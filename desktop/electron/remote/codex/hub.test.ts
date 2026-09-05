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
      if (method === 'turn/start') return { turn: { id: 'turn-1' } }
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
    approvalCap: () => ({ fullAccessAllowed: true, roots: [] }),
  })
  return { hub, patches, ...f }
}

test('approval cards expose exact command scope and map offered session decisions without policy amendments', async () => {
  const { hub, ask, patches } = makeHub()
  await hub.startThread('task', { cwd: '/tmp', approvalPolicy: 'on-request', sandbox: 'workspace-write' })
  const reply = ask({ id: 8, method: 'item/commandExecution/requestApproval', params: { threadId: 'th_1', itemId: 'c',
    command: 'curl https://example.test', cwd: '/project', additionalPermissions: { fileSystem: { write: ['/cache'] } },
    networkApprovalContext: { host: 'example.test', protocol: 'https' },
    availableDecisions: ['acceptForSession', 'decline', { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['curl'] } }],
  } })
  const q = patches.filter(p => p.question).at(-1)!.question!
  const detail = q.text + JSON.stringify((q as any).details)
  for (const value of ['curl https://example.test', '/project', '/cache', 'example.test']) assert.ok(detail.includes(value))
  assert.deepEqual(q.choices, ['Allow for session', 'Deny'])
  assert.match(detail, /persistent|global/i)
  assert.equal(hub.answer('task', 'Allow once', q.reference), false)
  assert.equal(hub.answer('task', 'Allow for session', q.reference), true)
  assert.deepEqual(await reply, { decision: 'acceptForSession' })
})

test('permission session grants and pending file patches match the displayed request', async () => {
  const { hub, ask, patches, emit } = makeHub()
  await hub.startThread('task', { cwd: '/tmp', approvalPolicy: 'on-request', sandbox: 'workspace-write' })
  const permissions = { fileSystem: { write: ['/project/out'] }, network: { enabled: true } }
  const reply = ask({ id: 9, method: 'item/permissions/requestApproval', params: { threadId: 'th_1', cwd: '/project', permissions } })
  let q = patches.filter(p => p.question).at(-1)!.question!
  assert.ok((q.text + JSON.stringify((q as any).details)).includes('/project/out'))
  assert.equal(hub.answer('task', 'Allow for session', q.reference), true)
  assert.deepEqual(await reply, { permissions, scope: 'session' })
  emit('item/started', { threadId: 'th_1', item: { type: 'fileChange', id: 'f', changes: [
    { path: '/project/a', kind: { type: 'update' }, diff: '-old\n+new' }, { path: '/project/b', kind: { type: 'add' }, diff: '+more' },
  ] } })
  const file = ask({ id: 10, method: 'item/fileChange/requestApproval', params: { threadId: 'th_1', itemId: 'f', grantRoot: '/project' } })
  q = patches.filter(p => p.question).at(-1)!.question!
  const detail = q.text + JSON.stringify((q as any).details)
  assert.ok(detail.includes('/project/a') && detail.includes('/project/b') && detail.includes('+new'))
  assert.equal(hub.answer('task', 'Cancel turn', q.reference), true)
  assert.deepEqual(await file, { decision: 'cancel' })
})

test('history loading and pagination errors are visible and retry restores the same thread', async () => {
  const { hub, srv, patches } = makeHub()
  let fail = true
  srv.request = async (method: string) => {
    if (method === 'thread/resume') return { thread: { id: 'history', turns: [{ id: 'new', status: 'interrupted', items: [{ type: 'userMessage', id: 'u', content: [{ type: 'text', text: 'newer' }] }] }] }, turnsBackwardsCursor: 'older' } as any
    if (method === 'thread/turns/list') { if (fail) throw new Error('page unavailable'); return { data: [], nextCursor: null } as any }
    return {} as any
  }
  const options = { cwd: '/tmp', approvalPolicy: 'on-request', sandbox: 'workspace-write' }
  await assert.rejects(hub.resumeThread('task', 'history', options), /page unavailable/)
  assert.ok(patches.some(p => (p as any).history?.phase === 'loading'))
  assert.ok(patches.some(p => ['failed', 'partial'].includes((p as any).history?.phase)))
  fail = false
  await hub.resumeThread('task', 'history', options, true)
  assert.equal((patches.at(-1) as any).history?.phase, 'ready')
  assert.equal(hub.threadIdFor('task'), 'history')
  assert.equal(patches.at(-1)?.turnOutcome, 'cancelled')
})

test('history startup failure leaves loading with an explicit retryable failure', async () => {
  const patches: HubPatch[] = []
  const hub = new CodexHub({ resolveBin: async () => { throw new Error('binary unavailable') }, onPatch: p => patches.push(p) })
  await assert.rejects(hub.resumeThread('task', 'history', { cwd: '/tmp', approvalPolicy: 'on-request', sandbox: 'workspace-write' }), /binary unavailable/)
  assert.equal(patches.at(-1)?.history?.phase, 'failed')
  assert.equal(patches.at(-1)?.history?.canRetry, true)
})

