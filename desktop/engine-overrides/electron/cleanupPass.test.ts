import { test, describe } from 'node:test'
import assert from 'node:assert'
import { buildCleanupMessages, acceptCleanupResult, shouldAttemptCleanup } from './cleanupPass'

describe('shouldAttemptCleanup', () => {
  test('skips short utterances (not worth latency)', () => {
    assert.equal(shouldAttemptCleanup('Yes, do it.'), false)
  })
  test('attempts on real dictations', () => {
    assert.equal(shouldAttemptCleanup('Uh so so I I want you to create a new worktree from the main branch and then we will work on the feature'), true)
  })
})

describe('buildCleanupMessages', () => {
  test('two messages, raw text in the user turn, verbatim-preserving system rules', () => {
    const m = buildCleanupMessages('raw text here')
    assert.equal(m.length, 2)
    assert.equal(m[0].role, 'system')
    assert.match(m[0].content, /do not add|never add/i)
    assert.equal(m[1].role, 'user')
    assert.equal(m[1].content, 'raw text here')
  })
})

describe('acceptCleanupResult', () => {
  const raw = 'Uh so so I I want you to create a new worktree from the main branch please'
  test('accepts a plausible cleanup', () => {
    const cleaned = 'So I want you to create a new worktree from the main branch please'
    assert.equal(acceptCleanupResult(raw, cleaned), cleaned)
  })
  test('rejects null/empty', () => {
    assert.equal(acceptCleanupResult(raw, null), raw)
    assert.equal(acceptCleanupResult(raw, '  '), raw)
  })
  test('rejects refusals', () => {
    assert.equal(acceptCleanupResult(raw, "I'm sorry, I can't help with that."), raw)
  })
  test('rejects suspicious shrink (<40% of raw) and growth (>140%)', () => {
    assert.equal(acceptCleanupResult(raw, 'ok'), raw)
    assert.equal(acceptCleanupResult(raw, raw + ' ' + raw), raw)
  })
})
