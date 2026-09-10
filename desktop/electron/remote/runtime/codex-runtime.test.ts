import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RuntimeRpcClient, RuntimeRpcServer } from './rpc'
import { CodexRuntimeService } from './codex-service'
import { PersistentCodexHub } from './codex-client'
import type { CodexAppServer, ServerRequest } from '../codex/app-server-client'
import type { HubPatch } from '../codex/hub'
import { createServer } from 'node:net'

test('live runtime events carry a lightweight mirror while snapshots retain complete blocks', async t => {
  const root = await mkdtemp(join(tmpdir(), 'codex-light-events-'))
  let notify: (value: any) => void = () => {}
  const provider = {
    running: true, url: 'ws://localhost:9999', async start() {}, stop() {}, on(_name: string, callback: typeof notify) { notify = callback; return () => {} }, onRequest() {}, notify() {},
    async request(method: string) { return method === 'thread/start' ? { threadId: 'thread' } : method === 'turn/start' ? { turn: { id: 'turn' } } : {} },
  } as unknown as CodexAppServer
  const events: any[] = []
  const service = new CodexRuntimeService(root, event => events.push(event), { makeServer: () => provider })
  t.after(async () => { service.close(); await rm(root, { recursive: true, force: true }) })
  await service.invoke('prepare', ['task', { bin: '/codex' }])
  await service.invoke('startThread', ['task', { cwd: '/tmp' }])
  events.length = 0

  notify({ method: 'item/agentMessage/delta', params: { threadId: 'thread', turnId: 'turn', itemId: 'answer', delta: 'Hello' } })
  await new Promise(resolve => setImmediate(resolve))

  const event = events.findLast(candidate => candidate.kind === 'patch')
  assert.equal(event?.mirror.patch, undefined)
  assert.equal(event?.patch.blockUpdates?.[0]?.block.text, 'Hello')
  const snapshot = await service.invoke('snapshot', ['task']) as any
  assert.equal(snapshot.tasks[0].patch.blocks[0].text, 'Hello')
})

test('idle release atomically refuses changed or active bindings and retains canonical identity', async t => {
  const root = await mkdtemp(join(tmpdir(), 'codex-release-idle-'))
  let notify: (value: any) => void = () => {}
  const provider = { running: true, url: '', async start() {}, stop() {}, on(_name: string, callback: typeof notify) { notify = callback; return () => {} }, onRequest() {},
    async request(method: string) { return method === 'thread/start' ? { threadId: 'thread' } : method === 'turn/start' ? { turn: { id: 'active' } } : {} },
  } as unknown as CodexAppServer
  const service = new CodexRuntimeService(root, () => {}, { makeServer: () => provider })
  t.after(async () => { service.close(); await rm(root, { recursive: true, force: true }) })
  await service.invoke('prepare', ['task', { bin: '/codex' }])
  await service.invoke('startThread', ['task', { cwd: '/tmp' }])
  assert.equal(await service.invoke('releaseIdle', ['task', 'different']), false)
  assert.equal(await service.invoke('send', ['task', 'work']), true)
  assert.equal(await service.invoke('releaseIdle', ['task', 'thread']), false)
  assert.equal(service.hub.threadIdFor('task'), 'thread')
  notify({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'active', status: 'completed' } } })
  assert.equal(await service.invoke('releaseIdle', ['task', 'thread']), true)
  assert.equal(service.hub.threadIdFor('task'), undefined)
  assert.equal((await service.invoke('identity', ['task']) as any).threadId, 'thread')
})

