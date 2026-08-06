import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseHookEvent,
  isAnswerable,
  type AskQuestion,
  summarize,
  plainLine,
  endsWithQuestion,
  deriveCategory,
  deriveStatus,
  type ObserverContext,
} from './observer.ts'

const NOW = '2026-08-06T00:00:00.000Z'
const ctx = (o: Partial<ObserverContext> = {}): ObserverContext => ({ kind: 'oneoff', now: NOW, ...o })

// ─── Reading what a session emits ───────────────────────────────────────────

test('parseHookEvent maps the five events we wire', () => {
  const base = { session_id: 's1', cwd: '/repo' }
  assert.equal(parseHookEvent({ ...base, hook_event_name: 'UserPromptSubmit' })?.kind, 'prompt-submitted')
  assert.equal(parseHookEvent({ ...base, hook_event_name: 'PostToolUse', tool_name: 'Read' })?.kind, 'tool-used')
  assert.equal(parseHookEvent({ ...base, hook_event_name: 'Stop', last_assistant_message: 'hi' })?.kind, 'turn-ended')
  assert.equal(parseHookEvent({ ...base, hook_event_name: 'Notification', message: 'm' })?.kind, 'waiting')
  assert.equal(parseHookEvent({ ...base, hook_event_name: 'SessionEnd', reason: 'clear' })?.kind, 'session-ended')
})

test('an unknown event is ignorable, never fatal', () => {
  // Claude Code keeps adding hook events. A new one must not break a task.
  assert.equal(parseHookEvent({ session_id: 's', hook_event_name: 'WorktreeCreate' }), null)
  assert.equal(parseHookEvent({ hook_event_name: 'Stop' }), null) // no session_id ⇒ no identity
  assert.equal(parseHookEvent('nonsense'), null)
  assert.equal(parseHookEvent(null), null)
})

// ─── Turning a reply into a headline ────────────────────────────────────────

test('summarize takes the first real line, without the markdown', () => {
  assert.equal(summarize('## **Done** — `main` is clean\n\nmore prose'), 'Done — main is clean')
  assert.equal(summarize('\n\n---\n\nThe answer is 42.'), 'The answer is 42.')
  assert.equal(summarize(''), '')
})

test('summarize caps a long first line rather than speaking a paragraph', () => {
  const out = summarize('x'.repeat(400), 50)
  assert.equal(out.length, 50)
  assert.ok(out.endsWith('…'))
})

test('plainLine strips links to their text', () => {
  assert.equal(plainLine('- see [the docs](https://x.dev) here'), 'see the docs here')
})

// ─── Blocked vs finished ────────────────────────────────────────────────────

test('a short trailing question means the session is waiting on the user', () => {
  assert.equal(endsWithQuestion('I found two candidates.\n\nWhich one should I use?'), true)
})

test('a long trailing line ending in "?" is NOT treated as a question', () => {
  // Conservative on purpose: mislabelling a finished task as blocked parks it
  // in the user's queue forever, which is the worse of the two errors.
  const rhetorical = `Here is the summary. ${'and more detail '.repeat(20)}right?`
  assert.equal(endsWithQuestion(rhetorical), false)
})

test('a question that is not the last thing said does not count', () => {
  assert.equal(endsWithQuestion('Should I refactor this?\n\nI went ahead and did it.'), false)
})

// ─── Category, from evidence rather than instruction ────────────────────────

test('deriveCategory: media surfaces play, mutation acts, links navigate, else info', () => {
  assert.equal(deriveCategory(ctx({ surface: 'youtube' }), []), 'watch')
  assert.equal(deriveCategory(ctx({ surface: 'jiohotstar' }), ['https://x']), 'watch')
  assert.equal(deriveCategory(ctx({ sideEffects: true }), []), 'act')
  assert.equal(deriveCategory(ctx(), ['https://example.com']), 'navigate')
  assert.equal(deriveCategory(ctx(), []), 'info')
})

// ─── The state machine ──────────────────────────────────────────────────────

test('a heartbeat is liveness, not news', () => {
  assert.equal(deriveStatus({ kind: 'tool-used', sessionId: 's' }, ctx()), null)
})

test('a finished one-off is done; a session that finished a step is ready', () => {
  const msg = 'Renamed the file and pushed.'
  assert.equal(deriveStatus({ kind: 'turn-ended', sessionId: 's', lastMessage: msg }, ctx({ kind: 'oneoff' }))?.state, 'done')
  assert.equal(deriveStatus({ kind: 'turn-ended', sessionId: 's', lastMessage: msg }, ctx({ kind: 'session' }))?.state, 'ready')
})

