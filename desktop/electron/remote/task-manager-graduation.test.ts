import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { TaskManager, DEFAULT_WARM_MS } from './task-manager.ts'
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

// ── A ONE-OFF IS NOT DISPOSABLE ──
//
// The window was 15 MINUTES, and reaching it did a FULL erase: remove() kills
// the runtime, drops the row, and fs.rm's the task's home directory. Working
// across several tasks at once, you look away from one for a quarter of an
// hour and it is gone — no card, no Finished, no warning. That is what
// happened on 2026-08-30, and the follow-up-count bug (above) only decided
// WHICH tasks it happened to.
//
// Two changes, and they are independent:
//   the window   15 minutes → 12 hours
//   the expiry   stop the runtime, KEEP the record
//
// The record surviving is the half that matters. A process is a cache and can
// be respawned; the conversation and its card cannot be un-deleted.

test('the warm window is twelve hours, not fifteen minutes', () => {
  assert.equal(DEFAULT_WARM_MS, 12 * 60 * 60_000)
})

test('an idle one-off loses its runtime but keeps its card', async () => {
  const baseDir = await tmpBase()
  let killed = false
  const ex = {
    get alive() { return !killed },
    async spawn() {}, async isReady() {},
    writeStdin() {}, write() {}, resize() {},
    onData() {}, kill() { killed = true },
  } as unknown as AgentExecutor
  // A window short enough to fire inside the test; the DEFAULT is asserted above.
  const tm = new TaskManager({
    executorFactory: () => ex, baseDir, trustAcceptMs: 0, submitConfirmMs: 0,
    pollMs: 10_000, staleMs: 10_000, warmMs: 40,
  })
  const id = await tm.dispatch('a one-off worth keeping')
  try {
    // Settle it the way the executor does — a real terminal state, not a test
    // hook reaching into the manager.
    await tm.setReportedStatus(id, { state: 'done' })
    await new Promise((r) => setTimeout(r, 250))

    assert.ok(tm.get(id), 'the card must survive its idle window')
    assert.equal(killed, true, 'the runtime is what expires')
    // The home directory is the receipt — fs.rm'ing it is what made this
    // unrecoverable, so its survival is the assertion that matters most.
    await fs.access(path.join(baseDir, 'local', id))
  } finally { tm.kill(id) }
})

// THE OTHER TWO ERASE PATHS. Fixing armWarmTimer alone would have been a
// half-fix: the maintenance sweep aged terminal one-offs by warmMs too, and
// rehydrate erased any whose window had lapsed while the app was closed. All
// three have to agree, or the record still disappears — just later, or on the
// next launch.

test('the maintenance sweep keeps a finished one-off past its warm window', async () => {
  const baseDir = await tmpBase()
  const tm = new TaskManager({
    executorFactory: () => stubExecutor(), baseDir, trustAcceptMs: 0, submitConfirmMs: 0,
    pollMs: 10_000, staleMs: 10_000,
    warmMs: 1,              // its runtime window has long lapsed
    purgeAgeMs: 60_000,     // but the record's has not
  })
  const id = await tm.dispatch('finished, and still wanted')
  try {
    await tm.setReportedStatus(id, { state: 'done' })
    await new Promise((r) => setTimeout(r, 50))

    await tm.purgeStale()

    assert.ok(tm.get(id), 'a lapsed runtime window is not a reason to delete the work')
    await fs.access(path.join(baseDir, 'local', id))
  } finally { tm.kill(id) }
})

test('a one-off whose window lapsed while the app was closed comes back as a card', async () => {
  const baseDir = await tmpBase()
  const first = manager(baseDir)
  const id = await first.dispatch('interrupted by a quit')
  await first.setReportedStatus(id, { state: 'done' })
  await new Promise((r) => setTimeout(r, 50))
  first.kill(id)

  // reattachPersistent only considers tasks whose tmux runtime is still alive,
  // so the case this covers is precise: the app was closed across the window,
  // the runtime outlived it, and the relaunch discovers a lapsed one-off.
  const second = new TaskManager({
    executorFactory: () => stubExecutor(), baseDir, trustAcceptMs: 0, submitConfirmMs: 0,
    pollMs: 10_000, staleMs: 10_000, warmMs: 1, purgeAgeMs: 60_000,
    listLiveRuntimeIds: async () => new Set([id]),
  })
  await second.rehydrate()
  // The lapsed-window erase lives in reattachPersistent, which runs right after
  // rehydrate on every launch — so the real sequence is both, in that order.
  await second.reattachPersistent()
  try {
    assert.ok(second.get(id), 'a relaunch must not erase what it just found')
  } finally { second.kill(id) }
})
