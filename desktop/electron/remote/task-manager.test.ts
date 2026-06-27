import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs, utimesSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
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
