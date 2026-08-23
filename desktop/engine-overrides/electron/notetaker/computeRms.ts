/**
 * Standard RMS (root-mean-square) amplitude, for raw Float32 PCM samples
 * already in [-1, 1] range (as delivered by both the native Core Audio tap
 * and the renderer's getUserMedia mic tap) — no byte-to-float normalization
 * needed here, unlike dictation's AnalyserNode-byte-data version.
 */
export function computeRms(samples: Float32Array): number {
  if (samples.length === 0) return 0
  let sumSquares = 0
  for (let i = 0; i < samples.length; i++) {
    sumSquares += samples[i] * samples[i]
  }
  return Math.sqrt(sumSquares / samples.length)
}
