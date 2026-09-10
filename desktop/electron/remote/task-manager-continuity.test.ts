import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskManager } from './task-manager.ts'
import { GroupRegistry } from './group-registry.ts'

test('Claude Desktop agent handoff has metadata before adoption publishes the card', async t => {
  const baseDir = await base()
  const groupRegistry = new GroupRegistry({ path: join(baseDir, 'groups.json'), idFactory: () => 'canonical-group' })
  groupRegistry.define('Unmute')
  let created = false
  const driver = { async list() { return created ? [{ sessionId: 'desktop-session', title: 'New task', cwd: baseDir, createdAt: Date.now(), lastActivityAt: Date.now(), model: null }] : [] } }
  const actuator = { async createTask(text: string) {
    assert.equal(text, 'repair billing'); created = true
    assert.deepEqual(await tm.adoptClaudeDesktop(), [], 'background discovery must wait for handoff metadata')
    return { ok: true }
  } }
  const tm = new TaskManager({ executorFactory, claudeDesktopDriver: driver as never, claudeActuator: actuator as never, baseDir, groupRegistry })
  t.after(() => tm.shutdown())
  const first: unknown[] = []
  tm.on('created', task => first.push({ name: task.name, group: task.group, groupId: task.groupId }))
  const id = await tm.dispatch('repair billing', { agent: 'claude-code-desktop', agentMetadata: { title: 'Repair billing migration', group: 'Unmute', agentRunId: 'run' } })
  assert.deepEqual(first, [{ name: 'Repair billing migration', group: 'Unmute', groupId: 'canonical-group' }])
  assert.equal(JSON.parse(await fs.readFile(join(tm.get(id)!.home, 'meta.json'), 'utf8')).name, 'Repair billing migration')
  const restarted = new TaskManager({ executorFactory, baseDir, groupRegistry })
  t.after(() => restarted.shutdown())
  await restarted.rehydrate()
  assert.equal(restarted.get(id)?.sessionId, 'desktop-session')
  assert.equal(restarted.get(id)?.agent, 'claude-code-desktop')
  assert.equal(restarted.get(id)?.origin, 'unmute-agent')
  await groupRegistry.flush()
})

test('agent dispatch publishes and persists its canonical metadata on the first created event', async () => {
  const baseDir = await base()
  const groupRegistry = new GroupRegistry({ path: join(baseDir, 'groups.json'), idFactory: () => 'canonical-group' })
  groupRegistry.define('Unmute')
  const sent: string[] = []
  const hub = { running: true, async startThread() { return { threadId: 'new-thread' } }, async send(_id: string, text: string) { sent.push(text); return true } }
  const tm = new TaskManager({ executorFactory, codexHub: hub as never, baseDir, groupRegistry })
  const first: unknown[] = []
  tm.on('created', task => first.push({ name: task.name, group: task.group, groupId: task.groupId, origin: task.origin }))
  const id = await tm.dispatch('repair billing', { agent: 'codex', agentMetadata: { title: 'Repair billing migration', group: 'unmute', agentRunId: 'run' } } as any)
  assert.deepEqual(first, [{ name: 'Repair billing migration', group: 'Unmute', groupId: 'canonical-group', origin: 'unmute-agent' }])
  assert.deepEqual(sent, ['repair billing'])
  const saved = JSON.parse(await fs.readFile(join(tm.get(id)!.home, 'meta.json'), 'utf8'))
  assert.equal(saved.name, 'Repair billing migration')
  assert.equal(saved.groupId, 'canonical-group')
  await groupRegistry.flush()
})

async function base(): Promise<string> {
  return fs.mkdtemp(join(tmpdir(), 'unmute-continuity-'))
}

function executorFactory(): never {
  throw new Error('continuity must not use a terminal executor')
}

