import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RuntimeRpcClient, RuntimeRpcServer } from './rpc'

test('a throwing event consumer is logged without dropping unrelated RPC replies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rpc-audit-'))
  const events: Array<{ event: string; fields: any }> = []
  const server = new RuntimeRpcServer(join(root, 'rpc.sock'), async () => {
    server.emit('test.event', { secret: 'never-log-payload' })
    return 'accepted'
  })
  await server.listen()
  const client = new RuntimeRpcClient(join(root, 'rpc.sock'), 1000, (event, fields) => events.push({ event, fields }))
  client.on('test.event', () => { throw new Error('consumer failed') })
  try {
    assert.equal(await client.call('ping', { token: 'never-log-payload' }), 'accepted')
    assert.ok(events.some(e => e.event === 'runtime-frame-handler-failed'))
    const start = events.find(e => e.event === 'runtime-request-started')!
    assert.ok(start.fields.requestId)
    assert.ok(events.some(e => e.event === 'runtime-request-completed' && e.fields.requestId === start.fields.requestId))
    assert.ok(!JSON.stringify(events).includes('never-log-payload'))
  } finally { client.disconnect(); await server.close(); await rm(root, { recursive: true, force: true }) }
})
