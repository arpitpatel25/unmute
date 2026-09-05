import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskManager } from './task-manager'
import { ClaudeTaskChannel } from './claude/task-channel'

async function fixture(t: any, extra = {}) {
  const baseDir = await fs.mkdtemp(join(tmpdir(), 'core-safety-'))
  const manager = new TaskManager({ baseDir, executorFactory: () => { throw new Error('No provider launch permitted') }, ...extra })
  t.after(async () => { manager.shutdown(); await Promise.all([...(manager as any).metaChains.values()]); await fs.rm(baseDir, { recursive: true, force: true, maxRetries:3, retryDelay: 10 }) })
  return { manager, baseDir }
}

test('managed project preview is non-mutating and exact allocation survives Remove and restart', async t => {
  const { manager, baseDir } = await fixture(t)
  const preview = await manager.previewChat({ provider: 'claude' })
  assert.equal(await fs.stat(preview.path).catch(() => null), null)
  assert.deepEqual(await fs.readdir(baseDir), [])
  const id = await manager.createChat({ provider: 'claude', allocationId: preview.allocationId })
  const task = manager.get(id)!
  assert.equal(task.cwd, preview.path)
  assert.notEqual(task.home, task.cwd)
  await fs.writeFile(join(task.cwd, 'deliverable.txt'), 'keep')
  await manager.remove(id)
  assert.equal(await fs.readFile(join(task.cwd, 'deliverable.txt'), 'utf8'), 'keep')
  await manager.rehydrate()
  assert.equal(manager.get(id), undefined)
})

test('legacy home and nested cwd survive Remove; aged unknown directories survive orphan sweep', async t => {
  const { manager, baseDir } = await fixture(t)
  for (const nested of [false, true]) {
    const id = await manager.createChat({ provider: 'claude' })
    const task = manager.get(id)!
    task.cwd = nested ? join(task.home, 'project') : task.home
    await fs.mkdir(task.cwd, { recursive: true })
    await fs.writeFile(join(task.cwd, 'output.txt'), 'legacy output')
    await manager.remove(id)
    assert.equal(await fs.readFile(join(task.cwd, 'output.txt'), 'utf8'), 'legacy output')
    await manager.rehydrate()
    assert.equal(manager.get(id), undefined)
  }
  const orphan = join(baseDir, 'local', 'unidentified')
  await fs.mkdir(orphan, { recursive: true })
  await fs.writeFile(join(orphan, 'output.txt'), 'unknown output')
  await fs.utimes(orphan, 1, 1)
  await (manager as any).purgeOrphanDirs(Date.now())
  assert.equal(await fs.readFile(join(orphan, 'output.txt'), 'utf8'), 'unknown output')
})

test('owned new sessions select maximum authorized policy while explicit lower choices persist', async t => {
  const { manager } = await fixture(t, { permissionMode: () => 'ask', codexFullAccess: () => true, claudeChoice: () => ({ permissionMode: 'manual' }) })
  const claude = await manager.createChat({ provider: 'claude' })
  assert.equal(manager.get(claude)!.claudeSessionSettings?.permissionMode, 'bypassPermissions')
  const codex = await manager.createChat({ provider: 'codex' })
  assert.equal(manager.get(codex)!.codexSessionSettings?.sandbox, 'danger-full-access')
  const lower = await manager.createChat({ provider: 'claude', permission: 'plan' })
  assert.equal(manager.get(lower)!.claudeSessionSettings?.permissionMode, 'plan')
})

test('preview collisions and missing selected folders fail without replacement or provider launch', async t => {
  const { manager, baseDir } = await fixture(t)
  const preview = await manager.previewChat({ provider: 'codex' })
  await fs.mkdir(preview.path, { recursive: true })
  await fs.writeFile(join(preview.path, 'existing.txt'), 'keep')
  await assert.rejects(manager.createChat({ provider: 'codex', allocationId: preview.allocationId }), /Could not create/)
  assert.equal(await fs.readFile(join(preview.path, 'existing.txt'), 'utf8'), 'keep')
  await assert.rejects(manager.createChat({ provider: 'claude', allocationId: preview.allocationId }), /expired or changed/)
  await assert.rejects(manager.createChat({ provider: 'claude', cwd: join(baseDir, 'missing') }), /unavailable/)
  const project = join(baseDir, 'selected'); await fs.mkdir(project)
  const id = await manager.createChat({ provider: 'claude', cwd: project })
  assert.equal(manager.get(id)!.cwd, project)
  assert.deepEqual(await fs.readdir(project), [])
  await fs.rmdir(project)
  assert.equal(await manager.resume(id), false)
  assert.equal(manager.get(id)!.cwd, project)
  assert.equal(await fs.stat(project).catch(() => null), null)
})

