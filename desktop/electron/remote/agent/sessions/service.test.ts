import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AgentContinuationService } from './service.ts'
import type { LocatedSession } from './locate.ts'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

test('host-side retries share one fork even when an older agent varies intent', async () => {
  const { service, calls } = fixture()
  service.deps.interactionId = () => 'interaction-one'
  const [a, b] = await Promise.all([
    service.fork({ sessionId: 'source-session', title: 'Notetaker branch', group: 'Unmute' }),
    service.fork({ sessionId: 'source-session', intent: 'try again' }),
  ])
  assert.deepEqual(a, b)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].input, { harness: 'codex', sessionId: 'source-session', cwd: '/project', title: 'Notetaker branch', group: 'Unmute' })
})

test('completed continuation receipt prevents a second fork after service restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'continuation-receipt-'))
  const first = fixture()
  first.service.deps.operationRoot = root
  first.service.deps.interactionId = () => 'same-request'
  const result = await first.service.fork({ sessionId: 'source-session' })
  const restarted = fixture()
  restarted.service.deps.operationRoot = root
  restarted.service.deps.interactionId = () => 'same-request'
  assert.deepEqual(await restarted.service.fork({ sessionId: 'source-session' }), result)
  assert.equal(restarted.calls.length, 0)
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
