import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { mergeTranscripts, generateTitle, mergeChannelChunks, mergeAdjacentSpeakerTurns, attributeSpeakers, type SpeakerSample } from './transcriptMerge'

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

describe('mergeChannelChunks', () => {
  test('interleaves mic and system chunks by startMs, not by channel', () => {
    const segments = mergeChannelChunks(
      [{ channel: 'mic', text: 'hi there', startMs: 0, endMs: 3000 }],
      [{ channel: 'system', text: 'hey', startMs: 4000, endMs: 6000 }]
    )
    assert.equal(segments.length, 2)
    assert.equal(segments[0].channel, 'mic')
    assert.equal(segments[1].channel, 'system')
  })

  test('multiple chunks per channel all appear as separate ordered segments', () => {
    const segments = mergeChannelChunks(
      [
        { channel: 'mic', text: 'first', startMs: 0, endMs: 1000 },
        { channel: 'mic', text: 'second', startMs: 5000, endMs: 6000 },
      ],
      [{ channel: 'system', text: 'reply', startMs: 2000, endMs: 3000 }]
    )
    assert.equal(segments.length, 3)
    assert.deepEqual(segments.map((s) => s.text), ['first', 'reply', 'second'])
  })

  test('empty-text chunks are dropped', () => {
    const segments = mergeChannelChunks(
      [{ channel: 'mic', text: '', startMs: 0, endMs: 1000 }],
      [{ channel: 'system', text: 'real text', startMs: 2000, endMs: 3000 }]
    )
    assert.equal(segments.length, 1)
    assert.equal(segments[0].channel, 'system')
  })

  test('both channels empty produces no segments', () => {
    assert.deepEqual(mergeChannelChunks([], []), [])
  })

  test('preserves the channel label on each segment (does not merge adjacent-time segments across channels)', () => {
    const segments = mergeChannelChunks(
      [{ channel: 'mic', text: 'a', startMs: 0, endMs: 1000 }],
      [{ channel: 'system', text: 'b', startMs: 1000, endMs: 2000 }]
    )
    assert.equal(segments.length, 2)
    assert.notEqual(segments[0].channel, segments[1].channel)
  })

  test('uses deterministic chronological tie-breakers instead of promise or array order', () => {
    const segments = mergeChannelChunks(
      [{ channel: 'mic', text: 'you spoke first', startMs: 1000, endMs: 1800 }],
      [{ channel: 'system', text: 'later ending overlap', startMs: 1000, endMs: 2200 }]
    )
    assert.deepEqual(segments.map((segment) => segment.text), ['you spoke first', 'later ending overlap'])
  })

  test('prefers the direct system lane over a long overlapping microphone echo', () => {
    const segments = mergeChannelChunks(
      [{
        channel: 'mic',
        text: "It was like two years ago I was there and you were here and now I'm here and you are",
        startMs: 11367,
        endMs: 20327,
      }],
      [{
        channel: 'system',
        text: "So good. It was like two years ago I was there. And you were here. And now I'm here. And you are still here.",
        startMs: 11385,
        endMs: 20825,
      }]
    )
    assert.deepEqual(segments.map((segment) => segment.channel), ['system'])
  })

  test('removes a short microphone tail duplicated in an overlapping system utterance', () => {
    const segments = mergeChannelChunks(
      [{ channel: 'mic', text: "I'm still here.", startMs: 20241, endMs: 25105 }],
      [{ channel: 'system', text: "And now I'm here. And you are still here.", startMs: 11385, endMs: 20825 }]
    )
    assert.deepEqual(segments.map((segment) => segment.channel), ['system'])
  })

  test('keeps repeated text when it is outside the echo timing window', () => {
    const segments = mergeChannelChunks(
      [{ channel: 'mic', text: 'the project is still here', startMs: 10000, endMs: 12000 }],
      [{ channel: 'system', text: 'the project is still here', startMs: 0, endMs: 2000 }]
    )
    assert.equal(segments.length, 2)
  })

  test('keeps genuinely different simultaneous speech', () => {
    const segments = mergeChannelChunks(
      [{ channel: 'mic', text: 'we should ship the project on Tuesday', startMs: 1000, endMs: 3000 }],
      [{ channel: 'system', text: 'we should review the proposal on Friday', startMs: 900, endMs: 4200 }]
    )
    assert.equal(segments.length, 2)
  })

  test('uses matching acoustic boundaries when STT renders the two echo copies differently', () => {
    const segments = mergeChannelChunks(
      [{ channel: 'mic', text: 'Then he sat down and I saw the camera. He was sitting on the top.', startMs: 7554, endMs: 15234 }],
      [{ channel: 'system', text: 'Then I sat down and sat down and sat down. There was a bus in the sun.', startMs: 7510, endMs: 15105 }]
    )
    assert.deepEqual(segments.map((segment) => segment.channel), ['system'])
  })

  test('does not delete an unrelated mic transcript just because full-channel retry files share boundaries', () => {
    const segments = mergeChannelChunks(
      [{
        channel: 'mic',
        text: 'He is giving lessons around forests, jungles, tigers, and British rule in India.',
        startMs: 1000,
        endMs: 31000,
      }],
      [{ channel: 'system', text: 'foreign Thank you.', startMs: 1000, endMs: 31000 }]
    )

    assert.deepEqual(segments.map((segment) => segment.channel), ['mic', 'system'])
  })

  test('keeps ambiguous one-word overlap instead of deleting a real acknowledgement', () => {
    const segments = mergeChannelChunks(
      [{ channel: 'mic', text: 'yes', startMs: 1000, endMs: 1300 }],
      [{ channel: 'system', text: 'yes that is correct', startMs: 900, endMs: 2000 }]
    )
    assert.equal(segments.length, 2)
  })
})

