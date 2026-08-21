/**
 * CODEX CLI — finding the rollout a task is writing to.
 *
 * `cli-observer.ts` maps rollout events onto task state. This finds the file.
 *
 * WHERE THEY LIVE (verified 2026-08-09, codex-cli 0.142.5):
 *
 *   ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl    live
 *   ~/.codex/archived_sessions/rollout-<ts>-<uuid>.jsonl      archived
 *
 * Both are searched, because a session archived mid-task must not become
 * unreadable — the task would freeze on its last known state with nothing
 * logged, which is the failure mode this whole layer exists to avoid.
 *
 * THE SESSION ID IS DISCOVERED, NOT ASSIGNED. Claude takes `--session-id` so we
 * mint the id and know it before the process starts. Codex mints its own, so a
 * fresh task has no id until Codex writes one — and the only way to learn it is
 * to look for the rollout that appeared after we spawned, in the directory we
 * spawned into.
 *
 * That is a race with exactly one safe resolution: match on BOTH the working
 * directory AND a start time at-or-after our spawn. Matching on cwd alone would
 * adopt whichever session the user happened to have open in that repo — someone
 * else's conversation, silently, and then write our task's state from it.
 *
 * ORIGINATOR IS NOT USED AS A FILTER, deliberately. `session_meta.originator`
 * does distinguish "Codex Desktop" from a CLI run, and filtering on it looks
 * tempting. But the value is Codex's to change, an unrecognised string would
 * make every task undiscoverable, and the cwd+time match is already precise.
 * It is read and logged so a mismatch is visible if this ever goes wrong.
 */

import { promises as fs } from 'node:fs'
import { basename, join } from 'node:path'
import { homedir } from 'node:os'
import { createLogger } from '../log'
import type { RolloutEvent } from './cli-observer'

const log = createLogger('codex-cli-session')

const ROLLOUT = /^rollout-.*-([0-9a-f-]{36})\.jsonl$/i
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export interface RolloutCandidate {
  path: string
  sessionId: string
  mtimeMs: number
  fileId: string
}

export type RolloutSnapshot =
  | { status: 'missing'; path: string }
  | {
      status: 'present'
      path: string
      fileId: string
      mtimeMs: number
      size: number
      stable: boolean
      sessionId: string | null
      events: RolloutEvent[]
    }

function roots(home = homedir()): string[] {
  return [join(home, '.codex', 'sessions'), join(home, '.codex', 'archived_sessions')]
}

/** Every rollout on disk, newest first. Walks the date-partitioned tree. */
async function allRollouts(home?: string, strict = false): Promise<RolloutCandidate[]> {
  const out: RolloutCandidate[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 4) return
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch (error) {
      if (missingPath(error)) return
      if (strict) throw error
      return
    }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) { await walk(p, depth + 1); continue }
      const m = ROLLOUT.exec(e.name)
      if (!m) continue
      try {
        const st = await fs.stat(p)
        out.push({
          path: p,
          sessionId: m[1],
          mtimeMs: st.mtimeMs,
          fileId: `${st.dev}:${st.ino}`,
        })
      } catch (error) {
        if (!missingPath(error) && strict) throw error
      }
    }
  }
  for (const r of roots(home)) await walk(r, 0)
  out.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return out
}

/** The rollout for a known session id, live or archived. */
export async function findRollout(sessionId: string, home?: string): Promise<string | null> {
  const all = await allRollouts(home)
  return all.find((r) => r.sessionId === sessionId)?.path ?? null
}

/** Every readable path carrying one exact provider session identity. */
export async function findRolloutCandidates(sessionId: string, home?: string): Promise<RolloutCandidate[]> {
  return (await allRollouts(home, true)).filter((rollout) => rollout.sessionId === sessionId)
}

/** Snapshot identities that existed before a fresh CLI process was spawned. */
export async function snapshotRolloutSessionIds(home?: string): Promise<ReadonlySet<string>> {
  return new Set((await allRollouts(home, true)).map((rollout) => rollout.sessionId))
}

/** Parse a rollout into events. Tolerant: a half-written trailing line is
 *  normal — Codex is appending to this file as we read it. */
export async function readRolloutEvents(path: string): Promise<RolloutEvent[]> {
  const snapshot = await readRolloutSnapshot(path)
  return snapshot.status === 'present' ? snapshot.events : []
}

/** A read with explicit missing/present state and file identity. Integrity and
 * storage errors are never converted into an empty history. */
export async function readRolloutSnapshot(path: string): Promise<RolloutSnapshot> {
  let before: import('node:fs').Stats
  try {
    before = await fs.stat(path)
  } catch (error) {
    if (missingPath(error)) return { status: 'missing', path }
    throw error
  }
  let text: string
  try {
    text = await fs.readFile(path, 'utf8')
  } catch (error) {
    if (missingPath(error)) return { status: 'missing', path }
    throw error
  }
  let after: import('node:fs').Stats
  try {
    after = await fs.stat(path)
  } catch (error) {
    if (missingPath(error)) return { status: 'missing', path }
    throw error
  }
  const out = parseRolloutJsonl(text)
  const sessionId = rolloutSessionId(path, out)
  const fileId = `${after.dev}:${after.ino}`
  return {
    status: 'present',
    path,
    fileId,
    mtimeMs: after.mtimeMs,
    size: after.size,
    stable: before.dev === after.dev
      && before.ino === after.ino
      && Buffer.byteLength(text, 'utf8') === after.size,
    sessionId,
    events: out,
  }
}

