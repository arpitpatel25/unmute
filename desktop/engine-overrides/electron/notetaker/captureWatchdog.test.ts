import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { captureStopReason, MAX_CAPTURE_MS, SILENCE_STOP_MS } from './captureWatchdog'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

describe('captureStopReason', () => {
  test('keeps a capture running while someone is still talking', () => {
    const now = 1_788_942_929_429
    assert.equal(captureStopReason({ nowMs: now, startedAtMs: now - 40 * MINUTE, lastAudibleAtMs: now - 12_000 }), null)
  })

  // 2026-09-09: a capture started for an interview at 14:05 was still running
  // at 23:13 because nothing but a human ever ends one. Real speech stopped
  // around 18:04; the rest is silence, and one hallucinated segment.
  test('ends a capture that has heard nothing for the silence limit', () => {
    const now = 1_788_975_839_336
    assert.equal(captureStopReason({ nowMs: now, startedAtMs: now - 9 * HOUR, lastAudibleAtMs: now - SILENCE_STOP_MS }), 'silence')
  })

  // The wall clock is what "this capture has been dead for 15 minutes" means,
  // and it is the only clock that keeps counting while the Mac is asleep — a
  // capture left running overnight is silent for the whole night.
  test('counts a night of sleep as silence, because it reads the system clock', () => {
    const beforeSleep = 1_789_432_567_969
    const afterSleep = beforeSleep + 9 * HOUR
    assert.equal(captureStopReason({ nowMs: afterSleep, startedAtMs: beforeSleep - HOUR, lastAudibleAtMs: beforeSleep }), 'silence')
  })

  test('ends a capture that has run past the maximum even while audio keeps arriving', () => {
    const now = 1_788_942_929_429
    assert.equal(captureStopReason({ nowMs: now, startedAtMs: now - MAX_CAPTURE_MS, lastAudibleAtMs: now - 5_000 }), 'max-duration')
  })

  test('reports silence first when a long capture is also silent', () => {
    const now = 1_788_942_929_429
    assert.equal(
      captureStopReason({ nowMs: now, startedAtMs: now - MAX_CAPTURE_MS, lastAudibleAtMs: now - SILENCE_STOP_MS }),
      'silence',
    )
  })

  test('never stops on a clock that has moved backwards', () => {
    const now = 1_788_942_929_429
    assert.equal(captureStopReason({ nowMs: now, startedAtMs: now + MINUTE, lastAudibleAtMs: now + MINUTE }), null)
  })
})
