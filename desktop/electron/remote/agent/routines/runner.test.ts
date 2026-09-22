import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { writeFileAtomic } from './atomic'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RoutineRunner } from './runner'
import { RoutineStore } from './store'
import { RoutineRunLog } from './run-log'
import { nextFireAt } from './schedule'
import { parseRoutineContext, type RoutineFields } from './definition'
import type { ExecuteInput, ExecuteOutcome, RoutineExecutor } from './executor'
import type { RoutineRun } from './types'

const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime()
const MON_0800 = at(2026, 9, 14, 8)

interface FakeStart { input: ExecuteInput; finish(outcome: Omit<ExecuteOutcome, 'agentRunId'>): void; cancels: number }
function fakeExecutor() {
  const starts: FakeStart[] = []
  let n = 0
  const executor: RoutineExecutor = {
    start(input) {
      const agentRunId = `agent-${++n}`
      let resolve!: (o: ExecuteOutcome) => void
      const completion = new Promise<ExecuteOutcome>(r => { resolve = r })
      const record: FakeStart = { input, finish: o => resolve({ ...o, agentRunId }), cancels: 0 }
      starts.push(record)
      return { agentRunId, completion, cancel: async () => { record.cancels++ } }
    },
    dispose: async () => {},
  }
  return { executor, starts }
}

function fakeTimers() {
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = []
  return {
    timers,
    setTimer: (fn: () => void, ms: number) => { const t = { fn, ms, cleared: false }; timers.push(t); return t },
    clearTimer: (h: unknown) => { (h as { cleared: boolean }).cleared = true },
    live: (ms: number) => timers.filter(t => !t.cleared && t.ms === ms),
  }
}

async function until(check: () => boolean, label = 'condition'): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (check()) return
    await new Promise(r => setTimeout(r, 5))
  }
  assert.fail(`timed out waiting for ${label}`)
}

async function setup(opts: { now?: number; agentProvider?: 'claude' | 'codex'; maxConcurrent?: number; persist?: (path: string, content: string) => Promise<void> } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'routines-'))
  const clock = { now: opts.now ?? MON_0800 }
  const store = new RoutineStore({ root: join(dir, 'routines'), now: () => clock.now, watch: false })
  const log = new RoutineRunLog({ path: join(dir, 'routines', 'runs.json'), ...(opts.persist ? { persist: opts.persist } : {}) })
  const { executor, starts } = fakeExecutor()
  const timers = fakeTimers()
  let ids = 0
  let changes = 0
  const indexDir = join(dir, 'index')
  const runsDir = join(dir, 'routines', 'runs')
  const runner = new RoutineRunner({
    store, log, executor, runsDir, indexDir, excludeCwdPart: runsDir,
    agentProvider: () => opts.agentProvider ?? 'codex', now: () => clock.now, randomId: () => `id-${++ids}`,
    setTimer: timers.setTimer, clearTimer: timers.clearTimer, maxConcurrent: opts.maxConcurrent,
    onChange: () => { changes++ },
  })
  const create = (fields: Partial<RoutineFields> & { name: string }) =>
    store.create({ schedule: 'daily 09:00', prompt: 'Do the thing.', window: 'none', ...fields })
  return { dir, clock, store, log, starts, timers, runner, indexDir, runsDir, create, changes: () => changes }
}

const runsOf = (log: RoutineRunLog, routineId: string) => log.all().filter(r => r.routineId === routineId)

test('selected context reaches the manifest and empty sessions do not discard attached reference files', async () => {
  const s = await setup()
  const context = parseRoutineContext({ folders: ['/repo/a'], excludedSessionIds: ['excluded'], files: ['/reference.md'] })
  await s.create({ name: 'Scoped', context })
  await mkdir(s.indexDir, { recursive: true })
  await writeFile(join(s.indexDir, 'sessions.jsonl'), ['selected', 'excluded', 'other'].map(id => JSON.stringify({ id, cwd: id === 'other' ? '/repo/b' : '/repo/a' })).join('\n'))
  await writeFile(join(s.indexDir, 'turns.jsonl'), ['selected', 'excluded', 'other'].map(s => JSON.stringify({ s, t: MON_0800 - 1, o: 0, text: s })).join('\n'))
  const run = await s.runner.runNow('scoped')
  const manifest = JSON.parse(await readFile(join(s.runsDir, run.id, 'manifest.json'), 'utf8'))
  assert.deepEqual(manifest.sessions.map((s: any) => s.id), ['selected'])
  assert.match(s.starts[0]!.input.transcript, /reference.md/)
  await s.runner.dispose()
  s.store.close()
  const empty = await setup()
  await empty.create({ name: 'Reference', context })
  await empty.runner.runNow('reference')
  assert.equal(empty.starts.length, 1)
  await empty.runner.dispose()
  empty.store.close()
})

