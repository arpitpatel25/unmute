import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startMcpServer, type McpHandlers, type McpServer } from './mcp-server.ts'
import { CapabilityRegistry } from './agent/capabilities/registry.ts'
import type { CapabilityModule, McpPrincipal } from './agent/types.ts'

const PORT = 43991
let seq = 0

function handlers(overrides: Partial<McpHandlers> = {}): McpHandlers {
  return {
    resolveCaller: (token): McpPrincipal | null => {
      if (token === 'good-token') return { kind: 'task', taskId: 'task-parent' }
      if (token === 'agent-token') {
        return { kind: 'unmute-agent', runId: 'run-1', interactionId: 'ix-1', expiresAt: Date.now() + 60_000 }
      }
      return null
    },
    createTask: async (caller, input) => ({ task_id: `child-of-${caller}`, name: input.name }),
    taskStatus: async (caller, taskId) => ({ task_id: taskId, state: 'done', requested_by: caller }),
    ...overrides,
  }
}

const agentCapability: CapabilityModule = {
  id: 'memory',
  roles: ['unmute-agent'],
  tools: [{
    name: 'memory_search',
    description: 'Search explicitly saved memory.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    consequence: 'read',
  }],
  async call(_ctx, tool, input) {
    return { content: [{ type: 'text', text: JSON.stringify({ tool, input }) }] }
  },
}

const taskExtensionCapability: CapabilityModule = {
  id: 'task-extension',
  roles: ['task'],
  tools: [{
    name: 'task_extension',
    description: 'A task-role extension that must not widen the legacy task surface.',
    inputSchema: { type: 'object', properties: {} },
    consequence: 'read',
  }],
  async call() {
    return { content: [{ type: 'text', text: 'task extension called' }] }
  },
}

const overlappingAgentCapability: CapabilityModule = {
  id: 'agent-overlap',
  roles: ['unmute-agent'],
  tools: [{
    name: 'unmute_create_task',
    description: 'Agent-owned overlapping tool.',
    inputSchema: { type: 'object', properties: {} },
    consequence: 'read',
  }],
  async call() {
    return { content: [{ type: 'text', text: 'agent-owned overlap' }] }
  },
}

async function rpc(port: number, method: string, params?: unknown, token?: string): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method, params }),
  })
  return res.json()
}

async function withServer(
  h: McpHandlers,
  fn: (port: number) => Promise<void>,
  registry = new CapabilityRegistry([agentCapability]),
): Promise<void> {
  const port = PORT + Math.floor(Math.random() * 500)
  const server: McpServer = await startMcpServer(h, port, registry)
  try { await fn(port) } finally { server.close() }
}

test('mcp: task principals retain exactly the existing task tool surface', async () => {
  await withServer(handlers(), async (port) => {
    const init = await rpc(port, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} })
    assert.equal(init.result.serverInfo.name, 'unmute')
    assert.ok(init.result.capabilities.tools)
    const list = await rpc(port, 'tools/list', undefined, 'good-token')
    const names = list.result.tools.map((t: { name: string }) => t.name).sort()
    // THE SURFACE: sessions may ADD work, never TOUCH it. Two tools, no more.
    // unmute_status is the OPTIONAL precision channel (observer.ts derives
    // state on its own). Deliberately third and deliberately described as
    // optional — the moment it reads as mandatory we have rebuilt the
    // reporting contract this design deleted, one tool call at a time.
    assert.deepEqual(names, ['unmute_create_task', 'unmute_status', 'unmute_task_status'])
    for (const tool of list.result.tools) {
      assert.deepEqual(Object.keys(tool).sort(), ['description', 'inputSchema', 'name'])
    }
  })
})

test('mcp: Agent principals list and call registered Agent tools only', async () => {
  await withServer(handlers(), async (port) => {
    const list = await rpc(port, 'tools/list', undefined, 'agent-token')
    assert.deepEqual(list.result.tools.map((tool: { name: string }) => tool.name), ['memory_search'])
    const found = await rpc(port, 'tools/call', { name: 'memory_search', arguments: { query: 'passport' } }, 'agent-token')
    assert.deepEqual(JSON.parse(found.result.content[0].text), {
      tool: 'memory_search', input: { query: 'passport' },
    })
  })
})

