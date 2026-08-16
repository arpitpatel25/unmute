import assert from 'node:assert/strict'
import test from 'node:test'

import { authorizeCapabilityCall } from './policy.ts'
import type { CapabilityCallContext, McpPrincipal, ToolDefinition } from './types.ts'

const agent: McpPrincipal = {
  kind: 'unmute-agent', runId: 'run-1', interactionId: 'ix-1', expiresAt: 2_000,
}

function context(overrides: Partial<CapabilityCallContext> = {}): CapabilityCallContext {
  return { principal: agent, now: 1_000, ...overrides }
}

function tool(consequence: ToolDefinition['consequence'], intent?: string): ToolDefinition {
  return { name: 'test_tool', description: 'test tool', inputSchema: {}, consequence, intent }
}

test('allows read capabilities without an explicit interaction', () => {
  assert.doesNotThrow(() => authorizeCapabilityCall(context(), tool('read')))
})

test('requires an active matching interaction for reversible writes', () => {
  assert.throws(() => authorizeCapabilityCall(context(), tool('reversible-write')), /active explicit interaction/)
  assert.throws(
    () => authorizeCapabilityCall(context({ interaction: { id: 'other', active: true } }), tool('reversible-write')),
    /active explicit interaction/,
  )
  assert.doesNotThrow(() => authorizeCapabilityCall(context({ interaction: { id: 'ix-1', active: true } }), tool('reversible-write')))
  assert.throws(
    () => authorizeCapabilityCall(context({ now: 2_000, interaction: { id: 'ix-1', active: true } }), tool('reversible-write')),
    /active explicit interaction/,
  )
})

test('requires a matching explicit intent for sensitive and destructive capabilities', () => {
  for (const consequence of ['sensitive-read', 'destructive'] as const) {
    assert.throws(
      () => authorizeCapabilityCall(context({ interaction: { id: 'ix-1', active: true } }), tool(consequence, 'share-memory')),
      /explicit matching intent flag/,
    )
    assert.throws(
      () => authorizeCapabilityCall(context({ interaction: { id: 'ix-1', active: true, intents: ['other'] } }), tool(consequence, 'share-memory')),
      /explicit matching intent flag/,
    )
    assert.doesNotThrow(
      () => authorizeCapabilityCall(context({ interaction: { id: 'ix-1', active: true, intents: ['share-memory'] } }), tool(consequence, 'share-memory')),
    )
  }
})
