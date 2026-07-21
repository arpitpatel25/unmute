import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Curator, type MaterialSession, makeRunSweep, RateLimitedError, ProposalConversation } from './curator.ts'
import { curatorPaths, readCursor, writeCursor, readCandidates, writeCandidates, listPendingProposals, writeProposal, appendRejection, recordOwnership, type CandidatesFile, type Proposal } from './curator-store.ts'
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

// ── Bugfix: transcripts keyed by CONVERSATION id, not folder-newest ──────────

test('curator: two sessions sharing a cwd but with DISTINCT sessionIds resolve to DISTINCT transcripts and keep SEPARATE cursors (no collapse)', async () => {
  const root = await tmp()
  const sessDir = path.join(root, 'sess')
  const fA = path.join(root, 'A.jsonl'); await fs.writeFile(fA, busyLines())
  const fB = path.join(root, 'B.jsonl'); await fs.writeFile(fB, busyLines())
  const captured: MaterialSession[][] = []
  const curator = new Curator({
    paths: curatorPaths(root),
    sweepIntervalMs: () => 12 * 60 * 60_000,
    listSessions: async () => [
      { taskId: 't1', intent: 'a', cwd: sessDir, kind: 'session', sessionId: 'sA' },
      { taskId: 't2', intent: 'b', cwd: sessDir, kind: 'session', sessionId: 'sB' },
    ],
    isBusy: () => false,
    runSweep: async (m: MaterialSession[]) => { captured.push(m) },
    // Resolve per CONVERSATION — each session id maps to its own file, never the
    // "newest .jsonl in the folder" both would collapse onto.
    locateTranscriptFor: async (s) => (s.sessionId === 'sA' ? fA : fB),
  })
  // Pre-seed sB's cursor PAST all its lines. If cursors were keyed by taskId (or
  // by folder), this couldn't suppress sB — but keyed by the SESSION id, sB has
  // no new delta and is skipped, proving per-conversation cursor reads.
  await writeCursor(curatorPaths(root), { version: 1, lastSweepAt: 0, sessions: { sB: { transcriptPath: fB, lineOffset: 999, lastSweptAt: 0, sweeps: 1 } } })
  curator.notifyCheckpoint('t1'); curator.notifyCheckpoint('t2')
  assert.equal(await curator.checkNow(), true)
  const material = captured[0]
  assert.equal(material.length, 1)                 // sA admitted; sB suppressed by ITS OWN cursor
  assert.equal(material[0].taskId, 't1')
  assert.equal(material[0].transcriptPath, fA)     // sA's own transcript, not a shared "newest"
  assert.equal(material[0].convKey, 'sA')
})

test('curator: a RESUMED conversation (same sessionId, transcript grew) reads only the GROWN delta from its existing cursor — not from offset 0', async () => {
  const root = await tmp()
  const sessDir = path.join(root, 'sess')
  const f = path.join(root, 'sA.jsonl')
  await fs.writeFile(f, busyLines() + busyLines())   // 32 lines: 16 already swept + 16 new
  // Prior sweep left the conversation cursor at line 16 (keyed by session id).
  await writeCursor(curatorPaths(root), { version: 1, lastSweepAt: 0, sessions: { sA: { transcriptPath: f, lineOffset: 16, lastSweptAt: 0, sweeps: 1 } } })
  const captured: MaterialSession[][] = []
  const curator = new Curator({
    paths: curatorPaths(root),
    sweepIntervalMs: () => 12 * 60 * 60_000,
    listSessions: async () => [{ taskId: 't1', intent: 'a', cwd: sessDir, kind: 'session', sessionId: 'sA' }],
    isBusy: () => false,
    runSweep: async (m: MaterialSession[]) => { captured.push(m) },
    locateTranscriptFor: async () => f,
  })
  curator.notifyCheckpoint('t1')
  assert.equal(await curator.checkNow(), true)
  const m = captured[0][0]
  assert.equal(m.convKey, 'sA')
  assert.equal(m.fromLine, 16)          // resumed from the prior cursor, NOT re-reading from 0
  assert.equal(m.lines.length, 16)      // only the delta (the 16 new lines)
  assert.equal(m.newOffset, 32)
})

