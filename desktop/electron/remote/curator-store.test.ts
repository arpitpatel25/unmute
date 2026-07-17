import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  curatorPaths, readCursor, writeCursor, readLedger, appendLedger, curatedSkillNames,
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

test('ledger appends and curatedSkillNames reflects created skills', async () => {
  const p = curatorPaths(await tmp())
  await appendLedger(p, { at: 't', skill: 'pr-review', action: 'proposed', proposalId: 'p1' })
  await appendLedger(p, { at: 't', skill: 'pr-review', action: 'created', contentHash: 'h' })
  const l = await readLedger(p)
  assert.equal(l.entries.length, 2)
  assert.ok(curatedSkillNames(l).has('pr-review'))
  assert.ok(!curatedSkillNames({ version: 1, entries: [{ at: 't', skill: 'x', action: 'proposed' }] }).has('x'))
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

import { occurrenceKey, mergeDistill, type CandidatesFile } from './curator-store.ts'

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
