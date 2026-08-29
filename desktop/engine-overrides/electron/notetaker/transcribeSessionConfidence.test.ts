import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { isReliableWhisperSegment } from './whisperConfidence'

const base = { start: 0, end: 1, text: 'hello' }

describe('isReliableWhisperSegment', () => {
  test('keeps multilingual or accented speech when Whisper considers it speech', () => {
    assert.equal(isReliableWhisperSegment({ ...base, no_speech_prob: 0.08, avg_logprob: -1.2 }), true)
  })

  test('rejects overwhelmingly non-speech output even when decoder text looks confident', () => {
    assert.equal(isReliableWhisperSegment({ ...base, no_speech_prob: 0.9, avg_logprob: -0.2 }), false)
  })

  test('rejects the combination of probable silence and weak decoding', () => {
    assert.equal(isReliableWhisperSegment({ ...base, no_speech_prob: 0.7, avg_logprob: -0.8 }), false)
  })

  test('keeps backward-compatible segments from an older worker without confidence fields', () => {
    assert.equal(isReliableWhisperSegment(base), true)
  })
})
