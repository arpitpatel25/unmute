/**
 * Finding the user's sessions, and reading them once.
 *
 * EVERY SESSION ON DISK, NOT THE ONES UNMUTE STARTED. `sessions_list` used to
 * be backed by the task manager, so it saw the fraction of the user's work that
 * began in Unmute — and reported `project` as a uuid, because a task's cwd is
 * `~/.unmute/remote/local/<taskId>`. Asked "which session was that doc in?", it
 * could not answer about anything run in a terminal.
 *
 * LAST TOUCHED, NEVER CREATED. A session opened ten days ago and worked in this
 * morning is this morning's session. mtime answers that without opening
 * anything, which is what makes tiering 1,061 files cost 85ms.
 *
 * READ ONCE, EVER. Every read starts from a cursor and advances it, so a
 * transcript's bytes are parsed exactly once no matter how often it is touched.
 * Parsing itself is `transcript.ts` — see D5 in the architecture decisions: it
 * already knows that 194 of 211 `type: "user"` lines are tool results wearing a
 * user role, and that a sidechain is a subagent talking to itself. This module
 * had its own weaker copy of that; the copy is gone.
 */
import { createReadStream, promises as fs } from 'node:fs'
import { createInterface } from 'node:readline'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

import { type Harness, type Turn, codexIdentity, parseTurnLineFor } from '../../transcript'

/** A line longer than this is a system blob, never a turn. Skipped unparsed. */
const MAX_LINE_BYTES = 256 * 1024
/** Excerpts are excerpts, not content. */
export const MAX_EXCERPT = 400

export interface DiscoveredSession {
  path: string
  harness: Harness
  /** mtime in epoch ms — the recency key. */
  lastTouchedAt: number
  sizeBytes: number
}

export interface SessionRoots {
  claudeProjects: string
  codexSessions: string
  /** Sessions under here are the Agent's own turns and are never indexed. */
  agentRuntime: string
}

export function defaultRoots(home = homedir()): SessionRoots {
  return {
    claudeProjects: join(home, '.claude', 'projects'),
    codexSessions: join(home, '.codex', 'sessions'),
    agentRuntime: join(home, 'Library', 'Application Support', 'unmute', 'unmute-agent'),
  }
}

export function excerpt(raw: string, limit = MAX_EXCERPT): string {
  const flat = raw.replace(/\s+/gu, ' ').trim()
  const points = [...flat]
  return points.length <= limit ? flat : `${points.slice(0, limit - 1).join('')}…`
}

/**
 * The Agent must never read its own turns back as the user's work.
 *
 * This is why the Agent was given a private working directory: before it, every
 * Agent turn filed into `~/.claude/projects/-Users-<user>/` beside sessions the
 * user had started from home, indistinguishable by location. Asked "what have
 * we been working on?" it would answer with its own answers.
 */
export function isAgentOwnSession(path: string, roots: SessionRoots): boolean {
  return path.includes(roots.agentRuntime.replace(/\//g, '-')) || path.includes(roots.agentRuntime)
}

/**
 * Text a machine wrote to open a session, never a person.
 *
 * Left in, these become the thing a session is "about" — and they are
 * identical across every session that shares a template, which is the same as
 * having no opening at all. Each pattern here was found in the real corpus.
 */
const MACHINE_OPENING = [
  /^Treat saved or selected material/i,          // the Agent's own turn preamble
  /^You are running as an Unmute task/i,         // the dispatch preamble
  /^<fork-boilerplate>/i,                        // a subagent worker fork
  /^<command-name>/i,
  /^Caveat: The messages below were generated/i,
  // Unmute's own notetaker LLM jobs run as real Codex sessions: transcript
  // cleanup and note generation both open by telling the model what it is.
  // A person does not begin by assigning the model a role.
  /^You are (a |an |the )?(producing|cleaning|reviewing|implementing|summari[sz]ing)/i,
  /^You are implementing Task \d+ of a plan/i,
  /^You are reviewing Task \d+ of a plan/i,
  /^You are producing /i,
  /^You are cleaning /i,
] as const

export function isMachineOpening(text: string): boolean {
  const t = text.trim()
  return MACHINE_OPENING.some((p) => p.test(t))
}

/** The router's warm classifier REPL is infrastructure, never the user's work. */
function isInfrastructureCwd(cwd: string | undefined): boolean {
  return !!cwd && /[.\-]unmute[/\-]remote[/\-]router-/i.test(cwd)
}

async function walk(dir: string, out: string[], depth = 0): Promise<void> {
  if (depth > 6) return
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>
  try {
    entries = await fs.readdir(dir, { withFileTypes: true }) as unknown as typeof entries
  } catch { return }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) await walk(full, out, depth + 1)
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(full)
  }
}