test('message editing is disabled for Codex and cannot fork the provider thread', async t => {
  const baseDir = await base()
  let forks = 0
  const hub = {
    running: true,
    followupGate() { return { kind: 'idle', blocked: false } },
    async forkThread() { forks++; return { threadId: 'child', forkedFromId: 'source' } },
  }
  const tm = new TaskManager({ executorFactory, codexHub: hub as never, baseDir,
    codexFullAccess: () => true, permissionMode: () => 'auto-approve' })
  t.after(() => tm.shutdown())
  const id = await tm.createChat({ provider: 'codex', cwd: baseDir })
  const task = tm.get(id)!
  task.sessionId = 'source'
  task.sessionOwnership = 'unmute'
  task.chatUnstarted = false
  task.state = 'completed'
  task.blocks = [{ kind: 'message', role: 'user', text: 'Original' }]
  assert.equal(tm.canEditLatestMessage(id), false)
  assert.equal(await tm.editLatestMessage(id, 'Original', 'Replacement'), false)
  assert.equal(task.sessionId, 'source')
  assert.equal(forks, 0)
})

test('opening a restored task waits for the startup recovery barrier before resuming', async t => {
  const baseDir = await base()
  let resumes = 0
  const hub = { running: true, threadIdFor() { return undefined },
    async resumeThread() { resumes++ } }
  const tm = new TaskManager({ executorFactory, codexHub: hub as never, baseDir,
    codexFullAccess: () => true, permissionMode: () => 'auto-approve' })
  t.after(() => tm.shutdown())
  const finishRecovery = tm.beginStartupRecovery()
  const id = await tm.createChat({ provider: 'codex', cwd: baseDir })
  const task = tm.get(id)!
  task.chatUnstarted = false; task.sessionId = 'thread'; task.codexRolloutId = 'thread'; task.state = 'done'
  tm.opened(id)
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(resumes, 0)
  finishRecovery()
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(resumes, 1)
})

test('automatic resume failures are cooled down across repeated open announcements', async t => {
  const baseDir = await base()
  let resumes = 0
  const hub = { running: true, threadIdFor() { return undefined },
    async resumeThread() { resumes++; throw new Error('active writer') } }
  const tm = new TaskManager({ executorFactory, codexHub: hub as never, baseDir,
    codexFullAccess: () => true, permissionMode: () => 'auto-approve' })
  t.after(() => tm.shutdown())
  const id = await tm.createChat({ provider: 'codex', cwd: baseDir })
  const task = tm.get(id)!
  task.chatUnstarted = false; task.sessionId = 'thread'; task.codexRolloutId = 'thread'; task.state = 'done'
  tm.opened(id)
  await new Promise(resolve => setTimeout(resolve, 20))
  tm.opened(id)
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(resumes, 1)
})

test('rehydration does not invent a disconnected failure for a structured runtime awaiting recovery', async t => {
  const baseDir = await base()
  const id = 'structured-recovery'
  const home = join(baseDir, 'local', id)
  await fs.mkdir(home, { recursive: true })
  await fs.writeFile(join(home, 'meta.json'), JSON.stringify({
    id, intent: 'Keep working', agent: 'codex', sessionId: 'thread', codexRolloutId: 'thread',
    state: 'processing', kind: 'session', sessionOwnership: 'unmute',
    codexSessionSettings: { cwd: baseDir, approvalPolicy: 'on-request', sandbox: 'workspace-write' },
  }))
  await fs.writeFile(join(home, 'status.json'), JSON.stringify({ schema_version: 1, state: 'processing', updated_at: new Date().toISOString() }))
  const tm = new TaskManager({ executorFactory, codexHub: { running: false, threadIdFor() { return undefined } } as never, baseDir })
  t.after(() => tm.shutdown())
  await tm.rehydrate()
  assert.equal(tm.get(id)?.state, 'processing')
  assert.equal(tm.get(id)?.error, undefined)
})

