// PeriodicChunkEmitter: per-channel VAD-driven chunk cutting for the meeting
// notetaker. Reuses dictation's real, field-tuned decideCut() /
// effectiveSilenceThreshold() from vadPolicy.ts rather than reimplementing
// chunk-boundary logic — see that file's header for the "why relative
// silence, why soft-cap" history. This module owns only the state machine
// (accumulate samples, track noise floor, decide when to cut and emit).
//
// Cross-tree import note: vadPolicy.ts lives under renderer/widget/, this
// file lives under electron/notetaker/ (main-process tree). That is a
// deliberate, verified choice, not an oversight — see
// .superpowers/sdd/2026-08-24-meeting-notetaker-periodic-flush/task-3-report.md
// for the full reasoning. Short version: electron-vite's `main` build (see
// engine-overrides/electron.vite.config.ts) is a single Rollup `lib` bundle
// from electron/main.ts as entry, with no `root`/resolve boundary that
// isolates it from the renderer directory — Rollup follows STATIC imports
// through the full reachable graph regardless of which subtree a file lives
// in; only externalizeDepsPlugin() carves out npm deps. This branch's one
// prior cross-tree bundling bug (fixed in 51b9b3d/103e467/f9597cf) was a
// runtime require() of a relative path breaking after main.js got bundled
// into one file — that failure mode does not apply to a STATIC import, which
// Rollup resolves and inlines at build time. vadPolicy.ts is also a
// zero-dependency pure module (no DOM, no React — confirmed by reading it),
// so it carries no renderer-only runtime requirements into the main process.
import { decideCut, effectiveSilenceThreshold } from '../../renderer/widget/vadPolicy'
import { computeRms } from './computeRms'
import { NoiseFloorTracker } from './noiseFloorTracker'

export type FinalizedSegment = {
  chunkIndex: number
  samples: Float32Array
  sampleRate: number
  channels: number
  startTimestampMs: number
}

export type PeriodicChunkEmitterConfig = {
  minChunkMs?: number
  hardCapMs?: number
  silenceDurationMs?: number
  softCapWindowMs?: number
  silenceThreshold?: number
  noiseFloorWindowMs?: number
}

const DEFAULTS: Required<PeriodicChunkEmitterConfig> = {
  minChunkMs: 30_000,
  hardCapMs: 45_000,
  silenceDurationMs: 400,
  softCapWindowMs: 5_000,
  silenceThreshold: 0.015,
  noiseFloorWindowMs: 6_000,
}

/**
 * Per-channel periodic chunk cutter — reuses dictation's real, tuned
 * vadPolicy.decideCut() rather than reimplementing chunk-boundary logic.
 * One instance per channel (mic, system); channels are independent chunk
 * sequences, never synchronized.
 */
export class PeriodicChunkEmitter {
  private readonly onSegment: (segment: FinalizedSegment) => void
  private readonly config: Required<PeriodicChunkEmitterConfig>
  private readonly now: () => number
  private readonly noiseFloor: NoiseFloorTracker

  private parts: Float32Array[] = []
  private sampleRate = 0
  private channels = 0
  private segmentStartMs = 0
  private silenceStartMs: number | null = null
  private chunkIndex = 0

  constructor(
    onSegment: (segment: FinalizedSegment) => void,
    config: PeriodicChunkEmitterConfig = {},
    now: () => number = Date.now
  ) {
    this.onSegment = onSegment
    this.config = { ...DEFAULTS, ...config }
    this.now = now
    this.noiseFloor = new NoiseFloorTracker(this.config.noiseFloorWindowMs)
  }

  feed(samples: Float32Array, sampleRate: number, channels: number, timestampMs: number): void {
    const rms = computeRms(samples)
    this.noiseFloor.feed(rms, timestampMs)
    const threshold = effectiveSilenceThreshold(this.config.silenceThreshold, this.noiseFloor.floor)

    if (this.parts.length === 0) {
      // First sample of a brand new segment: nothing to compare against yet
      // (chunkElapsedMs is 0, so decideCut could never fire), so just seed
      // state and accumulate.
      this.segmentStartMs = timestampMs
      this.sampleRate = sampleRate
      this.channels = channels
      this.silenceStartMs = rms < threshold ? timestampMs : null
      this.parts.push(samples)
      return
    }

    if (rms < threshold) {
      if (this.silenceStartMs === null) this.silenceStartMs = timestampMs
    } else {
      this.silenceStartMs = null
    }

    const chunkElapsedMs = timestampMs - this.segmentStartMs
    const decision = decideCut({
      rms,
      chunkElapsedMs,
      silenceSinceMs: this.silenceStartMs === null ? null : timestampMs - this.silenceStartMs,
      minChunkMs: this.config.minChunkMs,
      silenceDurationMs: this.config.silenceDurationMs,
      hardCapMs: this.config.hardCapMs,
      softCapWindowMs: this.config.softCapWindowMs,
      threshold,
    })

    if (decision !== 'none') {
      // The boundary lands BEFORE this call's samples: finalize everything
      // accumulated so far (not including this call), then this call's
      // samples become the first chunk of the next segment. Carry the
      // silence state forward rather than resetting it, so a streak that's
      // already under way (e.g. the sample that tipped a 'silence' decision)
      // keeps counting in the new segment instead of restarting from null.
      this.finalizeSegment()
      this.segmentStartMs = timestampMs
      this.sampleRate = sampleRate
      this.channels = channels
      this.silenceStartMs = rms < threshold ? timestampMs : null
      this.parts.push(samples)
    } else {
      this.parts.push(samples)
    }
  }

  /** Force-finalizes whatever's accumulated — called at session stop for the trailing partial segment. */
  flush(): void {
    if (this.parts.length > 0) {
      this.finalizeSegment()
    }
  }

  private finalizeSegment(): void {
    const totalLength = this.parts.reduce((sum, p) => sum + p.length, 0)
    const merged = new Float32Array(totalLength)
    let offset = 0
    for (const part of this.parts) {
      merged.set(part, offset)
      offset += part.length
    }

    this.onSegment({
      chunkIndex: this.chunkIndex,
      samples: merged,
      sampleRate: this.sampleRate,
      channels: this.channels,
      startTimestampMs: this.segmentStartMs,
    })

    this.chunkIndex++
    this.parts = []
    this.silenceStartMs = null
  }
}
