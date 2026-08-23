import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { mergeTranscripts, generateTitle } from './transcriptMerge'

describe('mergeTranscripts', () => {
  test('mic-only transcript produces one mic segment', () => {
    const segments = mergeTranscripts('hello there', 1000, 2000, '', 0, 0)
    assert.deepEqual(segments, [{ channel: 'mic', text: 'hello there', startMs: 1000, endMs: 3000 }])
  })

  test('system-only transcript produces one system segment', () => {
    const segments = mergeTranscripts('', 0, 0, 'how are you', 500, 1500)
    assert.deepEqual(segments, [{ channel: 'system', text: 'how are you', startMs: 500, endMs: 2000 }])
  })

  test('both channels present, mic starts first, ordered by startMs', () => {
    const segments = mergeTranscripts('hello', 1000, 1000, 'hi back', 3000, 1000)
    assert.equal(segments.length, 2)
    assert.equal(segments[0].channel, 'mic')
    assert.equal(segments[0].startMs, 1000)
    assert.equal(segments[1].channel, 'system')
    assert.equal(segments[1].startMs, 3000)
  })

  test('system starts before mic, ordered accordingly', () => {
    const segments = mergeTranscripts('hello', 5000, 1000, 'hi', 1000, 1000)
    assert.equal(segments[0].channel, 'system')
    assert.equal(segments[1].channel, 'mic')
  })

  test('empty text on both channels produces no segments', () => {
    assert.deepEqual(mergeTranscripts('', 0, 0, '', 0, 0), [])
  })

  test('whitespace-only text is treated as empty', () => {
    assert.deepEqual(mergeTranscripts('   ', 0, 0, '', 0, 0), [])
  })
})

describe('generateTitle', () => {
  test('uses the first substantive segment, truncated to a short phrase', () => {
    const title = generateTitle([{ channel: 'mic', text: 'so I wanted to talk about the roadmap for next quarter', startMs: 0, endMs: 5000 }])
    assert.ok(title.length <= 60)
    assert.ok(title.startsWith('so I wanted to talk'))
  })

  test('no segments falls back to a date-based title', () => {
    const title = generateTitle([])
    assert.match(title, /Meeting/)
  })

  test('very short first segment is used as-is without truncation artifacts', () => {
    const title = generateTitle([{ channel: 'mic', text: 'hi', startMs: 0, endMs: 500 }])
    assert.equal(title, 'hi')
  })
})