test("the reply IS the result — verbatim, with a headline and its links", () => {
  const msg = '**Found it.**\n\nThe page is at https://example.com/pricing'
  const s = deriveStatus({ kind: 'turn-ended', sessionId: 's', lastMessage: msg }, ctx())!
  assert.equal(s.result?.detail, msg, 'the model\'s own prose must survive untouched')
  assert.equal(s.result?.summary, 'Found it.')
  assert.deepEqual(s.result?.artifacts, [{ type: 'url', value: 'https://example.com/pricing' }])
  assert.equal(s.category, 'navigate')
  assert.ok(s.thread_context && s.thread_context.length > 0)
})

test('a trailing question is an OFFER — ready, not blocked, and not a question box', () => {
  // It used to set needs-user, and it was the only thing that ever could. So a
  // finished answer ending "Want me to spec that first?" became a task
  // demanding a reply, shown as one line with a text box and none of the
  // reasoning that made it answerable. The turn ENDED — nothing is blocked.
  const s = deriveStatus(
    { kind: 'turn-ended', sessionId: 's', lastMessage: 'Two options exist.\n\nWhich do you want?' },
    ctx({ kind: 'oneoff' }),
  )!
  assert.equal(s.state, 'ready')
  assert.equal(s.question, undefined, 'no fake question box')
  assert.match(s.result!.detail!, /Two options exist/, 'the reasoning is still there in full')
})



test('a permission request names the command, because "Allow Bash?" is unanswerable', () => {
  const s = deriveStatus({ kind: 'permission-asked', sessionId: 's', tool: 'Bash', summary: 'rm -rf /tmp/x' }, ctx())!
  assert.equal(s.state, 'needs-user')
  assert.match(s.question!.text, /rm -rf \/tmp\/x/)
  assert.deepEqual(s.question?.choices, ['Allow', 'Deny'])
})


test('PreToolUse for any OTHER tool is not an ask', () => {
  assert.equal(parseHookEvent({ session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }), null)
})


test('a session that dies mid-work fails; one that dies after finishing does not', () => {
  assert.equal(deriveStatus({ kind: 'session-ended', sessionId: 's' }, ctx({ prior: 'processing' }))?.state, 'failed')
  assert.equal(deriveStatus({ kind: 'session-ended', sessionId: 's' }, ctx({ prior: 'done' })), null)
  assert.equal(deriveStatus({ kind: 'session-ended', sessionId: 's' }, ctx({ prior: 'ready' })), null)
})

test('when it cannot tell, it says so instead of inventing a result', () => {
  // A turn that produced no prose. The honest answer is "finished, but I have
  // nothing to report" — never a confident summary of work we did not observe.
  const s = deriveStatus({ kind: 'turn-ended', sessionId: 's', lastMessage: '   ' }, ctx())!
  assert.equal(s.state, 'done')
  assert.match(s.result!.summary, /without a written reply/)
  assert.equal(s.result?.detail, undefined)
})

// ─── The ask channel is not last-writer-wins ────────────────────────────────





test('we never ask permission to ask a question', () => {
  // Claude Code fires PermissionRequest for AskUserQuestion itself, which
  // produced "Allow AskUserQuestion?" on the card before the real question.
  assert.equal(parseHookEvent({
    session_id: 's', hook_event_name: 'PermissionRequest',
    tool_name: 'AskUserQuestion', tool_input: { questions: [] },
  }), null)
})

// ─── An ask is an INTERVAL, keyed by tool_use_id ────────────────────────────

const askPayload = (questions: unknown[], id = 'toolu_1') => ({
  session_id: 's', prompt_id: 'p1', hook_event_name: 'PreToolUse',
  tool_name: 'AskUserQuestion', tool_use_id: id, tool_input: { questions },
})

test('an ask opens with EVERY question it declared, not just the first', () => {
  // Verified live: one call carried two questions, and reading questions[0]
  // silently dropped half the ask.
  const e = parseHookEvent(askPayload([
    { question: 'Colour?', header: 'Colour', multiSelect: false, options: [{ label: 'Blue', description: 'cool' }, { label: 'Red' }] },
    { question: 'Languages?', header: 'Languages', multiSelect: true, options: [{ label: 'Go' }, { label: 'Rust' }] },
  ])) as { kind: string; askId: string; questions: AskQuestion[] }
  assert.equal(e.kind, 'ask-opened')
  assert.equal(e.askId, 'toolu_1')
  assert.equal(e.questions.length, 2)
  assert.equal(e.questions[1].multiSelect, true)
  assert.equal(e.questions[0].options[0].description, 'cool')
})

