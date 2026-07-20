import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  curatorPaths, readCursor, writeCursor, readOwnership, recordOwnership, ownedSkillNames, markUserModified,
  writeProposal, readProposal, listPendingProposals, resolveProposal,
  appendFeedback, readFeedback, markFeedbackConsumed, readTranscriptDelta,
  type Proposal,
} from './curator-store.ts'

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'cur-'))

const prop = (id: string, over: Partial<Proposal> = {}): Proposal => ({
  id, sweepId: 'sweep_1', proposedAt: '2026-07-17T00:00:00Z', kind: 'create',
  draft: { name: 'pr-review', description: 'd', body: 'b' },
  evidence: { occurrences: 2, sessions: [], firstSeen: '', lastSeen: '', struggle: { errors: 0, recoveries: 0, wallClockMin: 0 } },
  rationale: 'r', resolution: null, ...over,
})

test('cursor round-trips and defaults to empty', async () => {
  const p = curatorPaths(await tmp())
  const empty = await readCursor(p)
  assert.equal(empty.lastSweepAt, 0)
  assert.deepEqual(empty.sessions, {})
  await writeCursor(p, { version: 1, lastSweepAt: 5, sessions: { t1: { transcriptPath: '/x', lineOffset: 10, lastSweptAt: 5, sweeps: 1 } } })
  const back = await readCursor(p)
  assert.equal(back.sessions.t1.lineOffset, 10)
})

test('ownership defaults empty; recordOwnership creates then updates; ownedSkillNames reflects keys', async () => {
  const p = curatorPaths(await tmp())
  const empty = await readOwnership(p)
  assert.equal(empty.version, 1)
  assert.deepEqual(empty.skills, {})
  assert.equal(ownedSkillNames(empty).size, 0)

  // Create: createdAt = updatedAt = at, contentHash set, userModified cleared.
  await recordOwnership(p, 'pr-review', 'h1', '2026-07-17T00:00:00Z')
  const after1 = await readOwnership(p)
  assert.deepEqual([...ownedSkillNames(after1)], ['pr-review'])
  assert.equal(after1.skills['pr-review'].origin, 'unmute')
  assert.equal(after1.skills['pr-review'].createdAt, '2026-07-17T00:00:00Z')
  assert.equal(after1.skills['pr-review'].updatedAt, '2026-07-17T00:00:00Z')
  assert.equal(after1.skills['pr-review'].contentHash, 'h1')
  assert.equal(after1.skills['pr-review'].userModified, false)

  // Update: createdAt stable, updatedAt advances, contentHash changes, userModified cleared.
  await recordOwnership(p, 'pr-review', 'h2', '2026-07-18T00:00:00Z')
  const after2 = await readOwnership(p)
  assert.equal(after2.skills['pr-review'].createdAt, '2026-07-17T00:00:00Z')  // stable
  assert.equal(after2.skills['pr-review'].updatedAt, '2026-07-18T00:00:00Z')  // advanced
  assert.equal(after2.skills['pr-review'].contentHash, 'h2')
  assert.equal(after2.skills['pr-review'].userModified, false)
})

test('markUserModified sets the flag, adopts the hash, and is idempotent at the same hash', async () => {
  const p = curatorPaths(await tmp())
  await recordOwnership(p, 'pr-review', 'h1', '2026-07-17T00:00:00Z')

  // First flag: hash differs → mutates, returns true, adopts hash + sets flag.
  assert.equal(await markUserModified(p, 'pr-review', 'edited'), true)
  const flagged = await readOwnership(p)
  assert.equal(flagged.skills['pr-review'].contentHash, 'edited')
  assert.equal(flagged.skills['pr-review'].userModified, true)

  // Idempotent: same on-disk hash → no-op, returns false.
  assert.equal(await markUserModified(p, 'pr-review', 'edited'), false)

  // Unowned name → no-op, returns false.
  assert.equal(await markUserModified(p, 'not-ours', 'x'), false)

  // A fresh curator write supersedes the hand-edit flag.
  await recordOwnership(p, 'pr-review', 'h3', '2026-07-19T00:00:00Z')
  assert.equal((await readOwnership(p)).skills['pr-review'].userModified, false)
})

test('proposal lifecycle: write → list pending → resolve → no longer pending', async () => {
  const p = curatorPaths(await tmp())
  await writeProposal(p, prop('prop_a'))
  await writeProposal(p, prop('prop_b'))
  assert.equal((await listPendingProposals(p)).length, 2)
  await resolveProposal(p, 'prop_a', { action: 'rejected', at: 't', userEdited: false, reason: 'too niche' })
  const pending = await listPendingProposals(p)
  assert.equal(pending.length, 1)
  assert.equal(pending[0].id, 'prop_b')
  assert.equal((await readProposal(p, 'prop_a'))?.resolution?.reason, 'too niche')
})

test('readProposal back-compat: a persisted kind:"update" proposal loads as "narrow"', async () => {
  const p = curatorPaths(await tmp())
  // Write a legacy-shaped proposal directly (bypassing writeProposal's typed
  // signature, since 'update' is no longer part of the Proposal.kind union) —
  // this simulates a proposal persisted to disk before the kind rename.
  const legacy = { ...prop('prop_legacy'), kind: 'update' as unknown as Proposal['kind'] }
  await writeProposal(p, legacy)
  const back = await readProposal(p, 'prop_legacy')
  assert.equal(back?.kind, 'narrow')
})

test('feedback appends and is marked consumed by sweep', async () => {
  const p = curatorPaths(await tmp())
  await appendFeedback(p, { at: 't', skill: 'pr-review', note: 'misses lockfiles' })
  await markFeedbackConsumed(p, 'sweep_9')
  const f = await readFeedback(p)
  assert.equal(f[0].consumedBySweep, 'sweep_9')
})