test('real nested Codex error payload retains details and retries without terminal failure', async () => {
  const { hub, emit, patches } = makeHub()
  await hub.startThread('task', { cwd: '/tmp', approvalPolicy: 'on-request', sandbox: 'workspace-write' })
  emit('turn/started', { threadId: 'th_1', turn: { id: 'turn' } })
  const error = { message: 'Rate limit reached; retry in 20s', codexErrorInfo: 'usageLimitExceeded', additionalDetails: 'Full provider retry detail', misalignment: null }
  emit('error', { threadId: 'th_1', turnId: 'turn', error, willRetry: true })
  let patch = patches.findLast(p => p.errorReason)!
  assert.equal(patch.state, 'processing'); assert.equal(patch.turnOutcome, null)
  assert.match(patch.activity?.label ?? '', /retry/i)
  assert.match(patch.errorReason!, /Rate limit reached; retry in 20s/)
  assert.match(patch.errorReason!, /Full provider retry detail/)
  assert.match(patch.errorReason!, /usageLimitExceeded/)
  emit('error', { threadId: 'th_1', turnId: 'turn', error, willRetry: false })
  patch = patches.findLast(p => p.errorReason)!
  assert.equal(patch.state, 'failed'); assert.equal(patch.turnOutcome, 'failed')
  emit('turn/completed', { threadId: 'th_1', turn: { id: 'turn', status: 'completed' } })
  assert.equal(patches.findLast(p => p.state)?.errorReason, '')
})

test('threadless MCP startup failure reaches owned task surfaces and Stop immediately acknowledges Cancelling', async () => {
  const { hub, emit, patches } = makeHub()
  await hub.startThread('task', { cwd: '/tmp', approvalPolicy: 'on-request', sandbox: 'workspace-write' })
  emit('mcpServer/startupStatus/updated', { threadId: null, name: 'drive', status: 'failed', error: 'Auth expired', failureReason: 'reauthenticationRequired' })
  assert.equal(patches.at(-1)?.mcpStatus?.error, 'Auth expired')
  await hub.send('task', 'work')
  const stop = hub.interrupt('task')
  assert.equal(patches.at(-1)?.activity?.label, 'Cancelling')
  await stop
  emit('turn/completed', { threadId: 'th_1', turn: { id: 'turn-1', status: 'interrupted' } })
  assert.equal(patches.at(-1)?.turnOutcome, 'cancelled')
})

test('owned per-turn plans survive reconnect even though provider history does not repeat plan notifications', async () => {
  const f = fakeServer(), patches: HubPatch[] = [], saved: any[] = []
  const hub = new CodexHub({ resolveBin: async () => '/never-launched', makeServer: () => f.srv, onPatch: p => patches.push(p),
    savePlans: async (_task, _thread, plans) => { saved.splice(0, saved.length, ...structuredClone(plans)) },
    loadPlans: async () => saved } as any)
  const options = { cwd: '/tmp', approvalPolicy: 'on-request', sandbox: 'workspace-write' }
  await hub.startThread('t', options)
  for (const turnId of ['one', 'two']) f.emit('turn/plan/updated', { threadId: 'th_1', turnId, plan: [{ step: turnId, status: 'completed' }] })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(saved.length, 2)
  f.srv.request = async () => ({ thread: { id: 'th_1', turns: ['one', 'two'].map(id => ({ id, status: 'completed', items: [
    { type: 'userMessage', id: `u-${id}`, content: [{ type: 'text', text: id }] }, { type: 'agentMessage', id: `a-${id}`, text: 'answer' },
  ] })) } }) as any
  await hub.resumeThread('t', 'th_1', options, true)
  const blocks = patches.filter(p => p.blocks).at(-1)!.blocks!
  assert.deepEqual(blocks.filter(b => b.kind === 'plan').map(b => b.steps[0].text), ['one', 'two'])
  assert.deepEqual(blocks.filter(b => b.kind === 'message' && b.role === 'assistant').map(b => b.text), ['answer', 'answer'])
})