describe('mergeAdjacentSpeakerTurns', () => {
  test('joins consecutive STT chunks from the same speaker into one readable turn', () => {
    const turns = mergeAdjacentSpeakerTurns([
      { channel: 'mic', text: 'This thought started here.', startMs: 0, endMs: 2000 },
      { channel: 'mic', text: 'And continued after the chunk flush.', startMs: 2500, endMs: 5000 },
    ])

    assert.deepEqual(turns, [{
      channel: 'mic',
      text: 'This thought started here. And continued after the chunk flush.',
      startMs: 0,
      endMs: 5000,
    }])
  })

  test('speaker interruption starts a new turn and prevents cross-interruption joining', () => {
    const turns = mergeAdjacentSpeakerTurns([
      { channel: 'mic', text: 'First from you.', startMs: 0, endMs: 1000 },
      { channel: 'system', text: 'Then from them.', startMs: 1200, endMs: 2200 },
      { channel: 'mic', text: 'Back to you.', startMs: 2400, endMs: 3400 },
    ])

    assert.deepEqual(turns.map((turn) => turn.text), [
      'First from you.',
      'Then from them.',
      'Back to you.',
    ])
  })

  test('keeps different attributed remote speakers as separate turns', () => {
    const turns = mergeAdjacentSpeakerTurns([
      { channel: 'system', speakerName: 'Alice', text: 'Alice speaking.', startMs: 0, endMs: 1000 },
      { channel: 'system', speakerName: 'Bob', text: 'Bob interrupts.', startMs: 1200, endMs: 2200 },
    ])

    assert.equal(turns.length, 2)
  })

  test('does not mutate the source segments', () => {
    const source = [
      { channel: 'mic' as const, text: 'one', startMs: 0, endMs: 1000 },
      { channel: 'mic' as const, text: 'two', startMs: 1200, endMs: 2000 },
    ]
    mergeAdjacentSpeakerTurns(source)
    assert.deepEqual(source.map((segment) => segment.text), ['one', 'two'])
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

describe('attributeSpeakers', () => {
  test('a system segment gets the speaker who was sampled for the largest share of its time window', () => {
    const segments = [{ channel: 'system' as const, text: 'hello', startMs: 0, endMs: 10000 }]
    const samples: SpeakerSample[] = [
      { speakerName: 'Sarah', timestampMs: 1000 },
      { speakerName: 'Sarah', timestampMs: 3000 },
      { speakerName: 'John', timestampMs: 8000 },
    ]
    const result = attributeSpeakers(segments, samples)
    assert.equal(result[0].speakerName, 'Sarah')
  })

  test('no samples fall inside the segment window -> speakerName is null', () => {
    const segments = [{ channel: 'system' as const, text: 'hi', startMs: 0, endMs: 1000 }]
    const samples: SpeakerSample[] = [{ speakerName: 'Sarah', timestampMs: 50000 }]
    const result = attributeSpeakers(segments, samples)
    assert.equal(result[0].speakerName, null)
  })

  test('every in-range sample is null -> speakerName is null, not "null" the string', () => {
    const segments = [{ channel: 'system' as const, text: 'hi', startMs: 0, endMs: 1000 }]
    const samples: SpeakerSample[] = [{ speakerName: null, timestampMs: 500 }]
    const result = attributeSpeakers(segments, samples)
    assert.equal(result[0].speakerName, null)
  })

  test('mic segments are never attributed, even with in-range samples', () => {
    const segments = [{ channel: 'mic' as const, text: 'hi', startMs: 0, endMs: 1000 }]
    const samples: SpeakerSample[] = [{ speakerName: 'Sarah', timestampMs: 500 }]
    const result = attributeSpeakers(segments, samples)
    assert.equal('speakerName' in result[0], false)
  })

  test('empty samples array -> every system segment stays null, no throw', () => {
    const segments = [{ channel: 'system' as const, text: 'hi', startMs: 0, endMs: 1000 }]
    const result = attributeSpeakers(segments, [])
    assert.equal(result[0].speakerName, null)
  })

  test('a tie between two speakers picks whichever was sampled first, deterministically', () => {
    const segments = [{ channel: 'system' as const, text: 'hi', startMs: 0, endMs: 1000 }]
    const samples: SpeakerSample[] = [
      { speakerName: 'John', timestampMs: 100 },
      { speakerName: 'Sarah', timestampMs: 200 },
    ]
    const result = attributeSpeakers(segments, samples)
    assert.equal(result[0].speakerName, 'John')
  })

  test('does not mutate the input segments array', () => {
    const segments = [{ channel: 'system' as const, text: 'hi', startMs: 0, endMs: 1000 }]
    attributeSpeakers(segments, [{ speakerName: 'Sarah', timestampMs: 500 }])
    assert.equal('speakerName' in segments[0], false)
  })
})
