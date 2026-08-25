/**
 * Finding the user's sessions, and reading only as much of one as it takes.
 *
 * EVERY SESSION ON DISK, NOT THE ONES UNMUTE STARTED. `sessions_list` used to
 * be backed by the task manager, so it saw the fraction of the user's work that
 * happened to begin in Unmute — and reported `project` as a uuid, because the
 * task's cwd is `~/.unmute/remote/local/<taskId>`. Asked "which session was
 * that doc in?", it could not answer about anything the user ran themselves.
 *
 * LAST TOUCHED, NEVER CREATED. A session opened ten days ago and worked in this
 * morning is this morning's session. mtime answers that without opening
 * anything, which is what makes tiering 1,061 files free.
 *
 * READING IS BOUNDED TWICE OVER. Files run to tens of megabytes and Codex
 * writes an enormous `session_meta` before its first turn, so a fixed head
 * window can land entirely inside one blob. Lines are streamed instead, with
 * oversized ones skipped unparsed and an early exit the moment the opening is
 * in hand.
 */
import { createReadStream, promises as fs, type Dirent } from 'node:fs'
import { createInterface } from 'node:readline'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

import {
  type Harness, type TranscriptFacts, factsFor, mergeFacts,
} from './transcript-facts'

/** A line longer than this is a system blob, never a turn. Skipped unparsed. */
const MAX_LINE_BYTES = 256 * 1024
/** How far in to look for an opening before accepting there isn't one. */
const MAX_FORWARD_BYTES = 8 * 1024 * 1024
/** How much of the end to read for the closing. */
const TAIL_BYTES = 128 * 1024

export interface DiscoveredSession {
  /** Absolute path of the transcript. */
  path: string
  harness: Harness
  /** mtime in epoch ms — the tiering key. */
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

/**
 * The Agent must never read its own turns back as the user's work.
 *
 * This is the reason the Agent was given its own working directory in the first
 * place: before that, every Agent turn filed into
 * `~/.claude/projects/-Users-<user>/` beside sessions the user had started from
 * home, indistinguishable by location. Asked "what have we been working on?" it
 * would answer with its own answers, and "consolidate those" could consolidate
 * them.
 */
export function isAgentOwnSession(path: string, roots: SessionRoots): boolean {
  const slug = slugOf(roots.agentRuntime)
  return path.includes(slug) || path.includes(roots.agentRuntime)
}

/**
 * Claude encodes a cwd into a directory name by flattening it.
 *
 * Separators are not the only thing replaced: spaces and dots go too, which
 * matters here because the Agent's runtime lives under "Application Support".
 * Replacing only `/` produced a slug that never matched, and the Agent's own
 * turns were indexed as the user's work — the exact confusion its private
 * working directory exists to prevent.
 */
function slugOf(dir: string): string {
  return dir.replace(/[/\s.]/g, '-')
}

async function walk(dir: string, out: string[], depth = 0): Promise<void> {
  if (depth > 6) return
  // Typed explicitly: the overload chosen by `withFileTypes` alone resolves to
  // the Buffer-named variant under this tsconfig, which makes entry.name a
  // Buffer and every string operation below an error.
  let entries: Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true, encoding: 'utf8' }) as Dirent[]
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
        found.push({
          path,
          harness,
          lastTouchedAt: Math.round(stat.mtimeMs),
          sizeBytes: stat.size,
        })
      } catch { /* it may have been rotated away mid-walk */ }
    }
  }
  return found.sort((a, b) => b.lastTouchedAt - a.lastTouchedAt)
}

/** Reads forward only as far as an opening requires. */
/**
 * Identity out of a line too big to parse.
 *
 * Codex's `session_meta` carries `session_id` and `cwd` at the front and then
 * the entire base-instructions prompt, which can run to megabytes. Skipping the
 * line keeps the reader cheap but throws away the only place those two fields
 * are ever stated — so the prefix is scanned for them instead. Bounded, and
 * never JSON.parse'd: a prefix is not valid JSON and pretending otherwise is
 * how a reader starts throwing on real files.
 */
export function identityFromPrefix(prefix: string): Pick<TranscriptFacts, 'sessionId' | 'cwd'> {
  const sessionId = /"session_id"\s*:\s*"([^"]{1,128})"/.exec(prefix)?.[1]
  const cwd = /"cwd"\s*:\s*"((?:[^"\\]|\\.){1,1024})"/.exec(prefix)?.[1]
  return {
    ...(sessionId ? { sessionId } : {}),
    ...(cwd ? { cwd: cwd.replace(/\\(.)/g, '$1') } : {}),
  }
}

