import { test } from 'node:test'
import assert from 'node:assert/strict'
import { selectSessions, isHot, SESSION_INDEX_RETENTION_MS, type IndexedSession } from './index'

const NOW = 1_000_000_000
function session(id: string, agoMs: number, extra: Partial<IndexedSession> = {}): IndexedSession {
  return { id, source: 'unmute', startedAt: NOW - agoMs, updatedAt: NOW - agoMs, turns: 3, ...extra }
}

test('recent sessions come back newest first', () => {
  const all = [session('old', 60_000), session('new', 1_000), session('mid', 30_000)]
  assert.deepEqual(selectSessions(all, { now: NOW }).map((s) => s.id), ['new', 'mid', 'old'])
})

// The 7-day rule is a retention window, not a special mechanism: inside it a
// lookup is an index read, outside it the Agent has to go and read transcripts
// like anything else — slow, and visibly so.
test('sessions past the window are out of the fast path', () => {
  const all = [session('recent', 1_000), session('ancient', SESSION_INDEX_RETENTION_MS + 1)]
  assert.deepEqual(selectSessions(all, { now: NOW }).map((s) => s.id), ['recent'])
})

test('the cold path can still reach them, deliberately', () => {
  const all = [session('recent', 1_000), session('ancient', SESSION_INDEX_RETENTION_MS + 1)]
  assert.equal(selectSessions(all, { now: NOW, includeCold: true }).length, 2)
})

test('isHot answers the same question for one session', () => {
  assert.equal(isHot(session('a', 1_000), NOW), true)
  assert.equal(isHot(session('b', SESSION_INDEX_RETENTION_MS + 1), NOW), false)
})

test('results are bounded even when the caller asks for everything', () => {
  const many = Array.from({ length: 400 }, (_, i) => session(`s${i}`, i))
  assert.equal(selectSessions(many, { now: NOW, limit: 10_000 }).length, 100)
  assert.equal(selectSessions(many, { now: NOW }).length, 20, 'a sensible default, not all of them')
})

// The field that makes widening additive rather than a migration. Only one
// value ever occurs today, and it is still written.
test('every record declares its source, so widening later is a filter change', () => {
  const mixed = [session('ours', 1_000), session('theirs', 2_000, { source: 'external' })]
  assert.deepEqual(selectSessions(mixed, { now: NOW }).map((s) => s.source), ['unmute', 'external'])
})
