import { test } from 'node:test'
import assert from 'node:assert'
import { isSuspectQuietCapture } from './quietGuard'

test('faint capture + tiny transcript = suspect (the "BOT" case)', () => {
  assert.equal(isSuspectQuietCapture(0.005, 'BOT'), true)
  assert.equal(isSuspectQuietCapture(0.005, ' Thank you.'), true)
})

test('faint capture + substantive transcript = NOT suspect (soft-spoken user)', () => {
  assert.equal(isSuspectQuietCapture(0.005, 'So I want to create a new worktree from the main branch'), false)
})

test('healthy level + tiny transcript = NOT suspect (user said one word)', () => {
  assert.equal(isSuspectQuietCapture(0.3, 'Yes.'), false)
})

test('unknown quality (no report) never gates', () => {
  assert.equal(isSuspectQuietCapture(null, 'BOT'), false)
  assert.equal(isSuspectQuietCapture(0, 'BOT'), false)
})

test('raw-level normal speech (AGC off, rmsMax ~0.02-0.04) + short transcript = NOT suspect', () => {
  assert.equal(isSuspectQuietCapture(0.02, 'Correction.'), false)
  assert.equal(isSuspectQuietCapture(0.035, 'Yes, do it.'), false)
})
