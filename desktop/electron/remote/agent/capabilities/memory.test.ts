import assert from 'node:assert/strict'
import test from 'node:test'

import { MemoryCapability, type MemoryCapabilityService } from './memory.ts'
import { CapabilityRegistry } from './registry.ts'
import type { CapabilityCallContext, McpPrincipal, ToolResult } from '../types.ts'
import { MemoryServiceError } from '../memory/service.ts'
import type { MemoryRecord } from '../memory/types.ts'

const NOW = 10_000
const agent: McpPrincipal = {
  kind: 'unmute-agent', runId: 'run-1', interactionId: 'ix-1', expiresAt: 20_000,
}
const interaction = {
  id: 'ix-1', active: true,
  intents: ['memory.store', 'memory.update', 'memory.forget', 'memory.restore', 'memory.reveal-sensitive'],
} as const
const context: CapabilityCallContext = { principal: agent, now: NOW, interaction }

function record(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: 'memory-1', kind: 'note', title: 'Primary email', content: 'user@example.com',
    tags: ['personal'], scope: { purpose: 'contact' }, sensitivity: 'normal',
    attachments: ['attachment-1'], references: [{ type: 'url', value: 'https://example.com' }],
    provenance: { source: 'voice' }, createdAt: 1, updatedAt: 2, version: 1,
    ...overrides,
  }
}

class FakeMemoryService implements MemoryCapabilityService {
  readonly calls: Array<{ operation: string; ctx: CapabilityCallContext; args: unknown[] }> = []
  failure?: unknown
  searchResult: Awaited<ReturnType<MemoryCapabilityService['search']>> = [{
    id: 'memory-1', title: 'Primary email', kind: 'note', snippet: '"user@example.com"',
    score: 1000, sensitivity: 'normal', attachmentCount: 1, scopes: ['contact'],
  }]
  getResult: Awaited<ReturnType<MemoryCapabilityService['get']>> = {
    id: 'memory-1', kind: 'note', title: 'Primary email', tags: ['personal'],
    scope: { purpose: 'contact' }, sensitivity: 'normal', references: [],
    provenance: { source: 'voice' }, createdAt: 1, updatedAt: 2, version: 1,
  }
  storeResult = record()
  updateResult = record({ version: 2 })
  openResult: Awaited<ReturnType<MemoryCapabilityService['openAttachment']>> = {
    handle: 'opaque-delivery-handle', expiresAt: 15_000,
  }

  private called(operation: string, ctx: CapabilityCallContext, ...args: unknown[]): void {
    this.calls.push({ operation, ctx, args })
    if (this.failure !== undefined) throw this.failure
  }

  async search(ctx: CapabilityCallContext, query: Parameters<MemoryCapabilityService['search']>[1]) {
    this.called('search', ctx, query)
    return this.searchResult
  }

  async get(
    ctx: CapabilityCallContext,
    id: string,
    options: Parameters<MemoryCapabilityService['get']>[2],
  ) {
    this.called('get', ctx, id, options)
    return this.getResult
  }

  async store(ctx: CapabilityCallContext, input: Parameters<MemoryCapabilityService['store']>[1]) {
    this.called('store', ctx, input)
    return this.storeResult
  }

  async update(
    ctx: CapabilityCallContext,
    id: string,
    patch: Parameters<MemoryCapabilityService['update']>[2],
  ) {
    this.called('update', ctx, id, patch)
    return this.updateResult
  }

  async forget(ctx: CapabilityCallContext, id: string) {
    this.called('forget', ctx, id)
  }

  async restore(ctx: CapabilityCallContext, id: string) {
    this.called('restore', ctx, id)
  }

  async openAttachment(ctx: CapabilityCallContext, id: string) {
    this.called('openAttachment', ctx, id)
    return this.openResult
  }
}

function parse(result: ToolResult): unknown {
  assert.equal(result.content.length, 1)
  assert.equal(result.content[0].type, 'text')
  assert.equal(typeof result.content[0].text, 'string')
  return JSON.parse(result.content[0].text as string)
}

