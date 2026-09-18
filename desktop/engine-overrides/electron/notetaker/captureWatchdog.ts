/**
 * Bounds on a running capture.
 *
 * Nothing but a person ever ended a note-taking session: the double-tap, the
 * widget's End/Discard, app quit, or MeetingWatcher's own end-detection —
 * which can only fire for a meeting it detected the START of, so a capture
 * begun by the chord (or hosted in Chrome, which detection deliberately does
 * not watch) had no automatic end at all. On 2026-09-09 that left an
 * interview recording for 9h08m: real speech stopped after ~4h, and the rest
 * is silence plus one hallucinated segment. The 286-segment transcript then
 * blew the note-cleanup timeout, so the meeting also "ended with the
 * note-taking failing".
 *
 * These limits read the WALL clock on purpose. "This capture has heard
 * nothing for 15 minutes" is a wall-clock statement, and the wall clock is
 * the only one that keeps counting while the Mac sleeps — so a capture left
 * running overnight is stopped on wake instead of recording the night.
 * Stopping SAVES the meeting (see NotetakerSession.stop()), so the worst case
 * of a limit firing early is a saved meeting and a new capture, never a lost
 * one.
 */

/** No audible speech in either lane for this long ends the capture. Longer
 *  than any natural pause in a call, short enough that a forgotten capture
 *  costs minutes of silence rather than hours. */
export const SILENCE_STOP_MS = 15 * 60_000

/** Absolute ceiling, so a capture fed continuous audio (music, a left-open
 *  stream) still cannot run all day. */
export const MAX_CAPTURE_MS = 4 * 60 * 60_000

export type CaptureStopReason = 'silence' | 'max-duration'

export function captureStopReason(input: {
  nowMs: number
  startedAtMs: number
  lastAudibleAtMs: number
  silenceLimitMs?: number
  maxDurationMs?: number
}): CaptureStopReason | null {
  const { nowMs, startedAtMs, lastAudibleAtMs } = input
  const silenceLimitMs = input.silenceLimitMs ?? SILENCE_STOP_MS
  const maxDurationMs = input.maxDurationMs ?? MAX_CAPTURE_MS
  // A backwards jump (NTP correction, a manual clock change) reads as a
  // capture that started or spoke in the future. Never end a live meeting on
  // arithmetic that cannot be trusted; the next tick re-decides.
  if (nowMs < startedAtMs || nowMs < lastAudibleAtMs) return null
  if (nowMs - lastAudibleAtMs >= silenceLimitMs) return 'silence'
  if (nowMs - startedAtMs >= maxDurationMs) return 'max-duration'
  return null
}
