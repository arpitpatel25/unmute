const DEFAULT_WINDOW_MS = 6000
const FLOOR_PERCENTILE = 0.2

/**
 * Time-windowed rolling p20 RMS — the noise-floor input to vadPolicy.ts's
 * effectiveSilenceThreshold(). Ports dictation's 60-tick/~100ms rolling
 * window (useAudioRecorder.ts) to a time-based window, since notetaker
 * chunks don't arrive on a fixed timer.
 */
export class NoiseFloorTracker {
  private readonly windowMs: number
  private readonly samples: { rms: number; timestampMs: number }[] = []

  constructor(windowMs: number = DEFAULT_WINDOW_MS) {
    this.windowMs = windowMs
  }

  feed(rms: number, timestampMs: number): void {
    this.samples.push({ rms, timestampMs })
    const cutoff = timestampMs - this.windowMs
    while (this.samples.length > 0 && this.samples[0].timestampMs < cutoff) {
      this.samples.shift()
    }
  }

  get floor(): number | null {
    if (this.samples.length === 0) return null
    const sorted = this.samples.map((s) => s.rms).sort((a, b) => a - b)
    return sorted[Math.floor(sorted.length * FLOOR_PERCENTILE)]
  }
}
