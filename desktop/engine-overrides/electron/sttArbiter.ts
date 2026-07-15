// SttArbiter — session-scoped engine routing for dictation STT.
//
// Replaces the per-chunk 4s cloud-vs-local race that produced mixed-engine
// transcripts (the #1 proven accuracy failure, 2026-07-14 investigation:
// every garbled field dictation was a silent local commit or a mid-transcript
// engine flip). The contract it enforces:
//
//   * Mid-recording: NO commits. Nobody is waiting while they're speaking —
//     a chunk resolves early only if its cloud result lands. Local drafts
//     still warm up speculatively so a later switch pastes instantly.
//   * Post key-up (recordingEnded): cloud pastes the moment it completes;
//     at offerAfterMs a "quick draft ready" offer fires (UI); acceptDraft()
//     or the hardDeadlineMs auto-resolve switch to local.
//   * The switch is ONE-WAY and INDEX-ORDERED: once chunk k goes local,
//     every chunk ≥ k goes local, even if its cloud arrived. Every
//     transcript is full-cloud, cloud-prefix + local-suffix, or full-local.
//     Chunks also COMMIT (settle their promise) strictly in index order —
//     a later chunk's cloud result is held even if it arrives first, so a
//     switch decided while it's still waiting can still redirect it to
//     local instead of a cloud value that already "left the building".
//   * Late cloud results (within lateCloudWindowMs of a local commit) are
//     surfaced via onLateCloud for history's "better take".
//
// Pure module: no electron imports — unit-tested by sttArbiter.test.ts.

export type EngineSource = 'cloud' | 'local'
export interface ChunkResolution { text: string; source: EngineSource }

export interface ArbiterEvents {
  onDraftOffer?: () => void
  onDraftResolved?: (how: 'cloud' | 'accepted' | 'deadline') => void
  onLateCloud?: (chunkIndex: number, text: string) => void
}

export interface ArbiterTimeouts {
  speculateAfterMs: number
  offerAfterMs: number
  hardDeadlineMs: number
  lateCloudWindowMs: number
}

export const DEFAULT_TIMEOUTS: ArbiterTimeouts = {
  speculateAfterMs: 1_500,
  offerAfterMs: 4_000,
  hardDeadlineMs: 12_000,
  lateCloudWindowMs: 30_000,
}

interface ChunkEntry {
  idx: number
  cloud: Promise<string | null>
  cloudSettled: boolean
  cloudText: string | null
  startLocal: (() => Promise<string | null>) | null
  localStarted: boolean
  localSettled: boolean
  localText: string | null
  committed: boolean
  committedResult: ChunkResolution | null
  commitAt: number
  resolve: (r: ChunkResolution | null) => void
  promise: Promise<ChunkResolution | null>
  speculateTimer: ReturnType<typeof setTimeout> | null
}

export class SttArbiter {
  private chunks = new Map<number, ChunkEntry>()
  private events: ArbiterEvents
  private t: ArbiterTimeouts
  private ended = false
  private disposed = false
  /** Index at which the one-way cloud→local switch happened; null = no switch. */
  private switchIndex: number | null = null
  private offerFired = false
  private resolvedNotified = false
  private offerTimer: ReturnType<typeof setTimeout> | null = null
  private deadlineTimer: ReturnType<typeof setTimeout> | null = null

  constructor(events: ArbiterEvents = {}, timeouts: Partial<ArbiterTimeouts> = {}) {
    this.events = events
    this.t = { ...DEFAULT_TIMEOUTS, ...timeouts }
  }

  get engineSummary(): 'cloud' | 'local' | 'mixed' | 'none' {
    let sawCloud = false
    let sawLocal = false
    for (const c of this.chunks.values()) {
      if (c.committedResult?.source === 'cloud') sawCloud = true
      if (c.committedResult?.source === 'local') sawLocal = true
    }
    if (sawCloud && sawLocal) return 'mixed'
    if (sawLocal) return 'local'
    if (sawCloud) return 'cloud'
    return 'none'
  }