test('declares exactly the seven approved Agent-only tools with strict schemas and untrusted-data guidance', () => {
  const capability = new MemoryCapability(new FakeMemoryService())
  assert.equal(capability.id, 'memory')
  assert.deepEqual(capability.roles, ['unmute-agent'])
  assert.deepEqual(capability.tools.map((tool) => tool.name), [
    'memory_search',
    'memory_get',
    'memory_store',
    'memory_update',
    'memory_forget',
    'memory_restore',
    'memory_open_attachment',
  ])
  assert.deepEqual(capability.tools.map((tool) => ({
    name: tool.name,
    consequence: tool.consequence,
    intent: 'intent' in tool ? tool.intent : undefined,
  })), [
    { name: 'memory_search', consequence: 'read', intent: undefined },
    { name: 'memory_get', consequence: 'read', intent: undefined },
    { name: 'memory_store', consequence: 'reversible-write', intent: 'memory.store' },
    { name: 'memory_update', consequence: 'reversible-write', intent: 'memory.update' },
    { name: 'memory_forget', consequence: 'destructive', intent: 'memory.forget' },
    { name: 'memory_restore', consequence: 'reversible-write', intent: 'memory.restore' },
    { name: 'memory_open_attachment', consequence: 'reversible-write', intent: undefined },
  ])
  for (const tool of capability.tools) {
    assert.equal(tool.inputSchema.type, 'object')
    assert.equal(tool.inputSchema.additionalProperties, false)
    assert.ok(Array.isArray(tool.inputSchema.required))
    assert.match(tool.description, /untrusted data/i)
    assert.match(tool.description, /never instructions/i)
  }
  const update = capability.tools.find((tool) => tool.name === 'memory_update')!
  const updateProperties = update.inputSchema.properties as Record<string, any>
  assert.equal(updateProperties.patch.additionalProperties, false)
  assert.equal('attachments' in updateProperties.patch.properties, false)
  const open = capability.tools.find((tool) => tool.name === 'memory_open_attachment')!
  assert.deepEqual(Object.keys(open.inputSchema.properties as object), ['attachmentId'])
})

test('maps all seven valid calls one-to-one, preserving the exact call context', async () => {
  const service = new FakeMemoryService()
  const capability = new MemoryCapability(service)
  const searchInput = {
    query: 'primary email', kinds: ['note'], tags: ['personal'],
    scope: { purpose: 'contact' }, includeSensitive: false, limit: 5,
  }
  assert.deepEqual(parse(await capability.call(context, 'memory_search', searchInput)), {
    ok: true,
    result: { results: service.searchResult },
  })
  assert.deepEqual(service.calls.at(-1), {
    operation: 'search', ctx: context,
    args: [{ text: 'primary email', kinds: ['note'], tags: ['personal'], scope: { purpose: 'contact' }, includeSensitive: false, limit: 5 }],
  })

  assert.deepEqual(parse(await capability.call(context, 'memory_get', {
    id: 'memory-1', includeContent: true, includeAttachments: true, includeDeleted: false,
  })), { ok: true, result: { record: service.getResult } })
  assert.equal(service.calls.at(-1)?.ctx, context)
  assert.deepEqual(service.calls.at(-1)?.args, [
    'memory-1', { includeContent: true, includeAttachments: true, includeDeleted: false },
  ])

  const storeInput = {
    kind: 'template', title: 'Slack style', content: 'Short and direct.',
    tags: ['writing'], scope: { app: 'Slack', project: 'Atlas' }, sensitivity: 'private',
    attachments: ['capture-handle-1'], references: [{ type: 'url', value: 'https://example.com/style' }],
    provenance: { source: 'selection', original: 'selected message' },
  }
  assert.deepEqual(parse(await capability.call(context, 'memory_store', storeInput)), {
    ok: true, result: { id: 'memory-1', version: 1 },
  })
  assert.deepEqual(service.calls.at(-1)?.args, [storeInput])

  const patch = {
    kind: 'guidance', title: 'Updated style', content: null, tags: ['slack'],
    scope: null, sensitivity: 'normal', references: [{ type: 'external', value: 'crm-1' }],
    provenance: { source: 'import' },
  }
  assert.deepEqual(parse(await capability.call(context, 'memory_update', { id: 'memory-1', patch })), {
    ok: true, result: { id: 'memory-1', version: 2 },
  })
  assert.deepEqual(service.calls.at(-1)?.args, ['memory-1', patch])

  assert.deepEqual(parse(await capability.call(context, 'memory_forget', { id: 'memory-1' })), {
    ok: true, result: { id: 'memory-1', status: 'forgotten' },
  })
  assert.deepEqual(parse(await capability.call(context, 'memory_restore', { id: 'memory-1' })), {
    ok: true, result: { id: 'memory-1', status: 'restored' },
  })
  assert.deepEqual(parse(await capability.call(context, 'memory_open_attachment', { attachmentId: 'attachment-1' })), {
    ok: true, result: { handle: 'opaque-delivery-handle', expiresAt: 15_000 },
  })
  assert.deepEqual(service.calls.map((call) => call.operation), [
    'search', 'get', 'store', 'update', 'forget', 'restore', 'openAttachment',
  ])
  assert.equal(service.calls.every((call) => call.ctx === context), true)
})

