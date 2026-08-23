import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { ChunkBuffer } from './chunkBuffer'
import type { TimestampedChunk } from '../notetakerSession'

function chunk(source: 'mic' | 'system', samples: number[], timestampMs: number): TimestampedChunk {
  return { source, samples: new Float32Array(samples), sampleRate: 16000, channels: 1, timestampMs }
}

// Float32Array has inherent precision differences when converting back to JavaScript numbers
// Use this for tolerance-based comparison
function assertSamplesClose(actual: Float32Array, expected: number[], tolerance = 1e-6) {
  const actualArray = Array.from(actual)
  assert.equal(actualArray.length, expected.length)
  for (let i = 0; i < expected.length; i++) {
    const diff = Math.abs(actualArray[i] - expected[i])
    assert.ok(diff < tolerance, `Sample ${i}: ${actualArray[i]} differs from ${expected[i]} by ${diff}`)
  }
}

describe('ChunkBuffer', () => {
  test('finalize() on an untouched channel returns null', () => {
    const buf = new ChunkBuffer()
    assert.equal(buf.finalize('mic'), null)
  })

  test('concatenates same-channel chunks in feed order', () => {
    const buf = new ChunkBuffer()
    buf.feed(chunk('mic', [0.1, 0.2], 1000))
    buf.feed(chunk('mic', [0.3, 0.4], 1010))
    const result = buf.finalize('mic')
    assert.ok(result)
    assertSamplesClose(result!.samples, [0.1, 0.2, 0.3, 0.4])
  })

  test('mic and system channels are kept independent', () => {
    const buf = new ChunkBuffer()
    buf.feed(chunk('mic', [0.1], 1000))
    buf.feed(chunk('system', [0.9], 1005))
    assertSamplesClose(buf.finalize('mic')!.samples, [0.1])
    assertSamplesClose(buf.finalize('system')!.samples, [0.9])
  })

  test('records sampleRate/channels from the first chunk fed for that channel', () => {
    const buf = new ChunkBuffer()
    buf.feed({ source: 'system', samples: new Float32Array([0.1, 0.2]), sampleRate: 48000, channels: 2, timestampMs: 1000 })
    const result = buf.finalize('system')
    assert.equal(result!.sampleRate, 48000)
    assert.equal(result!.channels, 2)
  })

  test('records the timestamp of the first chunk fed for that channel', () => {
    const buf = new ChunkBuffer()
    buf.feed(chunk('mic', [0.1], 5000))
    buf.feed(chunk('mic', [0.2], 5010))
    assert.equal(buf.finalize('mic')!.firstTimestampMs, 5000)
  })

  test('finalize() can be called more than once and returns a consistent snapshot', () => {
    const buf = new ChunkBuffer()
    buf.feed(chunk('mic', [0.1], 1000))
    const first = buf.finalize('mic')
    buf.feed(chunk('mic', [0.2], 1010))
    const second = buf.finalize('mic')
    assertSamplesClose(first!.samples, [0.1])
    assertSamplesClose(second!.samples, [0.1, 0.2])
  })
})
