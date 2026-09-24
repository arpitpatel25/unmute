import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildHandoffPrompt, HandoffCapability, type HandoffAdapters } from './handoff.ts'
import type { CapabilityCallContext, McpPrincipal, ToolResult } from '../types.ts'
import { clearIndexFindings, noteIndexFindings } from '../retrieval-ledger.ts'

const NOW = 10_000
test('handoff requires descriptive title and workspace before creating a task', async () => {
  for (const metadata of [{}, { title: 'Untitled', group: 'Unmute' }, { title: 'Send resume to Rishi', group: 'Ungrouped' }]) {
    const a = adapters()
    const result = await new HandoffCapability(a).call(ctx, 'task_create', { intent: 'send it', kind: 'oneoff', ...metadata })
    assert.equal(result.isError, true)
    assert.equal(a.created.length, 0)
  }
})

test('carried transcript context cannot omit its source identities', async () => {
  const a = adapters()
  const result = await new HandoffCapability(a).call(ctx, 'task_create', {
    title: 'Repair billing migration', group: 'Unmute', intent: 'continue', kind: 'session', context: 'Earlier sessions found the billing bug.',
  })
  assert.equal(result.isError, true)
  assert.deepEqual(a.created, [])
})
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
    title: 'Send resume to Rishi', group: 'Unmute',
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
    title: 'Send resume to Rishi', group: 'Unmute',
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
    title: 'Send resume to Rishi', group: 'Unmute',
    intent: 'carry on with the marketing work',
    kind: 'session',
    provider: 'codex',
    context: 'Three earlier sessions covered ad copy, the landing page and competitor pricing.',
    sourceSessions: [{ sessionId: 'aaaaaaaa-1111-4222-8333-444444444444', provider: 'codex' }],
  })
  assert.equal(parse(result).ok, true)
  assert.equal(calls[0].context, 'Three earlier sessions covered ad copy, the landing page and competitor pricing.')
  assert.equal(calls[0].intent, 'carry on with the marketing work', 'the request itself stays unembellished')
})

test('synthesis carries validated source identities, cwd, and exact artifacts separately', async () => {
  const a = adapters()
  const sources = [
    { sessionId: 'aaaaaaaa-1111-2222-8333-444444444444', provider: 'claude' },
    { sessionId: 'bbbbbbbb-1111-4222-8333-444444444444', provider: 'codex' },
  ]
  const artifacts = [
    { kind: 'file', value: '/Users/me/report.csv', label: 'Revenue report' },
    { kind: 'url', value: 'https://docs.example.test/brief' },
    { kind: 'identifier', value: 'sheet_123' },
  ]

  const result = await new HandoffCapability(a).call(ctx, 'task_create', {
    title: 'Send resume to Rishi', group: 'Unmute',
    intent: 'continue the combined launch work', kind: 'session', provider: 'codex',
    context: 'The launch plan was approved; pricing remains unresolved.',
    sourceSessions: sources, artifacts, cwd: '/Users/me/launch',
  })

  assert.equal(parse(result).ok, true)
  assert.deepEqual(a.created[0].sourceSessions, sources)
  assert.deepEqual(a.created[0].artifacts, artifacts)
  assert.equal(a.created[0].cwd, '/Users/me/launch')
})

test('synthesis refuses truncated source ids and malformed provenance', async () => {
  const badValues = [
    { sourceSessions: [{ sessionId: 'short', provider: 'claude' }] },
    { sourceSessions: [{ sessionId: 'aaaaaaaa-1111-2222-8333-444444444444', provider: 'desktop' }] },
    { sourceSessions: Array.from({ length: 13 }, () => ({ sessionId: 'aaaaaaaa-1111-2222-8333-444444444444', provider: 'codex' })) },
    { artifacts: [{ kind: 'other', value: 'x' }] },
    { artifacts: [{ kind: 'url', value: '' }] },
    { cwd: 'relative/project' },
  ]
  for (const extra of badValues) {
    const a = adapters()
    const result = await new HandoffCapability(a).call(ctx, 'task_create', {
    title: 'Send resume to Rishi', group: 'Unmute',
      intent: 'continue', kind: 'session', ...extra,
    })
    assert.equal(result.isError, true)
    assert.deepEqual(a.created, [])
  }
})