test('immutable approval caps hide filesystem escalation and revalidate a previously displayed grant', async () => {
  const f = fakeServer(), patches: HubPatch[] = []
  let capped = true
  const hub = new CodexHub({ resolveBin: async () => '/never-launched', makeServer: () => f.srv, onPatch: p => patches.push(p),
    approvalCap: () => ({ roots: capped ? ['/allowed'] : [], fullAccessAllowed: !capped }) } as any)
  await hub.startThread('t', { cwd: '/allowed', approvalPolicy: 'on-request', sandbox: 'workspace-write' })
  const request = () => f.ask({ id: 1, method: 'item/permissions/requestApproval', params: { threadId: 'th_1', cwd: '/allowed', permissions: { fileSystem: { write: ['/outside'] } } } })
  let answer = request(), q = patches.filter(p => p.question).at(-1)!.question!
  assert.deepEqual(q.choices, ['Deny'])
  assert.match(q.details!, /cap|root|consent/i)
  assert.equal(hub.answer('t', 'Allow for session', q.reference), false)
  assert.equal(hub.answer('t', 'Deny', q.reference), true); await answer
  capped = false
  answer = request(); q = patches.filter(p => p.question).at(-1)!.question!
  assert.ok(q.choices?.includes('Allow for session'))
  capped = true
  assert.equal(hub.answer('t', 'Allow for session', q.reference), false)
  const refreshed = patches.filter(p => p.question).at(-1)!.question!
  assert.notDeepEqual(refreshed.reference, q.reference)
  assert.equal(hub.answer('t', 'Deny', q.reference), false)
  hub.answer('t', 'Deny', refreshed.reference); await answer
})

test('rendered Codex reference expires across requests and advances across question steps', async () => {
  const { hub, ask, patches } = makeHub()
  await hub.startThread('t', { cwd: '/tmp', approvalPolicy: 'on-request', sandbox: 'workspace-write' })
  const current = () => patches.filter(p => p.question).at(-1)!.question!.reference!
  const first = ask({ id: 1, method: 'item/tool/requestUserInput', params: { threadId: 'th_1', questions: [
    { id: 'a', question: 'First?' }, { id: 'b', question: 'Second?' },
  ] } })
  const A = current(); assert.ok(A)
  assert.equal(hub.answer('t', 'one', A), true)
  const B = current(); assert.notDeepEqual(A, B)
  assert.equal(hub.answer('t', 'stale', A), false)
  assert.equal(hub.answer('t', 'two', B), true)
  assert.equal(hub.answer('t', 'duplicate', B), false)
  assert.deepEqual(await first, { answers: { a: { answers: ['one'] }, b: { answers: ['two'] } } })
  const second = ask({ id: 1, method: 'item/commandExecution/requestApproval', params: { threadId: 'th_1', command: 'ls' } })
  assert.notEqual(current().requestId, A.requestId, 'reused wire ID is a distinct occurrence')
  assert.equal(hub.answer('t', 'Approve', B), false)
  hub.answer('t', 'Deny', current()); await second
})

test('queued new-turn reservation cannot answer approval and emits only live fenced completion', async () => {
  const { hub, ask, emit, calls } = makeHub()
  const ended: unknown[] = []; hub.onFollowup(e => ended.push(e))
  await hub.startThread('task', { cwd: '/tmp', approvalPolicy: 'on-request', sandbox: 'workspace-write' })
  const idle = hub.followupGate('task'); assert.equal(idle.kind, 'idle')
  const reply = ask({ id: 99, method: 'item/commandExecution/requestApproval', params: { threadId: 'th_1', command: 'ls' } })
  assert.equal((await hub.sendNewTurn('task', 'queued prose', [], idle as any)).kind, 'not-sent')
  assert.equal(calls.filter(c => c.method === 'turn/start').length, 0)
  hub.answer('task', 'Deny'); await reply
  assert.equal((await hub.sendNewTurn('task', 'next', [], idle as any)).kind, 'accepted')
  const active = hub.followupGate('task'); assert.equal(active.kind, 'active')
  emit('turn/completed', { threadId: 'th_1', turn: { id: 'turn-1', status: 'completed' } })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(ended.filter((e: any) => e.type === 'ended').length, 1)
  emit('turn/completed', { threadId: 'th_1', turn: { id: 'turn-1', status: 'completed' } })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(ended.filter((e: any) => e.type === 'ended').length, 1)
})

test('Codex completion waits for start acknowledgement and cannot unlock uncertain acceptance', async () => {
  for (const confirmed of [true, false]) {
    const { hub, srv, emit } = makeHub()
    const events: any[] = []; hub.onFollowup(e => events.push(e))
    await hub.startThread('task', { cwd: '/tmp', approvalPolicy: 'on-request', sandbox: 'workspace-write' })
    const idle = hub.followupGate('task') as { sessionId: string; generation: number }
    let finish!: (value: any) => void
    srv.request = async () => {
      emit('turn/started', { threadId: 'th_1', turn: { id: 'early-turn' } })
      emit('turn/completed', { threadId: 'th_1', turn: { id: 'early-turn', status: 'completed' } })
      return await new Promise(resolve => { finish = resolve })
    }
    const sending = hub.sendNewTurn('task', 'first', [], idle)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(events.filter(e => e.type === 'ended').length, 0)
    assert.equal((await hub.sendNewTurn('task', 'duplicate', [], idle)).kind, 'not-sent')
    finish(confirmed ? { turn: { id: 'early-turn' } } : {})
    assert.equal((await sending).kind, confirmed ? 'accepted' : 'uncertain')
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(events.filter(e => e.type === 'ended').length, confirmed ? 1 : 0)
    if (!confirmed) assert.equal(hub.followupGate('task').kind, 'unavailable')
  }
})

