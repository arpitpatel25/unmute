import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { watch, type FSWatcher } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { writeFileAtomic } from '../../atomic-file'
import { cwdFromPrefix, defaultRoots, readSessionProvenance, type Harness, type SessionProvenance, type SessionRoots } from './locate'
import { devTrace } from '../devlog'

/**
 * WHAT THE USER SAID, ALL OF IT, AS A FILE.
 *
 * This replaces `sessions_search`, which read 64 KB from the head of a
 * transcript and 64 KB from its tail and threw the middle away. On a real
 * 33.9 MB session that was 0.369% of the file, and the sentence the user was
 * looking for sat at byte 30,433,728 — in the discarded middle. It then
 * required EVERY token of the query to match, so ordinary words like "opened"
 * and "wrong" discarded sessions outright. It failed silently, and the Agent
 * had no way to know it had been handed a confident nothing.
 *
 * The fix is not a better search tool. A tool over readable data caps the
 * Agent at the queries its schema author imagined, and the Agent already holds
 * Read, Glob and Grep. So this writes a FILE and stops there:
 *
 *   sessions.jsonl  one line per session — id, provider, cwd, provenance
 *   turns.jsonl     one line per user turn — session id, time, offset, text
 *
 * Nothing here calls a model. No summary, no title, no topic: only facts a
 * parser can take out of a transcript without interpreting it. A paraphrase
 * would delete the user's own vocabulary, which is exactly the vocabulary
 * their next sentence arrives in.
 *
 * Turns are their own lines rather than an array on the session because they
 * are APPENDED as they happen; a grouped record would mean rewriting a
 * session's line on every turn. Per-session metadata still lives once, in
 * sessions.jsonl. The only thing repeated per turn is the session id, which is
 * also what makes a grep hit on turns.jsonl self-describing.
 *
 * Transcripts are append-only, so maintenance is a byte cursor per file and a
 * read of the delta. A file is never re-read whole after its first pass.
 */

export interface IndexedTurn {
  /** Session id. Repeated per line so a grep hit identifies itself. */
  s: string
  /** Epoch ms of the turn, from the transcript. */
  t: number
  /** Byte offset of the source line, so a hit is a pointer into the transcript. */
  o: number
  text: string
  /** Present only when `text` was clipped; go to `o` for the whole thing. */
  trunc?: true
}

export interface IndexedSession {
  id: string
  provider: Harness
  cwd?: string
  provenance: SessionProvenance['kind']
  parentSessionId?: string
  path: string
  firstAt: number
  lastAt: number
  /** How many times they left this session and came back — see RETURN_GAP_MS. */
  returns?: number
  turns: number
  /** Sessions in ANOTHER harness whose first turn is byte-identical to this
   *  one's — see LINKED. A link is a fact, not a ranking: neither side is
   *  declared the original, because copies are not reliably newer. */
  linkedTo?: string[]
  /** sha256 of the first user turn, which is what the link is computed from. */
  openingHash?: string
  /** This session was OPENED by software, not by a person — see BRIEFING. It
   *  stays indexed and searchable; it is simply never what someone means when
   *  they say "the thing I was working on". */
  briefing?: true
}

/** One turn is generous; beyond this the transcript is the record. */
const MAX_TURN_TEXT = 8 * 1024
/**
 * Read the delta in slices so one huge catch-up cannot hold the loop.
 *
 * This also sets the largest line that can be seen whole, and therefore the
 * largest line that can be indexed — Claude puts pasted images in the user
 * turn as base64, so real turns arrive on multi-megabyte lines and 4 MB was
 * not enough. A slice is allocated as min(SLICE_BYTES, remaining), so small
 * files still cost little.
 */