test('a meeting-specific routine ignores unrelated meeting events', async () => {
  const s = await setup()
  await s.create({ name: 'Meeting', schedule: 'on meeting-notes-ready', inputs: ['meetings'], context: parseRoutineContext({ meetingIds: ['m1'] }) })
  assert.equal((await s.runner.event({ type: 'meeting-notes-ready', meetingId: 'm2' })).length, 0)
  assert.equal((await s.runner.event({ type: 'meeting-notes-ready', meetingId: 'm1' })).length, 1)
  await s.runner.dispose(); s.store.close()
})

test('1. a due clock routine within 6h fires a scheduled run and advances nextFireAt', async () => {
  const s = await setup()
  const entry = await s.create({ name: 'Recap' })
  const fireAt = entry.state.nextFireAt!
  s.clock.now = fireAt + 5 * 60_000
  await s.runner.tick()
  const [run] = runsOf(s.log, 'recap')
  assert.equal(run!.key, `recap@${new Date(fireAt).toISOString().slice(0, 16)}`)
  assert.deepEqual(run!.trigger, { type: 'schedule', scheduledFor: fireAt })
  assert.equal(run!.status, 'running')
  assert.equal(s.starts.length, 1)
  assert.equal(s.store.get('recap')!.state.nextFireAt, nextFireAt(entry.definition!.schedule, s.clock.now))
})

test('2. a fire more than 6h late records a missed skip without calling the executor', async () => {
  const s = await setup()
  const entry = await s.create({ name: 'Recap' })
  const fireAt = entry.state.nextFireAt!
  s.clock.now = fireAt + 7 * 3_600_000
  await s.runner.tick()
  const [run] = runsOf(s.log, 'recap')
  assert.equal(run!.status, 'skipped')
  assert.equal(run!.reason, 'missed')
  assert.equal(run!.posted, true)
  assert.equal(run!.unread, true)
  assert.equal(run!.resultPreview, "Skipped: Unmute wasn't running at 09:00.")
  assert.equal(s.starts.length, 0)
  assert.equal(s.store.get('recap')!.state.nextFireAt, nextFireAt(entry.definition!.schedule, s.clock.now))
})

test('3. a key already in the log never fires again', async () => {
  const s = await setup()
  const entry = await s.create({ name: 'Recap' })
  const fireAt = entry.state.nextFireAt!
  const key = `recap@${new Date(fireAt).toISOString().slice(0, 16)}`
  await s.log.upsert({
    id: 'old', routineId: 'recap', name: 'Recap', key, kind: 'read-only', trigger: { type: 'schedule', scheduledFor: fireAt },
    status: 'done', firedAt: fireAt, activity: [], posted: true, unread: false, speak: false,
  })
  s.clock.now = fireAt + 60_000
  await s.runner.tick()
  assert.equal(runsOf(s.log, 'recap').length, 1)
  assert.equal(s.starts.length, 0)
})

test('4. a disabled routine does not fire but its nextFireAt still advances', async () => {
  const s = await setup()
  const entry = await s.create({ name: 'Recap' })
  await s.store.setEnabled('recap', false)
  s.clock.now = entry.state.nextFireAt! + 60_000
  await s.runner.tick()
  assert.equal(runsOf(s.log, 'recap').length, 0)
  assert.ok(s.store.get('recap')!.state.nextFireAt! > s.clock.now)
})

