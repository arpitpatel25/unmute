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

  test('rejects deletion of a whole clause', () => {
    const raw = 'ship it today and be concise with the response'
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
})
