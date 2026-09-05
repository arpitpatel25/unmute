import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PersistentRuntimeClient, runtimeExecutable, runtimeSocket } from './client'
import { RuntimeRpcServer } from './rpc'
import { once } from 'node:events'

test('packaged macOS runtime uses the helper executable so LaunchServices can relaunch the GUI', async () => {
  const root = await mkdtemp(join(tmpdir(), 'unmute-runtime-exec-'))
  const main = join(root, 'unmute.app', 'Contents', 'MacOS', 'unmute')
  const helper = join(root, 'unmute.app', 'Contents', 'Frameworks', 'unmute Helper.app', 'Contents', 'MacOS', 'unmute Helper')
  try {
    await mkdir(dirname(main), { recursive: true })
    await mkdir(dirname(helper), { recursive: true })
    await writeFile(main, '')
    await writeFile(helper, '')
    assert.equal(runtimeExecutable(main), helper)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('runtime executable falls back outside a packaged macOS bundle', () => {
  assert.equal(runtimeExecutable('/usr/local/bin/electron'), '/usr/local/bin/electron')
})

test('a dropped runtime socket reconnects automatically without resubmitting a turn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-reconnect-'))
  const methods: string[] = []
  const server = new RuntimeRpcServer(runtimeSocket(root), async method => { methods.push(method); return 'ok' })
  const client = new PersistentRuntimeClient(root, '/unused')
  await server.listen()
  try {
    assert.equal(await client.call('ping'), 'ok')
    const disconnected = once(client, 'disconnected')
    await server.close(); await disconnected
    await server.listen()
    await once(client, 'reconnected', { signal: AbortSignal.timeout(5_000) })
    assert.equal(await client.call('ping'), 'ok')
    assert.deepEqual(methods, ['ping', 'ping'])
  } finally { client.disconnect(); await server.close(); await rm(root, { recursive: true, force: true }); await rm(dirname(runtimeSocket(root)), { recursive: true, force: true }) }
})