test('5. an invalid definition never fires', async () => {
  const s = await setup()
  const entry = await s.create({ name: 'Recap' })
  await writeFile(entry.path, '---\nname: Recap\n---\n')
  await s.store.load()
  assert.ok(s.store.get('recap')!.error)
  s.clock.now = entry.state.nextFireAt! + 60_000
  await s.runner.tick()
  assert.equal(s.log.all().length, 0)
  await assert.rejects(s.runner.runNow('recap'))
})

test('6. pool: three due runs start two, the third starts when one settles', async () => {
  const s = await setup()
  await s.create({ name: 'A' }); await s.create({ name: 'B' }); await s.create({ name: 'C' })
  s.clock.now = at(2026, 9, 14, 9, 1)
  await s.runner.tick()
  const statuses = () => s.log.all().map(r => r.status).sort()
  assert.deepEqual(statuses(), ['queued', 'running', 'running'])
  assert.equal(s.starts.length, 2)
  s.starts[0]!.finish({ outcome: 'completed', text: 'ok' })
  await until(() => s.starts.length === 3, 'third start')
  await until(() => s.log.all().filter(r => r.status === 'running').length === 2, 'two running')
})

async function writeIndex(indexDir: string, turns: Array<{ s: string; t: number }>) {
  await mkdir(indexDir, { recursive: true })
  await writeFile(join(indexDir, 'sessions.jsonl'), [...new Set(turns.map(t => t.s))].map(id => JSON.stringify({ id, provider: 'claude', cwd: '/work' })).join('\n') + '\n')
  await writeFile(join(indexDir, 'turns.jsonl'), turns.map((t, i) => JSON.stringify({ s: t.s, t: t.t, o: i, text: 'hi' })).join('\n') + '\n')
}

test('7a. sessions input with a window writes the manifest and records totals', async () => {
  const s = await setup()
  await writeIndex(s.indexDir, [{ s: 'sess-1', t: at(2026, 9, 14, 7) }, { s: 'sess-1', t: at(2026, 9, 14, 7, 30) }])
  const entry = await s.create({ name: 'Recap', window: 'today' })
  s.clock.now = entry.state.nextFireAt! + 60_000
  await s.runner.tick()
  const [run] = runsOf(s.log, 'recap')
  assert.equal(run!.status, 'running')
  assert.deepEqual(run!.manifestTotals, { sessions: 1, turns: 2 })
  const manifest = JSON.parse(await readFile(join(s.runsDir, run!.id, 'manifest.json'), 'utf8'))
  assert.equal(manifest.totals.turns, 2)
  assert.match(s.starts[0]!.input.transcript, /Inputs manifest/)
})

test('7b. sessions-only with an empty window skips with a note, or silently', async () => {
  const s = await setup()
  const note = await s.create({ name: 'Noted', window: 'today' })
  await s.create({ name: 'Quiet', window: 'today', whenEmpty: 'silent' })
  await s.create({ name: 'Mixed', window: 'today', inputs: ['sessions', 'memory'] })
  s.clock.now = note.state.nextFireAt! + 60_000
  await s.runner.tick()
  const noted = runsOf(s.log, 'noted')[0]!
  assert.equal(noted.status, 'skipped')
  assert.equal(noted.reason, 'nothing-in-window')
  assert.equal(noted.posted, true)
  assert.equal(noted.resultPreview, `Nothing since ${noted.window!.label.split(' → ')[0]}.`)
  const quiet = runsOf(s.log, 'quiet')[0]!
  assert.equal(quiet.status, 'skipped')
  assert.equal(quiet.posted, false)
  assert.equal(runsOf(s.log, 'mixed')[0]!.status, 'running')
  assert.equal(s.starts.length, 1)
})

test('7c. the window starts from the last successful run', async () => {
  const s = await setup()
  const entry = await s.create({ name: 'Recap', window: 'since-last-run' })
  const last = at(2026, 9, 13, 15)
  await s.log.upsert({
    id: 'prev', routineId: 'recap', name: 'Recap', key: 'recap@prev', kind: 'read-only', trigger: { type: 'manual' },
    status: 'done', firedAt: last, activity: [], posted: true, unread: false, speak: false,
  })
  s.clock.now = entry.state.nextFireAt! + 60_000
  await s.runner.tick()
  const run = runsOf(s.log, 'recap').find(r => r.id !== 'prev')!
  assert.equal(run.window!.start, last)
})