test('sandbox roots and Codex consent cap maximum new access; recorded lower modes survive rehydrate', async t => {
  for (const roots of [[], ['/allowed']]) for (const consent of [false, true]) {
    const { manager, baseDir } = await fixture(t, { sandboxRoots: () => roots, codexFullAccess: () => consent, codexHub: { stop() {} } })
    const c = await manager.createChat({ provider: 'claude' })
    const x = await manager.createChat({ provider: 'codex' })
    assert.equal(manager.get(c)!.claudeSessionSettings?.permissionMode, roots.length ? 'manual' : 'bypassPermissions')
    assert.equal(manager.get(x)!.codexSessionSettings?.sandbox, !roots.length && consent ? 'danger-full-access' : 'workspace-write')
    assert.equal(manager.get(x)!.codexSessionSettings?.approvalPolicy, 'never')
    assert.deepEqual(manager.get(x)!.codexSessionSettings?.writableRoots, roots)
    assert.equal(!!manager.get(x)!.permissionReason, !!roots.length || !consent)
    const lowerC = await manager.createChat({ provider: 'claude', permission: 'plan' })
    const lowerX = await manager.createChat({ provider: 'codex', permission: 'read' })
    const recorded = manager.get(lowerC)!.cwd
    manager.shutdown()
    await Promise.all([...(manager as any).metaChains.values()])
    const restored = new TaskManager({ baseDir, executorFactory: () => { throw new Error('No provider') } })
    await restored.rehydrate()
    assert.equal(restored.get(lowerC)!.claudeSessionSettings?.permissionMode, 'plan')
    assert.equal(restored.get(lowerX)!.codexSessionSettings?.sandbox, 'read-only')
    assert.equal(restored.get(lowerX)!.codexSessionSettings?.approvalPolicy, 'on-request')
    assert.equal(restored.get(lowerC)!.cwd, recorded)
    assert.ok(restored.get(lowerC)!.managedProjectId)
    restored.shutdown()
  }
})

test('maintenance retires stale conversations while preserving generated files and malformed receipts', async t => {
  const { manager, baseDir } = await fixture(t, { purgeAgeMs: 1, warmMs: 1 })
  const id = await manager.createChat({ provider: 'claude' }), task = manager.get(id)!
  task.kind = 'oneoff'; task.createdAt = 1; task.updatedAt = 1; task.lastHeartbeatMs = 1
  await fs.writeFile(join(task.cwd, 'output.txt'), 'managed deliverable')
  const unknown = join(baseDir, 'local', 'malformed')
  await fs.mkdir(unknown, { recursive: true }); await fs.writeFile(join(unknown, 'meta.json'), '{bad json')
  await fs.writeFile(join(unknown, 'result.md'), 'legacy deliverable'); await fs.utimes(unknown, 1, 1)
  await manager.purgeStale()
  assert.equal(manager.get(id), undefined)
  assert.equal(await fs.readFile(join(task.cwd, 'output.txt'), 'utf8'), 'managed deliverable')
  assert.equal(await fs.readFile(join(unknown, 'result.md'), 'utf8'), 'legacy deliverable')
  await manager.rehydrate(); assert.equal(manager.get(id), undefined)
})

test('manager rejects expired identity before provider method and retries rejected current answers', async t => {
  const { manager } = await fixture(t)
  const id = await manager.createChat({ provider: 'claude' }), task = manager.get(id)!
  const patches: any[] = []
  const channel = new ClaudeTaskChannel(p => { patches.push(p); manager.applyHubPatch({ taskId: id, ...p }) })
  let reject = true, calls = 0
  const driver = { answer: async () => { calls++; if (reject) throw new Error('delivery rejected') }, close() {} } as any
  ;(manager as any).claudeTasks.set(id, { channel, driver })
  channel.event({ type: 'request', requestId: 'A', kind: 'permission', tool: 'Write', input: {} } as any)
  const A = task.question!.reference!
  channel.event({ type: 'request-resolved', requestId: 'A' } as any)
  channel.event({ type: 'request', requestId: 'B', kind: 'permission', tool: 'Write', input: {} } as any)
  const B = task.question!.reference!
  assert.equal(await manager.deliverDraft(id, 'Allow once', [], undefined, undefined, A), false)
  assert.equal(calls, 0)
  assert.equal(await manager.answerQuestion(id, 'Allow once', B), false)
  assert.equal(task.question!.acknowledgment, undefined)
  reject = false
  assert.equal(await manager.answerQuestion(id, 'Allow once', B), true)
  assert.equal(task.questionAcknowledgment?.state, 'accepted')
  assert.equal(await manager.answerQuestion(id, 'Allow once', B), false)
  assert.equal(calls, 2)
})

test('rendered Claude request and subquestion identities reject stale answers without provider calls', async () => {
  let question: any
  const channel = new ClaudeTaskChannel(p => { if (p.question) question = p.question })
  const delivered: string[] = []
  const driver = { answer: async (id: string) => { delivered.push(id) } } as any
  channel.event({ type: 'request', requestId: 'A', kind: 'question', tool: 'AskUserQuestion', input: { questions: [{ question: 'First?' }, { question: 'Second?' }] } } as any)
  const first = question.reference
  assert.ok(first)
  assert.equal(await channel.answer('one', driver, first), true)
  const second = question.reference
  assert.notDeepEqual(first, second)
  assert.equal(await channel.answer('old answer', driver, first), false)
  assert.deepEqual(delivered, [])
  assert.equal(await channel.answer('two', driver, second), true)
  assert.equal(await channel.answer('duplicate', driver, second), false)
  channel.event({ type: 'request', requestId: 'B', kind: 'permission', tool: 'Write', input: {} } as any)
  assert.equal(await channel.answer('Allow once', driver, second), false)
  assert.deepEqual(delivered, ['A'])
})
