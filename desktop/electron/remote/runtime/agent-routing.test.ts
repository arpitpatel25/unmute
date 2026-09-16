import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RuntimeRpcClient, RuntimeRpcServer } from './rpc'
import { CompatibleAgentRuntime, recoverAgentRuntime } from './agent-routing'

const idle = () => ({ view: { record: { phase: 'ready' }, snapshot: { queued: [] } }, availability: {} })
async function fixture(oldState: any = idle(), newState: any = { availability: {} }, builds?: { running?: string; expected: string }) {
  const root = await mkdtemp(join(tmpdir(), 'agent-routing-'))
  const states = [oldState, newState], calls: string[] = []
  let running = builds?.running
  const servers: RuntimeRpcServer[] = states.map((_, i) => new RuntimeRpcServer(join(root, `${i}.sock`), async (method) => {
    calls.push(`${i}:${method}`)
    if (method === 'hello') return { version: 1, pid: 0, ...(i === 1 && running ? { build: running } : {}) }
    if (i === 1 && method === 'runtime.shutdown') {
      // The daemon exits; the next connection finds a fresh one on the new build.
      setTimeout(() => { void (async () => {
        clients[1].disconnect(); await servers[1].close(); states[1] = { availability: {} }; running = builds?.expected; await servers[1].listen()
      })() }, 10)
      return { shuttingDown: true }
    }
    if (method === 'agent.disable') states[i] = { availability: {} }
    if (method === 'agent.configure') states[i] = idle()
    if (method === 'agent.enqueue') return { submissionId: String(i) }
    return states[i]
  }))
  await Promise.all(servers.map(s => s.listen()))
  const clients = states.map((_, i) => new RuntimeRpcClient(join(root, `${i}.sock`)))
  const router = new CompatibleAgentRuntime(clients[0], clients[1], builds?.expected)
  return { router, states, calls, clients, restartCurrent: async () => {
    clients[1].disconnect(); await servers[1].close(); states[1] = { availability: {} }; await servers[1].listen()
  }, close: async () => {
    router.disconnect(); clients.forEach(c => c.disconnect())
    await Promise.all(servers.map(s => s.close())); await rm(root, { recursive: true, force: true })
  } }
}
test('idle upgrade closes only legacy Agent before current opens shared storage', async () => {
  const f = await fixture()
  try {
    await f.router.call('agent.configure', { masterKey: 'secret' })
    assert.deepEqual(f.calls.filter(c => !c.endsWith('snapshot')), ['0:agent.disable', '1:agent.configure'])
    assert.deepEqual(await f.router.call('agent.enqueue', {}), { submissionId: '1' })
  } finally { await f.close() }
})
test('busy legacy Agent finishes with its owner then next enqueue upgrades once', async () => {
  const busy = idle(); busy.view.record.phase = 'sending'
  const f = await fixture(busy)
  try {
    await f.router.call('agent.configure', { masterKey: 'secret' })
    assert.deepEqual(await f.router.call('agent.enqueue', {}), { submissionId: '0' })
    assert.equal(f.calls.includes('0:agent.disable'), false)
    f.states[0] = idle()
    await Promise.all([f.router.call('agent.configure', { masterKey: 'secret' }), f.router.call('agent.enqueue', {})])
    assert.equal(f.calls.filter(c => c === '0:agent.disable').length, 1)
    assert.equal(f.calls.filter(c => c === '1:agent.configure').length, 1)
    assert.equal(f.calls.at(-1), '1:agent.enqueue')
  } finally { await f.close() }
})
test('relaunch reuses configured current worker and forwards only owner events', async () => {
  const f = await fixture({ availability: {} }, idle())
  try {
    await f.router.call('agent.configure', { masterKey: 'secret' })
    const events: unknown[] = []; f.router.on('agent.event', e => events.push(e))
    f.clients[0].emit('agent.event', { old: true }); f.clients[1].emit('agent.event', { current: true })
    assert.deepEqual(events, [{ current: true }])
    assert.equal(f.calls.some(c => c.endsWith('disable')), false)
    await f.router.call('agent.snapshot')
    assert.equal(f.calls.at(-1), '1:agent.snapshot')
  } finally { await f.close() }
})
test('configured current and busy legacy are refused without changing either', async () => {
  const busy = idle(); busy.view.record.phase = 'sending'
  const f = await fixture(busy, idle())
  try {
    await assert.rejects(f.router.call('agent.configure', {}), /both|active/i)
    assert.equal(f.calls.every(c => c.endsWith('snapshot')), true)
  } finally { await f.close() }
})
test('queued or prepared work cannot be mistaken for an idle Agent before acceptance', async () => {
  for (const state of [
    { view: { record: { phase: 'ready', prepared: { submissionId: 'in-flight' } }, snapshot: { queued: [] } } },
    { view: { record: { phase: 'ready' }, snapshot: { queued: [{ submissionId: 'waiting' }] } } },
  ]) {
    const f = await fixture(state)
    try {
      await f.router.call('agent.configure', { masterKey: 'secret' })
      assert.equal(f.calls.some(c => c.endsWith('disable') || c === '1:agent.configure'), false)
      assert.deepEqual(await f.router.call('agent.enqueue', {}), { submissionId: '0' })
    } finally { await f.close() }
  }
})
test('worker restart obtains fresh configuration while a live reconnect preserves its running Agent', async () => {
  const f = await fixture({ availability: {} }, idle())
  let freshConfigurations = 0, projections = 0
  const recover = () => recoverAgentRuntime(f.router, async () => {
    freshConfigurations++
    await f.router.call('agent.configure', { masterKey: 'fresh-key' })
  }, async () => { assert.ok((await f.router.call('agent.snapshot')).view); projections++ })
  try {
    await f.router.call('agent.configure', { masterKey: 'initial-key' })
    await recover()
    assert.equal(freshConfigurations, 0)
    // A newly launched daemon has no configured lifecycle. Disconnecting the
    // transport also proves recovery does not rely on a previous socket.
    await f.restartCurrent()
    await recover()
    assert.equal(freshConfigurations, 1)
    assert.equal(projections, 2)
    assert.deepEqual(await f.router.call('agent.enqueue', {}), { submissionId: '1' })
    assert.equal(f.calls.includes('0:agent.configure'), false)
  } finally { await f.close() }
})