const SLICE_BYTES = 24 * 1024 * 1024
/** Ceiling on bytes consumed per pass; whatever is left is picked up next tick. */
const PASS_BUDGET = 64 * 1024 * 1024
/** Enough to carry provenance and cwd in both harnesses (see locate.ts). */
const PREFIX_BYTES = 64 * 1024
const DEBOUNCE_MS = 250
/**
 * A byte-level prefilter, applied before any line is decoded or parsed. The
 * corpus is ~29 GB and almost none of it is a user turn, so this keeps
 * JSON.parse off the vast majority of it. The markers are per harness and
 * deliberately narrow:
 *
 *  - Claude writes compact JSON, and a user line carries `"type":"user"`.
 *    `"role":"user"` is accepted too so a key-order change cannot silently
 *    empty the index.
 *  - Codex user turns carry `"user_message"`. This one matters: Codex puts its
 *    entire base-instructions prompt in the first line — one real rollout is
 *    21 MB before its first turn — and that line contains NO occurrence of
 *    `"user_message` (verified across real rollouts), so the blob is excluded
 *    without ever being parsed.
 *
 * A false positive only costs one parse; correctness rests entirely on
 * userTurnOf.
 */
const MARKS: Record<Harness, readonly Buffer[]> = {
  claude: [Buffer.from('"type":"user"'), Buffer.from('"role":"user"')],
  // Codex writes a user turn TWO ways and both must be caught: `event_msg`
  // with payload.type "user_message", and `response_item` with payload.type
  // "message" + role "user". Indexing only the first left a 580 MB session
  // with 142 real turns showing ZERO. Neither marker appears in a session_meta
  // blob (verified across real rollouts), so the blob is still never parsed.
  codex: [Buffer.from('"user_message'), Buffer.from('"role":"user"')],
}
/**
 * The largest line that can be indexed. Tied to SLICE_BYTES on purpose: a line
 * that cannot be seen whole in one slice is stepped over, so a separate cap
 * could only ever disagree with the slicer — and when it did, it dropped a
 * real 6,474-character message whose line was 6.98 MB because Claude embeds
 * pasted images as base64 in the user turn (52 of them in that one session).
 * Losing what someone said because they attached a screenshot to it is the
 * precise failure this index exists to prevent. The multi-megabyte prompt
 * blobs a size cap used to be aimed at are excluded by MARKS instead, which is
 * the accurate instrument.
 */
const MAX_LINE_BYTES = SLICE_BYTES

/**
 * Written into the user role by the harness or the environment, not by a
 * person. Every one of these was observed in a real transcript.
 */
const SYNTHETIC = [
  '<task-notification', '<system-reminder', '<local-command-', '<command-name>', 'Caveat:',
  '<environment_context>', '<recommended_plugins>', '# AGENTS.md instructions for',
  '[Request interrupted by user', 'This session is being continued from a previous',
  // A skill body, pasted into the user role when a skill loads mid-session.
  // 92 of these on one real machine, and they are the LARGEST rows in the
  // index — every one hits MAX_TURN_TEXT and is truncated, so each spends 8 KB
  // saying nothing a person said. One of them landed in a three-turn session
  // being weighed against its copy, where turn counts are exactly what decides
  // which side the work went to. Unlike a BRIEFING this is not the opening, so
  // labelling the session cannot reach it; the turn itself has to go.
  'Base directory for this skill:',
  // The Claude Code startup banner, box-drawing characters and all.
  '\u2590\u259b\u2588\u2588\u2588\u259c\u258c',
]
/**
 * COPIES ACROSS HARNESSES ARE REAL, AND THERE ARE HUNDREDS.
 *
 * 679 Codex sessions on one real machine open with a turn byte-identical to a
 * Claude session's, arriving in bursts of 30-50 within the same SECOND, every
 * day or two for weeks. Something enumerates one harness's history and replays
 * it into the other; nothing in either file records that it happened.
 *
 * The damage is to retrieval. Two sessions, same project, same opening, no
 * relationship recorded — indistinguishable from two separate conversations
 * about one subject, which is exactly how a reader concludes somebody started
 * the same thing twice. It is the unasked-for fork again, made by a vendor.
 *
 * So the link is recorded and NOTHING is ranked. Not by provider: preferring
 * the "original" would hand back the abandoned half of a thread that carried
 * on elsewhere. Not by age either: measured copies PREDATE their counterpart
 * by up to 232 hours, so oldest-is-original is simply false here. Which side
 * to offer is a question about where the work went, and that is the reader's
 * to answer from turns and recency.
 *
 * An opening shorter than this is not evidence — "yes" or "continue" collides
 * by chance across a corpus this size.
 */
