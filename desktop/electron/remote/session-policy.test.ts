import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SESSION_PREAMBLE,
  ALLOWED_FLAGS,
  flagsIn,
  flagsAllowed,
  browserFor,
  hookCommand,
  buildHookSettings,
  HOOK_PATH,
} from './session-policy.ts'
import { claudeLaunchArgs } from './pty-session.ts'

// ─── The no-modification guard ──────────────────────────────────────────────
//
// THE POINT OF THIS FILE. "Unmute observes a session, it never modifies one" is
// a principle that decays one reasonable-seeming line at a time — every single
// thing in the deleted 244-line contract was added for a good reason. So the
// principle is a test, not a memo: adding a flag that reshapes the user's
// session fails here before it can ship.

test('a launch adds NOTHING beyond the allowed flags', () => {
  const argv = claudeLaunchArgs({
    model: 'opus',
    chrome: true,
    settingsPath: '/u/.unmute/remote/session-hooks.json',
    appendSystemPrompt: SESSION_PREAMBLE,
    extraArgs: ['--dangerously-skip-permissions'],
    addDirs: ['/repo'],
  })
  assert.ok(flagsAllowed(argv), `unexpected flag: ${flagsIn(argv).filter((f) => !ALLOWED_FLAGS.includes(f))}`)
})

test('with nothing chosen, a launch adds nothing at all', () => {
  // The default shape: no model pin, no browser, no sandbox. A session started
  // like this is indistinguishable from one the user started themselves.
  assert.deepEqual(claudeLaunchArgs({}), [])
})

test('an absent model means NO --model flag (the user keeps their own default)', () => {
  assert.equal(claudeLaunchArgs({ model: '' }).includes('--model'), false)
  assert.equal(claudeLaunchArgs({}).includes('--model'), false)
  // ...and an explicit pick is still honoured — that one IS the user's decision.
  assert.deepEqual(claudeLaunchArgs({ model: 'opus' }), ['--model', 'opus'])
})

test('the preamble is framing, not a protocol', () => {
  const lines = SESSION_PREAMBLE.split('\n')
  assert.ok(lines.length <= 6, `preamble grew to ${lines.length} lines`)
  assert.ok(SESSION_PREAMBLE.length < 600, `preamble grew to ${SESSION_PREAMBLE.length} chars`)
  // The specific things that must never come back. Each one used to be in the
  // contract; each one is now observed, pushed by a hook, or dead.
  for (const banned of ['status.json', 'schema_version', 'atomically', 'heartbeat', 'recipe', 'librarian']) {
    assert.ok(!SESSION_PREAMBLE.toLowerCase().includes(banned), `preamble mentions "${banned}" again`)
  }
})

// ─── Browser control follows the task, not a global switch ──────────────────

test('browserFor: a project-bound session never gets browser control', () => {
  assert.equal(browserFor({ surface: 'gmail', projectBound: true }), false)
  assert.equal(browserFor({ surface: null, projectBound: true }), false)
})

test('browserFor: web errands keep it, native/unknown behave sensibly', () => {
  assert.equal(browserFor({ surface: 'gmail', projectBound: false }), true)
  assert.equal(browserFor({ surface: 'youtube', projectBound: false }), true)
  assert.equal(browserFor({ surface: 'macos', projectBound: false }), false)
  // An unclassified one-off keeps the browser: spoken errands are usually
  // web-shaped, and losing it there would be a real regression.
  assert.equal(browserFor({ surface: null, projectBound: false }), true)
  assert.equal(browserFor({ surface: 'general', projectBound: false }), true)
})

// ─── Hook wiring ────────────────────────────────────────────────────────────

test('hookCommand forwards the hook payload verbatim to loopback, with auth', () => {
  const cmd = hookCommand(42117, 'tok-123')
  assert.match(cmd, /--data-binary @-/)                 // stdin JSON, unmodified
  assert.match(cmd, /Authorization: Bearer tok-123/)
  assert.match(cmd, new RegExp(`http://127\\.0\\.0\\.1:42117${HOOK_PATH}`))
  assert.match(cmd, /-m 2/)                              // an unreachable Unmute costs 2s, never a hang
  assert.ok(!cmd.includes('jq'), 'must not depend on jq')
})

test('every hook is async, so Unmute can never delay a turn', () => {
  const s = buildHookSettings(42117, 't') as { hooks: Record<string, Array<{ hooks: Array<Record<string, unknown>> }>> }
  const events = Object.keys(s.hooks)
  assert.deepEqual(
    events.sort(),
    ['Notification', 'PostToolUse', 'SessionEnd', 'Stop', 'UserPromptSubmit'].sort(),
  )
  for (const ev of events) {
    for (const group of s.hooks[ev]) {
      for (const h of group.hooks) {
        assert.equal(h.async, true, `${ev} hook is not async`)
        assert.equal(h.type, 'command')
      }
    }
  }
})

test('no hook blocks or speaks to the model', () => {
  // The old Stop hook returned {"decision":"block"} and interrupted the end of
  // every turn to demand a status write. Hooks report OUT; they never talk back.
  const raw = JSON.stringify(buildHookSettings(42117, 't'))
  assert.ok(!raw.includes('decision'), 'a hook returns a decision to the model')
  assert.ok(!raw.includes('block'), 'a hook blocks the model')
})