/**
 * FIELD FAILURE (2026-09-16): the Agent's process survives quitting and
 * reinstalling, and was reused whenever its STORAGE format matched — so a new
 * build ran the old build's code, twice, until it was killed by hand.
 */
test('an idle Agent process from a different build is replaced, not reused', async () => {
  const f = await fixture({ availability: {} }, idle(), { running: 'old-build', expected: 'new-build' })
  try {
    await f.router.call('agent.configure', { masterKey: 'secret' })
    assert.ok(f.calls.includes('1:runtime.shutdown'), 'the stale process is asked to exit')
    const after = f.calls.slice(f.calls.indexOf('1:runtime.shutdown') + 1).filter(c => !c.endsWith('snapshot') && !c.endsWith('hello'))
    assert.deepEqual(after, ['1:agent.configure'], 'and the fresh one is configured, once')
  } finally { await f.close() }
})

test('an Agent process from before builds were reported is treated as stale', async () => {
  const f = await fixture({ availability: {} }, idle(), { expected: 'new-build' })
  try {
    await f.router.call('agent.configure', { masterKey: 'secret' })
    assert.ok(f.calls.includes('1:runtime.shutdown'))
  } finally { await f.close() }
})

test('an Agent process on the same build is reused', async () => {
  const f = await fixture({ availability: {} }, idle(), { running: 'same', expected: 'same' })
  try {
    await f.router.call('agent.configure', { masterKey: 'secret' })
    assert.equal(f.calls.includes('1:runtime.shutdown'), false)
  } finally { await f.close() }
})

test('a busy Agent process from a different build finishes its turn first', async () => {
  const busy = idle(); busy.view.record.phase = 'sending'
  const f = await fixture({ availability: {} }, busy, { running: 'old-build', expected: 'new-build' })
  try {
    await f.router.call('agent.snapshot')
    assert.equal(f.calls.includes('1:runtime.shutdown'), false, 'never interrupts a turn to upgrade')
  } finally { await f.close() }
})
