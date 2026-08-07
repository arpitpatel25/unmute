/**
 * PRESENCE — are you at the machine, and how much of YOUR time has passed.
 *
 * Two jobs, and the second is the one that matters.
 *
 * ── 1. The wake signal ──────────────────────────────────────────────────────
 *
 * The notch is allowed to open itself exactly once per absence: when you come
 * back. Not when work finishes — you might be sitting right there — and not on
 * a timer. IDLE → ACTIVE is the trigger.
 *
 * "Came back" deliberately does NOT mean "returned to the room". It means you
 * touched the machine after a stretch of not touching it, which is the same
 * event whether you were at lunch or just reading a long page in another
 * window. Keying on physical absence would have left the person who never gets
 * up with no interrupt channel at all — only a badge, and a badge you never
 * look at is not a channel.
 *
 * ── 2. The clock that only runs while you are here ──────────────────────────
 *
 * Things stop demanding after a while, so a checkpoint from this morning is not
 * still shouting this afternoon. But that window exists to give you A CHANCE TO
 * LOOK, and time spent away is not a chance. Burn it on wall-clock and the
 * worst case is the exact opposite of what the feature is for: gone four hours,
 * five threads finish, every one of them ages out while you are at lunch, and
 * you come back to a clean badge and nothing open.
 *
 * So `awakeMs()` is a monotonic clock that advances only while you are present.
 * Everything with an expiry measures against it, never against Date.now().
 *
 * The idle source is `powerMonitor.getSystemIdleTime()` — seconds since the
 * last system-wide input event. It is OS-level, so it sees you working in any
 * app, which is precisely the point; a renderer-level listener would only ever
 * see input aimed at us and would call you idle while you typed all day.
 */

import { EventEmitter } from 'node:events'
import { createLogger } from './log'

const log = createLogger('presence')

/** No input for this long and you are considered away from the machine.
 *
 *  Two minutes, not thirty seconds: the threshold is not "did you pause", it is
 *  "did you go do something else". Reading a diff, watching a build, thinking —
 *  all of that is being present, and waking the surface out of it would make
 *  the one self-opening moment feel random rather than earned. */
const IDLE_AFTER_MS = 2 * 60_000

/** How often we sample. Cheap (a syscall) and nowhere near hot. */
const SAMPLE_MS = 5_000

export interface PresenceLike {
  readonly active: boolean
  awakeMs(): number
  on(event: 'wake', cb: () => void): unknown
  stop(): void
}

export class Presence extends EventEmitter implements PresenceLike {
  private _active = true
  private _awake = 0
  private lastSample: number
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(
    /** Seconds since the last system-wide input. Injected so tests need no Electron. */
    private idleSeconds: () => number,
    private now: () => number = Date.now,
    private idleAfterMs = IDLE_AFTER_MS,
    sampleMs = SAMPLE_MS,
  ) {
    super()
    this.lastSample = now()
    this.timer = setInterval(() => this.sample(), sampleMs)
    this.timer.unref?.()
  }

  get active(): boolean { return this._active }

  /** Milliseconds of YOUR time since start. Only advances while present. */
  awakeMs(): number {
    // Fold in the sliver since the last sample so callers reading between ticks
    // are not quantised to SAMPLE_MS — an expiry check must not step in jumps.
    return this._awake + (this._active ? Math.max(0, this.now() - this.lastSample) : 0)
  }

  private sample(): void {
    const t = this.now()
    const elapsed = Math.max(0, t - this.lastSample)
    // Credit the interval we just LIVED THROUGH to whatever we were then. A
    // transition discovered now happened somewhere inside it; attributing the
    // whole slice to the new state would either gift or steal up to one sample.
    if (this._active) this._awake += elapsed
    this.lastSample = t

    let idleMs: number
    try {
      idleMs = this.idleSeconds() * 1000
    } catch (err) {
      // Never let a flaky idle source strand us as permanently away — that
      // would freeze every expiry in the product. Assume present.
      log.debug('idle probe failed — assuming present', { err: String(err) })
      idleMs = 0
    }
    const nowActive = idleMs < this.idleAfterMs
    if (nowActive === this._active) return

    this._active = nowActive
    if (nowActive) {
      log.event('wake', { awakeMs: Math.round(this._awake) })
      this.emit('wake')
    } else {
      log.event('idle', { awakeMs: Math.round(this._awake) })
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}

/** Always-present stand-in for tests and any path without a power monitor. */
export const ALWAYS_PRESENT: PresenceLike = {
  active: true,
  awakeMs: () => Date.now(),
  on: () => undefined,
  stop: () => undefined,
}
