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

import { occurrenceKey, mergeDistill, entryStatus, distinctSessionCount, setCandidateStatus, isSuspicion, type CandidatesFile, type Candidate } from './curator-store.ts'

const candFile = (over: Partial<Candidate> = {}): CandidatesFile => ({
  version: 1,
  candidates: {
    'load-video': { key: 'load-video', title: 'Load video', skeleton: 's', total: 2, struggle: true, firstSeen: 'a', lastSeen: 'b', occurrences: [], ...over },
  },
})

test('setCandidateStatus updates status (+ optional linkedSkillId), is pure, and no-ops on a missing key', () => {
  const before = candFile()
  const after = setCandidateStatus(before, 'load-video', 'surfaced')
  assert.equal(after.candidates['load-video'].status, 'surfaced')
  assert.equal(before.candidates['load-video'].status, undefined)  // pure — original untouched

  const live = setCandidateStatus(before, 'load-video', 'live', { linkedSkillId: 'video-load' })
  assert.equal(live.candidates['load-video'].status, 'live')
  assert.equal(live.candidates['load-video'].linkedSkillId, 'video-load')

  const missing = setCandidateStatus(before, 'not-here', 'rejected')
  assert.deepEqual(missing, before)  // absent key → no-op (returns an equivalent file)
})

test('isSuspicion: true for watched/undefined status, false once graduated/surfaced/live', () => {
  const base: Candidate = { key: 'k', title: 't', skeleton: 's', total: 1, struggle: false, firstSeen: 'a', lastSeen: 'a', occurrences: [] }
  assert.equal(isSuspicion(base), true)                              // undefined status defaults to watched
  assert.equal(isSuspicion({ ...base, status: 'watched' }), true)
  assert.equal(isSuspicion({ ...base, status: 'graduated' }), false)
  assert.equal(isSuspicion({ ...base, status: 'surfaced' }), false)
  assert.equal(isSuspicion({ ...base, status: 'live' }), false)
  assert.equal(isSuspicion({ ...base, status: 'rejected' }), false)
})

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

// --- Task 5: watch-list decay (pruneSuspicions) — spec §0 constraint C ---

import { pruneSuspicions } from './curator-store.ts'

const NOW = Date.parse('2026-07-21T00:00:00Z')
const OLD = new Date(NOW - 40 * 86400_000).toISOString()   // 40 days ago — past the 30-day default window
const RECENT = new Date(NOW - 5 * 86400_000).toISOString() // 5 days ago — well within the window

const occ = (taskId: string, at: string) => ({ taskId, sweepId: `sw-${taskId}`, count: 1, at, tracePointer: `traces/${taskId}` })

const watchedCand = (over: Partial<Candidate> = {}): CandidatesFile => ({
  version: 1,
  candidates: {
    k: { key: 'k', title: 't', skeleton: 's', total: 1, struggle: false, firstSeen: OLD, lastSeen: OLD, occurrences: [occ('t1', OLD)], ...over },
  },
})

test('pruneSuspicions drops an unconfirmed (1 distinct session), stale watched suspicion', () => {
  const file = watchedCand()
  const after = pruneSuspicions(file, NOW)
  assert.deepEqual(after.candidates, {})
})

test('pruneSuspicions keeps a CONFIRMED suspicion (>=2 distinct sessions) even when stale', () => {
  const file = watchedCand({ total: 2, occurrences: [occ('t1', OLD), occ('t2', OLD)] })
  const after = pruneSuspicions(file, NOW)
  assert.ok(after.candidates.k)
})

test('pruneSuspicions keeps a RECENT unconfirmed watched suspicion', () => {
  const file = watchedCand({ firstSeen: RECENT, lastSeen: RECENT, occurrences: [occ('t1', RECENT)] })
  const after = pruneSuspicions(file, NOW)
  assert.ok(after.candidates.k)
})

test('pruneSuspicions keeps stale non-watched entries (live/accepted) regardless of session count', () => {
  const file: CandidatesFile = {
    version: 1,
    candidates: {
      liveOne: { key: 'liveOne', title: 't', skeleton: 's', total: 1, struggle: false, status: 'live', firstSeen: OLD, lastSeen: OLD, occurrences: [occ('t1', OLD)] },
      acceptedOne: { key: 'acceptedOne', title: 't', skeleton: 's', total: 1, struggle: false, status: 'accepted', firstSeen: OLD, lastSeen: OLD, occurrences: [occ('t1', OLD)] },
    },
  }
  const after = pruneSuspicions(file, NOW)
  assert.ok(after.candidates.liveOne)
  assert.ok(after.candidates.acceptedOne)
})

test('pruneSuspicions keeps a stale, unconfirmed entry that carries a linkedSkillId', () => {
  const file = watchedCand({ linkedSkillId: 'some-skill' })
  const after = pruneSuspicions(file, NOW)
  assert.ok(after.candidates.k)
})

test('pruneSuspicions keeps an entry with an unparseable lastSeen (never drop on a parse error)', () => {
  const file = watchedCand({ firstSeen: 'not-a-date', lastSeen: 'not-a-date', occurrences: [occ('t1', 'not-a-date')] })
  const after = pruneSuspicions(file, NOW)
  assert.ok(after.candidates.k)
})

test('pruneSuspicions is pure — does not mutate the input file', () => {
  const before = watchedCand()
  const snapshot = JSON.parse(JSON.stringify(before))
  pruneSuspicions(before, NOW)
  assert.deepEqual(before, snapshot)
})

test('pruneSuspicions respects a custom windowDays', () => {
  const tenDaysAgo = new Date(NOW - 10 * 86400_000).toISOString()
  const file = watchedCand({ firstSeen: tenDaysAgo, lastSeen: tenDaysAgo, occurrences: [occ('t1', tenDaysAgo)] })
  assert.ok(pruneSuspicions(file, NOW).candidates.k)              // default 30-day window keeps it
  assert.deepEqual(pruneSuspicions(file, NOW, 7).candidates, {})  // a 7-day window drops it
})
