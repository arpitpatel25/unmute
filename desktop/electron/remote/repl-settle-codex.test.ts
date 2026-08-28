import { test } from 'node:test'
import assert from 'node:assert/strict'
import { settleRepl } from './repl-settle.ts'

// The Codex CLI startup screens, verbatim in shape from a field log
// (2026-08-28 06:48). Whitespace is irrelevant — settleRepl strips it.
const CODEX_TRUST = `
  > You are in /Users/x/.unmute/remote/local/abc
    Do you trust the contents of this directory? Working with untrusted contents
    comes with higher risk of prompt injection.
  › 1. Yes, continue
    2. No, quit
    Press enter to continue
`
const CODEX_READY = `
  ╭─────────────────────────────────╮
  │ >_ OpenAI Codex (v0.149.1)      │
  ╰─────────────────────────────────╯
  › Ask Codex to do anything
    ? for shortcuts
`

test('Codex settles on ITS OWN ready prompt, not on Claude’s footer', async () => {
  // REPL_READY_RE was /bypasspermissions/ — a Claude Code marker that Codex
  // never prints. So for Codex, settleRepl could never conclude "ready": it
  // burned its whole budget and the caller dispatched into whatever was on
  // screen. On 2026-08-28 that was the trust dialog, and the task text became
  // menu input; Codex exited 0 and the card sat at "Working" for nine minutes.
  const out = await settleRepl({
    agent: 'codex',
    getOutput: () => CODEX_READY,
    isAlive: () => true,
    sendEnter: () => {},
    sendRaw: () => {},
    quietMs: 0, pollMs: 1, maxWaitMs: 200,
  })
  assert.equal(out.settled, true)
  assert.equal(out.reason, 'ready')
})

test('the Codex trust dialog is answered only when it is positively on screen', async () => {
  // The keystroke is an ordinary Enter — "1. Yes, continue" is preselected and
  // correct. What changed is the TARGETING: it fires because this dialog was
  // matched, once, instead of being sprayed at whatever the terminal was
  // showing. The update chooser is the counter-example and gets Down first,
  // because ITS default row runs an install and quits.
  let screen = CODEX_TRUST
  const raw: string[] = []
  const enters: string[] = []
  await settleRepl({
    agent: 'codex',
    getOutput: () => screen,
    isAlive: () => true,
    sendEnter: () => enters.push('\r'),
    sendRaw: (i) => { raw.push(i); screen = CODEX_READY },
    quietMs: 0, pollMs: 1, maxWaitMs: 200,
  })
  assert.deepEqual(raw, ['\r'], 'accept the preselected "1. Yes, continue"')
  assert.deepEqual(enters, [], 'not the untargeted quiet-path Enter')
})

test('a repainting dialog is still recognised — quiet is not the only signal', async () => {
  // THE ACTUAL FIELD BUG. The trust dialog kept emitting redraws (mouse-tracking
  // sequences), so `raw.length` never held still, the quiet gate never tripped,
  // and settleRepl sat there for its full 14s without ever looking at what was
  // on screen. A dialog is a dialog whether or not the terminal is idle.
  let tick = 0
  let answered = false
  const raw: string[] = []
  const out = await settleRepl({
    agent: 'codex',
    // Length changes on EVERY read, so nothing is ever "quiet".
    getOutput: () => (answered ? CODEX_READY : `${CODEX_TRUST}${'[K'.repeat(++tick)}`),
    isAlive: () => true,
    sendEnter: () => {},
    sendRaw: (i) => { raw.push(i); answered = true },
    quietMs: 5_000,          // deliberately unreachable
    pollMs: 1, maxWaitMs: 300,
  })
  assert.deepEqual(raw, ['\r'], 'the dialog must be answered on content, not on silence')
  assert.equal(out.settled, true)
})

test('running out of budget is reported, not silent', async () => {
  // The loop used to fall out of `while` and return undefined — no event, no
  // signal, nothing to grep. The caller then dispatched anyway.
  const events: string[] = []
  const out = await settleRepl({
    agent: 'codex',
    getOutput: () => 'something unrecognisable that is never a prompt',
    isAlive: () => true,
    sendEnter: () => {},
    sendRaw: () => {},
    onEvent: (e) => events.push(e),
    quietMs: 0, pollMs: 1, maxWaitMs: 60,
  })
  assert.equal(out.settled, false)
  assert.ok(events.includes('repl-not-settled'), `expected a loud failure, got ${events.join(',')}`)
})

test('a known dialog still on screen at the end is named, so the caller can refuse to type', async () => {
  const out = await settleRepl({
    agent: 'codex',
    getOutput: () => CODEX_TRUST,
    isAlive: () => true,
    sendEnter: () => {},
    // No sendRaw: nothing can be answered, so the dialog stays up.
    onEvent: () => {},
    quietMs: 0, pollMs: 1, maxWaitMs: 60,
  })
  assert.equal(out.settled, false)
  assert.equal(out.dialog, 'codex-trust', 'the caller needs to know a menu is holding the screen')
})

test('Claude’s existing path is untouched', async () => {
  const enters: string[] = []
  const out = await settleRepl({
    agent: 'claude',
    getOutput: () => 'bypass permissions on (shift+tab to cycle)',
    isAlive: () => true,
    sendEnter: () => enters.push('\r'),
    quietMs: 0, pollMs: 1, maxWaitMs: 100,
  })
  assert.equal(out.settled, true)
  assert.equal(out.reason, 'ready')
  assert.deepEqual(enters, [], 'already at the prompt — nothing to send')
})