test('unresolved Desktop handoff retains metadata across restart and refuses ambiguous adoption', async t => {
  const baseDir = await base()
  const groupRegistry = new GroupRegistry({ path: join(baseDir, 'groups.json'), idFactory: () => 'canonical-group' })
  groupRegistry.define('Unmute')
  let ids: string[] = []
  const driver = {
    async list() { return ids.map(sessionId => ({ sessionId, title: 'Provider title', cwd: baseDir, createdAt: Date.now(), lastActivityAt: Date.now(), model: null })) },
    async snapshot(id: string) { return { snapshot: { turns: [{ role: 'user', text: id === 'manual' ? 'plan a holiday' : 'repair billing' }] } } },
  }
  const first = new TaskManager({ executorFactory, baseDir, groupRegistry, claudeDesktopDriver: driver as never, claudeActuator: { async createTask() { return { ok: true } } } as never })
  t.after(() => first.shutdown())
  const unresolved = await first.createClaudeDesktop('repair billing', { tries: 1, waitMs: 0, agentMetadata: { title: 'Repair billing migration', group: 'Unmute', agentRunId: 'run' } })
  assert.equal(unresolved.id, undefined)
  const restarted = new TaskManager({ executorFactory, baseDir, groupRegistry, claudeDesktopDriver: driver as never })
  t.after(() => restarted.shutdown())
  ids = ['candidate-a', 'candidate-b', 'manual']
  const manual = await restarted.adoptClaudeDesktop()
  assert.equal(manual.length, 1)
  assert.equal(restarted.get(manual[0])?.sessionId, 'manual')
  assert.equal(restarted.get(manual[0])?.origin, undefined)
  ids = ['candidate-a']
  const seen: string[] = []
  restarted.on('created', task => seen.push(task.name!))
  const [id] = await restarted.adoptClaudeDesktop()
  assert.deepEqual(seen, ['Repair billing migration'])
  assert.equal(restarted.get(id)?.groupId, 'canonical-group')
  assert.equal(restarted.get(id)?.sessionId, 'candidate-a')
  await groupRegistry.flush()
})

test('an unacknowledged Desktop create cannot claim a later unrelated conversation', async t => {
  const baseDir = await base()
  const groupRegistry = new GroupRegistry({ path: join(baseDir, 'groups.json') })
  groupRegistry.define('Unmute')
  let created = false
  const driver = { async list() { return created ? [{ sessionId: 'unrelated', title: 'Other work', createdAt: Date.now(), lastActivityAt: Date.now(), model: null }] : [] } }
  const first = new TaskManager({ executorFactory, baseDir, groupRegistry, claudeDesktopDriver: driver as never,
    claudeActuator: { async createTask() { throw new Error('transport disconnected') } } as never })
  t.after(() => first.shutdown())
  await assert.rejects(first.createClaudeDesktop('repair billing', { agentMetadata: { title: 'Repair billing migration', group: 'Unmute', agentRunId: 'run' } }))
  created = true
  const restarted = new TaskManager({ executorFactory, baseDir, groupRegistry, claudeDesktopDriver: driver as never })
  t.after(() => restarted.shutdown())
  assert.deepEqual(await restarted.adoptClaudeDesktop(), [])
  await groupRegistry.flush()
})

test('an expired Desktop receipt neither captures future chats nor prevents a new Agent request', async t => {
  const baseDir = await base()
  const groupRegistry = new GroupRegistry({ path: join(baseDir, 'groups.json') })
  groupRegistry.define('Unmute')
  let clock = Date.now(), visible = false
  const driver = {
    async list() { return visible ? [{ sessionId: 'future', title: 'Later work', createdAt: clock, lastActivityAt: clock, model: null }] : [] },
    async snapshot() { return { snapshot: { turns: [{ role: 'user', text: 'repair billing' }] } } },
  }
  const m = new TaskManager({ executorFactory, baseDir, groupRegistry, now: () => clock, claudeDesktopDriver: driver as never,
    claudeActuator: { async createTask() { return { ok: true } } } as never })
  t.after(() => m.shutdown())
  const metadata = { title: 'Repair billing migration', group: 'Unmute', agentRunId: 'first-run' }
  await m.createClaudeDesktop('repair billing', { tries: 1, waitMs: 0, agentMetadata: metadata })
  clock += 120_001; visible = true
  const [id] = await m.adoptClaudeDesktop()
  assert.equal(m.get(id)?.origin, undefined)
  assert.equal(m.get(id)?.sessionId, 'future')
  assert.equal((await m.createClaudeDesktop('new work', { tries: 1, waitMs: 0, agentMetadata: metadata })).ok, true)
  await groupRegistry.flush()
})

