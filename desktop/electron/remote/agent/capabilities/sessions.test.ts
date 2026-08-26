import assert from 'node:assert/strict'
import test from 'node:test'

import { SessionsCapability } from './sessions'
import type { CapabilityCallContext } from '../types'

const ctx = (over: Partial<CapabilityCallContext> = {}): CapabilityCallContext => ({
  principal: { kind: 'unmute-agent', runId: 'r', interactionId: 'i', expiresAt: 2_000 },
  now: 1_000,
  ...over,
})

const parse = (r: { content: Array<{ [k: string]: unknown }> }) =>
  JSON.parse(String(r.content[0]!.text))

/**
 * Four of the five tools here were wrappers around reading a plaintext file the
 * Agent can already open. Keeping them would cap it at the queries this schema
 * happened to imagine.
 */
test('only resuming is a tool — the readers became a file', () => {
  const cap = new SessionsCapability({ resume: async () => ({ taskId: 't' }) })
  assert.deepEqual(cap.tools.map((t) => t.name), ['session_resume'])
})

test('resuming returns the task it woke', async () => {
  const calls: unknown[] = []
  const cap = new SessionsCapability({
    resume: async (input) => { calls.push(input); return { taskId: 'task-9' } },
  })
  const result = await cap.call(ctx(), 'session_resume', { sessionId: 'sess-1', intent: 'add the rollback section' })
  assert.deepEqual(parse(result), { ok: true, result: { taskId: 'task-9', resumed: 'sess-1' } })
  assert.deepEqual(calls, [{ sessionId: 'sess-1', intent: 'add the rollback section' }])
})

test('an intent is optional — reopening without saying anything is allowed', async () => {
  const calls: unknown[] = []
  const cap = new SessionsCapability({
    resume: async (input) => { calls.push(input); return { taskId: 't' } },
  })
  await cap.call(ctx(), 'session_resume', { sessionId: 'sess-1' })
  assert.deepEqual(calls, [{ sessionId: 'sess-1' }])
})

test('a missing or oversized argument is refused, not passed on', async () => {
  let called = false
  const cap = new SessionsCapability({ resume: async () => { called = true; return { taskId: 't' } } })
  assert.equal(parse(await cap.call(ctx(), 'session_resume', {})).ok, false)
  assert.equal(parse(await cap.call(ctx(), 'session_resume', { sessionId: 's', intent: 'x'.repeat(2001) })).ok, false)
  assert.equal(called, false)
})

test('an expired interaction reaches nothing', async () => {
  let called = false
  const cap = new SessionsCapability({ resume: async () => { called = true; return { taskId: 't' } } })
  const result = await cap.call(ctx({ now: 9_999 }), 'session_resume', { sessionId: 's' })
  assert.equal(parse(result).ok, false)
  assert.equal(called, false)
})

test('a task principal is not an Agent principal', async () => {
  const cap = new SessionsCapability({ resume: async () => ({ taskId: 't' }) })
  const result = await cap.call(
    { principal: { kind: 'task', taskId: 't' }, now: 1 }, 'session_resume', { sessionId: 's' },
  )
  assert.equal(parse(result).ok, false)
})

/** A failure the user can act on beats a stack trace they cannot see. */
test('a resume that throws becomes an honest error, not a crash', async () => {
  const cap = new SessionsCapability({
    resume: async () => { throw new Error('That session is not on this machine') },
  })
  const result = await cap.call(ctx(), 'session_resume', { sessionId: 'gone' })
  const parsed = parse(result)
  assert.equal(parsed.ok, false)
  assert.match(parsed.error.message, /not on this machine/)
})

test('an unknown tool name is refused', async () => {
  const cap = new SessionsCapability({ resume: async () => ({ taskId: 't' }) })
  assert.equal(parse(await cap.call(ctx(), 'sessions_search', { text: 'x' })).ok, false)
})