test('readTranscriptDelta returns lines from offset with lookback and new offset', async () => {
  const dir = await tmp()
  const t = path.join(dir, 'x.jsonl')
  await fs.writeFile(t, ['{"n":1}', '{"n":2}', '{"n":3}', '{"n":4}'].join('\n') + '\n')
  const d = await readTranscriptDelta(t, 2, 1)
  assert.deepEqual(d.lines, ['{"n":3}', '{"n":4}'])
  assert.deepEqual(d.lookback, ['{"n":2}'])
  assert.equal(d.newOffset, 4)
  const none = await readTranscriptDelta(t, 4, 1)
  assert.deepEqual(none.lines, [])
  assert.equal(none.newOffset, 4)
})

// --- Task 4: occurrence accumulator ---

import { occurrenceKey, mergeDistill, entryStatus, distinctSessionCount, type CandidatesFile, type Candidate } from './curator-store.ts'

test('occurrenceKey normalizes stably', () => {
  assert.equal(occurrenceKey('Load video → Premiere via MCP!'), 'load-video-premiere-via-mcp')
  assert.equal(occurrenceKey('load VIDEO premiere via mcp'), 'load-video-premiere-via-mcp')
})

test('mergeDistill accumulates across sweeps and sessions, idempotent per (key,task,sweep)', () => {
  const empty: CandidatesFile = { version: 1, candidates: {} }
  const proc = { title: 'Load video Premiere via MCP', skeleton: 's', count: 2, struggle: true }
  const a = mergeDistill(empty, [proc], { taskId: 't1', sweepId: 'sw1', at: '2026-07-14', tracePointer: 'traces/a' })
  const b = mergeDistill(a, [proc], { taskId: 't2', sweepId: 'sw2', at: '2026-07-17', tracePointer: 'traces/b' })
  const c = mergeDistill(b, [proc], { taskId: 't2', sweepId: 'sw2', at: '2026-07-17', tracePointer: 'traces/b' }) // retry — no-op
  const cand = c.candidates[occurrenceKey(proc.title)]
  assert.equal(cand.total, 4)                       // 2 + 2, retry ignored
  assert.equal(cand.occurrences.length, 2)
  assert.equal(cand.firstSeen, '2026-07-14')
  assert.equal(cand.lastSeen, '2026-07-17')
  assert.equal(cand.struggle, true)
})

// --- Task 1: ledger entry enrichment (status/variance/divergence) — backward-compatible ---

// --- Task 2: rolling trace retention ---

import { pruneTraces } from './curator-store.ts'

test('pruneTraces deletes trace files older than keepDays and keeps recent ones', async () => {
  const p = curatorPaths(await tmp())
  await fs.mkdir(p.tracesDir, { recursive: true })
  const oldFile = path.join(p.tracesDir, 'task1-sweep1.txt')
  const recentFile = path.join(p.tracesDir, 'task2-sweep2.txt')
  await fs.writeFile(oldFile, 'old trace')
  await fs.writeFile(recentFile, 'recent trace')

  const now = Date.now()
  const oldMtime = new Date(now - 20 * 86400_000) // 20 days ago — older than the 14-day default
  const recentMtime = new Date(now - 1 * 86400_000) // 1 day ago — well within the window
  await fs.utimes(oldFile, oldMtime, oldMtime)
  await fs.utimes(recentFile, recentMtime, recentMtime)

  const pruned = await pruneTraces(p, now)
  assert.deepEqual(pruned, ['task1-sweep1.txt'])

  const remaining = await fs.readdir(p.tracesDir)
  assert.deepEqual(remaining, ['task2-sweep2.txt'])
})

test('pruneTraces respects a custom keepDays and returns [] when tracesDir is missing', async () => {
  const p = curatorPaths(await tmp())
  // No tracesDir created at all — best-effort, must not throw.
  const pruned = await pruneTraces(p, Date.now())
  assert.deepEqual(pruned, [])

  await fs.mkdir(p.tracesDir, { recursive: true })
  const f = path.join(p.tracesDir, 'task3-sweep3.txt')
  await fs.writeFile(f, 'x')
  const now = Date.now()
  const twoDaysAgo = new Date(now - 2 * 86400_000)
  await fs.utimes(f, twoDaysAgo, twoDaysAgo)

  // With keepDays=1, a 2-day-old file should be pruned.
  const pruned2 = await pruneTraces(p, now, 1)
  assert.deepEqual(pruned2, ['task3-sweep3.txt'])
})

test('legacy Candidate (no new fields) loads and defaults via pure accessors', () => {
  const legacy: Candidate = {
    key: 'load-video-premiere-via-mcp',
    title: 'Load video Premiere via MCP',
    skeleton: 's',
    total: 4,
    struggle: true,
    firstSeen: '2026-07-14',
    lastSeen: '2026-07-17',
    occurrences: [
      { taskId: 't1', sweepId: 'sw1', count: 2, at: '2026-07-14', tracePointer: 'traces/a' },
      { taskId: 't2', sweepId: 'sw2', count: 2, at: '2026-07-17', tracePointer: 'traces/b' },
      { taskId: 't2', sweepId: 'sw3', count: 1, at: '2026-07-18', tracePointer: 'traces/c' }, // same taskId, different sweep
    ],
  }
  assert.equal(entryStatus(legacy), 'watched')
  assert.equal(distinctSessionCount(legacy), 2) // distinct taskIds: t1, t2
  assert.deepEqual(legacy.divergenceLog ?? [], [])
})
