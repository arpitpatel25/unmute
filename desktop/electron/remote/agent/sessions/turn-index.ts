import fs from 'node:fs/promises'
import { watch, type FSWatcher } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { writeFileAtomic } from '../../atomic-file'
import { cwdFromPrefix, defaultRoots, readSessionProvenance, type Harness, type SessionProvenance, type SessionRoots } from './locate'

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
  turns: number
}

/** One turn is generous; beyond this the transcript is the record. */
const MAX_TURN_TEXT = 8 * 1024
/** Read the delta in slices so one huge catch-up cannot hold the loop. */
const SLICE_BYTES = 4 * 1024 * 1024
/** Ceiling on bytes consumed per pass; whatever is left is picked up next tick. */
const PASS_BUDGET = 64 * 1024 * 1024
/** Enough to carry provenance and cwd in both harnesses (see locate.ts). */
const PREFIX_BYTES = 64 * 1024
const DEBOUNCE_MS = 250
/**
 * A byte-level prefilter, applied before any line is decoded or parsed. The
 * corpus this walks is ~29 GB and almost none of it is a user turn: Codex
 * writes its whole base-instructions prompt into the first line (one real file
 * measured 21 MB before its first turn) and both harnesses write far more
 * assistant and tool output than input. `"user` appears in Claude's
 * `"type":"user"` and in Codex's `"user_message"`, so a line without it cannot
 * be a turn. A false positive only costs one parse — correctness still rests
 * entirely on userTurnOf.
 */
const USER_MARK = Buffer.from('"user')
/** No genuine turn is this big, and it keeps multi-megabyte prompt blobs out
 *  of JSON.parse. A turn is clipped to 8 KB in the index anyway. */
const MAX_LINE_BYTES = 2 * 1024 * 1024

/** Synthetic turns the harness writes into the user role. Not what anyone said. */
const SYNTHETIC = ['<task-notification', '<system-reminder', '<local-command-', '<command-name>', 'Caveat:']

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
        !!part && typeof part === 'object' && (part as any).type === 'text' && typeof (part as any).text === 'string')
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
    if (payload?.type !== 'user_message') return null
    raw = textOf(payload.message ?? payload.content)
  }

  const text = raw.trim()
  if (!text) return null
  if (SYNTHETIC.some(marker => text.startsWith(marker))) return null
  return { t: timeOf(record, fallbackTime), text }
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
  private watchers: FSWatcher[] = []
  private timer: NodeJS.Timeout | null = null
  private running = false
  private again = false
  private loaded = false

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
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 })
    await this.load()
    let budget = PASS_BUDGET
    let dirty = false
    for (const [harness, dir] of [['claude', this.roots.claudeProjects], ['codex', this.roots.codexSessions]] as const) {
      for (const path of await this.transcripts(dir)) {
        if (budget <= 0) { this.again = true; return }
        const consumed = await this.ingest(path, harness, budget).catch(() => 0)
        if (consumed > 0) { budget -= consumed; dirty = true }
      }
    }
    if (dirty) await this.flush()
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

    const handle = await fs.open(path, 'r').catch(() => null)
    if (!handle) return 0
    const lines: string[] = []
    let offset = start
    let consumed = 0
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
            if (raw.length <= MAX_LINE_BYTES && raw.includes(USER_MARK)) {
              const turn = userTurnOf(raw.toString('utf8'), harness, stat.mtimeMs)
              if (turn) lines.push(this.encode(id, turn, offset + lineStart))
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
    this.cursors.set(path, { offset, size: stat.size })
    this.bump(id, lines.length, stat.mtimeMs)
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
    this.sessions.set(id, {
      id, provider: harness, path,
      provenance: provenance.kind,
      // Subagents are LABELLED, never omitted: hiding them hides evidence.
      // The refusal to act on one lives in requireMainSession.
      ...(provenance.parentSessionId ? { parentSessionId: provenance.parentSessionId } : {}),
      ...(cwd ? { cwd } : {}),
      firstAt: 0, lastAt: 0, turns: 0,
    })
  }

  private bump(id: string, added: number, mtimeMs: number): void {
    const session = this.sessions.get(id)
    if (!session) return
    session.turns += added
    if (added && !session.firstAt) session.firstAt = mtimeMs
    if (added) session.lastAt = mtimeMs
  }

  private dropSession(id: string): void {
    const session = this.sessions.get(id)
    if (session) { session.turns = 0; session.firstAt = 0; session.lastAt = 0 }
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

  private async flush(): Promise<void> {
    const sessions = [...this.sessions.values()].map(session => JSON.stringify(session)).join('\n')
    await writeFileAtomic(this.paths.sessions, sessions ? sessions + '\n' : '')
    await writeFileAtomic(this.paths.cursors, JSON.stringify(Object.fromEntries(this.cursors)))
  }
}
