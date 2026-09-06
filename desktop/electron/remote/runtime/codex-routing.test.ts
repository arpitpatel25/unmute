import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
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
    if (method === 'runtime.info') return { capabilities: ['codex.forkThread'] }
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
