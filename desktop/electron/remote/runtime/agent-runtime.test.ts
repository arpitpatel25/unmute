import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { AgentRuntimeService } from './agent-service'
import { AgentRuntimeClient } from './agent-client'
import { RuntimeRpcClient, RuntimeRpcServer } from './rpc'
import type { AgentProvider, AgentCompletion, AgentStartInput } from '../agent/provider'
import type { RoutinesView } from '../agent/routines/types'

test('Agent work and encrypted conversation survive UI disconnection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-runtime-'))
  let finish!: (result: AgentCompletion) => void
  let accepted!: (input: AgentStartInput) => void
  const started = new Promise<AgentStartInput>(resolve => { accepted = resolve })
  let closes = 0
  const provider: AgentProvider = {
    id: 'codex', probe: async () => ({ provider: 'codex', available: true }),
    async start(input) { accepted(input); return { handle: { provider: 'codex', opaqueId: 'stable-session' }, activity: (async function* () {})(), completion: new Promise(resolve => { finish = resolve }) } },
    async resume(_handle, input) { return this.start(input) }, interrupt: async () => {}, close: async () => { closes++ },
  }
  let service!: AgentRuntimeService
  const server = new RuntimeRpcServer(join(root, 'rpc.sock'), (method, args) => service.invoke(method.replace('agent.', ''), args))
  service = new AgentRuntimeService(root, event => server.emit('agent.event', event), async () => { throw new Error('UI offline') }, new Map([['codex', provider]]), () => ({
    cipherVersion: 'test-projection', project() {}, setDeleted() {}, remove() {}, search: () => [], rebuild() {}, runInTransaction: fn => fn(), close() {},
  }))
  await server.listen()
  const rpc = new RuntimeRpcClient(join(root, 'rpc.sock'))
  const client = new AgentRuntimeClient(rpc, { onView() {}, onActivity() {} })
  try {
    await client.configure({ masterKey: randomBytes(32).toString('base64'), selectedProvider: 'codex' })
    await client.configure({ masterKey: randomBytes(32).toString('base64'), selectedProvider: 'codex', conversationCeiling: 24 })
    assert.equal(client.view().record.pendingProvider, undefined, 'UI reconnect must not rotate an unchanged provider conversation')
    assert.equal(client.view().record.ceiling, 20, 'the new ceiling applies at the next conversation boundary')
    const queued = await client.enqueue({ transcript: 'remember the durable test', submissionId: 'test-submission' })
    const input = await started
    assert.ok(input.mcp.endpoint.includes('127.0.0.1:'))
    assert.ok(!input.mcp.endpoint.includes(':0/'))
    assert.match(await readFile(input.constitutionPath, 'utf8'), /Unmute/)
    client.dispose(); rpc.disconnect()
    assert.equal(closes, 0)
    finish({ outcome: 'completed', finalText: 'Completed while the UI was closed.' })
    const nextRpc = new RuntimeRpcClient(join(root, 'rpc.sock'))
    try {
      let result: any
      for (let n = 0; n < 100 && !result; n++) {
        result = await nextRpc.call('agent.completion', queued.submissionId)
        if (!result) await new Promise(resolve => setTimeout(resolve, 5))
      }
      assert.equal(result?.outcome, 'completed')
      const snapshot = await nextRpc.call('agent.snapshot')
      assert.equal(snapshot.view.record.accepted.length, 1)
      assert.equal(closes, 0)
    } finally { nextRpc.disconnect() }
  } finally { client.dispose(); rpc.disconnect(); await service.close(); await server.close(); await rm(root, { recursive: true, force: true }) }
})

test('routines run inside the daemon: create, view, event, run now to a written result', async () => {
  const root = await mkdtemp(join(tmpdir(), 'routines-'))
  const fakeIndex = () => ({ cipherVersion: 'test-projection', project() {}, setDeleted() {}, remove() {}, search: () => [], rebuild() {}, runInTransaction: (fn: any) => fn(), close() {} })
  const agent: AgentProvider = {
    id: 'codex', probe: async () => ({ provider: 'codex', available: true }),
    async start() { return { handle: { provider: 'codex', opaqueId: 'agent-session' }, activity: (async function* () {})(), completion: new Promise(() => {}) } },
    async resume(_handle, input) { return this.start(input) }, interrupt: async () => {}, close: async () => {},
  }
  const routineStarts: AgentStartInput[] = []
  const reader: AgentProvider = {
    id: 'codex', probe: async () => ({ provider: 'codex', available: true }),
    async start(input) {
      routineStarts.push(input)
      return { handle: { provider: 'codex', opaqueId: 'routine-session' }, activity: (async function* () {})(),
        completion: Promise.resolve({ outcome: 'completed', finalText: 'Yesterday you shipped routines.' }) }
    },
    async resume(_handle, input) { return this.start(input) }, interrupt: async () => {}, close: async () => {},
  }
  let service!: AgentRuntimeService
  const server = new RuntimeRpcServer(join(root, 'rpc.sock'), (method, args) => service.invoke(method.replace('agent.', ''), args))
  service = new AgentRuntimeService(root, event => server.emit('agent.event', event), async () => { throw new Error('UI offline') },
    new Map([['codex', agent]]), fakeIndex, { reader: new Map([['codex', reader]]) })
  await server.listen()
  const rpc = new RuntimeRpcClient(join(root, 'rpc.sock'))
  const views: RoutinesView[] = []
  const client = new AgentRuntimeClient(rpc, { onView() {}, onActivity() {}, onRoutines: view => views.push(view) })
  try {
    await client.configure({ masterKey: randomBytes(32).toString('base64'), selectedProvider: 'codex', routines: true })
    const created = await client.routines.create({ name: 'Morning recap', schedule: 'daily 09:00', prompt: 'Recap yesterday.', window: 'none' })
    assert.equal(created.item.id, 'morning-recap')
    const view: RoutinesView = await client.routines.view()
    assert.equal(view.available, true)
    assert.deepEqual(view.items.map(i => i.id), ['morning-recap'])
    for (let n = 0; n < 100 && !views.some(v => v.items.length === 1); n++) await new Promise(resolve => setTimeout(resolve, 5))
    assert.ok(views.some(v => v.items.some(i => i.id === 'morning-recap')), 'a routines event reaches the client')
    const started = await client.routines.runNow('morning-recap')
    let detail: any
    for (let n = 0; n < 200; n++) {
      detail = await client.routines.run(started.id)
      if (detail?.run.status === 'done') break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(detail?.run.status, 'done')
    assert.equal(detail.result, 'Yesterday you shipped routines.')
    assert.ok((await stat(join(root, 'routines', 'runs', started.id, 'result.md'))).isFile())
    assert.equal(routineStarts.length, 1)
    assert.equal(routineStarts[0].cwd, join(root, 'routines', 'runs', started.id))
    assert.equal(await client.routines.transcriptPath('no-such-run'), null)
    assert.equal(await client.routines.path('morning-recap'), join(root, 'routines', 'morning-recap.md'))
    const snapshot = await rpc.call('agent.snapshot')
    assert.equal(snapshot.routines.items.length, 1)
    const off = await rpc.call('agent.update', { routines: false })
    assert.equal(off.routines.available, false, 'turning routines off rebuilds the service disabled')
    assert.equal(views.at(-1)?.available, false, 'and a fresh view is emitted')
    await assert.rejects(client.routines.runNow('morning-recap'), /turned off in Settings/)
  } finally { client.dispose(); rpc.disconnect(); await service.close(); await server.close(); await rm(root, { recursive: true, force: true }) }
})
