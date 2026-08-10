import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CodexHub, type HubPatch } from './hub.ts'
import type { CodexAppServer, ServerRequest } from './app-server-client.ts'

/** A CodexAppServer stand-in. Only the four things the hub touches. */
function fakeServer() {
  const calls: Array<{ method: string; params: unknown }> = []
  let notify: ((m: unknown) => void) | null = null
  let onReq: ((r: ServerRequest) => Promise<unknown>) | null = null
  let nextThread = 1
  const srv = {
    url: 'ws://127.0.0.1:9999',
    running: true,
    async start() {},
    stop() {},
    on(_m: string, h: (p: unknown) => void) { notify = h; return () => {} },
    onRequest(h: (r: ServerRequest) => Promise<unknown>) { onReq = h },
    async request(method: string, params: unknown) {
      calls.push({ method, params })
      if (method === 'thread/start') return { threadId: `th_${nextThread++}` }
      return {}
    },
    notify() {},
  } as unknown as CodexAppServer
  return {
    srv, calls,
    emit: (method: string, params: Record<string, unknown>) => notify?.({ method, params }),
    ask: (r: ServerRequest) => onReq!(r),
  }
}

function makeHub() {
  const patches: HubPatch[] = []
  const f = fakeServer()
  const hub = new CodexHub({
    resolveBin: async () => '/usr/bin/codex',
    onPatch: (p) => patches.push(p),
    makeServer: () => f.srv,
  })
  return { hub, patches, ...f }
}

test('a thread carries its own permissions — that is what one server buys', async () => {
  const { hub, calls } = makeHub()
  await hub.startThread('task-a', {
    cwd: '/tmp/a', approvalPolicy: 'never', sandbox: 'danger-full-access', model: 'gpt-5.6-terra',
  })
  await hub.startThread('task-b', {
    cwd: '/tmp/b', approvalPolicy: 'on-request', sandbox: 'workspace-write',
  })
  const starts = calls.filter((c) => c.method === 'thread/start').map((c) => c.params as Record<string, unknown>)
  assert.equal(starts.length, 2)
  // A full-access errand and a fenced session, at the same time, on one server.
  assert.equal(starts[0].sandbox, 'danger-full-access')
  assert.equal(starts[1].sandbox, 'workspace-write')
  assert.equal(starts[1].model, undefined, 'no model ⇒ Codex runs on its own default, not a made-up id')
})

test('events reach the task that owns the thread, and only that task', async () => {
  const { hub, patches, emit } = makeHub()
  await hub.startThread('task-a', { cwd: '/tmp/a', approvalPolicy: 'never', sandbox: 'workspace-write' })
  await hub.startThread('task-b', { cwd: '/tmp/b', approvalPolicy: 'never', sandbox: 'workspace-write' })

  emit('item/started', { threadId: 'th_2', item: { type: 'commandExecution', command: 'npm test' } })
  const p = patches.at(-1)!
  assert.equal(p.taskId, 'task-b')
  assert.deepEqual(p.activity, { kind: 'running', label: 'npm test' })

  // ONE SOCKET CARRIES EVERY THREAD. A notification for a thread we do not know
  // must be dropped, never applied to whichever task is current — that would put
  // one task's output on another's card.
  const before = patches.length
  emit('item/started', { threadId: 'th_unknown', item: { type: 'commandExecution', command: 'rm -rf /' } })
  assert.equal(patches.length, before)
})

test('an approval blocks the turn until a human answers — on the card', async () => {
  const { hub, patches, ask } = makeHub()
  await hub.startThread('task-a', { cwd: '/tmp/a', approvalPolicy: 'on-request', sandbox: 'workspace-write' })

  // Codex asks. The promise is PARKED — this is the whole point of the App
  // Server path: an approval that used to need a terminal now arrives as a
  // question on the card.
  const reply = ask({ id: 7, method: 'execCommandApproval', params: { threadId: 'th_1', command: 'rm -rf build' } })
  let settled = false
  void reply.then(() => { settled = true })
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(settled, false, 'the turn must stay blocked until answered')

  const q = patches.at(-1)!
  assert.equal(q.state, 'needs-user')
  assert.ok(q.question?.text.includes('rm -rf build'))

  assert.equal(hub.answer('task-a', 'approve'), true)
  assert.deepEqual(await reply, { decision: 'approved' })
  assert.equal(patches.at(-1)!.clearQuestion, true)
})

test('an unroutable or unrecognised request is denied, never left hanging', async () => {
  const { hub, ask } = makeHub()
  await hub.startThread('task-a', { cwd: '/tmp/a', approvalPolicy: 'on-request', sandbox: 'workspace-write' })
  // Codex has no timeout of its own: an unanswered request hangs the turn
  // forever, and that is indistinguishable from a model that stopped thinking.
  assert.deepEqual(await ask({ id: 1, method: 'execCommandApproval', params: { threadId: 'nope' } }), { decision: 'denied' })
  // Recognised thread, request we cannot describe to the user ⇒ still denied.
  assert.deepEqual(await ask({ id: 2, method: 'some/futureApproval', params: { threadId: 'th_1' } }), { decision: 'denied' })
})

test('replying while blocked answers the approval instead of talking over it', async () => {
  const { hub, calls, ask } = makeHub()
  await hub.startThread('task-a', { cwd: '/tmp/a', approvalPolicy: 'on-request', sandbox: 'workspace-write' })
  const reply = ask({ id: 3, method: 'applyPatchApproval', params: { threadId: 'th_1', fileChanges: { 'a.ts': {} } } })
  const turnsBefore = calls.filter((c) => c.method === 'turn/start').length

  assert.equal(await hub.send('task-a', 'yes'), true)
  assert.deepEqual(await reply, { decision: 'approved' })
  // No new turn: typing "yes" as a message would leave Codex blocked on the
  // original request AND add a stray line to the thread.
  assert.equal(calls.filter((c) => c.method === 'turn/start').length, turnsBefore)
})

test('releasing a task with a blocked turn does not leave Codex waiting forever', async () => {
  const { hub, ask } = makeHub()
  await hub.startThread('task-a', { cwd: '/tmp/a', approvalPolicy: 'on-request', sandbox: 'workspace-write' })
  const reply = ask({ id: 4, method: 'execCommandApproval', params: { threadId: 'th_1', command: 'ls' } })
  hub.release('task-a')
  assert.deepEqual(await reply, { decision: 'denied' })
})

test('send and interrupt name the right thread', async () => {
  const { hub, calls } = makeHub()
  await hub.startThread('task-a', { cwd: '/tmp/a', approvalPolicy: 'never', sandbox: 'workspace-write' })
  await hub.startThread('task-b', { cwd: '/tmp/b', approvalPolicy: 'never', sandbox: 'workspace-write' })
  await hub.send('task-b', 'hello')
  await hub.interrupt('task-a')
  const turn = calls.find((c) => c.method === 'turn/start')!.params as Record<string, unknown>
  const stop = calls.find((c) => c.method === 'turn/interrupt')!.params as Record<string, unknown>
  assert.equal(turn.threadId, 'th_2')
  assert.equal(stop.threadId, 'th_1')
  assert.equal(hub.threadIdFor('task-a'), 'th_1')
})

test('a task with no thread fails softly rather than throwing into dispatch', async () => {
  const { hub } = makeHub()
  assert.equal(await hub.send('ghost', 'hi'), false)
  assert.equal(await hub.interrupt('ghost'), false)
  assert.equal(hub.answer('ghost', 'yes'), false)
  hub.release('ghost')   // must not throw
})