async function readForward(path: string, harness: Harness): Promise<TranscriptFacts> {
  const stream = createReadStream(path, { encoding: 'utf8', end: MAX_FORWARD_BYTES })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  const kept: string[] = []
  let facts: TranscriptFacts = { turnsSeen: 0 }
  try {
    for await (const line of lines) {
      if (line.length > MAX_LINE_BYTES) {
        facts = mergeFacts(facts, { ...identityFromPrefix(line.slice(0, 4096)), turnsSeen: 0 })
        continue
      }
      kept.push(line)
      if (kept.length < 200) continue
      facts = mergeFacts(facts, factsFor(harness, kept.join('\n')))
      kept.length = 0
      if (facts.opening && facts.sessionId) break
    }
  } finally {
    lines.close()
    stream.destroy()
  }
  return kept.length > 0
    ? mergeFacts(facts, factsFor(harness, kept.join('\n')))
    : facts
}

async function readTail(path: string, size: number, harness: Harness): Promise<TranscriptFacts> {
  if (size <= TAIL_BYTES) return { turnsSeen: 0 }
  const handle = await fs.open(path, 'r')
  try {
    const buffer = Buffer.alloc(TAIL_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, TAIL_BYTES, size - TAIL_BYTES)
    return factsFor(harness, buffer.subarray(0, bytesRead).toString('utf8'))
  } finally {
    await handle.close()
  }
}

export interface SessionRecord extends DiscoveredSession, TranscriptFacts {
  /** What a person would call the place this ran — never a task uuid. */
  project?: string
  /** True when Unmute started it, in which case the cwd is a scratch dir. */
  unmuteTaskId?: string
  /**
   * A session no person opened: a subagent fork, a plan-task worker, or the
   * router's own classifier REPL. Indexed and searchable, but never offered as
   * something you were working on.
   *
   * Measured on the real disk: 16 of 81 recently-touched sessions — a fifth of
   * the hot tier — are these. Their opening is machine framing, so they arrive
   * with none at all once it is stripped, and a digest full of blank rows is
   * worse than a shorter digest.
   */
  derived?: boolean
}

/** The router's warm classifier REPL is infrastructure, never the user's work. */
function isInfrastructure(cwd: string | undefined): boolean {
  return !!cwd && /[.\-]unmute[/\-]remote[/\-]router-/i.test(cwd)
}

/**
 * Unmute's own scratch directories are named after the task, so the uuid in the
 * path is a join key rather than a project name. Recovering it lets the index
 * borrow the task's real name and repository instead of showing a uuid, which
 * is what `sessions_list` did for as long as it was backed by the task manager.
 */
export function unmuteTaskIdOf(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined
  // Two spellings of the same location. The real path is
  // `~/.unmute/remote/local/<taskId>`; Claude's project directory encodes that
  // same cwd by replacing every separator with a dash, which turns the leading
  // dot into a second dash — `-Users-me--unmute-remote-local-<taskId>`.
  const match = /[.\-]unmute[/\-]remote[/\-]local[/\-]([0-9a-f]{8}-[0-9a-f-]{27})/i.exec(cwd)
  return match?.[1]
}

export async function readSession(found: DiscoveredSession): Promise<SessionRecord> {
  // The harness comes from discovery, which knows which root it walked. It
  // used to be re-derived from the path here, and the two disagreed the moment
  // a root lived anywhere but `~/.codex` — a Codex transcript parsed as Claude
  // yields nothing at all, silently.
  const [head, tail] = await Promise.all([
    readForward(found.path, found.harness),
    readTail(found.path, found.sizeBytes, found.harness),
  ])
  const facts = mergeFacts(head, tail)
  const unmuteTaskId = unmuteTaskIdOf(facts.cwd)
  // No opening survived the framing filter and no user turn was counted, so
  // nobody addressed this session in their own words.
  const derived = (!facts.opening && facts.turnsSeen === 0) || isInfrastructure(facts.cwd)
  return {
    ...found,
    ...facts,
    ...(unmuteTaskId ? { unmuteTaskId } : {}),
    ...(facts.cwd && !unmuteTaskId ? { project: basename(facts.cwd) } : {}),
    ...(derived ? { derived: true } : {}),
  }
}
