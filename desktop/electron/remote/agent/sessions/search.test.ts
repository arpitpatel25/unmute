import assert from 'node:assert/strict'
import test from 'node:test'

import { searchSessions, terms, recencyScore } from './search'
import type { SessionRecord } from './scan'

const NOW = 1_800_000_000_000
const DAY = 86_400_000

let seq = 0
function record(over: Partial<SessionRecord> = {}): SessionRecord {
  seq += 1
  return {
    path: `/p/${seq}.jsonl`,
    harness: 'claude',
    lastTouchedAt: NOW - DAY,
    sizeBytes: 1024,
    turnsSeen: 2,
    sessionId: `s-${seq}`,
    opening: 'Audit the billing migrations',
    project: 'unmute-cloud',
    ...over,
  }
}

test('the words a person would not say are dropped', () => {
  assert.deepEqual(terms('that thing I was working on about the pricing doc'), ['pricing', 'doc'])
  assert.deepEqual(terms('a an the'), [])
})

test('recency is full for a day and gone by a fortnight', () => {
  assert.equal(recencyScore(NOW, NOW), 1)
  assert.equal(recencyScore(NOW - 20 * DAY, NOW), 0)
  const week = recencyScore(NOW - 7 * DAY, NOW)
  assert.ok(week > 0 && week < 1)
})

test('a session is found by what the person opened it with', () => {
  const wanted = record({ opening: 'Draft the pricing sheet for Q3' })
  const results = searchSessions([record(), wanted, record()], { text: 'pricing sheet' }, NOW)
  assert.equal(results[0]!.record.sessionId, wanted.sessionId)
  assert.equal(results[0]!.matched, 'opening')
})

test('it is also found by how it ended', () => {
  const wanted = record({ opening: 'unrelated', closing: 'Created the rollback runbook.' })
  const results = searchSessions([record(), wanted], { text: 'rollback runbook' }, NOW)
  assert.equal(results[0]!.record.sessionId, wanted.sessionId)
  assert.equal(results[0]!.matched, 'closing')
})

/**
 * "A day or two back" is half the question. A stale session that matches one
 * more word must not beat this morning's.
 */
test('this morning beats last month on an equal-ish match', () => {
  const fresh = record({ lastTouchedAt: NOW - 3_600_000, opening: 'the pricing doc' })
  const stale = record({ lastTouchedAt: NOW - 40 * DAY, opening: 'the pricing doc again' })
  const results = searchSessions([stale, fresh], { text: 'pricing doc' }, NOW)
  assert.equal(results[0]!.record.sessionId, fresh.sessionId)
})

test('a query with no usable words returns the recent tier, not nothing', () => {
  const results = searchSessions(
    [record({ lastTouchedAt: NOW - DAY }), record({ lastTouchedAt: NOW - 2 * DAY })],
    { text: 'the thing I was working on' },
    NOW,
  )
  assert.equal(results.length, 2)
  assert.equal(results[0]!.matched, 'recency')
})

test('a match on nothing at all is omitted rather than ranked low', () => {
  const results = searchSessions([record({ opening: 'billing', closing: 'done', project: 'x' })], { text: 'kubernetes' }, NOW)
  assert.deepEqual(results, [])
})

test('forks and workers stay out unless asked for', () => {
  const fork = record({ derived: true, opening: 'pricing fork' })
  assert.equal(searchSessions([fork], { text: 'pricing' }, NOW).length, 0)
  assert.equal(searchSessions([fork], { text: 'pricing', includeDerived: true }, NOW).length, 1)
})

test('a harness can be named', () => {
  const codex = record({ harness: 'codex', opening: 'pricing in codex' })
  const claude = record({ harness: 'claude', opening: 'pricing in claude' })
  const results = searchSessions([codex, claude], { text: 'pricing', harness: 'codex' }, NOW)
  assert.equal(results.length, 1)
  assert.equal(results[0]!.record.harness, 'codex')
})

test('the limit is bounded at both ends', () => {
  const many = Array.from({ length: 80 }, () => record({ opening: 'pricing' }))
  assert.equal(searchSessions(many, { text: 'pricing', limit: 999 }, NOW).length, 50)
  assert.equal(searchSessions(many, { text: 'pricing', limit: 0 }, NOW).length, 1)
})
