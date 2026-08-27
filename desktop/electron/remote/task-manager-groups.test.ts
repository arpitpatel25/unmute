import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { TaskManager } from './task-manager.ts'
import { GroupRegistry } from './group-registry.ts'

// A TaskManager with a real registry and no executor: grouping is metadata, so
// none of it needs a session. Same discipline as the other pure-ish suites here.
let seq = 0
async function fixture() {
  const base = await fs.mkdtemp(join(tmpdir(), 'unmute-tm-groups-'))
  const registry = new GroupRegistry({
    path: join(base, 'groups.json'),
    now: () => 1_000,
    idFactory: () => `g${++seq}`,
  })
  await registry.load()
  const mgr = new TaskManager({
    executorFactory: () => { throw new Error('no executor in these tests') },
    baseDir: base,
    groupRegistry: registry,
  } as never)
  return { mgr, registry, base }
}

async function seed(mgr: TaskManager, title: string): Promise<string> {
  const id = await mgr.adoptCliSession({
    sessionId: `s-${title}`, title, cwd: '/tmp', lastActivityAt: 1_000,
  })
  assert.ok(id)
  return id!
}

test('setGroup files the task against a registry entry, and shows its label', async () => {
  const { mgr, registry } = await fixture()
  const id = await seed(mgr, 'notch freeze')
  mgr.setGroup(id, 'Unmute Cloud')

  const task = mgr.get(id)!
  assert.equal(task.group, 'Unmute Cloud', 'the label is what every surface renders')
  assert.ok(task.groupId, 'and the id is what it is actually filed under')
  assert.equal(registry.get(task.groupId!)?.label, 'Unmute Cloud')
})

test('two tasks grouped by differently-spelled labels land in ONE group', async () => {
  const { mgr } = await fixture()
  const a = await seed(mgr, 'first')
  const b = await seed(mgr, 'second')
  mgr.setGroup(a, 'unmute cloud')
  mgr.setGroup(b, 'Unmute-Cloud')

  assert.equal(mgr.get(a)!.groupId, mgr.get(b)!.groupId, 'this is the sprawl bug')
  // The label stays as the stream was first named, not as the second caller spelled it.
  assert.equal(mgr.get(b)!.group, 'unmute cloud')
})

test('renaming a group relabels its tasks without moving any of them', async () => {
  const { mgr } = await fixture()
  const a = await seed(mgr, 'first')
  mgr.setGroup(a, 'unmute')
  const filedUnder = mgr.get(a)!.groupId

  const moved = mgr.renameGroup('unmute', 'unmute cloud')

  assert.equal(moved, 1)
  assert.equal(mgr.get(a)!.group, 'unmute cloud')
  assert.equal(mgr.get(a)!.groupId, filedUnder, 'a rename must not re-file anything')
})

test('a rename onto an existing stream is refused rather than silently merging', async () => {
  const { mgr } = await fixture()
  const a = await seed(mgr, 'first')
  const b = await seed(mgr, 'second')
  mgr.setGroup(a, 'unmute')
  mgr.setGroup(b, 'launch video')

  assert.equal(mgr.renameGroup('launch video', 'Unmute'), 0)
  assert.equal(mgr.get(b)!.group, 'launch video', 'the refused rename changes nothing')
})

test('clearing a group leaves the task ungrouped, with nothing dangling', async () => {
  const { mgr } = await fixture()
  const a = await seed(mgr, 'first')
  mgr.setGroup(a, 'unmute')
  mgr.setGroup(a, null)
  assert.equal(mgr.get(a)!.group, undefined)
  assert.equal(mgr.get(a)!.groupId, undefined)
})

test('a task persisted before the registry existed migrates to an entry on rehydrate', async () => {
  // Every task on disk today carries a bare label string and no groupId. On
  // first launch they must resolve into entries — and two spellings of one
  // stream must collapse, which is the first dedup the user ever sees.
  const { mgr, registry, base } = await fixture()
  const a = await seed(mgr, 'first')
  const b = await seed(mgr, 'second')
  const homeA = mgr.get(a)!.home
  const homeB = mgr.get(b)!.home

  for (const [home, label] of [[homeA, 'unmute'], [homeB, 'Unmute']] as const) {
    const path = join(home, 'meta.json')
    const meta = JSON.parse(await fs.readFile(path, 'utf8')) as Record<string, unknown>
    delete meta.groupId
    await fs.writeFile(path, JSON.stringify({ ...meta, group: label }, null, 2))
  }

  const fresh = new TaskManager({
    executorFactory: () => { throw new Error('no executor') },
    baseDir: base,
    groupRegistry: registry,
  } as never)
  await fresh.rehydrate()

  const ra = fresh.list().find((t) => t.sessionId === 's-first')!
  const rb = fresh.list().find((t) => t.sessionId === 's-second')!
  assert.ok(ra.groupId, 'the bare label became a real entry')
  assert.equal(ra.groupId, rb.groupId, 'and the two spellings collapsed into one')
})
