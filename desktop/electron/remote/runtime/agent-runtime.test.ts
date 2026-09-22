import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { AgentRuntimeService } from './agent-service'
import { AgentRuntimeClient } from './agent-client'
import { RuntimeRpcClient, RuntimeRpcServer } from './rpc'
import type { AgentProvider, AgentCompletion, AgentStartInput } from '../agent/provider'
import type { RoutinesView } from '../agent/routines/types'
import { RoutineService } from '../agent/routines/service'

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
  const agent: AgentProvider = {
    id: 'codex', probe: async () => ({ provider: 'codex', available: true }),
    async start() { return { handle: { provider: 'codex', opaqueId: 'agent-session' }, activity: (async function* () {})(), completion: new Promise(() => {}) } },
    async resume(_handle, input) { return this.start(input) }, interrupt: async () => {}, close: async () => {},
  }
  const routineStarts: AgentStartInput[] = []
  const gateway: Record<string, any> = {}
  const call = async (input: AgentStartInput, name: string, args: unknown) => (await (await fetch(input.mcp.endpoint, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${input.mcp.token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })).json()).result
  const reader: AgentProvider = {
    id: 'codex', probe: async () => ({ provider: 'codex', available: true }),
    async start(input) {
      routineStarts.push(input)
      const completion = (async (): Promise<AgentCompletion> => {
        gateway.list = await call(input, 'routine_list', {})
        gateway.create = await call(input, 'routine_create', { name: 'Escape', schedule: 'daily 10:00', prompt: 'Write something.' })
        return { outcome: 'completed', finalText: 'Yesterday you shipped routines.' }
      })()
      return { handle: { provider: 'codex', opaqueId: 'routine-session' }, activity: (async function* () {})(), completion }
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
    assert.notEqual(gateway.list?.isError, true, 'a routine token is a valid caller for read tools')
    assert.equal(gateway.create?.isError, true, 'but a reversible-write tool is refused through the gateway')
    assert.match(gateway.create.content[0].text, /requires an active explicit interaction/)
    assert.deepEqual((await client.routines.view()).items.map(i => i.id), ['morning-recap'], 'nothing was created')
    assert.equal(routineStarts[0].cwd, join(root, 'routines', 'runs', started.id))
    assert.equal(await client.routines.transcriptPath('no-such-run'), null)
    assert.equal(await client.routines.path('morning-recap'), join(root, 'routines', 'morning-recap.md'))
    const snapshot = await rpc.call('agent.snapshot')
    assert.equal(snapshot.routines.items.length, 1)
    await client.routines.update('morning-recap', { inputs: ['meetings'], context: { folders: [], sessionIds: [], files: [], excludedFolders: [], excludedSessionIds: [], meetingIds: ['m1'] } })
    const duplicate = await client.routines.duplicate('morning-recap')
    assert.equal(duplicate.enabled, false)
    assert.deepEqual(duplicate.context?.meetingIds, ['m1'])
    await client.routines.refreshContext()
    assert.ok((await client.routines.view()).contextCatalog)
    await client.routines.remove(duplicate.id)
    const off = await rpc.call('agent.update', { routines: false })
    assert.equal(off.routines.available, false, 'turning routines off rebuilds the service disabled')
    assert.equal(views.at(-1)?.available, false, 'and a fresh view is emitted')
    await assert.rejects(client.routines.runNow('morning-recap'), /turned off in Settings/)
  } finally { client.dispose(); rpc.disconnect(); await service.close(); await server.close(); await rm(root, { recursive: true, force: true }) }
})

const fakeIndex = () => ({ cipherVersion: 'test-projection', project() {}, setDeleted() {}, remove() {}, search: () => [], rebuild() {}, runInTransaction: (fn: any) => fn(), close() {} })
async function routinesHarness() {
  const root = await mkdtemp(join(tmpdir(), 'routines-'))
  const starts: AgentStartInput[] = []
  const provider: AgentProvider = {
    id: 'codex', probe: async () => ({ provider: 'codex', available: true }),
    async start(input) { starts.push(input); return { handle: { provider: 'codex', opaqueId: 'agent-session' }, activity: (async function* () {})(), completion: new Promise(() => {}) } },
    async resume(_handle, input) { return this.start(input) }, interrupt: async () => {}, close: async () => {},
  }
  const events: any[] = []
  const service = new AgentRuntimeService(root, event => events.push(event), async () => { throw new Error('UI offline') },
    new Map([['codex', provider]]), fakeIndex, { reader: new Map([['codex', provider]]) })
  const configure = (extra: object = {}) => service.invoke('configure', [{ masterKey: randomBytes(32).toString('base64'), selectedProvider: 'codex', ...extra }]) as Promise<any>
  return { root, service, events, starts, configure, view: () => service.invoke('routines.view', []) as Promise<RoutinesView>,
    close: async () => { await service.close(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }) } }
}

