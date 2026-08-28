// Sprawl has TWO causes and they need different cures.
//
// The one the model has to judge: "reddit marketing" vs "unmute marketing" —
// same stream at a different altitude. No string rule can settle that without
// also wrongly merging two real products, so it belongs in the prompt.
//
// The one code CAN settle, and the more common of the two: a label that is the
// existing label plus a qualifier — "unmute marketing plan" arriving when
// "unmute marketing" already exists. One label's words strictly CONTAIN the
// other's, so they cannot be about different subjects; the longer one is the
// shorter one with detail bolted on. That is a rename at best, never a new
// stream, and it is how "notch ui" became "notch ui redesign".
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canonicalGroup } from './router.ts'

const HAVE = [
  { label: 'unmute marketing' },
  { label: 'unmute ios' },
  { label: 'notch ui' },
  { label: 'on-call' },
]

test('an exact match still folds onto the stored label', () => {
  assert.equal(canonicalGroup('unmute marketing', HAVE), 'unmute marketing')
  assert.equal(canonicalGroup('UNMUTE  Marketing', HAVE), 'unmute marketing')
})

test('a label that adds a qualifier to an existing one joins it', () => {
  assert.equal(canonicalGroup('unmute marketing plan', HAVE), 'unmute marketing')
  assert.equal(canonicalGroup('notch ui redesign', HAVE), 'notch ui')
  assert.equal(canonicalGroup('unmute ios app', HAVE), 'unmute ios')
})

test('word order does not defeat the fold', () => {
  assert.equal(canonicalGroup('marketing for unmute', HAVE), 'unmute marketing')
})

test('sibling streams are NOT merged — they only share one word', () => {
  // The whole point of the containment rule: "unmute ios" and "unmute
  // marketing" overlap on the product word and neither contains the other.
  assert.equal(canonicalGroup('unmute pricing', HAVE), undefined)
  assert.equal(canonicalGroup('unmute', HAVE), undefined)
})

test('a shorter label does not swallow the streams beneath it', () => {
  // "marketing" alone is contained by "unmute marketing", but folding DOWN to
  // it would let one bare word capture every stream that mentions it.
  assert.equal(canonicalGroup('marketing', HAVE), undefined)
})

test('an unrelated label still creates', () => {
  assert.equal(canonicalGroup('launch video', HAVE), undefined)
})

test('no groups, or an empty label, is the create path', () => {
  assert.equal(canonicalGroup('unmute marketing plan', []), undefined)
  assert.equal(canonicalGroup('', HAVE), undefined)
  assert.equal(canonicalGroup(null, HAVE), undefined)
})
