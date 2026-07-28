import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs, utimesSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { TaskManager } from './task-manager.ts'
import { writeRecipe } from './recipe-store.ts'
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
  // sessionId minted, set on the task, passed to the spawn (→ --session-id), and persisted.
  assert.ok(task.sessionId, 'task carries a minted sessionId')
  assert.equal(spawned!.sessionId, task.sessionId, 'sessionId handed to the executor for --session-id')
  const meta = JSON.parse(await fs.readFile(path.join(task.cwd, 'meta.json'), 'utf8'))
  assert.equal(meta.sessionId, task.sessionId, 'sessionId persisted in meta.json')
  tm.kill(id) // stop polling
})

test('resume NUDGES an unfinished (interrupted) task to continue, and goes back to processing', async () => {
  const baseDir = await tmpBase()
  const fake = makeFakeExecutor()
  const tm = new TaskManager({ executorFactory: () => fake, baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 9999 })
  // Simulate an interrupted task: a meta receipt + a NON-done status on disk.
  const tid = randomUUID()
  const dir = path.join(baseDir, 'local', tid)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify({ id: tid, intent: 'scroll my feed', createdAt: Date.now() }))
  await claudeWrites(path.join(dir, 'status.json'), { state: 'processing' })
  await tm.rehydrate() // rehydrate sets no executor, so resume will spawn a fresh one
  const ok = await tm.resume(tid)
  assert.equal(ok, true)
  // A continuation nudge was typed (re-grounding it with the original intent).
  assert.ok(fake.writes.some((w) => /resumed|continue/i.test(w) && w.includes('scroll my feed')),
    'a continue nudge carrying the intent was sent')
  assert.equal(tm.get(tid)!.state, 'processing') // tracking again
  tm.kill(tid) // stop polling so the test process exits cleanly
})

test('resume does NOT nudge a task that already completed (no regression to the finished case)', async () => {
  const baseDir = await tmpBase()
  const fake = makeFakeExecutor()
  const tm = new TaskManager({ executorFactory: () => fake, baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 9999 })
  const tid = randomUUID()
  const dir = path.join(baseDir, 'local', tid)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify({ id: tid, intent: 'find a file', createdAt: Date.now() }))
  await claudeWrites(path.join(dir, 'status.json'), { state: 'done', result: { summary: 'found it' } })
  await tm.rehydrate()
  const ok = await tm.resume(tid)
  assert.equal(ok, true)
  // Only the empty folder-trust accept — NO continue nudge.
  assert.ok(!fake.writes.some((w) => /resumed|continue now/i.test(w)), 'no nudge for a finished task')
  assert.equal(tm.get(tid)!.state, 'done') // stays done, warm and waiting
  tm.kill(tid) // cancel the warm timer so the test process exits cleanly
})

test('resume ANNOUNCES ITSELF before the spawn, so the click is never silent', { timeout: 5000 }, async () => {
  // Resume is seconds long: spawn, isReady, a 2s trust-accept wait, a status
  // read, the nudge, a 450ms submit wait — and the state only changed at the
  // very END. Nothing moved in between, so a working Resume was indistinguishable
  // from a dead button, and users pressed it again (which is the race the
  // `resuming` guard exists for).
  const baseDir = await tmpBase()
  let releaseSpawn: () => void = () => {}
  const spawnBlocked = new Promise<void>((r) => { releaseSpawn = r })
  const fake = makeFakeExecutor()
  const slow: AgentExecutor = { ...fake, spawn: async () => { await spawnBlocked } }
  const tm = new TaskManager({ executorFactory: () => slow, baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 9999 })
  const tid = randomUUID()
  const dir = path.join(baseDir, 'local', tid)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify({ id: tid, intent: 'scroll my feed', createdAt: Date.now() }))
  await claudeWrites(path.join(dir, 'status.json'), { state: 'processing' })
  await tm.rehydrate()

  // Wait on the EVENT, not on a tick: resume does async fs work (resolving the
  // transcript) before it ever reaches the spawn, so a fixed tick count is a
  // race. This resolves only if the announcement really is emitted early.
  const announced = new Promise<void>((resolve) => {
    tm.on('updated', (t: { id: string; resuming?: boolean }) => { if (t.id === tid && t.resuming) resolve() })
  })
  const inFlight = tm.resume(tid) // do NOT await — we want the middle
  await announced                 // still inside the blocked spawn
  assert.equal(tm.get(tid)!.resuming, true, 'the task must read as resuming WHILE the spawn is still going')

  releaseSpawn()
  await inFlight
  assert.equal(tm.get(tid)!.resuming ?? false, false, 'and must stop reading as resuming once it lands')
  tm.kill(tid)
})

test('a FAILED resume says so — it never just reverts in silence', async () => {
  // Every failure path in resume() logged and returned false. The caller
  // (`void api().remoteResume?.(id)`) discards that, so a resume that could not
  // possibly work looked exactly like one that had not been clicked. This is what
  // made the 2026-07-28 backend crossing take an hour to even identify.
  const baseDir = await tmpBase()
  const tm = new TaskManager({
    executorFactory: () => { throw new Error('AGENT_SEPARATION_VIOLATION: codex-desktop has no PTY executor') },
    baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 9999,
  })
  const tid = randomUUID()
  const dir = path.join(baseDir, 'local', tid)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify({ id: tid, intent: 'scroll my feed', createdAt: Date.now() }))
  await claudeWrites(path.join(dir, 'status.json'), { state: 'processing' })
  await tm.rehydrate()

  const failures: Array<{ taskId: string; error: string }> = []
  tm.on('resume-failed', (p: { taskId: string; error: string }) => failures.push(p))

  const ok = await tm.resume(tid)

  assert.equal(ok, false)
  assert.equal(failures.length, 1, 'the failure must be announced, not only logged')
  assert.match(failures[0].error, /AGENT_SEPARATION_VIOLATION/, 'and must carry the reason')
  assert.match(tm.get(tid)!.resumeError ?? '', /AGENT_SEPARATION_VIOLATION/, 'the card must be able to show it')
  assert.equal(tm.get(tid)!.resuming ?? false, false, 'the in-flight flag must clear on failure too')
})

test('rehydrate recovers sessionId from meta.json, falling back to the task id for old receipts', async () => {
  const baseDir = await tmpBase()
  const root = path.join(baseDir, 'local')
  // A new-style receipt carrying a sessionId, and an old-style one without.
  const withSid = randomUUID(); const oldNoSid = randomUUID()
  for (const [tid, sid] of [[withSid, 'sess-abc'], [oldNoSid, null]] as const) {
    const dir = path.join(root, tid)
    await fs.mkdir(dir, { recursive: true })
    const meta: Record<string, unknown> = { id: tid, intent: 'x', createdAt: Date.now() }
    if (sid) meta.sessionId = sid
    await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta))
  }
  const tm = new TaskManager({ executorFactory: () => makeFakeExecutor(), baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 9999 })
  await tm.rehydrate()
  assert.equal(tm.get(withSid)!.sessionId, 'sess-abc')   // recovered as written
  assert.equal(tm.get(oldNoSid)!.sessionId, oldNoSid)    // fallback to task id
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

