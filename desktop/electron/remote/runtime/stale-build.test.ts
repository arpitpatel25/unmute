import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PersistentRuntimeClient, runtimeSocket } from './client'
import { RuntimeRpcServer } from './rpc'

/** An "old daemon" still serving after an install, and the fresh one a spawn
 *  would start. The spawn itself is a no-op here; the fresh server stands in. */
async function daemons(root: string) {
  const log: string[] = []
  const fresh = new RuntimeRpcServer(runtimeSocket(root), async method => method === 'hello' ? { build: 'new' } : 'fresh')
  const old: RuntimeRpcServer = new RuntimeRpcServer(runtimeSocket(root), async method => {
    log.push(method)
    if (method === 'hello') return { build: 'old' }
    if (method === 'runtime.shutdown') { setImmediate(async () => { await old.close(); await fresh.listen() }); return { shuttingDown: true } }
    return 'old'
  })
  await old.listen()
  return { old, fresh, log }
}

async function scenario(idle: boolean, build: string) {
  const root = await mkdtemp(join(tmpdir(), 'runtime-stale-'))
  const d = await daemons(root)
  let asked = 0
  const client = new PersistentRuntimeClient(root, '/unused', '/usr/bin/true')
    .replaceStaleBuild({ build, idle: async () => { asked++; return idle } })
  try { return { answer: await client.call('ping'), log: d.log, asked } }
  finally { client.disconnect(); await d.old.close().catch(() => {}); await d.fresh.close().catch(() => {}); await rm(root, { recursive: true, force: true }); await rm(dirname(runtimeSocket(root)), { recursive: true, force: true }) }
}

test('an idle daemon from an older build is replaced before anything attaches', async () => {
  const r = await scenario(true, 'new')
  assert.equal(r.answer, 'fresh')
  assert.deepEqual(r.log, ['hello', 'runtime.shutdown'], 'no task call ever reached the old build')
})

test('a busy daemon from an older build is left alone this launch', async () => {
  const r = await scenario(false, 'new')
  assert.equal(r.answer, 'old')
  assert.ok(!r.log.includes('runtime.shutdown'))
})

test('a deferred stale daemon is replaced after it becomes idle without another app launch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-stale-retry-'))
  const d = await daemons(root)
  let busy = true
  const client = new PersistentRuntimeClient(root, '/unused', '/usr/bin/true')
    .replaceStaleBuild({ build: 'new', idle: async () => !busy, retryAfterMs: 5 })
  try {
    assert.equal(await client.call('ping'), 'old')
    assert.ok(!d.log.includes('runtime.shutdown'))
    busy = false
    const deadline = Date.now() + 1_000
    while (!d.log.includes('runtime.shutdown') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
    assert.ok(d.log.includes('runtime.shutdown'))
    const freshDeadline = Date.now() + 1_000
    let answer = ''
    while (Date.now() < freshDeadline) {
      try { answer = await client.call<string>('ping'); if (answer === 'fresh') break } catch { /* reconnecting */ }
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(answer, 'fresh')
  } finally {
    client.disconnect()
    await d.old.close().catch(() => {})
    await d.fresh.close().catch(() => {})
    await rm(root, { recursive: true, force: true })
    await rm(dirname(runtimeSocket(root)), { recursive: true, force: true })
  }
})

test('a daemon already on this build is kept and not even asked about idleness', async () => {
  const r = await scenario(true, 'old')
  assert.equal(r.answer, 'old')
  assert.equal(r.asked, 0)
})
