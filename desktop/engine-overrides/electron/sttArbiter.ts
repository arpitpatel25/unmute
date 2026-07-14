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

    // Cloud watcher — does double duty:
    //  1. Before commit: feeds the ordered-advance loop with fresh data.
    //  2. After a LOCAL commit: reports a late cloud result within the window.
    void cloud.then((text) => {
      entry.cloudSettled = true
      entry.cloudText = text
      this.onCloudSettled(entry)
    }).catch(() => {
      entry.cloudSettled = true
      entry.cloudText = null
      this.onCloudSettled(entry)
    })

    // Speculation: warm the local draft if cloud is slow. Never commits here
    // directly — the advance loop decides when (and if) a draft is used.
    if (startLocal) {
      entry.speculateTimer = setTimeout(() => {
        entry.speculateTimer = null
        this.startLocalFor(entry)
      }, this.t.speculateAfterMs)
    }
    return promise
  }

  recordingEnded(): void {
    if (this.ended) return
    this.ended = true
    this.offerTimer = setTimeout(() => {
      this.offerTimer = null
      if (!this.offerFired && this.hasPending()) {
        this.offerFired = true
        this.events.onDraftOffer?.()
      }
    }, this.t.offerAfterMs)
    this.deadlineTimer = setTimeout(() => {
      this.deadlineTimer = null
      if (this.hasPending()) this.switchToLocal('deadline')
    }, this.t.hardDeadlineMs)
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
    if (this.hasPending()) this.switchToLocal('accepted')
  }

  dispose(): void {
    if (this.offerTimer) clearTimeout(this.offerTimer)
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer)
    for (const c of this.chunks.values()) {
      if (c.speculateTimer) clearTimeout(c.speculateTimer)
    }
  }

  private hasPending(): boolean {
    for (const c of this.chunks.values()) if (!c.committed) return true
    return false
  }

  private startLocalFor(entry: ChunkEntry): void {
    if (entry.localStarted || entry.committed || !entry.startLocal) return
    entry.localStarted = true
    entry.startLocal().then((text) => {
      entry.localSettled = true
      entry.localText = text
      this.tryAdvance()
    }).catch(() => {
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
    if (entry.committed) return
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
      // Cloud settled with nothing usable — nothing left to wait on except
      // whatever local draft is warming.
      if (!head.startLocal) {
        this.finalize(head, null)
        continue
      }
      this.startLocalFor(head)
      if (!head.localSettled) break
      this.finalize(head, head.localText != null ? { text: head.localText, source: 'local' } : null)
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
    if (!this.ended || this.resolvedNotified) return
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
    if (this.switchIndex !== null) return // one-way: already switched
    const head = this.lowestPending()
    if (!head) return
    this.switchIndex = head.idx
    if (!this.resolvedNotified) {
      this.resolvedNotified = true
      this.events.onDraftResolved?.(how)
    }
    this.clearSessionTimers()
    this.tryAdvance()
  }
}
