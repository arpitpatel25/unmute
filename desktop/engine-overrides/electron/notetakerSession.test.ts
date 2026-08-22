// desktop/engine-overrides/electron/notetakerSession.test.ts
import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { NotetakerSession, type TimestampedChunk } from './notetakerSession'

function fakeNativeAudioTap() {
  let capturedOnChunk: ((c: { samples: Float32Array; sampleRate: number; timestampMs: number }) => void) | null = null
  let startCalls: number[] = []
  let stopCalls = 0
  return {
    tap: {
      startCapture: (pid: number, onChunk: typeof capturedOnChunk extends null ? never : NonNullable<typeof capturedOnChunk>) => {
        startCalls.push(pid)
        capturedOnChunk = onChunk
      },
      stopCapture: () => {
        stopCalls++
      },
    },
    emitSystemChunk: (samples: Float32Array, sampleRate: number, timestampMs: number) => {
      capturedOnChunk?.({ samples, sampleRate, timestampMs })
    },
    get startCalls() { return startCalls },
    get stopCalls() { return stopCalls },
  }
}

describe('NotetakerSession', () => {
  test('start() calls native startCapture with the target pid', () => {
    const fake = fakeNativeAudioTap()
    const session = new NotetakerSession(fake.tap, () => {})
    session.start(4242)
    assert.deepEqual(fake.startCalls, [4242])
    assert.equal(session.isActive, true)
  })

  test('system-audio chunks are tagged with source "system" and passed through', () => {
    const fake = fakeNativeAudioTap()
    const received: TimestampedChunk[] = []
    const session = new NotetakerSession(fake.tap, (c) => received.push(c))
    session.start(4242)
    fake.emitSystemChunk(new Float32Array([0.1, 0.2]), 48000, 1000)
    assert.equal(received.length, 1)
    assert.equal(received[0].source, 'system')
    assert.equal(received[0].timestampMs, 1000)
  })

  test('mic chunks fed in from the renderer are tagged with source "mic"', () => {
    const fake = fakeNativeAudioTap()
    const received: TimestampedChunk[] = []
    const session = new NotetakerSession(fake.tap, (c) => received.push(c))
    session.start(4242)
    session.feedMicChunk(new Float32Array([0.3]), 16000, 1005)
    assert.equal(received.length, 1)
    assert.equal(received[0].source, 'mic')
    assert.equal(received[0].timestampMs, 1005)
  })

  test('mic and system chunks interleave in arrival order, both timestamped', () => {
    const fake = fakeNativeAudioTap()
    const received: TimestampedChunk[] = []
    const session = new NotetakerSession(fake.tap, (c) => received.push(c))
    session.start(4242)
    fake.emitSystemChunk(new Float32Array([0.1]), 48000, 1000)
    session.feedMicChunk(new Float32Array([0.2]), 16000, 1010)
    fake.emitSystemChunk(new Float32Array([0.3]), 48000, 1020)
    assert.deepEqual(received.map((c) => c.source), ['system', 'mic', 'system'])
    assert.deepEqual(received.map((c) => c.timestampMs), [1000, 1010, 1020])
  })

  test('stop() calls native stopCapture and further chunks are ignored', () => {
    const fake = fakeNativeAudioTap()
    const received: TimestampedChunk[] = []
    const session = new NotetakerSession(fake.tap, (c) => received.push(c))
    session.start(4242)
    session.stop()
    assert.equal(fake.stopCalls, 1)
    assert.equal(session.isActive, false)
    session.feedMicChunk(new Float32Array([0.5]), 16000, 2000)
    assert.equal(received.length, 0)
  })

  test('start() throws if already active', () => {
    const fake = fakeNativeAudioTap()
    const session = new NotetakerSession(fake.tap, () => {})
    session.start(4242)
    assert.throws(() => session.start(4242))
  })

  test('start() resets isActive to false if native startCapture throws synchronously, and a retry is possible', () => {
    let shouldThrow = true
    const throwingTap = {
      startCapture: (_pid: number, _onChunk: (c: { samples: Float32Array; sampleRate: number; timestampMs: number }) => void) => {
        if (shouldThrow) {
          throw new Error('AudioDeviceStart failed (TCC permission not yet granted)')
        }
      },
      stopCapture: () => {},
    }
    const session = new NotetakerSession(throwingTap, () => {})
    assert.throws(() => session.start(4242))
    assert.equal(session.isActive, false)
    // Retry after the failure (e.g. once the user grants the TCC permission) must not hit
    // the "already active" guard.
    shouldThrow = false
    assert.doesNotThrow(() => session.start(4242))
    assert.equal(session.isActive, true)
  })
})
