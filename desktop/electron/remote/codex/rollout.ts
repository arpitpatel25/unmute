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
// PARTIALLY observable here: "blocked on approval". Codex never persists the
// approval REQUEST — it is transient and routed to whichever client is the
// approval reviewer (the desktop app). The original design leaned on that being
// harmless, because unmute creates its Codex tasks with an approval policy that
// does not block (see driver.ts).
//
// That assumption does not hold for COMPUTER USE consents. Observed 2026-07-30:
// a task asked to drive WhatsApp, Codex raised "Allow ChatGPT to use WhatsApp?"
// in its own window, and NOTHING was written here — no hook fired either, since
// Computer Use consents do not go through `PermissionRequest`. The turn simply
// stopped mid-`exec` and the rollout froze.
//
// What IS observable is the shadow it casts: the `exec` call line with no
// matching `*_call_output`, and a file that stops growing. That pair is exposed
// as `pendingToolCalls` — a CANDIDATE signal, never proof, because a slow build
// looks the same. cdp.ts reads the authoritative "Awaiting approval" from the
// DOM for the mounted thread.

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
  /** `work` heads a run of commentary+tool items — Codex's "Worked for 2m 46s". */
  role: 'user' | 'assistant' | 'commentary' | 'tool' | 'work'
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
  /**
   * Tool calls opened but never closed — the call line is written, its
   * `*_call_output` never arrives.
   *
   * This is the ONLY on-disk trace of a turn that has stalled: a Computer Use
   * consent ("Allow ChatGPT to use WhatsApp?") blocks the exec and Codex writes
   * nothing further, so the rollout freezes mid-call. It is deliberately NOT
   * proof of blocking on its own — a slow build looks identical — so callers
   * must pair it with "and the file stopped growing" before drawing any
   * conclusion. See TaskManager.pollCodex.
   */
  pendingToolCalls: number
  /** Name of the oldest unclosed call, for the card's "waiting on…" line. */
  pendingToolName: string | null
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
    pendingToolCalls: 0, pendingToolName: null,
  }
  let started = 0
  let completed = 0
  // call_id → the step awaiting its output. Codex writes the call and its
  // result as separate lines, sometimes many lines apart.
  const pendingCalls = new Map<string, CodexTurn>()
  // call_id → tool name, kept in step with pendingCalls so an unclosed call can
  // name itself ("exec") without re-walking the turns.
  const pendingNames = new Map<string, string>()
  // Wall time per completed turn, in order — used to head each work block.
  const turnDurations: number[] = []
  let turnStartedAt = 0

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
        turnStartedAt = stamp || turnStartedAt
        break
      case 'task_complete':
        completed++
        // Codex's own header is the WALL time of the turn ("Worked for 2m 46s"),
        // which includes model thinking — always longer than the steps add up
        // to. `task_complete` reports it directly; measured 167s against the
        // steps' 107s on the same turn, so deriving it from the steps would
        // have been visibly wrong next to the real Codex window.
        // NOT numericMs(): that one reads EPOCH stamps and scales seconds→ms,
        // which turns a 166877ms duration into 166877 seconds.
        const reported = typeof p.duration_ms === 'number' && Number.isFinite(p.duration_ms) ? p.duration_ms : 0
        if (reported > 0) turnDurations.push(reported)
        else if (turnStartedAt && stamp > turnStartedAt) turnDurations.push(stamp - turnStartedAt)
        else turnDurations.push(0)
        turnStartedAt = 0
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
        // Plumbing the user never sees in Codex either. `wait` is how the model
        // polls a still-running cell — showing it as a step of the work is like
        // listing "checked whether it was done yet" as an achievement.
        if (typeof p.name === 'string' && INTERNAL_STEPS.has(p.name)) break
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
        pendingNames.set(callId, typeof p.name === 'string' ? p.name : 'step')
        break
      }

      case 'custom_tool_call_output':
      case 'function_call_output': {
        const callId = typeof p.call_id === 'string' ? p.call_id : null
        const turn = callId ? pendingCalls.get(callId) : undefined
        if (!turn || !callId) break
        pendingCalls.delete(callId)
        pendingNames.delete(callId)
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
  snap.pendingToolCalls = pendingCalls.size
  snap.pendingToolName = pendingNames.size ? [...pendingNames.values()][0] : null
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
  snap.turns = withWorkBlocks(snap.turns, turnDurations)
  if (snap.turns.length > turnLimit) snap.turns = snap.turns.slice(-turnLimit)
  return snap
}

