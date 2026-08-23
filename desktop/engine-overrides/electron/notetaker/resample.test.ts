import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { downmixAndResample, TARGET_SAMPLE_RATE } from './resample'

/** Float32Array round-trips lose precision against JS doubles, so compare
 *  with a tolerance rather than assert.deepEqual (the same lesson the
 *  chunkBuffer tests already learned). */
function assertClose(actual: Float32Array, expected: number[], eps = 1e-6): void {
  assert.equal(actual.length, expected.length, `length ${actual.length} !== ${expected.length}`)
  for (let i = 0; i < expected.length; i++) {
    assert.ok(Math.abs(actual[i] - expected[i]) < eps, `index ${i}: ${actual[i]} !== ${expected[i]}`)
  }
}

describe('downmixAndResample', () => {
  test('mono 48kHz decimates 3:1 to 16kHz and keeps the target rate', () => {
    const input = new Float32Array(48000) // exactly 1 second
    const out = downmixAndResample(input, 1, 48000)
    assert.equal(out.sampleRate, TARGET_SAMPLE_RATE)
    assert.equal(out.samples.length, 16000)
  })

  test('stereo 48kHz halves the sample count (downmix) then decimates 3:1', () => {
    // 2 channels interleaved, 48000 FRAMES => 96000 samples => 16000 out.
    const input = new Float32Array(96000)
    const out = downmixAndResample(input, 2, 48000)
    assert.equal(out.sampleRate, TARGET_SAMPLE_RATE)
    assert.equal(out.samples.length, 16000)
  })

  test('a known waveform: each output sample is the mean of 3 input samples', () => {
    // 9 mono samples at 48k -> 3 samples at 16k.
    const input = new Float32Array([0, 3, 6, 1, 1, 1, -1, 0, 1])
    const out = downmixAndResample(input, 1, 48000)
    assert.equal(out.sampleRate, 16000)
    assertClose(out.samples, [3, 1, 0]) // (0+3+6)/3, (1+1+1)/3, (-1+0+1)/3
  })

  test('stereo averages BOTH channels per frame before decimating', () => {
    // 9 frames, interleaved L,R. L is the waveform above; R is L+2, so the
    // per-frame average is L+1 and the decimated output is the mono case +1.
    const l = [0, 3, 6, 1, 1, 1, -1, 0, 1]
    const interleaved: number[] = []
    for (const v of l) interleaved.push(v, v + 2)
    const out = downmixAndResample(new Float32Array(interleaved), 2, 48000)
    assertClose(out.samples, [4, 2, 1])
  })

  test('never upsamples: 16kHz input is returned untouched at 16kHz', () => {
    const input = new Float32Array([0.25, -0.25, 0.5])
    const out = downmixAndResample(input, 1, 16000)
    assert.equal(out.sampleRate, 16000)
    assertClose(out.samples, [0.25, -0.25, 0.5])
  })

  test('an 8kHz input is downmixed but not resampled', () => {
    const out = downmixAndResample(new Float32Array([1, 3, 5, 7]), 2, 8000)
    assert.equal(out.sampleRate, 8000)
    assertClose(out.samples, [2, 6]) // (1+3)/2, (5+7)/2
  })

  test('non-integer ratios (44.1k -> 16k) still produce the expected length', () => {
    const out = downmixAndResample(new Float32Array(44100), 1, 44100)
    assert.equal(out.sampleRate, TARGET_SAMPLE_RATE)
    assert.equal(out.samples.length, Math.floor(44100 / (44100 / 16000)))
    assert.equal(out.samples.length, 16000)
  })

  test('empty input yields empty output rather than throwing', () => {
    const out = downmixAndResample(new Float32Array(0), 2, 48000)
    assert.equal(out.samples.length, 0)
  })

  test('input shorter than one output slot yields an empty result, not NaN', () => {
    const out = downmixAndResample(new Float32Array([1, 2]), 1, 48000)
    assert.equal(out.samples.length, 0)
  })

  test('does not mutate or alias the caller\'s buffer', () => {
    const input = new Float32Array([0.5, 0.5, 0.5])
    const out = downmixAndResample(input, 1, 16000)
    out.samples[0] = 99
    assert.equal(input[0], 0.5)
  })

  test('reduces a 48kHz stereo second from 192kB of PCM to 32kB', () => {
    const oneSecondStereo48k = new Float32Array(48000 * 2)
    const out = downmixAndResample(oneSecondStereo48k, 2, 48000)
    // 16-bit PCM => 2 bytes per sample.
    assert.equal(oneSecondStereo48k.length * 2, 192000)
    assert.equal(out.samples.length * 2, 32000)
  })
})