test('applies documented store defaults without weakening the canonical service input', async () => {
  const service = new FakeMemoryService()
  const capability = new MemoryCapability(service)
  await capability.call(context, 'memory_store', { title: 'Remember this' })
  assert.deepEqual(service.calls[0].args, [{
    kind: 'note', title: 'Remember this', tags: [], sensitivity: 'normal',
    attachments: [], references: [], provenance: { source: 'voice' },
  }])
})

test('runtime validation matches strict schema boundaries and never calls the service for invalid input', async () => {
  const service = new FakeMemoryService()
  const capability = new MemoryCapability(service)
  const invalid: Array<[string, unknown]> = [
    ['memory_search', null],
    ['memory_search', []],
    ['memory_search', {}],
    ['memory_search', { query: 'x', extra: true }],
    ['memory_search', { query: '   ' }],
    ['memory_search', { query: 'x', kinds: ['file'] }],
    ['memory_search', { query: 'x', tags: [''] }],
    ['memory_search', { query: 'x', scope: { project: '' } }],
    ['memory_search', { query: 'x', scope: { destination: '/tmp/out' } }],
    ['memory_search', { query: 'x', limit: 0 }],
    ['memory_search', { query: 'x', limit: 101 }],
    ['memory_search', { query: 'x', includeSensitive: 'yes' }],
    ['memory_get', { id: 'memory-1', includeContent: 'yes' }],
    ['memory_get', { id: '/private/memory.enc' }],
    ['memory_get', { id: 'memory-1', path: '/private/memory.enc' }],
    ['memory_store', {}],
    ['memory_store', { title: 'x', kind: 'file' }],
    ['memory_store', { title: 'x', sensitivity: 'secret' }],
    ['memory_store', { title: 'x', attachments: ['/private/file.pdf'] }],
    ['memory_store', { title: 'x', references: [{ type: 'url' }] }],
    ['memory_store', { title: 'x', references: [{ type: 'arbitrary', value: 'x' }] }],
    ['memory_store', { title: 'x', provenance: { source: 'filesystem', original: '/private/x' } }],
    ['memory_store', { title: 'x', provenance: { source: 'voice', path: '/private/x' } }],
    ['memory_store', { title: 'x', destination: 'clipboard' }],
    ['memory_store', { title: 'x', path: '/private/x' }],
    ['memory_update', { id: 'memory-1', patch: {} }],
    ['memory_update', { id: 'memory-1', patch: { attachments: ['attachment-2'] } }],
    ['memory_update', { id: 'memory-1', patch: { scope: { unknown: 'x' } } }],
    ['memory_update', { id: 'memory-1', patch: { references: [{}] } }],
    ['memory_update', { id: 'memory-1', patch: { provenance: [] } }],
    ['memory_forget', {}],
    ['memory_restore', { id: '' }],
    ['memory_open_attachment', { attachmentId: 'attachment-1', destination: 'clipboard' }],
    ['memory_open_attachment', { path: '/private/file.pdf' }],
  ]
  for (const [tool, input] of invalid) {
    const output = await capability.call(context, tool, input)
    assert.equal(output.isError, true, `${tool}: ${JSON.stringify(input)}`)
    assert.deepEqual(parse(output), {
      ok: false,
      error: { code: 'invalid-input', message: 'Memory tool input is invalid' },
    })
  }
  assert.equal(service.calls.length, 0)
})

