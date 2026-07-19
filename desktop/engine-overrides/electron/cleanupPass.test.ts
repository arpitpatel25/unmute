import { test, describe } from 'node:test'
import assert from 'node:assert'
import { buildCleanupMessages, buildCorrectionMessages, acceptCleanupResult, shouldAttemptCleanup } from './cleanupPass'

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
  test('names discourse fillers to remove, keeps the never-add guard', () => {
    const m = buildCleanupMessages('raw')
    assert.match(m[0].content, /discourse fillers?/i)
    assert.match(m[0].content, /you know/i)
    assert.match(m[0].content, /never add|do not add|only delete|only DELETE/i)
    assert.match(m[0].content, /do not summarize|never summarize/i)
  })
})

describe('buildCorrectionMessages', () => {
  // SUBSTITUTION-ONLY: the correction prompt's only job is replacing misheard
  // words. It must NOT invite removing fillers, and must forbid removals/adds.
  test('substitution-only: replace misheard words, never remove or add', () => {
    const m = buildCorrectionMessages('raw')
    assert.equal(m.length, 2)
    assert.equal(m[0].role, 'system')
    assert.match(m[0].content, /sound like|misheard/i)          // substitution rule intact
    assert.match(m[0].content, /do NOT remove|not remove any words/i) // no deletions
    assert.match(m[0].content, /do NOT add|not add words/i)     // no insertions
    assert.match(m[0].content, /numbers or negations|never change numbers/i)
    assert.doesNotMatch(m[0].content, /discourse fillers?/i)    // no longer invites filler removal
    assert.equal(m[1].content, 'raw')
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

describe('structural verbatim guard (2026-07-15 field incident)', () => {
  const raw = 'Got it. So yeah, MCP needs a running server and do you think it\'s slow? It\'s tad bit slow? Not tad bit, it could be significantly slow, correct? Be concise with the response.'
  test('rejects the real summarization that ate questions and the trailing instruction', () => {
    const summarized = 'MCP needs a running server. It\'s tad bit slow, not tad bit, it could be significantly slow.'
    assert.equal(acceptCleanupResult(raw, summarized), raw)
  })
  test('accepts a true deletion-only cleanup within the word budget', () => {
    const cleaned = 'Got it. MCP needs a running server and do you think it\'s slow? It\'s tad bit slow? Not tad bit, it could be significantly slow, correct? Be concise with the response.'
    assert.equal(acceptCleanupResult(raw, cleaned), cleaned)
  })
  test('rejects rewording even at similar length', () => {
    const reworded = raw.replace('needs a running server', 'requires an active server')
    assert.equal(acceptCleanupResult(raw, reworded), raw)
  })
  test('punctuation/case changes alone are accepted (words unchanged)', () => {
    const repunct = raw.replace('slow?', 'slow.').replace('So yeah,', 'so yeah —')
    assert.equal(acceptCleanupResult(raw, repunct), repunct)
  })
})

describe('meaning-lock guard (deletion-only can still invert)', () => {
  test('rejects a deletion-only cleanup that dropped a negation', () => {
    // Pure deletion, within the keep ratio, but it deletes "not" → inverts.
    const raw = 'please do not send the final report to the whole team today'
    const dropped = 'please do send the final report to the whole team today'
    assert.equal(acceptCleanupResult(raw, dropped), raw)
  })
  test('rejects a deletion-only cleanup that dropped a number', () => {
    const raw = 'please send 3 copies of the signed contract to the client today'
    const dropped = 'please send copies of the signed contract to the client today'
    assert.equal(acceptCleanupResult(raw, dropped), raw)
  })
  test('still accepts a clean filler-only deletion that keeps negations/numbers', () => {
    const raw = 'uh so do not send the 3 copies you know today'
    const cleaned = 'so do not send the 3 copies today'
    assert.equal(acceptCleanupResult(raw, cleaned), cleaned)
  })
})
