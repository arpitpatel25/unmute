/**
 * Keeping the record current, without a clock and without a surprise bill.
 *
 * IDLE, NOT HOURLY. An hourly sweep does the wrong work twice: it catches
 * sessions mid-turn, in a state about to change, and re-processes anything
 * touched in that hour whether or not a turn finished. A session that has been
 * quiet for a couple of minutes is the only moment its state is coherent, so
 * that is when it is summarised.
 *
 * THIS IS THE FIRST THING IN THE AGENT THAT SPENDS ON A SCHEDULE rather than on
 * a request, so it is bounded on every axis that can run away: concurrency, a
 * byte cap on any transcript never read before, and an environment switch that
 * turns it off entirely. It spends the user's own CLI, never managed billing.
 */
import { createLogger } from '../../log'
import { writeRecord } from './record'
import type { SessionStore } from './store'
import type { RunModel } from './summary'

const log = createLogger('agent-sessions')

/** How long a session must be quiet before its summary is worth updating. */
export const IDLE_MS = 2 * 60_000
/** How often idleness is checked. Cheap: mtimes only, no file is opened. */
export const TICK_MS = 60_000

/**
 * The off switch. `UNMUTE_AGENT_SESSION_SUMMARIES=0` stops every model call
 * here with no rebuild — the record simply stops being written, and the Agent
 * falls through to reading transcripts itself, exactly as a bare Claude Code
 * session would. Shaped like UNMUTE_AGENT_RUNTIME for the same reason: the
 * failure modes of a background spender are hard to debug after the fact, and
 * being able to turn it off is worth more than being able to tune it.
 */
export function summariesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.UNMUTE_AGENT_SESSION_SUMMARIES?.trim() !== '0'
}

export interface SweeperOptions {
  store: SessionStore
  recordPath: string
  run: RunModel
  parseJson: (raw: string) => unknown
  now?: () => number
  idleMs?: number
  tickMs?: number
  windowMs?: number
  env?: NodeJS.ProcessEnv
}

export class SessionSweeper {
  private timer: NodeJS.Timeout | null = null
  private running = false
  private readonly signal = { aborted: false }
  private readonly now: () => number

  constructor(private readonly options: SweeperOptions) {
    this.now = options.now ?? Date.now
  }

  /** Runs one pass immediately, then keeps the record current in the background. */
  start(): void {
    if (this.timer || !summariesEnabled(this.options.env)) {
      if (!summariesEnabled(this.options.env)) {
        log.event('session-summaries-disabled', {})
      }
      return
    }
    void this.tick()
    this.timer = setInterval(() => { void this.tick() }, this.options.tickMs ?? TICK_MS)
    this.timer.unref?.()
  }

  stop(): void {
    this.signal.aborted = true
    if (this.timer) { clearInterval(this.timer); this.timer = null }
  }

  /**
   * One pass. Never overlaps itself — a sweep that ran long would otherwise
   * stack, and two passes summarising the same session would both advance the
   * same cursor.
   */
  async tick(): Promise<void> {
    if (this.running || this.signal.aborted) return
    if (!summariesEnabled(this.options.env)) return
    this.running = true
    const startedAt = this.now()
    try {
      const tally = await this.options.store.refresh(
        this.guarded(),
        this.options.parseJson,
        { signal: this.signal, idleMs: this.options.idleMs ?? IDLE_MS },
      )
      if (tally.updated > 0) {
        await writeRecord(this.options.recordPath, this.options.store.all(), {
          now: this.now(),
          ...(this.options.windowMs === undefined ? {} : { windowMs: this.options.windowMs }),
        })
      }
      if (tally.updated > 0 || tally.failed > 0) {
        log.event('session-record-swept', { ...tally, ms: this.now() - startedAt })
      }
    } catch (error) {
      // A sweep is housekeeping. It must never take the Agent down with it.
      log.warn('session sweep failed', { error: (error as Error).message })
    } finally {
      this.running = false
    }
  }

  /** A session still being typed into is not ready to be summarised. */
  private guarded(): RunModel {
    return async (input: string) => {
      if (this.signal.aborted) return { ok: false, error: 'shutting down' }
      return this.options.run(input)
    }
  }
}

/** True when a session has been quiet long enough to have a coherent state. */
export function isIdle(lastTouchedAt: number, now: number, idleMs = IDLE_MS): boolean {
  return now - lastTouchedAt >= idleMs
}
