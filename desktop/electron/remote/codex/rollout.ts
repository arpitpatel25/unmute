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

/**
 * One entry of a Codex thread, in the shape Codex itself shows it.
 *
 * A Claude task's transcript is a terminal — the real thing, raw. The honest
 * equivalent for Codex is its own item stream, so this deliberately keeps the
 * DISTINCTIONS Codex draws rather than flattening everything to text:
 *
 *   user        what you asked
 *   commentary  the running "I'll do X next" line (phase: commentary)
 *   tool        a step it ran — its own title, the code, and the output
 *   assistant   the final answer (phase: final_answer)
 *
 * Flattening these was real data loss: a turn that opened a browser, searched
 * YouTube and verified a channel rendered as a single grey sentence, because
 * only `agent_message` survived.
 */
export interface CodexTurn {
  role: 'user' | 'assistant' | 'commentary' | 'tool'
  text: string
  /** tool: the step's own label — Codex's `title`, e.g. "Search YouTube". */
  title?: string
  /** tool: the exact code/command it ran. */
  code?: string
  /** tool: what came back (truncated). */
  output?: string
  /** tool: wall time Codex reported, in ms. */
  durationMs?: number
  /** tool: false when the step reported an error. */
  ok?: boolean
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
  // call_id → the step awaiting its output. Codex writes the call and its
  // result as separate lines, sometimes many lines apart.
  const pendingCalls = new Map<string, CodexTurn>()

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
        // The EVENT is the authority for what you actually said. A matching
        // `response_item` message exists too, but so do several synthetic
        // user-role messages Codex injects (<app-context>, <recommended_plugins>)
        // which are not yours and must never be shown back to you.
        if (typeof p.message === 'string' && p.message) snap.turns.push({ role: 'user', text: p.message })
        break

      case 'message': {
        // `agent_message` events carry the same assistant text but NOT the
        // phase, and Codex draws a real distinction between a running
        // commentary line and the final answer. So the response_item is the
        // source, and the event is skipped so each answer appears once.
        if (p.role !== 'assistant') break
        const text = textOf(p.content)
        if (text) snap.turns.push({ role: p.phase === 'commentary' ? 'commentary' : 'assistant', text })
        break
      }

      case 'custom_tool_call':
      case 'function_call': {
        // Open the step; its output arrives later under the same call_id.
        const callId = typeof p.call_id === 'string' ? p.call_id : null
        if (!callId) break
        const code = typeof p.input === 'string' ? p.input
          : typeof p.arguments === 'string' ? p.arguments : ''
        const turn: CodexTurn = {
          role: 'tool',
          text: '',
          title: stepTitle(code, typeof p.name === 'string' ? p.name : 'step'),
          code: clip(code, 1200),
        }
        snap.turns.push(turn)
        pendingCalls.set(callId, turn)
        break
      }

      case 'custom_tool_call_output':
      case 'function_call_output': {
        const callId = typeof p.call_id === 'string' ? p.call_id : null
        const turn = callId ? pendingCalls.get(callId) : undefined
        if (!turn || !callId) break
        pendingCalls.delete(callId)
        const out = textOf(p.output)
        // Codex prefixes its own status line ("Script completed / Wall time 2.9
        // seconds / Output:"); lift the timing out of it and show the rest.
        const wall = /Wall time ([\d.]+) seconds/.exec(out)
        if (wall) turn.durationMs = Math.round(parseFloat(wall[1]) * 1000)
        turn.ok = !/^\s*error/i.test(out)
        turn.output = clip(
          out.replace(/^Script (?:completed|running[^\n]*)\n(?:Wall time [^\n]*\n)?(?:Output:\s*)?/, '').trim(),
          2000,
        )
        break
      }
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

/**
 * Codex content arrives as a string, as an array of {type,text} parts, or as a
 * single part. Flatten whichever shape without losing anything.
 */
function textOf(v: unknown): string {
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return v.map(textOf).filter(Boolean).join('\n')
  if (v && typeof v === 'object') {
    const t = (v as { text?: unknown }).text
    if (typeof t === 'string') return t
  }
  return ''
}

/**
 * The label Codex puts on a step.
 *
 * Its exec payloads embed the human title it displays — {"title":"Search
 * YouTube", …} — so prefer that over the tool's internal name: it is shorter
 * and it is exactly what the user saw in the Codex window.
 */
function stepTitle(code: string, fallback: string): string {
  for (const key of ['title', 'cmd']) {
    const m = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(code)
    if (m) { try { return JSON.parse(`"${m[1]}"`) as string } catch { return m[1] } }
  }
  return fallback
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}\n… (${s.length - n} more characters)` : s
}