test('deterministic hook heartbeat keeps a silent task alive; it goes stuck once activity stops', { timeout: 5000 }, async () => {
  const baseDir = await tmpBase()
  const tm = new TaskManager({
    executorFactory: () => makeFakeExecutor(),
    baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 30, staleMs: 200,
  })
  const id = await tm.dispatch('a long task that works without writing status')
  const cwd = tm.get(id)!.cwd
  const activity = path.join(cwd, '.unmute-activity')
  // Simulate PostToolUse firing every 60ms (real progress, NO status writes).
  const beat = setInterval(() => { void fs.writeFile(activity, '') }, 60)
  await new Promise((r) => setTimeout(r, 500)) // > 2x staleMs with no status write
  assert.notEqual(tm.get(id)!.state, 'stuck', 'hook heartbeat kept the silent task alive')
  // Activity stops → no heartbeat, no status → the backstop must still fire.
  clearInterval(beat)
  const [stuckTask] = await once(tm, 'stuck')
  assert.equal(stuckTask.state, 'stuck', 'still goes stuck once genuinely silent')
  tm.kill(id)
})

test('rehydrate() rebuilds task rows from disk after a restart (crash recovery)', async () => {
  const baseDir = await tmpBase()
  // Simulate a task left on disk by a previous (crashed) run.
  const id = 'aaaaaaaa-1111-2222-3333-444444444444'
  const dir = path.join(baseDir, 'local', id)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify({ id, intent: 'analyze fastlane', createdAt: Date.now() }))
  await claudeWrites(path.join(dir, 'status.json'), {
    state: 'done', category: 'act', result: { summary: 'created the analysis folder' },
  })

  const tm = new TaskManager({ executorFactory: () => makeFakeExecutor(), baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 9999 })
  const created = once(tm, 'created')
  await tm.rehydrate()
  const [t] = await created

  const task = (t as { id: string }).id === id ? (t as { intent: string; state: string; result?: { summary?: string } }) : null
  assert.ok(task, 'rehydrated the crashed task')
  assert.equal(task!.intent, 'analyze fastlane', 'intent recovered from meta.json')
  assert.equal(task!.state, 'done', 'last state recovered from status.json')
  assert.equal(task!.result?.summary, 'created the analysis folder', 'result recovered')
  assert.equal(tm.get(id)?.id, id, 'task is back in the live list (viewable + resumable)')
})

test('rehydrate() surfaces an interrupted (non-terminal) task as failed, still resumable', async () => {
  const baseDir = await tmpBase()
  const id = 'bbbbbbbb-1111-2222-3333-444444444444'
  const dir = path.join(baseDir, 'local', id)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify({ id, intent: 'long running task', createdAt: Date.now() }))
  await claudeWrites(path.join(dir, 'status.json'), { state: 'processing', step: 'mid-flight' })

  const tm = new TaskManager({ executorFactory: () => makeFakeExecutor(), baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 9999 })
  await tm.rehydrate()
  const task = tm.get(id)!
  assert.equal(task.state, 'failed', 'mid-run task whose session died shows as failed, not forever-processing')
  assert.match(task.error?.reason ?? '', /interrupted/i)
})

test('a later hook event must NOT hide a status write (false-stuck regression)', { timeout: 5000 }, async () => {
  const baseDir = await tmpBase()
  const tm = new TaskManager({
    executorFactory: () => makeFakeExecutor(),
    baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 25, staleMs: 100_000,
  })
  const id = await tm.dispatch('check my emails')
  const task = tm.get(id)!
  // Simulate the production race: hook activity (PostToolUse/Stop) raced AHEAD of
  // the model's 'done' write, so the liveness clock is far in the future...
  task.lastHeartbeatMs = Date.now() + 60_000
  // ...then the doer writes its terminal 'done' (mtime ~now: newer than the status
  // read cursor, but OLDER than the hook-advanced heartbeat).
  const done = once(tm, 'done')
  await claudeWrites(task.statusPath, { state: 'done', result: { summary: 'no human emails' } })
  const [d] = await done // must still fire — the read cursor (lastMtimeMs) ignores the heartbeat
  assert.equal((d as { state: string }).state, 'done', 'done was read despite a later hook event')
  tm.kill(id)
})

test('maintenance sweep hard-erases tasks untouched past purgeAgeMs; keeps recent ones', async () => {
  const baseDir = await tmpBase()
  const tm = new TaskManager({
    executorFactory: () => makeFakeExecutor(),
    baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 9999, purgeAgeMs: 60_000,
  })
  const oldId = await tm.dispatch('a stale task from yesterday')
  const freshId = await tm.dispatch('a task from just now')
  const oldTask = tm.get(oldId)!
  const oldCwd = oldTask.cwd
  oldTask.updatedAt = Date.now() - 120_000 // age it well past the 60s threshold

  const removed = once(tm, 'removed')
  await tm.purgeStale()
  const [r] = await removed

  assert.equal((r as { id: string }).id, oldId, 'removed event fired for the stale task')
  assert.equal(tm.get(oldId), undefined, 'stale task erased from the map')
  assert.equal(tm.get(freshId)?.id, freshId, 'recent task kept')
  await assert.rejects(fs.access(oldCwd), 'stale scratch dir was deleted')
  tm.kill(freshId)
})

