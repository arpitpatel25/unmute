import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileOwnershipStore } from './codex-ownership'
import { codexIdentityFile } from './codex-identity'
import { createHash } from 'node:crypto'

test('upgrade repairs the old job receipt while its old runtime remains alive', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-job-recovery-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const root = join(dir, 'continuity-v4', 'codex')
  await mkdir(root, { recursive: true })
  await writeFile(join(root, `${'a'.repeat(64)}.json`), JSON.stringify({ threadId: 'child', forkedFromId: 'parent' }))
  const store = fileOwnershipStore(dir, 'continuity-v4')
  assert.equal(await store.recoverIdentity!('unrelated', 'parent'), null)
  store.remember('job')
  assert.equal(await store.recoverIdentity!('job', 'parent'), null, 'generation ownership is not ownership of an anonymous fork')
  await writeFile(join(root, `${'b'.repeat(64)}.json`), JSON.stringify({ threadId: 'other-child', forkedFromId: 'parent' }))
  assert.equal(await store.recoverIdentity!('job', 'parent'), null)
  await writeFile(codexIdentityFile(root, 'job'), JSON.stringify({ taskId: 'job', threadId: 'parent' }))
  assert.equal((await store.recoverIdentity!('job', 'parent'))?.threadId, 'parent', 'an exact task receipt outranks anonymous forks that may belong to other cards')
})

test('legacy recovery reads only the exact task operation and never follows another card’s child', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-chain-recovery-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const root = join(dir, 'continuity-v4', 'codex')
  await mkdir(root, { recursive: true })
  const store = fileOwnershipStore(dir, 'continuity-v4'); store.remember('job')
  const exact = createHash('sha256').update(JSON.stringify(['job', 'parent', 'fork'])).digest('hex')
  await writeFile(join(root, `${exact}.json`), JSON.stringify({ threadId: 'child', forkedFromId: 'parent' }))
  await writeFile(join(root, `${'b'.repeat(64)}.json`), JSON.stringify({ threadId: 'grandchild', forkedFromId: 'child' }))
  assert.equal((await store.recoverIdentity!('job', 'parent'))?.threadId, 'child')
  await writeFile(join(root, `${'c'.repeat(64)}.json`), JSON.stringify({ threadId: 'parent', forkedFromId: 'grandchild' }))
  assert.equal((await store.recoverIdentity!('job', 'parent'))?.threadId, 'child')
})

test('a remembered task id is still there for the next process', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-own-'))
  try {
    fileOwnershipStore(dir, 'continuity-v4').remember('task-a')
    assert.deepEqual([...fileOwnershipStore(dir, 'continuity-v4').initial()], ['task-a'])
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('generations do not read each other ownership', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-own-'))
  try {
    fileOwnershipStore(dir, 'continuity-v3').remember('v3-task')
    fileOwnershipStore(dir, 'continuity-v4').remember('v4-task')
    assert.deepEqual([...fileOwnershipStore(dir, 'continuity-v3').initial()], ['v3-task'])
    assert.deepEqual([...fileOwnershipStore(dir, 'continuity-v4').initial()], ['v4-task'])
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('remembering the same task twice does not duplicate it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-own-'))
  try {
    const store = fileOwnershipStore(dir, 'continuity-v4')
    store.remember('task-a')
    store.remember('task-a')
    assert.deepEqual([...fileOwnershipStore(dir, 'continuity-v4').initial()], ['task-a'])
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('blank lines in the ownership file are ignored', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-own-'))
  try {
    await writeFile(join(dir, 'codex-ownership-continuity-v4.txt'), 'task-a\n\n   \ntask-b\n')
    assert.deepEqual([...fileOwnershipStore(dir, 'continuity-v4').initial()], ['task-a', 'task-b'])
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('a missing directory reports no ownership instead of throwing at startup', async () => {
  const store = fileOwnershipStore(join(tmpdir(), `codex-own-absent-${Date.now()}`), 'continuity-v4')
  assert.deepEqual([...store.initial()], [])
})

test('unreadable ownership never masquerades as an unowned task', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-own-invalid-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await mkdir(join(dir, 'codex-ownership-continuity-v4.txt'))
  const store = fileOwnershipStore(dir, 'continuity-v4')
  assert.throws(() => store.initial())
  assert.throws(() => store.remember('task'))
})
