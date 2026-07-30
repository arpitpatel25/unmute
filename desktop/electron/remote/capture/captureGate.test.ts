import { test, describe } from 'node:test'
import assert from 'node:assert'
import { canArmScratchpad, canObserve } from './captureGate'

describe('the two axes gate independently', () => {
  test('both on: everything works', () => {
    const s = { scratchpadEnabled: true, captureEnabled: true }
    assert.equal(canArmScratchpad(s), true)
    assert.equal(canObserve(s), true)
  })

  test('scratchpad OFF does not disable capture — a copy still lands inline', () => {
    const s = { scratchpadEnabled: false, captureEnabled: true }
    assert.equal(canArmScratchpad(s), false)
    assert.equal(canObserve(s), true)
  })

  test('capture OFF does not disable the scratchpad — speech alone still builds a pad', () => {
    const s = { scratchpadEnabled: true, captureEnabled: false }
    assert.equal(canArmScratchpad(s), true)
    assert.equal(canObserve(s), false)
  })

  test('both off', () => {
    const s = { scratchpadEnabled: false, captureEnabled: false }
    assert.equal(canArmScratchpad(s), false)
    assert.equal(canObserve(s), false)
  })
})

describe('defaults are permissive', () => {
  test('undefined reads as ON for both — capture is the baseline behaviour', () => {
    const s = {} as { scratchpadEnabled: boolean; captureEnabled: boolean }
    assert.equal(canArmScratchpad(s), true)
    assert.equal(canObserve(s), true)
  })
})
