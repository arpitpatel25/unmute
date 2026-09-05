import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtemp, readFile, writeFile, chmod, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskManager } from '../task-manager'
import type { ClaudeTaskOptions } from './task-session'
import { promises as fs } from 'node:fs'
import { CodexHub } from '../codex/hub'
import { TaskFollowupCoordinator } from '../task-followup'
import { TaskDraftStore } from '../task-draft'

async function codexQueueFixture() {
  const baseDir = await mkdtemp(join(tmpdir(), 'unmute-queue-review-'))
  let notify!: (m: any) => void, manager!: TaskManager
  const inputs: any[] = []
  const server = {
    running: true, url: '', start: async () => {}, stop() { this.running = false; notify({ method: 'transport/disconnected', params: {} }) },
    on(_name: string, h: any) { notify = h }, onRequest() {},
    request: async (method: string, params: any): Promise<any> => {
      if (method === 'turn/start') { inputs.push(params.input); return { turn: { id: `turn-${inputs.length}` } } }
      return { thread: { id: 'thread', turns: [] } }
    },
  }
  const hub = new CodexHub({ resolveBin: async () => 'fake', onPatch: p => manager.applyHubPatch(p), makeServer: () => server as any })
  manager = new TaskManager({ baseDir, executorFactory: () => { throw new Error('No PTY') }, codexHub: hub })
  const id = await manager.createChat({ provider: 'codex' }); await manager.deliverDraft(id, 'first', [])
  const store = new TaskDraftStore(); store.setText(id, 'next')
  const queue = new TaskFollowupCoordinator({ store, assetsRoot: baseDir, scope: id => manager.followupScope(id), gate: id => manager.followupGate(id),
    deliver: (id, r, gate) => manager.deliverQueuedDraft(id, r, gate), immediate: async () => { throw new Error('Queue bypass') }, changed: () => {} })
  manager.on('followup-turn-ended', e => queue.turnEnded(e)); manager.on('followup-ready', e => queue.readinessChanged(e.taskId))
  manager.on('followup-disarm', e => queue.disarm(e.taskId, 'stopped'))
  return { baseDir, manager, hub, server, notify: (m: any) => notify(m), id, store, queue, inputs }
}

