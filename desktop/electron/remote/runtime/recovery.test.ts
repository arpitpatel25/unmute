import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RuntimeRpcClient, RuntimeRpcServer } from './rpc'
import { ClaudeRuntimeService } from './claude-service'
import type { ClaudeTaskSession, ClaudeTaskOptions } from '../claude/task-session'

test('a hung runtime request releases the caller without cancelling background work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-timeout-'))
  let finish!: (value: string) => void
  const server = new RuntimeRpcServer(join(root, 's'), async method => method === 'slow' ? new Promise<string>(resolve => { finish = resolve }) : 'alive')
  await server.listen()
  const client = new RuntimeRpcClient(join(root, 's'), 40)
  try {
    await assert.rejects(client.call('slow'), /timed out.*outcome is unknown/)
    assert.equal(await client.call('ping'), 'alive')
    finish('completed')
    assert.equal(await client.call('ping'), 'alive')
  } finally { client.disconnect(); await server.close(); await rm(root, { recursive: true, force: true }) }
})

test('large conversation snapshots arrive promptly and preserve split UTF-8', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-history-'))
  const text = '🙂 history '.repeat(2_000_000)
  const server = new RuntimeRpcServer(join(root, 's'), async () => text)
  await server.listen()
  const client = new RuntimeRpcClient(join(root, 's'), 5_000)
  try { assert.equal(await client.call('snapshot'), text) }
  finally { client.disconnect(); await server.close(); await rm(root, { recursive: true, force: true }) }
})

test('Claude reconnect reuses live work, but reopens a dead driver with the same session identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-reopen-'))
  const drivers: Array<{ alive: boolean }> = []
  const options: ClaudeTaskOptions[] = []
  const service = new ClaudeRuntimeService(root, () => {}, input => {
    options.push(input)
    const driver = { alive: false, busy: false, models: [], followupBlocked: false, followupUnavailable: false,
      async start() { this.alive = true }, close() { this.alive = false } }
    drivers.push(driver)
    return driver as unknown as ClaudeTaskSession
  })
  try {
    const input = { sessionId: 'original', binary: 'claude', cwd: root, resume: true }
    await service.invoke('open', ['original', input])
    await service.invoke('open', ['original', input])
    assert.equal(drivers.length, 1)
    drivers[0].alive = false
    const reopened = await service.invoke('open', ['original', input]) as { alive: boolean }
    assert.equal(reopened.alive, true)
    assert.equal(drivers.length, 2)
    assert.equal(options[1].sessionId, 'original')
    assert.equal(options[1].resume, true)
  } finally { service.close(); await rm(root, { recursive: true, force: true }) }
})
