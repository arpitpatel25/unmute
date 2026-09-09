import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { ClaudeTaskSession, type ClaudeTaskOptions, type ClaudeTaskEvent } from '../claude/task-session'
import { diagnostic } from '../diagnostics'

export interface ClaudeRuntimeState {
  alive: boolean
  busy: boolean
  activeSubmissionId?: string
  followupBlocked: boolean
  followupUnavailable: boolean
  pid?: number
  models: ClaudeTaskSession['models']
}
export interface ClaudeRuntimeEvent {
  sessionId: string
  sequence: number
  event: ClaudeTaskEvent
  state: ClaudeRuntimeState
}
export const CLAUDE_RUNTIME_RELEASED = 'The provider runtime no longer exists; recover the conversation before submitting'
type Entry = {
  driver: ClaudeTaskSession; events: ClaudeRuntimeEvent[]; opening: Promise<void>; opened: boolean
  /** Last time this session was spoken to or spoke. Drives the idle reap. */
  usedAt: number
}

/**
 * HOW LONG AN IDLE SESSION IS KEPT WARM before its process is let go.
 *
 * A CALENDAR FLOOR, ON PURPOSE. Reaping the instant a turn ends would be
 * technically fine — the conversation is a file on disk and `--resume` brings
 * it back — but it would be a worse product: come back from lunch, send a
 * message, and pay a cold start for nothing. Twelve hours keeps a working day
 * warm and still lets an overnight gap collect.
 */
const DEFAULT_IDLE_MS = 12 * 60 * 60_000

/** How often idleness is checked. Cheap: a walk of a map with a handful of entries. */
const DEFAULT_SWEEP_MS = 5 * 60_000

/**
 * HOW MANY LIVE SESSIONS MAY EXIST AT ONCE.
 *
 * The deadline bounds how LONG one lives; this bounds how MANY exist at a
 * moment, and it is the count that does the damage — six concurrent sessions,
 * each growing with its own context, is gigabytes. Eviction prefers the least
 * recently used IDLE session and never touches one mid-turn, so the cap can
 * only ever cost a resume, never work.
 */
const DEFAULT_MAX_SESSIONS = 4

export interface ClaudeRuntimeLimits {
  idleMs?: number
  sweepMs?: number
  maxSessions?: number
  now?: () => number
}

/**
 * Owns both stdio and approval continuations, including while no UI exists.
 *
 * AND THAT LAST CLAUSE IS WHY THE REAPER LIVES HERE. These sessions outlive the
 * app by design — that is the whole point of the detached runtime — so a sweep
 * in the app's TaskManager only runs while someone is watching. Measured on
 * 2026-09-09: six `claude -p` processes alive for twenty hours under a runtime
 * whose app had long since quit, one of them started five hours after that app
 * was gone. The app-side sweep (`purgeStale`) covers `executors`; nothing
 * covered these, because nothing that runs in the app can.
 */
export class ClaudeRuntimeService {
  private sessions = new Map<string, Entry>()
  private readonly idleMs: number
  private readonly maxSessions: number
  private readonly now: () => number
  private sweepTimer?: ReturnType<typeof setInterval>

  constructor(private root: string, private emit: (event: ClaudeRuntimeEvent) => void,
    private makeDriver: (options: ClaudeTaskOptions) => ClaudeTaskSession = options => new ClaudeTaskSession(options),
    limits: ClaudeRuntimeLimits = {}) {
    mkdirSync(root, { recursive: true, mode: 0o700 })
    this.idleMs = limits.idleMs ?? DEFAULT_IDLE_MS
    this.maxSessions = limits.maxSessions ?? DEFAULT_MAX_SESSIONS
    this.now = limits.now ?? Date.now
    const sweepMs = limits.sweepMs ?? DEFAULT_SWEEP_MS
    this.sweepTimer = setInterval(() => this.sweepIdle(), sweepMs)
    // Never hold the daemon open just to run the sweep.
    ;(this.sweepTimer as { unref?: () => void }).unref?.()
  }

  /** Live sessions. Read by the daemon to decide whether it still has work. */
  get sessionCount(): number { return this.sessions.size }

  /** True while any session is mid-turn — the daemon must not exit under one. */
  get busy(): boolean {
    for (const entry of this.sessions.values()) if (entry.driver.busy) return true
    return false
  }

  /**
   * Let go of sessions that have been idle past the floor.
   *
   * NEVER MID-TURN, at any age. A session with a turn in flight is doing the
   * work the detached runtime exists to protect; killing it would lose an
   * answer that cannot be recovered by resuming, because the turn never
   * finished. `busy` is the driver's own flag, not a silence timer — a model
   * thinking for ten minutes with no output is busy, and must read as busy.
   */
  sweepIdle(): void {
    const now = this.now()
    for (const [id, entry] of this.sessions) {
      if (entry.driver.busy || !entry.opened) continue
      const idleFor = now - entry.usedAt
      if (idleFor < this.idleMs) continue
      this.release(id, entry, 'idle', idleFor)
    }
  }

