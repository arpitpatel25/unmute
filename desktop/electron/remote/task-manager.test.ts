import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs, utimesSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { TaskManager } from './task-manager.ts'
import { readRolloutEvents } from './codex/cli-session.ts'
import { writeRecipe } from './recipe-store.ts'
import { providerOf } from './providers.ts'
import type { AgentExecutor, SpawnOpts } from './executor.ts'
import type { AgentKind } from './codex-executor.ts'

// A fake executor that records what's written and lets the test play "Claude"
// by writing the status file directly (atomic temp-then-rename, like the contract).
function makeFakeExecutor(opts: { onSpawn?: (o: SpawnOpts) => void } = {}) {
  const writes: string[] = []
  const raw: string[] = []
  const resizes: Array<[number, number]> = []
  let aliveFlag = true
  let detached = 0
  let killed = 0
  const ex: AgentExecutor & { writes: string[]; raw: string[]; resizes: Array<[number, number]>; detached: () => number; killed: () => number } = {
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
    detach() { detached++; aliveFlag = false },
    kill() { killed++; aliveFlag = false },
    detached: () => detached,
    killed: () => killed,
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

test('dispatch → scaffolds status, types ONLY the intent, writes nothing into the cwd', async () => {
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
  // NOTHING Unmute-authored lands in the session's working directory. This is
  // the principle (session-policy.ts) as an assertion: no CLAUDE.md, no
  // .claude/settings.json, no hook script, no marker files, no PROFILE.md.
  const inCwd = await fs.readdir(task.cwd)
  for (const forbidden of ['CLAUDE.md', '.claude', '.unmute-hook.sh', '.unmute-activity', 'PROFILE.md']) {
    assert.ok(!inCwd.includes(forbidden), `dispatch wrote ${forbidden} into the session cwd`)
  }
  assert.ok(spawned, 'executor spawned')
  // sessionId minted, set on the task, passed to the spawn (→ --session-id), and persisted.
  assert.ok(task.sessionId, 'task carries a minted sessionId')
  assert.equal(spawned!.sessionId, task.sessionId, 'sessionId handed to the executor for --session-id')
  const meta = JSON.parse(await fs.readFile(path.join(task.cwd, 'meta.json'), 'utf8'))
  assert.equal(meta.sessionId, task.sessionId, 'sessionId persisted in meta.json')
  tm.kill(id) // stop polling
})

test('dispatch fails truthfully and never writes the intent when the CLI exits during startup', async () => {
  const baseDir = await tmpBase()
  const writes: string[] = []
  let alive = true
  const exitedDuringReady: AgentExecutor = {
    get alive() { return alive },
    async spawn() {},
    async isReady() { alive = false },
    writeStdin(text) { writes.push(text) },
    write() {},
    resize() {},
    onData() {},
    kill() { alive = false },
  }
  const tm = new TaskManager({
    executorFactory: () => exitedDuringReady,
    baseDir,
    trustAcceptMs: 0,
    submitConfirmMs: 0,
    pollMs: 9999,
  })

  const id = await tm.dispatch('research the new feature', { agent: 'codex' })

  assert.deepEqual(writes, [], 'a dead CLI must never receive or claim to dispatch the user prompt')
  assert.equal(tm.get(id)!.state, 'failed', 'the card must not remain falsely Working')
  assert.match(tm.get(id)!.error?.detail ?? '', /exited before task dispatch/i)
})

test('resume brings an interrupted task back WITHOUT speaking for the user', () => {
  // THIS ASSERTED THE OPPOSITE, and the behaviour it pinned was the bug: an
  // interrupted task was re-grounded by typing the original intent back into
  // it. Plausible, and still wrong — pressing Resume took a turn in the
  // conversation on the user's behalf. What was cut off is visible in the
  // terminal; what to say about it is theirs.
  //
  // The assertion is inverted rather than deleted, so the old behaviour cannot
  // quietly return.
  return (async () => {
    const baseDir = await tmpBase()
    const fake = makeFakeExecutor()
    const tm = new TaskManager({ executorFactory: () => fake, baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 9999 })
    const tid = randomUUID()
    const dir = path.join(baseDir, 'local', tid)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify({ id: tid, intent: 'scroll my feed', createdAt: Date.now() }))
    await claudeWrites(path.join(dir, 'status.json'), { state: 'processing' })
    await tm.rehydrate()
    fake.writes.length = 0
    assert.equal(await tm.resume(tid), true, 'the session still comes back')
    assert.deepEqual(fake.writes.filter((w) => /resumed|continue|scroll my feed/i.test(w)), [],
      'and it arrives silent')
    tm.kill(tid)
  })()
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

test('rehydrate preserves each CLI provider for inactive cards and resume', async () => {
  // THE BUG: dispatch persisted agent:'codex', but the generic CLI rehydrate
  // branch did not copy it onto the Task. Before anything was opened, every
  // surface therefore resolved the inactive card through providerOf(undefined)
  // and drew Claude; opening it then resumed through Claude too.
  const baseDir = await tmpBase()
  const root = path.join(baseDir, 'local')
  const codexId = randomUUID()
  const claudeId = randomUUID()
  const legacyId = randomUUID()
  const fixtures = [
    { id: codexId, agent: 'codex', sessionId: 'codex-session', codexRolloutId: 'codex-session' },
    { id: claudeId, agent: 'claude', sessionId: 'claude-session' },
    // Receipts from before provider identity was persisted remain Claude.
    { id: legacyId, sessionId: 'legacy-session' },
  ] as const

  for (const receipt of fixtures) {
    const dir = path.join(root, receipt.id)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify({
      ...receipt,
      intent: `continue ${receipt.id}`,
      kind: 'session',
      createdAt: Date.now(),
      cwd: dir,
    }))
    await claudeWrites(path.join(dir, 'status.json'), { state: 'done' })
  }

  const requested: AgentKind[] = []
  const tm = new TaskManager({
    executorFactory: (_resume, agent) => {
      requested.push(agent ?? 'claude')
      return makeFakeExecutor()
    },
    baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 9999,
  })

  await tm.rehydrate()

  const codex = tm.get(codexId)!
  assert.equal(codex.agent, 'codex', 'inactive task keeps its persisted provider')
  assert.equal(codex.codexRolloutId, 'codex-session', 'Codex continuation handle survives too')
  assert.equal(providerOf(codex.agent).label, 'Codex CLI', 'all card/notch serializers resolve the Codex presentation')
  assert.equal(tm.get(claudeId)!.agent, 'claude')
  assert.equal(tm.get(legacyId)!.agent, 'claude', 'legacy absent provider keeps the compatibility default')

  assert.equal(await tm.resume(codexId), true)
  assert.deepEqual(requested, ['codex'], 'resume constructs the original provider, not Claude')
  tm.killAll()
  tm.stopMaintenance()
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

  // TYPED, and correctly so. This question arrived through a STATUS WRITE, not
  // through the AskUserQuestion hook — so there is no picker shape on record and
  // no basis for sending an index. We drive the picker only when a hook told us
  // its exact options (see the index test below); otherwise typing is the honest
  // fallback, and the terminal can take it.
  const before = fake.writes.length
  tm.answer(id, 'A')
  assert.equal(fake.writes.length, before + 1)
  assert.equal(fake.writes.at(-1), 'A')
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

test('a pushed hook heartbeat keeps a silent task alive; it goes stuck once the events stop', { timeout: 5000 }, async () => {
  const baseDir = await tmpBase()
  const tm = new TaskManager({
    executorFactory: () => makeFakeExecutor(),
    baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 30, staleMs: 200,
  })
  const id = await tm.dispatch('a long task that works without writing status')
  const sessionId = tm.get(id)!.sessionId!
  // PostToolUse arriving every 60ms — real progress, NO status writes. These
  // are PUSHED now (session-policy.ts) rather than inferred from a marker file.
  const beat = setInterval(() => tm.onHookEvent({ kind: 'tool-used', sessionId }), 60)
  await new Promise((r) => setTimeout(r, 500)) // > 2x staleMs with no status write
  assert.notEqual(tm.get(id)!.state, 'stuck', 'hook heartbeat kept the silent task alive')
  // Events stop → no heartbeat, no status → the backstop must still fire.
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
  // A FOLLOW-UP IS JUST WHAT THE USER SAID. The re-anchoring scaffolding —
  // status path, recipe path, "Act now, follow the contract" — used to wrap
  // every sentence for the life of the session. The Stop hook replaced the
  // mechanism it existed to support, so it is gone.
  assert.equal(fake.writes.at(-1)!, 'reply to the second one')
  assert.ok(!fake.writes.at(-1)!.includes(task.statusPath), 'follow-up re-sent the status path')
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

test('shutdown detaches every live terminal runtime, including one-off work', async () => {
  const baseDir = await tmpBase()
  const fakes: ReturnType<typeof makeFakeExecutor>[] = []
  const tm = new TaskManager({
    executorFactory: () => { const fake = makeFakeExecutor(); fakes.push(fake); return fake },
    baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 9999,
  })
  const persistent = await tm.dispatch('keep this runtime', { kind: 'session' })
  const oneoff = await tm.dispatch('finish this errand')

  tm.shutdown()

  assert.equal(fakes[0].detached(), 1, 'persistent runtime client detaches from tmux')
  assert.equal(fakes[0].killed(), 0, 'persistent tmux session is not killed')
  assert.equal(tm.get(persistent)!.state, 'processing', 'live task state survives app shutdown')
  assert.equal(fakes[1].detached(), 1, 'active one-off client also detaches from tmux')
  assert.equal(fakes[1].killed(), 0, 'closing Unmute does not kill active one-off work')
  assert.equal(tm.get(oneoff)!.state, 'processing', 'active one-off state survives app shutdown')
})

// ── Memory injection: REMOVED (2026-08-06) ───────────────────────────────────
//
// Dispatch used to copy graduated skills into the cwd, write a PROFILE.md, and
// type hedged "memory leads" from the nursery into the payload. All three came
// from the librarian, which has been parked since 2026-08-03 — so they were
// unvetted hints from a system with no maintainer, and the project overview
// already called them "noise that pollutes instruction packets".
//
// These tests pin the removal, so it cannot quietly come back.

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

test('a nursery recipe on disk is NOT injected, in managed mode or any other', async () => {
  const baseDir = await tmpBase()
  await seedGmailNursery(baseDir)
  const fake = makeFakeExecutor()
  const tm = new TaskManager({ executorFactory: () => fake, baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 25 })
  const id = await tm.dispatch('scan my inboxes') // detectSurface -> gmail, default managed
  assert.equal(fake.writes.join(''), 'scan my inboxes', 'the payload is the intent and nothing else')
  assert.doesNotMatch(fake.writes.join(''), /unverified lead/i)
  assert.equal((tm.get(id)!.injectedRecipes ?? []).length, 0)
  // surface + mode are still recorded — they route the work, they do not inject.
  assert.equal(tm.get(id)!.mode, 'managed')
  assert.equal(tm.get(id)!.surface, 'gmail')
  tm.kill(id)
})

test('no skills copy and no PROFILE.md land in the session directory', async () => {
  const baseDir = await tmpBase()
  await seedGmailNursery(baseDir)
  const tm = new TaskManager({ executorFactory: () => makeFakeExecutor(), baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 9999 })
  const id = await tm.dispatch('scan my inboxes')
  const written = await fs.readdir(tm.get(id)!.cwd)
  assert.ok(!written.includes('.claude'), 'skills were copied into the session cwd')
  assert.ok(!written.includes('PROFILE.md'), 'a PROFILE.md was written into the session cwd')
  tm.killAll()
})

test('managed done still hands off to the librarian; raw still never does', { timeout: 5000 }, async () => {
  const baseDir = await tmpBase()
  const submits: any[] = []
  const librarian = { submit: async (s: any) => { submits.push(s) } } as any
  const tm = new TaskManager({ executorFactory: () => makeFakeExecutor(), baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 25, librarian })

  const managed = await tm.dispatch('scan my inboxes')
  const doneA = once(tm, 'done')
  await claudeWrites(tm.get(managed)!.statusPath, { state: 'done', result: { summary: 'swept' } })
  await doneA
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(submits.length, 1)
  assert.equal(submits[0].outcome, 'done')
  assert.deepEqual(submits[0].injectedRecipes, [], 'nothing was injected to grade against')

  const raw = await tm.dispatch('open me a coding session', { mode: 'raw' })
  const doneB = once(tm, 'done')
  await claudeWrites(tm.get(raw)!.statusPath, { state: 'done', result: { summary: 'ok' } })
  await doneB
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(submits.length, 1, 'raw mode never hands off')
  tm.killAll()
})

test('a failed task no longer hands off — that gate required injected memory', { timeout: 5000 }, async () => {
  const baseDir = await tmpBase()
  const submits: any[] = []
  const librarian = { submit: async (s: any) => { submits.push(s) } } as any
  const tm = new TaskManager({ executorFactory: () => makeFakeExecutor(), baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 25, librarian })
  const id = await tm.dispatch('scan my inboxes')
  const failed = once(tm, 'failed')
  await claudeWrites(tm.get(id)!.statusPath, { state: 'failed', error: { reason: 'boom' } })
  await failed
  await new Promise((r) => setTimeout(r, 50))
  // The rule was "a wrong injected recipe is a contradiction signal". With
  // nothing injected there is no signal, so a failure is just noise — exactly
  // what the gate always said.
  assert.equal(submits.length, 0)
  tm.killAll()
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

test('Codex work dispatches exactly once through the native hub', async () => {
  const baseDir = await tmpBase()
  let hubStarts = 0
  const hubSends: string[] = []
  const hub = {
    async startThread() {
      hubStarts++
      return { threadId: `codex-thread-${hubStarts}`, url: 'ws://127.0.0.1:1' }
    },
    async send(_threadId: string, intent: string) { hubSends.push(intent); return true },
    threadIdFor() { return undefined },
  }
  const agents: Array<AgentKind | undefined> = []
  const tm = new TaskManager({
    executorFactory: (_resume, agent) => { agents.push(agent); return makeFakeExecutor() },
    codexHub: hub as never,
    baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 9999,
  })

  const persistent = await tm.dispatch('long Codex thread', { agent: 'codex', kind: 'session' })
  const oneoff = await tm.dispatch('quick Codex errand', { agent: 'codex', kind: 'oneoff' })

  assert.equal(hubStarts, 2)
  assert.deepEqual(hubSends, ['long Codex thread', 'quick Codex errand'])
  assert.deepEqual(agents, ['codex', 'codex'])
  assert.equal(tm.get(persistent)!.agent, 'codex')
  assert.equal(tm.get(oneoff)!.agent, 'codex')
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

test('project-bound dispatch: spawns in the project dir and pollutes NOTHING there', async () => {
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

  // NO inline contract. It used to ride in the payload here — as a USER TURN —
  // precisely because we would not write a CLAUDE.md into the user's repo. It
  // now lives in the system prompt (--append-system-prompt) instead, so the
  // conversation contains only what the user actually said.
  assert.equal(fake.writes[0], 'work on the gating feature')
  assert.ok(!fake.writes[0].includes(task.statusPath), 'status path leaked into the payload')

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
  // A scratch spawn is now exactly as clean as a project-bound one: no
  // CLAUDE.md, and the payload is the intent.
  const inHome = await fs.readdir(task.home)
  assert.ok(!inHome.includes('CLAUDE.md'), 'scratch spawn still writes a CLAUDE.md')
  tm.killAll()
})

// ─── Multimodal attachments: the voice-era screenshot paste ───────────────────

test('attachFile saves under home/attachments without mutating the terminal draft', async () => {
  const baseDir = await tmpBase()
  const fake = makeFakeExecutor()
  const tm = new TaskManager({ executorFactory: () => fake, baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 9999 })
  const id = await tm.dispatch('look at this design')
  const beforeRaw = fake.raw.length
  const saved = await tm.attachFile(id, new Uint8Array([137, 80, 78, 71]), 'png')
  assert.ok(saved, 'returns the saved path')
  assert.ok(saved!.startsWith(path.join(tm.get(id)!.home, 'attachments')), 'stored in OUR dir, never the project')
  assert.ok((await fs.stat(saved!)).isFile())
  // Saving an attachment must not inject an invisible path into a terminal.
  const typed = fake.raw.slice(beforeRaw).join('')
  assert.equal(typed, '')
  // Storage belongs to the task draft, not to a process. A cold task remains a
  // valid draft destination and provider delivery decides whether it can send.
  tm.kill(id)
  const coldSaved = await tm.attachFile(id, new Uint8Array([1]), 'png')
  assert.ok(coldSaved)
  assert.ok((await fs.stat(coldSaved!)).isFile())
})

test('attachFile persists a Codex Desktop image although that task never has a PTY', async () => {
  const baseDir = await tmpBase()
  const id = await seedInterrupted(baseDir, 'session', { agent: 'codex-desktop', codexThreadId: 'thread-1' })
  const tm = new TaskManager({
    executorFactory: () => { throw new Error('desktop tasks must not create an executor') },
    baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 9999,
  })
  await tm.rehydrate()

  const saved = await tm.attachFile(id, new Uint8Array([137, 80, 78, 71]), 'png')
  assert.ok(saved)
  assert.ok(saved!.startsWith(path.join(tm.get(id)!.home, 'attachments')))
  assert.ok((await fs.stat(saved!)).isFile())
  tm.killAll()
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
  const metaPath = path.join(tm.get(id)!.home, 'meta.json')
  let persistedActivity = 0
  for (let attempt = 0; attempt < 40 && persistedActivity !== 1_800_000; attempt++) {
    persistedActivity = JSON.parse(await fs.readFile(metaPath, 'utf8')).lastUserInputAt ?? 0
    if (persistedActivity !== 1_800_000) await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.equal(persistedActivity, 1_800_000,
    'the idle-policy clock survives an app restart')
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

test('a finished THREAD parks the session WARM: executor alive, not counted active', { timeout: 5000 }, async () => {
  const baseDir = await tmpBase()
  const fake = makeFakeExecutor()
  const tm = new TaskManager({ executorFactory: () => fake, baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 25, warmMs: 60_000 })
  const id = await tm.dispatch('load the video and tell me about it')
  tm.setKind(id, 'session')
  await claudeWrites(tm.get(id)!.statusPath, { state: 'done', result: { summary: 'Video loaded — ready for what you want next' } })
  await waitForState(tm, id, 'done')
  assert.equal(fake.alive, true, 'the thread stays warm — its turn ended, it did not end')
  assert.equal(tm.activeCount(), 0, 'turn-over: not "running"')
  assert.equal(tm.get(id)!.result?.summary, 'Video loaded — ready for what you want next')
  tm.kill(id)
})

test('killing a finished thread leaves it finished — it did not fail', { timeout: 5000 }, async () => {
  // THIS ASSERTED 'failed' UNDER THE OLD MODEL, and it was right to: `ready`
  // meant "awaiting you", so ending it there really was an interruption. A
  // `done` thread genuinely completed its turn. Recording that as a failure
  // would put a red row on the wall for work that succeeded — the user simply
  // closed the session afterwards.
  const baseDir = await tmpBase()
  const tm = new TaskManager({ executorFactory: () => makeFakeExecutor(), baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 25, warmMs: 60_000 })
  const id = await tm.dispatch('x')
  tm.setKind(id, 'session')
  await claudeWrites(tm.get(id)!.statusPath, { state: 'done' })
  await waitForState(tm, id, 'done')
  tm.kill(id)
  assert.equal(tm.get(id)!.state, 'done')
})

// THE DECAY-VALVE TEST LIVED HERE and the feature is gone with `ready`.
//
// It settled an ignored `ready` one-off to `done` after an hour so it would
// stop haunting the queue. But `done` also meant "fades off the notch in
// fifteen minutes", so the valve did not quiet a task — it removed it from
// everywhere the user could reach without opening the dashboard. Quieting is
// the notch's job now (DEMAND_WINDOW_MS), and it steps a task down a tier
// rather than off a cliff. Nothing rewrites state behind the user any more.

test('resume of a finished thread is SILENT — warm re-entry, no continue nudge', { timeout: 5000 }, async () => {
  const baseDir = await tmpBase()
  const fake = makeFakeExecutor()
  const tm = new TaskManager({ executorFactory: () => fake, baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 9999 })
  const tid = randomUUID()
  const dir = path.join(baseDir, 'local', tid)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify({ id: tid, intent: 'load the video', kind: 'session', createdAt: Date.now() }))
  await claudeWrites(path.join(dir, 'status.json'), { state: 'done', result: { summary: 'loaded' } })
  await tm.rehydrate()
  assert.equal(tm.get(tid)!.state, 'done')
  const ok = await tm.resume(tid)
  assert.equal(ok, true)
  // The ball is with the USER. Nudging "continue" would snatch it back.
  assert.ok(!fake.writes.some((w) => /resumed|continue now/i.test(w)), 'no nudge into a finished thread')
  assert.equal(tm.get(tid)!.state, 'done')
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

test('a session closed by the quit switch comes back FINISHED, not failed; a one-off still reads interrupted', async () => {
  const baseDir = await tmpBase()
  const sid = await seedInterrupted(baseDir, 'session')
  const oid = await seedInterrupted(baseDir, 'oneoff')
  const tm = new TaskManager({ executorFactory: () => makeFakeExecutor(), baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 9999 })
  await tm.rehydrate()
  // The quit switch closes every session BY DESIGN — that is not a failure.
  assert.equal(tm.get(sid)!.state, 'done', 'a thread restores as ball-with-you, not as a failure')
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
  const activityBeforeOpen = tm.get(sid)!.updatedAt

  tm.opened(sid)
  await waitFor(() => tm.isAlive(sid))
  assert.equal(spawns, 1, 'opening the card resumed it')
  // The session is BACK, not restarted. Resume no longer nudges it into
  // 'processing' — nothing has been said to it, so nothing is in flight.
  assert.equal(tm.isAlive(sid), true, 'reachable again, which is all resume promises')
  assert.equal(tm.get(sid)!.updatedAt, activityBeforeOpen,
    'automatic relaunch is liveness, not new task activity')

  // A one-off is opened to READ its result — resuming it would spawn a REPL
  // behind the user's back (and after a purge there is nothing to resume).
  tm.opened(oid)
  await new Promise((r) => setTimeout(r, 120))
  assert.equal(spawns, 1, 'one-off keeps its explicit Resume button')
  assert.equal(tm.isAlive(oid), false)
  tm.killAll()
})

test('startup reattaches a persistent tmux runtime without typing or resubmitting a turn', async () => {
  const baseDir = await tmpBase()
  const sid = await seedInterrupted(baseDir, 'session', { agent: 'claude', runtimePinned: true })
  let spawned: SpawnOpts | null = null
  const fake = makeFakeExecutor({ onSpawn: (o) => { spawned = o } })
  const tm = new TaskManager({
    executorFactory: () => fake,
    listLiveRuntimeIds: async () => new Set([sid]),
    baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 9999,
  })
  await tm.rehydrate()

  await tm.reattachPersistent()

  assert.equal(spawned?.attachExisting, true, 'startup attaches the existing tmux session')
  assert.deepEqual(fake.writes, [], 'reattachment never presses Enter or creates a user turn')
  assert.equal(tm.isAlive(sid), true)
  tm.killAll()
})

test('startup reattaches a live one-off runtime without restarting its turn', async () => {
  const baseDir = await tmpBase()
  const id = await seedInterrupted(baseDir, 'oneoff', { agent: 'codex', state: 'processing' })
  let spawned: SpawnOpts | null = null
  const fake = makeFakeExecutor({ onSpawn: (o) => { spawned = o } })
  const tm = new TaskManager({
    executorFactory: () => fake,
    listLiveRuntimeIds: async () => new Set([id]),
    baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 9999,
  })
  await tm.rehydrate()

  await tm.reattachPersistent()

  assert.equal(spawned?.attachExisting, true)
  assert.deepEqual(fake.writes, [], 'reattachment never resubmits the one-off prompt')
  assert.equal(tm.isAlive(id), true)
  assert.equal(tm.get(id)!.state, 'processing', 'a live one-off remains in flight after relaunch')
  assert.equal(tm.get(id)!.error, undefined)
  tm.killAll()
})

test('a completed one-off reattached after relaunch still expires on its warm timer', { timeout: 5000 }, async () => {
  const baseDir = await tmpBase()
  const id = await seedInterrupted(baseDir, 'oneoff', { agent: 'codex', state: 'done' })
  const dir = path.join(baseDir, 'local', id)
  await claudeWrites(path.join(dir, 'status.json'), { state: 'done', result: { summary: 'finished' } })
  const fake = makeFakeExecutor()
  const tm = new TaskManager({
    executorFactory: () => fake,
    listLiveRuntimeIds: async () => new Set([id]),
    baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 9999, warmMs: 80,
  })
  await tm.rehydrate()

  await tm.reattachPersistent()

  assert.equal(tm.isAlive(id), true, 'the remaining follow-up window survives relaunch')
  await new Promise((resolve) => setTimeout(resolve, 140))
  assert.equal(tm.isAlive(id), false, 'the ordinary one-off warm expiry remains authoritative')
})

test('a discovered Codex rollout handle is persisted for restart reattachment', async (t) => {
  const baseDir = await tmpBase()
  const tm = new TaskManager({
    executorFactory: () => makeFakeExecutor(),
    baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 9999,
  })
  const id = await tm.dispatch('keep this Codex thread attached', { agent: 'codex', kind: 'session' })
  t.after(() => tm.killAll())
  const task = tm.get(id)!
  const rolloutId = randomUUID()

  // Codex mints this identity after spawn. Persisting only state/conversation
  // leaves a surviving tmux process addressable but its structured transcript
  // anonymous after Unmute restarts.
  task.codexRolloutId = rolloutId
  const internals = tm as unknown as { persistState: (task: typeof task) => Promise<void> }
  await internals.persistState(task)

  const meta = JSON.parse(await fs.readFile(path.join(task.home, 'meta.json'), 'utf8'))
  assert.equal(meta.codexRolloutId, rolloutId, 'the provider transcript identity survives restart')
})

test('reattaching a completed Codex runtime does not revive stale scaffold processing state', async (t) => {
  const baseDir = await tmpBase()
  const sid = await seedInterrupted(baseDir, 'session', {
    agent: 'codex',
    runtimePinned: true,
    codexRolloutId: randomUUID(),
    state: 'done',
  })
  const tm = new TaskManager({
    executorFactory: () => makeFakeExecutor(),
    listLiveRuntimeIds: async () => new Set([sid]),
    baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 9999,
  })
  t.after(() => tm.killAll())
  await tm.rehydrate()
  assert.equal(tm.get(sid)!.state, 'done', 'the durable task state is complete before attachment')

  await tm.reattachPersistent()

  assert.equal(tm.get(sid)!.state, 'done', 'a stale Codex status scaffold must not make an idle thread Working')
  assert.equal(tm.isAlive(sid), true, 'the terminal runtime remains natively reachable')
})

test('rehydrate trusts completed status for Codex one-offs and repairs stale metadata', async (t) => {
  const baseDir = await tmpBase()
  const id = await seedInterrupted(baseDir, 'oneoff', {
    agent: 'codex',
    state: 'processing',
  })
  const dir = path.join(baseDir, 'local', id)
  await claudeWrites(path.join(dir, 'status.json'), {
    state: 'done',
    result: { summary: 'Message sent.' },
  })
  const tm = new TaskManager({
    executorFactory: () => makeFakeExecutor(),
    baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 9999,
  })
  t.after(() => tm.killAll())

  await tm.rehydrate()

  assert.equal(tm.get(id)!.state, 'done', 'a completed one-off must not return as Working')
  const repaired = JSON.parse(await fs.readFile(path.join(dir, 'meta.json'), 'utf8'))
  assert.equal(repaired.state, 'done', 'the canonical state must replace stale metadata on disk')
})

test('startup never restarts a missing persistent runtime; it keeps the task resumable', async () => {
  const baseDir = await tmpBase()
  const sid = await seedInterrupted(baseDir, 'session', { agent: 'claude', runtimePinned: true })
  let attempts = 0
  const tm = new TaskManager({
    executorFactory: () => ({
      ...makeFakeExecutor(),
      spawn: async (opts) => {
        attempts++
        assert.equal(opts.attachExisting, true)
        throw new Error('tmux session not found')
      },
    }),
    listLiveRuntimeIds: async () => new Set(),
    baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 9999,
  })
  await tm.rehydrate()

  await tm.reattachPersistent()

  assert.equal(attempts, 0, 'a historical ticket is not probed as though it were a live runtime')
  assert.equal(tm.isAlive(sid), false)
  assert.equal(tm.get(sid)!.state, 'done', 'the ticket remains available for explicit Resume')
  assert.equal(tm.get(sid)!.resumeError, undefined, 'a normal machine restart is not shown as a task failure')
})

test('startup reattaches only task ids reported by the live tmux runtime registry', async () => {
  const baseDir = await tmpBase()
  const live = await seedInterrupted(baseDir, 'session', { agent: 'claude', runtimePinned: true })
  const historical = await seedInterrupted(baseDir, 'session', { agent: 'claude', runtimePinned: true })
  const attached: string[] = []
  const tm = new TaskManager({
    executorFactory: () => makeFakeExecutor({ onSpawn: (opts) => attached.push(opts.taskId) }),
    listLiveRuntimeIds: async () => new Set([live]),
    baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 9999,
  })
  await tm.rehydrate()

  await tm.reattachPersistent()

  assert.deepEqual(attached, [live])
  assert.equal(tm.isAlive(live), true)
  assert.equal(tm.isAlive(historical), false)
  assert.equal(tm.get(historical)!.state, 'done')
  tm.killAll()
})

test('a corrupt Codex rollout stops its poller instead of retrying forever', async () => {
  const baseDir = await tmpBase()
  const rollout = path.join(baseDir, 'corrupt-rollout.jsonl')
  await fs.writeFile(rollout, 'not-json\n')
  const tm = new TaskManager({
    executorFactory: () => makeFakeExecutor(),
    baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 5,
  })
  let calls = 0
  const internals = tm as unknown as {
    poll: (id: string) => Promise<void>
    startPolling: (id: string) => void
    scheduler: { keys: () => IterableIterator<string> }
  }
  internals.poll = async () => {
    calls++
    await readRolloutEvents(rollout)
  }

  internals.startPolling('corrupt-task')
  await waitFor(() => calls === 1)
  await new Promise((resolve) => setTimeout(resolve, 30))

  assert.equal(calls, 1, 'the deterministic error is not retried on every tick')
  assert.equal([...internals.scheduler.keys()].includes('corrupt-task'), false)
})

test('an unpinned persistent runtime expires after seven idle days but its task remains resumable', async () => {
  const baseDir = await tmpBase()
  let now = 1_000_000
  const fakes: ReturnType<typeof makeFakeExecutor>[] = []
  const tm = new TaskManager({
    executorFactory: () => { const fake = makeFakeExecutor(); fakes.push(fake); return fake },
    baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 9999,
    persistentIdleMs: 7 * 24 * 60 * 60_000,
    now: () => now,
  })
  const expiring = await tm.dispatch('a thread that graduated')
  tm.setKind(expiring, 'session') // automatic graduation: persistent, not explicitly pinned
  const pinned = await tm.dispatch('a user-pinned thread')
  tm.setKind(pinned, 'session', { pinned: true })
  now += 7 * 24 * 60 * 60_000 + 1

  await tm.purgeStale()

  assert.equal(fakes[0].killed(), 1, 'expired runtime is actually stopped')
  assert.ok(tm.get(expiring), 'task/ticket is retained')
  assert.equal(tm.get(expiring)!.state, 'done', 'retained task can be resumed later')
  assert.equal(fakes[1].killed(), 0, 'explicitly pinned runtime has no idle expiry')
  tm.killAll()
})

test('a failed automatic relaunch reports the error without rewriting task activity', { timeout: 5000 }, async () => {
  const baseDir = await tmpBase()
  const sid = await seedInterrupted(baseDir, 'session')
  const tm = new TaskManager({
    executorFactory: () => { throw new Error('PTY_RELAUNCH_FAILED') },
    baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 9999,
  })
  await tm.rehydrate()
  const activityBeforeOpen = tm.get(sid)!.updatedAt

  tm.opened(sid)
  await waitFor(() => !!tm.get(sid)!.resumeError)

  assert.match(tm.get(sid)!.resumeError ?? '', /PTY_RELAUNCH_FAILED/)
  assert.equal(tm.get(sid)!.updatedAt, activityBeforeOpen,
    'a process failure is visible, but opening still is not new task activity')
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
  // The retries work out — real tool execution resumes, and the PostToolUse
  // hook tells us directly rather than us noticing a marker file's mtime.
  tm.onHookEvent({ kind: 'tool-used', sessionId: tm.get(id)!.sessionId! })
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

// ─── The conversation, for a PTY task too ────────────────────────────────────

test('dispatch shows the ask immediately, and a follow-up replaces it', async () => {
  // A card that is blank for the first thirty seconds of every task reads as
  // broken — and the user already knows what they said. The transcript is still
  // the source of truth; this is what fills the gap until a turn ends.
  const baseDir = await tmpBase()
  const fake = makeFakeExecutor()
  const tm = new TaskManager({ executorFactory: () => fake, baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 9999 })
  const id = await tm.dispatch('summarize the pricing thread')
  assert.deepEqual(tm.get(id)!.conversation, [{ role: 'user', text: 'summarize the pricing thread' }])

  tm.followUp(id, 'now compare it with last quarter')
  await new Promise((r) => setTimeout(r, 0))
  assert.deepEqual(tm.get(id)!.conversation, [{ role: 'user', text: 'now compare it with last quarter' }])
  tm.killAll()
})

test('a finished turn puts the model reply into the conversation, from the EVENT not the file', async () => {
  // The field bug: the reply was read back from the transcript JSONL, which
  // Claude Code has not flushed when Stop fires. The read came back empty, a
  // length guard skipped the update, and a DONE task showed the user's question
  // and nothing else — while the status file held the full 2.5k reply, because
  // that path used the payload. One event, two fields, one of them going to a
  // file that did not exist yet.
  const baseDir = await tmpBase()
  const tm = new TaskManager({ executorFactory: () => makeFakeExecutor(), baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 9999 })
  const id = await tm.dispatch('summarize my bookmarks')
  const sessionId = tm.get(id)!.sessionId!

  const done = once(tm, 'done')
  tm.onHookEvent({ kind: 'turn-ended', sessionId, lastMessage: 'Here are your 5 most recent bookmarks:\n\n1. prateek — kanban in Codex' })
  await done

  const convo = tm.get(id)!.conversation ?? []
  assert.deepEqual(convo.map((t) => t.role), ['user', 'assistant'], 'both sides must be present')
  assert.equal(convo[0].text, 'summarize my bookmarks')
  assert.match(convo[1].text, /5 most recent bookmarks/)
  // And the same text is what the status carries — one reply, two fields.
  assert.match(tm.get(id)!.result!.detail!, /5 most recent bookmarks/)
  tm.killAll()
})

test('a hook event can NEVER land on a driven backend, by session id or by cwd', async () => {
  // The isolation is asymmetric: dispatch() forks to the drivers before any hook
  // code runs, so the OUTBOUND side is guarded by construction. The inbound side
  // matched on identity alone — and both fallbacks are reachable. A Codex task
  // stores the Codex THREAD id in `sessionId`; a Claude-desktop task carries a
  // real project `cwd`. So a CLI session firing hooks from the same repo could
  // have selected the desktop card, and we would have written a derived status
  // onto a task whose agent we never spoke to.
  const baseDir = await tmpBase()
  const tm = new TaskManager({ executorFactory: () => makeFakeExecutor(), baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 9999 })
  const cli = await tm.dispatch('a real claude task')
  const claudeTask = tm.get(cli)!

  // A driven task that shares BOTH keys with the hook payload.
  const alien = { ...claudeTask, id: 'codex-1', agent: 'codex-desktop' as AgentKind, createdAt: claudeTask.createdAt + 1000 }
  ;(tm as unknown as { tasks: Map<string, Task> }).tasks.set('codex-1', alien)

  tm.onHookEvent({ kind: 'turn-ended', sessionId: claudeTask.sessionId!, cwd: claudeTask.cwd, lastMessage: 'done here' })
  await new Promise((r) => setTimeout(r, 30))

  assert.equal(tm.get('codex-1')!.state, claudeTask.state === 'done' ? 'processing' : tm.get('codex-1')!.state,
    'the driven task must not have been transitioned')
  assert.equal((tm.get('codex-1')!.conversation ?? []).length, (alien.conversation ?? []).length,
    'the driven task must not have gained a conversation')
  assert.match(tm.get(cli)!.result?.detail ?? '', /done here/, 'the CLI task is the one that got it')
  tm.killAll()
})

test('a choice is answered by INDEX — typing the label picks the wrong option', async () => {
  // Verified on a live session: AskUserQuestion is a numbered picker, so typing
  // "Spaces" and pressing Enter recorded "Tabs" (the highlighted default). The
  // user picks one thing, the agent receives another, and nothing reports an
  // error — the worst class of bug this surface can have.
  const baseDir = await tmpBase()
  const fake = makeFakeExecutor()
  const tm = new TaskManager({ executorFactory: () => fake, baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 9999 })
  const id = await tm.dispatch('pick something')
  const sessionId = tm.get(id)!.sessionId!
  tm.onHookEvent({ kind: 'ask-opened', sessionId, askId: 'toolu_1', questions: [{ question: 'Tabs or spaces?', multiSelect: false, options: [{ label: 'Tabs' }, { label: 'Spaces' }] }] })
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(tm.get(id)!.state, 'needs-user')

  const before = fake.raw.length
  tm.answer(id, 'Spaces')                       // the SECOND option
  assert.equal(fake.raw.slice(before).join(''), '2', 'must send the index, not the label')
  assert.equal(tm.get(id)!.state, 'processing')
  tm.killAll()
})

test('with no picker open, an answer is still typed as text', { timeout: 8000 }, async () => {
  // The ordinary case: the session is at its prompt, not inside a widget. This
  // is the path the refusal below must NOT swallow — a CLI task with no open
  // ask keeps writing to stdin exactly as it always did.
  const baseDir = await tmpBase()
  const fake = makeFakeExecutor()
  const tm = new TaskManager({ executorFactory: () => fake, baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 9999 })
  const id = await tm.dispatch('ask me something')
  await new Promise((r) => setTimeout(r, 30))
  const before = fake.writes.length
  tm.answer(id, 'do the thing')
  assert.equal(fake.writes.at(-1), 'do the thing')
  assert.ok(fake.writes.length > before)
  tm.killAll()
})

test('the conversation survives a restart', { timeout: 8000 }, async () => {
  // It lived only in memory, so every relaunch emptied the chat strip for every
  // existing task and left the short status line where the exchange should be.
  const baseDir = await tmpBase()
  const tm = new TaskManager({ executorFactory: () => makeFakeExecutor(), baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 9999 })
  const id = await tm.dispatch('summarize the thread')
  const sessionId = tm.get(id)!.sessionId!
  const done = once(tm, 'done')
  tm.onHookEvent({ kind: 'turn-ended', sessionId, lastMessage: 'Here is the summary.' })
  await done
  await new Promise((r) => setTimeout(r, 60))
  tm.killAll()

  const tm2 = new TaskManager({ executorFactory: () => makeFakeExecutor(), baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 9999 })
  await tm2.rehydrate()
  const convo = tm2.get(id)?.conversation ?? []
  assert.deepEqual(convo.map((t) => t.role), ['user', 'assistant'], 'both turns must come back')
  assert.match(convo[1].text, /Here is the summary/)
  tm2.killAll()
})

test('a complex ask is NOT answered by us — it goes to the terminal', { timeout: 8000 }, async () => {
  // A tab bar: pick, auto-advance, toggle, Tab to an unnumbered Submit, Enter.
  // We have watched that sequence and never driven it, and half-driving it
  // leaves the model waiting on a picker nobody is holding.
  const baseDir = await tmpBase()
  const fake = makeFakeExecutor()
  const tm = new TaskManager({ executorFactory: () => fake, baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 9999 })
  const id = await tm.dispatch('ask me two things')
  const sessionId = tm.get(id)!.sessionId!
  tm.onHookEvent({ kind: 'ask-opened', sessionId, askId: 'toolu_x', questions: [
    { question: 'Colour?', multiSelect: false, options: [{ label: 'Blue' }] },
    { question: 'Languages?', multiSelect: true, options: [{ label: 'Go' }] },
  ] })
  await new Promise((r) => setTimeout(r, 30))
  const beforeRaw = fake.raw.length
  const beforeWrites = fake.writes.length
  tm.answer(id, 'Blue')
  assert.equal(fake.raw.slice(beforeRaw).join(''), '', 'must not send an index for a shape we cannot drive')
  // AND MUST NOT FALL BACK TO TYPING. This used to write "Blue" + Enter into a
  // session rendering a picker: the prose lands nowhere and the Enter commits
  // whatever is HIGHLIGHTED — the same wrong-option corruption the index branch
  // exists to prevent, arriving through the fallback instead.
  assert.equal(fake.writes.length, beforeWrites, 'must not type prose at an open picker')
  assert.equal(tm.get(id)!.state, 'needs-user', 'still blocked — we did not answer it')
  assert.match(tm.get(id)!.deliveryError ?? '', /terminal/, 'and it says why')
  tm.killAll()
})

test('an answer that matches no option is refused too, not typed', { timeout: 8000 }, async () => {
  // The ask IS drivable, but "purple" is not one of its options, so there is no
  // index to send. The picker is still open, so typing the word is exactly as
  // wrong here as it is for a shape we never drive.
  const baseDir = await tmpBase()
  const fake = makeFakeExecutor()
  const tm = new TaskManager({ executorFactory: () => fake, baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 9999 })
  const id = await tm.dispatch('pick a colour')
  const sessionId = tm.get(id)!.sessionId!
  tm.onHookEvent({ kind: 'ask-opened', sessionId, askId: 'toolu_y', questions: [
    { question: 'Colour?', multiSelect: false, options: [{ label: 'Blue' }, { label: 'Green' }] }] })
  await new Promise((r) => setTimeout(r, 30))
  const beforeRaw = fake.raw.length
  const beforeWrites = fake.writes.length
  tm.answer(id, 'purple')
  assert.equal(fake.raw.slice(beforeRaw).join(''), '', 'nothing to index')
  assert.equal(fake.writes.length, beforeWrites, 'and nothing typed at the picker')
  assert.equal(tm.get(id)!.state, 'needs-user')
  assert.match(tm.get(id)!.deliveryError ?? '', /purple/, 'names what did not match')
  // The card is promoted to the refusal shape, which is what opens the terminal.
  assert.equal(tm.get(id)!.question?.kind, 'terminal_only')
  tm.killAll()
})

test('closing an ask clears it, so a stale question cannot shadow a live one', { timeout: 8000 }, async () => {
  const baseDir = await tmpBase()
  const tm = new TaskManager({ executorFactory: () => makeFakeExecutor(), baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 9999 })
  const id = await tm.dispatch('ask me')
  const sessionId = tm.get(id)!.sessionId!
  tm.onHookEvent({ kind: 'ask-opened', sessionId, askId: 'toolu_a', questions: [{ question: 'Q?', multiSelect: false, options: [{ label: 'A' }] }] })
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(tm.get(id)!.state, 'needs-user')
  tm.onHookEvent({ kind: 'ask-closed', sessionId, askId: 'toolu_a', answers: { 'Q?': 'A' } })
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(tm.get(id)!.state, 'processing')
  assert.equal(tm.get(id)!.openAsk, undefined)
  tm.killAll()
})

test('a Notification cannot bury a live ask', { timeout: 8000 }, async () => {
  // The football bug: question-asked → permission-asked → waiting, each
  // overwriting, leaving "Claude needs your permission" with no options.
  const baseDir = await tmpBase()
  const tm = new TaskManager({ executorFactory: () => makeFakeExecutor(), baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 9999 })
  const id = await tm.dispatch('football')
  const sessionId = tm.get(id)!.sessionId!
  tm.onHookEvent({ kind: 'ask-opened', sessionId, askId: 'toolu_f', questions: [
    { question: 'Which sport?', multiSelect: false, options: [{ label: 'Soccer' }, { label: 'American football' }] }] })
  await new Promise((r) => setTimeout(r, 30))
  tm.onHookEvent({ kind: 'waiting', sessionId, message: 'Claude needs your permission', notificationType: 'permission_prompt' })
  tm.onHookEvent({ kind: 'permission-asked', sessionId, tool: 'AskUserQuestion', summary: '' })
  await new Promise((r) => setTimeout(r, 40))
  assert.match(tm.get(id)!.question!.text, /Which sport/)
  assert.deepEqual(tm.get(id)!.question!.choices, ['Soccer', 'American football'])
  tm.killAll()
})

test('a message to a cold session revives it and is delivered, not dropped', { timeout: 8000 }, async () => {
  // IT USED TO DROP THE MESSAGE AND RETURN TRUE — reporting success for a reply
  // that went nowhere, so the crank advanced past a task you had just answered.
  // Nobody noticed because merely OPENING a task auto-resumed it, which is the
  // same call that rewrote a five-day-old task's clock and threw it into Today.
  // The revive belongs on the send: that is the interaction.
  const baseDir = await tmpBase()
  const fake = makeFakeExecutor()
  const tm = new TaskManager({ executorFactory: () => fake, baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 25 })
  const id = await tm.dispatch('go through the repo')
  tm.setKind(id, 'session')
  fake.writes.length = 0
  fake.alive = false                       // the session died with the app
  assert.equal(tm.answer(id, 'carry on'), true)
  await waitFor(() => fake.writes.some((w) => w.includes('carry on')), 4000)
  assert.ok(fake.alive, 'and the session is back')
  tm.kill(id)
})

test('resume heals a task whose cwd is wrong, from any caller', async () => {
  // THE FIELD BUG: an imported card's Resume did nothing, twice, ten seconds
  // apart — `fs.access(task.cwd)` failed and `resume` returned false into a log
  // nobody reads. The path was wrong because an early import reconstructed it
  // from the transcript FOLDER name, which is lossy.
  //
  // Healing at the import path would have fixed one door. This asserts it heals
  // at `resume` itself, which is the door the button, voice, the router and
  // revive-on-send all pass through.
  const baseDir = await tmpBase()
  const real = path.join(baseDir, 'a-real-project')
  await fs.mkdir(real, { recursive: true })
  const fake = makeFakeExecutor()
  const tm = new TaskManager({
    executorFactory: () => fake, baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 9999,
    resolveSessionCwd: async () => real,
  })
  const id = await tm.dispatch('go through the repo')
  tm.setKind(id, 'session')
  const t = tm.get(id)!
  t.sessionId = 'sess-1'
  t.cwd = path.join(baseDir, 'gone', 'never', 'existed')
  // A DEAD session, properly: `resume` short-circuits on a registered live
  // executor, so clearing the flag alone leaves it returning true before it
  // ever reaches the recovery. The first version of this test did exactly that
  // and passed while proving nothing.
  fake.alive = false
  ;(tm as unknown as { executors: Map<string, unknown> }).executors.delete(id)

  await tm.resume(id)
  assert.equal(tm.get(id)!.cwd, real, 'the task keeps the corrected path')
  tm.kill(id)
})

test('resume still refuses — loudly — when there is nothing to recover', async () => {
  const baseDir = await tmpBase()
  const fake = makeFakeExecutor()
  const tm = new TaskManager({
    executorFactory: () => fake, baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 9999,
    resolveSessionCwd: async () => null,        // no transcript anywhere
  })
  const id = await tm.dispatch('x')
  tm.setKind(id, 'session')
  tm.get(id)!.cwd = path.join(baseDir, 'gone')
  fake.alive = false
  ;(tm as unknown as { executors: Map<string, unknown> }).executors.delete(id)
  assert.equal(await tm.resume(id), false, 'false is what makes the surface say so')
  tm.kill(id)
})

test('resume sends NOTHING — it makes a session reachable, it does not take a turn in it', async () => {
  // THE FIELD REPORT: resuming an imported session typed "This was interrupted
  // before it finished and has just been resumed… pick up exactly where you
  // left off" into it and submitted. Resume did not restore a conversation, it
  // spoke in one, with words the user never wrote.
  //
  // Imports made it certain: they carry no status file, so `status?.state` was
  // undefined, `undefined !== 'done'` was true, and every single one got
  // prompted the moment it came back.
  const baseDir = await tmpBase()
  const fake = makeFakeExecutor()
  const tm = new TaskManager({ executorFactory: () => fake, baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 9999 })
  const id = await tm.dispatch('go through the repo')
  tm.setKind(id, 'session')
  // No status file at all — exactly an imported session's shape.
  await fs.rm(tm.get(id)!.statusPath, { force: true })
  fake.alive = false
  ;(tm as unknown as { executors: Map<string, unknown> }).executors.delete(id)
  fake.writes.length = 0

  assert.equal(await tm.resume(id), true)
  const said = fake.writes.join('')
  assert.ok(!/interrupted|pick up|resumed|continue/i.test(said),
    `resume must not speak, but it wrote: ${said.slice(0, 120)}`)
})

test('a Codex CLI task writes its state down, so a restart does not call it failed', async () => {
  // THE BUG THIS PINS. rehydrate() decides a restarted task's state from
  // status.json: a non-terminal file means "its session died with the app",
  // which for a one-off is reported as failed/interrupted. Right for Claude,
  // whose agent writes that file through the hooks Unmute installs.
  //
  // Nothing wrote it for Codex CLI — state arrives over the App Server and
  // landed in memory only — so the file kept the 'processing' the scaffold put
  // there at spawn, and every finished Codex task came back RED after any
  // restart. Seen in the field on two tasks that had completed forty minutes
  // earlier.
  const baseDir = await tmpBase()
  const tm = new TaskManager({
    executorFactory: () => makeFakeExecutor({}),
    baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 50,
  })
  const id = await tm.dispatch('summarise the release notes')
  const task = tm.get(id)!

  tm.applyHubPatch({ taskId: id, state: 'done', assistantText: 'Summarised.' })
  await new Promise((r) => setTimeout(r, 30))          // the write is fire-and-forget

  const onDisk = JSON.parse(await fs.readFile(task.statusPath, 'utf8'))
  assert.equal(onDisk.state, 'done', 'the finished state must survive the process')
  assert.equal(onDisk.result?.detail, 'Summarised.')
  // …which is exactly what rehydrate reads to decide the task is terminal
  // rather than interrupted.
  assert.ok(onDisk.state === 'done' || onDisk.state === 'failed')
})

test('an unchanged state is not news — the surface must not be re-triggered', async () => {
  // WHY THIS EXISTS. Several App Server events carry a state without changing
  // one: `turn/started` says processing on a task already processing, and
  // `thread/status/changed: active` says it again. Transitioning anyway
  // rewrites updatedAt, which re-sorts the wall, re-enters the attention path
  // and re-opens the surface — reported as a Codex task that "keeps expanding
  // every few seconds as if something interrupted it".
  //
  // pollCodexCli has had this guard all along; the hub path shipped without it.
  const baseDir = await tmpBase()
  const tm = new TaskManager({
    executorFactory: () => makeFakeExecutor({}),
    baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 50,
  })
  const id = await tm.dispatch('watch the build')
  const before = tm.get(id)!.updatedAt
  await new Promise((r) => setTimeout(r, 5))

  tm.applyHubPatch({ taskId: id, state: 'processing' })          // already processing
  assert.equal(tm.get(id)!.updatedAt, before, 'same state, no text ⇒ nothing moved')

  // …but a reply at the SAME state is still news: a streamed message arriving
  // while the task stays processing has to reach the card.
  tm.applyHubPatch({ taskId: id, state: 'processing', assistantText: 'halfway' })
  assert.ok(tm.get(id)!.updatedAt > before, 'new text must move the task')

  // And a real state change always lands.
  tm.applyHubPatch({ taskId: id, state: 'done' })
  assert.equal(tm.get(id)!.state, 'done')
})

// ── The warm window must never reap a session that is actually working ──
//
// Field failure (2026-08-20, task b8388aec): a one-off finished at 06:10:22 and
// parked warm with an 8-minute idle-kill armed. The user sent it a follow-up at
// 06:14:59 through the Right-Option capture path (deliverDraft), it went back to
// `processing`, and at 06:18:22 the timer armed BEFORE that message fired anyway
// and killed a session mid-work. The card read "The session ended before the
// task finished", which was true and told the user nothing about who ended it.
// It was us.

test('deliverDraft cancels the armed warm-kill (Right-Option reply keeps the session)', { timeout: 5000 }, async () => {
  const baseDir = await tmpBase()
  const fake = makeFakeExecutor()
  let submitted: () => void = () => {}
  const ex = Object.assign(fake, {
    writeDraftText(_t: string) {},
    submitDraft() { submitted() },
  })
  const tm = new TaskManager({ executorFactory: () => ex, baseDir, trustAcceptMs: 0, submitConfirmMs: 0, verifyAfterMs: 20, pollMs: 25, warmMs: 120 })
  const id = await tm.dispatch('analyse my transcripts')
  const task = tm.get(id)!
  submitted = () => tm.onHookEvent({ kind: 'prompt-submitted', sessionId: tm.get(id)!.sessionId })
  const done = once(tm, 'done')
  await claudeWrites(task.statusPath, { state: 'done', result: { summary: 'first pass done' } })
  await done // parked warm — the 120ms idle-kill is armed

  assert.equal(await tm.deliverDraft(id, 'also check the codex ones', []), true)
  await new Promise((r) => setTimeout(r, 250)) // well past the warm window
  assert.equal(ex.alive, true, 'the reply defused the warm-kill')
  tm.kill(id)
})

test('parking warm twice leaves NO orphan timer that can still reap the session', { timeout: 5000 }, async () => {
  const baseDir = await tmpBase()
  const fake = makeFakeExecutor()
  const tm = new TaskManager({ executorFactory: () => fake, baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 25, warmMs: 200 })
  const id = await tm.dispatch('watch this')
  const task = tm.get(id)!
  // Park #1 — arms timer A.
  await (async () => { const d = once(tm, 'done'); await claudeWrites(task.statusPath, { state: 'done', result: { summary: 'a' } }); await d })()
  await new Promise((r) => setTimeout(r, 60))
  // Wake (the field path: a hook, not a poll — polling stops when parked), then
  // finish again → park #2 arms timer B. Only B is remembered; A is unreachable.
  tm.onHookEvent({ kind: 'prompt-submitted', sessionId: tm.get(id)!.sessionId })
  await (async () => { const d = once(tm, 'done'); tm.onHookEvent({ kind: 'turn-ended', sessionId: tm.get(id)!.sessionId, lastMessage: 'b' }); await d })()
  // Pinning cancels "the" warm timer — it must cancel the only one there is.
  tm.setKind(id, 'session')
  await new Promise((r) => setTimeout(r, 450)) // past BOTH windows
  assert.equal(fake.alive, true, 'an orphaned timer from the first park reaped the session')
  tm.kill(id)
})

test('the warm-kill re-parks instead of killing a task that went back to work', { timeout: 5000 }, async () => {
  const baseDir = await tmpBase()
  const fake = makeFakeExecutor()
  const tm = new TaskManager({ executorFactory: () => fake, baseDir, trustAcceptMs: 0, submitConfirmMs: 0, pollMs: 25, warmMs: 150 })
  const id = await tm.dispatch('long job')
  const task = tm.get(id)!
  await (async () => { const d = once(tm, 'done'); await claudeWrites(task.statusPath, { state: 'done', result: { summary: 'turn one' } }); await d })()
  // Back to work by ANY route — the backstop must not care which one, and must
  // not depend on that route having remembered to cancel the timer.
  tm.onHookEvent({ kind: 'prompt-submitted', sessionId: tm.get(id)!.sessionId })
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(tm.get(id)!.state, 'processing', 'precondition: the session went back to work')
  await new Promise((r) => setTimeout(r, 300)) // past the armed window
  assert.equal(fake.alive, true, 'the idle-kill fired on a working session')
  assert.equal(tm.get(id)!.state, 'processing')
  tm.kill(id)
})
