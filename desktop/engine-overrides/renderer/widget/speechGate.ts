// speechGate — "did the user actually say anything?" as a pure decision.
//
// Field problem (2026-09-15 investigation): a close WIRED mic was unusable for
// quiet speech. Speak up and it worked; whisper and the dictation vanished with
// "nothing captured" — the recording was discarded before STT, so Whisper never
// saw it. The built-in MacBook mic hid the bug for a year: it is hot enough
// that its QUIETEST capture in 946 logged recordings still peaked at 0.03.
//
// The old test was one line — `rms >= 0.015` — and it was wrong twice over:
//
//   * THE BAR WAS ABSOLUTE. 0.015 rms is about -36.5 dBFS. It was chosen while
//     Chromium's auto-gain was boosting the mic; d3e4a9e5 (2026-07-15) turned
//     AGC and noise suppression off (RAW_CAPTURE) and every level dropped, but
//     this bar never moved. A whisper into an unamplified wired mic lands
//     around -44 dBFS — inaudible to the gate, obvious to a human and to
//     Whisper. An absolute bar cannot tell "said nothing" from "said it
//     quietly"; only the room can, which is what this module uses.
//
//   * THE METER COULD NOT SEE IT ANYWAY. The level came from the 8-bit
//     getByteTimeDomainData array, where one code step is 1/128 and truncation
//     biases each sample by half a step. Everything quiet collapses into a
//     narrow band around 0.004-0.008 regardless of how quiet it really is, so
//     a whisper and a silent room read the SAME. The caller now meters from
//     getFloatTimeDomainData (it was already reading that buffer in the same
//     tick for telemetry), which is why this module is written in float rms
//     and why the old byte-calibrated constants need conversion (below).
//
// The rule here: speech is a RISE ABOVE THIS RECORDING'S OWN NOISE FLOOR. The
// floor is already measured (p20 of the rolling rms window, the same number
// vadPolicy cuts chunks against), so the gate calibrates itself to whatever mic
// is plugged in — no device list, no per-mic table.
//
// Pure module: no DOM, no React — unit-tested by speechGate.test.ts.

/** Rms that the 8-bit meter ADDS to every reading of its own: quantization
 *  noise (step/sqrt(12)) plus the half-step truncation bias, combined. It is
 *  why that meter bottoms out near 0.0045 on true silence.
 *  byteRms ≈ sqrt(floatRms² + BYTE_METER_NOISE_RMS²). */
export const BYTE_METER_NOISE_RMS = 0.0045

/** Carry a constant that was calibrated against the old 8-bit meter over to the
 *  float meter with its MEANING intact. Without this every inherited threshold
 *  (noisy-room floor, too-quiet hint, silence cuts) would quietly tighten when
 *  the meter changed, and we would be debugging a second mystery. */
export function floatEquivalentOfByteRms(byteRms: number): number {
  const sq = byteRms * byteRms - BYTE_METER_NOISE_RMS * BYTE_METER_NOISE_RMS
  return sq <= 0 ? 0 : Math.sqrt(sq)
}

/** Speech must clear the recording's own floor by this much (4x ≈ 12 dB).
 *  Room tone wanders within a few dB of its floor; an utterance does not. */
export const FLOOR_MARGIN = 4

/** The gate is never STRICTER than it was before this fix — the float
 *  equivalent of the old 0.015 byte bar. In a genuinely loud room, floor*4
 *  would demand shouting, so the bar stops climbing here and the noisy-room
 *  machinery (correction pass) takes over from there. */
export const MAX_SPEECH_RMS = 0.0143

/** …and never LOOSER than this (-48 dBFS). Below it we are in the territory of
 *  mic self-noise and room tone, where "speech" would mean sending silence to
 *  Whisper and pasting whatever it invents. A whisper at 30cm sits comfortably
 *  above this; an empty room does not. */
export const MIN_SPEECH_RMS = 0.004

/** The level a capture must reach, this recording, to count as speech.
 *  `floorRms` is the p20 of the rolling rms window, or null before enough
 *  frames exist to measure one (recordings under ~2s). */
export function speechThreshold(floorRms: number | null): number {
  if (floorRms == null) return MIN_SPEECH_RMS
  return Math.min(Math.max(floorRms * FLOOR_MARGIN, MIN_SPEECH_RMS), MAX_SPEECH_RMS)
}

/** True once the recording has risen far enough above its own noise floor to
 *  be worth transcribing. The caller latches this for the whole recording. */
export function heardSpeech(rms: number, floorRms: number | null): boolean {
  return rms >= speechThreshold(floorRms)
}