test('the same tool_use_id closes it, carrying what actually registered', () => {
  // tool_response.answers — NOT tool_output, which the docs named and which is
  // null in practice.
  const e = parseHookEvent({
    session_id: 's', hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion',
    tool_use_id: 'toolu_1', tool_output: null,
    tool_response: { answers: { 'Colour?': 'Blue', 'Languages?': 'Go, Rust' } },
  }) as { kind: string; askId: string; answers: Record<string, string> }
  assert.equal(e.kind, 'ask-closed')
  assert.equal(e.askId, 'toolu_1')
  assert.equal(e.answers['Languages?'], 'Go, Rust')
})

test('askId falls back to prompt_id, because PermissionRequest has none', () => {
  // Verified live: PermissionRequest arrived with tool_use_id NULL.
  const e = parseHookEvent(askPayload([{ question: 'Q?', multiSelect: false, options: [{ label: 'A' }] }], null as unknown as string))
  assert.equal((e as { askId: string }).askId, 'p1')
})

test('only a single single-select ask is answerable by us', () => {
  const one = [{ question: 'Q?', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] }]
  assert.equal(isAnswerable(one), true)
  assert.equal(isAnswerable([...one, { question: 'Q2?', multiSelect: false, options: [{ label: 'C' }] }]), false, 'tab bar')
  assert.equal(isAnswerable([{ question: 'Q?', multiSelect: true, options: [{ label: 'A' }] }]), false, 'checkboxes')
  assert.equal(isAnswerable([{ question: 'Q?', multiSelect: false, options: [] }]), false, 'nothing to pick')
})

test('an answerable ask renders chips; a complex one says use the terminal', () => {
  const simple = deriveStatus({ kind: 'ask-opened', sessionId: 's', askId: 'a', questions: [
    { question: 'Tabs or spaces?', multiSelect: false, options: [{ label: 'Tabs' }, { label: 'Spaces' }] }] }, ctx())!
  assert.equal(simple.state, 'needs-user')
  assert.deepEqual(simple.question?.choices, ['Tabs', 'Spaces'])

  const complex = deriveStatus({ kind: 'ask-opened', sessionId: 's', askId: 'a', questions: [
    { question: 'Colour?', multiSelect: false, options: [{ label: 'Blue' }] },
    { question: 'Languages?', multiSelect: true, options: [{ label: 'Go' }] }] }, ctx())!
  assert.equal(complex.question?.kind, 'free_text', 'no chips we cannot honour')
  assert.equal(complex.question?.choices, undefined)
  assert.match(complex.question!.text, /2 questions/)
  assert.match(complex.question!.text, /terminal/)
})

test('closing an ask returns the task to work, however it was answered', () => {
  const s = deriveStatus({ kind: 'ask-closed', sessionId: 's', askId: 'a', answers: {} }, ctx())!
  assert.equal(s.state, 'processing')
})

test('a Notification is never state — it is liveness', () => {
  // Unkeyed, content-free, and async with no ordering guarantee. It buried a
  // real question and its options under "Claude needs your permission".
  assert.equal(deriveStatus({ kind: 'waiting', sessionId: 's', message: 'Claude needs your permission', notificationType: 'permission_prompt' }, ctx()), null)
  assert.equal(deriveStatus({ kind: 'waiting', sessionId: 's', message: 'x', notificationType: 'idle_prompt' }, ctx()), null)
})

test('a plan awaiting approval is an ask, carrying the plan itself', () => {
  // Verified live: ExitPlanMode's tool_input has `plan` (full markdown) and
  // `planFilePath`. Before this, our matcher named only AskUserQuestion, so a
  // plan approval reached us as NOTHING — the card sat at processing while the
  // terminal held a picker nobody could see.
  const e = parseHookEvent({
    session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'ExitPlanMode',
    tool_use_id: 'toolu_p', tool_input: { plan: '# Add a --version flag\n\n## Context\n…', planFilePath: '/p.md' },
  }) as { kind: string; askId: string; questions: AskQuestion[] }
  assert.equal(e.kind, 'ask-opened')
  assert.equal(e.askId, 'toolu_p')
  assert.match(e.questions[0].question, /--version flag/)
  assert.equal(isAnswerable(e.questions), false, 'we have not proven we can drive its picker')
})

test('a plan ask closes on its own PostToolUse', () => {
  const e = parseHookEvent({
    session_id: 's', hook_event_name: 'PostToolUse', tool_name: 'ExitPlanMode',
    tool_use_id: 'toolu_p', tool_response: {},
  })
  assert.equal(e?.kind, 'ask-closed')
})
