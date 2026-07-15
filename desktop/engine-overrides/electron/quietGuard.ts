// quietGuard — don't paste Whisper fiction from near-silent captures.
//
// Field case (2026-07-14, 21:41:07): a capture averaging -34dB came back
// from cloud Whisper as "BOT" — four characters of pure hallucination,
// pasted into the user's document. The recorder already measures rmsMax;
// this gate fires ONLY when BOTH signals agree: the capture never got loud
// AND the transcript is suspiciously tiny. Either alone is legitimate
// (soft-spoken long dictation / a loud "Yes."), so either alone passes.
// Pure module: unit-tested by quietGuard.test.ts.

/** Below this rmsMax the recording never contained clearly-audible speech.
 *  RECALIBRATED 2026-07-15 field test: with capture DSP (AGC) off, RAW
 *  normal-volume speech measures rmsMax 0.018-0.044 — the old AGC-era 0.07
 *  bar made EVERY capture read as "faint" and the gate ate every short
 *  dictation ("correction", "yes"). 0.008 sits well below the quietest
 *  normal capture observed while still catching near-silent dead audio. */
const QUIET_RMS_MAX = 0.008
/** A real utterance rarely transcribes to fewer characters than this. */
const TINY_TRANSCRIPT_CHARS = 20

export function isSuspectQuietCapture(rmsMax: number | null, transcript: string): boolean {
  if (!rmsMax || rmsMax <= 0) return false // no quality report — never gate
  if (rmsMax >= QUIET_RMS_MAX) return false
  return transcript.trim().length < TINY_TRANSCRIPT_CHARS
}