test('fork identity is durable before history refresh and refresh failure is retryable, not another card', async () => {
  const baseDir = await base()
  let tm: TaskManager
  const visible: string[] = []
  const hub = { running: true, threadIdFor() { return undefined },
    async forkThread() { return { threadId: 'child', forkedFromId: 'source' } },
    async refreshTask(id: string) {
      const task = tm.get(id)!
      const saved = JSON.parse(await fs.readFile(join(task.home, 'meta.json'), 'utf8'))
      assert.equal(saved.sessionId, 'child')
      assert.equal(saved.continuationPending, false)
      throw new Error('history disconnected')
    } }
  tm = new TaskManager({ executorFactory, codexHub: hub as never, baseDir })
  tm.on('created', task => visible.push(task.id))
  try {
    const result = await tm.forkProviderSession({ harness: 'codex', sessionId: 'source', cwd: baseDir })
    assert.deepEqual(visible, [result.taskId])
    assert.equal(tm.get(result.taskId)?.history?.canRetry, true)
    assert.equal(tm.get(result.taskId)?.history?.phase, 'failed')
  } finally { await fs.rm(baseDir, { recursive: true, force: true }) }
})

test('failed native fork never publishes a card or resurrects a draft on restart', async () => {
  const baseDir = await base()
  const hub = { running: true, threadIdFor() { return undefined }, async forkThread() { throw new Error('Unknown Codex runtime command') } }
  const options = { executorFactory, codexHub: hub as never, baseDir }
  const tm = new TaskManager(options)
  const visible: string[] = []
  tm.on('created', task => visible.push(task.id))
  await assert.rejects(tm.forkProviderSession({ harness: 'codex', sessionId: 'source', cwd: baseDir }))
  assert.deepEqual(visible, [])
  assert.deepEqual(tm.list(), [])
  const restarted = new TaskManager(options)
  await restarted.rehydrate()
  assert.deepEqual(restarted.list(), [])
})

test('fork inherits name and group, and a supplied title is not a user message', async () => {
  const baseDir = await base()
  const hub = { running: true, threadIdFor() { return undefined },
    async forkThread() { return { threadId: 'child', forkedFromId: 'source' } },
    async send() { throw new Error('Naming must not send a prompt') } }
  const tm = new TaskManager({ executorFactory, codexHub: hub as never, baseDir })
  const sourceId = await tm.createChat({ provider: 'codex', cwd: baseDir })
  const source = tm.get(sourceId)!
  source.sessionId = 'source'; source.name = 'Notetaker models'; source.group = 'Unmute'; source.groupId = 'unmute-group'
  const result = await tm.forkProviderSession({ harness: 'codex', sessionId: 'source', cwd: baseDir, title: 'ASR experiment' })
  const child = tm.get(result.taskId)!
  assert.equal(child.name, 'Notetaker models')
  assert.equal(child.group, 'Unmute')
  assert.equal(child.groupId, 'unmute-group')
  const saved = JSON.parse(await fs.readFile(join(child.home, 'meta.json'), 'utf8'))
  assert.equal(saved.continuationPending, false)
  assert.equal(saved.name, 'Notetaker models')
})