function parseRolloutJsonl(text: string): RolloutEvent[] {
  if (!text) return []
  const terminated = text.endsWith('\n')
  const lines = text.split('\n')
  if (terminated) lines.pop()
  const events: RolloutEvent[] = []
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    const unterminatedTail = !terminated && index === lines.length - 1
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      if (unterminatedTail) break
      throw rolloutIntegrityError()
    }
    if (!validRolloutEvent(value)) throw rolloutIntegrityError()
    events.push(value)
  }
  return events
}

function validRolloutEvent(value: unknown): value is RolloutEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const event = value as Record<string, unknown>
  if (typeof event.type !== 'string' || !event.type) return false
  if (event.type !== 'session_meta' && event.type !== 'event_msg') return true
  if (!event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) return false
  const payload = event.payload as Record<string, unknown>
  if (event.type === 'event_msg') return typeof payload.type === 'string' && payload.type.length > 0
  return typeof payload.session_id === 'string'
    && UUID.test(payload.session_id)
    && typeof payload.cwd === 'string'
    && payload.cwd.length > 0
}

function rolloutSessionId(path: string, events: readonly RolloutEvent[]): string | null {
  const filenameId = ROLLOUT.exec(basename(path))?.[1]
  const metadata = events.filter((event) => event.type === 'session_meta')
  if (!metadata.length) return null
  const ids = new Set(metadata.map((event) => String(event.payload?.session_id).toLowerCase()))
  if (ids.size !== 1 || !filenameId || !ids.has(filenameId.toLowerCase())) {
    throw rolloutIntegrityError()
  }
  return filenameId
}

const ROLLOUT_INTEGRITY_ERROR = 'CODEX_ROLLOUT_INTEGRITY'

function rolloutIntegrityError(): Error {
  return Object.assign(new Error('Codex rollout integrity check failed'), {
    code: ROLLOUT_INTEGRITY_ERROR,
  })
}

/** Stable discriminator for a corrupt or identity-mismatched rollout. The
 * reader deliberately throws; callers that poll must stop retrying the same
 * immutable corruption on every timer tick. */
export function isRolloutIntegrityError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === ROLLOUT_INTEGRITY_ERROR
}

function missingPath(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
}

/**
 * Which session did the task we just spawned become?
 *
 * Matches on cwd AND a start at-or-after our spawn. Both are required: cwd
 * alone would adopt whatever conversation the user already had open in that
 * repo and then report our task's state from someone else's session.
 *
 * `sinceMs` is given a small grace, because the rollout's own timestamp is
 * written when Codex boots rather than when we called spawn, and a clock that
 * rounds the wrong way would make the session we are looking for invisible
 * forever.
 */
/** One importable Codex session — same shape the Claude scanner produces, so
 *  the rail can hold both without knowing which is which. */
export interface ImportableCodexSession {
  sessionId: string
  title: string
  cwd: string
  lastActivityAt: number
  project: string
}

const WINDOW_MS = 30 * 24 * 60 * 60 * 1000
/** Written to this recently and someone is almost certainly still typing in it.
 *  Same heuristic and same reason as the Claude rail: a live session sorts to
 *  the top by mtime and `codex resume` against a running process is not a
 *  resume. */
const LIVE_MS = 2 * 60 * 1000

/**
 * Codex CLI sessions on this machine that unmute does not have.
 *
 * The Codex half of the import rail. Deliberately mirrors
 * claude-cli-sessions.ts down to the bounds, because the two lists sit in one
 * rail and a user should not have to learn that one of them ages out sooner.
 *
 * TITLES ARE NOT GIVEN TO US. Claude writes an `aiTitle` on line 1; Codex
 * writes none, so the first user_message is the honest stand-in — it is what
 * the person actually asked for, which is a better name than anything we would
 * invent and costs no model.
 *
 * The cwd comes from `session_meta`, which is authoritative — unlike Claude's
 * directory names, nothing here has to be reconstructed from a lossy path.
 */
