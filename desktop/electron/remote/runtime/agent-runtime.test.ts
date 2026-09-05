import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { AgentRuntimeService } from './agent-service'
import { AgentRuntimeClient } from './agent-client'
import { RuntimeRpcClient, RuntimeRpcServer } from './rpc'
import type { AgentProvider, AgentCompletion, AgentStartInput } from '../agent/provider'

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