test('runSweep: cursors advance keyed by convKey (the pinned session id), so two sessions sharing a cwd advance SEPARATE cursors', async () => {
  const root = await tmp(); const p = curatorPaths(root)
  const writes = async (prompt: string) => {
    const m = prompt.match(/(\/\S+?(?:distill|match|synth)\.json)/)
    if (!m) return
    const payload = m[1].endsWith('distill.json') ? distillJson : m[1].endsWith('match.json') ? { matches: [] } : { proposals: [] }
    await fs.mkdir(path.dirname(m[1]), { recursive: true })
    await fs.writeFile(m[1] + '.tmp', JSON.stringify(payload)); await fs.rename(m[1] + '.tmp', m[1])
  }
  const line = JSON.stringify({ message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: {} }] } })
  const run = makeRunSweep({ executorFactory: () => fakeExecutor(writes), paths: p, curatedIndex: async () => [], sessionTimeoutMs: 5_000, pollMs: 20 })
  await run([
    { taskId: 't1', intent: 'x', convKey: 'sA', transcriptPath: path.join(root, 't1.jsonl'), fromLine: 0, lines: [line], lookback: [], newOffset: 5 },
    { taskId: 't2', intent: 'y', convKey: 'sB', transcriptPath: path.join(root, 't2.jsonl'), fromLine: 0, lines: [line], lookback: [], newOffset: 7 },
  ])
  const cursor = await readCursor(p)
  assert.equal(cursor.sessions.sA?.lineOffset, 5)   // keyed by conversation id…
  assert.equal(cursor.sessions.sB?.lineOffset, 7)   // …two separate cursors, no collapse
  assert.equal(cursor.sessions.t1, undefined)       // NOT keyed by taskId
  assert.equal(cursor.sessions.t2, undefined)
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

// User-side finding shape (Task 2): intent → title 'Load video Premiere'
// (occurrenceKey 'load-video-premiere'); a correction keeps struggle:true; count 2.
const distillJson = { findings: [{ intent: 'Load video Premiere', contextSupplied: ['open the Premiere project first'], correction: 'no, use the CLI', bodySketch: 'S', count: 2 }] }
const synthJson = { proposals: [{ kind: 'create', draft: { name: 'video-load-premiere', description: 'd', body: 'Goal…' }, evidence: { occurrences: 2, sessions: [], firstSeen: 'a', lastSeen: 'b', struggle: { errors: 1, recoveries: 1, wallClockMin: 30 } }, rationale: 'seen twice with struggle' }] }

test('runSweep: distills, accumulates, synthesizes, writes proposal, advances cursor', async () => {
  const root = await tmp()
  const p = curatorPaths(root)
  const writes = async (prompt: string) => {
    const m = prompt.match(/(\/\S+?(?:distill|match|synth)\.json)/)
    if (!m) return
    const payload = m[1].endsWith('distill.json') ? distillJson : m[1].endsWith('match.json') ? { matches: [] } : synthJson
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

test('runSweep: passes the existing skills WITH descriptions into the distill prompt (Constraint 7 modification signal)', async () => {
  const root = await tmp()
  const p = curatorPaths(root)
  let distillPrompt = ''
  const writes = async (prompt: string) => {
    const m = prompt.match(/(\/\S+?(?:distill|match|synth)\.json)/)
    if (!m) return
    if (m[1].endsWith('distill.json')) distillPrompt = prompt
    const payload = m[1].endsWith('distill.json') ? distillJson : m[1].endsWith('match.json') ? { matches: [] } : synthJson
    await fs.mkdir(path.dirname(m[1]), { recursive: true })
    await fs.writeFile(m[1] + '.tmp', JSON.stringify(payload)); await fs.rename(m[1] + '.tmp', m[1])
  }
  const curatedIndex = async () => [{ name: 'pr-review', description: 'review a pull request end to end', body: '## Goal\nreview' }]
  const run = makeRunSweep({ executorFactory: () => fakeExecutor(writes), paths: p, curatedIndex, sessionTimeoutMs: 5_000, pollMs: 20 })
  await run([{ taskId: 't1', intent: 'video work', transcriptPath: path.join(root, 't1.jsonl'), fromLine: 0, lines: [JSON.stringify({ message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: {} }] } })], lookback: [], newOffset: 1 }])
  assert.ok(distillPrompt.includes('pr-review'))
  assert.ok(distillPrompt.includes('review a pull request end to end'))   // the description, not just the name
  assert.ok(/skillObservation/.test(distillPrompt))
})