test('registry rejects ordinary tasks, expired principals, inactive interactions, and wrong interaction IDs before service dispatch', async () => {
  const service = new FakeMemoryService()
  const registry = new CapabilityRegistry([new MemoryCapability(service)])
  const task: McpPrincipal = { kind: 'task', taskId: 'task-1' }
  await assert.rejects(registry.call(task, 'memory_search', { query: 'x' }), /not available to task principals/)

  const expired: McpPrincipal = { ...agent, expiresAt: NOW }
  await assert.rejects(
    registry.call(expired, 'memory_store', { title: 'x' }, { now: NOW, interaction }),
    /active explicit interaction/,
  )
  await assert.rejects(
    registry.call(agent, 'memory_store', { title: 'x' }, { now: NOW }),
    /active explicit interaction/,
  )
  await assert.rejects(
    registry.call(agent, 'memory_update', { id: 'memory-1', patch: { title: 'x' } }, {
      now: NOW, interaction: { ...interaction, id: 'ix-other' },
    }),
    /active explicit interaction/,
  )
  assert.equal(service.calls.length, 0)
})

test('forget requires exact destructive intent and does not dispatch on absent or mismatched intent', async () => {
  const service = new FakeMemoryService()
  const registry = new CapabilityRegistry([new MemoryCapability(service)])
  for (const intents of [undefined, ['memory.store'], ['memory.forget-something-else']]) {
    await assert.rejects(
      registry.call(agent, 'memory_forget', { id: 'memory-1' }, {
        now: NOW, interaction: { id: 'ix-1', active: true, ...(intents ? { intents } : {}) },
      }),
      /explicit matching intent flag/,
    )
  }
  assert.equal(service.calls.length, 0)
})

test('ordinary reads do not require reveal intent while sensitive requests remain service-authorized', async () => {
  const service = new FakeMemoryService()
  const capability = new MemoryCapability(service)
  const ordinary: CapabilityCallContext = {
    principal: agent, now: NOW, interaction: { id: 'ix-1', active: true },
  }
  assert.equal((await capability.call(ordinary, 'memory_search', { query: 'email' })).isError, undefined)
  assert.equal((await capability.call(ordinary, 'memory_get', { id: 'memory-1', includeContent: true })).isError, undefined)

  service.failure = new MemoryServiceError('intent-required', 'Memory operation requires explicit user intent')
  const sensitiveSearch = await capability.call(ordinary, 'memory_search', { query: 'passport', includeSensitive: true })
  assert.equal(sensitiveSearch.isError, true)
  assert.deepEqual(parse(sensitiveSearch), {
    ok: false,
    error: { code: 'intent-required', message: 'Memory operation requires explicit user intent' },
  })
  assert.equal(service.calls.at(-1)?.operation, 'search')
})

test('absent or mismatched store, update, and restore intents fail through the service authorization boundary', async () => {
  const service = new FakeMemoryService()
  service.failure = new MemoryServiceError('intent-required', 'dependency details must not escape')
  const capability = new MemoryCapability(service)
  const calls: Array<[string, unknown]> = [
    ['memory_store', { title: 'x' }],
    ['memory_update', { id: 'memory-1', patch: { title: 'x' } }],
    ['memory_restore', { id: 'memory-1' }],
  ]
  for (const intents of [undefined, ['memory.wrong']]) {
    for (const [tool, input] of calls) {
      const output = await capability.call({
        principal: agent,
        now: NOW,
        interaction: { id: 'ix-1', active: true, ...(intents ? { intents } : {}) },
      }, tool, input)
      assert.equal(output.isError, true)
      assert.deepEqual(parse(output), {
        ok: false,
        error: { code: 'intent-required', message: 'Memory operation requires explicit user intent' },
      })
    }
  }
  assert.deepEqual(service.calls.map((call) => call.operation), [
    'store', 'update', 'restore', 'store', 'update', 'restore',
  ])
})