/**
 * Head each run of commentary/tool items with a `work` marker.
 *
 * Codex collapses everything it did into ONE line — "Worked for 2m 46s ›" —
 * and shows the answer underneath. Rendering a dozen step rows inline, which is
 * what we did, buries the one thing the user came for.
 *
 * The duration is the turn's real wall time where the rollout recorded it;
 * otherwise the steps' own times, which under-counts (it excludes model
 * thinking) but never invents a number.
 */
function withWorkBlocks(items: CodexTurn[], durations: number[]): CodexTurn[] {
  const out: CodexTurn[] = []
  let block = 0
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    const isWork = it.role === 'tool' || it.role === 'commentary'
    const startsRun = isWork && (i === 0 || !(items[i - 1].role === 'tool' || items[i - 1].role === 'commentary'))
    if (startsRun) {
      let summed = 0
      for (let j = i; j < items.length && (items[j].role === 'tool' || items[j].role === 'commentary'); j++) {
        summed += items[j].durationMs ?? 0
      }
      out.push({ role: 'work', text: '', durationMs: durations[block] || summed })
      block++
    }
    out.push(it)
  }
  return out
}

/** Steps that are Codex's plumbing, not the user's work. */
const INTERNAL_STEPS = new Set(['wait'])

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
/**
 * Creation time from the filename, e.g. `rollout-2026-07-30T21-12-54-<id>.jsonl`.
 * Null when unparseable, so callers fall back rather than treating the file as
 * absent.
 */
export function rolloutCreatedAt(name: string): number | null {
  const m = name.match(/^rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-/)
  if (!m) return null
  const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]),
                     Number(m[4]), Number(m[5]), Number(m[6])).getTime()
  return Number.isFinite(t) ? t : null
}

export async function newestThreadIdSince(
  sinceMs: number,
  sessionsDir = DEFAULT_SESSIONS_DIR,
  /** Threads already claimed by a live task. A thread we are creating RIGHT NOW
   *  can never be one of these, so excluding them makes a collision impossible
   *  rather than merely unlikely — and it is independent of any timestamp. */
  exclude: ReadonlySet<string> = new Set(),
): Promise<string | null> {
  const candidates: Array<{ id: string; at: number }> = []
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
          if (!id || exclude.has(id)) continue
          // CREATION time from the FILENAME — never mtime.
          //
          // mtime is bumped by every append, so a thread that is merely STILL
          // RUNNING looks brand new forever. Measured across 57 real rollouts:
          // 26 had an mtime more than a minute past creation, one by 18 HOURS.
          // So dispatching a second task while a first was working handed the
          // newcomer the RUNNING thread's id — two cards, one Codex thread,
          // each showing the other's conversation (observed 2026-07-30: two
          // dispatches 29s apart resolved to the same threadId, and the
          // resolver reported attempts:1, having never needed to wait).
          //
          // The filename stamp is written once and never changes. mtime stays
          // as the fallback for an unparseable name (57/57 parsed on a real
          // machine) so a naming change degrades to the old behaviour instead
          // of breaking task creation outright.
          let at = rolloutCreatedAt(n)
          if (at === null) {
            try { at = (await fs.stat(join(dir, n))).mtimeMs } catch { continue }
          }
          if (at >= sinceMs) candidates.push({ id, at })
        }
        if (candidates.length) break outer
      }
    }
  }
  if (!candidates.length) return null
  candidates.sort((a, b) => b.at - a.at)
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
/**
 * Reparsing is skipped while the file is byte-for-byte unchanged.
 *
 * Every poll re-read and re-parsed the whole JSONL — and the parse is no longer
 * cheap now that it reconstructs the item stream. A long thread is megabytes,
 * and the common case by far is "nothing happened since last time", where the
 * work is entirely wasted. Keyed on (size, mtime), which is exactly what
 * changes when Codex appends.
 */
