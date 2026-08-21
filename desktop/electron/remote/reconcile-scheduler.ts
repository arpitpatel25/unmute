/**
 * One heartbeat for every provider reconciliation job.
 *
 * Provider events call trigger() for immediate delivery. The heartbeat exists
 * only to repair missed file events, app-server disconnects, and sleep/wake
 * gaps. Jobs are serialized per key and repeated triggers are coalesced.
 */

type Timer = ReturnType<typeof setInterval>

export interface ReconcileSchedulerOpts {
  tickMs: number
  now?: () => number
  setInterval?: (fn: () => void, ms: number) => Timer
  clearInterval?: (timer: Timer) => void
  onError?: (key: string, error: unknown) => void
}

interface Entry {
  job: () => void | Promise<void>
  interval: () => number
  nextAt: number
  inFlight: boolean
  pending: boolean
}

export class ReconcileScheduler {
  private readonly entries = new Map<string, Entry>()
  private readonly now: () => number
  private readonly startInterval: (fn: () => void, ms: number) => Timer
  private readonly stopInterval: (timer: Timer) => void
  private heartbeat: Timer | null = null

  constructor(private readonly opts: ReconcileSchedulerOpts) {
    this.now = opts.now ?? Date.now
    this.startInterval = opts.setInterval ?? setInterval
    this.stopInterval = opts.clearInterval ?? clearInterval
  }

  register(key: string, job: () => void | Promise<void>, interval: () => number): void {
    const existing = this.entries.get(key)
    if (existing) {
      existing.job = job
      existing.interval = interval
      existing.nextAt = Math.min(existing.nextAt, this.now())
      if (existing.inFlight) existing.pending = true
      return
    }
    this.entries.set(key, {
      job,
      interval,
      nextAt: this.now(),
      inFlight: false,
      pending: false,
    })
    this.ensureHeartbeat()
  }

  unregister(key: string): void {
    this.entries.delete(key)
    if (this.entries.size === 0) this.stopHeartbeat()
  }

  trigger(key: string): void {
    const entry = this.entries.get(key)
    if (!entry) return
    if (entry.inFlight) {
      entry.pending = true
      return
    }
    void this.run(key, entry)
  }

  keys(): IterableIterator<string> {
    return this.entries.keys()
  }

  shutdown(): void {
    this.entries.clear()
    this.stopHeartbeat()
  }

  private ensureHeartbeat(): void {
    if (this.heartbeat !== null) return
    this.heartbeat = this.startInterval(() => this.tick(), Math.max(1, this.opts.tickMs))
  }

  private stopHeartbeat(): void {
    if (this.heartbeat === null) return
    this.stopInterval(this.heartbeat)
    this.heartbeat = null
  }

  private tick(): void {
    const now = this.now()
    for (const [key, entry] of this.entries) {
      if (!entry.inFlight && entry.nextAt <= now) void this.run(key, entry)
    }
  }

  private async run(key: string, entry: Entry): Promise<void> {
    if (this.entries.get(key) !== entry) return
    entry.inFlight = true
    try {
      await entry.job()
    } catch (error) {
      if (this.entries.get(key) === entry) this.opts.onError?.(key, error)
    } finally {
      if (this.entries.get(key) !== entry) return
      entry.inFlight = false
      entry.nextAt = this.now() + this.safeInterval(entry.interval)
      if (entry.pending) {
        entry.pending = false
        void this.run(key, entry)
      }
    }
  }

  private safeInterval(interval: () => number): number {
    const value = interval()
    return Number.isFinite(value) ? Math.max(1, value) : 60_000
  }
}