test('queued Codex outcome belongs to its attempt when same-thread resume replaces task state', async () => {
  for (const accepted of [false, true]) {
    const { hub, srv } = makeHub()
    const options = { cwd: '/tmp', approvalPolicy: 'on-request', sandbox: 'workspace-write' }
    await hub.startThread('task', options)
    const idle = hub.followupGate('task') as { sessionId: string; generation: number }
    let resolveAttempt!: (value: any) => void, rejectAttempt!: (error: Error) => void
    srv.request = async (method: string) => method === 'turn/start'
      ? await new Promise((resolve, reject) => { resolveAttempt = resolve; rejectAttempt = reject })
      : { thread: { id: 'th_1', turns: [{ id: 'replacement-turn', status: 'inProgress', items: [] }] } } as any
    const pending = hub.sendNewTurn('task', 'frozen follow-up', [], idle)
    await hub.resumeThread('task', 'th_1', options, true)
    if (accepted) resolveAttempt({ turn: { id: 'original-attempt-turn' } }); else rejectAttempt(new Error('old acknowledgement lost'))
    const outcome = await pending
    assert.equal(outcome.kind, accepted ? 'accepted' : 'uncertain')
    if (outcome.kind === 'accepted') assert.equal(outcome.turnId, 'original-attempt-turn')
  }
})

test('modern approval replies use the modern decision schema', async () => {
  const { hub, ask } = makeHub()
  await hub.startThread('task', { cwd: '/tmp', approvalPolicy: 'on-request', sandbox: 'workspace-write' })
  const reply = ask({ id: 1, method: 'item/commandExecution/requestApproval', params: { threadId: 'th_1', command: 'ls' } })
  hub.answer('task', 'Approve')
  assert.deepEqual(await reply, { decision: 'accept' })
})

test('MCP primitive form validates answers and sends structured content after confirmation', async () => {
  const { hub, ask, patches } = makeHub()
  await hub.startThread('task', { cwd: '/tmp', approvalPolicy: 'on-request', sandbox: 'workspace-write' })
  const reply = ask({ id: 3, method: 'mcpServer/elicitation/request', params: { threadId: 'th_1', mode: 'form', message: 'Configure tool', requestedSchema: {
    type: 'object', required: ['name', 'count', 'enabled', 'tags'], properties: {
      name: { type: 'string', minLength: 2 }, count: { type: 'integer', minimum: 1, maximum: 4 }, enabled: { type: 'boolean' },
      tags: { type: 'array', items: { type: 'string', enum: ['a', 'b'] }, minItems: 1 }, color: { type: 'string', oneOf: [{ const: 'r', title: 'Red' }, { const: 'g', title: 'Green' }] },
    },
  } } })
  assert.equal(hub.answer('task', ''), false)
  assert.equal(hub.answer('task', 'Tool'), true)
  assert.equal(hub.answer('task', '99'), false)
  assert.equal(hub.answer('task', '2'), true)
  assert.equal(hub.answer('task', 'maybe'), false)
  assert.equal(hub.answer('task', 'true'), true)
  assert.equal(hub.answer('task', '["bad"]'), false)
  assert.equal(hub.answer('task', '["a","b"]'), true)
  assert.equal(hub.answer('task', 'Red'), true)
  assert.match(patches.at(-1)?.question?.text ?? '', /submit/i)
  assert.equal(hub.answer('task', 'Approve'), true)
  assert.deepEqual(await reply, { action: 'accept', content: { name: 'Tool', count: 2, enabled: true, tags: ['a', 'b'], color: 'r' } })
})

test('MCP optional fields can be omitted and cancellation emits no partial content', async () => {
  const { hub, ask } = makeHub()
  await hub.startThread('task', { cwd: '/tmp', approvalPolicy: 'on-request', sandbox: 'workspace-write' })
  const params = { threadId: 'th_1', mode: 'form', requestedSchema: { type: 'object', properties: { optional: { type: 'string' } } } }
  const first = ask({ id: 1, method: 'mcpServer/elicitation/request', params })
  assert.equal(hub.answer('task', '/skip'), true)
  assert.equal(hub.answer('task', 'accept'), true)
  assert.deepEqual(await first, { action: 'accept', content: {} })
  const second = ask({ id: 2, method: 'mcpServer/elicitation/request', params })
  assert.equal(hub.answer('task', '/cancel'), true)
  assert.deepEqual(await second, { action: 'cancel' })
})

