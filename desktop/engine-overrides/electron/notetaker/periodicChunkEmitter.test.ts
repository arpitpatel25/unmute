import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { PeriodicChunkEmitter, type FinalizedSegment } from './periodicChunkEmitter'

function silentSamples(n: number): Float32Array {
  return new Float32Array(n) // all zeros — well below any threshold
}

function loudSamples(n: number): Float32Array {
  const arr = new Float32Array(n)
  arr.fill(0.5)
  return arr
}

describe('PeriodicChunkEmitter', () => {
  test('does not cut before minChunkMs, even on silence', () => {
    const segments: FinalizedSegment[] = []
    let clock = 0
    const emitter = new PeriodicChunkEmitter((s) => segments.push(s), { minChunkMs: 1000, silenceDurationMs: 100 }, () => clock)
    emitter.feed(loudSamples(10), 16000, 1, 0)
    clock = 200
    emitter.feed(silentSamples(10), 16000, 1, clock) // silence, but elapsed < minChunkMs
    assert.equal(segments.length, 0)
  })

  test('cuts on silence once past minChunkMs', () => {
    const segments: FinalizedSegment[] = []
    let clock = 0
    const emitter = new PeriodicChunkEmitter((s) => segments.push(s), { minChunkMs: 1000, silenceDurationMs: 100 }, () => clock)
    emitter.feed(loudSamples(10), 16000, 1, 0)
    clock = 1100 // past minChunkMs
    emitter.feed(silentSamples(10), 16000, 1, clock) // silence starts
    clock = 1250 // 150ms of continuous silence, past silenceDurationMs
    emitter.feed(silentSamples(10), 16000, 1, clock)
    assert.equal(segments.length, 1)
    assert.equal(segments[0].chunkIndex, 0)
  })

  test('force-cuts at hardCapMs regardless of loudness', () => {
    const segments: FinalizedSegment[] = []
    let clock = 0
    const emitter = new PeriodicChunkEmitter((s) => segments.push(s), { minChunkMs: 500, hardCapMs: 2000 }, () => clock)
    emitter.feed(loudSamples(10), 16000, 1, 0)
    clock = 2100
    emitter.feed(loudSamples(10), 16000, 1, clock) // still loud, but past hardCapMs
    assert.equal(segments.length, 1)
  })

  test('chunk index increments across multiple cuts', () => {
    const segments: FinalizedSegment[] = []
    let clock = 0
    const emitter = new PeriodicChunkEmitter((s) => segments.push(s), { minChunkMs: 100, silenceDurationMs: 50 }, () => clock)
    emitter.feed(loudSamples(10), 16000, 1, 0)
    clock = 200
    emitter.feed(silentSamples(10), 16000, 1, clock)
    clock = 300
    emitter.feed(silentSamples(10), 16000, 1, clock) // cut 1
    clock = 400
    emitter.feed(loudSamples(10), 16000, 1, clock)
    clock = 600
    emitter.feed(silentSamples(10), 16000, 1, clock)
    clock = 700
    emitter.feed(silentSamples(10), 16000, 1, clock) // cut 2
    assert.equal(segments.length, 2)
    assert.equal(segments[0].chunkIndex, 0)
    assert.equal(segments[1].chunkIndex, 1)
  })

  test('samples accumulate correctly within one segment before a cut', () => {
    const segments: FinalizedSegment[] = []
    let clock = 0
    const emitter = new PeriodicChunkEmitter((s) => segments.push(s), { minChunkMs: 100, silenceDurationMs: 50 }, () => clock)
    emitter.feed(new Float32Array([0.1, 0.2]), 16000, 1, 0)
    clock = 150
    emitter.feed(new Float32Array([0.3, 0.4]), 16000, 1, clock)
    clock = 250
    emitter.feed(silentSamples(2), 16000, 1, clock)
    clock = 350
    emitter.feed(silentSamples(2), 16000, 1, clock) // cut
    // Expected values run through Math.fround: samples travel via Float32Array,
    // which rounds 0.1/0.2/etc. to the nearest float32 — a different float64
    // bit pattern than the plain JS literal. Math.fround(x) reproduces exactly
    // that rounding, so this compares like-for-like instead of failing on an
    // IEEE-754 precision artifact unrelated to the emitter's own correctness.
    assert.deepEqual(Array.from(segments[0].samples), [0.1, 0.2, 0.3, 0.4, 0, 0].map(Math.fround))
  })

  test('flush() finalizes whatever is accumulated, even if under minChunkMs', () => {
    const segments: FinalizedSegment[] = []
    let clock = 0
    const emitter = new PeriodicChunkEmitter((s) => segments.push(s), { minChunkMs: 10000 }, () => clock)
    emitter.feed(new Float32Array([0.1, 0.2]), 16000, 1, 0)
    clock = 500
    emitter.flush()
    assert.equal(segments.length, 1)
    // See Math.fround note above.
    assert.deepEqual(Array.from(segments[0].samples), [0.1, 0.2].map(Math.fround))
  })

  test('flush() on an empty/no-feed emitter emits nothing', () => {
    const segments: FinalizedSegment[] = []
    const emitter = new PeriodicChunkEmitter((s) => segments.push(s))
    emitter.flush()
    assert.equal(segments.length, 0)
  })

  test('startTimestampMs on a segment is the timestamp of its first fed sample', () => {
    const segments: FinalizedSegment[] = []
    let clock = 0
    const emitter = new PeriodicChunkEmitter((s) => segments.push(s), { minChunkMs: 100, silenceDurationMs: 50 }, () => clock)
    emitter.feed(loudSamples(2), 16000, 1, 12345)
    clock = 12345 + 200
    emitter.feed(silentSamples(2), 16000, 1, clock)
    clock = 12345 + 300
    emitter.feed(silentSamples(2), 16000, 1, clock)
    assert.equal(segments[0].startTimestampMs, 12345)
  })

  test('timestamps a transcript at its first audible frame, not leading silence', () => {
    const segments: FinalizedSegment[] = []
    const emitter = new PeriodicChunkEmitter((s) => segments.push(s), { minChunkMs: 100, silenceDurationMs: 50 })
    emitter.feed(silentSamples(2), 16000, 1, 1000)
    emitter.feed(loudSamples(2), 16000, 1, 1250)
    emitter.flush()
    assert.equal(segments[0].startTimestampMs, 1250)
    assert.ok(segments[0].endTimestampMs >= 1250)
  })

  test('does not let a cold adaptive noise floor move a realistic speech onset later', () => {
    const segments: FinalizedSegment[] = []
    const emitter = new PeriodicChunkEmitter((segment) => segments.push(segment))
    const realisticSpeech = new Float32Array(160)
    realisticSpeech.fill(0.02)
    // On the first frame p20 is also 0.02, which makes the adaptive cut
    // threshold 0.032. Ordering must still use the stable configured floor.
    emitter.feed(realisticSpeech, 16000, 1, 1000)
    emitter.flush()
    assert.equal(segments[0].startTimestampMs, 1000)
  })

  test('reports audible duration separately from a long silent tail', () => {
    const segments: FinalizedSegment[] = []
    const emitter = new PeriodicChunkEmitter((segment) => segments.push(segment))
    emitter.feed(loudSamples(1600), 16000, 1, 0) // 100ms audible
    emitter.feed(silentSamples(16000), 16000, 1, 100) // 1s silence
    emitter.flush()
    assert.equal(Math.round(segments[0].audibleDurationMs), 100)
  })

  test('reports zero audible duration for a completely silent stop tail', () => {
    const segments: FinalizedSegment[] = []
    const emitter = new PeriodicChunkEmitter((segment) => segments.push(segment))
    emitter.feed(silentSamples(8000), 16000, 1, 0)
    emitter.flush()
    assert.equal(segments[0].audibleDurationMs, 0)
  })
})
