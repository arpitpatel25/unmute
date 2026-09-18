import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, timeoutMsForSegments } from './pipelineTimeout'

describe('timeoutMsForSegments', () => {
  test('keeps the default budget for an ordinary transcript', () => {
    assert.equal(timeoutMsForSegments(40), DEFAULT_TIMEOUT_MS)
  })

  // 2026-09-09: a 9h capture produced 286 segments, and note cleanup was
  // killed at the fixed 300s — so that meeting's notes came from the
  // uncleaned transcript. The budget has to grow with the work.
  test('gives a long meeting more than the fixed budget that killed it', () => {
    assert.ok(timeoutMsForSegments(286) > DEFAULT_TIMEOUT_MS)
  })

  test('caps the budget so a runaway transcript cannot hang the pipeline', () => {
    assert.equal(timeoutMsForSegments(100_000), MAX_TIMEOUT_MS)
  })

  test('treats a missing count as an ordinary transcript', () => {
    assert.equal(timeoutMsForSegments(0), DEFAULT_TIMEOUT_MS)
  })
})
