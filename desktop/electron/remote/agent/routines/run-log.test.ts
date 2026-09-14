import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RoutineRunLog } from './run-log'
import type { RoutineRun } from './types'

async function tempPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'routines-'))
  return join(dir, 'runs.json')
}

function run(overrides: Partial<RoutineRun> & { id: string }): RoutineRun {
  return {
    routineId: 'r', name: 'R', key: overrides.id, kind: 'read-only', trigger: { type: 'manual' }, status: 'done',
    firedAt: 1000, activity: [], posted: true, unread: false, speak: false, ...overrides,
  }
}

test('upsert then reload keeps the run', async () => {
  const path = await tempPath()
  const log = new RoutineRunLog({ path })
  await log.upsert(run({ id: 'a' }))
  const reloaded = new RoutineRunLog({ path })
  const runs = await reloaded.load()
  assert.equal(runs.length, 1)
  assert.equal(reloaded.get('a')?.id, 'a')
})

test('hasKey', async () => {
  const path = await tempPath()
  const log = new RoutineRunLog({ path })
  await log.upsert(run({ id: 'a', key: 'a@2026-09-14' }))
  assert.equal(log.hasKey('a@2026-09-14'), true)
  assert.equal(log.hasKey('nope'), false)
})

test('30 concurrent upserts all survive', async () => {
  const path = await tempPath()
  const log = new RoutineRunLog({ path })
  await Promise.all(Array.from({ length: 30 }, (_, i) => log.upsert(run({ id: `run-${i}`, firedAt: i }))))
  assert.equal(log.all().length, 30)
  const text = await readFile(path, 'utf8')
  assert.equal((JSON.parse(text) as RoutineRun[]).length, 30)
})

test('cap trims oldest terminal runs but never running ones', async () => {
  const path = await tempPath()
  const log = new RoutineRunLog({ path, max: 3 })
  await log.upsert(run({ id: 'a', status: 'running', firedAt: 0 }))
  await log.upsert(run({ id: 'b', status: 'done', firedAt: 1 }))
  await log.upsert(run({ id: 'c', status: 'done', firedAt: 2 }))
  await log.upsert(run({ id: 'd', status: 'done', firedAt: 3 }))
  const ids = log.all().map(r => r.id)
  assert.equal(ids.length, 3)
  assert.ok(ids.includes('a'), 'running run must survive the cap')
  assert.ok(!ids.includes('b'), 'oldest terminal run must be trimmed first')
})

test('a corrupt file is quarantined', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'routines-'))
  const path = join(dir, 'runs.json')
  const { writeFile } = await import('node:fs/promises')
  await writeFile(path, '{ not json', 'utf8')
  const log = new RoutineRunLog({ path })
  const runs = await log.load()
  assert.deepEqual(runs, [])
  const { readdir } = await import('node:fs/promises')
  const files = await readdir(dir)
  assert.ok(files.some(f => /^runs\.json\.corrupt-\d+$/.test(f)))
})

test('missing file loads as empty', async () => {
  const path = await tempPath()
  const log = new RoutineRunLog({ path })
  assert.deepEqual(await log.load(), [])
})

test('lastSuccess: newest done, or skipped nothing-in-window, ignores others', async () => {
  const path = await tempPath()
  const log = new RoutineRunLog({ path })
  await log.upsert(run({ id: 'a', routineId: 'r1', status: 'failed', firedAt: 5 }))
  await log.upsert(run({ id: 'b', routineId: 'r1', status: 'done', firedAt: 10 }))
  await log.upsert(run({ id: 'c', routineId: 'r1', status: 'skipped', reason: 'nothing-in-window', firedAt: 20 }))
  await log.upsert(run({ id: 'd', routineId: 'r1', status: 'skipped', reason: 'missed', firedAt: 30 }))
  assert.equal(log.lastSuccess('r1')?.id, 'c')
  assert.equal(log.lastSuccess('nope'), undefined)
})