test('8. provider follows the Agent for agent routines; takes-actions always runs claude', async () => {
  const s = await setup({ agentProvider: 'codex', maxConcurrent: 5 })
  await s.create({ name: 'Follows' })
  await s.create({ name: 'Pinned', provider: 'claude' })
  await s.create({ name: 'Acts', kind: 'takes-actions', provider: 'agent' })
  await s.runner.runNow('follows'); await s.runner.runNow('pinned'); await s.runner.runNow('acts')
  const byId = new Map(s.starts.map(x => [x.input.definition.id, x.input.provider]))
  assert.equal(byId.get('follows'), 'codex')
  assert.equal(byId.get('pinned'), 'claude')
  assert.equal(byId.get('acts'), 'claude')
  assert.equal(runsOf(s.log, 'follows')[0]!.provider, 'codex')
})

test('9a. completion writes result.md, lifts proposals and posts unread', async () => {
  const s = await setup()
  await s.create({ name: 'Acts', kind: 'takes-actions' })
  const run = await s.runner.runNow('acts')
  assert.equal(run.key, `acts@manual:${run.id}`)
  const text = 'x'.repeat(700) + '\n```unmute-proposals\n[{"title":"Reply","detail":"Say hi"}]\n```'
  s.starts[0]!.finish({ outcome: 'completed', text, providerSessionId: 'ps-1' })
  await until(() => s.log.get(run.id)?.status === 'done', 'done')
  const done = s.log.get(run.id)!
  assert.equal(done.resultPath, join(s.runsDir, run.id, 'result.md'))
  assert.equal(await readFile(done.resultPath!, 'utf8'), 'x'.repeat(700))
  assert.equal(done.resultPreview, 'x'.repeat(600))
  assert.equal(done.proposals!.length, 1)
  assert.equal(done.proposals![0]!.state, 'open')
  assert.equal(done.posted, true)
  assert.equal(done.unread, true)
  assert.equal(done.providerSessionId, 'ps-1')
  assert.ok(done.endedAt)
})

test('9b. a provider failure settles failed and posts the error', async () => {
  const s = await setup()
  await s.create({ name: 'Recap' })
  const run = await s.runner.runNow('recap')
  s.starts[0]!.finish({ outcome: 'failed', error: 'boom' })
  await until(() => s.log.get(run.id)?.status === 'failed', 'failed')
  const failed = s.log.get(run.id)!
  assert.equal(failed.reason, 'provider')
  assert.equal(failed.error, 'boom')
  assert.equal(failed.resultPreview, "Couldn't finish: boom")
  assert.equal(failed.posted, true)
  assert.equal(failed.unread, true)
})

test('9c. a user cancel settles cancelled and posts nothing', async () => {
  const s = await setup()
  await s.create({ name: 'Recap' })
  const run = await s.runner.runNow('recap')
  assert.equal(await s.runner.cancel(run.id), true)
  assert.equal(s.starts[0]!.cancels, 1)
  s.starts[0]!.finish({ outcome: 'interrupted' })
  await until(() => s.log.get(run.id)?.status === 'cancelled', 'cancelled')
  assert.equal(s.log.get(run.id)!.posted, false)
  assert.equal(await s.runner.cancel('nope'), false)
})

test('9d. cancelling a queued run settles it cancelled without starting it', async () => {
  const s = await setup({ maxConcurrent: 1 })
  await s.create({ name: 'A' }); await s.create({ name: 'B' })
  await s.runner.runNow('a')
  const queued = await s.runner.runNow('b')
  assert.equal(queued.status, 'queued')
  assert.equal(await s.runner.cancel(queued.id), true)
  assert.equal(s.log.get(queued.id)!.status, 'cancelled')
  s.starts[0]!.finish({ outcome: 'completed', text: 'ok' })
  await new Promise(r => setTimeout(r, 30))
  assert.equal(s.starts.length, 1)
})

