import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileOwnershipStore } from './codex-ownership'

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
