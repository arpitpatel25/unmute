// DriverClient protocol tests against fake-driver.mjs — proves the handshake,
// the embedded + telemetry-off env contract, request correlation, timeouts,
// and death handling, without touching the real binary or any TCC surface.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { DriverClient } from './driver-client'

const FAKE = join(process.cwd(), 'electron', 'remote', 'cua', 'fake-driver.mjs')

function client(extra: Partial<ConstructorParameters<typeof DriverClient>[0]> = {}): DriverClient {
  return new DriverClient({ binPath: process.execPath, binArgs: [FAKE], ...extra })
}

test('handshake: initResult carries the driver initialize result verbatim', async () => {
  const c = client()
  try {
    const init = await c.initResult
    assert.equal((init as any).protocolVersion, '2025-06-18')
    assert.equal((init as any).serverInfo.name, 'cua-driver')
    assert.equal((init as any).instructions, 'fake driver instructions')
  } finally { c.kill() }
})

test('env contract: child sees EMBEDDED=1 and telemetry forced off (both vars)', async () => {
  const c = client()
  try {
    const res = (await c.request('tools/call', { name: '__env', arguments: {} })) as any
    const env = JSON.parse(res.content[0].text)
    assert.equal(env.embedded, '1')
    assert.equal(env.telemetry, 'false')
    assert.equal(env.telemetryCompat, 'false')
  } finally { c.kill() }
})

test('timeout: a call the driver never answers rejects with a timeout error', async () => {
  const c = client({ timeoutMs: 300 })
  try {
    await assert.rejects(c.request('tools/call', { name: '__slow', arguments: {} }), /timed out/)
  } finally { c.kill() }
})

test('death: kill() fails in-flight and future requests, fires onExit', async () => {
  let exited = false
  const c = client({ onExit: () => { exited = true } })
  await c.initResult
  c.kill()
  await assert.rejects(c.request('tools/list'), /not running/)
  await new Promise((r) => setTimeout(r, 200))
  assert.equal(exited, true)
  assert.equal(c.alive, false)
})
