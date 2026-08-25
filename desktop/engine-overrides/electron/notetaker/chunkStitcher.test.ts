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

  test('a chunk that loops the same hallucination collapses to empty, not just its last occurrence', () => {
    assert.equal(cleanChunkText('Thank you. Thank you. Thank you.'), '')
    assert.equal(cleanChunkText('Thank you.  Thank you.   Thank you.  Thank you.'), '')
  })

  test('a looped hallucination followed by real speech keeps only the real speech', () => {
    assert.equal(cleanChunkText('Thank you. Thank you. Actually let\'s move to the next slide.'), 'Actually let\'s move to the next slide.')
  })

  test('real speech followed by a looped hallucination keeps only the real speech', () => {
    assert.equal(cleanChunkText('Let\'s move to the next slide. Thank you. Thank you.'), 'Let\'s move to the next slide.')
  })

  test('broadened phrase list covers other well-known Whisper silence hallucinations', () => {
    assert.equal(cleanChunkText('Please subscribe to my channel.'), '')
    assert.equal(cleanChunkText("Don't forget to like and subscribe!"), '')
    assert.equal(cleanChunkText('Bye bye.'), '')
    assert.equal(cleanChunkText('Goodbye!'), '')
    assert.equal(cleanChunkText("See you in the next video."), '')
    assert.equal(cleanChunkText('Thanks for listening.'), '')
    assert.equal(cleanChunkText('Subtitles by the Amara.org community'), '')
  })

  test('still leaves an unrelated filler word (not a known hallucination phrase) alone', () => {
    assert.equal(cleanChunkText('Hmm. Hmm. Hmm.'), 'Hmm. Hmm. Hmm.')
  })
})
