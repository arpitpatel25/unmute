import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { computeRms } from './computeRms'

describe('computeRms', () => {
  test('silence (all zeros) has rms 0', () => {
    assert.equal(computeRms(new Float32Array([0, 0, 0, 0])), 0)
  })

  test('constant amplitude signal has rms equal to that amplitude', () => {
    // rms of a constant-magnitude alternating signal equals the magnitude
    assert.ok(Math.abs(computeRms(new Float32Array([0.5, -0.5, 0.5, -0.5])) - 0.5) < 1e-9)
  })

  test('known values produce the correct rms', () => {
    // rms([3,4]) = sqrt((9+16)/2) = sqrt(12.5) ≈ 3.5355339
    const rms = computeRms(new Float32Array([3, 4]))
    assert.ok(Math.abs(rms - 3.5355339059327378) < 1e-9)
  })

  test('empty input returns 0, not NaN', () => {
    assert.equal(computeRms(new Float32Array([])), 0)
  })

  test('single sample returns its absolute value', () => {
    assert.ok(Math.abs(computeRms(new Float32Array([-0.7])) - 0.7) < 1e-6)
  })
})