test('10. the budget timer interrupts and settles failed with timeout', async () => {
  const s = await setup()
  await s.create({ name: 'Recap', maxMinutes: 3 })
  const run = await s.runner.runNow('recap')
  const [budget] = s.timers.live(3 * 60_000)
  assert.ok(budget)
  budget!.fn()
  await until(() => s.starts[0]!.cancels === 1, 'cancel')
  s.starts[0]!.finish({ outcome: 'interrupted' })
  await until(() => s.log.get(run.id)?.status === 'failed', 'failed')
  const failed = s.log.get(run.id)!
  assert.equal(failed.reason, 'timeout')
  assert.equal(failed.error, 'Ran out of time after 3 min')
  assert.equal(failed.posted, true)
})

test('11. activity keeps 30 lines, persists at most once a second, and on settle', async () => {
  const s = await setup()
  await s.create({ name: 'Recap' })
  const run = await s.runner.runNow('recap')
  const onActivity = s.starts[0]!.input.onActivity
  const base = s.changes()
  for (let i = 0; i < 35; i++) onActivity(`line ${i}`)
  await until(() => s.changes() === base + 1, 'first activity persist')
  await new Promise(r => setTimeout(r, 20))
  assert.equal(s.changes(), base + 1)
  assert.equal(s.log.get(run.id)!.activity.length, 1)
  const pending = s.timers.timers.filter(t => !t.cleared && t.ms <= 1000)
  assert.equal(pending.length, 1)
  s.clock.now += 1000
  pending[0]!.fn()
  await until(() => s.log.get(run.id)!.activity.length === 30, 'throttled persist')
  assert.equal(s.log.get(run.id)!.activity[0]!.text, 'line 5')
  onActivity('last')
  s.starts[0]!.finish({ outcome: 'completed', text: 'ok' })
  await until(() => s.log.get(run.id)?.status === 'done', 'done')
  assert.equal(s.log.get(run.id)!.activity.at(-1)!.text, 'last')
})

test('12. an event fires every enabled event routine once per meeting', async () => {
  const s = await setup({ maxConcurrent: 5 })
  await s.create({ name: 'Notes', schedule: 'on meeting-notes-ready' })
  await s.create({ name: 'Paused', schedule: 'on meeting-notes-ready' })
  await s.store.setEnabled('paused', false)
  await s.create({ name: 'Clock' })
  const runs = await s.runner.event({ type: 'meeting-notes-ready', meetingId: 'm1', title: 'Standup', notesPath: '/n.md' })
  assert.deepEqual(runs.map(r => r.key), ['notes@event:m1'])
  assert.match(s.starts[0]!.input.transcript, /Meeting: Standup · id m1 · notes at \/n\.md/)
  assert.equal((await s.runner.event({ type: 'meeting-notes-ready', meetingId: 'm1' })).length, 0)
  await s.runner.event({ type: 'meeting-notes-ready', meetingId: 'm2' })
  assert.match(s.starts[1]!.input.transcript, /Meeting: Untitled meeting · id m2 · notes at \(not available\)/)
})

test('13. dismiss and approve a proposal; the child run settles the proposal', async () => {
  const s = await setup()
  await s.create({ name: 'Acts', kind: 'takes-actions' })
  const run = await s.runner.runNow('acts')
  s.starts[0]!.finish({ outcome: 'completed', text: 'Result body\n```unmute-proposals\n[{"title":"A","detail":"do a"},{"title":"B","detail":"do b"}]\n```' })
  await until(() => s.log.get(run.id)?.status === 'done', 'done')
  const [a, b] = s.log.get(run.id)!.proposals!

  const dismissed = await s.runner.decideProposal(run.id, b!.id, 'dismiss')
  assert.equal(dismissed!.proposals!.find(p => p.id === b!.id)!.state, 'dismissed')

  const approved = await s.runner.decideProposal(run.id, a!.id, 'approve')
  assert.equal(approved!.proposals!.find(p => p.id === a!.id)!.state, 'running')
  const child = s.log.all().find(r => r.trigger.type === 'approval')!
  assert.deepEqual(child.trigger, { type: 'approval', parentRunId: run.id, proposalId: a!.id })
  assert.equal(child.routineId, 'acts')
  assert.equal(child.key, `acts@approval:${child.id}`)
  assert.match(s.starts[1]!.input.transcript, /The user approved this action/)
  assert.match(s.starts[1]!.input.transcript, /Result body/)

  s.starts[1]!.finish({ outcome: 'completed', text: 'Did A.' })
  await until(() => s.log.get(run.id)!.proposals!.find(p => p.id === a!.id)!.state === 'done', 'proposal done')
  assert.equal(s.log.get(run.id)!.proposals!.find(p => p.id === a!.id)!.runId, child.id)
  assert.equal(await s.runner.decideProposal('missing', a!.id, 'dismiss'), null)
})

