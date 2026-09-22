import test from 'node:test'
import assert from 'node:assert/strict'
import { mergeRoutineBlocks, routineEntries, routinesPayload, triggerLabel } from './routine-blocks'
import type { Block } from '../blocks'
import type { RoutineItemView, RoutineRun, RoutinesView } from '../agent/routines/types'

const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime()

function makeRun(overrides: Partial<RoutineRun> & { id: string; firedAt: number }): RoutineRun {
  return {
    routineId: overrides.routineId ?? overrides.id, name: 'Morning recap', key: overrides.id,
    kind: 'read-only', trigger: { type: 'manual' }, status: 'done',
    activity: [], posted: true, unread: false, speak: false,
    ...overrides,
  }
}

const userMsg = (text: string, when: number): Block => ({ kind: 'message', role: 'user', text, at: when })
const assistantMsg = (text: string, when: number): Block => ({ kind: 'message', role: 'assistant', text, at: when })

test('triggerLabel words each trigger type', () => {
  assert.equal(triggerLabel(makeRun({ id: 'r1', firedAt: at(2026, 9, 14, 9, 0), trigger: { type: 'schedule', scheduledFor: at(2026, 9, 14, 9, 0) } })), '09:00 schedule')
  assert.equal(triggerLabel(makeRun({ id: 'r2', firedAt: 0, trigger: { type: 'manual' } })), 'Run now')
  assert.equal(triggerLabel(makeRun({ id: 'r3', firedAt: 0, trigger: { type: 'event', event: 'meeting-notes-ready', meetingId: 'm1' } })), 'notes ready')
  assert.equal(triggerLabel(makeRun({ id: 'r4', firedAt: 0, trigger: { type: 'approval', parentRunId: 'p', proposalId: 'pr' } })), 'approved')
})

test('entries interleave by time with base blocks', () => {
  const base: Block[] = [userMsg('hi', at(2026, 9, 14, 8)), assistantMsg('hello', at(2026, 9, 14, 8, 1))]
  const run = makeRun({ id: 'r1', firedAt: at(2026, 9, 14, 8, 30), status: 'done', resultPreview: 'done!' })
  const entries = routineEntries([run], { since: 0 })
  assert.equal(entries.length, 2)
  assert.equal(entries[0]!.block.kind, 'routineRun')
  assert.equal(entries[1]!.block.kind, 'routineResult')
  const merged = mergeRoutineBlocks(base, entries, { busy: false })
  assert.deepEqual(merged.map(b => b.kind), ['message', 'message', 'routineRun', 'routineResult'])
})

test('a result never splits a user message from its answer', () => {
  const base: Block[] = [
    userMsg('question', at(2026, 9, 14, 8, 0)),
    assistantMsg('answer', at(2026, 9, 14, 8, 5)),
  ]
  // The run fires and finishes strictly between the question and the answer.
  const run = makeRun({ id: 'r1', firedAt: at(2026, 9, 14, 8, 1), endedAt: at(2026, 9, 14, 8, 2), status: 'done', resultPreview: 'x' })
  const entries = routineEntries([run], { since: 0 })
  const merged = mergeRoutineBlocks(base, entries, { busy: false })
  // Both routine blocks must land AFTER the answer, not between question and answer.
  const answerIdx = merged.findIndex(b => b.kind === 'message' && b.role === 'assistant')
  const runIdx = merged.findIndex(b => b.kind === 'routineRun')
  const resultIdx = merged.findIndex(b => b.kind === 'routineResult')
  assert.ok(runIdx > answerIdx, 'routineRun should be after the answer')
  assert.ok(resultIdx > answerIdx, 'routineResult should be after the answer')
})

test('while busy, an entry after the unanswered last user message goes before it', () => {
  const base: Block[] = [userMsg('question', at(2026, 9, 14, 8, 0))]
  const run = makeRun({ id: 'r1', firedAt: at(2026, 9, 14, 8, 1), status: 'done', resultPreview: 'x' })
  const entries = routineEntries([run], { since: 0 })
  const merged = mergeRoutineBlocks(base, entries, { busy: true })
  const userIdx = merged.findIndex(b => b.kind === 'message' && b.role === 'user')
  const runIdx = merged.findIndex(b => b.kind === 'routineRun')
  assert.ok(runIdx < userIdx, 'routine entries should land before the pending question while busy')

  // Not busy: the same shape lands after the question instead.
  const mergedIdle = mergeRoutineBlocks(base, entries, { busy: false })
  const userIdx2 = mergedIdle.findIndex(b => b.kind === 'message' && b.role === 'user')
  const runIdx2 = mergedIdle.findIndex(b => b.kind === 'routineRun')
  assert.ok(runIdx2 > userIdx2, 'routine entries should land after the question when not busy')
})