test('MCP date-time requires RFC3339 timezone and real calendar values', async () => {
  const { hub, ask } = makeHub()
  await hub.startThread('task', { cwd: '/tmp', approvalPolicy: 'on-request', sandbox: 'workspace-write' })
  const reply = ask({ id: 1, method: 'mcpServer/elicitation/request', params: { threadId: 'th_1', mode: 'form', requestedSchema: { type: 'object', properties: { when: { type: 'string', format: 'date-time' } } } } })
  for (const bad of ['2026-09-05T12:30:00', '2026-02-30T12:00:00Z', '2026-01-01T24:00:00Z', '2026-01-01T12:00:00+24:00']) assert.equal(hub.answer('task', bad), false, bad)
  assert.equal(hub.answer('task', '2024-02-29T12:30:45.123+05:30'), true)
  hub.answer('task', 'Approve')
  assert.deepEqual(await reply, { action: 'accept', content: { when: '2024-02-29T12:30:45.123+05:30' } })
})

test('missing turn acknowledgement locks further sends until resume', async () => {
  const { hub, srv, patches } = makeHub()
  await hub.startThread('task', { cwd: '/tmp', approvalPolicy: 'never', sandbox: 'danger-full-access' })
  srv.request = async () => ({}) as any
  assert.equal(await hub.send('task', 'work'), false)
  assert.equal(await hub.send('task', 'retry'), false)
  assert.match(patches.at(-1)?.errorReason ?? '', /confirm|uncertain/i)
})

test('disconnected pending requests survive silent resume and bind replayed request ids', async () => {
  const { hub, srv, ask, emit, patches } = makeHub()
  const opts = { cwd: '/tmp', approvalPolicy: 'on-request', sandbox: 'workspace-write' }
  await hub.startThread('task', opts)
  void ask({ id: 3, method: 'item/fileChange/requestApproval', params: { threadId: 'th_1', turnId: 'active' } })
  void ask({ id: 4, method: 'item/commandExecution/requestApproval', params: { threadId: 'th_1', turnId: 'active', command: 'pwd' } })
  emit('transport/disconnected', {})
  srv.request = async () => ({ thread: { id: 'th_1', turns: [] } }) as any
  await hub.resumeThread('task', 'th_1', opts, true)
  assert.equal(patches.at(-1)?.state, 'needs-user')
  assert.equal(hub.answer('task', 'Approve'), false)
  const replay = ask({ id: 3, method: 'item/fileChange/requestApproval', params: { threadId: 'th_1', turnId: 'active' } })
  assert.equal(hub.answer('task', 'Deny'), true)
  assert.deepEqual(await replay, { decision: 'decline' })
  assert.equal(patches.at(-1)?.state, 'needs-user')
  assert.equal(hub.answer('task', 'Approve'), false)
  const replayQueued = ask({ id: 4, method: 'item/commandExecution/requestApproval', params: { threadId: 'th_1', turnId: 'active', command: 'pwd' } })
  assert.equal(hub.answer('task', 'Deny'), true)
  assert.deepEqual(await replayQueued, { decision: 'decline' })
})

test('history marks completed turn approvals stale before queued requests drain', async () => {
  const { hub, srv, ask, patches } = makeHub()
  let stale!: Promise<unknown>
  srv.request = async () => {
    stale = ask({ id: 3, method: 'item/fileChange/requestApproval', params: { threadId: 'old', turnId: 'complete' } })
    return { thread: { id: 'old', turns: [{ id: 'complete', status: 'completed', items: [] }, { id: 'active', status: 'inProgress', items: [] }] } } as any
  }
  await hub.resumeThread('task', 'old', { cwd: '/tmp', approvalPolicy: 'on-request', sandbox: 'workspace-write' })
  assert.deepEqual(await stale, { decision: 'decline' })
  assert.equal(patches.some(p => p.state === 'needs-user'), false)
})

test('replaced server cannot introduce requests into live thread state', async () => {
  const old = fakeServer(), next = fakeServer()
  let count = 0
  const hub = new CodexHub({ resolveBin: async () => 'codex', onPatch() {}, makeServer: () => count++ ? next.srv : old.srv })
  const opts = { cwd: '/tmp', approvalPolicy: 'never', sandbox: 'danger-full-access' }
  await hub.startThread('task', opts)
  ;(old.srv as any).running = false
  await hub.resumeThread('task', 'th_1', opts, true)
  await assert.rejects(old.ask({ id: 7, method: 'item/fileChange/requestApproval', params: { threadId: 'th_1' } }), /replaced|connection/i)
  assert.equal(hub.answer('task', 'Approve'), false)
})