test('Codex attach resumes the exact provider thread and submits only the current request', async () => {
  const baseDir = await base()
  const calls: Array<{ op: string; value?: string }> = []
  const threads = new Map<string, string>()
  const hub = {
    running: true,
    async resumeThread(taskId: string, threadId: string) {
      if (threads.get(taskId) === threadId) return
      calls.push({ op: 'resume', value: threadId }); threads.set(taskId, threadId)
    },
    async send(_taskId: string, text: string) { calls.push({ op: 'send', value: text }); return true },
    threadIdFor(taskId: string) { return threads.get(taskId) },
  }
  const tm = new TaskManager({ executorFactory, codexHub: hub as never, baseDir,
    codexFullAccess: () => true, permissionMode: () => 'auto-approve' })

  const result = await tm.attachProviderSession({
    harness: 'codex', sessionId: 'source-thread', cwd: baseDir, intent: 'add the pricing row',
  })

  assert.equal(result.sessionId, 'source-thread')
  assert.deepEqual(calls, [
    { op: 'resume', value: 'source-thread' },
    { op: 'send', value: 'add the pricing row' },
  ])
  assert.equal(tm.get(result.taskId)?.continuationMode, 'resume')
  assert.deepEqual(tm.get(result.taskId)?.continuationSources, [
    { sessionId: 'source-thread', provider: 'codex' },
  ])
  const durable = JSON.parse(await fs.readFile(join(tm.get(result.taskId)!.home, 'meta.json'), 'utf8'))
  assert.equal(durable.intent, 'add the pricing row')
  assert.equal(durable.chatUnstarted, false)
  assert.equal(durable.continuationMode, 'resume')
  assert.deepEqual(durable.continuationSources, [{ sessionId: 'source-thread', provider: 'codex' }])
})

test('unknown legacy Codex conversation is claimed only after exact provider resume succeeds', async () => {
  const baseDir = await base()
  const firstHub = { running: true, threadIdFor() { return undefined } }
  const first = new TaskManager({ executorFactory, codexHub: firstHub as never, baseDir,
    codexFullAccess: () => true, permissionMode: () => 'auto-approve' })
  const id = await first.createChat({ provider: 'codex', cwd: baseDir, permission: 'maximum' })
  const task = first.get(id)!, home = task.home
  const meta = JSON.parse(await fs.readFile(join(home, 'meta.json'), 'utf8'))
  meta.sessionId = 'legacy-thread'; meta.codexRolloutId = 'legacy-thread'; meta.chatUnstarted = false
  delete meta.codexSessionSettings; delete meta.sessionOwnership
  await fs.writeFile(join(home, 'meta.json'), JSON.stringify(meta))

  const calls: string[] = []
  let activeWriter = true
  const hub = {
    running: true,
    async resumeThread(_taskId: string, threadId: string) {
      calls.push(threadId)
      if (activeWriter) throw new Error('thread already has an active writer')
    },
    threadIdFor() { return undefined },
  }
  const restarted = new TaskManager({ executorFactory, codexHub: hub as never, baseDir,
    codexFullAccess: () => true, permissionMode: () => 'auto-approve' })
  await restarted.rehydrate()
  assert.equal(restarted.get(id)?.sessionOwnership, 'unknown')
  assert.equal(restarted.get(id)?.agent, 'codex')
  assert.equal(await restarted.resume(id), false)
  const refused = JSON.parse(await fs.readFile(join(home, 'meta.json'), 'utf8'))
  assert.equal(refused.sessionOwnership, undefined)
  assert.equal(refused.codexSessionSettings, undefined)
  activeWriter = false
  assert.equal(await restarted.resume(id), true, restarted.get(id)?.deliveryError ?? restarted.get(id)?.resumeError)
  assert.deepEqual(calls, ['legacy-thread', 'legacy-thread'])
  assert.equal(restarted.get(id)?.deliveryError, undefined)
  assert.equal(restarted.get(id)?.resumeError, undefined)
  const adopted = JSON.parse(await fs.readFile(join(home, 'meta.json'), 'utf8'))
  assert.equal(adopted.sessionOwnership, 'unmute')
  assert.ok(adopted.codexSessionSettings)
})

test('Codex reopen attaches exact history without inventing a user turn', async () => {
  const baseDir = await base()
  const calls: string[] = []
  const threads = new Map<string, string>()
  const hub = {
    running: true,
    async resumeThread(taskId: string, threadId: string) {
      if (threads.get(taskId) === threadId) return
      calls.push(`resume:${threadId}`); threads.set(taskId, threadId)
    },
    async send() { calls.push('send'); return true },
    threadIdFor(taskId: string) { return threads.get(taskId) },
  }
  const tm = new TaskManager({ executorFactory, codexHub: hub as never, baseDir,
    codexFullAccess: () => true, permissionMode: () => 'auto-approve' })

  const result = await tm.attachProviderSession({ harness: 'codex', sessionId: 'source-thread', cwd: baseDir })

  assert.equal(result.sessionId, 'source-thread')
  assert.deepEqual(calls, ['resume:source-thread'])
})