test('the notice stays first and the error stays last', () => {
  const base: Block[] = [
    { kind: 'message', role: 'assistant', text: 'Ask me anything' }, // notice, no `at`
    userMsg('hi', at(2026, 9, 14, 8, 0)),
    assistantMsg('hello', at(2026, 9, 14, 8, 1)),
    { kind: 'error', message: 'boom' }, // trailing error, no `at`
  ]
  const run = makeRun({ id: 'r1', firedAt: at(2026, 9, 14, 7, 0), status: 'done', resultPreview: 'x' }) // before everything
  const late = makeRun({ id: 'r2', firedAt: at(2026, 9, 14, 9, 0), status: 'done', resultPreview: 'y' }) // after everything
  const entries = routineEntries([run, late], { since: 0 })
  const merged = mergeRoutineBlocks(base, entries, { busy: false })
  assert.equal(merged[0]!.kind, 'message')
  assert.equal((merged[0] as Extract<Block, { kind: 'message' }>).text, 'Ask me anything')
  assert.equal(merged.at(-1)!.kind, 'error')
})

test('a lone trailing error (no leading notice) still stays last', () => {
  const base: Block[] = [{ kind: 'error', message: 'boom' }] // both "first" and "last" at once
  const run = makeRun({ id: 'r1', firedAt: at(2026, 9, 14, 8), status: 'done', resultPreview: 'x' })
  const entries = routineEntries([run], { since: 0 })
  const merged = mergeRoutineBlocks(base, entries, { busy: false })
  assert.equal(merged.at(-1)!.kind, 'error')
})

test('cancelled runs have no result', () => {
  const run = makeRun({ id: 'r1', firedAt: at(2026, 9, 14, 8), status: 'cancelled', resultPreview: 'should not appear' })
  const entries = routineEntries([run], { since: 0 })
  assert.equal(entries.length, 1)
  assert.equal(entries[0]!.block.kind, 'routineRun')
})

test('silent (unposted) terminal runs have no result either', () => {
  const run = makeRun({ id: 'r1', firedAt: at(2026, 9, 14, 8), status: 'failed', posted: false, resultPreview: 'x' })
  const entries = routineEntries([run], { since: 0 })
  assert.equal(entries.length, 1)
  assert.equal(entries[0]!.block.kind, 'routineRun')
})

test('an unread run older than since is still shown', () => {
  const since = at(2026, 9, 14, 8)
  const run = makeRun({ id: 'r1', firedAt: at(2026, 9, 13, 8), status: 'done', resultPreview: 'x', unread: true })
  const entries = routineEntries([run], { since })
  assert.equal(entries.length, 2)
  const old = makeRun({ id: 'r2', firedAt: at(2026, 9, 13, 8), status: 'done', resultPreview: 'x', unread: false })
  assert.equal(routineEntries([old], { since }).length, 0)
})

test('the limit is 30, keeping the newest', () => {
  const runs = Array.from({ length: 40 }, (_, i) => makeRun({ id: `r${i}`, firedAt: at(2026, 9, 14, 0) + i * 60_000, status: 'done', resultPreview: 'x' }))
  const entries = routineEntries(runs, { since: 0 })
  const runEntries = entries.filter(e => e.block.kind === 'routineRun')
  assert.equal(runEntries.length, 30)
  const names = runEntries.map(e => (e.block as Extract<Block, { kind: 'routineRun' }>).what)
  assert.deepEqual(names, Array.from({ length: 30 }, (_, i) => `r${i + 10}`))
})

test('done text prefers the injected result map over resultPreview', () => {
  const run = makeRun({ id: 'r1', firedAt: at(2026, 9, 14, 8), status: 'done', resultPreview: 'short preview' })
  const withMap = routineEntries([run], { since: 0, results: new Map([['r1', 'full result text']]) })
  const result = withMap.find(e => e.block.kind === 'routineResult')!.block as Extract<Block, { kind: 'routineResult' }>
  assert.equal(result.text, 'full result text')

  const withoutMap = routineEntries([run], { since: 0 })
  const result2 = withoutMap.find(e => e.block.kind === 'routineResult')!.block as Extract<Block, { kind: 'routineResult' }>
  assert.equal(result2.text, 'short preview')
})

