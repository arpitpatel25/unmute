// ax-mcp HTTP protocol test — boots the real server on an ephemeral port with
// a fake bridge and speaks MCP JSON-RPC over HTTP, the way Claude Code does.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startAxServer, AX_MCP_PATH } from './server'
import type { AxBridge, AxMethod } from './ax-bridge'
import type { AxPolicy } from './policy'

const ON: AxPolicy = { enabled: true, screenshotEnabled: true, allowAll: true, allowed: [] }

function fakeBridge(): AxBridge {
  return {
    async call(m: AxMethod) {
      if (m === 'listApps') return [{ name: 'Notion', bundleId: 'notion.id', pid: 1, windowsHere: 1, windowsAnywhere: 1 }]
      if (m === 'find') return { app: 'Notion', nodes: [{ id: 5, role: 'AXButton', label: 'Close Sidebar', actions: ['AXPress'] }], total: 40 }
      if (m === 'press') return { ok: true, role: 'AXButton', label: 'Close Sidebar' }
      return {}
    },
    async trusted() { return true },
    dispose() {},
  }
}

async function rpc(port: number, method: string, params?: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}${AX_MCP_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  return res.json() as Promise<any>
}

test('MCP handshake + tools/list + tools/call over HTTP', async () => {
  const server = await startAxServer({ getPolicy: () => ON, bridge: fakeBridge(), port: 0 })
  const port = server.port
  try {
    const init = await rpc(port, 'initialize', { protocolVersion: '2025-06-18' })
    assert.equal(init.result.serverInfo.name, 'ax-mcp')

    const list = await rpc(port, 'tools/list')
    const names = list.result.tools.map((t: any) => t.name)
    assert.deepEqual(names.sort(), ['capture_window', 'find', 'fill_form', 'get_tree', 'list_apps', 'menu_action', 'press', 'set_value', 'type_text'].sort())
    // The steer lives in the descriptions: find is the primary verb, nothing fronts the app.
    const find = list.result.tools.find((t: any) => t.name === 'find')
    assert.match(find.description, /PREFER THIS/)
    assert.doesNotMatch(JSON.stringify(names), /activate_app/) // deliberately absent

    const call = await rpc(port, 'tools/call', { name: 'find', arguments: { app: 'Notion', role: 'AXButton' } })
    assert.match(call.result.content[0].text, /Close Sidebar/)
    assert.equal(call.result.isError ?? false, false)
  } finally {
    server.close()
  }
})

test('unknown method returns a JSON-RPC error', async () => {
  const server = await startAxServer({ getPolicy: () => ON, bridge: fakeBridge(), port: 0 })
  try {
    const r = await rpc(server.port, 'does/not/exist')
    assert.equal(r.error.code, -32601)
  } finally {
    server.close()
  }
})