test('runSweep: a proposal.sourceKeys moves its ledger candidate to status "surfaced"', async () => {
  const root = await tmp()
  const p = curatorPaths(root)
  // distillJson title 'Load video Premiere' → occurrenceKey 'load-video-premiere'.
  const synthSourced = { proposals: [
    { kind: 'create', draft: { name: 'video-load-premiere', description: 'd', body: 'Goal…' },
      evidence: { occurrences: 2, sessions: [], firstSeen: 'a', lastSeen: 'b', struggle: { errors: 1, recoveries: 1, wallClockMin: 30 } },
      rationale: 'seen twice', sourceKeys: ['load-video-premiere'] },
  ] }
  const writes = async (prompt: string) => {
    const m = prompt.match(/(\/\S+?(?:distill|match|synth)\.json)/)
    if (!m) return
    const payload = m[1].endsWith('distill.json') ? distillJson : m[1].endsWith('match.json') ? { matches: [] } : synthSourced
    await fs.mkdir(path.dirname(m[1]), { recursive: true })
    await fs.writeFile(m[1] + '.tmp', JSON.stringify(payload)); await fs.rename(m[1] + '.tmp', m[1])
  }
  const run = makeRunSweep({ executorFactory: () => fakeExecutor(writes), paths: p, curatedIndex: async () => [], sessionTimeoutMs: 5_000, pollMs: 20 })
  await run([{ taskId: 't1', intent: 'video work', transcriptPath: path.join(root, 't1.jsonl'), fromLine: 0, lines: [JSON.stringify({ message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: {} }] } })], lookback: [], newOffset: 1 }])
  const cands = await readCandidates(p)
  assert.equal(cands.candidates['load-video-premiere'].status, 'surfaced')
})

test('runSweep: backfills evidence occurrences + struggle from sourceKeys candidates when the judge left them zero (the 0-min bug)', async () => {
  const root = await tmp()
  const p = curatorPaths(root)
  // A struggling session: one tool_use at t0, an is_error tool_result, then a
  // recovery 10 minutes later → computeTriageMetrics yields errors:1, recoveries:1,
  // wallClockMs:600_000. distillJson (count:2) → candidate 'load-video-premiere' total 2.
  const strugLines = [
    JSON.stringify({ timestamp: new Date(1_000_000).toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: {} }] } }),
    JSON.stringify({ timestamp: new Date(1_060_000).toISOString(), message: { role: 'user', content: [{ type: 'tool_result', is_error: true }] } }),
    JSON.stringify({ timestamp: new Date(1_600_000).toISOString(), message: { role: 'user', content: [{ type: 'tool_result', is_error: false }] } }),
  ]
  // Judge emits a create pointing at the candidate but with ZEROED evidence.
  const synthBackfill = { proposals: [
    { kind: 'create', draft: { name: 'video-load-premiere', description: 'd', body: 'Goal…' },
      evidence: { occurrences: 0, sessions: [], firstSeen: 'a', lastSeen: 'b', struggle: { errors: 0, recoveries: 0, wallClockMin: 0 } },
      rationale: 'seen', sourceKeys: ['load-video-premiere'] },
  ] }
  const writes = async (prompt: string) => {
    const m = prompt.match(/(\/\S+?(?:distill|match|synth)\.json)/)
    if (!m) return
    const payload = m[1].endsWith('distill.json') ? distillJson : m[1].endsWith('match.json') ? { matches: [] } : synthBackfill
    await fs.mkdir(path.dirname(m[1]), { recursive: true })
    await fs.writeFile(m[1] + '.tmp', JSON.stringify(payload)); await fs.rename(m[1] + '.tmp', m[1])
  }
  const run = makeRunSweep({ executorFactory: () => fakeExecutor(writes), paths: p, curatedIndex: async () => [], sessionTimeoutMs: 5_000, pollMs: 20 })
  await run([{ taskId: 't1', intent: 'video work', transcriptPath: path.join(root, 't1.jsonl'), fromLine: 0, lines: strugLines, lookback: [], newOffset: 3 }])
  const pending = await listPendingProposals(p)
  assert.equal(pending.length, 1)
  const ev = pending[0].evidence
  assert.equal(ev.occurrences, 2)             // backfilled from candidate.total (was 0)
  assert.equal(ev.struggle.wallClockMin, 10)  // round(600_000 / 60_000) (was 0)
  assert.equal(ev.struggle.errors, 1)
  assert.equal(ev.struggle.recoveries, 1)
})