test('proposals are included only when non-empty', () => {
  const withProposals = makeRun({
    id: 'r1', firedAt: at(2026, 9, 14, 8), status: 'done', resultPreview: 'x',
    proposals: [{ id: 'p1', title: 't', detail: 'd', state: 'open' }],
  })
  const entries = routineEntries([withProposals], { since: 0 })
  const result = entries.find(e => e.block.kind === 'routineResult')!.block as Extract<Block, { kind: 'routineResult' }>
  assert.equal(result.proposals?.length, 1)

  const without = makeRun({ id: 'r2', firedAt: at(2026, 9, 14, 8), status: 'done', resultPreview: 'x', proposals: [] })
  const entries2 = routineEntries([without], { since: 0 })
  const result2 = entries2.find(e => e.block.kind === 'routineResult')!.block as Extract<Block, { kind: 'routineResult' }>
  assert.equal('proposals' in result2, false)
})

test('routinesPayload: view null is unavailable and loading', () => {
  const payload = routinesPayload(null)
  assert.deepEqual(payload, { available: false, reason: 'Routines are loading', items: [] })
})

test('routine details retain context and per-routine results outside the global chat window', () => {
  const context = { folders: ['/repo'], sessionIds: [], files: ['/brief.md'], excludedFolders: [], excludedSessionIds: [], meetingIds: ['meeting-1'] }
  const recentRuns = [{ id: 'older-run', status: 'done' as const, at: 1, preview: 'The last result' }]
  const item: RoutineItemView = { id: 'r', name: 'R', scheduleLabel: 'Daily', kind: 'read-only', enabled: true,
    nextRunAt: 2, window: 'today', schedule: 'daily 09:00', prompt: 'Review', color: 'white', nextRunLabel: 'Tomorrow',
    running: false, path: '/r.md', inputs: ['sessions', 'meetings'], context, recentRuns }
  const catalog = { folders: ['/repo'], sessions: [], meetings: [{ id: 'meeting-1', title: 'Review' }] }
  const payload = routinesPayload({ available: true, items: [item], runs: [], contextCatalog: catalog })
  assert.deepEqual(payload.items[0]!.context, context)
  assert.deepEqual(payload.items[0]!.recentRuns, recentRuns)
  assert.deepEqual(payload.contextCatalog, catalog)
})

test('routinesPayload maps an item, the last-run label and a run detail', () => {
  const now = at(2026, 9, 14, 10)
  const item: RoutineItemView = {
    id: 'morning-recap', name: 'Morning recap', scheduleLabel: 'Daily at 09:00', kind: 'read-only',
    enabled: true, nextRunAt: at(2026, 9, 15, 9), window: 'today', nextRunLabel: 'Tomorrow 09:00',
    lastRun: { status: 'done', at: at(2026, 9, 14, 9) }, running: false, path: '/routines/morning-recap.md',
  }
  const view: RoutinesView = { available: true, items: [item], runs: [] }
  const run = makeRun({
    id: 'run-1', routineId: 'morning-recap', firedAt: at(2026, 9, 14, 9), endedAt: at(2026, 9, 14, 9, 2),
    status: 'done', window: { start: 0, end: 1, label: 'Sun 13 Sep 09:00 → Mon 14 Sep 09:00' },
    manifestTotals: { sessions: 2, turns: 5 }, provider: 'claude', resultPreview: 'preview text',
  })

  const payload = routinesPayload(view, { run, result: null, hasTranscript: true }, now)
  assert.equal(payload.available, true)
  assert.equal(payload.items.length, 1)
  assert.equal(payload.items[0]!.lastRunLabel, 'Last run 09:00 · done')
  assert.ok(payload.run)
  assert.equal(payload.run!.runId, 'run-1')
  assert.equal(payload.run!.totals, '2 sessions · 5 turns')
  assert.equal(payload.run!.windowLabel, 'Sun 13 Sep 09:00 → Mon 14 Sep 09:00')
  assert.equal(payload.run!.result, 'preview text')
  assert.equal(payload.run!.canCancel, false)

  const running = makeRun({ id: 'run-2', routineId: 'morning-recap', firedAt: now, status: 'running' })
  const runningPayload = routinesPayload(view, { run: running, result: null, hasTranscript: false }, now)
  assert.equal(runningPayload.run!.canCancel, true)
})

test('lastRunLabel gets a weekday prefix when not today', () => {
  const now = at(2026, 9, 14, 10)
  const item: RoutineItemView = {
    id: 'r', name: 'r', scheduleLabel: 's', kind: 'read-only', enabled: true, nextRunAt: null,
    window: 'today', nextRunLabel: 'x', lastRun: { status: 'done', at: at(2026, 9, 12, 9) }, running: false, path: 'p',
  }
  const view: RoutinesView = { available: true, items: [item], runs: [] }
  const payload = routinesPayload(view, undefined, now)
  assert.equal(payload.items[0]!.lastRunLabel, 'Last run Sat 09:00 · done')
})