  submitChunk(
    idx: number,
    cloud: Promise<string | null>,
    startLocal: (() => Promise<string | null>) | null,
  ): Promise<ChunkResolution | null> {
    let resolveFn!: (r: ChunkResolution | null) => void
    const promise = new Promise<ChunkResolution | null>((r) => { resolveFn = r })
    const entry: ChunkEntry = {
      idx, cloud, cloudSettled: false, cloudText: null,
      startLocal, localStarted: false, localSettled: false, localText: null,
      committed: false, committedResult: null, commitAt: 0,
      resolve: resolveFn, promise, speculateTimer: null,
    }
    this.chunks.set(idx, entry)

    // A chunk submitted after dispose can never resolve — settle it now.
    if (this.disposed) {
      entry.committed = true
      entry.committedResult = null
      entry.resolve(null)
      return promise
    }

    // Cloud watcher — does double duty:
    //  1. Before commit: feeds the ordered-advance loop with fresh data.
    //  2. After a LOCAL commit: reports a late cloud result within the window.
    void cloud.then((text) => {
      if (this.disposed) return
      entry.cloudSettled = true
      entry.cloudText = text
      this.onCloudSettled(entry)
    }).catch(() => {
      if (this.disposed) return
      entry.cloudSettled = true
      entry.cloudText = null
      this.onCloudSettled(entry)
    })

    if (this.ended) {
      // Late chunk (submitted after key-up): the session timers may have
      // already fired and self-disarmed with nothing pending. A late chunk
      // must NEVER be able to hang, so (a) start its local draft NOW, and
      // (b) re-arm fresh offer/deadline coverage if none is armed.
      this.startLocalFor(entry)
      if (this.switchIndex === null) {
        if (!this.offerFired && this.offerTimer === null) this.armOfferTimer()
        if (this.deadlineTimer === null) this.armDeadlineTimer()
      }
    } else if (startLocal) {
      // Speculation: warm the local draft if cloud is slow. Never commits
      // here directly — the advance loop decides when a draft is used.
      entry.speculateTimer = setTimeout(() => {
        entry.speculateTimer = null
        this.startLocalFor(entry)
      }, this.t.speculateAfterMs)
    }
    this.tryAdvance()
    return promise
  }

  recordingEnded(): void {
    if (this.ended || this.disposed) return
    this.ended = true
    if (this.switchIndex === null) {
      if (!this.offerFired) this.armOfferTimer()
      this.armDeadlineTimer()
    }
    // Ensure every pending chunk has a warming draft NOW — key-up starts the clock.
    for (const c of this.chunks.values()) {
      if (!c.committed && c.startLocal) {
        if (c.speculateTimer) { clearTimeout(c.speculateTimer); c.speculateTimer = null }
        this.startLocalFor(c)
      }
    }
    this.tryAdvance()
  }

  acceptDraft(): void {
    if (!this.ended || this.disposed) return
    if (this.hasPending()) this.switchToLocal('accepted')
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.clearSessionTimers()
    for (const c of this.chunks.values()) {
      if (c.speculateTimer) { clearTimeout(c.speculateTimer); c.speculateTimer = null }
      // Nobody may hang on a disposed arbiter: settle every pending chunk.
      if (!c.committed) {
        c.committed = true
        c.committedResult = null
        c.resolve(null)
      }
    }
  }

  private armOfferTimer(): void {
    this.offerTimer = setTimeout(() => {
      this.offerTimer = null
      if (!this.disposed && !this.offerFired && this.hasPending()) {
        this.offerFired = true
        this.events.onDraftOffer?.()
      }
    }, this.t.offerAfterMs)
  }

  private armDeadlineTimer(): void {
    this.deadlineTimer = setTimeout(() => {
      this.deadlineTimer = null
      if (!this.disposed && this.hasPending()) this.switchToLocal('deadline')
    }, this.t.hardDeadlineMs)
  }

  private hasPending(): boolean {
    for (const c of this.chunks.values()) if (!c.committed) return true
    return false
  }

  private startLocalFor(entry: ChunkEntry): void {
    if (entry.localStarted || entry.committed || !entry.startLocal) return
    entry.localStarted = true
    entry.startLocal().then((text) => {
      if (this.disposed) return
      entry.localSettled = true
      entry.localText = text
      this.tryAdvance()
    }).catch(() => {
      if (this.disposed) return
      entry.localSettled = true
      entry.localText = null
      this.tryAdvance()
    })
  }

