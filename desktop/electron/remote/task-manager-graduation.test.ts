import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { TaskManager } from './task-manager.ts'
import type { AgentExecutor } from './executor.ts'

// ── A ONE-OFF GRADUATES ON THE SECOND REPLY, EVEN ACROSS A RESTART ──
//
// FIELD FAILURE (2026-08-30). Two tasks the user worked with for hours were
// erased 15 minutes after their last turn, taking their home directories with
// them. Both were still `oneoff`, so armWarmTimer reaped them; neither had
// graduated, despite plenty of replies.
//
//   ef84c214  processing→done FIVE times between 13:54 and 14:37, erased 14:52
//   3a46ec7e  done→processing→done across two hours, erased 14:33
//
// The replies were counted — deliverAndNote calls noteFollowUp and always has.
// `followUps` was simply never PERSISTED: it lived on the in-memory Task and
// nowhere else, so `rehydrate` rebuilt every task from meta.json without it and
// the count restarted at zero. The app was relaunched 19 times that day (dev
// builds), three of them inside both tasks' lives. Graduation needs two
// follow-ups; the counter never survived long enough to reach them.
//
// The graduated KIND was durable (meta.kind), so a task that made it stayed a
// session forever — only the progress toward it evaporated. That asymmetry is
// what made this invisible.

async function tmpBase(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'remote-grad-'))
}

function stubExecutor(): AgentExecutor {
  return {
    get alive() { return true },
    async spawn() {}, async isReady() {},
    writeStdin() {}, write() {}, resize() {},
    onData() {}, kill() {},
  } as unknown as AgentExecutor
}

function manager(baseDir: string): TaskManager {
  return new TaskManager({
    executorFactory: () => stubExecutor(),
    baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 10_000, staleMs: 10_000,
  })
}

async function metaOf(baseDir: string, id: string): Promise<Record<string, unknown>> {
  const raw = await fs.readFile(path.join(baseDir, 'local', id, 'meta.json'), 'utf8')
  return JSON.parse(raw) as Record<string, unknown>
}

test('a follow-up is written to disk, not just counted in memory', async () => {
  const baseDir = await tmpBase()
  const tm = manager(baseDir)
  const id = await tm.dispatch('check the build')
  try {
    tm.followUp(id, 'is it done yet')
    // Persisted asynchronously alongside the rest of meta; give it a tick.
    await new Promise((r) => setTimeout(r, 50))

    assert.equal((await metaOf(baseDir, id)).followUps, 1)
  } finally { tm.kill(id) }
})

test('the count comes back after a restart instead of starting over', async () => {
  const baseDir = await tmpBase()
  const first = manager(baseDir)
  const id = await first.dispatch('go through the repo')
  first.followUp(id, 'and summarise it')
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(first.get(id)!.kind, 'oneoff', 'one reply is not yet a conversation')
  first.kill(id)

  // The app restarts — a new manager over the same store, as rehydrate does.
  const second = manager(baseDir)
  await second.rehydrate()
  try {
    // THE FIX, AND THE WHOLE FIX. Before it, meta.json carried `kind` but not
    // `followUps`, so this came back undefined and the next reply counted as
    // the FIRST — leaving the task a one-off for the warm timer to erase.
    assert.equal(second.get(id)?.followUps, 1, 'the count came back from disk')
    assert.equal(second.get(id)?.kind, 'oneoff', 'and it is still one reply short')
  } finally { second.kill(id) }
})

// Graduation itself is unchanged — two replies, as before. What changed is that
// the two no longer have to fall inside one app lifetime.
test('the second reply graduates, wherever the count came from', async () => {
  const baseDir = await tmpBase()
  const tm = manager(baseDir)
  const id = await tm.dispatch('a task with history')
  try {
    tm.followUp(id, 'one')
    assert.equal(tm.get(id)!.kind, 'oneoff')
    tm.followUp(id, 'two')
    assert.equal(tm.get(id)!.kind, 'session')
    await new Promise((r) => setTimeout(r, 50))
    assert.equal((await metaOf(baseDir, id)).followUps, 2, 'and the count is on disk')
  } finally { tm.kill(id) }
})

test('a task that already graduated stays a session across a restart', async () => {
  const baseDir = await tmpBase()
  const first = manager(baseDir)
  const id = await first.dispatch('a real conversation')
  first.followUp(id, 'one')
  first.followUp(id, 'two')
  assert.equal(first.get(id)!.kind, 'session')
  await new Promise((r) => setTimeout(r, 50))
  first.kill(id)

  const second = manager(baseDir)
  await second.rehydrate()
  try {
    assert.equal(second.get(id)!.kind, 'session')
  } finally { second.kill(id) }
})
