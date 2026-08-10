import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  reduceAppServerEvent, questionFromApproval, approvalDecision,
  type AppServerEvent, type CodexPatch,
} from './app-server-events.ts'

/** Fold a stream the way the live layer does, so the tests exercise ordering
 *  rather than one event at a time. */
function fold(events: AppServerEvent[]): CodexPatch {
  const out: CodexPatch = {}
  for (const e of events) {
    const p = reduceAppServerEvent(e)
    if (!p) continue
    if ('activity' in p) out.activity = p.activity
    if (p.state) out.state = p.state
    if (p.threadId) out.threadId = p.threadId
    if (p.assistantText) out.assistantText = (out.assistantText ?? '') + p.assistantText
    if (p.errorReason) out.errorReason = p.errorReason
    if (p.clearQuestion) out.clearQuestion = true
  }
  return out
}

test('a real turn: started → work → reply → completed', () => {
  // The exact sequence observed from codex-cli 0.147 in the live probe.
  const r = fold([
    { method: 'thread/started', params: { threadId: 'th_1' } },
    { method: 'turn/started', params: {} },
    { method: 'item/started', params: { item: { type: 'commandExecution', command: 'whoami' } } },
    { method: 'item/completed', params: { item: { type: 'commandExecution' } } },
    { method: 'item/started', params: { item: { type: 'agentMessage' } } },
    { method: 'item/completed', params: { item: { type: 'agentMessage', text: 'zodpatel' } } },
    { method: 'turn/completed', params: { turn: { status: 'completed' } } },
  ])
  assert.equal(r.threadId, 'th_1')
  assert.equal(r.state, 'done')
  assert.equal(r.assistantText, 'zodpatel')
  assert.equal(r.activity, null, 'a finished task must not still claim to be running something')
})

test('THE BUG: a completed turn does not end a session', () => {
  // Codex emits turn/completed after EVERY exchange while the thread stays
  // idle. The rollout reader treated that as the task finishing, the PTY was
  // reaped, and the stage announced "Session ended" over a live conversation.
  //
  // `done` is still the right STATE here — for a session it means "finished
  // this step, waiting for you". What must not happen is the thread being
  // treated as gone, which is why thread/status idle is a separate signal that
  // reports no state at all.
  const idle = reduceAppServerEvent(
    { method: 'thread/status/changed', params: { status: { type: 'idle' } } })
  assert.equal(idle, null, 'idle must not decide a state — turn/completed owns that')

  // And the next turn reopens it cleanly.
  const r = fold([
    { method: 'turn/completed', params: { turn: { status: 'completed' } } },
    { method: 'turn/started', params: {} },
  ])
  assert.equal(r.state, 'processing')
  assert.equal(r.clearQuestion, true)
})

test('interrupted is done, not failed', () => {
  // Pressing Esc is the ordinary way to stop a turn you have seen enough of.
  // Mapping it to `failed` made every deliberate stop demand attention — the
  // same mistake the rollout reader made with turn_aborted, where five of
  // twelve real sessions ended that way.
  const r = fold([{ method: 'turn/completed', params: { turn: { status: 'interrupted' } } }])
  assert.equal(r.state, 'done')
  assert.equal(r.errorReason, undefined)
})

test('a failed turn carries its reason; a system error fails the task', () => {
  const f = fold([{ method: 'turn/completed', params: { turn: { status: 'failed', error: { message: 'model refused' } } } }])
  assert.equal(f.state, 'failed')
  assert.equal(f.errorReason, 'model refused')

  const sys = reduceAppServerEvent(
    { method: 'thread/status/changed', params: { status: { type: 'systemError' } } })
  assert.equal(sys?.state, 'failed')
})

test('activity tracks the work and clears when it stops', () => {
  const running = reduceAppServerEvent(
    { method: 'item/started', params: { item: { type: 'commandExecution', command: 'npm test' } } })
  assert.deepEqual(running?.activity, { kind: 'running', label: 'npm test' })

  const web = reduceAppServerEvent(
    { method: 'item/started', params: { item: { type: 'webSearch', query: 'swift charts' } } })
  assert.deepEqual(web?.activity, { kind: 'searching', label: 'swift charts' })

  // Explicitly null, not absent: absent would leave the last command on screen.
  const stopped = reduceAppServerEvent({ method: 'item/completed', params: { item: { type: 'commandExecution' } } })
  assert.ok(stopped && 'activity' in stopped && stopped.activity === null)
})

test('an agent message is captured whichever field this version used', () => {
  // Three shapes have been seen across Codex versions. Betting on one is
  // exactly how the reply stopped being captured at 0.147.
  for (const item of [
    { type: 'agentMessage', text: 'hello' },
    { type: 'agentMessage', message: 'hello' },
    { type: 'agentMessage', content: [{ type: 'text', text: 'hel' }, { type: 'text', text: 'lo' }] },
  ]) {
    const r = reduceAppServerEvent({ method: 'item/completed', params: { item } })
    assert.equal(r?.assistantText, 'hello', JSON.stringify(item))
  }
})

test('a user message is never mistaken for the agent speaking', () => {
  const r = reduceAppServerEvent(
    { method: 'item/completed', params: { item: { type: 'userMessage', text: 'do the thing' } } })
  assert.equal(r?.assistantText, undefined)
})

test('noise is ignored, and ignoring it is explicit', () => {
  for (const m of ['thread/tokenUsage/updated', 'account/rateLimits/updated',
    'mcpServer/startupStatus/updated', 'fuzzyFileSearch/sessionUpdated', 'remoteControl/status/changed']) {
    assert.equal(reduceAppServerEvent({ method: m, params: {} }), null, m)
  }
})

test('all seven blocking requests become one answerable question', () => {
  // Codex distinguishes a command from a patch from a permission grant; the
  // person looking at the card needs one thing: what is being asked.
  const cases: Array<[string, unknown, string]> = [
    ['execCommandApproval', { command: 'rm -rf build' }, 'rm -rf build'],
    ['item/commandExecution/requestApproval', { command: 'npm i' }, 'npm i'],
    ['applyPatchApproval', { fileChanges: { 'a.ts': {}, 'b.ts': {} } }, '2 files'],
    ['item/fileChange/requestApproval', { fileChanges: { 'a.ts': {} } }, '1 file'],
    ['item/permissions/requestApproval', { reason: 'network access' }, 'network access'],
    ['mcpServer/elicitation/request', { message: 'Pick a database' }, 'Pick a database'],
    ['item/tool/requestUserInput', { prompt: 'Which branch?' }, 'Which branch?'],
  ]
  for (const [method, params, needle] of cases) {
    const q = questionFromApproval(method, params)
    assert.ok(q, `${method} produced no question`)
    assert.ok(q!.text.includes(needle), `${method}: ${q!.text}`)
    assert.deepEqual(q!.choices, ['Approve', 'Deny'])
    assert.equal(q!.kind, 'confirm')
  }
  assert.equal(questionFromApproval('account/chatgptAuthTokens/refresh', {}), null)
})

test('an answer becomes a decision Codex accepts, and defaults to denied', () => {
  for (const yes of ['yes', 'Yes', 'approve', 'Approved', 'allow', 'ok', 'go ahead']) {
    assert.equal(approvalDecision(yes), 'approved', yes)
  }
  // ANYTHING UNRECOGNISED IS A DENIAL. A misread "no" that runs the command is
  // worse in every case than a misread "yes" that does not.
  for (const no of ['no', 'deny', 'stop', 'wait', '', 'hmm']) {
    assert.equal(approvalDecision(no), 'denied', no)
  }
})