test('14. start settles runs left running or queued as interrupted', async () => {
  const s = await setup()
  const stale = (id: string, status: RoutineRun['status']): RoutineRun => ({
    id, routineId: 'gone', name: 'Gone', key: `gone@${id}`, kind: 'read-only', trigger: { type: 'manual' },
    status, firedAt: 1, activity: [], posted: false, unread: false, speak: false,
  })
  await s.log.upsert(stale('r1', 'running'))
  await s.log.upsert(stale('r2', 'queued'))
  await s.log.upsert({ ...stale('r3', 'done'), posted: true })
  await s.runner.start()
  for (const id of ['r1', 'r2']) {
    const run = s.log.get(id)!
    assert.equal(run.status, 'failed')
    assert.equal(run.reason, 'interrupted')
    assert.equal(run.resultPreview, 'Interrupted when Unmute restarted.')
    assert.equal(run.posted, true)
  }
  assert.equal(s.log.get('r3')!.status, 'done')
  assert.equal(s.timers.live(30_000).length, 1)
  await s.runner.dispose()
  assert.equal(s.timers.live(30_000).length, 0)
})

test('15. every state change upserts before onChange fires; markRead clears unread once', async () => {
  const s = await setup()
  await s.create({ name: 'Recap' })
  const seen: string[] = []
  const log = s.log
  const runner = new RoutineRunner({
    store: s.store, log, executor: { start: input => { void input; return { agentRunId: 'x', completion: new Promise(() => {}), cancel: async () => {} } }, dispose: async () => {} },
    runsDir: s.runsDir, indexDir: s.indexDir, excludeCwdPart: s.runsDir, agentProvider: () => 'claude', now: () => s.clock.now,
    setTimer: s.timers.setTimer, clearTimer: s.timers.clearTimer,
    onChange: () => { seen.push(log.all().map(r => r.status).join(',')) },
  })
  const run = await runner.runNow('recap')
  assert.deepEqual(seen, ['queued', 'running'])
  assert.equal(log.get(run.id)!.status, 'running')

  await s.log.upsert({ ...log.get(run.id)!, status: 'done', unread: true })
  await s.log.upsert({ ...log.get(run.id)!, id: 'other', key: 'k2', status: 'done', unread: true })
  seen.length = 0
  await runner.markRead()
  assert.equal(seen.length, 1)
  assert.ok(log.all().every(r => !r.unread))
  await runner.dispose()
})

test('fix: dispose settles running and queued runs as interrupted and ignores late completions', async () => {
  const s = await setup({ maxConcurrent: 1 })
  await s.create({ name: 'A' }); await s.create({ name: 'B' })
  const running = await s.runner.runNow('a')
  const queued = await s.runner.runNow('b')
  await s.runner.dispose()
  for (const id of [running.id, queued.id]) {
    const run = s.log.get(id)!
    assert.equal(run.status, 'failed')
    assert.equal(run.reason, 'interrupted')
    assert.equal(run.resultPreview, 'Interrupted when Unmute restarted.')
    assert.equal(run.posted, true)
    assert.equal(run.unread, true)
  }
  assert.equal(s.starts[0]!.cancels, 1)
  s.starts[0]!.finish({ outcome: 'interrupted' })
  await new Promise(r => setTimeout(r, 30))
  assert.equal(s.log.get(running.id)!.status, 'failed')
  assert.equal(s.starts.length, 1)
})