test('maintenance sweep also reclaims ORPHAN on-disk dirs from past runs (not in memory)', async () => {
  const baseDir = await tmpBase()
  const reaped: string[] = []
  const tm = new TaskManager({
    executorFactory: () => makeFakeExecutor(),
    baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 9999,
    purgeAgeMs: 60_000, userKey: 'local',
    reapSession: (id) => reaped.push(id),
  })
  // A live task (in memory) — must be kept even though we also seed its dir.
  const liveId = await tm.dispatch('a live task')

  // Two ORPHAN dirs on disk, never in memory (simulate yesterday's runs).
  const root = path.join(baseDir, 'local')
  const oldOrphan = path.join(root, 'orphan-old')
  const newOrphan = path.join(root, 'orphan-recent')
  await fs.mkdir(oldOrphan, { recursive: true })
  await fs.mkdir(newOrphan, { recursive: true })
  const past = new Date(Date.now() - 120_000)
  utimesSync(oldOrphan, past, past)               // aged past the 60s cutoff
  // newOrphan keeps its fresh mtime (just created)

  await tm.purgeStale()

  await assert.rejects(fs.access(oldOrphan), 'old orphan dir reclaimed')
  assert.deepEqual(reaped, ['orphan-old'], 'orphan tmux session reaped by id')
  await fs.access(newOrphan) // recent orphan kept
  await fs.access(tm.get(liveId)!.cwd) // live task untouched
  tm.kill(liveId)
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
  // The write is now DEFERRED until the REPL is idle (await ex.isReady()) so a
  // payload can't be swallowed mid-generation. isReady() resolves immediately
  // for the fake executor; flush the microtask so the deferred write lands.
  await new Promise((r) => setTimeout(r, 0))
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

// ── Memory layer: surface + mode, nursery injection, recipe-bearing handoff ──

async function seedGmailNursery(baseDir: string) {
  await writeRecipe({
    frontmatter: {
      name: 'gmail-inbox-sweep', surface: 'gmail',
      description: 'scan my inboxes, check my email',
      confidence: 'low', runs_confirmed: 0, runs_contradicted: 0,
      created: '2026-06-27T00:00:00Z', last_used: '2026-06-27T00:00:00Z', last_verified: '2026-06-27T00:00:00Z',
    },
    body: '## Invariants\nSweep inbox, group by sender.\n',
  }, baseDir)
}

test('managed dispatch injects + records the gmail nursery lead for the detected surface', async () => {
  const baseDir = await tmpBase()
  await seedGmailNursery(baseDir)
  const fake = makeFakeExecutor()
  const tm = new TaskManager({ executorFactory: () => fake, baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 25 })
  const id = await tm.dispatch('scan my inboxes') // detectSurface -> gmail, default managed
  // hedged nursery lead is typed into the payload
  assert.match(fake.writes.join(''), /unverified lead/i)
  // and recorded on the task (tier nursery, surface gmail)
  const injected = tm.get(id)!.injectedRecipes ?? []
  assert.ok(injected.some((r) => r.name === 'gmail-inbox-sweep' && r.tier === 'nursery' && r.surface === 'gmail'),
    'gmail nursery recipe recorded')
  assert.equal(tm.get(id)!.mode, 'managed')
  assert.equal(tm.get(id)!.surface, 'gmail')
  tm.kill(id)
})

test('raw dispatch skips injection, records no recipes, and never hands off on done', { timeout: 5000 }, async () => {
  const baseDir = await tmpBase()
  await seedGmailNursery(baseDir)
  const submits: any[] = []
  const librarian = { submit: async (s: any) => { submits.push(s) } } as any
  const fake = makeFakeExecutor()
  const tm = new TaskManager({ executorFactory: () => fake, baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 25, librarian })
  const id = await tm.dispatch('open me a coding session', { mode: 'raw' })
  assert.doesNotMatch(fake.writes.join(''), /unverified lead/i)
  assert.equal((tm.get(id)!.injectedRecipes ?? []).length, 0)
  const donePromise = once(tm, 'done')
  await claudeWrites(tm.get(id)!.statusPath, { state: 'done', result: { summary: 'ok' } })
  await donePromise
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(submits.length, 0) // raw mode never hands off
})

test('managed done with an injected recipe hands off to the librarian once with outcome done', { timeout: 5000 }, async () => {
  const baseDir = await tmpBase()
  await seedGmailNursery(baseDir)
  const submits: any[] = []
  const librarian = { submit: async (s: any) => { submits.push(s) } } as any
  const tm = new TaskManager({ executorFactory: () => makeFakeExecutor(), baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 25, librarian })
  const id = await tm.dispatch('scan my inboxes')
  const donePromise = once(tm, 'done')
  await claudeWrites(tm.get(id)!.statusPath, { state: 'done', result: { summary: 'swept' } })
  await donePromise
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(submits.length, 1)
  assert.equal(submits[0].outcome, 'done')
  assert.ok(submits[0].injectedRecipes.some((r: any) => r.name === 'gmail-inbox-sweep'))
})

test('managed failed hands off ONLY when an injected recipe is present', { timeout: 5000 }, async () => {
  const baseDir = await tmpBase()
  await seedGmailNursery(baseDir)
  const submits: any[] = []
  const librarian = { submit: async (s: any) => { submits.push(s) } } as any
  const tm = new TaskManager({ executorFactory: () => makeFakeExecutor(), baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 25, librarian })

  // (a) gmail surface has a recipe → failed hands off with outcome 'failed'
  const withRecipe = await tm.dispatch('scan my inboxes')
  const failedA = once(tm, 'failed')
  await claudeWrites(tm.get(withRecipe)!.statusPath, { state: 'failed', error: { reason: 'boom' } })
  await failedA
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(submits.length, 1)
  assert.equal(submits[0].outcome, 'failed')

  // (b) general surface, no recipes → injectedRecipes empty → failed does NOT hand off
  const noRecipe = await tm.dispatch('refactor the thing') // -> general, empty
  assert.equal((tm.get(noRecipe)!.injectedRecipes ?? []).length, 0)
  const failedB = once(tm, 'failed')
  await claudeWrites(tm.get(noRecipe)!.statusPath, { state: 'failed', error: { reason: 'boom2' } })
  await failedB
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(submits.length, 1) // unchanged — recipe-less failure is not handed off
})

// ─── Durable session model (Orchestrate): kind 'oneoff' | 'session' ───────────

test('dispatch persists kind in meta.json; defaults to oneoff with home === cwd', async () => {
  const baseDir = await tmpBase()
  const tm = new TaskManager({ executorFactory: () => makeFakeExecutor(), baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 9999 })
  const oneoff = await tm.dispatch('open my mail')
  const session = await tm.dispatch('work on the gating feature', { kind: 'session' })
  assert.equal(tm.get(oneoff)!.kind, 'oneoff')
  assert.equal(tm.get(oneoff)!.home, tm.get(oneoff)!.cwd, 'scratch oneoff: home === cwd')
  assert.equal(tm.get(session)!.kind, 'session')
  const meta = JSON.parse(await fs.readFile(path.join(tm.get(session)!.home, 'meta.json'), 'utf8'))
  assert.equal(meta.kind, 'session', 'kind persisted in the receipt')
  tm.killAll()
})

test('persistent session parks warm with NO idle timer (never reaped); oneoff still idle-kills', { timeout: 5000 }, async () => {
  const baseDir = await tmpBase()
  const fakes: ReturnType<typeof makeFakeExecutor>[] = []
  const tm = new TaskManager({
    executorFactory: () => { const f = makeFakeExecutor(); fakes.push(f); return f },
    baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 25, warmMs: 120,
  })
  const sid = await tm.dispatch('long-lived repo session', { kind: 'session' })
  const oid = await tm.dispatch('quick errand')
  const doneS = once(tm, 'done')
  await claudeWrites(tm.get(sid)!.statusPath, { state: 'done', result: { summary: 'checkpoint' } })
  await doneS
  const doneO = once(tm, 'done')
  await claudeWrites(tm.get(oid)!.statusPath, { state: 'done', result: { summary: 'errand done' } })
  await doneO
  await new Promise((r) => setTimeout(r, 250)) // past the 120ms warm window
  assert.equal(fakes[0].alive, true, 'persistent session survives past the warm window')
  assert.equal(fakes[1].alive, false, 'oneoff idle-killed after the warm window (unchanged)')
  tm.killAll()
})

test('purgeStale never touches persistent sessions — in memory or as on-disk receipts', async () => {
  const baseDir = await tmpBase()
  const tm = new TaskManager({
    executorFactory: () => makeFakeExecutor(), baseDir, trustAcceptMs: 0, submitConfirmMs: 0,
    pollMs: 9999, purgeAgeMs: 60_000, userKey: 'local',
  })
  // In-memory: an aged-out session vs an aged-out oneoff.
  const sid = await tm.dispatch('multi-day refactor', { kind: 'session' })
  const oid = await tm.dispatch('stale errand')
  tm.get(sid)!.updatedAt = Date.now() - 120_000
  tm.get(oid)!.updatedAt = Date.now() - 120_000
  // On-disk orphan receipts from a "past run" (not in memory), both aged out.
  const root = path.join(baseDir, 'local')
  for (const [tid, kind] of [[randomUUID(), 'session'], [randomUUID(), 'oneoff']] as const) {
    const dir = path.join(root, tid)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify({ id: tid, intent: 'past-run task', kind, createdAt: Date.now() - 120_000 }))
    const old = new Date(Date.now() - 120_000)
    utimesSync(dir, old, old)
  }
  await tm.purgeStale()
  assert.ok(tm.get(sid), 'in-memory persistent session survives the sweep')
  assert.equal(tm.get(oid), undefined, 'in-memory stale oneoff purged (unchanged)')
  const left = await fs.readdir(root)
  const metas = await Promise.all(left.map(async (d) => {
    try { return JSON.parse(await fs.readFile(path.join(root, d, 'meta.json'), 'utf8')) } catch { return null }
  }))
  assert.ok(metas.some((m) => m?.kind === 'session' && m.intent === 'past-run task'), 'on-disk session receipt survives')
  assert.ok(!metas.some((m) => m?.kind === 'oneoff' && m.intent === 'past-run task'), 'on-disk oneoff orphan purged')
  tm.killAll()
})

test('rehydrate restores kind, name, and a project cwd from the receipt', async () => {
  const baseDir = await tmpBase()
  const id = randomUUID()
  const dir = path.join(baseDir, 'local', id)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify({
    id, intent: 'work on unmute gating', name: 'Gating feature work', kind: 'session',
    cwd: '/Users/someone/tools/unmute', createdAt: Date.now(),
  }))
  const tm = new TaskManager({ executorFactory: () => makeFakeExecutor(), baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 9999 })
  await tm.rehydrate()
  const task = tm.get(id)!
  assert.equal(task.kind, 'session')
  assert.equal(task.name, 'Gating feature work')
  assert.equal(task.cwd, '/Users/someone/tools/unmute', 'resume will respawn in the real project dir')
  assert.equal(task.home, dir, 'home stays the Unmute-owned receipt dir')
})