test('runSweep: the matcher FUSES two differently-titled procedures from two sessions into ONE ledger entry (semantic match replaces slug-keying)', async () => {
  const root = await tmp()
  const p = curatorPaths(root)
  // Two sessions distill DIFFERENT-worded titles for the same repeatable core.
  // Under the old title-slug fold these were two entries; the matcher fuses them.
  const distillT1 = { findings: [{ intent: 'Alpha pattern one', contextSupplied: ['c1'], bodySketch: 'S1', count: 1 }] }
  const distillT2 = { findings: [{ intent: 'Beta different wording', contextSupplied: ['c2'], bodySketch: 'S2', count: 1 }] }
  // The single matcher session: proc[0] is new, proc[1] EXTENDS proc[0]'s entry.
  const matchJson = { matches: [
    { procedureIndex: 0, matchedKey: null, confidence: 0.9, variedThisRun: [] },
    { procedureIndex: 1, matchedKey: 'alpha-pattern-one', confidence: 0.9, variedThisRun: [] },
  ] }
  const synthJson = { proposals: [] }
  const writes = async (prompt: string) => {
    const m = prompt.match(/(\/\S+?(?:distill|match|synth)\.json)/)
    if (!m) return
    const out = m[1]
    const payload = out.endsWith('distill.json')
      ? (out.includes('distill-t1') ? distillT1 : distillT2)
      : out.endsWith('match.json') ? matchJson : synthJson
    await fs.mkdir(path.dirname(out), { recursive: true })
    await fs.writeFile(out + '.tmp', JSON.stringify(payload)); await fs.rename(out + '.tmp', out)
  }
  const line = JSON.stringify({ message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: {} }] } })
  const run = makeRunSweep({ executorFactory: () => fakeExecutor(writes), paths: p, curatedIndex: async () => [], sessionTimeoutMs: 5_000, pollMs: 20 })
  await run([
    { taskId: 't1', intent: 'work one', transcriptPath: path.join(root, 't1.jsonl'), fromLine: 0, lines: [line], lookback: [], newOffset: 1 },
    { taskId: 't2', intent: 'work two', transcriptPath: path.join(root, 't2.jsonl'), fromLine: 0, lines: [line], lookback: [], newOffset: 1 },
  ])
  const cands = await readCandidates(p)
  const entries = Object.values(cands.candidates)
  assert.equal(entries.length, 1)                     // ONE fused entry, not two slug-keyed ones
  assert.equal(entries[0].occurrences.length, 2)      // both sessions contributed an occurrence
  assert.equal(entries[0].total, 2)
})

