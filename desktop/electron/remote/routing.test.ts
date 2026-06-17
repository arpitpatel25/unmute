import { test } from 'node:test'
import assert from 'node:assert/strict'
import { looksLikeContinuation } from './routing.ts'

test('explicit continuation cues are detected', () => {
  assert.equal(looksLikeContinuation('also send it to Rishi'), true)
  assert.equal(looksLikeContinuation('and then reply to the second one'), true)
  assert.equal(looksLikeContinuation('now reply to that'), true)
  assert.equal(looksLikeContinuation('continue'), true)
  assert.equal(looksLikeContinuation('reply to the second one'), true)
  assert.equal(looksLikeContinuation('open it now'), true)
})

test('fresh standalone commands default to NEW (not continuation)', () => {
  assert.equal(looksLikeContinuation('extract the zip in Downloads'), false)
  assert.equal(looksLikeContinuation('create a file called test.txt'), false)
  assert.equal(looksLikeContinuation('what emails are worth replying to'), false)
  assert.equal(looksLikeContinuation(''), false)
})