test('fork status returns durable identity while provider history is still loading', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fork-slow-history-'))
  let release!: (value: any) => void
  let entered!: () => void
  const loading = new Promise<void>(resolve => { entered = resolve })
  const provider = {
    running: true, url: '', async start() {}, stop() {}, on() { return () => {} }, onRequest() {}, notify() {},
    async request(method: string) {
      if (method === 'thread/fork') return { thread: { id: 'child', turns: [] }, turnsBackwardsCursor: 'older' }
      if (method === 'thread/turns/list') { entered(); return new Promise(resolve => { release = resolve }) }
      return {}
    },
  } as unknown as CodexAppServer
  const service = new CodexRuntimeService(root, () => {}, { makeServer: () => provider })
  await service.invoke('prepare', ['task', { bin: '/codex' }])
  const fork = service.invoke('forkThread', ['task', 'source', { cwd: '/tmp' }])
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await loading
    const result = await Promise.race([service.invoke('forkResult', ['task', 'source']),
      new Promise(resolve => { timer = setTimeout(() => resolve('blocked-on-history'), 200) })])
    assert.deepEqual(result, { threadId: 'child', forkedFromId: 'source' })
  } finally { clearTimeout(timer); release({ data: [] }); await fork; service.close(); await rm(root, { recursive: true, force: true }) }
})

test('canonical fork identity survives a runtime restart and repairs legacy receipts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fork-canonical-identity-'))
  let forks = 0
  const provider = {
    running: true, url: '', async start() {}, stop() {}, on() { return () => {} }, onRequest() {}, notify() {},
    async request(method: string) {
      if (method === 'thread/fork') { forks++; return { thread: { id: 'child', forkedFromId: 'source', turns: [] } } }
      if (method === 'thread/start') return { thread: { id: 'started' } }
      return {}
    },
  } as unknown as CodexAppServer
  const first = new CodexRuntimeService(root, () => {}, { makeServer: () => provider })
  await first.invoke('prepare', ['task', { bin: '/codex' }])
  await first.invoke('forkThread', ['task', 'source', { cwd: '/tmp' }])
  assert.deepEqual(await first.invoke('identity', ['task', 'source']), { taskId: 'task', threadId: 'child', forkedFromId: 'source' })
  await first.invoke('prepare', ['fresh', { bin: '/codex' }])
  await first.invoke('startThread', ['fresh', { cwd: '/tmp' }])
  assert.deepEqual(await first.invoke('identity', ['fresh']), { taskId: 'fresh', threadId: 'started' })
  first.close()

  // Simulate an upgrade from a build that had the durable fork receipt but no
  // canonical per-task identity record.
  const identity = (await readdir(root)).find(file => file.startsWith('identity-'))
  assert.ok(identity)
  await unlink(join(root, identity))
  const restarted = new CodexRuntimeService(root, () => {}, { makeServer: () => provider })
  try {
    assert.deepEqual(await restarted.invoke('identity', ['task', 'source']), { taskId: 'task', threadId: 'child', forkedFromId: 'source' })
    assert.equal(forks, 1, 'identity recovery must never issue another provider fork')
    assert.ok((await readdir(root)).some(file => file.startsWith('identity-')), 'legacy recovery is promoted to the canonical record')
    await restarted.invoke('prepare', ['task', { bin: '/codex' }])
    await restarted.invoke('resumeThread', ['task', 'child', { cwd: '/tmp' }])
    assert.deepEqual(await restarted.invoke('identity', ['task', 'child']), { taskId: 'task', threadId: 'child', forkedFromId: 'source' }, 'resuming a recovered child preserves its lineage')
  } finally { restarted.close(); await rm(root, { recursive: true, force: true }) }
})

test('a real socket loss after provider acceptance recovers the same child without retrying the fork', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fork-socket-loss-'))
  let forkCalls = 0
  const server = createServer(socket => {
    let buffer = ''
    socket.on('data', bytes => {
      buffer += bytes.toString()
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      const frame = JSON.parse(buffer.slice(0, newline))
      buffer = buffer.slice(newline + 1)
      if (frame.method === 'codex.forkThread') { forkCalls++; socket.end(); return }
      const result = frame.method === 'codex.forkResult' ? { threadId: 'child', forkedFromId: 'source' } : true
      socket.write(JSON.stringify({ id: frame.id, result }) + '\n')
    })
  })
  await new Promise<void>(resolve => server.listen(join(root, 'rpc.sock'), resolve))
  const rpc = new RuntimeRpcClient(join(root, 'rpc.sock'), 1000)
  const hub = new PersistentCodexHub(rpc, { resolveBin: async () => '/codex', onPatch() {} })
  try {
    assert.equal((await hub.forkThread('task', 'source', { cwd: '/tmp' } as any)).threadId, 'child')
    assert.equal(forkCalls, 1)
  } finally { hub.stop(); rpc.disconnect(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }) }
})

