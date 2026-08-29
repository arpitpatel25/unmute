import { test } from 'node:test'
import assert from 'node:assert/strict'
import { provisionalName } from './provisional-name.ts'

test('leads with the subject, not the action', () => {
  // The real namer is held to this; the placeholder standing in for it should
  // not read differently for the few seconds it is up.
  assert.equal(provisionalName('Help me plan out Reddit marketing for Unmute'), 'Reddit marketing for Unmute')
  assert.equal(provisionalName('fix the notch freeze on wake'), 'Notch freeze on wake')
})

test('drops spoken preamble', () => {
  assert.equal(provisionalName('hey so can you look at the pricing page'), 'Pricing page')
  assert.equal(provisionalName("okay let's draft a few LinkedIn posts"), 'Few LinkedIn posts')
})

test('keeps it to a title length', () => {
  const n = provisionalName('plan a small Twitter marketing approach for Unmute posting about what I use it for daily')
  assert.ok(n.split(' ').length <= 4, n)
  assert.ok(n.length <= 60)
})

test('never returns an empty or punctuation-only title', () => {
  assert.equal(provisionalName(''), 'New task')
  assert.equal(provisionalName('   ...  '), 'New task')
  assert.equal(provisionalName('please'), 'New task')
})

test('leaves an already subject-led utterance alone', () => {
  assert.equal(provisionalName('Unmute pricing model'), 'Unmute pricing model')
})