test('setName persists the generated name into meta.json (survives restart)', async () => {
  const baseDir = await tmpBase()
  const tm = new TaskManager({ executorFactory: () => makeFakeExecutor(), baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 9999 })
  const id = await tm.dispatch('can you check the twitter strategy folder for me')
  tm.setName(id, 'Twitter strategy summary')
  await new Promise((r) => setTimeout(r, 50)) // persistence is async best-effort
  const meta = JSON.parse(await fs.readFile(path.join(tm.get(id)!.home, 'meta.json'), 'utf8'))
  assert.equal(meta.name, 'Twitter strategy summary')
  tm.killAll()
})

// ─── Project-bound spawn (Orchestrate): the agent runs IN the user's dir ──────

test('project-bound dispatch: spawns in the project dir, pollutes NOTHING there, contract rides inline', async () => {
  const baseDir = await tmpBase()
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'user-project-'))
  let spawned: SpawnOpts | null = null
  const fake = makeFakeExecutor({ onSpawn: (o) => { spawned = o } })
  const tm = new TaskManager({ executorFactory: () => fake, baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 9999 })
  const id = await tm.dispatch('work on the gating feature', { kind: 'session', cwd: project })
  const task = tm.get(id)!

  // Runs THERE; bookkeeping stays HOME.
  assert.equal(spawned!.cwd, project, 'agent spawns in the real project dir')
  assert.equal(task.cwd, project)
  assert.notEqual(task.home, project)
  assert.ok(task.statusPath.startsWith(task.home), 'status file lives in our dir, not the repo')

  // The user's directory is READ-ONLY territory: no CLAUDE.md, no .claude, no hooks.
  const written = await fs.readdir(project)
  assert.deepEqual(written, [], 'nothing written into the user project dir')

  // The contract can't auto-load from a CLAUDE.md we never wrote → inline payload.
  assert.ok(fake.writes[0].includes('Unmute operating contract'), 'contract inline in the payload')
  assert.ok(fake.writes[0].includes(task.statusPath), 'status path in the payload')

  // Receipt carries the project cwd so resume() respawns there after a restart.
  const meta = JSON.parse(await fs.readFile(path.join(task.home, 'meta.json'), 'utf8'))
  assert.equal(meta.cwd, project)
  assert.equal(meta.kind, 'session')

  tm.killAll()
  await fs.rm(project, { recursive: true, force: true })
})

test('project-bound dispatch falls back to scratch when the dir is unusable', async () => {
  const baseDir = await tmpBase()
  let spawned: SpawnOpts | null = null
  const tm = new TaskManager({
    executorFactory: () => makeFakeExecutor({ onSpawn: (o) => { spawned = o } }),
    baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 9999,
  })
  const id = await tm.dispatch('a task', { cwd: '/definitely/not/a/real/dir' })
  const task = tm.get(id)!
  assert.equal(task.cwd, task.home, 'fell back to the scratch spawn')
  assert.equal(spawned!.cwd, task.home)
  // Scratch spawn = full machinery: CLAUDE.md installed as usual.
  assert.ok((await fs.readFile(path.join(task.home, 'CLAUDE.md'), 'utf8')).includes('Unmute'))
  tm.killAll()
})

// ─── Multimodal attachments: the voice-era screenshot paste ───────────────────

test('attachFile saves under home/attachments and TYPES the path unsubmitted (no Enter)', async () => {
  const baseDir = await tmpBase()
  const fake = makeFakeExecutor()
  const tm = new TaskManager({ executorFactory: () => fake, baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 9999 })
  const id = await tm.dispatch('look at this design')
  const beforeRaw = fake.raw.length
  const saved = await tm.attachFile(id, new Uint8Array([137, 80, 78, 71]), 'png')
  assert.ok(saved, 'returns the saved path')
  assert.ok(saved!.startsWith(path.join(tm.get(id)!.home, 'attachments')), 'stored in OUR dir, never the project')
  assert.ok((await fs.stat(saved!)).isFile())
  // Typed into the input box via raw keystrokes, space-padded, and NOT submitted.
  const typed = fake.raw.slice(beforeRaw).join('')
  assert.ok(typed.includes(` ${saved} `), 'path typed with separating spaces')
  assert.ok(!typed.includes('\r'), 'no Enter — submission belongs to the next utterance')
  // Dead session → null, no throw.
  tm.kill(id)
  assert.equal(await tm.attachFile(id, new Uint8Array([1]), 'png'), null)
})