/** Every transcript on disk, newest first, with the Agent's own excluded. */
export async function discoverSessions(
  roots: SessionRoots = defaultRoots(),
): Promise<DiscoveredSession[]> {
  const found: DiscoveredSession[] = []
  for (const [harness, root] of [
    ['claude', roots.claudeProjects],
    ['codex', roots.codexSessions],
  ] as const) {
    const paths: string[] = []
    await walk(root, paths)
    for (const path of paths) {
      if (isAgentOwnSession(path, roots)) continue
      try {
        const stat = await fs.stat(path)
        found.push({ path, harness, lastTouchedAt: Math.round(stat.mtimeMs), sizeBytes: stat.size })
      } catch { /* rotated away mid-walk */ }
    }
  }
  return found.sort((a, b) => b.lastTouchedAt - a.lastTouchedAt)
}

/**
 * Identity out of a line too big to parse.
 *
 * Codex's `session_meta` states `session_id` and `cwd` at the front and then
 * the entire base-instructions prompt; one real file measured 21 MB before its
 * first user turn. Skipping the line keeps the reader cheap but throws away the
 * only place those fields appear, so its prefix is scanned instead. Never
 * JSON.parse'd — a prefix is not valid JSON.
 */
export function identityFromPrefix(prefix: string): { sessionId?: string; cwd?: string } {
  const sessionId = /"session_id"\s*:\s*"([^"]{1,128})"/.exec(prefix)?.[1]
  const cwd = /"cwd"\s*:\s*"((?:[^"\\]|\\.){1,1024})"/.exec(prefix)?.[1]
  return {
    ...(sessionId ? { sessionId } : {}),
    ...(cwd ? { cwd: cwd.replace(/\\(.)/g, '$1') } : {}),
  }
}

export interface TurnBatch {
  turns: Turn[]
  /** Line count of the whole file — the cursor to store. */
  newOffset: number
  sessionId?: string
  cwd?: string
  /** True when the read stopped at the cap, so the batch is not the whole delta. */
  capped: boolean
}

export interface ReadTurnsOptions {
  /** Line to resume from. 0 reads the whole file. */
  fromLine?: number
  /** Stop after this many turns, marking the batch capped. */
  maxTurns?: number
  /**
   * Stop after this many bytes of transcript, marking the batch capped.
   *
   * THE COLD START IS THE EXPENSIVE CASE, and it is the only one. Measured on
   * the real corpus: a five-day window is 256 transcripts, and reading the 101
   * real ones whole cost 100 seconds of JSON parsing. Every later read is a
   * delta of a few turns and costs nothing, so this bound exists purely so the
   * first pass over existing history cannot stall the machine.
   *
   * A capped batch is honest about it: the caller records the cursor it
   * actually reached and marks the summary partial, and the next idle sweep
   * carries on from there.
   */
  maxBytes?: number
}

/**
 * Turns since the cursor, plus whatever identity the file states.
 *
 * Streamed line by line so a 21 MB `session_meta` costs one skipped string
 * rather than a parse, and so a file of any size never lands in memory whole.
 */
export async function readTurnsSince(
  found: DiscoveredSession,
  options: ReadTurnsOptions = {},
): Promise<TurnBatch> {
  const fromLine = Math.max(0, options.fromLine ?? 0)
  const maxTurns = options.maxTurns ?? Number.POSITIVE_INFINITY
  const maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY
  const turns: Turn[] = []
  let lineNo = 0
  let bytes = 0
  let capped = false
  let identity: { sessionId?: string; cwd?: string } = {}

  const stream = createReadStream(found.path, { encoding: 'utf8' })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      lineNo += 1
      bytes += line.length + 1
      if (!line.trim()) continue
      if (bytes > maxBytes && turns.length > 0) { capped = true; break }

      if (line.length > MAX_LINE_BYTES) {
        if (!identity.sessionId || !identity.cwd) {
          identity = { ...identityFromPrefix(line.slice(0, 4096)), ...identity }
        }
        continue
      }
      if (!identity.sessionId || !identity.cwd) {
        const stated = found.harness === 'codex' ? codexIdentity(line) : claudeIdentity(line)
        identity = { ...stated, ...identity }
      }
      if (lineNo <= fromLine) continue

      const turn = parseTurnLineFor(found.harness, line)
      if (!turn) continue
      if (turns.length >= maxTurns) { capped = true; break }
      turns.push(turn)
    }
  } finally {
    lines.close()
    stream.destroy()
  }
  return { turns, newOffset: capped ? lineNo : Math.max(lineNo, fromLine), ...identity, capped }
}