const LINKABLE_OPENING_CHARS = 40

/**
 * A GAP THIS LONG BETWEEN TWO THINGS SOMEONE SAID MEANS THEY LEFT AND CAME BACK.
 *
 * Which of two sessions to continue is a question nothing in the words can
 * answer: a session that failed matches the same phrases as one that worked,
 * and is usually the MORE recent of the two, because the failure is what made
 * them ask again. Turn counts do not separate them either — fifteen turns is
 * either a rich collaboration or fifteen corrections.
 *
 * What does separate them is whether the person came back. Someone who leaves
 * a session and returns to it has accepted it; someone who says two things and
 * never reappears has not, however well it matches. It is also the only signal
 * here a session cannot author about itself, unlike a terminal state (a task
 * can be "done" and still say "I couldn't complete this") or a summary it
 * writes about its own success.
 *
 * Thirty minutes rather than hours: continuous work has gaps of seconds to
 * minutes, so this is short enough to catch a real return and long enough that
 * thinking, a meal, or a meeting is not mistaken for one.
 */
const RETURN_GAP_MS = 30 * 60_000

/**
 * A session whose FIRST turn takes one of these forms was opened by software
 * for software: a job prompt, a worker briefing, a reviewer's instructions.
 * One Unmute job prompt alone — "You are maintaining a factual record of one
 * coding session…" — accounted for 2,703 of 16,771 indexed turns, and
 * briefings together for 17% of the index.
 *
 * The FORM is the rule rather than a list of phrasings; that was already
 * settled in docs/superpowers/specs/2026-08-26, where enumerating them proved
 * to be whack-a-mole. Nothing is dropped: the same words could be something a
 * person genuinely typed, and dropping loses content. The SESSION is labelled,
 * exactly as provenance labels a subagent, and the reader decides.
 */
