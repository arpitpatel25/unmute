import assert from 'node:assert/strict'
import test from 'node:test'

import { digestEntries, digestSection, relativeAge, DIGEST_EXCERPT } from './digest'
import type { SessionRecord } from './scan'

const NOW = 1_800_000_000_000

function record(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    path: `/p/${Math.random()}.jsonl`,
    harness: 'claude',
    lastTouchedAt: NOW - 60_000,
    sizeBytes: 1024,
    turnsSeen: 2,
    sessionId: `s-${Math.random()}`,
    opening: 'Audit the billing migrations',
    project: 'unmute-cloud',
    ...over,
  }
}

test('ages read the way a person says them', () => {
  assert.equal(relativeAge(NOW, NOW), 'just now')
  assert.equal(relativeAge(NOW - 5 * 60_000, NOW), '5m ago')
  assert.equal(relativeAge(NOW - 3 * 3_600_000, NOW), '3h ago')
  assert.equal(relativeAge(NOW - 50 * 3_600_000, NOW), '2d ago')
})

test('derived sessions and openingless ones never reach the digest', () => {
  const entries = digestEntries([
    record({ opening: 'real work' }),
    record({ derived: true, opening: 'a fork' }),
    record({ opening: undefined }),
  ], NOW)
  assert.equal(entries.length, 1)
  assert.equal(entries[0]!.opening, 'real work')
})

/** A resume writes a second transcript for one conversation. */
test('one session does not spend two digest lines', () => {
  const entries = digestEntries([
    record({ unmuteTaskId: 'task-1', lastTouchedAt: NOW - 10_000, opening: 'newer' }),
    record({ unmuteTaskId: 'task-1', lastTouchedAt: NOW - 90_000, opening: 'older' }),
  ], NOW)
  assert.equal(entries.length, 1)
  assert.equal(entries[0]!.opening, 'newer')
})

/**
 * `sessions_list` reported a uuid as the project for every Unmute session.
 * The task's own name is what the person actually calls it.
 */
test('an Unmute session is named by its task, never by its uuid', () => {
  const [entry] = digestEntries(
    [record({ unmuteTaskId: 'abc', project: undefined })],
    NOW,
    () => ({ name: 'Notetaker speaker attribution' }),
  )
  assert.equal(entry!.where, 'Notetaker speaker attribution')
})

test('an unknown task degrades to a phrase, not a uuid', () => {
  const [entry] = digestEntries([record({ unmuteTaskId: 'abc', project: undefined })], NOW, () => undefined)
  assert.equal(entry!.where, 'an Unmute session')
  assert.doesNotMatch(entry!.where, /abc/)
})

test('the digest is bounded, newest first', () => {
  const many = Array.from({ length: 60 }, (_, i) => record({
    lastTouchedAt: NOW - i * 60_000, opening: `session ${i}`,
  }))
  const entries = digestEntries(many, NOW, undefined, 25)
  assert.equal(entries.length, 25)
  assert.equal(entries[0]!.opening, 'session 0')
})

test('openings are trimmed so one session cannot eat the turn', () => {
  const [entry] = digestEntries([record({ opening: 'x'.repeat(500) })], NOW)
  assert.equal([...entry!.opening].length, DIGEST_EXCERPT)
})

test('nothing to say produces nothing at all', () => {
  assert.equal(digestSection([], NOW), '')
  assert.equal(digestSection([record({ derived: true })], NOW), '')
})

/**
 * A search that matched nothing means those words did not match. The digest
 * has to say so itself, because it is the surface that looks exhaustive.
 */
test('the digest says it is partial and names the way out', () => {
  const section = digestSection([record()], NOW)
  assert.match(section, /sessions_search/)
  assert.match(section, /session_resume/)
  assert.match(section, /rather than concluding something does not exist/)
})
