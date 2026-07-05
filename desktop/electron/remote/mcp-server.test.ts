import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startMcpServer, type McpHandlers, type McpServer } from './mcp-server.ts'

const PORT = 43991
let seq = 0

function handlers(overrides: Partial<McpHandlers> = {}): McpHandlers {
  return {
    resolveCaller: (token) => (token === 'good-token' ? 'task-parent' : null),
    createTask: async (caller, input) => ({ task_id: `child-of-${caller}`, name: input.name }),
    taskStatus: async (caller, taskId) => ({ task_id: taskId, state: 'done', requested_by: caller }),
    ...overrides,
  }
}

async function rpc(port: number, method: string, params?: unknown, token?: string): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method, params }),
  })
  return res.json()
}

async function withServer(h: McpHandlers, fn: (port: number) => Promise<void>): Promise<void> {
  const port = PORT + Math.floor(Math.random() * 500)
  const server: McpServer = await startMcpServer(h, port)
  try { await fn(port) } finally { server.close() }
}

test('mcp: initialize handshake + tools/list expose exactly the two-tool surface', async () => {
  await withServer(handlers(), async (port) => {
    const init = await rpc(port, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} })
    assert.equal(init.result.serverInfo.name, 'unmute')
    assert.ok(init.result.capabilities.tools)
    const list = await rpc(port, 'tools/list')
    const names = list.result.tools.map((t: { name: string }) => t.name).sort()
    // THE SURFACE: sessions may ADD work, never TOUCH it. Two tools, no more.
    assert.deepEqual(names, ['unmute_create_task', 'unmute_task_status'])
  })
})

test('mcp: tool calls without a valid task identity are rejected with an instructive error', async () => {
  await withServer(handlers(), async (port) => {
    const res = await rpc(port, 'tools/call', { name: 'unmute_create_task', arguments: { intent: 'x' } }, 'bogus')
    assert.equal(res.result.isError, true)
    assert.match(res.result.content[0].text, /no valid task identity/)
    // ...but the handshake itself needs no identity (server must be listable).
    const list = await rpc(port, 'tools/list')
    assert.equal(list.result.tools.length, 2)
  })
})

test('mcp: identified caller creates a task and reads its child status', async () => {
  await withServer(handlers(), async (port) => {
    const created = await rpc(port, 'tools/call', { name: 'unmute_create_task', arguments: { intent: 'do a thing', name: 'Thing' } }, 'good-token')
    assert.notEqual(created.result.isError, true)
    const payload = JSON.parse(created.result.content[0].text)
    assert.equal(payload.task_id, 'child-of-task-parent')
    const status = await rpc(port, 'tools/call', { name: 'unmute_task_status', arguments: { task_id: payload.task_id } }, 'good-token')
    const st = JSON.parse(status.result.content[0].text)
    assert.equal(st.state, 'done')
    assert.equal(st.requested_by, 'task-parent')
  })
})

test('mcp: handler rejections (depth/rate/disabled) surface as instructive tool errors, not crashes', async () => {
  await withServer(handlers({
    createTask: async () => { throw new Error('depth limit: agent-created tasks cannot themselves create tasks — ask the user to dispatch it') },
  }), async (port) => {
    const res = await rpc(port, 'tools/call', { name: 'unmute_create_task', arguments: { intent: 'x' } }, 'good-token')
    assert.equal(res.result.isError, true)
    assert.match(res.result.content[0].text, /depth limit/)
  })
})

test('mcp: missing required args and unknown tools are rejected cleanly', async () => {
  await withServer(handlers(), async (port) => {
    const noIntent = await rpc(port, 'tools/call', { name: 'unmute_create_task', arguments: {} }, 'good-token')
    assert.equal(noIntent.result.isError, true)
    assert.match(noIntent.result.content[0].text, /intent/)
    const unknown = await rpc(port, 'tools/call', { name: 'unmute_kill_task', arguments: {} }, 'good-token')
    assert.equal(unknown.error.code, -32602)
    const badMethod = await rpc(port, 'nonsense/method')
    assert.equal(badMethod.error.code, -32601)
  })
})

test('mcp: notifications get 202 with no body; GET is refused (no SSE)', async () => {
  await withServer(handlers(), async (port) => {
    const note = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    })
    assert.equal(note.status, 202)
    const get = await fetch(`http://127.0.0.1:${port}/mcp`)
    assert.equal(get.status, 405)
  })
})
