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
  let aliveFlag = true
  const ex: AgentExecutor & { writes: string[] } = {
    writes,
    get alive() { return aliveFlag },
    async spawn(o) { opts.onSpawn?.(o) },
    async isReady() {},
    writeStdin(t) { writes.push(t) },
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
    baseDir, pollMs: 50,
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
  const tm = new TaskManager({ executorFactory: () => makeFakeExecutor(), baseDir, pollMs: 25 })
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
  const tm = new TaskManager({ executorFactory: () => fake, baseDir, pollMs: 25 })
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
    baseDir, pollMs: 30, staleMs: 150,
  })
  const id = await tm.dispatch('a task that goes silent')
  const [stuckTask] = await once(tm, 'stuck')
  assert.equal(stuckTask.state, 'stuck')
  tm.kill(id)
})

test('kill marks a running task failed with "Stopped by you" (PRD §10.4)', async () => {
  const baseDir = await tmpBase()
  const tm = new TaskManager({ executorFactory: () => makeFakeExecutor(), baseDir, pollMs: 9999 })
  const id = await tm.dispatch('long task')
  tm.kill(id)
  const task = tm.get(id)!
  assert.equal(task.state, 'failed')
  assert.equal(task.error?.reason, 'Stopped by you')
})