test('runSweep: update proposal gets a DETERMINISTIC diff from the current body; create gets none (D19)', async () => {
  const root = await tmp()
  const p = curatorPaths(root)
  const synthUpdate = { proposals: [
    { kind: 'narrow', targetSkill: 'pr-review', draft: { name: 'pr-review', description: 'd', body: 'line1\nline2-new' },
      evidence: { occurrences: 2, sessions: [], firstSeen: 'a', lastSeen: 'b', struggle: { errors: 1, recoveries: 1, wallClockMin: 5 } }, rationale: 'gap found' },
    { kind: 'create', draft: { name: 'brand-new-skill', description: 'd', body: 'B' },
      evidence: { occurrences: 2, sessions: [], firstSeen: 'a', lastSeen: 'b', struggle: { errors: 1, recoveries: 1, wallClockMin: 5 } }, rationale: 'seen twice' },
  ] }
  const writes = async (prompt: string) => {
    const m = prompt.match(/(\/\S+?(?:distill|match|synth)\.json)/)
    if (!m) return
    const payload = m[1].endsWith('distill.json') ? distillJson : m[1].endsWith('match.json') ? { matches: [] } : synthUpdate
    await fs.mkdir(path.dirname(m[1]), { recursive: true })
    await fs.writeFile(m[1] + '.tmp', JSON.stringify(payload)); await fs.rename(m[1] + '.tmp', m[1])
  }
  // The pr-review entry must carry accumulated divergence so the narrow clears
  // the Task-10 gate and reaches the diff computation this test exercises.
  await writeCandidates(p, { version: 1, candidates: { 'pr-review-key': {
    key: 'pr-review-key', title: 'review a PR', skeleton: 'S', total: 3, struggle: true, firstSeen: 'a', lastSeen: 'b', occurrences: [],
    linkedSkillId: 'pr-review', divergenceLog: [
      { sessionId: 's0', at: 'x', verdict: 'diverge', note: 'n' },
      { sessionId: 's1', at: 'y', verdict: 'diverge', note: 'n' },
    ],
  } } })
  // curatedIndex now carries the current on-disk BODY — the diff's left side.
  const curatedIndex = async () => [{ name: 'pr-review', description: 'd', body: 'line1\nline2' }]
  const run = makeRunSweep({ executorFactory: () => fakeExecutor(writes), paths: p, curatedIndex, sessionTimeoutMs: 5_000, pollMs: 20 })
  await run([{ taskId: 't1', intent: 'x', transcriptPath: path.join(root, 't1.jsonl'), fromLine: 0, lines: [JSON.stringify({ message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: {} }] } })], lookback: [], newOffset: 1 }])
  const pending = await listPendingProposals(p)
  const upd = pending.find((x) => x.kind === 'narrow')
  const cre = pending.find((x) => x.kind === 'create')
  assert.ok(upd?.diff && upd.diff.includes('-line2') && upd.diff.includes('+line2-new'))   // real diff off the real body
  assert.equal(cre?.diff, undefined)                                                       // create → no previous version → no diff
})

// ── Task 10: divergence accumulation gates `narrow` proposals ────────────────

const evid = { occurrences: 2, sessions: [], firstSeen: 'a', lastSeen: 'b', struggle: { errors: 1, recoveries: 1, wallClockMin: 5 } }
const seededLedger = (divergeCount: number): CandidatesFile => ({
  version: 1,
  candidates: {
    'pr-review-key': {
      key: 'pr-review-key', title: 'review a PR', skeleton: 'S', total: 3, struggle: true,
      firstSeen: 'a', lastSeen: 'b', occurrences: [], linkedSkillId: 'pr-review',
      divergenceLog: Array.from({ length: divergeCount }, (_, i) => ({ sessionId: `s${i}`, at: 'x', verdict: 'diverge' as const, note: 'n' })),
    },
  },
})
const synthNarrowAndCreate = { proposals: [
  { kind: 'narrow', targetSkill: 'pr-review', draft: { name: 'pr-review', description: 'd', body: 'new body' }, evidence: evid, rationale: 'gap' },
  { kind: 'create', draft: { name: 'brand-new-skill', description: 'd', body: 'B' }, evidence: evid, rationale: 'seen twice' },
] }
const writesWith = (synthPayload: unknown) => async (prompt: string) => {
  const m = prompt.match(/(\/\S+?(?:distill|match|synth)\.json)/)
  if (!m) return
  const payload = m[1].endsWith('distill.json') ? distillJson : m[1].endsWith('match.json') ? { matches: [] } : synthPayload
  await fs.mkdir(path.dirname(m[1]), { recursive: true })
  await fs.writeFile(m[1] + '.tmp', JSON.stringify(payload)); await fs.rename(m[1] + '.tmp', m[1])
}
const oneMaterial = (root: string): MaterialSession[] => [{ taskId: 't1', intent: 'x', transcriptPath: path.join(root, 't1.jsonl'), fromLine: 0, lines: [JSON.stringify({ message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: {} }] } })], lookback: [], newOffset: 1 }]

test('runSweep: a narrow proposal is DROPPED when its linked entry has <2 accumulated diverges (create survives)', async () => {
  const root = await tmp(); const p = curatorPaths(root)
  await writeCandidates(p, seededLedger(1))   // only ONE diverge — below the anti-thrash floor
  const curatedIndex = async () => [{ name: 'pr-review', description: 'd', body: 'line1\nline2' }]
  const run = makeRunSweep({ executorFactory: () => fakeExecutor(writesWith(synthNarrowAndCreate)), paths: p, curatedIndex, sessionTimeoutMs: 5_000, pollMs: 20 })
  await run(oneMaterial(root))
  const pending = await listPendingProposals(p)
  assert.equal(pending.find((x) => x.kind === 'narrow'), undefined)   // gated out
  assert.ok(pending.find((x) => x.kind === 'create'))                 // not divergence-gated
})

