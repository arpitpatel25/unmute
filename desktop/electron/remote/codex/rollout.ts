// Unmute Remote — Codex desktop READ side: the rollout transcript.
//
// Codex persists every thread as a JSONL rollout at
//   ~/.codex/sessions/YYYY/MM/DD/rollout-<iso-ts>-<threadId>.jsonl
// and that file is the ONLY read channel we use. Deliberately no sqlite:
//   * unmute knows the threadIds of the tasks it created, so it never needs to
//     enumerate Codex's whole store;
//   * a file read costs nothing, works while Codex is CLOSED, and — unlike a
//     DOM read over CDP — cannot yank the user's view, because a Codex renderer
//     mounts exactly ONE conversation at a time (verified 2026-07-25);
//   * no native module, no schema coupling to a store OpenAI may rev.
//
// The event vocabulary below was observed across every rollout on a real
// machine (~60 files). The lifecycle pair we depend on is task_started /
// task_complete; `last_agent_message` on task_complete is the doorbell headline
// for free.
//
// NOT observable here: "blocked on approval". Codex never persists approval
// requests — they are transient and routed to whichever client is the approval
// reviewer (the desktop app). unmute therefore creates its Codex tasks with an
// approval policy that does not block (see driver.ts), exactly as the Claude
// adapter runs with permissions pre-granted, so `needs-user` for a Codex task
// means "the turn finished and the ball is with you" — which IS task_complete.

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/** State of a Codex thread, in Unmute's vocabulary (status-file.ts TaskState). */
export type CodexState = 'processing' | 'ready' | 'failed'

export interface CodexTurn {
  role: 'user' | 'assistant'
  text: string
}

export interface CodexSnapshot {
  /** Derived task state. `ready` = a turn completed and the ball is with the user. */
  state: CodexState
  /** The agent's final message of the last completed turn (the headline). */
  lastAgentMessage: string | null
  /** Last few turns, oldest→newest. */
  turns: CodexTurn[]
  /** ms since epoch of the newest event we could date (0 when unknown). */
  updatedAt: number
  /** Total turns started (for progress display). */
  turnsStarted: number
  /** True once at least one turn has completed. */
  everCompleted: boolean
}

export const DEFAULT_SESSIONS_DIR = join(homedir(), '.codex', 'sessions')

/**
 * Locate the rollout file for a thread. The filename embeds the threadId, so a
 * shallow walk of the date-partitioned tree finds it without an index. Returns
 * null when the thread has no transcript yet (a just-created thread that has
 * not taken a turn) — callers treat that as "processing", never as an error.
 */
export async function findRolloutPath(threadId: string, sessionsDir = DEFAULT_SESSIONS_DIR): Promise<string | null> {
  const needle = `-${threadId}.jsonl`
  // sessions/YYYY/MM/DD/rollout-*.jsonl — walk newest-first so a live thread is
  // found in the first directory we look at.
  const years = await safeDirs(sessionsDir)
  for (const y of years.sort().reverse()) {
    const months = await safeDirs(join(sessionsDir, y))
    for (const m of months.sort().reverse()) {
      const days = await safeDirs(join(sessionsDir, y, m))
      for (const d of days.sort().reverse()) {
        const dir = join(sessionsDir, y, m, d)
        let names: string[] = []
        try { names = await fs.readdir(dir) } catch { continue }
        const hit = names.find((n) => n.endsWith(needle))
        if (hit) return join(dir, hit)
      }
    }
  }
  return null
}

async function safeDirs(dir: string): Promise<string[]> {
  try {
    const ents = await fs.readdir(dir, { withFileTypes: true })
    return ents.filter((e) => e.isDirectory()).map((e) => e.name)
  } catch { return [] }
}

