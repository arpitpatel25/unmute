// quietGuard — don't paste Whisper fiction from near-silent captures.
//
// Field case (2026-07-14, 21:41:07): a capture averaging -34dB came back
// from cloud Whisper as "BOT" — four characters of pure hallucination,
// pasted into the user's document. The recorder already measures rmsMax;
// this gate fires ONLY when BOTH signals agree: the capture never got loud
// AND the transcript is suspiciously tiny. Either alone is legitimate
// (soft-spoken long dictation / a loud "Yes."), so either alone passes.
// Pure module: unit-tested by quietGuard.test.ts.
//
// 2026-09-15 — "never got loud" is now judged AGAINST THE RECORDING'S OWN ROOM.
// The bar used to be a fixed 0.008. A whisper into a close wired mic peaks
// around 0.006, so once the recorder stopped discarding those captures
// (speechGate.ts) this guard would have caught every one of them at the paste
// stage instead — the same bug, one layer down. A capture is suspect when it
// barely rose above its own noise floor, which silence does and a whisper in a
// quiet room does not.
//
// Cross-tree import note: speechGate.ts lives under renderer/widget/ and this
// file under electron/, same as periodicChunkEmitter.ts → vadPolicy.ts. Both
// are pure TS with no DOM or Electron surface; Rollup resolves and inlines
// them at build time. Sharing the constant beats letting two copies drift.
import { MIN_SPEECH_RMS } from '../renderer/widget/speechGate'

/** How far above its own noise floor a capture must have risen for us to
 *  believe there was a voice in it. Deliberately wider than the recorder's
 *  own speech bar (4x): by the time we are here the audio has already been
 *  transcribed, so this only has to catch what slipped through. */
const QUIET_FLOOR_MARGIN = 6
/** A real utterance rarely transcribes to fewer characters than this. */
const TINY_TRANSCRIPT_CHARS = 20

/** `rmsMax` and `noiseFloor` are float-meter rms as reported by the recorder's
 *  capture-quality message. `noiseFloor` is null for recordings too short to
 *  measure one, where the absolute minimum speech level stands in. */
export function isSuspectQuietCapture(
  rmsMax: number | null,
  transcript: string,
  noiseFloor?: number | null,
): boolean {
  if (!rmsMax || rmsMax <= 0) return false // no quality report — never gate
  const bar = noiseFloor && noiseFloor > 0
    ? Math.max(noiseFloor * QUIET_FLOOR_MARGIN, MIN_SPEECH_RMS)
    : MIN_SPEECH_RMS
  if (rmsMax >= bar) return false
  return transcript.trim().length < TINY_TRANSCRIPT_CHARS
}
