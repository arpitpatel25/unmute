import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RuntimeRpcClient, RuntimeRpcServer } from './rpc'
import { CompatibleCodexRuntime } from './codex-routing'

test('new fork uses compatible runtime while old sessions stay with their owner', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-routing-'))
  const oldCalls: string[] = [], newCalls: string[] = []
  let forked = false
  const old = new RuntimeRpcServer(join(dir, 'old.sock'), async method => {
    oldCalls.push(method)
    if (method === 'codex.forkThread') throw new Error('Unknown Codex runtime command')
    if (method === 'codex.snapshot') return { running: true, url: '', tasks: [{ taskId: 'old-task' }] }
    return true
  })
  const modern = new RuntimeRpcServer(join(dir, 'new.sock'), async method => {
    newCalls.push(method)
    if (method === 'runtime.info') return { capabilities: ['codex.forkThread', 'codex.forkResult', 'codex.targetedSnapshot'] }
    if (method === 'codex.forkThread') { forked = true; return { threadId: 'child', forkedFromId: 'source' } }
    if (method === 'codex.snapshot') return { running: true, url: '', tasks: forked ? [{ taskId: 'new-task' }] : [] }
    return true
  })
  await old.listen(); await modern.listen()
  const a = new RuntimeRpcClient(join(dir, 'old.sock')), b = new RuntimeRpcClient(join(dir, 'new.sock'))
  const router = new CompatibleCodexRuntime(a, b)
  try {
    await router.call('codex.prepare', 'new-task', { bin: 'codex' })
    assert.deepEqual(await router.call('codex.forkThread', 'new-task', 'source', {}), { threadId: 'child', forkedFromId: 'source' })
    await router.call('codex.send', 'new-task', 'hello')
    await router.call('codex.send', 'old-task', 'hello')
    assert.equal(oldCalls.includes('codex.forkThread'), false)
    assert.equal(newCalls.filter(x => x === 'codex.prepare').length, 1)
    assert.equal(newCalls.filter(x => x === 'codex.send').length, 1)
    const snapshot = await router.call('codex.snapshot')
    assert.deepEqual(snapshot.tasks.map((t: any) => t.taskId), ['old-task', 'new-task'])
  } finally { router.disconnect(); a.disconnect(); b.disconnect(); await old.close(); await modern.close() }
})

test('an older fork-capable worker is refused before creating a child without recovery support', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-capabilities-'))
  const calls: string[] = []
  const server = new RuntimeRpcServer(join(dir, 'rpc.sock'), async method => {
    calls.push(method)
    if (method === 'runtime.info') return { capabilities: ['codex.forkThread'] }
    return true
  })
  await server.listen()
  const rpc = new RuntimeRpcClient(join(dir, 'rpc.sock'))
  const router = new CompatibleCodexRuntime(rpc, rpc)
  try {
    await assert.rejects(router.call('codex.forkThread', 'task', 'source', {}), /needs an update/)
    assert.equal(calls.includes('codex.forkThread'), false)
  } finally { router.disconnect(); rpc.disconnect(); await server.close() }
})

test('rolling v3 upgrade keeps main and v2 task owners and refreshes only the new fork worker', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-rolling-'))
  const calls: string[][] = [[], [], []]
  const servers = calls.map((lane, index) => new RuntimeRpcServer(join(dir, `${index}.sock`), async (method, args) => {
    lane.push(method)
    if (method === 'runtime.info') return { capabilities: index === 2 ? ['codex.forkThread', 'codex.forkResult', 'codex.targetedSnapshot'] : ['codex.forkThread'] }
    if (method === 'codex.snapshot') return { running: true, url: '', tasks: [{ taskId: ['main-task', 'v2-task', 'new-task'][index] }] }
    if (method === 'codex.forkThread') return { threadId: 'child', forkedFromId: args[1] }
    return true
  }))
  await Promise.all(servers.map(server => server.listen()))
  const clients = calls.map((_, index) => new RuntimeRpcClient(join(dir, `${index}.sock`)))
  const router = new CompatibleCodexRuntime(new CompatibleCodexRuntime(clients[0], clients[1]), clients[2])
  try {
    await router.call('codex.snapshot')
    await router.call('codex.send', 'main-task', 'hello')
    await router.call('codex.send', 'v2-task', 'hello')
    await router.call('codex.forkThread', 'new-task', 'source', {})
    const before = calls.map(lane => lane.filter(method => method === 'codex.snapshot').length)
    await router.call('codex.snapshot', 'new-task')
    assert.deepEqual(calls.map(lane => lane.filter(method => method === 'codex.snapshot').length), [before[0], before[1], before[2] + 1])
    assert.deepEqual(calls.map(lane => lane.filter(method => method === 'codex.forkThread').length), [0, 0, 1])
    assert.deepEqual(calls.map(lane => lane.filter(method => method === 'codex.send').length), [1, 1, 0])
  } finally { router.disconnect(); clients.forEach(client => client.disconnect()); await Promise.all(servers.map(server => server.close())); await rm(dir, { recursive: true, force: true }) }
})