test('mcp: task-role extensions cannot widen task discovery or calls', async () => {
  const registry = new CapabilityRegistry([agentCapability, taskExtensionCapability])
  await withServer(handlers(), async (port) => {
    const list = await rpc(port, 'tools/list', undefined, 'good-token')
    assert.deepEqual(list.result.tools.map((tool: { name: string }) => tool.name).sort(), [
      'unmute_create_task', 'unmute_status', 'unmute_task_status',
    ])

    const call = await rpc(port, 'tools/call', { name: 'task_extension', arguments: {} }, 'good-token')
    assert.equal(call.result.isError, true)
    assert.match(call.result.content[0].text, /not available to task principals/)
  }, registry)
})

test('mcp: an Agent-visible built-in-name overlap dispatches to the Agent registry', async () => {
  const registry = new CapabilityRegistry([overlappingAgentCapability])
  await withServer(handlers(), async (port) => {
    const list = await rpc(port, 'tools/list', undefined, 'agent-token')
    assert.deepEqual(list.result.tools.map((tool: { name: string; description: string }) => ({
      name: tool.name, description: tool.description,
    })), [{ name: 'unmute_create_task', description: 'Agent-owned overlapping tool.' }])

    const call = await rpc(port, 'tools/call', { name: 'unmute_create_task', arguments: {} }, 'agent-token')
    assert.notEqual(call.result.isError, true)
    assert.equal(call.result.content[0].text, 'agent-owned overlap')
  }, registry)
})

test('mcp: Agent and task principals cannot call each other\'s tools', async () => {
  await withServer(handlers(), async (port) => {
    const agentTaskCall = await rpc(port, 'tools/call', {
      name: 'unmute_create_task', arguments: { intent: 'escape the Agent boundary' },
    }, 'agent-token')
    assert.equal(agentTaskCall.result.isError, true)
    assert.match(agentTaskCall.result.content[0].text, /not available to unmute-agent principals/)

    const taskAgentCall = await rpc(port, 'tools/call', {
      name: 'memory_search', arguments: { query: 'private memory' },
    }, 'good-token')
    assert.equal(taskAgentCall.result.isError, true)
    assert.match(taskAgentCall.result.content[0].text, /not available to task principals/)
  })
})

test('mcp: expired and unidentified callers can initialize but see no tools and cannot call', async () => {
  await withServer(handlers(), async (port) => {
    for (const token of [undefined, 'expired-token']) {
      const init = await rpc(port, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} }, token)
      assert.equal(init.result.serverInfo.name, 'unmute')
      const list = await rpc(port, 'tools/list', undefined, token)
      assert.deepEqual(list.result.tools, [])
      const res = await rpc(port, 'tools/call', { name: 'unmute_create_task', arguments: { intent: 'x' } }, token)
      assert.equal(res.result.isError, true)
      assert.match(res.result.content[0].text, /no valid task identity/)
    }
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

test('mcp: lifecycle hook authentication stays on its separate lane', async () => {
  const resolvedTokens: Array<string | null> = []
  const hookCalls: Array<{ token: string | null; payload: unknown }> = []
  await withServer(handlers({
    resolveCaller: (token) => { resolvedTokens.push(token); return null },
    hookEvent: (token, payload) => { hookCalls.push({ token, payload }) },
  }), async (port) => {
    const response = await fetch(`http://127.0.0.1:${port}/hook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer hook-token' },
      body: JSON.stringify({ session_id: 'session-1', hook_event_name: 'Stop' }),
    })
    assert.equal(response.status, 200)
    assert.deepEqual(hookCalls, [{
      token: 'hook-token', payload: { session_id: 'session-1', hook_event_name: 'Stop' },
    }])
    assert.deepEqual(resolvedTokens, [])
  })
})
