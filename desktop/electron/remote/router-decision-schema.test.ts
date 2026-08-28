import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decisionSchema, routeDecisionTool, compactDecision, ROUTE_TOOL_NAME } from './router-decision-schema.ts'

/** OpenAI strict mode, which Codex's --output-schema runs, rejects a schema
 *  whose `required` omits any key in `properties`. This is the rule that cost a
 *  400 to discover, so it is pinned at every level including nested objects. */
function assertStrict(s: Record<string, unknown>, path = 'root'): void {
  if (s.type === 'object' || (Array.isArray(s.type) && s.type.includes('object'))) {
    const props = (s.properties ?? {}) as Record<string, unknown>
    const req = (s.required ?? []) as string[]
    assert.equal(s.additionalProperties, false, `${path}: additionalProperties must be false`)
    for (const k of Object.keys(props)) {
      assert.ok(req.includes(k), `${path}: "${k}" is in properties but missing from required`)
      assertStrict(props[k] as Record<string, unknown>, `${path}.${k}`)
    }
  }
  if (s.items) assertStrict(s.items as Record<string, unknown>, `${path}[]`)
}

test('every key is required — the rule Codex strict mode enforces', () => {
  assertStrict(decisionSchema({ ops: true, skills: true, agents: ['claude', 'codex-desktop'], codexProjects: ['p'] }))
  assertStrict(decisionSchema())
})

test('optional fields are expressed as nullable, never as omitted', () => {
  const s = decisionSchema() as { properties: Record<string, { type: unknown }> }
  assert.deepEqual(s.properties.group.type, ['string', 'null'])
  assert.deepEqual(s.properties.name.type, ['string', 'null'])
  // The two that are genuinely always present stay plain strings.
  assert.equal(s.properties.action.type, 'string')
  assert.equal(s.properties.intent.type, 'string')
})

test('the field names are the EXISTING contract — parseDecision is unchanged', () => {
  const s = decisionSchema({ ops: true }) as { properties: Record<string, unknown> }
  for (const k of ['action', 'intent', 'targetTaskId', 'name', 'group', 'kind', 'mode', 'surface', 'dir', 'alternate', 'contextTaskId', 'ops']) {
    assert.ok(k in s.properties, `missing contract key "${k}"`)
  }
  // The keys the model kept inventing must NOT be offered.
  assert.ok(!('title' in s.properties))
  assert.ok(!('task' in s.properties))
})

test('curate and skill_feedback appear only when that surface is offered', () => {
  const bare = decisionSchema() as { properties: { action: { enum: string[] } } }
  assert.ok(!bare.properties.action.enum.includes('curate'))
  assert.ok(!bare.properties.action.enum.includes('skill_feedback'))
  const full = decisionSchema({ ops: true, skills: true }) as { properties: { action: { enum: string[] } } }
  assert.ok(full.properties.action.enum.includes('curate'))
  assert.ok(full.properties.action.enum.includes('skill_feedback'))
})

test('agent is offered only when there is a real choice', () => {
  const one = decisionSchema({ agents: ['claude'] }) as { properties: Record<string, unknown> }
  assert.ok(!('agent' in one.properties))
  const two = decisionSchema({ agents: ['claude', 'codex-desktop'] }) as { properties: Record<string, unknown> }
  assert.ok('agent' in two.properties)
})

test('the MCP tool carries the same schema', () => {
  const t = routeDecisionTool({ ops: true })
  assert.equal(t.name, ROUTE_TOOL_NAME)
  assert.deepEqual(t.inputSchema, decisionSchema({ ops: true }))
})

test('compactDecision drops the nulls strict mode forced the model to send', () => {
  const raw = compactDecision({
    action: 'new', intent: 'plan reddit marketing', name: 'Reddit marketing plan',
    group: 'unmute marketing', kind: 'session',
    targetTaskId: null, dir: null, surface: null, alternate: null, contextTaskId: null, ops: [],
  })
  assert.equal(raw, JSON.stringify({
    action: 'new', intent: 'plan reddit marketing', name: 'Reddit marketing plan',
    group: 'unmute marketing', kind: 'session',
  }))
})

test('compactDecision survives junk rather than throwing into the router', () => {
  assert.equal(compactDecision(null), '')
  assert.equal(compactDecision('nope'), '')
  assert.equal(compactDecision({}), '{}')
})