test('runSweep: a narrow proposal SURVIVES when its linked entry has ≥2 accumulated diverges', async () => {
  const root = await tmp(); const p = curatorPaths(root)
  await writeCandidates(p, seededLedger(2))   // accumulated divergence — the reshape is warranted
  const curatedIndex = async () => [{ name: 'pr-review', description: 'd', body: 'line1\nline2' }]
  const run = makeRunSweep({ executorFactory: () => fakeExecutor(writesWith(synthNarrowAndCreate)), paths: p, curatedIndex, sessionTimeoutMs: 5_000, pollMs: 20 })
  await run(oneMaterial(root))
  const pending = await listPendingProposals(p)
  assert.ok(pending.find((x) => x.kind === 'narrow'))                 // survives the gate
})

// ── Task 12: deterministic create-suppression (a rejected create never re-surfaces) ──

test('runSweep: a create proposal whose draft name was previously rejected is dropped (create-suppression)', async () => {
  const root = await tmp(); const p = curatorPaths(root)
  await appendRejection(p, { at: 'x', name: 'foo' })   // the user already said no to this exact name
  const synthRejectedCreate = { proposals: [
    { kind: 'create', draft: { name: 'foo', description: 'd', body: 'B' }, evidence: evid, rationale: 'seen twice' },
  ] }
  const run = makeRunSweep({ executorFactory: () => fakeExecutor(writesWith(synthRejectedCreate)), paths: p, curatedIndex: async () => [], sessionTimeoutMs: 5_000, pollMs: 20 })
  await run(oneMaterial(root))
  const pending = await listPendingProposals(p)
  assert.equal(pending.find((x) => x.kind === 'create' && x.draft.name === 'foo'), undefined)   // suppressed — never persisted
})

test('runSweep: a create proposal with a NON-rejected name is unaffected by suppression', async () => {
  const root = await tmp(); const p = curatorPaths(root)
  await appendRejection(p, { at: 'x', name: 'some-other-name' })
  const synthCreate = { proposals: [
    { kind: 'create', draft: { name: 'foo', description: 'd', body: 'B' }, evidence: evid, rationale: 'seen twice' },
  ] }
  const run = makeRunSweep({ executorFactory: () => fakeExecutor(writesWith(synthCreate)), paths: p, curatedIndex: async () => [], sessionTimeoutMs: 5_000, pollMs: 20 })
  await run(oneMaterial(root))
  const pending = await listPendingProposals(p)
  assert.ok(pending.find((x) => x.kind === 'create' && x.draft.name === 'foo'))   // not suppressed — survives
})

test('runSweep: gardening kinds (narrow/split/merge/retire) targeting an existing skill are NOT create-suppressed even if that skill name was once rejected', async () => {
  const root = await tmp(); const p = curatorPaths(root)
  await appendRejection(p, { at: 'x', name: 'pr-review' })   // rejected once, unrelated to today's gardening proposal
  await writeCandidates(p, seededLedger(2))   // pr-review has accumulated divergence — narrow clears its own gate
  const synthGardening = { proposals: [
    { kind: 'narrow', targetSkill: 'pr-review', draft: { name: 'pr-review', description: 'd', body: 'new body' }, evidence: evid, rationale: 'gap' },
  ] }
  const curatedIndex = async () => [{ name: 'pr-review', description: 'd', body: 'line1\nline2' }]
  const run = makeRunSweep({ executorFactory: () => fakeExecutor(writesWith(synthGardening)), paths: p, curatedIndex, sessionTimeoutMs: 5_000, pollMs: 20 })
  await run(oneMaterial(root))
  const pending = await listPendingProposals(p)
  assert.ok(pending.find((x) => x.kind === 'narrow' && x.targetSkill === 'pr-review'))   // create-suppression doesn't apply to gardening kinds
})