test('a confirmed fork does not fail when history refresh fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fork-confirm-'))
  const methods: string[] = []
  const server = new RuntimeRpcServer(join(root, 'rpc.sock'), async method => {
    methods.push(method)
    if (method === 'codex.forkThread') return { threadId: 'child', forkedFromId: 'source' }
    if (method === 'codex.snapshot') throw new Error('History connection lost')
    return true
  })
  await server.listen()
  const rpc = new RuntimeRpcClient(join(root, 'rpc.sock'))
  const hub = new PersistentCodexHub(rpc, { resolveBin: async () => '/codex', onPatch() {} })
  try {
    assert.deepEqual(await hub.forkThread('task', 'source', { cwd: '/tmp' } as any), { threadId: 'child', forkedFromId: 'source' })
    assert.equal(hub.threadIdFor('task'), 'child')
    assert.equal(methods.filter(m => m === 'codex.forkThread').length, 1)
  } finally { hub.stop(); rpc.disconnect(); await server.close(); await rm(root, { recursive: true, force: true }) }
})

test('lost fork acknowledgement is recovered by status without issuing another fork', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fork-recover-'))
  const methods: string[] = []
  const server = new RuntimeRpcServer(join(root, 'rpc.sock'), async method => {
    methods.push(method)
    if (method === 'codex.forkThread') throw new Error('Runtime disconnected; submission may have been accepted')
    if (method === 'codex.forkResult') return { threadId: 'child', forkedFromId: 'source' }
    if (method === 'codex.snapshot') return { running: true, url: '', tasks: [] }
    return true
  })
  await server.listen()
  const rpc = new RuntimeRpcClient(join(root, 'rpc.sock'))
  const hub = new PersistentCodexHub(rpc, { resolveBin: async () => '/codex', onPatch() {} })
  try {
    assert.equal((await hub.forkThread('task', 'source', { cwd: '/tmp' } as any)).threadId, 'child')
    assert.equal(methods.filter(m => m === 'codex.forkThread').length, 1)
    assert.ok(methods.includes('codex.forkResult'))
  } finally { hub.stop(); rpc.disconnect(); await server.close(); await rm(root, { recursive: true, force: true }) }
})

test('fork receipt survives a worker restart and retry resumes the exact child', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fork-receipt-'))
  const calls: Array<{ method: string; threadId?: string }> = []
  const provider = {
    running: true, url: '', async start() {}, stop() {}, on() { return () => {} }, onRequest() {}, notify() {},
    async request(method: string, args: any) {
      calls.push({ method, threadId: args?.threadId })
      if (method === 'thread/fork') return { thread: { id: 'child', forkedFromId: 'source', turns: [] } }
      if (method === 'thread/resume') return { thread: { id: 'child', turns: [] } }
      return {}
    },
  } as unknown as CodexAppServer
  const first = new CodexRuntimeService(root, () => {}, { makeServer: () => provider })
  const second = new CodexRuntimeService(root, () => {}, { makeServer: () => provider })
  try {
    await first.invoke('prepare', ['task', { bin: '/codex' }])
    await first.invoke('forkThread', ['task', 'source', { cwd: '/tmp' }])
    first.close()
    assert.deepEqual(await second.invoke('forkResult', ['task', 'source']), { threadId: 'child', forkedFromId: 'source' })
    await second.invoke('prepare', ['task', { bin: '/codex' }])
    assert.deepEqual(await second.invoke('forkThread', ['task', 'source', { cwd: '/tmp' }]), { threadId: 'child', forkedFromId: 'source' })
    assert.equal(calls.filter(c => c.method === 'thread/fork').length, 1)
    assert.ok(calls.some(c => c.method === 'thread/resume' && c.threadId === 'child'))
  } finally { first.close(); second.close(); await rm(root, { recursive: true, force: true }) }
})