test('fix: dispose during the manifest phase still records interrupted', async () => {
  const s = await setup()
  await writeIndex(s.indexDir, [{ s: 'sess-1', t: MON_0800 - 60_000 }])
  await s.create({ name: 'Recap', window: 'today' })
  const pending = s.runner.runNow('recap')
  await new Promise(r => setImmediate(r))
  await s.runner.dispose()
  await pending
  await new Promise(r => setTimeout(r, 30))
  const [run] = runsOf(s.log, 'recap')
  assert.equal(run!.status, 'failed')
  assert.equal(run!.reason, 'interrupted')
  assert.equal(s.starts.length, 0)
})

test('fix: a budget timer after a user cancel keeps the run cancelled', async () => {
  const s = await setup()
  await s.create({ name: 'Recap', maxMinutes: 2 })
  const run = await s.runner.runNow('recap')
  await s.runner.cancel(run.id)
  s.timers.live(2 * 60_000)[0]!.fn()
  s.starts[0]!.finish({ outcome: 'interrupted' })
  await until(() => s.log.get(run.id)?.status === 'cancelled', 'cancelled')
})

test('fix: a failed save of a finished run is retried, never turned into a failure', async () => {
  let failNext = false
  const s = await setup({ persist: async (path, content) => { if (failNext) { failNext = false; throw new Error('disk full') } return writeFileAtomic(path, content) } })
  await s.create({ name: 'Recap' })
  const run = await s.runner.runNow('recap')
  failNext = true
  s.starts[0]!.finish({ outcome: 'completed', text: 'All good.' })
  await until(() => s.log.get(run.id)?.status === 'done', 'done')
  assert.equal(s.log.get(run.id)!.resultPreview, 'All good.')
})

async function approvedChild(s: Awaited<ReturnType<typeof setup>>) {
  await s.create({ name: 'Acts', kind: 'takes-actions', maxMinutes: 4 })
  const run = await s.runner.runNow('acts')
  s.starts[0]!.finish({ outcome: 'completed', text: 'Body\n```unmute-proposals\n[{"title":"A","detail":"do a"}]\n```' })
  await until(() => s.log.get(run.id)?.status === 'done', 'done')
  const proposal = s.log.get(run.id)!.proposals![0]!
  return { run, proposal }
}
const proposalState = (s: Awaited<ReturnType<typeof setup>>, runId: string) => s.log.get(runId)!.proposals![0]!

test('fix: two concurrent approves start exactly one child run', async () => {
  const s = await setup()
  const { run, proposal } = await approvedChild(s)
  await Promise.all([s.runner.decideProposal(run.id, proposal.id, 'approve'), s.runner.decideProposal(run.id, proposal.id, 'approve')])
  assert.equal(s.log.all().filter(r => r.trigger.type === 'approval').length, 1)
  assert.equal(s.starts.length, 2)
})

test('fix: a user-cancelled approval run reopens its proposal', async () => {
  const s = await setup()
  const { run, proposal } = await approvedChild(s)
  await s.runner.decideProposal(run.id, proposal.id, 'approve')
  const child = s.log.all().find(r => r.trigger.type === 'approval')!
  await s.runner.cancel(child.id)
  s.starts[1]!.finish({ outcome: 'interrupted' })
  await until(() => proposalState(s, run.id).state === 'open', 'proposal open')
  assert.equal(proposalState(s, run.id).runId, undefined)
  await s.runner.decideProposal(run.id, proposal.id, 'approve')
  assert.equal(s.log.all().filter(r => r.trigger.type === 'approval').length, 2)
})

test('fix: a timed-out or shut-down approval run fails its proposal', async () => {
  const s = await setup()
  const { run, proposal } = await approvedChild(s)
  await s.runner.decideProposal(run.id, proposal.id, 'approve')
  s.timers.live(4 * 60_000).at(-1)!.fn()
  s.starts[1]!.finish({ outcome: 'interrupted' })
  await until(() => proposalState(s, run.id).state === 'failed', 'proposal failed after timeout')

  const t = await setup()
  const second = await approvedChild(t)
  await t.runner.decideProposal(second.run.id, second.proposal.id, 'approve')
  await t.runner.dispose()
  assert.equal(proposalState(t, second.run.id).state, 'failed')
})