const BRIEFING = [/^You are /, /^\/(?:Users|home|tmp|Volumes)\//]

/**
 * UNMUTE TALKING TO ITSELF IS NOT THE PERSON'S HISTORY.
 *
 * A BRIEFING is labelled and kept, because the same words could be something
 * a person typed. These are different: the cwd says outright that Unmute
 * spawned the session for its own machinery, and the only reason the person's
 * words appear inside is that Unmute quoted them into a prompt. There is no
 * reading of "the thing we were working on" that means one of these.
 *
 * On one real machine they were 850 of 4,792 sessions, and they took five of
 * the top six results for "Tanmay" — the router classifying the very sentence
 * that asked. Labelling was not enough: the Agent still had to read past them.
 *
 *  - router-headless / router-codex-exec: ONE EXEC PER ROUTE, never resumed,
 *    a single classification of one spoken command.
 *  - unmute-agent/runtime: the Agent's own chat. It IS resumed, so the files
 *    stay on disk and only the indexing stops.
 *  - agent-eval-*: the behaviour evals' temp dirs — test fixtures, not history.
 *
 * Matched on cwd, which is recorded for every session and cannot be faked by
 * the text of a turn.
 */
const MACHINERY = [
  /[\\/]\.unmute[\\/]remote[\\/]router-[A-Za-z0-9-]+/,
  /[\\/]unmute-agent[\\/]runtime(?:[\\/]|$)/,
  /[\\/]agent-eval-[A-Za-z0-9]+(?:[\\/]|$)/,
]

/** True when this session is Unmute's own machinery — see MACHINERY. */
export function isUnmuteMachinery(cwd: string | undefined): boolean {
  return !!cwd && MACHINERY.some(form => form.test(cwd))
}

/** Attachment references Codex wraps around a turn — opening AND closing, and
 *  several in a row when more than one image was attached. The words after
 *  them are still the person's, so strip the tags rather than drop the turn. */
const IMAGE_TAG = /^(?:\s*<\/?image\b[^>]*>\s*)+/

/**
 * A session that ran INSIDE a routine's own run directory, not one a person
 * drove. Left unmarked, its turns would feed the next routine's manifest as
 * if they were something someone said — the self-feeding loop behind the
 * deleted session-summary sweep (see the module doc above). Checked on the
 * cwd rather than on how the session started, because that is the one fact
 * that cannot be spoofed by what a routine's own prompt happens to say.
 *
 * Segment-matched rather than substring-matched, and split on both `/` and
 * `\` rather than `path.sep`: this index runs on whatever machine holds the
 * transcript, not necessarily the one that wrote it.
 */
function isRoutineRunCwd(cwd: string): boolean {
  const segments = cwd.split(/[\\/]/)
  for (let i = 0; i + 2 < segments.length; i++) {
    if (segments[i] === 'unmute-agent' && segments[i + 1] === 'routines' && segments[i + 2] === 'runs') return true
  }
  return false
}

export function defaultIndexRoot(home: string = homedir()): string {
  return join(home, '.unmute', 'remote', 'session-index')
}

/** The filename IS the id in both harnesses — the same rule locate.ts matches on. */
export function sessionIdFromPath(path: string, harness: Harness): string | null {
  const name = basename(path)
  if (!name.endsWith('.jsonl')) return null
  const stem = name.slice(0, -'.jsonl'.length)
  if (harness === 'claude') return /^[0-9a-f-]{36}$/i.test(stem) ? stem : null
  if (!stem.startsWith('rollout-')) return null
  const id = stem.slice(-36)
  return /^[0-9a-f-]{36}$/i.test(id) ? id : null
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    // Only genuine text blocks. A tool_result also rides in the user role and
    // is not something the person said.
    return value
      .filter((part): part is { type: string; text: string } =>
        !!part && typeof part === 'object'
        // `input_text` is what Codex calls the same thing.
        && ((part as any).type === 'text' || (part as any).type === 'input_text')
        && typeof (part as any).text === 'string')
      .map(part => part.text)
      .join('\n')
  }
  return ''
}

