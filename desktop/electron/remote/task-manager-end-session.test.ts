// "End that task" from the Agent stops the process and KEEPS the task — the
// same promise the warm-idle expiry keeps (THE RUNTIME EXPIRES, THE RECORD
// DOES NOT). remove() is the only delete, and endSession must never become it.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskManager } from './task-manager'
import type { AgentExecutor } from './executor'

async function running() {
  const killed: number[] = []
  const ex: AgentExecutor = {
    alive: true,
    async spawn() {}, async isReady() {},
    writeStdin() {}, writeDraftText() {},
    async pasteImage() { return true },
    submitDraft() {},
    write() {}, resize() {}, onData() {}, kill() { killed.push(1); (ex as { alive: boolean }).alive = false },
  }
  const baseDir = await mkdtemp(join(tmpdir(), 'unmute-end-'))
  const manager = new TaskManager({ executorFactory: () => ex, baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 99_999 })
  const id = await manager.dispatch('fix the mic cutting out')
  return { manager, id, killed }
}

test('ending a working session releases its process and keeps the task', async () => {
  const { manager, id, killed } = await running()
  manager.get(id)!.state = 'processing'
  assert.equal(await manager.endSession(id), true)
  assert.ok(killed.length >= 1, 'the process was released')
  const task = manager.get(id)
  assert.ok(task, 'the task is kept')
  assert.equal(task!.state, 'failed')
  assert.equal(task!.error?.reason, 'Ended by you')
  assert.equal(manager.isLive(id), false)
})

test('ending an idle session settles it as done, not failed', async () => {
  const { manager, id } = await running()
  manager.get(id)!.state = 'needs-user'
  assert.equal(await manager.endSession(id), true)
  assert.equal(manager.get(id)!.state, 'done')
})

test('ending a task that does not exist reports false', async () => {
  const { manager, id } = await running()
  try { assert.equal(await manager.endSession('nope'), false) } finally { manager.kill(id) }
})
