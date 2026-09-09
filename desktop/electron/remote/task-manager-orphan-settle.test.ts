// A Codex task leaves `processing` only when a live worker delivers
// `task_complete`. When nothing is attached at the moment the turn ends — the
// worker was reaped, the app restarted, the route broke — that event is dropped
// and the card spins on "Working" forever with no Stop button, because there is
// no live turn to stop.
//
// Measured 2026-09-09: task 35085ff1 finished at 23:28 with `task_complete`
// already on disk and was still showing "Working 5h" an hour later; every
// resume failed with `-32600 already has an active writer` against a thread a
// superseded worker still held. The rollout is append-only and is the thread's
// own record, so it can always answer the question the event stream dropped.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskManager } from './task-manager'
import type { AgentExecutor } from './executor'

const started = () => JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } })
const complete = (message: string) =>
  JSON.stringify({ timestamp: '2026-09-09T17:58:35.908Z', type: 'event_msg', payload: { type: 'task_complete', last_agent_message: message } })

async function orphanedCodexTask(rollout: string[]) {
  const ex: AgentExecutor = {
    alive: false,
    async spawn() {}, async isReady() {},
    writeStdin() {}, writeDraftText() {},
    async pasteImage() { return true },
    submitDraft() {},
    write() {}, resize() {}, onData() {}, kill() {},
  }
  const baseDir = await mkdtemp(join(tmpdir(), 'unmute-orphan-'))
  const rolloutPath = join(baseDir, 'rollout.jsonl')
  await writeFile(rolloutPath, rollout.join('\n') + '\n')

  const manager = new TaskManager({
    executorFactory: () => ex, baseDir,
    trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 99_999,
    // Stands in for the ~/.codex/sessions lookup; the thread is real, the
    // search path is not something a unit test should depend on.
    rolloutPathFor: async (threadId: string) => (threadId === 'thread-x' ? rolloutPath : null),
  })
  const id = await manager.dispatch('build the platform registry')
  const task = manager.get(id)!
  task.agent = 'codex'
  task.codexRolloutId = 'thread-x'
  task.state = 'processing'
  return { manager, id }
}

test('a task orphaned mid-turn is settled from its own rollout instead of spinning forever', async () => {
  const { manager, id } = await orphanedCodexTask([started(), complete('All 244 tests pass.')])
  try {
    assert.equal(await manager.settleFromRollout(id), true)
    assert.equal(manager.get(id)!.state, 'done')
  } finally { manager.kill(id) }
})

test('a task whose turn is genuinely still open is left alone', async () => {
  const { manager, id } = await orphanedCodexTask([started(), complete('first'), started()])
  try {
    assert.equal(await manager.settleFromRollout(id), false)
    assert.equal(manager.get(id)!.state, 'processing')
  } finally { manager.kill(id) }
})

test('an unreadable rollout leaves the task untouched rather than guessing it finished', async () => {
  const { manager, id } = await orphanedCodexTask([started(), complete('done')])
  manager.get(id)!.codexRolloutId = 'thread-that-does-not-exist'
  try {
    assert.equal(await manager.settleFromRollout(id), false)
    assert.equal(manager.get(id)!.state, 'processing')
  } finally { manager.kill(id) }
})

test('a task that is not processing is never re-settled', async () => {
  const { manager, id } = await orphanedCodexTask([started(), complete('done')])
  manager.get(id)!.state = 'needs-user'
  try {
    assert.equal(await manager.settleFromRollout(id), false)
    assert.equal(manager.get(id)!.state, 'needs-user')
  } finally { manager.kill(id) }
})
