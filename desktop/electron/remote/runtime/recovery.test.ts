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

test('Claude reconnect replays only the bounded recent runtime tail', async () => {
  const { PersistentClaudeTaskSession } = await import('./claude-client')
  const replayOffsets: number[] = []
  const seen: string[] = []
  const rpc = {
    on() {}, off() {},
    async call(method: string, ...args: unknown[]) {
      if (method === 'claude.open') return {
        alive: true, busy: false, followupBlocked: false, followupUnavailable: false,
        models: [], sequence: 1_000, replayFrom: 900,
      }
      if (method === 'claude.replay') {
        const offset = args[1] as number
        replayOffsets.push(offset)
        return Array.from({ length: Math.min(100, 1_000 - offset) }, (_, index) => ({
          sessionId: 'bounded', sequence: offset + index + 1,
          event: { type: 'text', text: `event-${offset + index + 1}` },
          state: { alive: true, busy: false, followupBlocked: false, followupUnavailable: false, models: [] },
        }))
      }
      throw new Error(`Unexpected method ${method}`)
    },
  } as unknown as RuntimeRpcClient
  const driver = new PersistentClaudeTaskSession(rpc, {
    binary: 'claude', cwd: '/tmp', sessionId: 'bounded', resume: true,
    onEvent(event) { if (event.type === 'text') seen.push(event.text) },
  })
  await driver.start()
  assert.deepEqual(replayOffsets, [900])
  assert.equal(seen.length, 100)
  assert.equal(seen.at(-1), 'event-1000')
})

test('an idle-released Claude process resumes transparently on the next send', async () => {
  const { PersistentClaudeTaskSession } = await import('./claude-client')
  const root = await mkdtemp(join(tmpdir(), 'claude-idle-resume-'))
  let clock = 1_000_000
  const drivers: Array<{ alive: boolean; sent: string[]; newTurns: string[] }> = []
  let server!: RuntimeRpcServer
  const service = new ClaudeRuntimeService(root, event => server.emit('claude.event', event), options => {
    const driver = {
      alive: false, busy: false, models: [], followupBlocked: false, followupUnavailable: false,
      sent: [] as string[], newTurns: [] as string[],
      async start() { this.alive = true },
      async send(text: string) { this.sent.push(text); return { submissionId: 'next', sessionId: options.sessionId! } },
      async sendNewTurn(text: string) { this.newTurns.push(text); return { kind: 'accepted', submissionId: 'followup' } },
      close() { if (!this.alive) return; this.alive = false; options.onEvent({ type: 'closed' }) },
    }
    drivers.push(driver)
    return driver as unknown as ClaudeTaskSession
  }, { idleMs: 60_000, sweepMs: 60_000, now: () => clock })
  server = new RuntimeRpcServer(join(root, 's'), (method, args) => service.invoke(method.replace('claude.', ''), args))
  await server.listen()
  const rpc = new RuntimeRpcClient(join(root, 's'))
  const driver = new PersistentClaudeTaskSession(rpc, {
    binary: 'claude', cwd: root, sessionId: 'conversation', resume: true, onEvent() {},
  })
  try {
    await driver.start()
    clock += 61_000
    service.sweepIdle()

    const sent = await driver.send('continue our conversation')

    assert.deepEqual(sent, { submissionId: 'next', sessionId: 'conversation' })
    assert.equal(drivers.length, 2)
    assert.deepEqual(drivers[1].sent, ['continue our conversation'])

    clock += 61_000
    service.sweepIdle()
    const followup = await driver.sendNewTurn('and keep going', [], 'followup')

    assert.deepEqual(followup, { kind: 'accepted', submissionId: 'followup' })
    assert.equal(drivers.length, 3)
    assert.deepEqual(drivers[2].newTurns, ['and keep going'])
  } finally { driver.detach(); rpc.disconnect(); service.close(); await server.close(); await rm(root, { recursive: true, force: true }) }
})

test('Claude checkpoint edits check worker capability before opening and preserve the checkpoint across RPC', async () => {
  const { PersistentClaudeTaskSession } = await import('./claude-client')
  const root = await mkdtemp(join(tmpdir(), 'claude-edit-worker-'))
  const opened: ClaudeTaskOptions[] = []
  let capable = false
  const service = new ClaudeRuntimeService(root, () => {}, options => {
    opened.push(options)
    return { alive: true, busy: false, models: [], followupBlocked: false, followupUnavailable: false, async start() {}, close() {} } as unknown as ClaudeTaskSession
  })
  const server = new RuntimeRpcServer(join(root, 's'), (method, args) => method === 'runtime.info'
    ? Promise.resolve({ capabilities: capable ? ['claude.resumeSessionAt'] : [] }) : service.invoke(method.replace('claude.', ''), args))
  await server.listen()
  const rpc = new RuntimeRpcClient(join(root, 's'))
  const driver = new PersistentClaudeTaskSession(rpc, { binary: 'claude', cwd: root, sessionId: 'child', forkFromSessionId: 'source', resumeSessionAt: 'answer-1', onEvent() {} })
  try {
    await assert.rejects(driver.start(), /checkpoint support/)
    assert.equal(opened.length, 0)
    capable = true
    await driver.start()
    assert.equal(opened[0].resumeSessionAt, 'answer-1')
    assert.equal(opened[0].forkFromSessionId, 'source')
  } finally { driver.detach(); rpc.disconnect(); service.close(); await server.close(); await rm(root, { recursive: true, force: true }) }
})
