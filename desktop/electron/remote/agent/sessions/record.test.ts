import assert from 'node:assert/strict'
import test from 'node:test'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { defaultRecordPath, renderRecord, renderSession, writeRecord } from './record'
import type { StoredSession } from './store'

const NOW = Date.parse('2026-08-26T12:00:00Z')

const session = (over: Partial<StoredSession> = {}): StoredSession => ({
  key: 'sess-1',
  path: '/Users/me/.claude/projects/-Users-me-repo/a.jsonl',
  harness: 'claude',
  sessionId: 'sess-1',
  cwd: '/Users/me/unmute-cloud',
  project: 'unmute-cloud',
  lastTouchedAt: NOW - 3_600_000,
  cursor: 40,
  userTurns: 6,
  summary: {
    about: 'Editing the Q3 promo video',
    done: ['cut the 4-second intro', 're-exported at 4K'],
    standing: 'awaiting review',
    touched: ['promo.mp4'],
  },
  partial: false,
  updatedAt: NOW,
  ...over,
})

test('a session block carries what someone would search by', () => {
  const block = renderSession(session())
  assert.match(block, /Editing the Q3 promo video/)
  assert.match(block, /id: sess-1/)
  assert.match(block, /where: unmute-cloud · claude/)
  assert.match(block, /standing: awaiting review/)
  assert.match(block, /- cut the 4-second intro/)
  assert.match(block, /touched: promo\.mp4/)
  assert.match(block, /transcript: .*a\.jsonl/)
})

/** A summary that has not caught up must not be trusted as complete. */
test('a partial summary says so, and points at the transcript', () => {
  assert.match(renderSession(session({ partial: true })), /summary is partial/)
  assert.doesNotMatch(renderSession(session()), /partial/)
})

test('a session with no summary yet still identifies itself', () => {
  const bare = session({
    summary: { about: '', done: [], standing: '', touched: [] },
    opening: 'cut the intro off the promo video',
  })
  assert.match(renderSession(bare), /cut the intro off the promo video/)
})

test('an Unmute scratch session shows its task, never a bare uuid as a project', () => {
  const scratch = session({
    project: undefined,
    unmuteTaskId: '3dc48045-b226-463e-a5bd-33c480dc7844',
  })
  assert.match(renderSession(scratch), /where: unmute task 3dc48045 · claude/)
})

test('days are grouped, and the two that matter are named', () => {
  const record = renderRecord([
    session({ key: 'a', sessionId: 'a', lastTouchedAt: NOW - 3_600_000 }),
    session({ key: 'b', sessionId: 'b', lastTouchedAt: NOW - 26 * 3_600_000 }),
    session({ key: 'c', sessionId: 'c', lastTouchedAt: NOW - 3 * 86_400_000 }),
  ], { now: NOW })
  assert.match(record, /## 2026-08-26 — today/)
  assert.match(record, /## 2026-08-25 — yesterday/)
  assert.match(record, /## 2026-08-23\n/)
  assert.ok(record.indexOf('id: a') < record.indexOf('id: b'), 'newest first')
})

test('the window filters the record, and says how far it reaches', () => {
  const record = renderRecord([
    session({ key: 'recent', sessionId: 'recent', lastTouchedAt: NOW - 86_400_000 }),
    session({ key: 'ancient', sessionId: 'ancient', lastTouchedAt: NOW - 40 * 86_400_000 }),
  ], { now: NOW, windowMs: 5 * 86_400_000 })
  assert.match(record, /id: recent/)
  assert.doesNotMatch(record, /id: ancient/)
  assert.match(record, /Covering 5 days/)
})

/**
 * An empty record must not read as "you have never worked on anything" — the
 * same honesty rule memory_list carries, one surface over.
 */
test('an empty window is stated as empty, not as nothing existing', () => {
  const record = renderRecord([], { now: NOW })
  assert.match(record, /Nothing in this window/)
  assert.match(record, /Older work is not here and is not gone/)
})

test('the header says machine sessions are deliberately absent', () => {
  const record = renderRecord([session()], { now: NOW })
  assert.match(record, /subagent forks, plan/)
  assert.match(record, /deliberately absent/)
})

test('writing is atomic and lands where the constitution says', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'agent-record-'))
  try {
    const path = defaultRecordPath(dir)
    assert.match(path, /sessions\/recent-sessions\.md$/)
    await writeRecord(path, [session()], { now: NOW })
    const body = await fs.readFile(path, 'utf8')
    assert.match(body, /Editing the Q3 promo video/)
    const leftovers = await fs.readdir(join(dir, 'sessions'))
    assert.deepEqual(leftovers, ['recent-sessions.md'], 'no staging file left behind')
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})
