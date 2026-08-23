/**
 * Root-mean-square of a PCM sample buffer — the same RMS calculation
 * dictation's renderer-side VAD computes from an AnalyserNode, but usable
 * here on plain Float32Array chunks (both channels arrive as raw samples in
 * the Electron main process, not through a Web Audio graph).
 */
export function computeRms(samples: Float32Array): number {
  if (samples.length === 0) return 0
  let sumSquares = 0
  for (let i = 0; i < samples.length; i++) {
    sumSquares += samples[i] * samples[i]
  }
  return Math.sqrt(sumSquares / samples.length)
}