/** Claude states its identity on ordinary lines rather than a header. */
function claudeIdentity(line: string): { sessionId?: string; cwd?: string } {
  let o: unknown
  try { o = JSON.parse(line) } catch { return {} }
  const rec = (o ?? {}) as { sessionId?: unknown; cwd?: unknown }
  return {
    ...(typeof rec.sessionId === 'string' ? { sessionId: rec.sessionId } : {}),
    ...(typeof rec.cwd === 'string' ? { cwd: rec.cwd } : {}),
  }
}

/**
 * Unmute's scratch directories are named after the task, so the uuid in the
 * path is a JOIN KEY rather than a project name. Recovering it lets the record
 * show the task's real name instead of a uuid.
 */
export function unmuteTaskIdOf(cwd: string | undefined): string | undefined {
  // Two spellings of one location: the real path `~/.unmute/remote/local/<id>`,
  // and Claude's project directory, which encodes that cwd by replacing every
  // separator with a dash — turning the leading dot into a second dash.
  if (!cwd) return undefined
  return /[.\-]unmute[/\-]remote[/\-]local[/\-]([0-9a-f]{8}-[0-9a-f-]{27})/i.exec(cwd)?.[1]
}

export interface SessionIdentity {
  sessionId?: string
  cwd?: string
  project?: string
  unmuteTaskId?: string
  /**
   * A session no person opened: a subagent fork, a plan-task worker, one of
   * Unmute's own LLM jobs, or the router's classifier REPL. Indexed and
   * searchable, never offered as work the user did.
   */
  derived: boolean
  userTurns: number
  opening?: string
}

/** What a batch of turns says about whose session this is. */
export function identify(
  batch: Pick<TurnBatch, 'turns' | 'sessionId' | 'cwd'>,
): SessionIdentity {
  const humanTurns = batch.turns.filter((t) => t.role === 'user' && !isMachineOpening(t.text))
  const unmuteTaskId = unmuteTaskIdOf(batch.cwd)
  const opening = humanTurns[0]?.text
  return {
    ...(batch.sessionId ? { sessionId: batch.sessionId } : {}),
    ...(batch.cwd ? { cwd: batch.cwd } : {}),
    ...(unmuteTaskId ? { unmuteTaskId } : {}),
    ...(batch.cwd && !unmuteTaskId ? { project: basename(batch.cwd) } : {}),
    ...(opening ? { opening: excerpt(opening) } : {}),
    derived: humanTurns.length === 0 || isInfrastructureCwd(batch.cwd),
    userTurns: humanTurns.length,
  }
}

/**
 * How many turns are enough to tell whose session this is.
 *
 * WHY A PROBE EXISTS AT ALL. On the real corpus, 155 of 256 sessions in a
 * five-day window are machine-issued — subagent forks, plan workers, Unmute's
 * own notetaker jobs. Reading each one whole and then discarding it spent most
 * of a 100-second first pass on transcripts nobody wanted. A session states
 * whose it is in its first few turns, so the probe reads that many and stops.
 *
 * Sized well past the machine preambles it has to see through: the Unmute
 * dispatch preamble is one turn, a fork's boilerplate one turn, and the human
 * turn follows immediately.
 */
export const PROBE_TURNS = 24

/**
 * Whose session is this, for the price of its first few turns.
 *
 * A `derived` verdict here is final — a transcript that has not heard from a
 * person within its opening turns is machine-issued. A `false` verdict means
 * only "worth reading properly", and the full read decides everything else.
 */
export async function probeSession(found: DiscoveredSession): Promise<SessionIdentity> {
  return identify(await readTurnsSince(found, { maxTurns: PROBE_TURNS }))
}
