import { test } from 'node:test'
import assert from 'node:assert/strict'
import { failsafeDecision, parseDecision, type RoutableTask } from './router.ts'

const ONE: RoutableTask[] = [
  { id: 't1', intent: 'messi stats', state: 'done', ageSec: 30, agent: 'claude' },
]

test('a failsafe decision says it was never routed', () => {
  // A router timeout produces a task with the raw transcript as its title and
  // no group — which looks EXACTLY like naming and grouping having failed. Two
  // separate 60s router timeouts on 2026-08-28 were each read as "the grouping
  // feature is broken", because nothing on the card said otherwise.
  const d = failsafeDecision([], 'so there was this idea')
  assert.equal(d.action, 'new')
  assert.equal(d.unrouted, true)
})

test('the continue-latest failsafe is flagged too — it is still a guess', () => {
  const d = failsafeDecision(ONE, 'and 2015?')
  assert.equal(d.action, 'continue')
  assert.equal(d.unrouted, true)
})

test('a real decision is never flagged', () => {
  const d = parseDecision(
    JSON.stringify({ action: 'new', intent: 'x', name: 'X thing', kind: 'oneoff' }),
    'raw', ONE,
  )
  assert.equal(d.action, 'new')
  assert.equal(d.unrouted, undefined, 'only a failsafe carries the flag')
})

test('a malformed reply that falls through to failsafe is flagged', () => {
  // The router answered, but with nothing usable. From the user's side that is
  // the same event as silence, and the card should say so either way.
  const d = parseDecision('not json at all', 'raw transcript', [])
  assert.equal(d.unrouted, true)
})