// ─── Graduation + pin (§5): errands that become threads become sessions ───────

test('2nd follow-up graduates a oneoff to a session (and cancels its warm-kill)', { timeout: 5000 }, async () => {
  const baseDir = await tmpBase()
  const fake = makeFakeExecutor()
  const tm = new TaskManager({ executorFactory: () => fake, baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 25, warmMs: 120 })
  const id = await tm.dispatch('check the twitter folder')
  const done = once(tm, 'done')
  await claudeWrites(tm.get(id)!.statusPath, { state: 'done', result: { summary: 'found it' } })
  await done
  assert.equal(tm.followUp(id, 'now summarize the README'), true)
  assert.equal(tm.get(id)!.kind, 'oneoff', 'one follow-up is a correction, not a thread')
  // Finish the follow-up turn, then follow up AGAIN → thread → graduate.
  const done2 = once(tm, 'done')
  await claudeWrites(tm.get(id)!.statusPath, { state: 'done', result: { summary: 'summarized' } })
  await done2
  assert.equal(tm.followUp(id, 'and the fastlane folder too'), true)
  assert.equal(tm.get(id)!.kind, 'session', 'second follow-up proves a thread')
  // Graduated ⇒ persistent: survives well past the 120ms warm window once parked.
  const done3 = once(tm, 'done')
  await claudeWrites(tm.get(id)!.statusPath, { state: 'done', result: { summary: 'all done' } })
  await done3
  await new Promise((r) => setTimeout(r, 250))
  assert.equal(fake.alive, true, 'graduated session is never idle-killed')
  // Persisted for restarts.
  const meta = JSON.parse(await fs.readFile(path.join(tm.get(id)!.home, 'meta.json'), 'utf8'))
  assert.equal(meta.kind, 'session')
  tm.killAll()
})

test('setKind pin cancels an ALREADY-ARMED warm timer; unpin re-arms the park', { timeout: 5000 }, async () => {
  const baseDir = await tmpBase()
  const fake = makeFakeExecutor()
  const tm = new TaskManager({ executorFactory: () => fake, baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 25, warmMs: 150 })
  const id = await tm.dispatch('quick errand')
  const done = once(tm, 'done')
  await claudeWrites(tm.get(id)!.statusPath, { state: 'done', result: { summary: 'ok' } })
  await done // parked warm — 150ms timer armed
  tm.setKind(id, 'session') // pin BEFORE the timer fires
  await new Promise((r) => setTimeout(r, 300))
  assert.equal(fake.alive, true, 'pin defused the armed warm-kill')
  tm.setKind(id, 'oneoff') // unpin → re-parks → timer re-armed
  await new Promise((r) => setTimeout(r, 300))
  assert.equal(fake.alive, false, 'unpin re-armed normal lifecycle')
  tm.killAll()
})

// ─── Consent clock: lastUserInputAt moves ONLY on user-initiated input ────────

test('lastUserInputAt: set at dispatch, advanced by followUp/answer/typed input — never by status heartbeats', { timeout: 5000 }, async () => {
  const baseDir = await tmpBase()
  const fake = makeFakeExecutor()
  let t = 1_000_000
  const tm = new TaskManager({ executorFactory: () => fake, baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 25, warmMs: 60_000, now: () => t })
  const id = await tm.dispatch('long doc task', { kind: 'session' })
  assert.equal(tm.get(id)!.lastUserInputAt, 1_000_000, 'dispatch stamps the consent clock')

  // Status writes (the agent working) advance updatedAt but NOT the consent clock.
  t = 1_600_000
  const done = once(tm, 'done')
  await claudeWrites(tm.get(id)!.statusPath, { state: 'done', result: { summary: 'checkpoint' } })
  await done
  assert.equal(tm.get(id)!.lastUserInputAt, 1_000_000, 'agent activity is not consent')
  assert.ok(tm.get(id)!.updatedAt >= 1_600_000, 'updatedAt did move')

  // User follow-up advances it.
  t = 1_700_000
  assert.equal(tm.followUp(id, 'add a pricing section'), true)
  assert.equal(tm.get(id)!.lastUserInputAt, 1_700_000, 'followUp is consent')

  // Typing into the terminal advances it.
  t = 1_800_000
  tm.sendInput(id, 'ls\r')
  assert.equal(tm.get(id)!.lastUserInputAt, 1_800_000, 'typed input is consent')
  tm.killAll()
})

// ─── Typed turns: a manual prompt in the terminal re-arms the lifecycle ───────

test('typing a prompt into a DONE session flips it to processing and REVIVES polling', { timeout: 5000 }, async () => {
  const baseDir = await tmpBase()
  const fake = makeFakeExecutor()
  const tm = new TaskManager({ executorFactory: () => fake, baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 25, warmMs: 60_000 })
  const id = await tm.dispatch('draft the tweet thread', { kind: 'session' })
  const done = once(tm, 'done')
  await claudeWrites(tm.get(id)!.statusPath, { state: 'done', result: { summary: 'drafted' } })
  await done // parked warm — polling STOPPED

  // The user types a real prompt into the live terminal, char by char + Enter.
  for (const ch of 'where are the other tweets?') tm.sendInput(id, ch)
  tm.sendInput(id, '\r')
  assert.equal(tm.get(id)!.state, 'processing', 'typed turn leaves done')

  // The proof polling is back: the agent's next status write is actually READ.
  const done2 = once(tm, 'done')
  await claudeWrites(tm.get(id)!.statusPath, { state: 'done', result: { summary: 'full thread posted' } })
  await done2
  assert.equal(tm.get(id)!.result?.summary, 'full thread posted')
  tm.killAll()
})

test('typed-turn detection ignores noise: bare Enters, arrows, /commands, backspaced-away text', { timeout: 5000 }, async () => {
  const baseDir = await tmpBase()
  const fake = makeFakeExecutor()
  const tm = new TaskManager({ executorFactory: () => fake, baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 25, warmMs: 60_000 })
  const id = await tm.dispatch('quick check')
  const done = once(tm, 'done')
  await claudeWrites(tm.get(id)!.statusPath, { state: 'done', result: { summary: 'ok' } })
  await done

  tm.sendInput(id, '\r')                       // bare Enter
  tm.sendInput(id, '\x1b[A\x1b[B\r')           // arrow keys + Enter
  tm.sendInput(id, '/clear\r')                 // TUI command
  tm.sendInput(id, 'abc\x7f\x7f\x7f\r')        // typed then fully backspaced
  assert.equal(tm.get(id)!.state, 'done', 'none of the noise re-arms the task')

  tm.sendInput(id, 'ok fix the title\r')       // a real prompt
  assert.equal(tm.get(id)!.state, 'processing')
  tm.killAll()
})

