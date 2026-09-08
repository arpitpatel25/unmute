import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AgentContinuationService } from './service.ts'
import type { LocatedSession } from './locate.ts'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const located: LocatedSession = {
  sessionId: 'source-session', harness: 'codex', path: '/rollout.jsonl', cwd: '/project',
  provenance: { kind: 'main' },
}

test('host refuses missing metadata before waking an existing conversation', async () => {
  const { service, calls } = fixture(true)
  await assert.rejects(service.resume({ sessionId: 'source-session' }), /title/i)
  assert.deepEqual(calls, [])
})

test('host rejects subagent and unknown sources before wake, attach, fork, or scratch creation', async () => {
  for (const kind of ['subagent', 'unknown'] as const) for (const existing of [true, false]) for (const operation of ['resume', 'fork'] as const) {
    const { service, calls } = fixture(existing)
    service.deps.locate = async () => ({ ...located, cwd: '/scratch/reaped', provenance: { kind } })
    await assert.rejects(service[operation]({ sessionId: 'source-session', title: 'Repair billing migration', group: 'Unmute' }))
    assert.deepEqual(calls, [])
  }
})

test('host preserves existing descriptive title and canonical workspace on a fork', async () => {
  const { service, calls } = fixture()
  const manager = service.deps.manager()!
  service.deps.manager = () => ({ ...manager, list: () => [{ id: 'source-task', sessionId: 'source-session', name: 'Repair billing migration', group: 'Unmute', groupId: 'unmute' }] })
  await service.fork({ sessionId: 'source-session', title: 'Alternate migration', group: 'Unmute' })
  assert.deepEqual(calls[0].input, { harness: 'codex', sessionId: 'source-session', cwd: '/project', title: 'Repair billing migration', group: 'Unmute', groupId: 'unmute' })
})

function fixture(existing = false, deliveries: boolean[] = [], startsLive = true) {
  const calls: Array<{ op: string; input?: unknown }> = []
  let live = startsLive
  const manager = {
    list: () => existing ? [{ id: 'existing-task', sessionId: 'source-session' }] : [],
    async resume(id: string) { calls.push({ op: 'wake', input: id }); return true },
    async deliverDraft(id: string, text: string) { calls.push({ op: 'deliver', input: { id, text } }); return deliveries.shift() ?? live },
    saveDraft(id: string, text: string) { calls.push({ op: 'saveDraft', input: { id, text } }) },
    // A cold Claude card wakes on opened(), NOT on resume() — the whole bug.
    opened(id: string) { calls.push({ op: 'opened', input: id }); live = true },
    isLive(_id: string) { return live },
    setShelved(id: string, shelved: boolean) { calls.push({ op: 'setShelved', input: { id, shelved } }) },
    setKind(id: string, kind: string) { calls.push({ op: 'setKind', input: { id, kind } }) },
    async attachProviderSession(input: unknown) { calls.push({ op: 'attach', input }); return { taskId: 'new-task', sessionId: 'source-session' } },
    async forkProviderSession(input: unknown) { calls.push({ op: 'fork', input }); return { taskId: 'child-task', sessionId: 'child-session' } },
  }
  const service = new AgentContinuationService({
    manager: () => manager,
    locate: async id => id === 'source-session' ? located : null,
    workspaces: () => ({ find: label => label.toLowerCase() === 'unmute' ? { id: 'unmute', label: 'Unmute' } : undefined, get: id => id === 'unmute' ? { id, label: 'Unmute' } : undefined }),
    scratchRoot: '/scratch',
    // The real ladder waits ~23s to wake a cold chat session; tests assert the
    // shape of the retry, not the patience of it.
    deliveryBackoffMs: [0, 0, 0, 0, 0, 0, 0, 0],
    ensureDirectory: async path => { calls.push({ op: 'mkdir', input: path }) },
  })
  return { service, calls }
}

const metadata = { title: 'Repair billing migration', group: 'Unmute' }