test('Kill All and direct Codex stop retain follow-ups as saved without automatic restart', async () => {
  for (const directHub of [false, true]) {
    const h = await codexQueueFixture()
    const path = join(h.baseDir, 'capture.png'); await writeFile(path, 'image')
    h.store.addAttachment(h.id, { id: 'image', path, mimeType: 'image/png', name: 'Capture' })
    assert.equal((await h.queue.submit(h.id)).kind, 'queued')
    if (directHub) h.hub.stop(); else h.manager.killAll()
    assert.equal(h.queue.view(h.id)?.phase, 'saved')
    assert.equal(h.queue.view(h.id)?.canRestore, true)
    assert.equal(h.store.getFollowup(h.id)?.draft.text, 'next')
    assert.equal(h.store.getFollowup(h.id)?.draft.attachments.length, 1)
    h.notify({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn-1', status: 'completed' } } })
    await h.queue.settled(h.id)
    assert.equal(h.inputs.length, 1)
    h.manager.shutdown()
  }
})

test('app shutdown detaches a daemon-owned Claude turn without failing or closing it', async () => {
  const baseDir = await mkdtemp(join(tmpdir(), 'unmute-daemon-shutdown-'))
  let detached = 0, closed = 0
  const manager = new TaskManager({
    baseDir, executorFactory: () => { throw new Error('No PTY') },
    claudeSessionOptions: async task => ({ binary: 'fake', cwd: task.cwd }),
    claudeTaskFactory: () => ({ alive: true, busy: true, followupBlocked: false, followupUnavailable: false,
      async start() {}, async send() { return { submissionId: 'submission', sessionId: 'session' } },
      detach() { detached++ }, close() { closed++ },
    } as never),
  })
  const id = await manager.dispatch('continue after the UI exits', { agent: 'claude' })
  manager.shutdown()
  assert.equal(detached, 1)
  assert.equal(closed, 0)
  assert.equal(manager.get(id)?.state, 'processing')
})

test('old queued Codex acknowledgement loss stays uncertain after same-thread resume', async () => {
  const h = await codexQueueFixture()
  await h.queue.submit(h.id)
  let rejectAttempt!: (error: Error) => void, began!: () => void
  const attempted = new Promise<void>(resolve => { began = resolve })
  h.server.request = async method => {
    if (method === 'turn/start') { began(); return await new Promise((_resolve, reject) => { rejectAttempt = reject }) }
    return { thread: { id: 'thread', turns: [] } }
  }
  h.notify({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn-1', status: 'completed' } } })
  await attempted
  await h.hub.resumeThread(h.id, 'thread', h.manager.get(h.id)!.codexSessionSettings!, true)
  rejectAttempt(new Error('ack lost')); await h.queue.settled(h.id)
  const saved = h.store.getFollowup(h.id)!
  assert.equal(saved.phase, 'uncertain')
  assert.equal(h.queue.view(h.id)?.canQueueAgain, false)
  assert.equal(await h.queue.restore(h.id, saved.id), false)
  assert.equal(await h.queue.queueSaved(h.id, saved.id), false)
  h.manager.shutdown()
})

test('real manager and Codex coordinator drain live completion but hold an unresolved approval', async () => {
  const baseDir = await mkdtemp(join(tmpdir(), 'unmute-queue-boundary-'))
  let notify!: (m: any) => void, request!: (r: any) => Promise<unknown>, manager!: TaskManager
  const inputs: any[] = []
  const hub = new CodexHub({ resolveBin: async () => 'fake', onPatch: p => manager.applyHubPatch(p), makeServer: () => ({
    running: true, url: '', start: async () => {}, stop() {}, on(_name: string, h: any) { notify = h }, onRequest(h: any) { request = h },
    request: async (method: string, params: any) => {
      if (method === 'turn/start') { inputs.push(params.input); return { turn: { id: `turn-${inputs.length}` } } }
      return { thread: { id: 'thread', turns: [] } }
    },
  }) as any })
  manager = new TaskManager({ baseDir, executorFactory: () => { throw new Error('No PTY') }, codexHub: hub })
  const id = await manager.createChat({ provider: 'codex' }); await manager.deliverDraft(id, 'first', [])
  const store = new TaskDraftStore(); store.setText(id, 'next')
  const queue = new TaskFollowupCoordinator({ store, assetsRoot: baseDir, scope: id => manager.followupScope(id), gate: id => manager.followupGate(id),
    deliver: (id, r, gate) => manager.deliverQueuedDraft(id, r, gate), immediate: async () => { throw new Error('Queue must not route into answer-capable delivery') }, changed: () => {} })
  manager.on('followup-turn-ended', e => queue.turnEnded(e)); manager.on('followup-ready', e => queue.readinessChanged(e.taskId))
  manager.on('followup-disarm', e => queue.disarm(e.taskId, 'stopped'))
  assert.equal((await queue.submit(id)).kind, 'queued')
  store.setText(id, 'new typing')
  const approval = request({ id: 50, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread', command: 'pwd' } })
  notify({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn-1', status: 'completed' } } })
  await new Promise(resolve => setImmediate(resolve)); await queue.settled(id)
  assert.equal(inputs.length, 1)
  assert.equal(hub.answer(id, 'Deny'), true); await approval; await queue.settled(id)
  assert.deepEqual(inputs, [[{ type: 'text', text: 'first' }], [{ type: 'text', text: 'next' }]])
  assert.equal(store.get(id).text, 'new typing'); assert.equal(store.getFollowup(id), undefined)
  manager.get(id)!.origin = 'unmute-agent'
  assert.equal(manager.followupScope(id), undefined)
  manager.shutdown()
})

test('MCP field validation reaches the real manager and clears after correction', async () => {
  const baseDir = await mkdtemp(join(tmpdir(), 'unmute-form-boundary-'))
  let request!: (r: any) => Promise<unknown>, manager!: TaskManager
  const hub = new CodexHub({ resolveBin: async () => 'fake', onPatch: p => manager.applyHubPatch(p), makeServer: () => ({
    running: true, url: '', start: async () => {}, stop() {}, on() {}, onRequest(h: any) { request = h },
    request: async () => ({ thread: { id: 'thread', turns: [] } }),
  }) as any })
  manager = new TaskManager({ baseDir, executorFactory: () => { throw new Error('No PTY') }, codexHub: hub })
  const id = await manager.createChat({ provider: 'codex' }); await manager.resume(id)
  const reply = request({ id: 1, method: 'mcpServer/elicitation/request', params: { threadId: 'thread', mode: 'form', requestedSchema: { type: 'object', required: ['count'], properties: { count: { title: 'Count', type: 'integer', minimum: 1 } } } } })
  const rendered = manager.get(id)!.question!.reference!
  assert.equal(manager.answer(id, '2'), false, 'the legacy synchronous API cannot acknowledge an owned structured answer')
  assert.equal(await manager.deliverDraft(id, '2', []), false, 'unscoped prose cannot answer an owned request')
  assert.deepEqual(manager.get(id)!.question!.reference, rendered, 'unscoped input did not advance the field')
  assert.equal(await manager.answerQuestion(id, '0', manager.get(id)!.question!.reference!), false)
  assert.match(manager.get(id)!.deliveryError ?? '', /Count:.*range/)
  assert.equal(await manager.answerQuestion(id, '2', manager.get(id)!.question!.reference!), true)
  assert.equal(manager.get(id)!.deliveryError, undefined)
  assert.equal(manager.get(id)!.error, undefined)
  await manager.answerQuestion(id, 'Approve', manager.get(id)!.question!.reference!)
  assert.deepEqual(await reply, { action: 'accept', content: { count: 2 } })
  manager.shutdown()
})

test('session permission controls reject full access above policy and root caps', async () => {
  const cases = [
    { provider: 'claude', auto: true, roots: ['/allowed'], consent: true },
    { provider: 'codex', auto: true, roots: [], consent: false },
    { provider: 'codex', auto: true, roots: ['/allowed'], consent: true },
  ] as const
  for (const policy of cases) {
    const baseDir = await mkdtemp(join(tmpdir(), 'unmute-cap-'))
    const manager = new TaskManager({ baseDir, executorFactory: () => { throw new Error('No PTY') }, permissionMode: () => policy.auto ? 'auto-approve' : 'ask',
      sandboxRoots: () => [...policy.roots], codexFullAccess: () => policy.consent, claudeChoice: () => ({ permissionMode: 'manual' }), codexHub: {} as any })
    const id = await manager.createChat({ provider: policy.provider })
    assert.equal(manager.chatFullAccessAllowed(id), false)
    await assert.rejects(manager.configureChat(id, { permission: 'full' }), /policy|consent|allowed|roots/i)
    manager.shutdown()
  }
})

test('new session maximum access and recorded explicit lower access are independent of the generic default', async () => {
  for (const provider of ['claude', 'codex'] as const) {
    const baseDir = await mkdtemp(join(tmpdir(), 'unmute-explicit-full-'))
    const manager = new TaskManager({ baseDir, executorFactory: () => { throw new Error('No PTY') }, permissionMode: () => 'ask', codexFullAccess: () => true,
      claudeChoice: () => ({ permissionMode: 'manual' }), codexHub: {} as any })
    const id = await manager.createChat({ provider })
    assert.equal(manager.chatFullAccessAllowed(id), true)
    await manager.configureChat(id, { permission: 'full' })
    assert.equal(provider === 'claude' ? manager.get(id)!.claudeSessionSettings?.permissionMode : manager.get(id)!.codexSessionSettings?.sandbox, provider === 'claude' ? 'bypassPermissions' : 'danger-full-access')
    await manager.configureChat(id, { permission: 'ask' })
    assert.equal(provider === 'claude' ? manager.get(id)!.claudeSessionSettings?.permissionMode : manager.get(id)!.codexSessionSettings?.sandbox, provider === 'claude' ? 'manual' : 'workspace-write')
    const next = await manager.createChat({ provider })
    assert.equal(provider === 'claude' ? manager.get(next)!.claudeSessionSettings?.permissionMode : manager.get(next)!.codexSessionSettings?.sandbox, provider === 'claude' ? 'bypassPermissions' : 'danger-full-access')
    assert.equal(provider === 'claude' ? manager.get(id)!.claudeSessionSettings?.permissionMode : manager.get(id)!.codexSessionSettings?.sandbox, provider === 'claude' ? 'manual' : 'workspace-write')
    manager.shutdown()
  }
})

test('owned attachment storage repairs file privacy without following symlinks', async () => {
  const baseDir = await mkdtemp(join(tmpdir(), 'unmute-private-'))
  const manager = new TaskManager({ baseDir, executorFactory: () => { throw new Error('No PTY') } })
  const id = await manager.createChat({ provider: 'claude' })
  const path = (await manager.attachFile(id, new Uint8Array([1]), 'png'))!
  await chmod(path, 0o644)
  const outside = join(baseDir, 'original.txt'); await writeFile(outside, 'private original', { mode: 0o644 })
  await symlink(outside, join(manager.get(id)!.home, 'attachments', 'external-link'))
  await manager.attachFile(id, new Uint8Array([2]), 'png')
  assert.equal((await stat(path)).mode & 0o777, 0o600)
  assert.equal((await stat(join(manager.get(id)!.home, 'attachments'))).mode & 0o777, 0o700)
  assert.equal((await stat(outside)).mode & 0o777, 0o644)
  manager.shutdown()
})

test('reconnect drains the prior history writer before restoring and adding new frames', async t => {
  const baseDir = await mkdtemp(join(tmpdir(), 'unmute-history-drain-'))
  let release!: () => void, reached!: () => void
  const gate = new Promise<void>(r => { release = r }), waiting = new Promise<void>(r => { reached = r })
  const rename = fs.rename.bind(fs)
  let first = true, turn = 0
  t.mock.method(fs, 'rename', async (from: any, to: any) => {
    if (first && String(to).endsWith('chat-frames.json')) { first = false; reached(); await gate }
    return rename(from, to)
  })
  const manager = new TaskManager({ baseDir, executorFactory: () => { throw new Error('No PTY') },
    claudeSessionOptions: async task => ({ binary: 'fake', cwd: task.cwd }),
    claudeTaskFactory: options => ({ alive: true, busy: false, async start() {}, close() {}, async send() {
      turn++; options.onEvent({ type: 'message', message: { type: 'assistant', uuid: `a${turn}`, message: { content: [{ type: 'text', text: `Reply ${turn}` }] } } })
      options.onEvent({ type: 'result', message: { type: 'result', result: `Reply ${turn}` } })
    } } as never),
  })
  const id = await manager.dispatch('First'); await waiting
  let configured = false
  const configuring = manager.configureChat(id, { model: 'sonnet' }).then(() => { configured = true })
  await new Promise(setImmediate)
  assert.equal(configured, false)
  release(); await configuring
  await manager.deliverDraft(id, 'Second', [])
  await manager.configureChat(id, { effort: 'high' })
  const history = JSON.parse(await readFile(join(manager.get(id)!.home, 'chat-frames.json'), 'utf8'))
  assert.deepEqual(history.filter((f: any) => f.type === 'assistant').map((f: any) => f.uuid), ['a1', 'a2'])
  assert.equal(history.filter((f: any) => f.unmuteTurnEnd).length, 2)
  manager.shutdown()
})

test('resolved browser availability is recorded once and survives changed global defaults', async () => {
  const baseDir = await mkdtemp(join(tmpdir(), 'unmute-browser-record-'))
  let browser = true, live = false
  const launches: ClaudeTaskOptions[] = []
  const manager = new TaskManager({ baseDir, executorFactory: () => { throw new Error('No PTY') },
    claudeSessionOptions: async task => ({ binary: 'fake', cwd: task.cwd, chrome: browser }),
    claudeTaskFactory: options => { launches.push(options); live = true; return { get alive() { return live }, busy: false, async start() {}, close() { live = false }, async send() {
      options.onEvent({ type: 'result', message: { type: 'result', result: 'Done' } })
    } } as never },
  })
  const id = await manager.dispatch('Hello')
  browser = false; live = false
  await manager.resume(id)
  assert.deepEqual(launches.map(o => o.chrome), [true, true])
  assert.equal(JSON.parse(await readFile(join(manager.get(id)!.home, 'meta.json'), 'utf8')).claudeSessionSettings.chrome, true)
  manager.shutdown()
})

test('rediscovery fails closed for legacy imports but retains durable Unmute provenance', async () => {
  const baseDir = await mkdtemp(join(tmpdir(), 'unmute-provenance-'))
  const initial = new TaskManager({ baseDir, executorFactory: () => { throw new Error('No PTY') } })
  const owned = await initial.createChat({ provider: 'claude' })
  const external = (await initial.adoptCliSession({ sessionId: 'external-id', title: 'Old import', cwd: baseDir, lastActivityAt: 1 }))!
  const externalHome = initial.get(external)!.home, ownedSession = initial.get(owned)!.sessionId
  initial.shutdown()
  await Promise.all([...(initial as any).metaChains.values()])
  const meta = JSON.parse(await readFile(join(externalHome, 'meta.json'), 'utf8')); delete meta.importedFromCli; delete meta.sessionOwnership
  await writeFile(join(externalHome, 'meta.json'), JSON.stringify(meta))
  const manager = new TaskManager({ baseDir, executorFactory: () => { throw new Error('No PTY') }, claudeSessionOptions: async () => { throw new Error('No external launch') } })
  await manager.rehydrate()
  await manager.adoptCliSession({ sessionId: 'external-id', title: 'Old import', cwd: baseDir, lastActivityAt: 1 })
  await manager.adoptCliSession({ sessionId: ownedSession, title: 'Known owned', cwd: manager.get(owned)!.cwd, lastActivityAt: 1 })
  assert.equal(manager.get(external)!.importedFromCli, true)
  assert.equal(manager.get(owned)!.importedFromCli, undefined)
  assert.equal(await manager.resume(external), false)
  assert.equal(JSON.parse(await readFile(join(externalHome, 'meta.json'), 'utf8')).importedFromCli, true)
  manager.shutdown()
})

test('new conversation creates a visible workspace but sends nothing until the real draft', async () => {
  const baseDir = await mkdtemp(join(tmpdir(), 'unmute-empty-chat-'))
  const launches: ClaudeTaskOptions[] = [], sent: string[] = []
  const manager = new TaskManager({ baseDir, executorFactory: () => { throw new Error('No PTY') },
    claudeSessionOptions: async task => ({ binary: 'fake', cwd: task.cwd }),
    claudeTaskFactory: options => { launches.push(options); return { alive: true, busy: false, async start() {}, close() {}, async send(text: string) { sent.push(text) } } as never },
  })
  const id = await manager.createChat({ provider: 'claude' })
  assert.equal(launches.length, 0)
  assert.equal(manager.get(id)?.chatUnstarted, true)
  assert.notEqual(manager.get(id)?.cwd, manager.get(id)?.home)
  assert.ok(manager.get(id)?.managedProjectId)
  await manager.configureChat(id, { model: 'sonnet' })
  assert.equal(launches.length, 0)
  assert.equal(await manager.deliverDraft(id, 'Real question', []), true)
  assert.equal(launches[0].resume, false)
  assert.equal(launches[0].model, 'sonnet')
  assert.deepEqual(sent, ['Real question'])
  assert.equal(manager.get(id)?.chatUnstarted, false)
  manager.shutdown()
})

test('restart restores structured history without starting a provider and preserves completion', async () => {
  const baseDir = await mkdtemp(join(tmpdir(), 'unmute-chat-restore-'))
  const manager = new TaskManager({
    baseDir, executorFactory: () => { throw new Error('No PTY') },
    claudeSessionOptions: async task => ({ binary: 'fake', cwd: task.cwd }),
    claudeTaskFactory: options => ({ alive: true, busy: false, async start() {}, close() {}, async send() {
      options.onEvent({ type: 'result', message: { type: 'result', result: 'Finished' } })
    } } as never),
  })
  const id = await manager.dispatch('Hello')
  const home = manager.get(id)!.home
  await (manager as any).persistState(manager.get(id))
  await writeFile(join(home, 'chat-frames.json'), JSON.stringify([{ type: 'assistant', uuid: 'a', message: { content: [{ type: 'text', text: 'Restored reply' }] } }]))
  manager.shutdown()
  const restarted = new TaskManager({ baseDir, executorFactory: () => { throw new Error('Restart must not spawn') } })
  await restarted.rehydrate()
  assert.equal(restarted.get(id)?.state, 'done')
  assert.equal(restarted.get(id)?.turnOutcome, 'completed')
  assert.deepEqual(restarted.get(id)?.blocks, [{ kind: 'message', role: 'assistant', text: 'Restored reply' }])
  restarted.shutdown()
})

test('partial recovery cannot erase readable block-only content during reconnect and persisted replay', async () => {
  const baseDir = await mkdtemp(join(tmpdir(), 'unmute-partial-reconnect-'))
  const manager = new TaskManager({ baseDir, executorFactory: () => { throw new Error('No PTY') },
    claudeSessionOptions: async task => ({ binary: 'fake', cwd: task.cwd }),
    claudeTaskFactory: options => ({ alive: true, busy: false, async start() {}, close() {}, async send() {
      options.onEvent({ type: 'message', message: { type: 'assistant', uuid: 'answer', message: { content: [{ type: 'text', text: 'New live answer' }] } } })
      options.onEvent({ type: 'result', message: { type: 'result', result: 'New live answer' } })
    } } as never),
  })
  const id = await manager.createChat({ provider: 'claude' }), task = manager.get(id)!
  task.chatUnstarted = false; task.sessionId = undefined as any; task.state = 'done'
  task.blocks = [{ kind: 'message', role: 'user', text: 'Previously readable prompt' }, { kind: 'turnEnd', outcome: 'cancelled' }]
  await writeFile(join(task.home, 'chat-frames.json'), JSON.stringify([{ type: 'system', unmuteHistoryIncomplete: true }, { type: 'user', uuid: 'partial', message: { content: [{ type: 'text', text: 'Partial recovered prompt' }] } }]))
  await manager.configureChat(id, { model: 'sonnet' })
  assert.equal((task.blocks[0] as any).text, 'Previously readable prompt')
  await manager.deliverDraft(id, 'Continue', [])
  assert.equal((task.blocks[0] as any).text, 'Previously readable prompt')
  assert.ok(task.blocks.some(b => b.kind === 'message' && b.text === 'New live answer'))
  await Promise.all([...(manager as any).claudeHistoryWrites.values()])
  const history = JSON.parse(await readFile(join(task.home, 'chat-frames.json'), 'utf8'))
  assert.ok(history.some((f: any) => f.uuid === 'partial'), 'raw recovered frames remain private and recoverable')
  await manager.configureChat(id, { effort: 'high' })
  assert.equal((task.blocks[0] as any).text, 'Previously readable prompt')
  assert.equal(task.blocks.filter(b => b.kind === 'message' && b.text === 'New live answer').length, 1)
  manager.shutdown()
})

test('production reconnect checkpoint preserves pending MCP completion with hidden or already displayed call', async () => {
  for (const displayed of [false, true]) {
    const baseDir = await mkdtemp(join(tmpdir(), 'unmute-pending-reconnect-'))
    const manager = new TaskManager({ baseDir, executorFactory: () => { throw new Error('No PTY') },
      claudeSessionOptions: async task => ({ binary: 'fake', cwd: task.cwd }),
      claudeTaskFactory: options => ({ alive: true, busy: false, async start() {}, close() {}, async send() {
        options.onEvent({ type: 'message', message: { type: 'user', uuid: 'result', tool_use_result: { status: 'completed', structuredContent: { finding: 'unique structured reconnect finding' } }, message: { content: [{ type: 'tool_result', tool_use_id: 'mcp', content: 'unique reconnect MCP output' }] } } })
        options.onEvent({ type: 'result', message: { type: 'result', result: 'Done' } })
      } } as never),
    })
    const id = await manager.createChat({ provider: 'claude' }), task = manager.get(id)!
    task.chatUnstarted = false; task.sessionId = undefined as any; task.state = 'done'
    task.blocks = displayed ? [{ kind: 'mcpCall', server: 'tools', tool: 'read', status: 'running' }] : [{ kind: 'message', role: 'user', text: 'Unrelated retained prompt' }]
    await writeFile(join(task.home, 'chat-frames.json'), JSON.stringify([{ type: 'system', unmuteHistoryIncomplete: true },
      { type: 'assistant', uuid: 'call', message: { content: [{ type: 'tool_use', id: 'mcp', name: 'mcp__tools__read', input: {} }] } }]))
    await manager.configureChat(id, { model: 'sonnet' })
    await manager.deliverDraft(id, 'Continue', [])
    const tools = task.blocks.filter(b => b.kind === 'mcpCall')
    assert.equal(tools.length, 1)
    assert.equal(tools[0].status, 'succeeded')
    assert.match(tools[0].output!, /unique reconnect MCP output/)
    assert.match(tools[0].output!, /unique structured reconnect finding/)
    if (!displayed) assert.equal((task.blocks[0] as any).text, 'Unrelated retained prompt')
    await manager.configureChat(id, { effort: 'high' })
    assert.equal(task.blocks.filter(b => b.kind === 'mcpCall').length, 1)
    manager.shutdown()
  }
})

test('owned Claude chat creates one structured writer, preserves policy and resumes exact identity', async () => {
  const baseDir = await mkdtemp(join(tmpdir(), 'unmute-chat-integration-'))
  const launches: ClaudeTaskOptions[] = [], sent: string[] = []
  let live = true
  const manager = new TaskManager({
    baseDir, executorFactory: () => { throw new Error('PTY must not be created') },
    claudeChoice: () => ({ model: 'sonnet', permissionMode: 'bypassPermissions' }),
    claudeSessionOptions: async task => ({ binary: 'fake-claude', cwd: task.cwd, sessionId: task.sessionId }),
    claudeTaskFactory: options => {
      launches.push(options); live = true
      return {
        get alive() { return live }, busy: false, async start() {}, close() { live = false },
        async send(text: string) {
          sent.push(text)
          options.onEvent({ type: 'result', message: { type: 'result', result: 'Done', is_error: false } })
          return { submissionId: 'test', sessionId: options.sessionId! }
        },
      } as never
    },
  })
  const id = await manager.dispatch('First')
  const task = manager.get(id)!
  assert.equal(launches.length, 1)
  assert.equal(launches[0].permissionMode, 'bypassPermissions')
  assert.equal(task.state, 'done')
  assert.equal(await manager.deliverDraft(id, 'Second', []), true)
  assert.equal(launches.length, 1)
  live = false
  assert.equal(await manager.resume(id), true)
  assert.equal(launches[1].resume, true)
  assert.equal(launches[1].sessionId, launches[0].sessionId)
  assert.deepEqual(sent, ['First', 'Second'])
  const meta = JSON.parse(await readFile(join(task.home, 'meta.json'), 'utf8'))
  assert.equal(meta.claudeSessionSettings.model, 'sonnet')
  manager.shutdown()
})

test('stopping while Claude options load prevents the first prompt from being sent', async () => {
  const baseDir = await mkdtemp(join(tmpdir(), 'unmute-chat-stop-'))
  let release!: () => void, id = '', sends = 0
  const ready = new Promise<void>(r => { release = r })
  const manager = new TaskManager({
    baseDir, executorFactory: () => { throw new Error('No PTY') },
    claudeSessionOptions: async task => { id = task.id; await ready; return { binary: 'fake', cwd: task.cwd } },
    claudeTaskFactory: () => ({ alive: true, busy: false, async start() {}, close() {}, async send() { sends++ } } as never),
  })
  const dispatch = manager.dispatch('Must not run')
  while (!id) await new Promise(r => setTimeout(r, 1))
  manager.kill(id); release(); await dispatch
  assert.equal(sends, 0)
  assert.equal(manager.get(id)?.state, 'failed')
  manager.shutdown()
})

test('legacy owned conversation migrates only on explicit resume and keeps its exact session', async () => {
  const baseDir = await mkdtemp(join(tmpdir(), 'unmute-legacy-chat-'))
  const initial = new TaskManager({ baseDir, executorFactory: () => { throw new Error('No PTY') },
    claudeSessionOptions: async task => ({ binary: 'fake', cwd: task.cwd }),
  })
  const id = await initial.createChat({ provider: 'claude' })
  const home = initial.get(id)!.home, sessionId = initial.get(id)!.sessionId
  initial.shutdown()
  await Promise.all([...(initial as any).metaChains.values()])
  const meta = JSON.parse(await readFile(join(home, 'meta.json'), 'utf8'))
  delete meta.claudeSessionSettings
  delete meta.chatUnstarted
  await writeFile(join(home, 'meta.json'), JSON.stringify(meta))
  const launches: ClaudeTaskOptions[] = []
  let live = new Set([id])
  const manager = new TaskManager({ baseDir, executorFactory: () => { throw new Error('No PTY migration') },
    listLiveRuntimeIds: async () => live,
    claudeSessionOptions: async task => ({ binary: 'fake', cwd: task.cwd }),
    claudeTaskFactory: options => { launches.push(options); return { alive: true, busy: false, async start() {}, close() {} } as never },
  })
  await manager.rehydrate()
  assert.equal(await manager.deliverDraft(id, 'Do not send yet', []), false)
  assert.equal(await manager.resume(id), false)
  assert.match(manager.get(id)!.resumeError!, /Stop the existing legacy runtime/)
  assert.equal(launches.length, 0)
  live = new Set()
  assert.equal(await manager.resume(id), true)
  assert.equal(launches.length, 1)
  assert.equal(launches[0].sessionId, sessionId)
  assert.equal(launches[0].resume, true)
  assert.equal(launches[0].cwd, meta.cwd)
  manager.shutdown()
})

test('unknown legacy Claude conversation becomes Unmute-owned only after provider resume succeeds', async () => {
  const baseDir = await mkdtemp(join(tmpdir(), 'unmute-legacy-adopt-'))
  const initial = new TaskManager({ baseDir, executorFactory: () => { throw new Error('No PTY') },
    claudeSessionOptions: async task => ({ binary: 'fake', cwd: task.cwd }),
  })
  const id = await initial.createChat({ provider: 'claude' })
  const home = initial.get(id)!.home, sessionId = initial.get(id)!.sessionId
  initial.shutdown(); await Promise.all([...(initial as any).metaChains.values()])
  const meta = JSON.parse(await readFile(join(home, 'meta.json'), 'utf8'))
  delete meta.claudeSessionSettings; delete meta.sessionOwnership; delete meta.chatUnstarted
  await writeFile(join(home, 'meta.json'), JSON.stringify(meta))

  const launches: ClaudeTaskOptions[] = []
  const manager = new TaskManager({ baseDir, executorFactory: () => { throw new Error('No PTY migration') },
    listLiveRuntimeIds: async () => new Set(),
    claudeSessionOptions: async task => ({ binary: 'fake', cwd: task.cwd }),
    claudeTaskFactory: options => { launches.push(options); return { alive: true, busy: false, async start() {}, close() {} } as never },
  })
  await manager.rehydrate()
  assert.equal(manager.get(id)?.sessionOwnership, 'unknown')
  assert.equal(await manager.resume(id), true)
  assert.equal(launches[0].sessionId, sessionId)
  const adopted = JSON.parse(await readFile(join(home, 'meta.json'), 'utf8'))
  assert.equal(adopted.sessionOwnership, 'unmute')
  assert.ok(adopted.claudeSessionSettings)
  manager.shutdown()
})

test('externally owned conversation cannot silently acquire a second structured writer', async () => {
  const baseDir = await mkdtemp(join(tmpdir(), 'unmute-external-chat-'))
  const initial = new TaskManager({ baseDir, executorFactory: () => { throw new Error('No PTY') } })
  const id = await initial.createChat({ provider: 'claude' })
  const home = initial.get(id)!.home
  initial.shutdown()
  await Promise.all([...(initial as any).metaChains.values()])
  const meta = JSON.parse(await readFile(join(home, 'meta.json'), 'utf8'))
  delete meta.claudeSessionSettings
  delete meta.chatUnstarted
  meta.importedFromCli = true
  await writeFile(join(home, 'meta.json'), JSON.stringify(meta))
  const manager = new TaskManager({ baseDir, executorFactory: () => { throw new Error('No PTY') },
    claudeSessionOptions: async () => { throw new Error('Must not launch an external session') },
  })
  await manager.rehydrate()
  assert.equal(await manager.resume(id), false)
  assert.match(manager.get(id)!.resumeError!, /owned outside Unmute/)
  assert.equal(await manager.deliverDraft(id, 'No second writer', []), false)
  assert.match(manager.get(id)!.deliveryError!, /read-only/)
  manager.shutdown()
})
