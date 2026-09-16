import { test } from 'node:test'
import assert from 'node:assert'
import { isSuspectQuietCapture } from './quietGuard'

// All levels here are FLOAT-meter rms (2026-09-15). The byte-meter numbers the
// earlier version of this test used read roughly 0.0045 high on quiet audio —
// e.g. the "BOT" capture logged as 0.005 on that meter is ~0.002 on this one.
const QUIET_ROOM_FLOOR = 0.0006
const NEAR_SILENT = 0.002   // the "BOT" capture
const WHISPER = 0.006       // a deliberate whisper into a close wired mic
const NORMAL = 0.08

test('near-silent capture + tiny transcript = suspect (the "BOT" case)', () => {
  assert.equal(isSuspectQuietCapture(NEAR_SILENT, 'BOT', QUIET_ROOM_FLOOR), true)
  assert.equal(isSuspectQuietCapture(NEAR_SILENT, ' Thank you.', QUIET_ROOM_FLOOR), true)
})

test('near-silent capture + substantive transcript = NOT suspect (soft-spoken user)', () => {
  assert.equal(isSuspectQuietCapture(NEAR_SILENT, 'So I want to create a new worktree from the main branch', QUIET_ROOM_FLOOR), false)
})

// THE REGRESSION TEST for the wired-mic fix: the recorder now sends whispered
// captures to STT, so this guard must not silently eat them at the paste stage.
test('a whisper in a quiet room + tiny transcript = NOT suspect', () => {
  assert.equal(isSuspectQuietCapture(WHISPER, 'Yes.', QUIET_ROOM_FLOOR), false)
  assert.equal(isSuspectQuietCapture(WHISPER, 'Correction.', null), false)
})

test('healthy level + tiny transcript = NOT suspect (user said one word)', () => {
  assert.equal(isSuspectQuietCapture(0.3, 'Yes.', QUIET_ROOM_FLOOR), false)
  assert.equal(isSuspectQuietCapture(NORMAL, 'Yes, do it.', null), false)
})

test('unknown quality (no report) never gates', () => {
  assert.equal(isSuspectQuietCapture(null, 'BOT', QUIET_ROOM_FLOOR), false)
  assert.equal(isSuspectQuietCapture(0, 'BOT', null), false)
})

test('no floor measured: the absolute minimum speech level stands in', () => {
  assert.equal(isSuspectQuietCapture(0.003, 'BOT', null), true)
  assert.equal(isSuspectQuietCapture(0.005, 'BOT', null), false)
})

test('a noisy room raises the bar with it', () => {
  // Floor 0.003 ⇒ a capture peaking at 0.012 never rose above its own room.
  assert.equal(isSuspectQuietCapture(0.012, 'BOT', 0.003), true)
  assert.equal(isSuspectQuietCapture(0.05, 'BOT', 0.003), false)
})
