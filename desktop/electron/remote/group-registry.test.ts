import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { GroupRegistry } from './group-registry.ts'

let seq = 0
const tmpPath = async (): Promise<string> => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'unmute-groups-'))
  return join(dir, 'groups.json')
}
const fixedIds = () => `g${++seq}`

const registry = async (opts: { now?: number } = {}) => {
  const r = new GroupRegistry({
    path: await tmpPath(),
    now: () => opts.now ?? 1_000,
    idFactory: fixedIds,
  })
  await r.load()
  return r
}

test('an unknown label mints an entry, and it is machine-authored', async () => {
  const r = await registry()
  const entry = r.resolve('launch video')
  assert.ok(entry)
  assert.equal(entry.label, 'launch video')
  assert.equal(entry.source, 'auto')
  assert.equal(r.list().length, 1)
})

test('a label that differs only by case or separator resolves to the SAME entry', async () => {
  const r = await registry()
  const first = r.resolve('unmute cloud')
  const again = r.resolve('Unmute-Cloud')
  assert.equal(again?.id, first?.id, 'must not mint a second entry')
  assert.equal(r.list().length, 1)
})

test('resolving keeps the label as first written — it is what the user sees', async () => {
  const r = await registry()
  r.resolve('Launch Video')
  const again = r.resolve('launch video')
  assert.equal(again?.label, 'Launch Video')
})

test('a blank label resolves to nothing rather than minting an empty group', async () => {
  const r = await registry()
  assert.equal(r.resolve(''), undefined)
  assert.equal(r.resolve('   '), undefined)
  assert.equal(r.resolve(null), undefined)
  assert.equal(r.list().length, 0)
})

test('entries survive a reload — the whole point of a registry', async () => {
  const path = await tmpPath()
  const a = new GroupRegistry({ path, now: () => 1_000, idFactory: fixedIds })
  await a.load()
  const minted = a.resolve('on-call')
  await a.flush()

  const b = new GroupRegistry({ path, now: () => 2_000, idFactory: fixedIds })
  await b.load()
  assert.equal(b.list().length, 1)
  assert.equal(b.get(minted!.id)?.label, 'on-call')
  // And a quiet stream rejoins its old entry instead of minting a new name.
  assert.equal(b.resolve('On Call')?.id, minted!.id)
})

test('a missing or corrupt file loads as empty rather than throwing', async () => {
  const path = await tmpPath()
  const missing = new GroupRegistry({ path, now: () => 1_000, idFactory: fixedIds })
  await missing.load()
  assert.deepEqual(missing.list(), [])

  await fs.writeFile(path, '{ not json')
  const corrupt = new GroupRegistry({ path, now: () => 1_000, idFactory: fixedIds })
  await corrupt.load()
  assert.deepEqual(corrupt.list(), [])
})

test('rename changes the label and keeps the id — tasks pointing at it never move', async () => {
  const r = await registry()
  const entry = r.resolve('unmute')!
  const out = r.rename(entry.id, 'Unmute Cloud')
  assert.equal(out.ok, true)
  assert.equal(r.get(entry.id)?.label, 'Unmute Cloud')
  assert.equal(r.list().length, 1)
  assert.equal(r.find('unmute-cloud')?.id, entry.id)
})

test('rename onto another live stream is refused, and says which one', async () => {
  const r = await registry()
  const a = r.resolve('unmute')!
  const b = r.resolve('launch video')!
  const out = r.rename(b.id, 'Unmute')
  assert.equal(out.ok, false)
  assert.equal(out.reason, 'duplicate')
  assert.equal(out.entry?.id, a.id)
  assert.equal(r.get(b.id)?.label, 'launch video', 'the refused rename must change nothing')
})

test('renaming an entry to what it already is succeeds and is a no-op', async () => {
  const r = await registry()
  const a = r.resolve('unmute')!
  const out = r.rename(a.id, 'Unmute')
  assert.equal(out.ok, true)
  assert.equal(r.get(a.id)?.label, 'Unmute')
})

test('a user-defined group is authored, not guessed', async () => {
  const r = await registry()
  const out = r.define('Launch Video')
  assert.equal(out.ok, true)
  assert.equal(out.entry?.source, 'user')
})

test('defining a group the router already minted adopts it instead of duplicating', async () => {
  const r = await registry()
  const auto = r.resolve('unmute')!
  const out = r.define('Unmute')
  assert.equal(out.ok, true)
  assert.equal(out.entry?.id, auto.id)
  assert.equal(out.entry?.source, 'user', 'the user naming it makes it theirs')
  assert.equal(r.list().length, 1)
})

test('an empty stream decays only when machine-authored, and only when idle', async () => {
  const path = await tmpPath()
  const r = new GroupRegistry({ path, now: () => 100_000, idFactory: fixedIds })
  await r.load()
  const stale = r.resolve('old experiment')!
  const mine = r.define('on-call').entry!
  const busy = r.resolve('unmute')!

  r.touch(stale.id, 1_000)
  r.touch(mine.id, 1_000)
  r.touch(busy.id, 1_000)

  const removed = r.prune({ liveIds: new Set([busy.id]), idleMs: 10_000 })

  assert.deepEqual(removed.map((e) => e.id), [stale.id])
  assert.ok(r.get(mine.id), 'a group the user authored is never pruned')
  assert.ok(r.get(busy.id), 'a group with live members is never pruned')
})

test('a recently quiet stream is kept, so it can be rejoined by name', async () => {
  const path = await tmpPath()
  const r = new GroupRegistry({ path, now: () => 5_000, idFactory: fixedIds })
  await r.load()
  const quiet = r.resolve('launch video')!
  r.touch(quiet.id, 4_000)
  assert.deepEqual(r.prune({ liveIds: new Set(), idleMs: 10_000 }), [])
  assert.ok(r.get(quiet.id))
})