test('restart repairs a persisted Codex identity that was incorrectly left unstarted', async () => {
  const baseDir = await base()
  const hub = { running: true, threadIdFor() { return undefined } }
  const initial = new TaskManager({ executorFactory, codexHub: hub as never, baseDir,
    codexFullAccess: () => true, permissionMode: () => 'auto-approve' })
  const id = await initial.createChat({ provider: 'codex', cwd: baseDir })
  const home = initial.get(id)!.home
  const broken = JSON.parse(await fs.readFile(join(home, 'meta.json'), 'utf8'))
  broken.sessionId = 'forked-child'; broken.codexRolloutId = 'forked-child'; broken.chatUnstarted = true
  await fs.writeFile(join(home, 'meta.json'), JSON.stringify(broken))

  const restarted = new TaskManager({ executorFactory, codexHub: hub as never, baseDir,
    codexFullAccess: () => true, permissionMode: () => 'auto-approve' })
  await restarted.rehydrate()
  assert.notEqual(restarted.get(id)?.chatUnstarted, true)
  assert.equal(JSON.parse(await fs.readFile(join(home, 'meta.json'), 'utf8')).chatUnstarted, false)
})

test('rehydration repairs stale task metadata from the canonical Codex identity before publication', async t => {
  const baseDir = await base()
  const initial = new TaskManager({ executorFactory, codexHub: { running: true, threadIdFor() { return undefined } } as never, baseDir,
    codexFullAccess: () => true, permissionMode: () => 'auto-approve' })
  const id = await initial.createChat({ provider: 'codex', cwd: baseDir })
  const home = initial.get(id)!.home
  initial.shutdown()
  await Promise.all([...((initial as any).metaChains.values())])
  const stale = JSON.parse(await fs.readFile(join(home, 'meta.json'), 'utf8'))
  stale.sessionId = 'source'; stale.codexRolloutId = 'source'; stale.chatUnstarted = false; stale.state = 'done'
  await fs.writeFile(join(home, 'meta.json'), JSON.stringify(stale))
  let recovered = 0
  const hub = { running: true, threadIdFor() { return undefined },
    async recoverIdentity(taskId: string, source: string) {
      recovered++
      assert.equal(taskId, id); assert.equal(source, 'source')
      return { taskId, threadId: 'child', forkedFromId: 'source' }
    } }
  const restarted = new TaskManager({ executorFactory, codexHub: hub as never, baseDir,
    codexFullAccess: () => true, permissionMode: () => 'auto-approve' })
  t.after(() => restarted.shutdown())
  await restarted.rehydrate()
  assert.equal(recovered, 1)
  assert.equal(restarted.get(id)?.sessionId, 'child')
  assert.equal(restarted.get(id)?.codexRolloutId, 'child')
  const repaired = JSON.parse(await fs.readFile(join(home, 'meta.json'), 'utf8'))
  assert.equal(repaired.sessionId, 'child')
  assert.equal(repaired.codexRolloutId, 'child')
})

