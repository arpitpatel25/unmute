import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AgentContinuationService } from './service.ts'
import type { LocatedSession } from './locate.ts'

const located: LocatedSession = {
  sessionId: 'source-session', harness: 'codex', path: '/rollout.jsonl', cwd: '/project',
}

function fixture(existing = false) {
  const calls: Array<{ op: string; input?: unknown }> = []
  const manager = {
    list: () => existing ? [{ id: 'existing-task', sessionId: 'source-session' }] : [],
    async resume(id: string) { calls.push({ op: 'wake', input: id }); return true },
    async deliverDraft(id: string, text: string) { calls.push({ op: 'deliver', input: { id, text } }); return true },
    async attachProviderSession(input: unknown) { calls.push({ op: 'attach', input }); return { taskId: 'new-task', sessionId: 'source-session' } },
    async forkProviderSession(input: unknown) { calls.push({ op: 'fork', input }); return { taskId: 'child-task', sessionId: 'child-session' } },
  }
  const service = new AgentContinuationService({
    manager: () => manager,
    locate: async id => id === 'source-session' ? located : null,
    scratchRoot: '/scratch',
    ensureDirectory: async path => { calls.push({ op: 'mkdir', input: path }) },
  })
  return { service, calls }
}

test('resume wakes an existing card and delivers only the current request', async () => {
  const { service, calls } = fixture(true)
  const result = await service.resume({ sessionId: 'source-session', intent: 'continue the migration' })
  assert.deepEqual(result, {
    taskId: 'existing-task', operation: 'resume',
    sourceSessionId: 'source-session', sessionId: 'source-session',
  })
  assert.deepEqual(calls, [
    { op: 'wake', input: 'existing-task' },
    { op: 'deliver', input: { id: 'existing-task', text: 'continue the migration' } },
  ])
})

test('resume attaches an unowned session without converting it to a fork', async () => {
  const { service, calls } = fixture()
  const result = await service.resume({ sessionId: 'source-session' })
  assert.equal(result.sessionId, 'source-session')
  assert.deepEqual(calls, [{ op: 'attach', input: {
    harness: 'codex', sessionId: 'source-session', cwd: '/project',
  } }])
})

test('fork calls only the explicit provider fork operation', async () => {
  const { service, calls } = fixture()
  const result = await service.fork({ sessionId: 'source-session', intent: 'try another route' })
  assert.deepEqual(result, {
    taskId: 'child-task', operation: 'fork',
    sourceSessionId: 'source-session', sessionId: 'child-session',
  })
  assert.deepEqual(calls, [{ op: 'fork', input: {
    harness: 'codex', sessionId: 'source-session', cwd: '/project', intent: 'try another route',
  } }])
})

test('unknown exact id is refused rather than prefix matched', async () => {
  const { service } = fixture()
  await assert.rejects(service.resume({ sessionId: 'source' }), /not on this machine/i)
})

test('a reaped Unmute scratch directory is recreated before attach', async () => {
  const { service, calls } = fixture()
  ;(service as any).deps.locate = async () => ({ ...located, cwd: '/scratch/task-id' })
  await service.resume({ sessionId: 'source-session' })
  assert.deepEqual(calls[0], { op: 'mkdir', input: '/scratch/task-id' })
})