export async function listImportableCodexSessions(
  known: ReadonlySet<string>,
  opts: { home?: string; now?: number; windowMs?: number; cap?: number; liveMs?: number } = {},
): Promise<ImportableCodexSession[]> {
  const now = opts.now ?? Date.now()
  const windowMs = opts.windowMs ?? WINDOW_MS
  const liveMs = opts.liveMs ?? LIVE_MS
  const out: ImportableCodexSession[] = []
  let skippedKnown = 0, skippedOld = 0, skippedLive = 0, skippedNoCwd = 0

  for (const r of await allRollouts(opts.home)) {
    if (known.has(r.sessionId)) { skippedKnown++; continue }
    if (now - r.mtimeMs > windowMs) { skippedOld++; continue }
    if (now - r.mtimeMs < liveMs) { skippedLive++; continue }
    const events = await readRolloutEvents(r.path)
    const meta = events.find((e) => e.type === 'session_meta')?.payload as { cwd?: string } | undefined
    if (!meta?.cwd) { skippedNoCwd++; continue }
    // A session whose project is gone cannot be resumed — `resume()` refuses a
    // cwd it cannot reach, so listing it is listing a dead button.
    try { await fs.access(meta.cwd) } catch { skippedNoCwd++; continue }
    const firstAsk = events.find((e) => e.type === 'event_msg' && e.payload?.type === 'user_message')
    const raw = String((firstAsk?.payload?.message ?? firstAsk?.payload?.text ?? '')).trim()
    const project = meta.cwd.split('/').filter(Boolean).pop() ?? meta.cwd
    out.push({
      sessionId: r.sessionId,
      title: raw ? (raw.length > 60 ? raw.slice(0, 59).trimEnd() + '…' : raw.split('\n')[0]) : project,
      cwd: meta.cwd,
      lastActivityAt: r.mtimeMs,
      project,
    })
    if (out.length >= (opts.cap ?? 40)) break
  }
  log.event('codex-cli-importable-scanned', {
    offered: out.length, skippedKnown, skippedOld, skippedLive, skippedNoCwd,
  })
  return out
}

/**
 * Where a Codex thread actually ran, read from its own rollout.
 *
 * The Codex half of the resume repair. `resolveSessionCwd` heals a task whose
 * cwd is wrong or stale — the repo moved, the folder was renamed — by asking
 * the session's own record where it ran. That resolver searched Claude's
 * transcripts only, so an imported CODEX session with a stale path had no
 * recovery at all: the id was looked up among Claude's transcripts, found
 * nowhere, and resume returned false.
 *
 * `session_meta.cwd` is authoritative here and needs no reconstruction —
 * unlike Claude's directory names, which encode the path lossily.
 */
export async function findCodexSessionCwd(sessionId: string, home?: string): Promise<string | null> {
  const path = await findRollout(sessionId, home)
  if (!path) return null
  const events = await readRolloutEvents(path)
  const meta = events.find((e) => e.type === 'session_meta')?.payload as { cwd?: string } | undefined
  const cwd = meta?.cwd
  if (!cwd) return null
  try { await fs.access(cwd); return cwd } catch { return null }   // a path that is gone heals nothing
}

export async function discoverSessionId(
  cwd: string,
  sinceMs: number,
  home?: string,
  graceMs = 5_000,
  excludedSessionIds: ReadonlySet<string> = new Set(),
): Promise<string | null> {
  return discoverSessionIdFrom(cwd, sinceMs, home, graceMs, excludedSessionIds, false)
}

/** Agent discovery is fail-closed on unreadable rollout storage. */
export async function discoverSessionIdStrict(
  cwd: string,
  sinceMs: number,
  home?: string,
  graceMs = 5_000,
  excludedSessionIds: ReadonlySet<string> = new Set(),
): Promise<string | null> {
  return discoverSessionIdFrom(cwd, sinceMs, home, graceMs, excludedSessionIds, true)
}

async function discoverSessionIdFrom(
  cwd: string,
  sinceMs: number,
  home: string | undefined,
  graceMs: number,
  excludedSessionIds: ReadonlySet<string>,
  strict: boolean,
): Promise<string | null> {
  for (const r of await allRollouts(home, strict)) {
    if (r.mtimeMs + graceMs < sinceMs) break        // sorted newest-first: older still
    if (excludedSessionIds.has(r.sessionId)) continue
    let snapshot: RolloutSnapshot
    try {
      snapshot = await readRolloutSnapshot(r.path)
    } catch (error) {
      // Recovery scans every recent Codex session before it can identify the
      // one belonging to this task. One malformed, unrelated rollout must not
      // make every surviving task undiscoverable after an app restart. The
      // agent bootstrap uses strict discovery and still fails closed.
      if (!strict && isRolloutIntegrityError(error)) {
        log.event('codex-cli-discovery-skipped-corrupt-rollout', {
          sessionId: r.sessionId,
        })
        continue
      }
      throw error
    }
    if (snapshot.status === 'missing' || !snapshot.stable) continue
    const events = snapshot.events
    const meta = events.find((e) => e.type === 'session_meta')?.payload as
      { cwd?: string; session_id?: string; timestamp?: string; originator?: string } | undefined
    if (!meta?.cwd || meta.cwd !== cwd) continue
    const started = meta.timestamp ? Date.parse(meta.timestamp) : r.mtimeMs
    if (started + graceMs < sinceMs) continue
    log.event('codex-cli-session-discovered', {
      sessionId: r.sessionId, cwd, originator: meta.originator ?? null,
    })
    return r.sessionId
  }
  return null
}
