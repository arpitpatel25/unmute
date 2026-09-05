import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SessionsCapability, type SessionAdapters } from './sessions.ts'
import type { CapabilityCallContext, McpPrincipal, ToolResult } from '../types.ts'

const NOW = 10_000
const agent: McpPrincipal = {
  kind: 'unmute-agent', runId: 'run-1', interactionId: 'ix-1', expiresAt: 20_000, provider: 'claude',
}
const ctx: CapabilityCallContext = {
  principal: agent, now: NOW, interaction: { id: 'ix-1', active: true, transcript: 'carry on with the migration' },
}
function parse(r: ToolResult): any { return JSON.parse(String(r.content[0]!.text)) }

function adapters(overrides: Partial<SessionAdapters> = {}): SessionAdapters & { asked: any[] } {
  const asked: any[] = []
  return {
    asked,
    async resume(input) {
      asked.push({ operation: 'resume', ...input })
      return {
        taskId: 'task-9', operation: 'resume' as const,
        sourceSessionId: input.sessionId, sessionId: input.sessionId,
      }
    },
    async fork(input) {
      asked.push({ operation: 'fork', ...input })
      return {
        taskId: 'task-10', operation: 'fork' as const,
        sourceSessionId: input.sessionId,
        sessionId: 'bbbbbbbb-1111-2222-3333-444444444444',
      }
    },
    async search(input) {
      asked.push({ operation: 'search', ...input })
      return [{ sessionId: 'match', harness: 'codex' as const, path: '/rollout', modifiedAt: 1,
        userText: 'pricing migration', artifacts: [], score: 2 }]
    },
    ...overrides,
  } as SessionAdapters & { asked: any[] }
}

test('a past session is reopened as a card, and the id is reported back', async () => {
  const a = adapters()

  const result = await new SessionsCapability(a).call(ctx, 'session_resume', {
    sessionId: 'aaaaaaaa-1111-2222-3333-444444444444',
    intent: 'carry on with the migration',
  })

  assert.deepEqual(parse(result), {
    ok: true,
    result: {
      taskId: 'task-9', operation: 'resume',
      sourceSessionId: 'aaaaaaaa-1111-2222-3333-444444444444',
      sessionId: 'aaaaaaaa-1111-2222-3333-444444444444',
    },
  })
  assert.equal(a.asked[0].sessionId, 'aaaaaaaa-1111-2222-3333-444444444444')
  assert.equal(a.asked[0].intent, 'carry on with the migration')
})

test('fork is a separate operation and reports the provider child identity', async () => {
  const a = adapters()

  const result = await new SessionsCapability(a).call(ctx, 'session_fork', {
    sessionId: 'aaaaaaaa-1111-2222-3333-444444444444',
    intent: 'try the alternate migration',
  })

  assert.deepEqual(parse(result), {
    ok: true,
    result: {
      taskId: 'task-10', operation: 'fork',
      sourceSessionId: 'aaaaaaaa-1111-2222-3333-444444444444',
      sessionId: 'bbbbbbbb-1111-2222-3333-444444444444',
    },
  })
  assert.deepEqual(a.asked[0], {
    operation: 'fork', sessionId: 'aaaaaaaa-1111-2222-3333-444444444444',
    intent: 'try the alternate migration',
  })
})

test('resume fails closed when the adapter changes provider identity', async () => {
  const result = await new SessionsCapability(adapters({
    async resume(input) {
      return {
        taskId: 'task-9', operation: 'resume', sourceSessionId: input.sessionId,
        sessionId: 'different-session',
      }
    },
  })).call(ctx, 'session_resume', { sessionId: 'source-session' })

  assert.equal(result.isError, true)
  assert.equal(parse(result).error.code, 'resume-failed')
})

test('fork fails closed when the adapter reuses provider identity', async () => {
  const result = await new SessionsCapability(adapters({
    async fork(input) {
      return {
        taskId: 'task-10', operation: 'fork', sourceSessionId: input.sessionId,
        sessionId: input.sessionId,
      }
    },
  })).call(ctx, 'session_fork', { sessionId: 'source-session' })

  assert.equal(result.isError, true)
  assert.equal(parse(result).error.code, 'fork-failed')
})

test('search returns bounded deterministic candidates without changing runtime state', async () => {
  const a = adapters()
  const result = await new SessionsCapability(a).call(ctx, 'sessions_search', {
    query: 'pricing migration', limit: 8,
  })
  assert.equal(parse(result).result[0].sessionId, 'match')
  assert.deepEqual(a.asked[0], { operation: 'search', query: 'pricing migration', limit: 8 })
})

test('search refuses empty queries and excessive limits', async () => {
  const a = adapters()
  assert.equal((await new SessionsCapability(a).call(ctx, 'sessions_search', { query: ' ' })).isError, true)
  assert.equal((await new SessionsCapability(a).call(ctx, 'sessions_search', { query: 'pricing', limit: 99 })).isError, true)
  assert.deepEqual(a.asked, [])
})

test('reopening without an intent asks for no follow-up at all', async () => {
  const a = adapters()

  await new SessionsCapability(a).call(ctx, 'session_resume', { sessionId: 'abc' })

  assert.equal('intent' in a.asked[0], false, 'an absent intent must not become an empty one')
})

/**
 * The Agent must be able to say "I could not reopen that" in its own words.
 * A thrown adapter would surface as a tool crash instead.
 */
test('a session that cannot be reopened comes back as an error the Agent can read', async () => {
  const a = adapters({
    async resume() { throw new Error('That session is not on this machine') },
  })

  const result = await new SessionsCapability(a).call(ctx, 'session_resume', { sessionId: 'abc' })

  assert.equal(result.isError, true)
  assert.deepEqual(parse(result).error, {
    code: 'resume-failed',
    message: 'That session is not on this machine',
  })
})

test('an empty session id is refused before the adapter is troubled', async () => {
  const a = adapters()

  const result = await new SessionsCapability(a).call(ctx, 'session_resume', { sessionId: '   ' })

  assert.equal(parse(result).error.code, 'invalid-input')
  assert.equal(a.asked.length, 0)
})

test('a task principal cannot reopen the user\'s sessions', async () => {
  const task: McpPrincipal = { kind: 'task', taskId: 't-1' } as McpPrincipal

  const result = await new SessionsCapability(adapters()).call(
    { principal: task, now: NOW }, 'session_resume', { sessionId: 'abc' },
  )

  assert.equal(parse(result).error.code, 'access-denied')
})

test('an expired agent run cannot reopen a session', async () => {
  const result = await new SessionsCapability(adapters()).call(
    { principal: agent, now: 30_000 }, 'session_resume', { sessionId: 'abc' },
  )

  assert.equal(parse(result).error.code, 'access-denied')
})

test('the capability exposes distinct resume and fork tools only to the Agent', () => {
  const capability = new SessionsCapability(adapters())

  assert.deepEqual(capability.tools.map((t) => t.name), ['sessions_search', 'session_resume', 'session_fork'])
  assert.deepEqual([...capability.roles], ['unmute-agent'])
  assert.equal(capability.tools[0]!.consequence, 'read')
  assert.equal(capability.tools[1]!.consequence, 'reversible-write')
  assert.equal(capability.tools[2]!.consequence, 'reversible-write')
})