test('recentlyFinished: one-offs only, window- and count-capped (the resume pool)', async () => {
  const baseDir = await tmpBase()
  let t = 2_000_000
  const tm = new TaskManager({ executorFactory: () => makeFakeExecutor(), baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 25, warmMs: 0, now: () => t })
  const oneoff = await tm.dispatch('play a video')
  const session = await tm.dispatch('long repo work', { kind: 'session' })
  for (const [id, task] of [[oneoff, 'oneoff'], [session, 'session']] as const) {
    const done = once(tm, 'done')
    await claudeWrites(tm.get(id)!.statusPath, { state: 'done', result: { summary: `${task} done` } })
    await done
  }
  tm.kill(session) // kill the session's PTY so !alive holds for it too
  const pool = tm.recentlyFinished()
  assert.deepEqual(pool.map((x) => x.id), [oneoff], 'sessions never enter the resume pool')
  // window cap: age the oneoff past 15 minutes → pool empties
  t += 16 * 60_000
  assert.equal(tm.recentlyFinished().length, 0, 'stale finishes leave the pool')
  tm.killAll()
})

test('thread_context from a status write lands on the task (bounded)', { timeout: 5000 }, async () => {
  const baseDir = await tmpBase()
  const tm = new TaskManager({ executorFactory: () => makeFakeExecutor(), baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 25 })
  const id = await tm.dispatch('long doc work', { kind: 'session' })
  const done = once(tm, 'done')
  await claudeWrites(tm.get(id)!.statusPath, {
    state: 'done', result: { summary: 'checkpoint' },
    thread_context: 'Drafted sections 1-2; pricing table pending; next: review tone.',
  })
  await done
  assert.equal(tm.get(id)!.threadContext, 'Drafted sections 1-2; pricing table pending; next: review tone.')
  tm.killAll()
})

// ─── The ready state: step complete, ball with the user (whose-move-is-it) ────