test('fresh task config is injected on start and forced resume', async () => {
  const f = fakeServer()
  let token = 0
  const hub = new CodexHub({ resolveBin: async () => 'codex', onPatch() {}, makeServer: () => f.srv,
    threadConfig: async (taskId) => ({ developer_instructions: taskId, token: ++token }) })
  const opts = { cwd: '/tmp', approvalPolicy: 'never', sandbox: 'danger-full-access' }
  await hub.startThread('task', opts)
  await hub.resumeThread('task', 'th_1', opts, true)
  assert.deepEqual(f.calls.map(c => (c.params as any).config.token), [1, 2])
})

test('resume paginates inclusive turn and item anchors in chronological order without duplicates', async () => {
  const { hub, srv, patches } = makeHub()
  const item = (id: string) => ({ id, type: 'agentMessage', text: id })
  srv.request = async (method, params: any) => {
    if (method === 'thread/resume') return { thread: { id: 'old', turns: [{ id: 't2', items: [item('c')], status: 'completed' }] }, turnsBackwardsCursor: 'turn-anchor', itemsBackwardsCursor: 'item-anchor' } as any
    if (method === 'thread/turns/list') {
      assert.equal(params.sortDirection, 'desc')
      assert.equal(params.itemsView, 'full')
      return params.cursor === 'turn-anchor' ? { data: [{ id: 't2', items: [item('c')], itemsView: 'full' }], nextCursor: 'older' }
        : { data: [{ id: 't1', items: [item('a')], itemsView: 'full' }], nextCursor: null } as any
    }
    assert.equal(method, 'thread/items/list')
    return params.cursor === 'item-anchor' ? { data: [{ turnId: 't2', item: item('c') }, { turnId: 't2', item: item('b') }], nextCursor: 'old-items' }
      : { data: [{ turnId: 't1', item: item('a') }], nextCursor: null } as any
  }
  await hub.resumeThread('task', 'old', { cwd: '/tmp', approvalPolicy: 'never', sandbox: 'danger-full-access' })
  assert.deepEqual(patches.findLast(p => p.blocks)?.blocks?.filter(b => b.kind === 'message').map(b => b.text), ['a', 'b', 'c'])
})

test('persisted submission metadata restores original names without conflating repeated paths', async () => {
  const f = fakeServer()
  const patches: HubPatch[] = []
  const saved: any[] = []
  const hub = new CodexHub({ resolveBin: async () => 'codex', onPatch: p => patches.push(p), makeServer: () => f.srv,
    saveInputMetadata: async (_task, _thread, record) => { const i = saved.findIndex(r => r.id === record.id); if (i < 0) saved.push(record); else saved[i] = record }, loadInputMetadata: async () => saved })
  const opts = { cwd: '/tmp', approvalPolicy: 'never', sandbox: 'danger-full-access' }
  await hub.startThread('task', opts)
  for (const name of ['First.png', 'Second.png']) {
    await hub.send('task', 'look', { ordered: [{ type: 'text', text: 'look' }, { type: 'image', path: '/tmp/same.png', name, mimeType: 'image/png' }] })
    f.emit('turn/completed', { threadId: 'th_1', turn: { id: 'turn-1', status: 'completed' } })
  }
  assert.equal(saved.length, 2)
  f.srv.request = async () => ({ thread: { id: 'th_1', turns: [{ id: 'turn-1', items: ['u1', 'u2'].map(id => ({ id, type: 'userMessage', content: [{ type: 'text', text: 'look' }, { type: 'localImage', path: '/tmp/same.png' }] })) }] } }) as any
  await hub.resumeThread('task', 'th_1', opts, true)
  assert.deepEqual(patches.findLast(p => p.blocks)?.blocks?.filter(b => b.kind === 'attachment').map(b => b.name), ['First.png', 'Second.png'])
})

test('summary turns hydrate full items and repeated cursors fail explicitly', async () => {
  const { hub, srv, patches } = makeHub()
  let repeat = false
  srv.request = async (method) => method === 'thread/resume'
    ? { thread: { id: 'old', turns: [{ id: 't', itemsView: 'summary', items: [{ id: 'm', type: 'agentMessage', text: 'short' }] }] } } as any
    : { data: [{ turnId: 't', item: { id: 'm', type: 'agentMessage', text: 'complete original text' } }], nextCursor: repeat ? 'loop' : null } as any
  const opts = { cwd: '/tmp', approvalPolicy: 'never', sandbox: 'danger-full-access' }
  await hub.resumeThread('task', 'old', opts)
  assert.ok(patches.findLast(p => p.blocks)?.blocks?.some(b => b.kind === 'message' && b.text === 'complete original text'))
  repeat = true
  await assert.rejects(hub.resumeThread('task', 'old', opts, true), /repeated a cursor/)
})