test('a routines start failure leaves the Agent working and reports why', async () => {
  const h = await routinesHarness()
  try {
    await writeFile(join(h.root, 'routines'), 'not a directory')
    const snapshot = await h.configure({ routines: true })
    assert.ok(snapshot.view, 'the Agent lifecycle still initializes')
    assert.equal(snapshot.routines.available, false)
    assert.match(snapshot.routines.reason, /^Routines couldn't start: /)
    assert.match((await h.view()).reason!, /^Routines couldn't start: /)
    assert.equal(h.events.filter(e => e.kind === 'routines').at(-1)?.view.available, false, 'the unavailable view is emitted')
    await assert.rejects(h.service.invoke('routines.create', [{ name: 'x', schedule: 'daily 09:00', prompt: 'y' }]), /Routines couldn't start/)
    await h.service.invoke('enqueue', [{ transcript: 'still here', submissionId: 'still-here' }])
    for (let n = 0; n < 100 && !h.starts.length; n++) await new Promise(resolve => setTimeout(resolve, 5))
    assert.equal(h.starts.length, 1, 'the Agent still takes a turn')
    await rm(join(h.root, 'routines'))
    const retried = await h.service.invoke('update', [{ routines: true }]) as any
    assert.equal(retried.routines.available, true, 'the same value retries a service that failed to start')
  } finally { await h.close() }
})

test('a failed toggle rebuild is not sticky: the same value retries', async () => {
  const h = await routinesHarness()
  try {
    await h.configure({ routines: true })
    assert.equal((await h.view()).available, true)
    await rm(join(h.root, 'routines'), { recursive: true, force: true })
    await writeFile(join(h.root, 'routines'), 'not a directory')
    const failed = await h.service.invoke('update', [{ routines: false }]) as any
    assert.match(failed.routines.reason, /^Routines couldn't start: /)
    await rm(join(h.root, 'routines'))
    const retried = await h.service.invoke('update', [{ routines: false }]) as any
    assert.equal(retried.routines.available, false)
    assert.equal(retried.routines.reason, 'Routines are turned off in Settings', 'the retry built the disabled service')
  } finally { await h.close() }
})

test('concurrent routines toggles leave exactly one live service', async () => {
  const h = await routinesHarness()
  const proto = RoutineService.prototype, initialize = proto.initialize, close = proto.close
  let live = 0
  proto.initialize = async function (this: RoutineService) { await initialize.call(this); live++ }
  proto.close = async function (this: RoutineService) { live--; await close.call(this) }
  try {
    await h.configure({ routines: true })
    assert.equal(live, 1)
    const [, last] = await Promise.all([h.service.invoke('update', [{ routines: false }]), h.service.invoke('update', [{ routines: true }])]) as any[]
    assert.equal(live, 1, 'every replaced service was closed')
    assert.equal(last.routines.available, true)
    await h.service.close()
    assert.equal(live, 0)
  } finally { proto.initialize = initialize; proto.close = close; await h.close() }
})

test('UNMUTE_ROUTINES=0 disables routines, and routines queries answer before configure', async () => {
  const h = await routinesHarness()
  const previous = process.env.UNMUTE_ROUTINES
  try {
    assert.deepEqual(await h.view(), { available: false, reason: 'The Agent is not running', items: [], runs: [] })
    assert.equal(await h.service.invoke('routines.transcriptPath', ['nope']), null)
    process.env.UNMUTE_ROUTINES = '0'
    await h.configure({ routines: true })
    const view = await h.view()
    assert.equal(view.available, false)
    assert.equal(view.reason, 'Routines are turned off in Settings')
  } finally {
    if (previous === undefined) delete process.env.UNMUTE_ROUTINES; else process.env.UNMUTE_ROUTINES = previous
    await h.close()
  }
})
