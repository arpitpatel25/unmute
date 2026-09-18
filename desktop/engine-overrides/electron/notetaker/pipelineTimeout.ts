/**
 * How long a note-pipeline stage (cleanup, summary) may take.
 *
 * The budget was a flat 300s for any transcript. A 9h capture on 2026-09-09
 * produced 286 segments; its cleanup was killed at exactly that limit, and
 * the meeting's notes were written from the uncleaned transcript instead.
 * The work scales with the transcript, so the budget has to as well — with a
 * ceiling, since an unbounded wait is its own failure.
 */

/** Floor, and the budget every short transcript already had. */
export const DEFAULT_TIMEOUT_MS = 300_000

/** Ceiling for any one stage. */
export const MAX_TIMEOUT_MS = 900_000

/** Budget per segment. The 2026-09-09 cleanup was still running at 300s for
 *  286 segments; the summary stage that did finish took 38s for the same
 *  transcript. 2s a segment keeps short meetings on the floor below and
 *  gives a long one room the flat limit never gave it. */
const MS_PER_SEGMENT = 2_000

export function timeoutMsForSegments(segmentCount: number): number {
  if (!Number.isFinite(segmentCount) || segmentCount <= 0) return DEFAULT_TIMEOUT_MS
  return Math.min(MAX_TIMEOUT_MS, Math.max(DEFAULT_TIMEOUT_MS, Math.round(segmentCount) * MS_PER_SEGMENT))
}
