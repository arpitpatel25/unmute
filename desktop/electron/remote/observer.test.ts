import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseHookEvent,
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

test('a trailing question outranks the kind and becomes the question', () => {
  const s = deriveStatus(
    { kind: 'turn-ended', sessionId: 's', lastMessage: 'Two options exist.\n\nWhich do you want?' },
    ctx({ kind: 'oneoff' }),
  )!
  assert.equal(s.state, 'needs-user')
  assert.equal(s.question?.text, 'Which do you want?')
})

test('a permission prompt blocks; other notifications are not state', () => {
  const blocked = deriveStatus(
    { kind: 'waiting', sessionId: 's', message: 'Claude needs permission to run git push', notificationType: 'permission_prompt' },
    ctx(),
  )!
  assert.equal(blocked.state, 'needs-user')
  assert.match(blocked.question!.text, /permission/)
  // An idle nudge must never park a working task in the user's queue.
  assert.equal(deriveStatus({ kind: 'waiting', sessionId: 's', message: 'still there?', notificationType: 'idle_prompt' }, ctx()), null)
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