test('transport loss retains thread identity and refuses an unconfirmed new turn', async () => {
  const { hub, emit, patches, srv } = makeHub()
  await hub.startThread('task', { cwd: '/tmp', approvalPolicy: 'never', sandbox: 'danger-full-access' })
  emit('transport/disconnected', { reason: 'socket closed' })
  assert.match(patches.at(-1)?.errorReason ?? '', /connection/i)
  assert.equal(hub.threadIdFor('task'), 'th_1')
  assert.equal(await hub.send('task', 'do more'), false)
})

test('resume restores active turn and routes notifications received during resume', async () => {
  const { hub, srv, emit, patches } = makeHub()
  srv.request = async () => {
    emit('item/agentMessage/delta', { threadId: 'old', itemId: 'live', delta: 'Live' })
    return { thread: { id: 'old', turns: [{ id: 'active', status: 'inProgress', items: [] }] } } as any
  }
  await hub.resumeThread('task', 'old', { cwd: '/tmp', approvalPolicy: 'never', sandbox: 'danger-full-access' })
  assert.equal(await hub.send('task', 'duplicate'), false)
  assert.ok(patches.some(p => p.blocks?.some(b => b.kind === 'message' && b.text === 'Live')))
})

test('interrupt during submission waits for the actual turn id', async () => {
  const { hub, srv, calls } = makeHub()
  await hub.startThread('task', { cwd: '/tmp', approvalPolicy: 'never', sandbox: 'danger-full-access' })
  const request = srv.request.bind(srv)
  let finish!: (v: any) => void
  srv.request = (method, params) => method === 'turn/start' ? new Promise(resolve => { finish = resolve }) : request(method, params)
  const send = hub.send('task', 'work')
  const stop = hub.interrupt('task')
  assert.equal(calls.some(c => c.method === 'turn/interrupt'), false)
  finish({ turn: { id: 'later-turn' } })
  await send
  assert.equal(await stop, true)
  assert.deepEqual(calls.at(-1), { method: 'turn/interrupt', params: { threadId: 'th_1', turnId: 'later-turn' } })
})

test('failed approval delivery remains answerable', async () => {
  const { hub, ask } = makeHub()
  await hub.startThread('task', { cwd: '/tmp', approvalPolicy: 'on-request', sandbox: 'workspace-write' })
  let fail = true
  const reply = ask({ id: 9, method: 'item/commandExecution/requestApproval', params: { threadId: 'th_1' },
    respond: () => { if (fail) throw new Error('socket closed') } })
  assert.equal(hub.answer('task', 'Approve'), false)
  fail = false
  assert.equal(hub.answer('task', 'Deny'), true)
  assert.deepEqual(await reply, { decision: 'decline' })
})

test('multiple questions and queued requests keep their own answer identities', async () => {
  const { hub, ask, patches } = makeHub()
  await hub.startThread('task', { cwd: '/tmp', approvalPolicy: 'on-request', sandbox: 'workspace-write' })
  const questions = ask({ id: 1, method: 'item/tool/requestUserInput', params: { threadId: 'th_1', questions: [
    { id: 'a', question: 'Which project?', options: [{ label: 'App' }] }, { id: 'b', question: 'What name?' },
  ] } })
  const approval = ask({ id: 2, method: 'item/fileChange/requestApproval', params: { threadId: 'th_1' } })
  hub.answer('task', 'App')
  assert.equal(patches.at(-1)?.question?.text, 'What name?')
  hub.answer('task', 'Example')
  assert.deepEqual(await questions, { answers: { a: { answers: ['App'] }, b: { answers: ['Example'] } } })
  assert.equal(patches.at(-1)?.state, 'needs-user')
  hub.answer('task', 'Deny')
  assert.deepEqual(await approval, { decision: 'decline' })
})

test('resume uses the recorded thread and policy without resubmitting a prompt', async () => {
  const { hub, calls } = makeHub()
  await hub.resumeThread('task', 'recorded-thread', { cwd: '/project', approvalPolicy: 'never', sandbox: 'danger-full-access' })
  assert.equal(hub.threadIdFor('task'), 'recorded-thread')
  assert.deepEqual(calls.map((c) => c.method), ['thread/resume'])
  await hub.resumeThread('task', 'recorded-thread', { cwd: '/project', approvalPolicy: 'never', sandbox: 'danger-full-access' })
  assert.equal(calls.length, 1)
})

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

test('REGRESSION: a display label is never sent as a model id', async () => {
  // 'gpt-5.6-terra high' is model+effort joined for a card. It reached
  // thread/start once and every Codex task died at the API:
  //   "The 'gpt-5.6-terra high' model is not supported when using Codex with a
  //    ChatGPT account."
  // The caller was fixed; this asserts the CLASS is refused, because the next
  // thing to hand a human-readable string to a machine field will not be that
  // caller.
  const { hub, calls } = makeHub()
  await hub.startThread('task-a', {
    cwd: '/tmp/a', approvalPolicy: 'never', sandbox: 'danger-full-access',
    model: 'gpt-5.6-terra high',
  })
  const start = calls.find((c) => c.method === 'thread/start')!.params as Record<string, unknown>
  assert.equal(start.model, undefined, 'a label must be dropped, not forwarded')
  // Dropped, not fatal: no model means Codex's own default, which runs. Failing
  // the task over a display bug would turn a wrong label into no work at all.
  assert.equal(hub.threadIdFor('task-a'), 'th_1')
})

