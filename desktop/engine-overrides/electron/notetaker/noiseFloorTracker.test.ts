import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { NoiseFloorTracker } from './noiseFloorTracker'

describe('NoiseFloorTracker', () => {
  test('floor is null before any samples are fed', () => {
    const tracker = new NoiseFloorTracker()
    assert.equal(tracker.floor, null)
  })

  test('floor is the p20 value of fed samples', () => {
    const tracker = new NoiseFloorTracker(6000)
    // 10 values 0.01..0.10 at t=0 — p20 index = floor(10*0.2) = 2 -> sorted[2] = 0.03
    for (let i = 1; i <= 10; i++) tracker.feed(i / 100, 0)
    assert.equal(tracker.floor, 0.03)
  })

  test('samples older than the window are evicted', () => {
    const tracker = new NoiseFloorTracker(1000)
    tracker.feed(0.01, 0)
    tracker.feed(0.02, 0)
    tracker.feed(0.03, 0)
    // advance past the window — old samples should no longer count
    tracker.feed(0.5, 2000)
    tracker.feed(0.6, 2000)
    tracker.feed(0.7, 2000)
    // p20 of [0.5,0.6,0.7] -> index floor(3*0.2)=0 -> 0.5
    assert.equal(tracker.floor, 0.5)
  })

  test('a single sample is its own p20 (and floor) value', () => {
    const tracker = new NoiseFloorTracker()
    tracker.feed(0.042, 0)
    assert.equal(tracker.floor, 0.042)
  })
})
