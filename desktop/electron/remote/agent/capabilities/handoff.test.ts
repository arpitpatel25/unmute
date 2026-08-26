import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HandoffCapability, type HandoffAdapters } from './handoff.ts'
import type { CapabilityCallContext, McpPrincipal, ToolResult } from '../types.ts'

const NOW = 10_000
const agent: McpPrincipal = {
  kind: 'unmute-agent', runId: 'run-1', interactionId: 'ix-1', expiresAt: 20_000, provider: 'codex',
}
const ctx: CapabilityCallContext = {
  principal: agent, now: NOW, interaction: { id: 'ix-1', active: true, transcript: 'send it to Rishi' },
}
function parse(r: ToolResult): any { return JSON.parse(String(r.content[0]!.text)) }

function adapters(overrides: Partial<HandoffAdapters> = {}): HandoffAdapters & { created: any[] } {
  const created: any[] = []
  return {
    created,
    async createTask(input) { created.push(input); return { taskId: 'task-9' } },
    async taskStatus(taskId) { return taskId === 'task-9' ? { state: 'running', intent: 'send it' } : null },
    ...overrides,
  } as HandoffAdapters & { created: any[] }
}

test('outside work becomes a task, and the run that caused it is recorded', async () => {
  const a = adapters()
  const result = await new HandoffCapability(a).call(ctx, 'task_create', {
    intent: 'send the resume to Rishi', kind: 'oneoff',
  })
  assert.deepEqual(parse(result), { ok: true, result: { taskId: 'task-9', status: 'created' } })
  assert.equal(a.created[0].intent, 'send the resume to Rishi')
  assert.equal(a.created[0].agentRunId, 'run-1', 'Law IV: the card must be able to show who made it')
  assert.equal(a.created[0].kind, 'oneoff')
  assert.equal(a.created[0].provider, 'codex', 'omitted provider inherits the Agent provider')
})

test('an explicit provider overrides the Agent provider', async () => {
  const a = adapters()
  await new HandoffCapability(a).call(ctx, 'task_create', {
    intent: 'continue this in Claude', kind: 'session', provider: 'claude',
  })
  assert.equal(a.created[0].kind, 'session')
  assert.equal(a.created[0].provider, 'claude')
})

// Consolidation is task_create with sources, not its own verb — the output of
// consolidating several sessions is a new working session, an Orchestrator
// object.
/**
 * sourceSessionIds used to live here. It pasted bare uuids into the prompt —
 * `Start from these earlier sessions: <uuid>, <uuid>` — and hoped the new
 * session went looking for them, with no path and no way to know where. The
 * Agent reads what it needs and writes the account itself now.
 */
test('carried context reaches the new session as content, not identifiers', async () => {
  const calls: any[] = []
  const cap = new HandoffCapability({
    createTask: async (input) => { calls.push(input); return { taskId: 'task-1' } },
    taskStatus: async () => null,
  })
  const result = await cap.call(ctx, 'task_create', {
    intent: 'carry on with the marketing work',
    kind: 'session',
    provider: 'codex',
    context: 'Three earlier sessions covered ad copy, the landing page and competitor pricing.',
  })
  assert.equal(parse(result).ok, true)
  assert.equal(calls[0].context, 'Three earlier sessions covered ad copy, the landing page and competitor pricing.')
  assert.equal(calls[0].intent, 'carry on with the marketing work', 'the request itself stays unembellished')
})

test('context is optional, and an oversized one is refused', async () => {
  const calls: any[] = []
  const cap = new HandoffCapability({
    createTask: async (input) => { calls.push(input); return { taskId: 't' } },
    taskStatus: async () => null,
  })
  await cap.call(ctx, 'task_create', { intent: 'send it', kind: 'oneoff', provider: 'claude' })
  assert.equal(calls[0].context, undefined)

  const huge = await cap.call(ctx, 'task_create', {
    intent: 'send it', kind: 'oneoff', provider: 'claude', context: 'x'.repeat(24_001),
  })
  assert.equal(parse(huge).ok, false)
  assert.equal(calls.length, 1, 'nothing oversized reached the Orchestrator')
})

test('an empty or oversized intent never reaches the Orchestrator', async () => {
  const a = adapters()
  for (const bad of [
    {},
    { intent: '   ', kind: 'oneoff' },
    { intent: 'x'.repeat(2_001), kind: 'oneoff' },
    { intent: 'ok' },
    { intent: 'ok', kind: 'other' },
    { intent: 'ok', kind: 'oneoff', provider: 'other' },
    { intent: 'ok', kind: 'oneoff', context: 42 },
    { intent: 'ok', kind: 'oneoff', context: 'x'.repeat(24_001) },
  ]) {
    assert.equal((await new HandoffCapability(a).call(ctx, 'task_create', bad)).isError, true)
  }
  assert.deepEqual(a.created, [])
})

// A background run has no live interaction by definition, so it cannot create
// tasks in the user's name. The rule needs no special case — it is the same
// boundary every other capability uses.
test('without a live interaction nothing can be created', async () => {
  const a = adapters()
  const stale: CapabilityCallContext = { principal: agent, now: NOW, interaction: { id: 'ix-1', active: false } }
  assert.equal((await new HandoffCapability(a).call(stale, 'task_create', { intent: 'x', kind: 'oneoff' })).isError, true)
  assert.deepEqual(a.created, [])
})

test('status is readable and a missing task says so', async () => {
  const cap = new HandoffCapability(adapters())
  assert.deepEqual(parse(await cap.call(ctx, 'task_status', { taskId: 'task-9' })).result,
    { state: 'running', intent: 'send it' })
  assert.equal((await cap.call(ctx, 'task_status', { taskId: 'nope' })).isError, true)
})

test('a failure to create is reported without leaking why', async () => {
  const a = adapters({ async createTask() { throw new Error('/private/path/exploded') } })
  const result = await new HandoffCapability(a).call(ctx, 'task_create', { intent: 'x', kind: 'oneoff' })
  assert.equal(parse(result).error.code, 'handoff-failed')
  assert.equal(String(result.content[0]!.text).includes('/private'), false)
})