/** Parse a rollout JSONL into the snapshot Unmute's task state is derived from. */
export function parseRollout(text: string, turnLimit = 6): CodexSnapshot {
  const snap: CodexSnapshot = {
    state: 'processing', lastAgentMessage: null, turns: [],
    updatedAt: 0, turnsStarted: 0, everCompleted: false,
  }
  let started = 0
  let completed = 0
  for (const line of text.split('\n')) {
    const raw = line.trim()
    if (!raw) continue
    let ev: any
    try { ev = JSON.parse(raw) } catch { continue } // a torn last line is normal while Codex writes
    const p = ev?.payload ?? {}
    const t = p.type ?? ev?.type

    // Timestamps arrive as seconds in some events and ISO strings in others.
    const stamp = numericMs(p.started_at ?? p.completed_at ?? ev?.timestamp)
    if (stamp > snap.updatedAt) snap.updatedAt = stamp

    switch (t) {
      case 'task_started':
        started++
        break
      case 'task_complete':
        completed++
        if (typeof p.last_agent_message === 'string' && p.last_agent_message) {
          snap.lastAgentMessage = p.last_agent_message
        }
        break
      case 'user_message':
        if (typeof p.message === 'string' && p.message) snap.turns.push({ role: 'user', text: p.message })
        break
      case 'agent_message':
        if (typeof p.message === 'string' && p.message) snap.turns.push({ role: 'assistant', text: p.message })
        break
      case 'error':
      case 'stream_error':
        snap.state = 'failed'
        break
      default:
        break
    }
  }
  snap.turnsStarted = started
  snap.everCompleted = completed > 0
  // A turn is in flight whenever more have started than completed. Otherwise the
  // ball is with the user: that is Unmute's `ready` (ORCHESTRATE-VISION §3 —
  // "the step is over but the ball is with you"), never `done`, because a Codex
  // thread is always continuable.
  //
  // The zero-turn case must be `processing`, NOT `ready`: a just-dispatched
  // thread whose rollout has not appeared yet has started<=completed trivially,
  // and calling that `ready` would put the ball with the user before the agent
  // had even begun — the card would claim a finished step that never ran.
  if (snap.state !== 'failed') {
    snap.state = started === 0 || started > completed ? 'processing' : 'ready'
  }
  if (snap.turns.length > turnLimit) snap.turns = snap.turns.slice(-turnLimit)
  return snap
}

function numericMs(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v // seconds → ms
  if (typeof v === 'string') {
    const ms = Date.parse(v)
    if (Number.isFinite(ms)) return ms
  }
  return 0
}

/**
 * The durable thread id of the newest thread created since `sinceMs`.
 *
 * THIS EXISTS BECAUSE OF A REAL FAILURE. The driver used to wait for the
 * durable id to appear in Codex's sidebar DOM after creating a thread. It never
 * does: the row keeps a transient `local:client-new-thread:<uuid>` id, and the
 * durable id only ever lands in Codex's own store. The wait therefore always
 * timed out ("codex-thread-id-unresolved"), the dispatch reported failure for
 * work that had actually SUCCEEDED, and the task was silently re-run on another
 * agent.
 *
 * The rollout FILENAME carries the durable id, so the file system is the
 * authority. No sqlite, no DOM, no polling a value that will never arrive.
 * Filenames look like:
 *   rollout-2026-07-25T02-40-24-019f95f7-1127-7792-9a96-e1148ed6d954.jsonl
 */
export async function newestThreadIdSince(
  sinceMs: number,
  sessionsDir = DEFAULT_SESSIONS_DIR,
): Promise<string | null> {
  const candidates: Array<{ id: string; mtime: number }> = []
  const years = (await safeDirs(sessionsDir)).sort().reverse()
  // Only the newest date partitions can hold a thread we just created; scanning
  // newest-first and stopping at the first day with a hit keeps this cheap.
  outer: for (const y of years) {
    const months = (await safeDirs(join(sessionsDir, y))).sort().reverse()
    for (const m of months) {
      const days = (await safeDirs(join(sessionsDir, y, m))).sort().reverse().slice(0, 2)
      for (const d of days) {
        const dir = join(sessionsDir, y, m, d)
        let names: string[] = []
        try { names = await fs.readdir(dir) } catch { continue }
        for (const n of names) {
          const id = threadIdFromRolloutName(n)
          if (!id) continue
          try {
            const mtime = (await fs.stat(join(dir, n))).mtimeMs
            if (mtime >= sinceMs) candidates.push({ id, mtime })
          } catch { /* file vanished mid-scan — ignore */ }
        }
        if (candidates.length) break outer
      }
    }
  }
  if (!candidates.length) return null
  candidates.sort((a, b) => b.mtime - a.mtime)
  return candidates[0].id
}

/** Extract the durable thread id from a rollout filename (null if not one). */
export function threadIdFromRolloutName(name: string): string | null {
  if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) return null
  // Trailing UUID: 8-4-4-4-12 hex.
  const m = name.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i)
  return m ? m[1] : null
}

/** Read + parse a thread's rollout. Missing file ⇒ a fresh `processing` snapshot. */
export async function readThread(threadId: string, sessionsDir = DEFAULT_SESSIONS_DIR, turnLimit = 6): Promise<CodexSnapshot> {
  const path = await findRolloutPath(threadId, sessionsDir)
  if (!path) return { state: 'processing', lastAgentMessage: null, turns: [], updatedAt: 0, turnsStarted: 0, everCompleted: false }
  let text = ''
  try { text = await fs.readFile(path, 'utf8') } catch {
    return { state: 'processing', lastAgentMessage: null, turns: [], updatedAt: 0, turnsStarted: 0, everCompleted: false }
  }
  const snap = parseRollout(text, turnLimit)
  if (!snap.updatedAt) {
    try { snap.updatedAt = (await fs.stat(path)).mtimeMs } catch { /* leave 0 */ }
  }
  return snap
}
