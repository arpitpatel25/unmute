import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { micChunkWallClockMs } from './micChunkClock'

describe('micChunkWallClockMs', () => {
  test('dates a chunk from the wall clock minus how long ago its first frame was captured', () => {
    const nowMs = 1_789_464_747_000
    assert.equal(micChunkWallClockMs({ nowMs, contextNowSeconds: 90_629.5, chunkContextSeconds: 90_629.4, chunkDurationMs: 85 }), nowMs - 100)
  })

  // 2026-09-15: the old mapping was performance.timeOrigin + performanceTime.
  // A window reused for a day whose Mac slept ~9h had a performance clock 9h
  // behind wall time, so the mic lane was dated 9h early. The mapping must not
  // depend on anything that stops while the machine sleeps — only on the wall
  // clock read now and the audio clock's own short-range age of the chunk.
  test('stays on the wall clock however long the audio context has been alive', () => {
    const nowMs = 1_789_464_747_000
    const dayOldContext = micChunkWallClockMs({ nowMs, contextNowSeconds: 1_000_000.1, chunkContextSeconds: 1_000_000, chunkDurationMs: 85 })
    assert.ok(Math.abs(dayOldContext - (nowMs - 100)) < 1)
  })

  test('falls back to one chunk duration before now when the chunk has no audio-clock time', () => {
    assert.equal(micChunkWallClockMs({ nowMs: 10_000, contextNowSeconds: 5, chunkDurationMs: 85 }), 10_000 - 85)
  })

  test('falls back when the chunk time is ahead of the context clock, as ScriptProcessor playbackTime is', () => {
    assert.equal(micChunkWallClockMs({ nowMs: 10_000, contextNowSeconds: 5, chunkContextSeconds: 5.2, chunkDurationMs: 85 }), 10_000 - 85)
  })
})