test('UI reconnect replays pending approval and keeps the original provider thread alive', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-daemon-'))
  const calls: string[] = []
  let handler!: (request: ServerRequest) => Promise<unknown>
  let stops = 0
  const provider = {
    running: true, url: 'ws://localhost:9999', async start() {}, stop() { stops++ },
    on() { return () => {} }, onRequest(h: typeof handler) { handler = h }, notify() {},
    async request(method: string) { calls.push(method); return method === 'thread/start' ? { threadId: 'original' } : {} },
  } as unknown as CodexAppServer
  let service!: CodexRuntimeService
  const server = new RuntimeRpcServer(join(root, 'rpc.sock'), (method, args) => service.invoke(method.replace('codex.', ''), args))
  service = new CodexRuntimeService(join(root, 'data'), event => server.emit('codex.event', event), { makeServer: () => provider })
  await server.listen()
  const rpc = new RuntimeRpcClient(join(root, 'rpc.sock'))
  const patches: HubPatch[] = []
  const deps = { resolveBin: async () => '/codex', onPatch: (p: HubPatch) => patches.push(p), approvalCap: () => ({ roots: [], fullAccessAllowed: true }) }
  const first = new PersistentCodexHub(rpc, deps)
  const options = { cwd: '/tmp', approvalPolicy: 'on-request', sandbox: 'danger-full-access' }
  try {
    await first.startThread('task', options)
    const approval = handler({ id: 7, method: 'item/commandExecution/requestApproval', params: {
      threadId: 'original', command: 'echo hello', availableDecisions: ['accept', 'decline'],
    } })
    let resolved = false
    void approval.then(() => { resolved = true })
    first.stop(); rpc.disconnect()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(resolved, false)
    assert.equal(stops, 0)
    const nextRpc = new RuntimeRpcClient(join(root, 'rpc.sock'))
    const next = new PersistentCodexHub(nextRpc, deps)
    try {
      await next.reconnect()
      assert.equal(next.threadIdFor('task'), 'original')
      const question = patches.filter(p => p.question).at(-1)!.question!
      assert.ok(question.reference)
      await next.resumeThread('task', 'original', options)
      assert.equal(calls.filter(c => c === 'thread/resume').length, 0)
      assert.equal(next.answer('task', 'Allow once', question.reference), true)
      assert.deepEqual(await approval, { decision: 'accept' })
      assert.equal(calls.filter(c => c === 'thread/start').length, 1)
    } finally { next.stop(); nextRpc.disconnect() }
  } finally {
    first.stop(); rpc.disconnect(); service.close(); await server.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('provider-native fork is owned by the persistent runtime and survives UI reconnect', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-daemon-fork-'))
  const calls: string[] = []
  const provider = {
    running: true, url: 'ws://localhost:9999', async start() {}, stop() {},
    on() { return () => {} }, onRequest() {}, notify() {},
    async request(method: string) {
      calls.push(method)
      if (method === 'thread/fork') return { thread: { id: 'child', forkedFromId: 'source', turns: [
        { id: 'turn-1', status: 'completed', items: [{ type: 'userMessage', content: [{ type: 'inputText', text: 'Earlier request' }] }] },
      ] } }
      return {}
    },
  } as unknown as CodexAppServer
  let service!: CodexRuntimeService
  const server = new RuntimeRpcServer(join(root, 'rpc.sock'), (method, args) => service.invoke(method.replace('codex.', ''), args))
  service = new CodexRuntimeService(join(root, 'data'), event => server.emit('codex.event', event), { makeServer: () => provider })
  await server.listen()
  const options = { cwd: '/tmp', approvalPolicy: 'on-request', sandbox: 'danger-full-access' }
  const deps = { resolveBin: async () => '/codex', onPatch() {}, approvalCap: () => ({ roots: [], fullAccessAllowed: true }) }
  const firstRpc = new RuntimeRpcClient(join(root, 'rpc.sock'))
  const first = new PersistentCodexHub(firstRpc, deps)
  try {
    assert.deepEqual(await first.forkThread('task', 'source', options), { threadId: 'child', forkedFromId: 'source' })
    assert.equal(first.threadIdFor('task'), 'child')
    first.stop(); firstRpc.disconnect()

    const nextRpc = new RuntimeRpcClient(join(root, 'rpc.sock'))
    const next = new PersistentCodexHub(nextRpc, deps)
    try {
      await next.reconnect()
      assert.equal(next.threadIdFor('task'), 'child')
      assert.deepEqual(calls, ['thread/fork'])
    } finally { next.stop(); nextRpc.disconnect() }
  } finally {
    first.stop(); firstRpc.disconnect(); service.close(); await server.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('persistent edits rollback the child, force recovery, and scope repeated forks by operation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-edit-runtime-'))
  const calls: Array<{ method: string; params: any }> = []
  let forks = 0
  const provider = {
    running: true, url: 'ws://localhost:9999', async start() {}, stop() {},
    on() { return () => {} }, onRequest() {}, notify() {},
    async request(method: string, params: any) {
      calls.push({ method, params })
      if (method === 'thread/fork') return { thread: { id: `child-${++forks}`, forkedFromId: params.threadId, turns: [] } }
      if (method === 'thread/resume') return { thread: { id: params.threadId, turns: [] } }
      return {}
    },
  } as unknown as CodexAppServer
  let service!: CodexRuntimeService
  const server = new RuntimeRpcServer(join(root, 'rpc.sock'), (method, args) => service.invoke(method.replace('codex.', ''), args))
  service = new CodexRuntimeService(join(root, 'data'), event => server.emit('codex.event', event), { makeServer: () => provider })
  await server.listen()
  const rpc = new RuntimeRpcClient(join(root, 'rpc.sock'))
  const hub = new PersistentCodexHub(rpc, { resolveBin: async () => '/codex', onPatch() {}, approvalCap: () => ({ roots: [], fullAccessAllowed: true }) })
  const options = { cwd: '/tmp', approvalPolicy: 'on-request', sandbox: 'danger-full-access' }
  try {
    await hub.forkThread('task', 'source', options)
    await hub.rollbackLatestTurn('task', options)
    assert.equal(calls.find(c => c.method === 'thread/rollback')?.params.threadId, 'child-1')
    const resumes = calls.filter(c => c.method === 'thread/resume').length
    await assert.rejects(hub.resumeThread('task', 'source', options, true), /canonical/i)
    assert.equal(calls.filter(c => c.method === 'thread/resume').length, resumes, 'reject a stale parent before acquiring its writer')
    await hub.resumeThread('task', 'child-1', options, true)
    assert.equal(hub.threadIdFor('task'), 'child-1')
    assert.equal((await hub.forkThread('task', 'child-1', options, 'edit-1')).threadId, 'child-2')
    assert.equal((await hub.forkThread('task', 'child-1', options, 'edit-1')).threadId, 'child-2')
    assert.equal(forks, 2)
    assert.equal((await hub.forkThread('task', 'child-2', options, 'edit-2')).threadId, 'child-3')
    assert.deepEqual(await service.invoke('forkResult', ['task', 'child-1', 'edit-1']), { threadId: 'child-2', forkedFromId: 'child-1' })
    await assert.rejects(service.invoke('forkThread', ['task', 'different', options, 'edit-1']), /cannot change its source/)
  } finally { hub.stop(); rpc.disconnect(); service.close(); await server.close(); await rm(root, { recursive: true, force: true }) }
})