test('runSweep: a proc.skillObservation is recorded against the ledger entry linked to that skill', async () => {
  const root = await tmp(); const p = curatorPaths(root)
  await writeCandidates(p, seededLedger(0))
  // distill emits a diverge observation against pr-review; the fold must append it.
  const distillObs = { findings: [{ intent: 'Load video Premiere', contextSupplied: ['open the Premiere project first'], correction: 'no, use the CLI', bodySketch: 'S', count: 2, skillObservation: { skill: 'pr-review', verdict: 'diverge', note: 'skipped lockfile' } }] }
  const writes = async (prompt: string) => {
    const m = prompt.match(/(\/\S+?(?:distill|match|synth)\.json)/)
    if (!m) return
    const payload = m[1].endsWith('distill.json') ? distillObs : m[1].endsWith('match.json') ? { matches: [] } : { proposals: [] }
    await fs.mkdir(path.dirname(m[1]), { recursive: true })
    await fs.writeFile(m[1] + '.tmp', JSON.stringify(payload)); await fs.rename(m[1] + '.tmp', m[1])
  }
  const run = makeRunSweep({ executorFactory: () => fakeExecutor(writes), paths: p, curatedIndex: async () => [{ name: 'pr-review', description: 'd', body: 'b' }], sessionTimeoutMs: 5_000, pollMs: 20 })
  await run(oneMaterial(root))
  const cands = await readCandidates(p)
  const log = cands.candidates['pr-review-key'].divergenceLog
  assert.equal(log?.length, 1)
  assert.deepEqual(log?.[0], { sessionId: 't1', at: log![0].at, verdict: 'diverge', note: 'skipped lockfile' })
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

test('runSweep: a SYNTH-stage rate limit leaves candidates.json + cursor UNCHANGED — no pre-synth ledger write, no double-count (I1)', async () => {
  const root = await tmp()
  const p = curatorPaths(root)
  // distill + match succeed (write their output files); the synth one-shot trips
  // the rate-limit sentinel instead of writing. If the sweep persisted the ledger
  // BEFORE synth, an occurrence for t1 would already be on disk here (and, since
  // sweepId regenerates next sweep, it would re-append → permanent double-count).
  const executorFactory = (): AgentExecutor => {
    let dataCb: (c: string) => void = () => {}
    return {
      alive: true,
      spawn: async () => {},
      isReady: async () => {},
      writeStdin: (text: string) => {
        const m = text.match(/(\/\S+?(?:distill|match|synth)\.json)/)
        if (!m) return
        if (m[1].endsWith('synth.json')) { setTimeout(() => dataCb('You have reached your usage limit'), 10); return }
        const payload = m[1].endsWith('distill.json') ? distillJson : { matches: [] }
        void (async () => {
          await fs.mkdir(path.dirname(m[1]), { recursive: true })
          await fs.writeFile(m[1] + '.tmp', JSON.stringify(payload)); await fs.rename(m[1] + '.tmp', m[1])
        })()
      },
      write: () => {}, resize: () => {}, onData: (cb: (c: string) => void) => { dataCb = cb }, kill: () => {},
    } as unknown as AgentExecutor
  }
  const run = makeRunSweep({ executorFactory, paths: p, curatedIndex: async () => [], sessionTimeoutMs: 3_000, pollMs: 20 })
  await assert.rejects(run(oneMaterial(root)), RateLimitedError)
  const cands = await readCandidates(p)
  assert.equal(Object.keys(cands.candidates).length, 0)                 // NOTHING persisted pre-synth
  assert.equal((await readCursor(p)).sessions.t1?.lineOffset ?? 0, 0)    // cursor not advanced
  assert.equal((await listPendingProposals(p)).length, 0)
})

test('runSweep: judge evidence missing struggle/sessions completes without throwing and persists the proposal (I2)', async () => {
  const root = await tmp()
  const p = curatorPaths(root)
  // create carries sourceKeys → exercises the evidence backfill (which reads
  // ev.struggle.errors / ev.occurrences unconditionally). Evidence lacks both
  // struggle and sessions — the parse normalization must have supplied them.
  const synthNoStruggle = { proposals: [
    { kind: 'create', draft: { name: 'video-load-premiere', description: 'd', body: 'Goal…' },
      evidence: { occurrences: 2 }, rationale: 'seen', sourceKeys: ['load-video-premiere'] },
  ] }
  const run = makeRunSweep({ executorFactory: () => fakeExecutor(writesWith(synthNoStruggle)), paths: p, curatedIndex: async () => [], sessionTimeoutMs: 5_000, pollMs: 20 })
  await run(oneMaterial(root))                       // must NOT throw
  const pending = await listPendingProposals(p)
  assert.equal(pending.length, 1)
  assert.deepEqual(pending[0].evidence.sessions, [])
  assert.equal(pending[0].evidence.struggle.errors, 0)         // no per-occurrence errors in this material → stays 0
  assert.equal(pending[0].evidence.occurrences, 2)             // backfilled from candidate.total
})

test('runSweep: a create for an ALREADY-OWNED skill name is pre-filtered (M3 — would only dead-end at accept with a collision)', async () => {
  const root = await tmp()
  const p = curatorPaths(root)
  await recordOwnership(p, 'video-load-premiere', 'hash', 'x')   // we already own this name
  const synthOwnedCreate = { proposals: [
    { kind: 'create', draft: { name: 'video-load-premiere', description: 'd', body: 'B' }, evidence: evid, rationale: 'seen twice' },
  ] }
  const run = makeRunSweep({ executorFactory: () => fakeExecutor(writesWith(synthOwnedCreate)), paths: p, curatedIndex: async () => [], sessionTimeoutMs: 5_000, pollMs: 20 })
  await run(oneMaterial(root))
  const pending = await listPendingProposals(p)
  assert.equal(pending.find((x) => x.kind === 'create' && x.draft.name === 'video-load-premiere'), undefined)   // dropped, never persisted
})

test('runSweep: a create proposal whose draft name matches an entry in curatedIndex() (e.g. a project-scoped skill the curator does not own) is dropped as a duplicate (create-dropped-duplicate)', async () => {
  const root = await tmp(); const p = curatorPaths(root)
  // 'foo' is neither rejected nor owned — only curatedIndex() knows about it
  // (this is the shape of a project-scoped skill: readable, but the curator
  // never created it, so ownedSkillNames() alone can't catch the duplicate).
  const synthDuplicateCreate = { proposals: [
    { kind: 'create', draft: { name: 'foo', description: 'd', body: 'B' }, evidence: evid, rationale: 'seen twice' },
  ] }
  const curatedIndex = async () => [{ name: 'foo', description: 'already exists', body: 'b' }]
  const run = makeRunSweep({ executorFactory: () => fakeExecutor(writesWith(synthDuplicateCreate)), paths: p, curatedIndex, sessionTimeoutMs: 5_000, pollMs: 20 })
  await run(oneMaterial(root))
  const pending = await listPendingProposals(p)
  assert.equal(pending.find((x) => x.kind === 'create' && x.draft.name === 'foo'), undefined)   // dropped — never persisted
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

test('ProposalConversation: input written before the PTY is ready is buffered and flushed in order (not dropped)', async () => {
  const root = await tmp(); const p = curatorPaths(root)
  await writeProposal(p, prop('prop_d'))
  await fs.writeFile(path.join(p.proposalsDir, 'prop_d', 'draft.md'), 'body v1')
  const raw: string[] = []
  // Executor that is NOT alive until start() completes — mirrors the real race:
  // the popup's sendLine fires ensureStarted() then curatorConverseWrite in the
  // same synchronous tick, so write() lands while start() is still awaiting.
  let ready = false
  const ex = {
    get alive() { return ready },
    spawn: async () => {},
    isReady: async () => { await new Promise((r) => setTimeout(r, 5)); ready = true },
    writeStdin: () => {}, write: (d: string) => raw.push(d),
    resize: () => {}, onData: () => {}, kill: () => { ready = false },
  } as unknown as AgentExecutor
  const conv = new ProposalConversation({ executorFactory: () => ex, paths: p, proposalId: 'prop_d', onData: () => {}, readyGraceMs: 0 })
  const started = conv.start()             // in-flight — not alive yet
  conv.write('first instruction')          // arrives BEFORE the PTY is ready
  conv.write(' second')                    // and a follow-up in the same window
  assert.equal(raw.length, 0)              // nothing written through while not alive
  assert.equal(await started, true)
  assert.deepEqual(raw, ['first instruction', ' second'])   // buffered chunks flushed, in order
})
