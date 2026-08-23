import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { computeRms } from './computeRms'

describe('computeRms', () => {
  test('all-zero samples produce rms 0', () => {
    assert.equal(computeRms(new Float32Array([0, 0, 0, 0])), 0)
  })

  test('constant-amplitude samples produce that amplitude as rms', () => {
    assert.equal(computeRms(new Float32Array([0.5, -0.5, 0.5, -0.5])), 0.5)
  })

  test('known mixed values match the hand-computed rms', () => {
    // rms([1,0,0,0]) = sqrt((1+0+0+0)/4) = 0.5
    assert.equal(computeRms(new Float32Array([1, 0, 0, 0])), 0.5)
  })

  test('empty array returns 0, not NaN', () => {
    assert.equal(computeRms(new Float32Array([])), 0)
  })

  test('single-sample array returns the absolute value of that sample', () => {
    assert.equal(computeRms(new Float32Array([-0.75])), 0.75)
  })
})
