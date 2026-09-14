import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RoutineService } from './service'
import { describeNext, nextFireAt, parseSchedule } from './schedule'
import type { ExecuteOutcome, RoutineExecutor } from './executor'
import type { RoutinesView } from './types'

const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime()

function fakeExecutor() {
  const finishes: Array<(o: Omit<ExecuteOutcome, 'agentRunId'>) => void> = []
  const executor: RoutineExecutor = {
    start() {
      let resolve!: (o: ExecuteOutcome) => void
      const completion = new Promise<ExecuteOutcome>(r => { resolve = r })
      finishes.push(o => resolve({ ...o, agentRunId: 'a' }))
      return { agentRunId: 'a', completion, cancel: async () => {} }
    },
    dispose: async () => {},
  }
  return { executor, finishes }
}

async function setup(enabled = true) {
  const root = await mkdtemp(join(tmpdir(), 'routines-'))
  const now = at(2026, 9, 14, 8)
  const { executor, finishes } = fakeExecutor()
  const views: RoutinesView[] = []
  const service = new RoutineService({
    root, executor, agentProvider: () => 'claude', emit: v => views.push(v), enabled, now: () => now, indexDir: join(root, 'index'),
  })
  await service.initialize()
  return { root, now, service, views, finishes }
}

test('create shows the item in the view with its next run label', async t => {
  const s = await setup()
  t.after(() => s.service.close())
  const { item, definitionPath } = await s.service.create({ name: 'Morning recap', schedule: 'daily 09:00', prompt: 'p' })
  assert.equal(definitionPath, join(s.root, 'routines', 'morning-recap.md'))
  assert.match(await readFile(definitionPath, 'utf8'), /name: Morning recap/)
  assert.equal(item.nextRunLabel, 'Today 09:00')
  const view = s.service.view()
  assert.equal(view.available, true)
  assert.deepEqual(view.items.map(i => i.id), ['morning-recap'])
  assert.equal(view.items[0]!.scheduleLabel, 'Daily at 09:00')
  assert.equal(s.views.at(-1)!.items.length, 1)
})

test('items sort by name; paused and event routines get their labels', async t => {
  const s = await setup()
  t.after(() => s.service.close())
  await s.service.create({ name: 'zeta', schedule: 'daily 09:00', prompt: 'p' })
  await s.service.create({ name: 'Alpha', schedule: 'on meeting-notes-ready', prompt: 'p' })
  await s.service.setEnabled('zeta', false)
  const [alpha, zeta] = s.service.view().items
  assert.equal(alpha!.name, 'Alpha')
  assert.equal(alpha!.nextRunLabel, 'After your next meeting')
  assert.equal(zeta!.nextRunLabel, 'Paused')
  assert.equal(zeta!.enabled, false)
})

test('update schedule changes nextRunAt; remove drops the item', async t => {
  const s = await setup()
  t.after(() => s.service.close())
  const { item } = await s.service.create({ name: 'Recap', schedule: 'daily 09:00', prompt: 'p' })
  const updated = await s.service.update('recap', { schedule: 'daily 10:30' })
  assert.notEqual(updated.nextRunAt, item.nextRunAt)
  assert.equal(updated.nextRunAt, nextFireAt(parseSchedule('daily 10:30'), s.now))
  assert.equal(updated.nextRunLabel, describeNext(updated.nextRunAt, s.now))
  await s.service.remove('recap')
  assert.deepEqual(s.service.view().items, [])
})

test('run now reports running, then lastRun, result text and runs', async t => {
  const s = await setup()
  t.after(() => s.service.close())
  await s.service.create({ name: 'Recap', schedule: 'daily 09:00', window: 'none', prompt: 'p' })
  const run = await s.service.runNow('recap')
  assert.equal(s.service.view().items[0]!.running, true)
  s.finishes[0]!({ outcome: 'completed', text: 'All good.' })
  for (let i = 0; i < 200 && s.service.run(run.id)?.status !== 'done'; i++) await new Promise(r => setTimeout(r, 5))
  const item = s.service.view().items[0]!
  assert.equal(item.running, false)
  assert.equal(item.lastRun!.status, 'done')
  assert.equal(await s.service.result(run.id), 'All good.')
  assert.equal(await s.service.result('missing'), null)
  assert.deepEqual(s.service.runs({ routineId: 'recap' }).map(r => r.id), [run.id])
  assert.equal(s.service.view().runs.at(-1)!.id, run.id)
})

test('disabled: view is unavailable and mutations throw', async t => {
  const s = await setup(false)
  t.after(() => s.service.close())
  const view = s.service.view()
  assert.equal(view.available, false)
  assert.equal(view.reason, 'Routines are turned off in Settings')
  await assert.rejects(s.service.create({ name: 'Recap', schedule: 'daily 09:00', prompt: 'p' }), /turned off in Settings/)
  await assert.rejects(s.service.runNow('recap'), /turned off in Settings/)
  assert.deepEqual(s.service.list(), [])
})