  /**
   * End a session's PROCESS. The conversation is untouched: it is a transcript
   * on disk, and `open` resumes it by session id on the next message.
   */
  private release(id: string, entry: Entry, reason: 'idle' | 'capacity', idleFor: number): void {
    // CLOSE FIRST, THEN FORGET. `close()` emits `{type:'closed'}`, and that
    // event is how the app learns the session is gone — it flips the proxy's
    // `alive` to false, and `ensureChat` then reopens with `resume` on the next
    // message. Deleting the entry first would still deliver the event, but the
    // order below is the one that reads as intended rather than as a race that
    // happens to work.
    try { entry.driver.close() } catch { /* already gone */ }
    this.sessions.delete(id)
    diagnostic('claude-runtime-session-released', { sessionId: id, reason, idleMs: idleFor, remaining: this.sessions.size })
  }

  /**
   * Make room for a new session when the cap is reached.
   *
   * Evicts the least recently used IDLE session. If every session is mid-turn
   * the new one is allowed through anyway: refusing would block work the person
   * just asked for, and a cap that can stop you working is worse than the
   * problem it prevents. The overshoot is temporary — the sweep collects it.
   */
  private makeRoom(): void {
    if (this.sessions.size < this.maxSessions) return
    let oldest: [string, Entry] | undefined
    for (const pair of this.sessions) {
      if (pair[1].driver.busy || !pair[1].opened) continue
      if (!oldest || pair[1].usedAt < oldest[1].usedAt) oldest = pair
    }
    if (!oldest) {
      diagnostic('claude-runtime-over-capacity', { live: this.sessions.size, cap: this.maxSessions, reason: 'all-busy' })
      return
    }
    this.release(oldest[0], oldest[1], 'capacity', this.now() - oldest[1].usedAt)
  }
  async invoke(method: string, args: any[]): Promise<unknown> {
    if (method === 'list') return [...this.sessions].map(([sessionId, entry]) => ({ sessionId, ...this.state(entry.driver) }))
    const [id, ...rest] = args
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error('Invalid runtime session identity')
    if (method === 'open') {
      let entry = this.sessions.get(id)
      if (!entry || (entry.opened && !entry.driver.alive)) {
        const options = rest[0] as ClaudeTaskOptions
        if (options.sessionId !== id) throw new Error('Provider session identity mismatch')
        // Only a genuinely NEW session consumes a slot; reopening one we already
        // hold is not growth.
        if (!entry) this.makeRoom()
        const events: ClaudeRuntimeEvent[] = entry?.events ?? []
        const driver = this.makeDriver({ ...options, onEvent: event => {
          // THE AGENT SPEAKING IS ACTIVITY TOO. Keying idleness on the user's
          // messages alone would let the reaper fire under a long autonomous
          // run that had simply not been spoken to for a while.
          const live = this.sessions.get(id)
          if (live) live.usedAt = this.now()
          const record = { sessionId: id, sequence: events.length + 1, event, state: this.state(driver) }
          // Runtime receipts survive a daemon crash; only a live daemon can
          // claim that the old process is still executing.
          appendFileSync(join(this.root, `${id}.jsonl`), JSON.stringify(record) + '\n', { mode: 0o600 })
          events.push(record)
          this.emit(record)
        } })
        entry = { driver, events, opening: Promise.resolve(), opened: false, usedAt: this.now() }
        this.sessions.set(id, entry)
        const current = entry
        entry.opening = driver.start().finally(() => { current.opened = true })
      }
      entry.usedAt = this.now()
      await entry.opening
      return { ...this.state(entry.driver), sequence: entry.events.length }
    }
    const entry = this.sessions.get(id)
    if (!entry) throw new Error(CLAUDE_RUNTIME_RELEASED)
    // Any call about a session is use of it — including `state`, which is how
    // an attached UI keeps it in view.
    entry.usedAt = this.now()
    const driver = entry.driver
    switch (method) {
      case 'replay': return entry.events.slice(Number(rest[0]) || 0, (Number(rest[0]) || 0) + 100)
      case 'state': return this.state(driver)
      case 'send': return driver.send(rest[0], rest[1], rest[2], rest[3], rest[4])
      case 'sendNewTurn': return driver.sendNewTurn(rest[0], rest[1], rest[2], rest[3])
      case 'answer': await driver.answer(rest[0], rest[1]); return this.state(driver)
      case 'interrupt': await driver.interrupt(); return this.state(driver)
      case 'close': driver.close(); return this.state(driver)
      default: throw new Error('Unknown Claude runtime method')
    }
  }
  private state(driver: ClaudeTaskSession): ClaudeRuntimeState {
    return { alive: driver.alive, busy: driver.busy, activeSubmissionId: driver.activeSubmissionId,
      followupBlocked: driver.followupBlocked, followupUnavailable: driver.followupUnavailable,
      pid: driver.pid, models: driver.models }
  }
  close(): void {
    if (this.sweepTimer) { clearInterval(this.sweepTimer); this.sweepTimer = undefined }
    for (const entry of this.sessions.values()) entry.driver.close()
    this.sessions.clear()
  }
}
