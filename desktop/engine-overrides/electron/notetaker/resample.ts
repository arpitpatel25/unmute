// Meeting Notetaker — pre-encode audio reduction.
//
// WHY THIS EXISTS: the pipeline worker's MAX_AUDIO_BYTES is 50MB
// (backend/cloudflare/pipeline/src/index.ts) — a limit sized for COMPRESSED
// opus, not for the raw PCM this feature is the first caller ever to send.
// The system tap hands us 48kHz STEREO float samples; encodeWav() writes
// 16-bit PCM, so a meeting costs 48000 * 2ch * 2B = 192,000 bytes/second and
// blows the cap at ~4 minutes 33 seconds. Past that the upload 413s, and in
// 'auto' engine mode that failure is SILENT (tryManagedSTT returns null).
//
// Downmixing to mono and decimating to 16kHz costs 6x fewer bytes
// (192kB/s -> 32kB/s), pushing the safe window to roughly 27 minutes. 16kHz
// mono is also exactly what Whisper-class models resample to internally, so
// nothing useful is thrown away — the only real loss is above 8kHz, which
// carries no speech intelligibility.
//
// This does NOT make arbitrarily long meetings safe; segmenting a long
// meeting into several STT calls is a larger change, deliberately out of
// scope here.

/** What managed STT (Whisper-class) wants anyway. */
export const TARGET_SAMPLE_RATE = 16000

export type MonoAudio = {
  samples: Float32Array
  sampleRate: number
}

/**
 * Downmix interleaved `channels`-channel audio to mono (plain average of the
 * channels in each frame) and decimate it to `targetRate` with a box filter:
 * every output sample is the MEAN of the input samples that fall inside its
 * time slot, which is a cheap FIR low-pass — enough anti-aliasing that
 * decimating 48k -> 16k doesn't fold high-frequency content back down into
 * the speech band. (For the exact 3:1 ratio the system tap actually produces,
 * each output sample is simply the average of 3 consecutive input frames.)
 *
 * Never upsamples: if the input is already at or below `targetRate` the
 * (possibly downmixed) samples are returned at their original rate, since
 * inventing samples would only make the file bigger for no accuracy gain.
 *
 * Pure: no I/O, no globals, input is never mutated.
 */
export function downmixAndResample(
  samples: Float32Array,
  channels: number,
  sampleRate: number,
  targetRate: number = TARGET_SAMPLE_RATE,
): MonoAudio {
  const chCount = channels > 1 ? Math.floor(channels) : 1
  const frameCount = Math.floor(samples.length / chCount)

  if (frameCount === 0) return { samples: new Float32Array(0), sampleRate: sampleRate > 0 ? sampleRate : targetRate }

  // ── 1. Downmix to mono ──
  let mono: Float32Array
  if (chCount === 1) {
    // Already mono. Slice (not alias) so callers can never observe a view
    // into a buffer someone else still holds.
    mono = samples.length === frameCount ? samples.slice() : samples.slice(0, frameCount)
  } else {
    mono = new Float32Array(frameCount)
    for (let frame = 0; frame < frameCount; frame++) {
      let sum = 0
      const base = frame * chCount
      for (let c = 0; c < chCount; c++) sum += samples[base + c]
      mono[frame] = sum / chCount
    }
  }

  // ── 2. Decimate to targetRate ──
  if (!(sampleRate > 0) || !(targetRate > 0) || sampleRate <= targetRate) {
    return { samples: mono, sampleRate: sampleRate > 0 ? sampleRate : targetRate }
  }

  const ratio = sampleRate / targetRate
  const outLength = Math.floor(frameCount / ratio)
  if (outLength === 0) return { samples: new Float32Array(0), sampleRate: targetRate }

  const out = new Float32Array(outLength)
  for (let i = 0; i < outLength; i++) {
    const start = Math.floor(i * ratio)
    const end = Math.min(frameCount, Math.floor((i + 1) * ratio))
    // `end > start` always holds here because ratio > 1, but be explicit
    // rather than risk a divide-by-zero if that ever stops being true.
    const span = end > start ? end - start : 1
    let sum = 0
    for (let j = start; j < start + span && j < frameCount; j++) sum += mono[j]
    out[i] = sum / span
  }

  return { samples: out, sampleRate: targetRate }
}
