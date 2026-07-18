import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Curator, type MaterialSession, makeRunSweep, RateLimitedError, ProposalConversation } from './curator.ts'
import { curatorPaths, readCursor, writeCursor, readCandidates, listPendingProposals, writeProposal, type Proposal } from './curator-store.ts'
import type { AgentExecutor } from './executor'

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'cu-'))
// A transcript delta that clears triage: 16 tool calls over 11 minutes.
const busyLines = () => {
  const lines: string[] = []
  for (let i = 0; i < 16; i++) lines.push(JSON.stringify({ timestamp: new Date(1_000_000 + i * 44_000).toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: {} }] } }))
  return lines.join('\n') + '\n'
}

function make(root: string, over: Partial<ConstructorParameters<typeof Curator>[0]> = {}) {
  const swept: MaterialSession[][] = []
  const sessDir = path.join(root, 'sess')
  const opts = {
    paths: curatorPaths(root),
    sweepIntervalMs: () => 12 * 60 * 60_000,
    listSessions: async () => [{ taskId: 't1', intent: 'work', cwd: sessDir, kind: 'session' as const }],
    isBusy: () => false,
    runSweep: async (m: MaterialSession[]) => { swept.push(m) },
    now: () => Date.now(),
    ...over,
  }
  return { curator: new Curator(opts), swept, sessDir }
}

test('checkNow: no material → no sweep; new checkpointed delta clearing triage → sweep', async () => {
  const root = await tmp()
  const { curator, swept, sessDir } = make(root)
  assert.equal(await curator.checkNow(), false)         // no transcript at all
  // create the transcript where locateTranscript would… simpler: transcriptPath resolution is injectable
  const t = path.join(root, 't1.jsonl')
  await fs.writeFile(t, busyLines())
  const { curator: c2, swept: s2 } = make(root, {
    listSessions: async () => [{ taskId: 't1', intent: 'work', cwd: sessDir, kind: 'session' }],
    locateTranscriptFor: async () => t,
  } as never)
  c2.notifyCheckpoint('t1')
  assert.equal(await c2.checkNow(), true)
  assert.equal(s2.length, 1)
  assert.equal(s2[0][0].taskId, 't1')
  assert.ok(s2[0][0].lines.length >= 16)
})

test('interval gate: a sweep within sweepIntervalMs of the last is refused', async () => {
  const root = await tmp()
  const t = path.join(root, 't1.jsonl'); await fs.writeFile(t, busyLines())
  let nowMs = 1_000_000
  const { curator } = make(root, { locateTranscriptFor: async () => t, now: () => nowMs } as never)
  const p = curatorPaths(root)
  await writeCursor(p, { version: 1, lastSweepAt: nowMs - 60_000, sessions: {} })  // swept a minute ago
  curator.notifyCheckpoint('t1')
  assert.equal(await curator.checkNow(), false)
  nowMs += 13 * 60 * 60_000                                                        // 13h later — due
  assert.equal(await curator.checkNow(), true)
})

test('busy → deferred; single-flight; short/clean delta fails triage → cursor untouched, no sweep', async () => {
  const root = await tmp()
  const t = path.join(root, 't1.jsonl')
  await fs.writeFile(t, JSON.stringify({ message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: {} }] } }) + '\n')
  let busy = true
  const { curator, swept } = make(root, { locateTranscriptFor: async () => t, isBusy: () => busy } as never)
  curator.notifyCheckpoint('t1')
  assert.equal(await curator.checkNow(), false)   // busy
  busy = false
  assert.equal(await curator.checkNow(), false)   // idle but delta fails triage
  assert.equal(swept.length, 0)
  assert.equal((await readCursor(curatorPaths(root))).sessions.t1?.lineOffset ?? 0, 0)  // triage-fail advances nothing
})

test('scheduler resilience: a throwing runSweep is swallowed on scheduler ticks (no unhandledRejection); single-flight released', async () => {
  const root = await tmp()
  const t = path.join(root, 't1.jsonl')
  await fs.writeFile(t, busyLines())
  let sweepAttempts = 0
  let signalSwept!: () => void
  const sweptOnce = new Promise<void>((res) => { signalSwept = res })
  const { curator } = make(root, {
    locateTranscriptFor: async () => t,
    runSweep: async () => { sweepAttempts++; signalSwept(); throw new Error('sweep boom') },  // Task 9's pipeline rejects
  } as never)
  curator.notifyCheckpoint('t1')                 // material gate passes → runSweep will fire

  const flush = () => new Promise((r) => setImmediate(r))

  // 1) Production path: start()'s setImmediate/interval ticks drive checkNow via a
  //    void-discarded promise. A rejecting runSweep must NOT surface as an
  //    unhandledRejection (which, under Node's default, can kill the Electron main).
  const unhandled: unknown[] = []
  const onUnhandled = (e: unknown) => { unhandled.push(e) }
  process.on('unhandledRejection', onUnhandled)
  try {
    curator.start()
    await sweptOnce                              // the immediate tick reached runSweep, which threw
    await flush(); await flush()                 // let the .catch run + any unhandledRejection surface
    assert.equal(sweepAttempts, 1)
    assert.equal(unhandled.length, 0)            // fix: rejection was caught+logged, not left dangling
  } finally {
    curator.stop()
    process.removeListener('unhandledRejection', onUnhandled)
  }

  // 2) The scheduler wraps checkNow in a swallowing .catch (as start() does); that
  //    wrapped tick resolves even though checkNow itself rejects when runSweep throws.
  await assert.doesNotReject(curator.checkNow().catch(() => {}))

  // 3) Single-flight was released via finally (even on the rejecting path): a
  //    subsequent check re-enters and runs the sweep again (it still throws).
  const before = sweepAttempts
  await assert.rejects(() => curator.checkNow())
  assert.equal(sweepAttempts, before + 1)
})