async function waitForState(tm: TaskManager, id: string, state: string, timeoutMs = 3000): Promise<void> {
  const t0 = Date.now()
  while (tm.get(id)?.state !== state) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${state} (got ${tm.get(id)?.state})`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

test('ready parks the session WARM: state ready, executor alive, not counted active', { timeout: 5000 }, async () => {
  const baseDir = await tmpBase()
  const fake = makeFakeExecutor()
  const tm = new TaskManager({ executorFactory: () => fake, baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 25, warmMs: 60_000 })
  const id = await tm.dispatch('load the video and tell me about it')
  await claudeWrites(tm.get(id)!.statusPath, { state: 'ready', result: { summary: 'Video loaded — ready for what you want next' } })
  await waitForState(tm, id, 'ready')
  assert.equal(fake.alive, true, 'the session stays warm — ready is a checkpoint, not an ending')
  assert.equal(tm.activeCount(), 0, 'ready is turn-over: not "running"')
  assert.equal(tm.get(id)!.result?.summary, 'Video loaded — ready for what you want next')
  tm.kill(id)
})

test('kill on a ready task settles it as failed (ready is NOT settled)', { timeout: 5000 }, async () => {
  const baseDir = await tmpBase()
  const tm = new TaskManager({ executorFactory: () => makeFakeExecutor(), baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 25, warmMs: 60_000 })
  const id = await tm.dispatch('x')
  await claudeWrites(tm.get(id)!.statusPath, { state: 'ready' })
  await waitForState(tm, id, 'ready')
  tm.kill(id)
  // A killed ready task was awaiting the user — ending it there is an interruption,
  // not a completion: it must read failed (resumable), never silently "done".
  assert.equal(tm.get(id)!.state, 'failed')
})

test('decay valve: an ignored ready ONE-OFF settles to done after 60min; a ready SESSION never decays', { timeout: 5000 }, async () => {
  const baseDir = await tmpBase()
  const tm = new TaskManager({ executorFactory: () => makeFakeExecutor(), baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 25, warmMs: 600_000 })
  const oneoff = await tm.dispatch('one-off errand')
  const sess = await tm.dispatch('working session')
  tm.setKind(sess, 'session')
  for (const id of [oneoff, sess]) {
    await claudeWrites(tm.get(id)!.statusPath, { state: 'ready' })
    await waitForState(tm, id, 'ready')
  }
  // Backdate both past the 60-minute valve, then run the sweep.
  tm.get(oneoff)!.updatedAt = Date.now() - 61 * 60_000
  tm.get(sess)!.updatedAt = Date.now() - 61 * 60_000
  await tm.purgeStale()
  assert.equal(tm.get(oneoff)!.state, 'done', 'ignored ready one-off decays to done')
  assert.equal(tm.get(sess)!.state, 'ready', 'a session\'s open loop is real until the user closes it')
  tm.kill(oneoff); tm.kill(sess)
})

test('resume of a ready task is SILENT — warm re-entry, no continue nudge', { timeout: 5000 }, async () => {
  const baseDir = await tmpBase()
  const fake = makeFakeExecutor()
  const tm = new TaskManager({ executorFactory: () => fake, baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 9999 })
  const tid = randomUUID()
  const dir = path.join(baseDir, 'local', tid)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify({ id: tid, intent: 'load the video', createdAt: Date.now() }))
  await claudeWrites(path.join(dir, 'status.json'), { state: 'ready', result: { summary: 'loaded' } })
  await tm.rehydrate()
  assert.equal(tm.get(tid)!.state, 'ready', 'rehydrate preserves ready — it was a deliberate parked state')
  const ok = await tm.resume(tid)
  assert.equal(ok, true)
  // Ready = the ball is with the USER. Nudging "continue" would snatch it back.
  assert.ok(!fake.writes.some((w) => /resumed|continue now/i.test(w)), 'no nudge into a ready task')
  assert.equal(tm.get(tid)!.state, 'ready')
  tm.kill(tid)
})

// ─── Opening a card revives the session (the quit switch closed it) ──────────

/** Poll a predicate — opened() resumes in the background (fire-and-forget). */
async function waitFor(pred: () => boolean, ms = 2000): Promise<void> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (pred()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('waitFor: condition never became true')
}

/** Seed an on-disk task that was mid-work when the app quit. */
async function seedInterrupted(baseDir: string, kind: 'oneoff' | 'session', extraMeta: object = {}): Promise<string> {
  const id = randomUUID()
  const dir = path.join(baseDir, 'local', id)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify({ id, intent: 'the long thread', sessionId: randomUUID(), kind, createdAt: Date.now(), ...extraMeta }))
  await claudeWrites(path.join(dir, 'status.json'), { state: 'processing', step: 'mid-turn' })
  return id
}

test('a session closed by the quit switch comes back READY, not failed; a one-off still reads interrupted', async () => {
  const baseDir = await tmpBase()
  const sid = await seedInterrupted(baseDir, 'session')
  const oid = await seedInterrupted(baseDir, 'oneoff')
  const tm = new TaskManager({ executorFactory: () => makeFakeExecutor(), baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 9999 })
  await tm.rehydrate()
  // The quit switch closes every session BY DESIGN — that is not a failure.
  assert.equal(tm.get(sid)!.state, 'ready', 'persistent session restores as ball-with-you')
  assert.equal(tm.get(sid)!.error, undefined, 'and carries no error to explain away')
  // A one-off errand really was cut short: unchanged.
  assert.equal(tm.get(oid)!.state, 'failed')
  assert.match(tm.get(oid)!.error!.reason, /Interrupted by an app restart/)
})

test('opening a persistent session revives it with no Resume tap; a one-off is left alone', { timeout: 5000 }, async () => {
  const baseDir = await tmpBase()
  let spawns = 0
  const sid = await seedInterrupted(baseDir, 'session')
  const oid = await seedInterrupted(baseDir, 'oneoff')
  const tm = new TaskManager({
    executorFactory: () => { spawns++; return makeFakeExecutor() },
    baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 9999,
  })
  await tm.rehydrate()
  assert.equal(tm.isAlive(sid), false, 'rehydrate never re-attaches')

  tm.opened(sid)
  await waitFor(() => tm.isAlive(sid))
  assert.equal(spawns, 1, 'opening the card resumed it')
  // Mid-work when it closed ⇒ the resume NUDGES it to carry on.
  assert.equal(tm.get(sid)!.state, 'processing')

  // A one-off is opened to READ its result — resuming it would spawn a REPL
  // behind the user's back (and after a purge there is nothing to resume).
  tm.opened(oid)
  await new Promise((r) => setTimeout(r, 120))
  assert.equal(spawns, 1, 'one-off keeps its explicit Resume button')
  assert.equal(tm.isAlive(oid), false)
  tm.killAll()
})

test('opened() is idempotent — the surfaces re-announce on every tick, one gesture = one respawn', { timeout: 5000 }, async () => {
  const baseDir = await tmpBase()
  let spawns = 0
  const sid = await seedInterrupted(baseDir, 'session')
  const tm = new TaskManager({
    executorFactory: () => { spawns++; return makeFakeExecutor() },
    baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 9999,
  })
  await tm.rehydrate()
  for (let i = 0; i < 5; i++) tm.opened(sid) // reconcile fires repeatedly
  await waitFor(() => tm.isAlive(sid))
  tm.opened(sid) // and again once it IS alive
  await new Promise((r) => setTimeout(r, 120))
  assert.equal(spawns, 1, 'exactly one session, however many opens')
  tm.killAll()
})

test('two resumes racing (auto-resume + a Resume tap) build ONE session, not two', { timeout: 5000 }, async () => {
  const baseDir = await tmpBase()
  let spawns = 0
  const sid = await seedInterrupted(baseDir, 'session')
  // Mirror the REAL executor: a PTY is not `alive` until spawn resolves, and
  // that window is exactly where a second resume used to orphan the first PTY.
  const slowExecutor = () => {
    spawns++
    let live = false
    const ex = makeFakeExecutor()
    return Object.defineProperty(ex, 'alive', { get: () => live, configurable: true }) &&
      Object.assign(ex, { spawn: async () => { await new Promise((r) => setTimeout(r, 60)); live = true } })
  }
  const tm = new TaskManager({
    executorFactory: slowExecutor,
    baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 9999,
  })
  await tm.rehydrate()
  const [a, b] = await Promise.all([tm.resume(sid), tm.resume(sid)])
  assert.equal(a, true)
  assert.equal(b, true)
  assert.equal(spawns, 1, 'the second resume is absorbed, not a second session')
  tm.killAll()
})

test('opening a Codex thread spawns nothing — it has no session of ours to revive', { timeout: 5000 }, async () => {
  const baseDir = await tmpBase()
  let spawns = 0
  const cid = await seedInterrupted(baseDir, 'session', { agent: 'codex-desktop', codexThreadId: 'th-1' })
  const tm = new TaskManager({
    executorFactory: () => { spawns++; return makeFakeExecutor() },
    baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 9999,
  })
  await tm.rehydrate()
  tm.opened(cid)
  await new Promise((r) => setTimeout(r, 120))
  assert.equal(spawns, 0, 'no PTY is ever built for a chat backend')
  tm.killAll()
})

test('shelve/note persist to meta.json and survive rehydrate; shelved is purge-exempt', { timeout: 5000 }, async () => {
  const baseDir = await tmpBase()
  const tm = new TaskManager({ executorFactory: () => makeFakeExecutor(), baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 9999 })
  const id = await tm.dispatch('research task worth keeping')
  const task = tm.get(id)!
  await claudeWrites(task.statusPath, { state: 'done', result: { summary: 'kept' } })
  tm.setShelved(id, true)
  tm.setNote(id, 'JIRA-123 — revisit after the launch')
  await new Promise((r) => setTimeout(r, 150)) // let the async meta writes land
  const meta = JSON.parse(await fs.readFile(path.join(task.home, 'meta.json'), 'utf8'))
  assert.equal(meta.shelved, true)
  assert.equal(meta.note, 'JIRA-123 — revisit after the launch')
  // Purge exemption: backdate far past the 24h cutoff — the shelf keeps it.
  task.updatedAt = Date.now() - 48 * 60 * 60_000
  await tm.purgeStale()
  assert.ok(tm.get(id), 'shelved task survives the purge sweep')
  // Survives restart: a fresh manager rehydrates shelved + note from meta.
  tm.kill(id)
  const tm2 = new TaskManager({ executorFactory: () => makeFakeExecutor(), baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 9999 })
  await tm2.rehydrate()
  assert.equal(tm2.get(id)!.shelved, true)
  assert.equal(tm2.get(id)!.note, 'JIRA-123 — revisit after the launch')
})

// ─── Fear #1 killed: speaking at a BUSY session queues safely and visibly ─────

test('followUp on a mid-turn task: queued label + events, delivered when idle, label retired', { timeout: 5000 }, async () => {
  const baseDir = await tmpBase()
  let releaseIdle: (() => void) | null = null
  let blockIdle = false // armed after dispatch, so dispatch's own isReady passes
  const fake = makeFakeExecutor()
  // Make isReady controllable: the session is "mid-turn" until the test releases it.
  fake.isReady = () => (blockIdle ? new Promise<void>((r) => { releaseIdle = r }) : Promise.resolve())
  const tm = new TaskManager({ executorFactory: () => fake, baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 9999 })
  const id = await tm.dispatch('long grind') // state: processing (mid-turn)
  assert.equal(tm.get(id)!.state, 'processing')
  blockIdle = true // from here, the session reads as mid-turn

  const queued = once(tm, 'follow-up-queued')
  const delivered = once(tm, 'follow-up-delivered')
  const before = fake.writes.length
  assert.equal(tm.followUp(id, 'also check the auth logs'), true)
  const [qTask] = await queued
  assert.match(qTask.step ?? '', /queued/, 'the card shows the thought is HELD, not lost')
  assert.equal(fake.writes.length, before, 'nothing written while the REPL is busy — the running turn is never derailed')

  releaseIdle!() // the session goes idle → the queued instruction lands
  const [dTask] = await delivered
  assert.equal(dTask.step, undefined, 'queued label retired on delivery')
  assert.ok(fake.writes.some((w) => w.includes('also check the auth logs')), 'the instruction was delivered')
  tm.kill(id)
})

test('followUp on an IDLE (parked done) task: no queued event — it delivers straight away', { timeout: 5000 }, async () => {
  const baseDir = await tmpBase()
  const fake = makeFakeExecutor()
  const tm = new TaskManager({ executorFactory: () => fake, baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 25, warmMs: 60_000 })
  const id = await tm.dispatch('quick errand')
  await claudeWrites(tm.get(id)!.statusPath, { state: 'done', result: { summary: 'ok' } })
  await waitForState(tm, id, 'done')
  let queuedFired = false
  tm.on('follow-up-queued', () => { queuedFired = true })
  assert.equal(tm.followUp(id, 'one more thing'), true)
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(queuedFired, false, 'idle session = immediate delivery, no queue theater')
  assert.ok(fake.writes.some((w) => w.includes('one more thing')))
  tm.kill(id)
})

// ─── Self-healing stuck: the label retracts when real work resumes ────────────

test('stuck heals to processing when hook activity resumes (the API-retry recovery)', { timeout: 5000 }, async () => {
  const baseDir = await tmpBase()
  const tm = new TaskManager({
    executorFactory: () => makeFakeExecutor(),
    baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 30, staleMs: 200,
  })
  const id = await tm.dispatch('work that hits an API retry loop')
  // Silence past staleMs → stuck fires (the retry loop is hook-silent).
  const [stuckTask] = await once(tm, 'stuck')
  assert.equal(stuckTask.state, 'stuck')
  // The retries work out — real tool execution resumes (PostToolUse marker).
  const activity = path.join(tm.get(id)!.cwd, '.unmute-activity')
  await fs.writeFile(activity, '')
  // The label must heal itself: stuck → processing, no human intervention.
  const t0 = Date.now()
  while (tm.get(id)!.state === 'stuck') {
    if (Date.now() - t0 > 3000) throw new Error('stuck never healed after activity resumed')
    await new Promise((r) => setTimeout(r, 25))
  }
  assert.equal(tm.get(id)!.state, 'processing', 'resumed work retracts the stuck verdict')
  // And it can go stuck AGAIN if silence returns (heal is not a one-way pass).
  const [reStuck] = await once(tm, 'stuck')
  assert.equal(reStuck.state, 'stuck', 're-silence re-trips the backstop')
  tm.kill(id)
})

// ─── MCP provenance: spawnedBy persists and survives restarts ─────────────────

test('dispatch with spawnedBy: task carries provenance, meta persists it, rehydrate restores it', async () => {
  const baseDir = await tmpBase()
  const tm = new TaskManager({ executorFactory: () => makeFakeExecutor(), baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 9999 })
  const id = await tm.dispatch('an agent-created errand', { spawnedBy: 'parent-task-1' })
  assert.equal(tm.get(id)!.spawnedBy, 'parent-task-1')
  await new Promise((r) => setTimeout(r, 100))
  tm.kill(id)
  const tm2 = new TaskManager({ executorFactory: () => makeFakeExecutor(), baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 9999 })
  await tm2.rehydrate()
  assert.equal(tm2.get(id)!.spawnedBy, 'parent-task-1', 'provenance survives restart')
})

test('dispatch with forkFromSessionId: spawn omits the pinned session id and passes fork args', async () => {
  const baseDir = await tmpBase()
  let spawned: SpawnOpts | null = null
  const tm = new TaskManager({
    executorFactory: () => makeFakeExecutor({ onSpawn: (o) => { spawned = o } }),
    baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 9999,
  })
  const id = await tm.dispatch('continue the work', { forkFromSessionId: 'abc-123', extraEnv: { UNMUTE_MCP_TOKEN: 'tok' } })
  assert.ok(spawned)
  assert.equal(spawned!.forkFromSessionId, 'abc-123')
  assert.equal(spawned!.sessionId, undefined, 'a fork cannot pin a session id — Claude mints its own')
  assert.equal(spawned!.extraEnv?.UNMUTE_MCP_TOKEN, 'tok', 'intercom identity rides the spawn env')
  tm.kill(id)
})

// ─── Workspace grouping (spec 2026-07-16-cockpit-grouping) ────────────────

test('setGroup persists to meta.json, survives rehydrate, and freezes semantics live in the caller (assign is idempotent)', async () => {
  const baseDir = await tmpBase()
  const tm = new TaskManager({ executorFactory: () => makeFakeExecutor(), baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 9999 })
  const id = await tm.dispatch('fix the webhook ticket')
  tm.setGroup(id, '  on-call  ')
  assert.equal(tm.get(id)!.group, 'on-call')
  await new Promise((r) => setTimeout(r, 50))
  const meta = JSON.parse(await fs.readFile(path.join(tm.get(id)!.home, 'meta.json'), 'utf8'))
  assert.equal(meta.group, 'on-call')
  tm.killAll()

  // rehydrate restores the group
  const tm2 = new TaskManager({ executorFactory: () => makeFakeExecutor(), baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 9999 })
  await tm2.rehydrate()
  assert.equal(tm2.get(id)?.group, 'on-call')
  tm2.killAll()
})

test('setGroup with empty clears; renameGroup moves every member and reports the count', async () => {
  const baseDir = await tmpBase()
  const tm = new TaskManager({ executorFactory: () => makeFakeExecutor(), baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 9999 })
  const a = await tm.dispatch('ticket one')
  const b = await tm.dispatch('ticket two')
  const c = await tm.dispatch('unrelated')
  tm.setGroup(a, 'on-call')
  tm.setGroup(b, 'on-call')
  tm.setGroup(c, 'video')
  assert.equal(tm.renameGroup('on-call', 'incidents'), 2)
  assert.equal(tm.get(a)!.group, 'incidents')
  assert.equal(tm.get(b)!.group, 'incidents')
  assert.equal(tm.get(c)!.group, 'video')
  assert.equal(tm.renameGroup('ghost', 'x'), 0)
  tm.setGroup(a, '')
  assert.equal(tm.get(a)!.group, undefined)
  tm.killAll()
})

// ─── D14 tap-to-invoke plumbing: typeUnsubmitted writes RAW, no carriage return ─

test('typeUnsubmitted writes raw text with no CR to the task executor', async () => {
  const baseDir = await tmpBase()
  const fake = makeFakeExecutor()
  const tm = new TaskManager({ executorFactory: () => fake, baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 9999 })
  const id = await tm.dispatch('review the PR')
  fake.raw.length = 0                                      // ignore dispatch's confirm-Enter
  const ok = tm.typeUnsubmitted(id, '/pr-review ')
  assert.equal(ok, true)
  assert.deepEqual(fake.raw, ['/pr-review '])             // written raw, no '\r' appended anywhere
  assert.deepEqual(fake.writes.filter((w) => w === '/pr-review '), []) // NOT via writeStdin (which appends CR)
  assert.equal(tm.typeUnsubmitted('nope', 'x'), false)    // unknown task
  tm.kill(id)
})