test('contradictory canonical Codex identity fails closed without changing the task receipt', async t => {
  const baseDir = await base()
  const initial = new TaskManager({ executorFactory, codexHub: { running: true, threadIdFor() { return undefined } } as never, baseDir,
    codexFullAccess: () => true, permissionMode: () => 'auto-approve' })
  const id = await initial.createChat({ provider: 'codex', cwd: baseDir })
  const home = initial.get(id)!.home
  initial.shutdown(); await Promise.all([...((initial as any).metaChains.values())])
  const stale = JSON.parse(await fs.readFile(join(home, 'meta.json'), 'utf8'))
  stale.sessionId = 'source'; stale.codexRolloutId = 'source'; stale.chatUnstarted = false
  await fs.writeFile(join(home, 'meta.json'), JSON.stringify(stale))
  const hub = { running: true, threadIdFor() { return undefined }, async recoverIdentity(taskId: string) {
    return { taskId, threadId: 'unrelated-child', forkedFromId: 'different-source' }
  } }
  const restarted = new TaskManager({ executorFactory, codexHub: hub as never, baseDir })
  t.after(() => restarted.shutdown())
  await restarted.rehydrate()
  assert.equal(restarted.get(id)?.sessionId, 'source')
  assert.match(restarted.get(id)?.resumeError ?? '', /could not be verified/i)
})

test('Codex fork uses native fork and persists the returned child and source', async () => {
  const baseDir = await base()
  const calls: Array<{ op: string; value?: string }> = []
  const threads = new Map<string, string>()
  const hub = {
    running: true,
    async forkThread(taskId: string, source: string) {
      calls.push({ op: 'fork', value: source }); threads.set(taskId, 'child-thread')
      return { threadId: 'child-thread', forkedFromId: source }
    },
    async resumeThread() {},
    async send(_taskId: string, text: string) { calls.push({ op: 'send', value: text }); return true },
    threadIdFor(taskId: string) { return threads.get(taskId) },
  }
  const tm = new TaskManager({ executorFactory, codexHub: hub as never, baseDir,
    codexFullAccess: () => true, permissionMode: () => 'auto-approve' })

  const result = await tm.forkProviderSession({
    harness: 'codex', sessionId: 'source-thread', cwd: baseDir, intent: 'try another route',
  })

  assert.deepEqual(result, { taskId: result.taskId, sessionId: 'child-thread' })
  assert.deepEqual(calls, [
    { op: 'fork', value: 'source-thread' },
    { op: 'send', value: 'try another route' },
  ])
  assert.equal(tm.get(result.taskId)?.continuationMode, 'fork')
  assert.deepEqual(tm.get(result.taskId)?.continuationSources, [
    { sessionId: 'source-thread', provider: 'codex' },
  ])
  const durable = JSON.parse(await fs.readFile(join(tm.get(result.taskId)!.home, 'meta.json'), 'utf8'))
  assert.equal(durable.intent, 'try another route')
  assert.equal(durable.chatUnstarted, false)
  assert.equal(durable.continuationMode, 'fork')
  assert.deepEqual(durable.continuationSources, [{ sessionId: 'source-thread', provider: 'codex' }])
})

test('synthesis provenance survives task rehydration', async () => {
  const baseDir = await base()
  let sequence = 0
  const hub = {
    async startThread() { return { threadId: `thread-${++sequence}`, url: 'ws://localhost' } },
    async send() { return true },
    threadIdFor() { return undefined },
  }
  const options = { executorFactory, codexHub: hub as never, baseDir,
    codexFullAccess: () => true, permissionMode: () => 'auto-approve' as const }
  const first = new TaskManager(options)
  const taskId = await first.dispatch('continue the combined work', { agent: 'codex', kind: 'session', cwd: baseDir })
  first.mergeAgentOrigin(taskId, 'agent-run')
  await first.mergeContinuationProvenance(taskId, {
    mode: 'synthesis',
    sources: [{ sessionId: 'aaaaaaaa-1111-2222-8333-444444444444', provider: 'claude' }],
    artifacts: [{ kind: 'url', value: 'https://docs.example.test/brief', label: 'Brief' }],
  })
  const second = new TaskManager(options)
  await second.rehydrate()
  assert.equal(second.get(taskId)?.continuationMode, 'synthesis')
  assert.deepEqual(second.get(taskId)?.continuationSources, [
    { sessionId: 'aaaaaaaa-1111-2222-8333-444444444444', provider: 'claude' },
  ])
  assert.deepEqual(second.get(taskId)?.continuationArtifacts, [
    { kind: 'url', value: 'https://docs.example.test/brief', label: 'Brief' },
  ])
})