test('resume wakes an existing card and delivers only the current request', async () => {
  const { service, calls } = fixture(true)
  const result = await service.resume({ ...metadata, sessionId: 'source-session', intent: 'continue the migration' })
  assert.deepEqual(result, {
    taskId: 'existing-task', operation: 'resume',
    sourceSessionId: 'source-session', sessionId: 'source-session',
    // An intent was supplied, so whether it landed is part of the answer.
    delivered: true,
  })
  assert.deepEqual(calls, [
    { op: 'wake', input: 'existing-task' },
    // Bringing it back is what un-hides it — a card shelved earlier must not
    // stay out of the pocket once the Agent has reopened it.
    { op: 'setShelved', input: { id: 'existing-task', shelved: false } },
    { op: 'opened', input: 'existing-task' },
    // A resume carrying a message promotes the task: a thread, not an errand.
    { op: 'setKind', input: { id: 'existing-task', kind: 'session' } },
    { op: 'deliver', input: { id: 'existing-task', text: 'continue the migration' } },
  ])
})

test('resume attaches an unowned session without converting it to a fork', async () => {
  const { service, calls } = fixture()
  const result = await service.resume({ ...metadata, sessionId: 'source-session' })
  assert.equal(result.sessionId, 'source-session')
  assert.deepEqual(calls, [{ op: 'attach', input: {
    harness: 'codex', sessionId: 'source-session', cwd: '/project', ...metadata, groupId: 'unmute',
  } }])
})

test('fork calls only the explicit provider fork operation', async () => {
  const { service, calls } = fixture()
  const result = await service.fork({ ...metadata, sessionId: 'source-session', intent: 'try another route' })
  assert.deepEqual(result, {
    taskId: 'child-task', operation: 'fork',
    sourceSessionId: 'source-session', sessionId: 'child-session',
  })
  assert.deepEqual(calls, [{ op: 'fork', input: {
    harness: 'codex', sessionId: 'source-session', cwd: '/project', intent: 'try another route', ...metadata, groupId: 'unmute',
  } }])
})

test('host-side retries share one fork even when an older agent varies intent', async () => {
  const { service, calls } = fixture()
  service.deps.interactionId = () => 'interaction-one'
  const [a, b] = await Promise.all([
    service.fork({ ...metadata, sessionId: 'source-session', title: 'Notetaker branch', group: 'Unmute' }),
    service.fork({ ...metadata, sessionId: 'source-session', intent: 'try again' }),
  ])
  assert.deepEqual(a, b)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].input, { harness: 'codex', sessionId: 'source-session', cwd: '/project', title: 'Notetaker branch', group: 'Unmute', groupId: 'unmute' })
})

test('completed continuation receipt prevents a second fork after service restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'continuation-receipt-'))
  const first = fixture()
  first.service.deps.operationRoot = root
  first.service.deps.interactionId = () => 'same-request'
  const result = await first.service.fork({ ...metadata, sessionId: 'source-session' })
  const restarted = fixture()
  restarted.service.deps.operationRoot = root
  restarted.service.deps.interactionId = () => 'same-request'
  assert.deepEqual(await restarted.service.fork({ ...metadata, sessionId: 'source-session' }), result)
  assert.equal(restarted.calls.length, 0)
  restarted.service.deps.locate = async () => ({ ...located, provenance: { kind: 'subagent' } })
  await assert.rejects(restarted.service.fork({ ...metadata, sessionId: 'source-session' }))
  assert.equal(restarted.calls.length, 0)
})

test('unknown exact id is refused rather than prefix matched', async () => {
  const { service } = fixture()
  await assert.rejects(service.resume({ ...metadata, sessionId: 'source' }), /not on this machine/i)
})

test('a reaped Unmute scratch directory is recreated before attach', async () => {
  const { service, calls } = fixture()
  ;(service as any).deps.locate = async () => ({ ...located, cwd: '/scratch/task-id' })
  await service.resume({ ...metadata, sessionId: 'source-session' })
  assert.deepEqual(calls[0], { op: 'mkdir', input: '/scratch/task-id' })
})

/**
 * FIELD FAILURE (2026-09-07). `resume()` returns once the respawn is INITIATED,
 * not once the session can take input, and delivery ran on the very next line.
 * A cold Claude card failed 85 ms after the request — before its PTY could
 * exist — and the whole operation reported as failed even though the session
 * HAD reopened, with retryable:false, so the Agent could only apologise and
 * put the text on the clipboard.
 */
