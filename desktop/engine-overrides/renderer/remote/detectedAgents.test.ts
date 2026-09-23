import { test } from 'node:test'
import assert from 'node:assert/strict'
import { vendorsOf, showsVendor } from './detectedAgents.ts'

test('makers come from the detected backend ids', () => {
  assert.deepEqual(vendorsOf(['codex', 'codex-desktop']), ['codex'])
  assert.deepEqual(vendorsOf(['claude-code-desktop']), ['claude'])
  assert.deepEqual(vendorsOf(['claude', 'codex-desktop']), ['claude', 'codex'])
  assert.deepEqual(vendorsOf([]), [])
})

test('copy about an undetected maker is hidden, unless nothing is detected', () => {
  assert.equal(showsVendor(['codex'], 'claude'), false)
  assert.equal(showsVendor(['codex'], 'codex'), true)
  assert.equal(showsVendor([], 'claude'), true, 'nothing detected ⇒ name both')
})