function timeOf(record: any, fallback: number): number {
  const raw = record?.timestamp ?? record?.payload?.timestamp
  if (typeof raw === 'number') return raw
  if (typeof raw === 'string') {
    const parsed = Date.parse(raw)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

/**
 * The user's own turn, or null. Sidechains are excluded here rather than
 * filtered later: a subagent's prompt was written by software, not spoken.
 */
export function userTurnOf(line: string, harness: Harness, fallbackTime: number): { t: number; text: string } | null {
  let record: any
  try { record = JSON.parse(line) } catch { return null }
  if (!record || typeof record !== 'object') return null
  if (record.isSidechain === true || record.agentId) return null

  let raw = ''
  if (harness === 'claude') {
    if (record.type !== 'user') return null
    if (record.message?.role && record.message.role !== 'user') return null
    raw = textOf(record.message?.content ?? record.content)
  } else {
    const payload = record.payload
    if (payload?.type === 'user_message') raw = textOf(payload.message ?? payload.content)
    else if (payload?.type === 'message' && payload.role === 'user') raw = textOf(payload.content)
    else return null
  }

  let text = raw.trim().replace(IMAGE_TAG, '').trim()
  if (!text) return null
  if (SYNTHETIC.some(marker => text.startsWith(marker))) return null
  return { t: timeOf(record, fallbackTime), text }
}

/** The link key: a session's first turn, once it is long enough to be evidence. */
export function openingHash(text: string): string | undefined {
  const t = text.trim()
  if (t.length < LINKABLE_OPENING_CHARS) return undefined
  return createHash('sha256').update(t).digest('hex')
}

interface Cursor { offset: number; size: number }

export interface TurnIndexDeps {
  roots?: SessionRoots
  root?: string
  now?: () => number
}

export class SessionTurnIndex {
  private readonly roots: SessionRoots
  private readonly root: string
  private readonly now: () => number
  private readonly cursors = new Map<string, Cursor>()
  private readonly sessions = new Map<string, IndexedSession>()
  private readonly echoes = new Set<string>()
  private watchers: FSWatcher[] = []
  private timer: NodeJS.Timeout | null = null
  private running = false
  private again = false
  private loaded = false
  private compacted = false
  /** DEV-ONLY: turns appended during the current pass, for the pass trace. */
  private appended = 0

  constructor(deps: TurnIndexDeps = {}) {
    this.roots = deps.roots ?? defaultRoots()
    this.root = deps.root ?? defaultIndexRoot()
    this.now = deps.now ?? Date.now
  }

  get paths() {
    return {
      sessions: join(this.root, 'sessions.jsonl'),
      turns: join(this.root, 'turns.jsonl'),
      cursors: join(this.root, 'cursors.json'),
    }
  }

  /** Catch up, then watch. Safe to call twice. */
  async start(): Promise<void> {
    await this.sync()
    if (this.watchers.length) return
    for (const dir of [this.roots.claudeProjects, this.roots.codexSessions]) {
      try {
        // Directory-level and recursive: there are ~4,000 transcripts and one
        // watcher each would exhaust the descriptor budget for nothing.
        const watcher = watch(dir, { recursive: true }, () => this.schedule())
        watcher.on('error', () => {})
        this.watchers.push(watcher)
      } catch { /* a root that does not exist yet is not an error */ }
    }
  }

  stop(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    for (const watcher of this.watchers) { try { watcher.close() } catch { /* already gone */ } }
    this.watchers = []
  }

  private schedule(): void {
    if (this.timer) return
    this.timer = setTimeout(() => { this.timer = null; void this.sync() }, DEBOUNCE_MS)
  }

  /** One pass over everything that moved. Never throws. */
  async sync(): Promise<void> {
    if (this.running) { this.again = true; return }
    this.running = true
    try {
      do {
        this.again = false
        await this.pass().catch(() => {})
      } while (this.again)
    } finally { this.running = false }
  }

  private async pass(): Promise<void> {
    const started = this.now()
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 })
    await this.load()
    await this.compact()
    let budget = PASS_BUDGET
    let dirty = false
    let files = 0
    this.appended = 0
    for (const [harness, dir] of [['claude', this.roots.claudeProjects], ['codex', this.roots.codexSessions]] as const) {
      for (const path of await this.transcripts(dir)) {
        if (budget <= 0) {
          devTrace('turn-index.pass', { files, bytes: PASS_BUDGET - budget, turnsAppended: this.appended, budgetExhausted: true, ms: this.now() - started })
          this.again = true; return
        }
        const consumed = await this.ingest(path, harness, budget).catch(() => 0)
        if (consumed > 0) { budget -= consumed; dirty = true; files++ }
      }
    }
    if (dirty) {
      await this.flush()
      devTrace('turn-index.pass', { files, bytes: PASS_BUDGET - budget, turnsAppended: this.appended, sessions: this.sessions.size, ms: this.now() - started })
    }
  }

  /** No cap. The 2,000-file ceiling in the old catalog silently hid ~1,087 of
   *  3,087 Claude transcripts, in readdir order rather than by recency. */
  private async transcripts(dir: string, depth = 0): Promise<string[]> {
    if (depth > 8) return []
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>
    try { entries = await fs.readdir(dir, { withFileTypes: true }) as any } catch { return [] }
    const found: string[] = []
    const dirs: string[] = []
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) dirs.push(full)
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) found.push(full)
    }
    for (const child of dirs) found.push(...await this.transcripts(child, depth + 1))
    return found
  }

  private async ingest(path: string, harness: Harness, budget: number): Promise<number> {
    const id = sessionIdFromPath(path, harness)
    if (!id) return 0
    const stat = await fs.stat(path).catch(() => null)
    if (!stat?.isFile()) return 0

    let cursor = this.cursors.get(path)
    // Smaller than we last read means rewritten or compacted, not appended.
    // Re-read from zero rather than splicing a new file onto an old offset.
    if (cursor && stat.size < cursor.offset) { this.cursors.delete(path); this.dropSession(id); cursor = undefined }
    const start = cursor?.offset ?? 0
    if (stat.size <= start) return 0

    if (!this.sessions.has(id)) await this.describe(id, path, harness)
    // Unmute's own machinery is stepped over, not labelled: the cursor jumps
    // to the end so the file is never read again, and nothing it contains
    // reaches the index. see MACHINERY.
    if (isUnmuteMachinery(this.sessions.get(id)?.cwd)) {
      this.sessions.delete(id)
      this.cursors.set(path, { offset: stat.size, size: stat.size })
      return 0
    }

    const handle = await fs.open(path, 'r').catch(() => null)
    if (!handle) return 0
    const lines: string[] = []
    let offset = start
    let consumed = 0
    // Every turn time in this pass, in the order they were read; bump() folds
    // them into the session's bounds and counts the gaps between them.
    const times: number[] = []
    // True while stepping through a line longer than one slice: the next
    // newline we meet ENDS that line rather than starting a new one.
    let overlong = false
    try {
      while (offset < stat.size && consumed < budget) {
        const length = Math.min(SLICE_BYTES, stat.size - offset)
        const buffer = Buffer.alloc(length)
        const { bytesRead } = await handle.read(buffer, 0, length, offset)
        if (!bytesRead) break
        const slice = buffer.subarray(0, bytesRead)
        const lastBreak = slice.lastIndexOf(0x0a)
        if (lastBreak === -1) {
          // No line ENDS in this slice. Two very different reasons:
          //  - at EOF it is a half-written trailing line, so leave the cursor
          //    before it and let the next pass see it whole;
          //  - mid-file it is a single line longer than the slice (Codex
          //    writes 21 MB of base instructions on line one). Stepping over
          //    it is the only way forward. Returning here instead — which is
          //    what the first version did — pinned the cursor and stalled the
          //    file permanently, silently, for the life of the index.
          if (offset + bytesRead >= stat.size) break
          offset += bytesRead
          consumed += bytesRead
          overlong = true
          continue
        }
        let lineStart = 0
        for (let i = 0; i <= lastBreak; i++) {
          if (slice[i] !== 0x0a) continue
          if (!overlong) {
            const raw = slice.subarray(lineStart, i)
            if (raw.length <= MAX_LINE_BYTES && MARKS[harness].some(mark => raw.includes(mark))) {
              const turn = userTurnOf(raw.toString('utf8'), harness, stat.mtimeMs)
              if (turn && !this.isEcho(id, turn)) {
                const session = this.sessions.get(id)
                if (session && !session.turns && !lines.length && BRIEFING.some(form => form.test(turn.text))) session.briefing = true
                if (session && !session.openingHash && !session.turns && !lines.length) session.openingHash = openingHash(turn.text)
                lines.push(this.encode(id, turn, offset + lineStart))
                times.push(turn.t)
              }
            }
          }
          // Whatever it was, it is finished now.
          overlong = false
          lineStart = i + 1
        }
        consumed += lastBreak + 1
        offset += lastBreak + 1
      }
    } finally { await handle.close().catch(() => {}) }

    if (offset === start) return 0
    if (lines.length) await fs.appendFile(this.paths.turns, lines.join('') , { mode: 0o600 })
    this.appended += lines.length
    this.cursors.set(path, { offset, size: stat.size })
    this.bump(id, lines.length, times)
    return consumed
  }

  private encode(id: string, turn: { t: number; text: string }, offset: number): string {
    const clipped = turn.text.length > MAX_TURN_TEXT
    const record: IndexedTurn = {
      s: id, t: turn.t, o: offset,
      text: clipped ? turn.text.slice(0, MAX_TURN_TEXT) : turn.text,
      ...(clipped ? { trunc: true as const } : {}),
    }
    return JSON.stringify(record) + '\n'
  }

  /** Provenance and cwd come from the same bounded prefix locate.ts reads —
   *  one implementation, so discovery and the execution guard cannot disagree. */
  private async describe(id: string, path: string, harness: Harness): Promise<void> {
    let prefix = ''
    const handle = await fs.open(path, 'r').catch(() => null)
    if (handle) {
      try {
        const buffer = Buffer.alloc(PREFIX_BYTES)
        const { bytesRead } = await handle.read(buffer, 0, PREFIX_BYTES, 0)
        prefix = buffer.subarray(0, bytesRead).toString('utf8')
      } catch { /* unreadable prefix leaves provenance unknown */ }
      finally { await handle.close().catch(() => {}) }
    }
    const provenance = await readSessionProvenance(path, harness, id, prefix).catch(
      (): SessionProvenance => ({ kind: 'unknown' }))
    const cwd = cwdFromPrefix(prefix)
    // Overrides whatever readSessionProvenance decided: a routine's own run is
    // never a main conversation regardless of how its transcript opens.
    const kind: SessionProvenance['kind'] = cwd && isRoutineRunCwd(cwd) ? 'routine' : provenance.kind
    this.sessions.set(id, {
      id, provider: harness, path,
      provenance: kind,
      // Subagents are LABELLED, never omitted: hiding them hides evidence.
      // The refusal to act on one lives in requireMainSession.
      ...(provenance.parentSessionId ? { parentSessionId: provenance.parentSessionId } : {}),
      ...(cwd ? { cwd } : {}),
      firstAt: 0, lastAt: 0, turns: 0,
    })
  }

  /**
   * When the person spoke, not when the file was touched.
   *
   * Both fields used to be the file's mtime, which made firstAt a duplicate of
   * lastAt: 4,006 of 4,007 sessions on one real machine carried firstAt ===
   * lastAt, 565 of the 566 multi-turn ones among them, and on 402 neither
   * value fell anywhere near the turns it claimed to bracket — one row read
   * Sep 4 16:18 for a conversation whose turns are all Aug 31 22:43. A reader
   * asking "when did we start this" had no answer at all, and the answer is
   * sitting in the turns we already parsed.
   *
   * lastAt therefore now means the last thing the PERSON said. A session the
   * assistant kept working in for hours after they left reads as of when they
   * left, which is the honest answer to where a conversation is.
   */
  private bump(id: string, added: number, times: readonly number[]): void {
    const session = this.sessions.get(id)
    if (!session || !added || !times.length) return
    session.turns += added
    // Sorted rather than trusted in file order: Codex writes a turn twice and
    // a compacted transcript can carry an older line after a newer one, and a
    // single out-of-order pair would otherwise invent a return.
    const sorted = [...times].sort((a, b) => a - b)
    // min/max rather than assignment: a later pass must never drag firstAt
    // forward off the opening turn.
    if (!session.firstAt || sorted[0] < session.firstAt) session.firstAt = sorted[0]
    // The gap BEFORE this pass counts too — a session tailed a day later is
    // exactly the person coming back, and it is the strongest case there is.
    let previous = session.lastAt
    for (const at of sorted) {
      if (previous && at - previous > RETURN_GAP_MS) session.returns = (session.returns ?? 0) + 1
      previous = at
    }
    if (sorted[sorted.length - 1] > session.lastAt) session.lastAt = sorted[sorted.length - 1]
  }


  /**
   * The SAME utterance arriving twice, not the person repeating themselves.
   *
   * Codex records every user message in BOTH of its shapes — `event_msg`
   * /`user_message` and `response_item`/`message` — at the identical
   * timestamp. Indexing both (which is what it took to stop losing half of
   * Codex) therefore doubled every Codex turn: 4,748 of 10,107 rows on one
   * real machine, 47%. That is not merely waste; it inflates turn counts, and
   * turn counts are how a reader judges which of two sessions the work is in.
   *
   * The timestamp is what makes this safe. Two shapes of one message share a
   * second exactly; a person typing "yes" twice does not. So identical text
   * at the identical millisecond is one turn, and the same words a minute
   * later are two.
   */
  private isEcho(id: string, turn: { t: number; text: string }): boolean {
    const key = `${id}\u0000${turn.t}\u0000${turn.text}`
    if (this.echoes.has(key)) return true
    this.echoes.add(key)
    // Bounded: only a live file's own turns can echo, and they arrive together.
    if (this.echoes.size > 4_096) this.echoes.delete(this.echoes.values().next().value!)
    return false
  }

  private dropSession(id: string): void {
    const session = this.sessions.get(id)
    if (session) { session.turns = 0; session.firstAt = 0; session.lastAt = 0; delete session.returns }
  }

  /**
   * Drop machinery that a previous version already indexed.
   *
   * Runs once per process, after load, and only rewrites when it finds
   * something: a turn's `o` is an offset into its TRANSCRIPT, never into
   * turns.jsonl, so removing lines here cannot invalidate the rest. Cursors
   * are left alone — those files are excluded at ingest now, so a kept cursor
   * is exactly what stops them being read again.
   */
  private async compact(): Promise<void> {
    if (this.compacted) return
    this.compacted = true
    const drop = new Set<string>()
    for (const [id, session] of this.sessions) if (isUnmuteMachinery(session.cwd)) drop.add(id)
    if (!drop.size) return
    let kept = 0
    let removed = 0
    const lines: string[] = []
    try {
      for (const line of (await fs.readFile(this.paths.turns, 'utf8')).split('\n')) {
        if (!line.trim()) continue
        let id: string | undefined
        try { id = (JSON.parse(line) as IndexedTurn).s } catch { id = undefined }
        if (id && drop.has(id)) { removed++; continue }
        kept++
        lines.push(line + '\n')
      }
      await writeFileAtomic(this.paths.turns, lines.join(''))
    } catch { return }
    for (const id of drop) this.sessions.delete(id)
    await this.flush()
    devTrace('turn-index.compacted', { sessionsDropped: drop.size, turnsDropped: removed, turnsKept: kept })
  }

  private async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const raw = JSON.parse(await fs.readFile(this.paths.cursors, 'utf8')) as Record<string, Cursor>
      for (const [path, cursor] of Object.entries(raw)) {
        if (cursor && typeof cursor.offset === 'number') this.cursors.set(path, cursor)
      }
    } catch { /* absent or corrupt cursors mean a full rebuild, which is correct */ }
    try {
      for (const line of (await fs.readFile(this.paths.sessions, 'utf8')).split('\n')) {
        if (!line.trim()) continue
        try {
          const session = JSON.parse(line) as IndexedSession
          if (session?.id) this.sessions.set(session.id, session)
        } catch { /* one bad line is not a bad file */ }
      }
    } catch { /* no sessions file yet */ }
  }

  /**
   * Record which sessions opened with the same words in a DIFFERENT harness.
   *
   * Recorded on both sides and ranked on neither — see LINKABLE_OPENING_CHARS
   * for why neither provider nor age can decide which is the original.
   */
  private link(): void {
    const byOpening = new Map<string, IndexedSession[]>()
    for (const session of this.sessions.values()) {
      if (!session.openingHash) continue
      const group = byOpening.get(session.openingHash)
      if (group) group.push(session); else byOpening.set(session.openingHash, [session])
    }
    for (const group of byOpening.values()) {
      if (group.length < 2 || new Set(group.map(s => s.provider)).size < 2) continue
      for (const session of group) {
        const others = group.filter(other => other.id !== session.id).map(other => other.id).sort()
        if (others.length) session.linkedTo = others
      }
    }
  }

  private async flush(): Promise<void> {
    this.link()
    const sessions = [...this.sessions.values()].map(session => JSON.stringify(session)).join('\n')
    await writeFileAtomic(this.paths.sessions, sessions ? sessions + '\n' : '')
    await writeFileAtomic(this.paths.cursors, JSON.stringify(Object.fromEntries(this.cursors)))
  }
}