// ── Task 9: the real sweep pipeline ──────────────────────────────────────────

function fakeExecutor(behavior: (prompt: string) => Promise<void>, emit?: (cb: (c: string) => void) => void): AgentExecutor {
  let dataCb: (c: string) => void = () => {}
  return {
    alive: true,
    spawn: async () => { if (emit) emit((c) => dataCb(c)) },
    isReady: async () => {},
    writeStdin: (text: string) => { void behavior(text) },
    write: () => {}, resize: () => {}, onData: (cb) => { dataCb = cb }, kill: () => {},
  } as unknown as AgentExecutor
}

const distillJson = { procedures: [{ title: 'Load video Premiere', skeleton: 'S', count: 2, struggle: true }] }
const synthJson = { proposals: [{ kind: 'create', draft: { name: 'video-load-premiere', description: 'd', body: 'Goal…' }, evidence: { occurrences: 2, sessions: [], firstSeen: 'a', lastSeen: 'b', struggle: { errors: 1, recoveries: 1, wallClockMin: 30 } }, rationale: 'seen twice with struggle' }] }

test('runSweep: distills, accumulates, synthesizes, writes proposal, advances cursor', async () => {
  const root = await tmp()
  const p = curatorPaths(root)
  const writes = async (prompt: string) => {
    const m = prompt.match(/(\/\S+?(?:distill|synth)\.json)/)
    if (!m) return
    const payload = m[1].endsWith('distill.json') ? distillJson : synthJson
    await fs.mkdir(path.dirname(m[1]), { recursive: true })
    await fs.writeFile(m[1] + '.tmp', JSON.stringify(payload)); await fs.rename(m[1] + '.tmp', m[1])
  }
  const run = makeRunSweep({ executorFactory: () => fakeExecutor(writes), paths: p, curatedIndex: async () => [], sessionTimeoutMs: 5_000, pollMs: 20 })
  await run([{ taskId: 't1', intent: 'video work', transcriptPath: path.join(root, 't1.jsonl'), fromLine: 0, lines: [JSON.stringify({ message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: {} }] } })], lookback: [], newOffset: 1 }])
  const cands = await readCandidates(p)
  assert.equal(Object.values(cands.candidates)[0]?.total, 2)
  const pending = await listPendingProposals(p)
  assert.equal(pending.length, 1)
  assert.equal(pending[0].draft.name, 'video-load-premiere')
  const cursor = await readCursor(p)
  assert.equal(cursor.sessions.t1.lineOffset, 1)                       // advanced on success
})

test('runSweep: rate-limit aborts — cursor NOT advanced, no proposals', async () => {
  const root = await tmp()
  const p = curatorPaths(root)
  const run = makeRunSweep({
    executorFactory: () => fakeExecutor(async () => {}, (cb) => setTimeout(() => cb('You have reached your usage limit'), 30)),
    paths: p, curatedIndex: async () => [], sessionTimeoutMs: 3_000, pollMs: 20,
  })
  await assert.rejects(
    run([{ taskId: 't1', intent: 'x', transcriptPath: '/nope', fromLine: 0, lines: ['{}'], lookback: [], newOffset: 1 }]),
    RateLimitedError,
  )
  assert.equal((await readCursor(p)).sessions.t1?.lineOffset ?? 0, 0)  // untouched
  assert.equal((await listPendingProposals(p)).length, 0)
})

// ── Task 10: the review popup's conversation backend ─────────────────────────

const prop = (id: string): Proposal => ({
  id, sweepId: 'sw_1', proposedAt: new Date().toISOString(), kind: 'create',
  draft: { name: id, description: 'd', body: 'body' },
  evidence: { occurrences: 2, sessions: [], firstSeen: 'a', lastSeen: 'b', struggle: { errors: 1, recoveries: 1, wallClockMin: 5 } },
  rationale: 'seen twice with struggle', resolution: null,
})

test('ProposalConversation: spawns in the proposal dir, primes with draft, streams, forwards keys', async () => {
  const root = await tmp(); const p = curatorPaths(root)
  await writeProposal(p, prop('prop_c'))
  await fs.writeFile(path.join(p.proposalsDir, 'prop_c', 'draft.md'), 'body v1')
  const chunks: string[] = []; const typed: string[] = []; const raw: string[] = []
  let emit: (c: string) => void = () => {}
  const ex = {
    alive: true, spawn: async (o: { cwd: string }) => { assert.ok(o.cwd.endsWith('prop_c')) },
    isReady: async () => {}, writeStdin: (t: string) => typed.push(t), write: (d: string) => raw.push(d),
    resize: () => {}, onData: (cb: (c: string) => void) => { emit = cb }, kill: () => {},
  } as unknown as AgentExecutor
  const conv = new ProposalConversation({ executorFactory: () => ex, paths: p, proposalId: 'prop_c', onData: (c) => chunks.push(c), readyGraceMs: 0 })
  assert.equal(await conv.start(), true)
  emit('hello')
  assert.deepEqual(chunks, ['hello'])
  assert.ok(typed.join('\n').includes('draft.md'))        // primer points the session at the draft file + evidence
  conv.write('why?')
  assert.deepEqual(raw.filter((r) => r === 'why?'), ['why?'])
})
