import assert from 'node:assert/strict'
import test from 'node:test'

import { CapabilityRegistry } from './registry.ts'
import { MemoryCapability } from './memory.ts'
import type { CapabilityModule, McpPrincipal } from '../types.ts'
import type { MemoryCapabilityService } from './memory.ts'

const task: McpPrincipal = { kind: 'task', taskId: 'task-1' }
const agent: McpPrincipal = {
  kind: 'unmute-agent', runId: 'run-1', interactionId: 'ix-1', expiresAt: 2_000,
}

const tasks: CapabilityModule = {
  id: 'tasks',
  roles: ['task'],
  tools: [{ name: 'unmute_create_task', description: 'Create a task', inputSchema: {}, consequence: 'read' }],
  async call() { return { content: [{ type: 'text', text: 'created' }] } },
}

const memory: CapabilityModule = {
  id: 'memory',
  roles: ['unmute-agent'],
  tools: [{ name: 'memory_search', description: 'Search memory', inputSchema: {}, consequence: 'read' }],
  async call() { return { content: [{ type: 'text', text: 'found' }] } },
}

test('every capability attempt records correlated start and outcome without raw inputs', async () => {
  const events: Array<{ event: string; fields: any }> = []
  const registry = new CapabilityRegistry([memory], (event, fields) => events.push({ event, fields }))
  await registry.call(agent, 'memory_search', { query: 'private text', password: 'secret' }, { now: 1000 })
  await assert.rejects(registry.call(agent, 'missing_tool', { token: 'secret' }, { now: 1000 }))
  assert.equal(events.filter(e => e.event === 'agent-tool-started').length, 2)
  const ends = events.filter(e => e.event === 'agent-tool-completed')
  assert.deepEqual(ends.map(e => e.fields.outcome), ['success', 'rejected'])
  for (const end of ends) assert.ok(events.some(e => e.event === 'agent-tool-started' && e.fields.callId === end.fields.callId))
  assert.equal(ends[0].fields.interactionId, 'ix-1')
  assert.ok(!JSON.stringify(events).includes('private text'))
  assert.ok(!JSON.stringify(events).includes('secret'))
})

test('shows only tools available to each principal and rejects unavailable calls', async () => {
  const registry = new CapabilityRegistry([tasks, memory])

  assert.deepEqual(registry.tools(task).map((tool) => tool.name), ['unmute_create_task'])
  assert.deepEqual(registry.tools(agent).map((tool) => tool.name), ['memory_search'])
  await assert.rejects(registry.call(task, 'memory_search', {}), /not available to task principals/)
})

test('rejects duplicate tool ownership', () => {
  assert.throws(
    () => new CapabilityRegistry([tasks, { ...memory, tools: [{ ...memory.tools[0], name: 'unmute_create_task' }] }]),
    /duplicate tool name/i,
  )
})

test('authorizes a tool before its module handler runs', async () => {
  let called = false
  const registry = new CapabilityRegistry([{
    id: 'writes',
    roles: ['unmute-agent'],
    tools: [{ name: 'memory_save', description: 'Save memory', inputSchema: {}, consequence: 'reversible-write' }],
    async call() {
      called = true
      return { content: [] }
    },
  }])

  await assert.rejects(registry.call(agent, 'memory_save', {}), /active explicit interaction/)
  assert.equal(called, false)
})

test('the real Memory capability remains invisible to ordinary task principals', async () => {
  const service = {
    async list() { return { map: { total: 0, groups: [], groupsOmitted: 0, ungrouped: 0 } } },
    async link() { throw new Error('not used') },
    async search() { return [] }, async get() { throw new Error('not used') },
    async store() { throw new Error('not used') }, async update() { throw new Error('not used') },
    async forget() {}, async restore() {}, async openAttachment() { throw new Error('not used') },
    async keepFile() { throw new Error('not used') },
  } as MemoryCapabilityService
  const registry = new CapabilityRegistry([tasks, new MemoryCapability(service)])

  assert.deepEqual(registry.tools(task).map((tool) => tool.name), ['unmute_create_task'])
  assert.deepEqual(registry.tools(agent).map((tool) => tool.name), [
    'memory_list', 'memory_link',
    'memory_search', 'memory_get', 'memory_store', 'memory_update',
    'memory_forget', 'memory_restore', 'memory_keep_file', 'memory_open_attachment',
  ])
  await assert.rejects(registry.call(task, 'memory_get', { id: 'memory-1' }), /not available to task principals/)
})