test('stale or wrong-principal direct calls fail closed without reaching the service', async () => {
  const service = new FakeMemoryService()
  const capability = new MemoryCapability(service)
  const stale = await capability.call({ ...context, principal: { ...agent, expiresAt: NOW } }, 'memory_search', { query: 'x' })
  const wrong = await capability.call({ ...context, principal: { kind: 'task', taskId: 'task-1' } }, 'memory_search', { query: 'x' })
  for (const output of [stale, wrong]) {
    assert.equal(output.isError, true)
    assert.deepEqual(parse(output), {
      ok: false,
      error: { code: 'access-denied', message: 'Memory access is unavailable' },
    })
  }
  assert.equal(service.calls.length, 0)
})

test('projects path-free approved result shapes and returns only an opaque attachment delivery handle', async () => {
  const service = new FakeMemoryService()
  service.getResult = {
    ...service.getResult,
    content: 'approved content',
    attachments: ['attachment-1'],
    references: [
      { type: 'path', value: '/Users/alice/.unmute/memory/records/memory-1.enc' },
      { type: 'url', value: 'https://example.com' },
    ],
    provenance: { source: 'voice' },
    ...({ managedPath: '/Users/alice/.unmute/memory/records/memory-1.enc' } as object),
  }
  service.storeResult = record({
    references: [{ type: 'path', value: '/Users/alice/private.txt' }],
    provenance: { source: 'selection', original: '/Users/alice/private.txt' },
  })
  service.openResult = {
    handle: 'opaque-delivery-handle', expiresAt: 15_000,
    ...({ path: '/Users/alice/.unmute/memory/attachments/blob.enc', name: 'secret.pdf' } as object),
  }
  const capability = new MemoryCapability(service)
  const getResult = await capability.call(context, 'memory_get', {
    id: 'memory-1', includeContent: true, includeAttachments: true,
  })
  assert.deepEqual(parse(getResult), {
    ok: true,
    result: {
      record: {
        id: 'memory-1', kind: 'note', title: 'Primary email', content: 'approved content',
        tags: ['personal'], scope: { purpose: 'contact' }, sensitivity: 'normal',
        attachments: ['attachment-1'], references: [{ type: 'url', value: 'https://example.com' }],
        provenance: { source: 'voice' }, createdAt: 1, updatedAt: 2, version: 1,
      },
    },
  })
  const stored = await capability.call(context, 'memory_store', { title: 'x' })
  const opened = await capability.call(context, 'memory_open_attachment', { attachmentId: 'attachment-1' })
  assert.equal(JSON.stringify(parse(stored)).includes('/Users/alice'), false)
  assert.deepEqual(parse(opened), {
    ok: true, result: { handle: 'opaque-delivery-handle', expiresAt: 15_000 },
  })
  assert.equal(JSON.stringify(parse(opened)).includes('path'), false)
  assert.equal(JSON.stringify(parse(opened)).includes('name'), false)
})

test('service failures become deterministic path-free JSON error envelopes', async () => {
  const service = new FakeMemoryService()
  const capability = new MemoryCapability(service)
  service.failure = new Error('sqlite failed at /Users/alice/.unmute/memory/index.sqlite with secret')
  const unknown = await capability.call(context, 'memory_search', { query: 'email' })
  assert.equal(unknown.isError, true)
  assert.deepEqual(parse(unknown), {
    ok: false,
    error: { code: 'operation-failed', message: 'Memory operation failed' },
  })
  assert.equal(JSON.stringify(unknown).includes('/Users/alice'), false)
  assert.equal(JSON.stringify(unknown).includes('sqlite'), false)

  service.failure = new MemoryServiceError('not-found', 'dependency said /private/record.enc')
  const known = await capability.call(context, 'memory_get', { id: 'memory-1' })
  assert.deepEqual(parse(known), {
    ok: false,
    error: { code: 'not-found', message: 'Memory record was not found' },
  })
  assert.equal(JSON.stringify(known).includes('/private'), false)
})