test('synthesis prompt separates background, exact references, and the current request', () => {
  const prompt = buildHandoffPrompt({
    intent: 'add the new customer', context: 'Earlier work established the billing workflow.',
    artifacts: [
      { kind: 'url', value: 'https://admin.example.test/customer/42', label: 'Customer' },
      { kind: 'identifier', value: 'acct_42' },
    ],
  })
  assert.ok(prompt.indexOf('Earlier work established') < prompt.indexOf('https://admin.example.test/customer/42'))
  assert.ok(prompt.indexOf('https://admin.example.test/customer/42') < prompt.indexOf('add the new customer'))
  assert.match(prompt, /Customer \(url\): https:\/\/admin\.example\.test\/customer\/42/)
  assert.match(prompt, /identifier: acct_42/)
})

test('context is optional, and an oversized one is refused', async () => {
  const calls: any[] = []
  const cap = new HandoffCapability({
    createTask: async (input) => { calls.push(input); return { taskId: 't' } },
    taskStatus: async () => null,
  })
  await cap.call(ctx, 'task_create', { title: 'Send resume to Rishi', group: 'Unmute', intent: 'send it', kind: 'oneoff', provider: 'claude' })
  assert.equal(calls[0].context, undefined)

  const huge = await cap.call(ctx, 'task_create', {
    title: 'Send resume to Rishi', group: 'Unmute',
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
    assert.equal((await new HandoffCapability(a).call(ctx, 'task_create', { title: 'Send resume to Rishi', group: 'Unmute', ...bad })).isError, true)
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
  const result = await new HandoffCapability(a).call(ctx, 'task_create', { title: 'Send resume to Rishi', group: 'Unmute', intent: 'x', kind: 'oneoff' })
  assert.equal(parse(result).error.code, 'handoff-failed')
  assert.equal(String(result.content[0]!.text).includes('/private'), false)
})

/**
 * FIELD FAILURE, 2026-09-08. One task took three task_create calls: an
 * `artifacts` entry it would not take, then the same input without it and
 * still refused because `context` requires `sourceSessions` beside it, then
 * both put right. Every refusal said only "Task input is invalid", so the two
 * wasted attempts were guesses at a reason that was never given.
 */
test('a rejected task says which field, and why', async () => {
  const base = { title: 'Build and install it', group: 'unmute-cloud', kind: 'oneoff', intent: 'Build it.' }
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ ...base, context: 'Earlier work established the build steps.' }, /context requires sourceSessions/],
    [{ ...base, kind: 'forever' }, /kind must be one of/],
    [{ ...base, intent: '' }, /intent is required/],
    [{ ...base, cwd: 'relative/path' }, /cwd must be an absolute path/],
    [{ ...base, artifacts: [{ kind: 'file', value: '/x', extra: 1 }] }, /artifacts entries take only/],
    [{ ...base, context: 'x', sourceSessions: [{ sessionId: 'not-a-uuid', provider: 'claude' }] },
      /sourceSessions entries take only/],
  ]
  for (const [input, expected] of cases) {
    const result = parse(await new HandoffCapability(adapters()).call(ctx, 'task_create', input))
    assert.equal(result.ok, false, JSON.stringify(input))
    assert.equal(result.error.code, 'invalid-input')
    assert.match(result.error.message, expected, JSON.stringify(input))
  }
})

/**
 * FIELD FAILURE (2026-09-16, 16:45): asked for a dev build "the way we did it
 * before", the Agent read the quiet-mic card's own session — correctly — and
 * then made a SECOND session for the same work instead of speaking into the
 * card that already held it. The rules said both things; code now decides.
 */
const SOURCE = 'dcca10df-b869-4a62-ab4e-fe0f52efb50e'
const create = { title: 'Quiet mic dev build', group: 'Unmute', intent: 'build it', kind: 'session', context: 'Last build used the unmute-test-build skill.', sourceSessions: [{ sessionId: SOURCE, provider: 'claude' }] }

test('a handoff citing a session that already has a card is refused, and points at the card', async () => {
  const a = adapters({ async cardForSession(id) { return id === SOURCE ? { taskId: 'quiet-mic-card', title: 'Quiet external microphone speech detection' } : null } })
  const result = await new HandoffCapability(a).call(ctx, 'task_create', create)
  assert.equal(result.isError, true)
  const error = parse(result).error
  assert.equal(error.code, 'already-has-card')
  assert.match(error.message, /quiet-mic-card/, 'the refusal names the card to send to')
  assert.match(error.message, /session_send/)
  assert.deepEqual(a.created, [], 'no second session was made')
})

