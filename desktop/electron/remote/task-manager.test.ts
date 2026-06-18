import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { TaskManager } from './task-manager.ts'
import type { AgentExecutor, SpawnOpts } from './executor.ts'

// A fake executor that records what's written and lets the test play "Claude"
// by writing the status file directly (atomic temp-then-rename, like the contract).
function makeFakeExecutor(opts: { onSpawn?: (o: SpawnOpts) => void } = {}) {
  const writes: string[] = []
  const raw: string[] = []
  const resizes: Array<[number, number]> = []
  let aliveFlag = true
  const ex: AgentExecutor & { writes: string[]; raw: string[]; resizes: Array<[number, number]> } = {
    writes,
    raw,
    resizes,
    get alive() { return aliveFlag },
    async spawn(o) { opts.onSpawn?.(o) },
    async isReady() {},
    writeStdin(t) { writes.push(t) },
    write(d) { raw.push(d) },
    resize(c, r) { resizes.push([c, r]) },
    onData() {},
    kill() { aliveFlag = false },
  }
  return ex
}

async function claudeWrites(statusPath: string, payload: object) {
  const tmp = statusPath + '.tmp'
  await fs.writeFile(tmp, JSON.stringify(payload))
  await fs.rename(tmp, statusPath) // atomic, per the contract
}

async function tmpBase(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'remote-tm-'))
}

test('dispatch → scaffolds, installs contract, types payload, starts processing', async () => {
  const baseDir = await tmpBase()
  let spawned: SpawnOpts | null = null
  const tm = new TaskManager({
    executorFactory: () => makeFakeExecutor({ onSpawn: (o) => { spawned = o } }),
    baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 50,
  })
  const id = await tm.dispatch('extract ~/Downloads/report.zip')
  const task = tm.get(id)!
  assert.equal(task.state, 'processing')
  // scaffolded status file exists
  assert.ok((await fs.stat(task.statusPath)).isFile())
  // CLAUDE.md installed in the session cwd
  assert.ok((await fs.readFile(path.join(task.cwd, 'CLAUDE.md'), 'utf8')).includes('Unmute Remote'))
  // dispatch payload typed, carrying the status path
  assert.ok(spawned, 'executor spawned')
  tm.kill(id) // stop polling
})

test('done status transition emits done with inline result (PRD §13.4 #3, §13.6)', { timeout: 5000 }, async () => {
  const baseDir = await tmpBase()
  const tm = new TaskManager({ executorFactory: () => makeFakeExecutor(), baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 25 })
  const id = await tm.dispatch('extract a zip')
  const task = tm.get(id)!

  const donePromise = once(tm, 'done')
  await claudeWrites(task.statusPath, {
    state: 'done',
    result: { summary: 'Extracted 12 files', artifacts: [{ type: 'path', value: '~/Downloads/report/' }] },
  })
  const [doneTask] = await donePromise
  assert.equal(doneTask.state, 'done')
  assert.equal(doneTask.result.summary, 'Extracted 12 files')
  assert.equal(tm.activeCount(), 0) // no longer counted as running
})

test('needs-user surfaces the question; answer() pipes it into stdin (PRD §7)', { timeout: 5000 }, async () => {
  const baseDir = await tmpBase()
  const fake = makeFakeExecutor()
  const tm = new TaskManager({ executorFactory: () => fake, baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 25 })
  const id = await tm.dispatch('send a file to rishi')
  const task = tm.get(id)!

  const needsUser = once(tm, 'needs-user')
  await claudeWrites(task.statusPath, {
    state: 'needs-user',
    question: { text: 'Which Rishi?', kind: 'choice', choices: ['A', 'B'] },
  })
  const [q] = await needsUser
  assert.equal(q.question.text, 'Which Rishi?')

  const before = fake.writes.length
  tm.answer(id, 'A')
  assert.equal(fake.writes.length, before + 1)
  assert.equal(fake.writes.at(-1), 'A') // answer piped to the session
  assert.equal(tm.get(id)!.state, 'processing') // optimistic resume
  tm.kill(id)
})

test('staleness backstop flags a silent task as stuck (PRD §6.3)', { timeout: 5000 }, async () => {
  const baseDir = await tmpBase()
  // Real-time aging (the scaffolded file's mtime is real wall-clock). Use a
  // tiny threshold so the file goes "stale" after ~150ms of no further writes.
  // (Mixing a fake clock with the file's real mtime would never match — the
  // comparison must be like-for-like.)
  const tm = new TaskManager({
    executorFactory: () => makeFakeExecutor(),
    baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 30, staleMs: 150,
  })
  const id = await tm.dispatch('a task that goes silent')
  const [stuckTask] = await once(tm, 'stuck')
  assert.equal(stuckTask.state, 'stuck')
  tm.kill(id)
})

test('kill marks a running task failed with "Stopped by you" (PRD §10.4)', async () => {
  const baseDir = await tmpBase()
  const tm = new TaskManager({ executorFactory: () => makeFakeExecutor(), baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 9999 })
  const id = await tm.dispatch('long task')
  tm.kill(id)
  const task = tm.get(id)!
  assert.equal(task.state, 'failed')
  assert.equal(task.error?.reason, 'Stopped by you')
})