const parseCache = new Map<string, { size: number; mtimeMs: number; limit: number; snap: CodexSnapshot }>()

const EMPTY = (): CodexSnapshot =>
  ({ state: 'processing', lastAgentMessage: null, turns: [], updatedAt: 0, turnsStarted: 0,
     everCompleted: false, pendingToolCalls: 0, pendingToolName: null })

export async function readThread(threadId: string, sessionsDir = DEFAULT_SESSIONS_DIR, turnLimit = 6): Promise<CodexSnapshot> {
  const path = await findRolloutPath(threadId, sessionsDir)
  if (!path) return EMPTY()

  let stat: { size: number; mtimeMs: number } | null = null
  try { stat = await fs.stat(path) } catch { return EMPTY() }

  const hit = parseCache.get(path)
  if (hit && hit.size === stat.size && hit.mtimeMs === stat.mtimeMs && hit.limit === turnLimit) return hit.snap

  let text = ''
  try { text = await fs.readFile(path, 'utf8') } catch { return EMPTY() }
  const snap = parseRollout(text, turnLimit)
  if (!snap.updatedAt) snap.updatedAt = stat.mtimeMs
  parseCache.set(path, { size: stat.size, mtimeMs: stat.mtimeMs, limit: turnLimit, snap })
  // Bounded: one entry per thread we have ever polled, dropped oldest-first.
  if (parseCache.size > 64) parseCache.delete(parseCache.keys().next().value as string)
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

/**
 * Watch a thread's rollout and call back when Codex appends to it.
 *
 * WHY. Codex state was polled only: 1s while a turn runs, and every 10th tick
 * (~10s) once a task is `ready`, because re-reading the JSONL for every
 * finished task on the wall was costly (see the backoff in task-manager). The
 * user-visible result was "Codex has already answered but unmute takes ages to
 * show it" — up to 10s of dead air, and the 10s branch is exactly the case
 * where the user is watching.
 *
 * A watcher removes the wait without removing the backoff: the poll stays as
 * the correctness backstop (fs.watch is best-effort, coalesces, and can miss
 * events), and this only makes the common case immediate.
 *
 * Deliberately cheap and forgiving:
 *   * resolves the path once, then watches the FILE — no directory scan;
 *   * debounced, because an append fires several change events;
 *   * every failure is a no-op returning a usable disposer. A watcher that
 *     cannot start must degrade to today's polling, never throw into the poll
 *     loop.
 */
export async function watchThread(
  threadId: string,
  onChange: () => void,
  sessionsDir = DEFAULT_SESSIONS_DIR,
  debounceMs = 150,
): Promise<() => void> {
  const noop = () => {}
  const path = await findRolloutPath(threadId, sessionsDir)
  if (!path) return noop            // no transcript yet — the poll will find it
  let timer: ReturnType<typeof setTimeout> | null = null
  let watcher: import('node:fs').FSWatcher | null = null
  try {
    const { watch } = await import('node:fs')
    watcher = watch(path, { persistent: false }, () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => { timer = null; try { onChange() } catch { /* never break the watcher */ } }, debounceMs)
    })
    watcher.on('error', () => { try { watcher?.close() } catch { /* already gone */ } })
  } catch {
    return noop
  }
  return () => {
    if (timer) { clearTimeout(timer); timer = null }
    try { watcher?.close() } catch { /* already gone */ }
  }
}