  private onCloudSettled(entry: ChunkEntry): void {
    if (entry.committed) {
      // Late cloud: only meaningful (and only reported) for a chunk that
      // committed via local, and only within the configured window.
      if (
        entry.cloudText != null &&
        entry.committedResult?.source === 'local' &&
        Date.now() - entry.commitAt <= this.t.lateCloudWindowMs
      ) {
        this.events.onLateCloud?.(entry.idx, entry.cloudText)
      }
      return
    }
    this.tryAdvance()
  }

  private finalize(entry: ChunkEntry, result: ChunkResolution | null): void {
    if (entry.committed || this.disposed) return
    entry.committed = true
    entry.committedResult = result
    entry.commitAt = Date.now()
    entry.resolve(result)
  }

  /**
   * Advance commits strictly in index order: only the lowest still-pending
   * chunk is ever considered, and we stop the moment it isn't ready yet
   * (whatever data it's missing will re-trigger this loop when it lands).
   */
  private tryAdvance(): void {
    if (this.disposed) return
    for (;;) {
      const head = this.lowestPending()
      if (!head) break

      const switched = this.switchIndex !== null && head.idx >= this.switchIndex
      if (switched) {
        if (!head.startLocal) {
          // No local available at all — cloud is the only source, however late.
          if (!head.cloudSettled) break
          this.finalize(head, head.cloudText != null ? { text: head.cloudText, source: 'cloud' } : null)
          continue
        }
        this.startLocalFor(head)
        if (!head.localSettled) break
        if (head.localText != null) {
          this.finalize(head, { text: head.localText, source: 'local' })
          continue
        }
        // Local resolved but empty/failed — fall back to cloud.
        if (!head.cloudSettled) break
        this.finalize(head, head.cloudText != null ? { text: head.cloudText, source: 'cloud' } : null)
        continue
      }

      // No switch yet: mid-recording rule — commit only once cloud settles.
      if (!head.cloudSettled) break
      if (head.cloudText != null) {
        this.finalize(head, { text: head.cloudText, source: 'cloud' })
        continue
      }
      // Cloud FAILED (settled null / rejected) — never bypass the switch
      // machinery: this chunk going local means ALL later chunks must too,
      // even mid-recording (shape integrity beats waiting for key-up).
      this.beginSwitch(head.idx, 'deadline')
      // Loop re-examines head under the switched branch above.
    }
    this.maybeAllCloudResolved()
  }

  private lowestPending(): ChunkEntry | null {
    let lowest: ChunkEntry | null = null
    for (const c of this.chunks.values()) {
      if (!c.committed && (lowest === null || c.idx < lowest.idx)) lowest = c
    }
    return lowest
  }

  private maybeAllCloudResolved(): void {
    if (!this.ended || this.resolvedNotified || this.disposed) return
    if (this.hasPending()) return
    if (this.switchIndex === null) {
      this.resolvedNotified = true
      this.clearSessionTimers()
      this.events.onDraftResolved?.('cloud')
    }
  }

  private clearSessionTimers(): void {
    if (this.offerTimer) { clearTimeout(this.offerTimer); this.offerTimer = null }
    if (this.deadlineTimer) { clearTimeout(this.deadlineTimer); this.deadlineTimer = null }
  }

  private switchToLocal(how: 'accepted' | 'deadline'): void {
    if (this.switchIndex !== null || this.disposed) return // one-way
    const head = this.lowestPending()
    if (!head) return
    this.beginSwitch(head.idx, how)
    this.tryAdvance()
  }

  /** Flip the one-way switch at `idx`: fire the notification, disarm timers. */
  private beginSwitch(idx: number, how: 'accepted' | 'deadline'): void {
    if (this.switchIndex !== null || this.disposed) return
    this.switchIndex = idx
    if (!this.resolvedNotified) {
      this.resolvedNotified = true
      this.events.onDraftResolved?.(how)
    }
    this.clearSessionTimers()
  }
}