test('done task stays WARM (session alive) for follow-up, then idle-kills', { timeout: 5000 }, async () => {
  const baseDir = await tmpBase()
  const fake = makeFakeExecutor()
  const tm = new TaskManager({ executorFactory: () => fake, baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 25, warmMs: 120 })
  const id = await tm.dispatch('check which emails are worth replying to')
  const task = tm.get(id)!
  const done = once(tm, 'done')
  await claudeWrites(task.statusPath, { state: 'done', result: { summary: '3 emails worth replying to' } })
  await done
  // session kept warm: still alive + listed as continuable
  assert.equal(fake.alive, true)
  assert.equal(tm.continuableTasks()[0]?.id, id)
  // after the warm window with no follow-up, it idle-kills
  await new Promise((r) => setTimeout(r, 200))
  assert.equal(fake.alive, false)
  assert.equal(tm.continuableTasks().length, 0)
})

test('followUp resumes a warm session — pipes text into stdin, back to processing', { timeout: 5000 }, async () => {
  const baseDir = await tmpBase()
  const fake = makeFakeExecutor()
  const tm = new TaskManager({ executorFactory: () => fake, baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 25, warmMs: 60_000 })
  const id = await tm.dispatch('check emails')
  const task = tm.get(id)!
  await (async () => { const d = once(tm, 'done'); await claudeWrites(task.statusPath, { state: 'done', result: { summary: 'done' } }); await d })()
  const before = fake.writes.length
  const ok = tm.followUp(id, 'reply to the second one')
  assert.equal(ok, true)
  assert.equal(fake.writes.length, before + 1)
  // A follow-up re-sends the FULL dispatch payload (not raw text) so the model is
  // re-anchored to the contract — the intent plus the status-file path.
  assert.ok(fake.writes.at(-1)!.includes('reply to the second one')) // the new intent
  assert.ok(fake.writes.at(-1)!.includes(task.statusPath))            // status-file path re-sent
  assert.equal(tm.get(id)!.state, 'processing')
  tm.kill(id)
})

test('followUp returns false when the session is no longer warm', async () => {
  const baseDir = await tmpBase()
  const fake = makeFakeExecutor()
  const tm = new TaskManager({ executorFactory: () => fake, baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 9999, warmMs: 60_000 })
  const id = await tm.dispatch('a task')
  tm.kill(id) // hard kill — no warm window
  assert.equal(tm.followUp(id, 'continue'), false)
  assert.equal(tm.continuableTasks().length, 0)
})

test('sendInput forwards RAW keystrokes to the PTY (typeable terminal, PRD §4.3)', async () => {
  const baseDir = await tmpBase()
  const fake = makeFakeExecutor()
  const tm = new TaskManager({ executorFactory: () => fake, baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 9999 })
  const id = await tm.dispatch('a task')
  fake.raw.length = 0 // ignore dispatch's submit-confirm Enter; test the typeable path
  tm.sendInput(id, 'ls') // two keystrokes
  tm.sendInput(id, '\r') // Enter — sent verbatim, NO extra \r appended
  assert.deepEqual(fake.raw, ['ls', '\r'])
  tm.kill(id)
})

test('resize forwards cols/rows to the PTY', async () => {
  const baseDir = await tmpBase()
  const fake = makeFakeExecutor()
  const tm = new TaskManager({ executorFactory: () => fake, baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 9999 })
  const id = await tm.dispatch('a task')
  tm.resize(id, 100, 30)
  assert.deepEqual(fake.resizes.at(-1), [100, 30])
  tm.kill(id)
})

test('tasksAwaitingUser lists only needs-user tasks, newest first (voice answering, PRD §7)', { timeout: 5000 }, async () => {
  const baseDir = await tmpBase()
  const tm = new TaskManager({ executorFactory: () => makeFakeExecutor(), baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 25 })
  const a = await tm.dispatch('task A')
  const b = await tm.dispatch('task B')
  // A goes needs-user; B stays processing.
  const wait = once(tm, 'needs-user')
  await claudeWrites(tm.get(a)!.statusPath, { state: 'needs-user', question: { text: 'Which one?' } })
  await wait
  const awaiting = tm.tasksAwaitingUser()
  assert.deepEqual(awaiting.map((t) => t.id), [a])
  tm.kill(a); tm.kill(b)
})

test('remove kills the session, erases the row, and deletes the scratch dir', async () => {
  const baseDir = await tmpBase()
  const tm = new TaskManager({ executorFactory: () => makeFakeExecutor(), baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 9999 })
  const id = await tm.dispatch('a task')
  const dir = tm.get(id)!.cwd
  assert.ok((await fs.stat(dir)).isDirectory())
  await tm.remove(id)
  assert.equal(tm.get(id), undefined)        // gone from the list
  await assert.rejects(fs.stat(dir))         // scratch dir deleted
})

test('killAll terminates every session and marks running tasks stopped (PRD §10.4)', async () => {
  const baseDir = await tmpBase()
  const tm = new TaskManager({ executorFactory: () => makeFakeExecutor(), baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 9999 })
  const a = await tm.dispatch('a')
  const b = await tm.dispatch('b')
  tm.killAll()
  assert.equal(tm.get(a)!.state, 'failed')
  assert.equal(tm.get(b)!.state, 'failed')
  assert.equal(tm.activeCount(), 0)
})
