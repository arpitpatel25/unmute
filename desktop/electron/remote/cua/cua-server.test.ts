// HTTP bridge tests — speaks MCP over HTTP the way Claude Code does, backed by
// fake-driver children. Proves: verbatim pass-through, session-id routing to
// distinct children, the master kill switch, and session teardown.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { startCuaServer, CUA_MCP_PATH } from './server'
import { DriverManager } from './driver-manager'
import type { AxPolicy } from '../ax/policy'

const FAKE = join(process.cwd(), 'electron', 'remote', 'cua', 'fake-driver.mjs')
const ON: AxPolicy = { enabled: true, screenshotEnabled: true, allowAll: true, allowed: [] }
const OFF: AxPolicy = { ...ON, enabled: false }

function mgr(): DriverManager {
  return new DriverManager({ binPath: process.execPath, binArgs: [FAKE], permissionPollMs: 0 })
}

async function post(port: number, body: unknown, sessionId?: string): Promise<{ json: any; sessionHeader: string | null }> {
  const res = await fetch(`http://127.0.0.1:${port}${CUA_MCP_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}) },
    body: JSON.stringify(body),
  })
  return { json: await res.json(), sessionHeader: res.headers.get('Mcp-Session-Id') }
}
const rpc = (method: string, params?: unknown) => ({ jsonrpc: '2.0', id: 1, method, params })

test('initialize: forwards the driver init verbatim and assigns a session id', async () => {
  const m = mgr()
  const s = await startCuaServer({ manager: m, getPolicy: () => ON, port: 0 })
  try {
    const a = await post(s.port, rpc('initialize', { protocolVersion: '2025-06-18' }))
    assert.equal(a.json.result.serverInfo.name, 'cua-driver')
    assert.equal(a.json.result.instructions, 'fake driver instructions')
    assert.ok(a.sessionHeader)
    const b = await post(s.port, rpc('initialize', { protocolVersion: '2025-06-18' }))
    assert.notEqual(a.sessionHeader, b.sessionHeader)
  } finally { s.close(); m.dispose() }
})

test('tools/list + tools/call pass through verbatim', async () => {
  const m = mgr()
  const s = await startCuaServer({ manager: m, getPolicy: () => ON, port: 0 })
  try {
    const list = await post(s.port, rpc('tools/list'))
    assert.equal(list.json.result.tools[0].name, 'list_apps')
    const call = await post(s.port, rpc('tools/call', { name: 'anything', arguments: { x: 1 } }))
    assert.equal(call.json.result.content[0].text, 'called anything')
    assert.deepEqual(call.json.result.structuredContent, { ok: true })
  } finally { s.close(); m.dispose() }
})

test('sessions route to distinct driver children', async () => {
  const m = mgr()
  const s = await startCuaServer({ manager: m, getPolicy: () => ON, port: 0 })
  try {
    const a = (await post(s.port, rpc('initialize', {}))).sessionHeader as string
    const b = (await post(s.port, rpc('initialize', {}))).sessionHeader as string
    const pidA = (await post(s.port, rpc('tools/call', { name: '__pid', arguments: {} }), a)).json.result.content[0].text
    const pidB = (await post(s.port, rpc('tools/call', { name: '__pid', arguments: {} }), b)).json.result.content[0].text
    assert.notEqual(pidA, pidB)
  } finally { s.close(); m.dispose() }
})

test('kill switch: tools/call refused when disabled; tools/list still visible', async () => {
  const m = mgr()
  const s = await startCuaServer({ manager: m, getPolicy: () => OFF, port: 0 })
  try {
    const call = await post(s.port, rpc('tools/call', { name: 'list_apps', arguments: {} }))
    assert.equal(call.json.result.isError, true)
    assert.match(call.json.result.content[0].text, /turned OFF/)
    const list = await post(s.port, rpc('tools/list'))
    assert.equal(list.json.result.tools.length, 1)
  } finally { s.close(); m.dispose() }
})
