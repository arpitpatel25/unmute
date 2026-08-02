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

// TRIED AND REMOVED: an insert-triggered cut. A clipboard event used to PERMIT
// an early boundary ('insert', gated on sustained silence past a ~9s floor) so
// a copy could be placed precisely inside the transcript. It bought nothing and
// was not free.
//
// Nothing: a chunk boundary is not a segment boundary. beginSegment opens
// exactly ONE segment per capture and the transcript attaches to it in one go,
// so where the audio was cut never reached the buffer at all — no arrangement
// of chunk boundaries could move an insert by a single character.
//
// Not free: it moves a real STT boundary, and the 2026-07-14 investigation
// established that cutting badly is the primary source of garbled transcripts.
// Order already carries almost all the value of interleaving (spec §2.1), so
// exactness was never worth paying accuracy for even when it worked.
//
// Do not add it back. The field bug it was meant to fix (2026-08-02: a link
// copied mid-sentence pasted at the END of the dictation) IS FIXED, and not
// here — the seam is made in the finished transcript by capture/speechSplit.ts,
// which costs the audio path nothing and works for every copy in every
// dictation.
//
// AND IT WAS UNREACHABLE BESIDES, which the original removal did not notice.
// decideCut is not even called until `vadActivatedRef` is set
// (useAudioRecorder.ts:511), and that is set by a timer at `chunkMinMs` —
// 30_000ms by default (useAudioRecorder.ts:27, 1026-1033). The insert branch
// only fired BELOW minChunkMs. The two conditions could never both hold, so
// the branch was dead on top of achieving nothing. Reaching it would mean
// activating the VAD early, i.e. moving a real STT boundary on the dictation
// fast path — the exact cost the 2026-07-14 investigation says not to pay.

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