test('saying what makes it a different instance lets the handoff through', async () => {
  const a = adapters({ async cardForSession() { return { taskId: 'comp-card', title: 'Comp Rishi a month' } } })
  const result = await new HandoffCapability(a).call(ctx, 'task_create', { ...create, sameJobNewInstance: 'the same comp, but for a different customer' })
  assert.equal(result.isError, undefined)
  assert.equal(a.created.length, 1)
  assert.equal(a.created[0].sameJobNewInstance, 'the same comp, but for a different customer')
})

test('a related new task cannot omit the earlier session and its findings', async () => {
  const a = adapters({ async cardForSession() { return { taskId: 'build-card', title: 'Build CLI support' } } })
  const result = await new HandoffCapability(a).call(ctx, 'task_create', {
    title: 'Install CLI support build', group: 'Unmute', intent: 'Install the existing build.', kind: 'session',
    sameJobNewInstance: 'Installation is a separate step from building the artifact.',
  })
  assert.equal(parse(result).error.code, 'invalid-input')
  assert.deepEqual(a.created, [])
})

test('a handoff whose sources have no card is unaffected', async () => {
  const a = adapters({ async cardForSession() { return null } })
  const result = await new HandoffCapability(a).call(ctx, 'task_create', create)
  assert.equal(result.isError, undefined)
  assert.equal(a.created.length, 1)
})

/**
 * THE 2026-09-20 HANDOFF. The search worked; the carrying did not. Five
 * spellings, two pages, 45 sessions, and then a task with contextChars 0 and
 * the identification appended to the user's own sentence.
 */
test('a task cannot go out empty-handed when this turn just found sessions', async () => {
  const a = adapters()
  const capability = new HandoffCapability(a)
  noteIndexFindings(ctx.principal.kind === 'unmute-agent' ? ctx.principal.interactionId : '', {
    matchedSessions: 45,
    sessionIds: ['01a08aae-116d-7761-b605-184073a24a24'],
    terms: ['Tanmay', 'Tanmay IIT GN'],
  })
  try {
    const refused = parse(await capability.call(ctx, 'task_create', {
      title: 'Message Tanmay on WhatsApp', group: 'WhatsApp messages', kind: 'oneoff',
      intent: 'Send Tanmay a WhatsApp message saying "Hey, how are you?". He is the contact saved as "Tanmay IIT GN".',
    }))
    assert.equal(refused.ok, false)
    // The refusal has to say which field and give an id to use, or the only
    // move left is guessing — the 2026-09-08 lesson.
    assert.match(refused.error.message, /context/)
    assert.match(refused.error.message, /sourceSessions/)
    assert.match(refused.error.message, /01a08aae-116d-7761-b605-184073a24a24/)
    assert.match(refused.error.message, /foundNothingRelevant/)
    assert.equal(a.created.length, 0)

    const carried = parse(await capability.call(ctx, 'task_create', {
      title: 'Message Tanmay on WhatsApp', group: 'WhatsApp messages', kind: 'oneoff',
      intent: 'Send Tanmay a WhatsApp message saying "Hey, how are you?"',
      context: 'The Tanmay they mean is the contact saved as "Tanmay IIT GN" (Tanmay Sharma), messaged on WhatsApp Desktop on 10 September.',
      sourceSessions: [{ sessionId: '01a08aae-116d-7761-b605-184073a24a24', provider: 'codex' }],
    }))
    assert.equal(carried.ok, true)
  } finally {
    clearIndexFindings(ctx.principal.kind === 'unmute-agent' ? ctx.principal.interactionId : '')
  }
})

test('a search that found nothing relevant is said out loud, and then it passes', async () => {
  const capability = new HandoffCapability(adapters())
  const id = ctx.principal.kind === 'unmute-agent' ? ctx.principal.interactionId : ''
  noteIndexFindings(id, { matchedSessions: 12, sessionIds: ['01a08aae-116d-7761-b605-184073a24a24'], terms: ['pricing'] })
  try {
    const result = parse(await capability.call(ctx, 'task_create', {
      title: 'Draft the pricing note', group: 'WhatsApp messages', kind: 'oneoff',
      intent: 'Draft a pricing note',
      foundNothingRelevant: 'the pricing matches were about a different product',
    }))
    assert.equal(result.ok, true)
  } finally { clearIndexFindings(id) }
})

test('a turn that searched nothing hands off exactly as it always did', async () => {
  const capability = new HandoffCapability(adapters())
  const result = parse(await capability.call(ctx, 'task_create', {
    title: 'Message Tanmay on WhatsApp', group: 'WhatsApp messages', kind: 'oneoff', intent: 'Say hi to Tanmay',
  }))
  assert.equal(result.ok, true)
})
