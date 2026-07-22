// HTTP bridge tests — speaks MCP over HTTP the way Claude Code does, backed by
// fake-driver children. Proves: verbatim pass-through, session-id routing to
// distinct children, the master kill switch, and session teardown.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { startCuaServer, CUA_MCP_PATH } from './server'
import { DriverManager } from './driver-manager'
import type { AxPolicy } from '../ax/policy'
import type { RouterCtx } from './router'
import type { CdpLane } from './lanes/cdp'
import type { Arming } from './lanes/arming'

const FAKE = join(process.cwd(), 'electron', 'remote', 'cua', 'fake-driver.mjs')
const ON: AxPolicy = { enabled: true, screenshotEnabled: true, allowAll: true, allowed: [] }
const OFF: AxPolicy = { ...ON, enabled: false }

function mgr(): DriverManager {
  return new DriverManager({ binPath: process.execPath, binArgs: [FAKE], permissionPollMs: 0 })
}

/** Fake RouterCtx whose `cdp.eval` is a spy — proves the router (not the
 *  fake driver child) served a router tool call. */
function fakeRouter(policy: () => AxPolicy = () => ON): { router: RouterCtx; evalCalls: { app: string; js: string }[] } {
  const evalCalls: { app: string; js: string }[] = []
  const cdp = {
    eval: async (app: string, js: string) => {
      evalCalls.push({ app, js })
      return { ok: true }
    },
  } as unknown as CdpLane
  const arming = {} as unknown as Arming
  const router: RouterCtx = {
    cdp,
    arming,
    runAppleScript: async () => 'ran',
    getPolicy: policy,
  }
  return { router, evalCalls }
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

test('strips cua session arg so the overlay never turns on (per-session cursors are born enabled)', async () => {
  const m = mgr()
  const s = await startCuaServer({ manager: m, getPolicy: () => ON, port: 0 })
  try {
    const call = await post(s.port, rpc('tools/call', { name: '__echo', arguments: { session: 'grpA', app: 'Notes', x: 1 } }))
    const received = call.json.result.structuredContent.receivedArgs
    assert.ok(!('session' in received), `session should be stripped, got ${JSON.stringify(received)}`)
    assert.deepEqual(received, { app: 'Notes', x: 1 }) // everything else forwarded verbatim
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

test('tools/list with a router present includes both a driver tool and web_eval', async () => {
  const m = mgr()
  const { router } = fakeRouter()
  const s = await startCuaServer({ manager: m, getPolicy: () => ON, port: 0, router })
  try {
    const list = await post(s.port, rpc('tools/list'))
    const names = list.json.result.tools.map((t: any) => t.name)
    assert.ok(names.includes('list_apps'), `expected driver tool list_apps, got ${JSON.stringify(names)}`)
    assert.ok(names.includes('web_eval'), `expected router tool web_eval, got ${JSON.stringify(names)}`)
  } finally { s.close(); m.dispose() }
})

test('tools/call for web_eval is served by the router, not the driver', async () => {
  const m = mgr()
  const { router, evalCalls } = fakeRouter()
  const s = await startCuaServer({ manager: m, getPolicy: () => ON, port: 0, router })
  try {
    const call = await post(s.port, rpc('tools/call', { name: 'web_eval', arguments: { app: 'Notion', js: '1+1' } }))
    assert.notEqual(call.json.result.isError, true) // not an error result
    assert.deepEqual(evalCalls, [{ app: 'Notion', js: '1+1' }])
    // Prove the fake driver child never saw this call.
    const seenByDriver = await post(s.port, rpc('tools/call', { name: '__calls', arguments: {} }))
    const driverToolNames = JSON.parse(seenByDriver.json.result.content[0].text)
    assert.ok(!driverToolNames.includes('web_eval'), `driver should not have seen web_eval, saw ${JSON.stringify(driverToolNames)}`)
  } finally { s.close(); m.dispose() }
})

test('tools/call for a normal cua tool still forwards to the driver (pass-through intact)', async () => {
  const m = mgr()
  const { router, evalCalls } = fakeRouter()
  const s = await startCuaServer({ manager: m, getPolicy: () => ON, port: 0, router })
  try {
    const call = await post(s.port, rpc('tools/call', { name: 'anything', arguments: { x: 1 } }))
    assert.equal(call.json.result.content[0].text, 'called anything')
    assert.deepEqual(call.json.result.structuredContent, { ok: true })
    assert.deepEqual(evalCalls, []) // router untouched
  } finally { s.close(); m.dispose() }
})

test('kill switch also blocks router tools', async () => {
  const m = mgr()
  const { router, evalCalls } = fakeRouter(() => OFF)
  const s = await startCuaServer({ manager: m, getPolicy: () => OFF, port: 0, router })
  try {
    const call = await post(s.port, rpc('tools/call', { name: 'web_eval', arguments: { app: 'Notion', js: '1+1' } }))
    assert.equal(call.json.result.isError, true)
    assert.match(call.json.result.content[0].text, /turned OFF/)
    assert.deepEqual(evalCalls, []) // router never invoked
  } finally { s.close(); m.dispose() }
})