test('a session that is still waking gets the message once it can take it', async () => {
  const { service, calls } = fixture(true, [false, false, true])
  const result = await service.resume({ sessionId: 'source-session', intent: 'carry on', title: 'Billing migration', group: 'Unmute' })
  assert.equal(result.delivered, true, 'it waits for the session rather than failing at once')
  assert.equal(calls.filter(c => c.op === 'deliver').length, 3, 'it retried until the session was ready')
  assert.equal(calls.filter(c => c.op === 'saveDraft').length, 0, 'nothing is parked when it lands')
})

test('a message that still cannot be delivered is parked in the card, never lost', async () => {
  const { service, calls } = fixture(true, [false, false, false, false, false, false, false, false, false])
  const result = await service.resume({ sessionId: 'source-session', intent: 'carry on', title: 'Billing migration', group: 'Unmute' })
  // Reopening SUCCEEDED. Reporting the whole thing as a failure is what left
  // the person with a clipboard and an apology.
  assert.equal(result.taskId, 'existing-task')
  assert.equal(result.delivered, false, 'and it says so, rather than throwing')
  assert.deepEqual(calls.at(-1), { op: 'saveDraft', input: { id: 'existing-task', text: 'carry on' } },
    'their words end up in that card\'s composer')
})

test('a reopen with no intent reports no delivery either way', async () => {
  const { service, calls } = fixture(true)
  const result = await service.resume({ sessionId: 'source-session', title: 'Billing migration', group: 'Unmute' })
  assert.equal(result.delivered, undefined, 'nothing was asked for, so there is nothing to report')
  assert.equal(calls.filter(c => c.op === 'deliver').length, 0)
})

/**
 * FIELD FAILURE, second round. `resume()` returned true having spawned
 * NOTHING: a cold Claude card is respawned lazily by `opened()`, which until
 * now only the UI called. The first fix retried politely for 6.6s against a
 * session that came alive 16 seconds later — when the person opened the card
 * by hand. No backoff would have helped; nothing was waking it.
 */
test('a cold card is woken, not merely resumed', async () => {
  const { service, calls } = fixture(true, [], false)
  const result = await service.resume({ sessionId: 'source-session', intent: 'carry on', title: 'Billing migration', group: 'Unmute' })
  const order = calls.map(c => c.op)
  assert.ok(order.indexOf('opened') > order.indexOf('wake'), 'opened() comes after resume() and before delivery')
  assert.ok(order.indexOf('opened') < order.indexOf('deliver'), 'the session is awake before we speak into it')
  assert.equal(result.delivered, true)
})

test('reopening a hidden card puts it back in the pocket', async () => {
  const { service, calls } = fixture(true, [], false)
  await service.resume({ sessionId: 'source-session', intent: 'carry on', title: 'Billing migration', group: 'Unmute' })
  // Hiding must never outlive the reason for it: bringing the session back IS
  // the act that un-hides it.
  assert.deepEqual(calls.find(c => c.op === 'setShelved')?.input, { id: 'existing-task', shelved: false })
})


/**
 * FIELD FAILURE, 2026-09-08. The Agent found the right session and carried a
 * 1,932-character message to it. The resume took 25.7s, returned
 * delivered:false, the message sat unsent in a composer, and the card was not
 * in the pocket to find it in. Retrieval was never the problem: isLive() read
 * only `executors`, so a graphical chat session was never live and the caller
 * burned its whole 20-second poll before delivering in what was left; and the
 * task stayed a one-off, so the pocket dropped it the moment it finished.
 */
test('a resume that carries a message makes the task a session', async () => {
  const { service, calls } = fixture(true)
  const result = await service.resume({ ...metadata, sessionId: 'source-session', intent: 'carry this over' })
  assert.equal(result.delivered, true)
  assert.deepEqual(calls.find(c => c.op === 'setKind'), { op: 'setKind', input: { id: 'existing-task', kind: 'session' } })
})

test('a resume with nothing to say leaves the kind alone', async () => {
  const { service, calls } = fixture(true)
  await service.resume({ ...metadata, sessionId: 'source-session' })
  assert.equal(calls.find(c => c.op === 'setKind'), undefined)
})