test('a real wire id passes through untouched', async () => {
  const { hub, calls } = makeHub()
  await hub.startThread('task-a', {
    cwd: '/tmp/a', approvalPolicy: 'never', sandbox: 'workspace-write', model: 'gpt-5.6-luna',
  })
  const start = calls.find((c) => c.method === 'thread/start')!.params as Record<string, unknown>
  assert.equal(start.model, 'gpt-5.6-luna')
})

test('effort rides on the turn, not the thread', async () => {
  // thread/start has no effort parameter; turn/start does. Sent on the wrong
  // one it is silently ignored, and the Effort axis becomes a control that
  // moves a setting Codex never sees.
  const { hub, calls } = makeHub()
  await hub.startThread('task-a', { cwd: '/tmp/a', approvalPolicy: 'never', sandbox: 'workspace-write', model: 'gpt-5.6-sol' })
  await hub.send('task-a', 'go', { effort: 'xhigh' })
  const start = calls.find((c) => c.method === 'thread/start')!.params as Record<string, unknown>
  const turn = calls.find((c) => c.method === 'turn/start')!.params as Record<string, unknown>
  assert.equal(start.effort, undefined)
  assert.equal(turn.effort, 'xhigh')
})

test('attachments are native localImage inputs, never filesystem paths in text', async () => {
  const { hub, calls } = makeHub()
  await hub.startThread('task-a', { cwd: '/tmp/a', approvalPolicy: 'never', sandbox: 'workspace-write' })

  assert.equal(await hub.send('task-a', 'compare these', {
    effort: 'high', attachments: ['/tmp/one.png', '/tmp/two.png'],
  }), true)

  const turn = calls.find((c) => c.method === 'turn/start')!.params as Record<string, any>
  assert.deepEqual(turn.input, [
    { type: 'text', text: 'compare these' },
    { type: 'localImage', path: '/tmp/one.png' },
    { type: 'localImage', path: '/tmp/two.png' },
  ])
  assert.doesNotMatch(JSON.stringify(turn.input[0]), /\/tmp\/one\.png/)
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
  await assert.rejects(ask({ id: 2, method: 'some/futureApproval', params: { threadId: 'th_1' } }), /Unsupported Codex request/)
})

test('malformed question sets are rejected explicitly and MCP forms are never empty-approved', async () => {
  const { hub, ask, patches } = makeHub()
  await hub.startThread('task', { cwd: '/tmp', approvalPolicy: 'on-request', sandbox: 'workspace-write' })
  await assert.rejects(ask({ id: 1, method: 'item/tool/requestUserInput', params: { threadId: 'th_1', questions: [] } }), /Malformed/)
  assert.deepEqual(await ask({ id: 2, method: 'mcpServer/elicitation/request', params: { threadId: 'th_1', mode: 'form', requestedSchema: { type: 'object' } } }), { action: 'decline' })
  assert.match(patches.at(-1)?.errorReason ?? '', /MCP/)
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
  await hub.send('task-a', 'also working')
  await hub.interrupt('task-a')
  const turn = calls.find((c) => c.method === 'turn/start')!.params as Record<string, unknown>
  const stop = calls.find((c) => c.method === 'turn/interrupt')!.params as Record<string, unknown>
  assert.equal(turn.threadId, 'th_2')
  assert.equal(stop.threadId, 'th_1')
  assert.equal(hub.threadIdFor('task-a'), 'th_1')
})

test('stopAndRelease confirms the active turn stopped before forgetting its task mapping', async () => {
  const { hub, calls } = makeHub()
  await hub.startThread('task-a', { cwd: '/tmp/a', approvalPolicy: 'never', sandbox: 'workspace-write' })
  await hub.send('task-a', 'working')

  assert.equal(await hub.stopAndRelease('task-a'), true)

  assert.ok(calls.some((call) => call.method === 'turn/interrupt'))
  assert.equal(hub.threadIdFor('task-a'), undefined)
})

test('a task with no thread fails softly rather than throwing into dispatch', async () => {
  const { hub } = makeHub()
  assert.equal(await hub.send('ghost', 'hi'), false)
  assert.equal(await hub.interrupt('ghost'), false)
  assert.equal(hub.answer('ghost', 'yes'), false)
  hub.release('ghost')   // must not throw
})
