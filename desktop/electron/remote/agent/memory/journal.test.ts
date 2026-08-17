import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DurableMemoryMutationJournal, MemoryMutationJournalError } from './journal.ts'
import type { MemoryMutationIntent } from './journal.ts'

async function temporaryRoot(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'unmute-memory-journal-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

function intent(stage: MemoryMutationIntent['stage'] = 'intent'): MemoryMutationIntent {
  return {
    format: 'unmute-memory-mutation',
    version: 1,
    operation: 'store',
    memoryId: 'memory-1',
    stage,
    audit: {
      principalKind: 'unmute-agent',
      principalIdHash: 'a'.repeat(64),
      memoryId: 'memory-1',
      operation: 'store',
      at: 1_000,
      outcome: 'success',
    },
  }
}

test('durably survives restart with only content-free mutation intent and clears explicitly', async (t) => {
  const root = await temporaryRoot(t)
  const journal = new DurableMemoryMutationJournal({ root })

  await journal.begin(intent())
  const restarted = new DurableMemoryMutationJournal({ root })
  assert.deepEqual(await restarted.read(), intent())
  await restarted.checkpoint(intent('canonical'))
  assert.deepEqual(await journal.read(), intent('canonical'))

  const path = join(root, 'transactions', 'pending.json')
  const persisted = await readFile(path, 'utf8')
  assert.equal(persisted.includes('private content canary'), false)
  assert.equal(persisted.includes('/Users/alice'), false)
  assert.equal(persisted.includes('run-secret'), false)
  assert.equal((await stat(path)).mode & 0o777, 0o600)

  await restarted.clear()
  assert.equal(await journal.read(), undefined)
})

test('refuses to overwrite another pending intent and returns only typed path-free failures', async (t) => {
  const root = await temporaryRoot(t)
  const journal = new DurableMemoryMutationJournal({ root })
  await journal.begin(intent())

  await assert.rejects(journal.begin({
    ...intent(),
    memoryId: 'memory-2',
    audit: { ...intent().audit, memoryId: 'memory-2' },
  }), (error: unknown) => {
    assert(error instanceof MemoryMutationJournalError)
    assert.equal(error.code, 'pending-mutation')
    assert.equal(error.message.includes(root), false)
    return true
  })
})
