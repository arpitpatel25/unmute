import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RuntimeRpcClient, RuntimeRpcServer } from './rpc'
import { CodexRuntimeService } from './codex-service'
import { PersistentCodexHub } from './codex-client'
import type { CodexAppServer, ServerRequest } from '../codex/app-server-client'
import type { HubPatch } from '../codex/hub'

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
