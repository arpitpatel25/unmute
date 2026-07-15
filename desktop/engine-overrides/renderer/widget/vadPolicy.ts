// VAD cut policy — the pure decisions behind chunk boundaries.
//
// Field problem (2026-07-14 investigation): the silence threshold was an
// ABSOLUTE rms (0.015) while a real café floor measures 0.012-0.014 — so in
// noise the silence condition never held, every chunk ran to the 45s hard
// cap, and the cap cuts mid-word by design. Two fixes here:
//   * effectiveSilenceThreshold — "silence" is relative to THIS recording's
//     measured noise floor (p20 of the rolling rms window), so café pauses
//     become detectable again.
//   * a soft-cap window — approaching the hard cap, cut at the first
//     relative dip instead of the guillotine, so forced cuts land between
//     words when at all possible.
// Pure module: no DOM, no React — unit-tested by vadPolicy.test.ts.

export type CutDecision = 'none' | 'silence' | 'soft-cap' | 'hard-cap'

export interface CutInput {
  rms: number
  chunkElapsedMs: number
  /** ms of continuous sub-threshold rms so far, or null if currently loud. */
  silenceSinceMs: number | null
  minChunkMs: number
  silenceDurationMs: number
  hardCapMs: number
  softCapWindowMs: number
  threshold: number
}

/** Ceiling: above this, "silence" would overlap real speech rms. */
const THRESHOLD_CAP = 0.045
/** Noise floor multiplier: gaps in speech sit near the floor; speech doesn't. */
const FLOOR_MARGIN = 1.6
/** Soft-cap accepts a dip that isn't full silence — 1.5x the silence bar. */
const SOFT_CAP_DIP = 1.5

export function effectiveSilenceThreshold(configured: number, floorP20: number | null): number {
  if (floorP20 == null) return configured
  return Math.min(Math.max(configured, floorP20 * FLOOR_MARGIN), THRESHOLD_CAP)
}

export function decideCut(input: CutInput): CutDecision {
  if (input.chunkElapsedMs >= input.hardCapMs) return 'hard-cap'
  if (input.chunkElapsedMs < input.minChunkMs) return 'none'
  if (
    input.chunkElapsedMs >= input.hardCapMs - input.softCapWindowMs &&
    input.rms < input.threshold * SOFT_CAP_DIP
  ) {
    return 'soft-cap'
  }
  if (input.rms < input.threshold && input.silenceSinceMs != null && input.silenceSinceMs >= input.silenceDurationMs) {
    return 'silence'
  }
  return 'none'
}
