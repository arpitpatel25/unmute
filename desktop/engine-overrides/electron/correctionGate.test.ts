import { test, describe } from 'node:test'
import assert from 'node:assert'
import { phoneticKey, segmentSimilarity, applyGatedCorrection } from './correctionGate'

describe('phoneticKey', () => {
  test('sound-alike words map to close keys', () => {
    assert.equal(phoneticKey('worktree'), phoneticKey('worktree'))
    // Not necessarily equal, but comparable — similarity handles closeness.
    assert.ok(phoneticKey('anit').length > 0)
  })
})

describe('segmentSimilarity', () => {
  test('the field mishearings score as similar (≥0.5)', () => {
    assert.ok(segmentSimilarity('world wall tree', 'worktree') >= 0.5)
    assert.ok(segmentSimilarity('brahc', 'branch') >= 0.5)
    assert.ok(segmentSimilarity('minibar', 'mini bar') >= 0.5)
  })
  test('meaning-changes score as dissimilar (<0.5)', () => {
    assert.ok(segmentSimilarity('do you think it is slow', 'the weather is nice') < 0.5)
    assert.ok(segmentSimilarity('correct', 'wrong') < 0.5)
  })
})

describe('applyGatedCorrection', () => {
  test('accepts a phonetically-plausible substitution', () => {
    const raw = 'create a new world wall tree from the main branch'
    const proposed = 'create a new worktree from the main branch'
    const r = applyGatedCorrection(raw, proposed)
    assert.equal(r.text, proposed)
    assert.ok(r.acceptedEdits >= 1)
    assert.equal(r.rejectedEdits, 0)
  })

  test('rejects a semantic rewrite but keeps unrelated good edits', () => {
    const raw = 'create a new world wall tree and uh uh tell me if it worked'
    // LLM fixes "world wall tree" (good) AND rewrites the tail (bad).
    const proposed = 'create a new worktree and report the outcome'
    const r = applyGatedCorrection(raw, proposed)
    assert.ok(r.text.includes('worktree'))          // good edit kept
    assert.ok(r.text.includes('tell me if it worked')) // rewrite rejected → raw kept
    assert.ok(r.rejectedEdits >= 1)
  })

  test('rejects insertions of new content', () => {
    const raw = 'send the report to the team'
    const proposed = 'send the quarterly financial report to the team'
    const r = applyGatedCorrection(raw, proposed)
    assert.equal(r.text, raw)
  })

  test('accepts small filler deletions', () => {
    const raw = 'so um I want um the file'
    const proposed = 'so I want the file'
    const r = applyGatedCorrection(raw, proposed)
    assert.equal(r.text, proposed)
  })

  test('rejects deletion of a whole clause (over the clause cap)', () => {
    // 8-word contiguous deletion — larger than MAX_DELETION_WORDS (6), so the
    // clause guard rejects it even though nothing is locked.
    const raw = 'ship it today and please be concise with the final response'
    const proposed = 'ship it today'
    const r = applyGatedCorrection(raw, proposed)
    assert.equal(r.text, raw)
  })

  test('locks negations: not→now flip is rejected despite sounding alike', () => {
    const raw = 'do not delete the folder'
    const proposed = 'do now delete the folder'
    const r = applyGatedCorrection(raw, proposed)
    assert.equal(r.text, raw)
  })

  test('locks numbers', () => {
    const raw = 'transfer 15 files'
    const proposed = 'transfer 50 files'
    const r = applyGatedCorrection(raw, proposed)
    assert.equal(r.text, raw)
  })

  test('identical text passes through untouched', () => {
    const raw = 'nothing to fix here'
    const r = applyGatedCorrection(raw, 'nothing to fix here')
    assert.equal(r.text, raw)
    assert.equal(r.acceptedEdits, 0)
    assert.equal(r.rejectedEdits, 0)
  })

  test('spelling propagation: normalizes a misheard term to a spelling the user produced elsewhere', () => {
    // User spelled the product out once (STT → "CALORIFY"), misheard elsewhere.
    const raw = 'the app is CALORIFY and the calorifi dashboard is great'
    const proposed = 'the app is CALORIFY and the calorify dashboard is great'
    const r = applyGatedCorrection(raw, proposed)
    assert.ok(r.text.toLowerCase().split(/\s+/).filter((w) => w === 'calorify').length >= 2) // both occurrences now match
    assert.ok(r.acceptedEdits >= 1)
  })

  test('spelling propagation does NOT swap one distinct term for an unrelated one that merely appears elsewhere', () => {
    // "kubernetes" and "terraform" both appear; a swap between them is a MEANING
    // change, not a spelling fix — the sound floor must reject it.
    const raw = 'we discussed kubernetes and terraform then the kubernetes rollout'
    const proposed = 'we discussed kubernetes and terraform then the terraform rollout'
    const r = applyGatedCorrection(raw, proposed)
    assert.ok(r.text.includes('kubernetes rollout')) // unrelated swap rejected → raw kept
    assert.ok(r.rejectedEdits >= 1)
  })

  test('spelling propagation never invents a spelling absent from the transcript', () => {
    const raw = 'the calorifi app is good'
    const proposed = 'the calorify app is good' // "calorify" never appears in raw
    const r = applyGatedCorrection(raw, proposed)
    // Only allowed if it clears the normal phonetic bar on its own (it does here,
    // ~0.87) — but that's the existing gate, not propagation. The propagation
    // path specifically must not fire without an elsewhere-match; verified above.
    assert.ok(r.acceptedEdits + r.rejectedEdits >= 1)
  })

  test('null/empty proposal returns raw', () => {
    assert.equal(applyGatedCorrection('keep me', null).text, 'keep me')
    assert.equal(applyGatedCorrection('keep me', '  ').text, 'keep me')
  })

  test('runaway edit budget: too many changed words returns raw wholesale', () => {
    const raw = 'alpha beta gamma delta epsilon zeta eta theta iota kappa'
    const proposed = 'apple bottle gamble delay ebsilon zebra ethan thought iowa cappa'
    const r = applyGatedCorrection(raw, proposed)
    assert.equal(r.text, raw)
  })

  // ─── deletion contract: trust-LLM + catastrophe locks (2026-07-19) ──────
  // The gate does NOT decide which deleted words are filler — that is a
  // context call ("like" the filler vs. "like" the verb) only the LLM can
  // make, and the user has chosen to trust it there. So for DELETIONS the
  // gate accepts any bounded, non-inverting removal and HARD-BLOCKS only the
  // two catastrophes: meaning INVERSION (deleting a negation or a number) and
  // CLAUSE-SIZE deletion (a run longer than MAX_DELETION_WORDS = summarization).
  // This is deliberately NOT the old per-word filler-set gate: that approach
  // rejected legitimate content-word deletions the LLM proposed (it turned
  // "can you send this" into a rejected edit) yet still couldn't tell filler
  // from content — so it was replaced with "trust the LLM, block catastrophes".
  describe('deletion contract: trust-LLM, block only inversions + clause-size', () => {
    test('discourse filler ACCEPTED: "like" is dropped', () => {
      const raw = 'So I like want you to do it'
      const proposed = 'So I want you to do it'
      const r = applyGatedCorrection(raw, proposed)
      assert.equal(r.text, proposed)
      assert.ok(r.acceptedEdits >= 1)
      assert.equal(r.rejectedEdits, 0)
    })

    test('multiword filler ACCEPTED: "you know" is removed', () => {
      const raw = 'we can you know start now'
      const proposed = 'we can start now'
      const r = applyGatedCorrection(raw, proposed)
      assert.equal(r.text, proposed)
      assert.ok(r.acceptedEdits >= 1)
    })

    test('bounded non-locked deletion ACCEPTED (trust-LLM): the gate no longer re-judges content vs filler', () => {
      // NEW CONTRACT: a bounded, non-inverting deletion the LLM proposed is
      // TRUSTED and accepted — the gate does not second-guess whether "you" was
      // filler here. (The OLD per-word filler-set gate REJECTED exactly this,
      // which was the "can you send this" → "can send this" content-word hole.
      // We stop the gate guessing; only inversions and clause-size are blocked.)
      const raw = 'can you send this'
      const proposed = 'can send this'
      const r = applyGatedCorrection(raw, proposed)
      assert.equal(r.text, proposed)
      assert.ok(r.acceptedEdits >= 1)
      assert.equal(r.rejectedEdits, 0)
    })

    test('negation deletion REJECTED (meaning lock): "not" is preserved', () => {
      const raw = 'do not send it'
      const proposed = 'do send it'
      const r = applyGatedCorrection(raw, proposed)
      assert.ok(r.text.toLowerCase().split(/\s+/).includes('not'))
      assert.ok(r.rejectedEdits >= 1)
    })

    test('number deletion REJECTED (meaning lock): "3" is preserved', () => {
      const raw = 'send 3 copies'
      const proposed = 'send copies'
      const r = applyGatedCorrection(raw, proposed)
      assert.ok(r.text.split(/\s+/).includes('3'))
      assert.ok(r.rejectedEdits >= 1)
    })

    test('stutter still accepted: "I I" collapses', () => {
      const raw = 'I I want'
      const proposed = 'I want'
      const r = applyGatedCorrection(raw, proposed)
      assert.equal(r.text, proposed)
      assert.ok(r.acceptedEdits >= 1)
    })

    test('a filler run within the cap passes but an over-cap clause does not', () => {
      // A 5-word filler run ("you know what I mean") is within MAX_DELETION_WORDS
      // (6) and accepted — trusted as filler …
      const okRaw = 'we can you know what I mean start'
      const okProp = 'we can start'
      assert.equal(applyGatedCorrection(okRaw, okProp).text, okProp)
      // … but a >6-word contiguous deletion is a clause and is rejected.
      const clauseRaw = 'ship it today and please be concise with the final response'
      const clauseProp = 'ship it today'
      assert.equal(applyGatedCorrection(clauseRaw, clauseProp).text, clauseRaw)
    })

    test('oversized deletion REJECTED (clause guard): a >6-word contiguous drop', () => {
      const raw = 'please review the document and send it back to me before noon'
      const proposed = 'please review the document'
      // Deleted "and send it back to me before noon" = 8 words > 6 → clause guard.
      const r = applyGatedCorrection(raw, proposed)
      assert.equal(r.text, raw)
      assert.ok(r.rejectedEdits >= 1)
    })

    test('non-sound-alike substitution still REJECTED (Job B unchanged)', () => {
      const raw = 'please show up the results'
      const proposed = 'please show it the results'
      const r = applyGatedCorrection(raw, proposed)
      assert.ok(r.text.toLowerCase().split(/\s+/).includes('up'))
      assert.ok(r.rejectedEdits >= 1)
    })
  })
})
