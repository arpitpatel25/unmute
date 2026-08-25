import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { stitchChannelChunks, cleanChunkText } from './chunkStitcher'

describe('stitchChannelChunks', () => {
  test('joins chunks in chunkIndex order, not array/arrival order', () => {
    const result = stitchChannelChunks([
      { chunkIndex: 1, text: 'world', startTimestampMs: 2000 },
      { chunkIndex: 0, text: 'hello', startTimestampMs: 1000 },
    ])
    assert.equal(result, 'hello world')
  })

  test('strips known Whisper hallucination sentinels', () => {
    const result = stitchChannelChunks([
      { chunkIndex: 0, text: '[BLANK_AUDIO]', startTimestampMs: 0 },
      { chunkIndex: 1, text: 'actual speech', startTimestampMs: 1000 },
    ])
    assert.equal(result, 'actual speech')
  })

  test('empty-text chunks contribute nothing (no extra whitespace)', () => {
    const result = stitchChannelChunks([
      { chunkIndex: 0, text: 'hello', startTimestampMs: 0 },
      { chunkIndex: 1, text: '', startTimestampMs: 1000 },
      { chunkIndex: 2, text: 'world', startTimestampMs: 2000 },
    ])
    assert.equal(result, 'hello world')
  })

  test('empty input list produces an empty string', () => {
    assert.equal(stitchChannelChunks([]), '')
  })

  test('all-empty/all-hallucination input produces an empty string', () => {
    const result = stitchChannelChunks([
      { chunkIndex: 0, text: '[BLANK_AUDIO]', startTimestampMs: 0 },
      { chunkIndex: 1, text: '', startTimestampMs: 1000 },
    ])
    assert.equal(result, '')
  })

  test('strips well-known trailing hallucination phrases on silence', () => {
    const result = stitchChannelChunks([
      { chunkIndex: 0, text: 'Thank you.', startTimestampMs: 0 },
      { chunkIndex: 1, text: 'actual speech', startTimestampMs: 1000 },
    ])
    assert.equal(result, 'actual speech')
  })

  test('strips a wider sentinel than [BLANK_AUDIO]/[MUSIC] alone', () => {
    const result = stitchChannelChunks([
      { chunkIndex: 0, text: '[SILENCE]', startTimestampMs: 0 },
      { chunkIndex: 1, text: 'actual speech', startTimestampMs: 1000 },
    ])
    assert.equal(result, 'actual speech')
  })
})

describe('cleanChunkText', () => {
  test('an entire chunk of pure hallucination cleans to empty', () => {
    assert.equal(cleanChunkText('Thank you.'), '')
    assert.equal(cleanChunkText('Thanks for watching!'), '')
    assert.equal(cleanChunkText('  bye. '), '')
  })

  test('leaves real speech that happens to end similarly alone', () => {
    assert.equal(cleanChunkText('So I just wanted to say thank you for coming'), 'So I just wanted to say thank you for coming')
  })
})
