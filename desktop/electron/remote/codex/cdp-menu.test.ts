import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { pickMenuItem, type MenuItem, type SetReasoningTrace } from './cdp'

const row = (text: string, y: number): MenuItem => ({ text, x: 100, y })

/** Codex's real model submenu: names alone, and names with a subtitle. */
const PLAIN: MenuItem[] = [row('5.4 Mini', 10), row('5.4', 20), row('5.6 Sol', 30)]
const SUBTITLED: MenuItem[] = [
  row('5.6 Sol\nLatest frontier agentic coding model.', 10),
  row('5.6 Luna\nFaster.', 20),
]

describe('pickMenuItem', () => {
  test('EXACT BEFORE PREFIX — "5.4" must not select "5.4 Mini"', () => {
    // Mini is listed FIRST, so a bare startsWith would have claimed it.
    assert.equal(pickMenuItem(PLAIN, '5.4')!.y, 20)
  })

  test('the mini is still reachable by its own name', () => {
    assert.equal(pickMenuItem(PLAIN, '5.4 Mini')!.y, 10)
  })

  test('matches the first line when the row carries a description', () => {
    assert.equal(pickMenuItem(SUBTITLED, '5.6 Sol')!.y, 10)
  })

  test('case and stray whitespace do not matter', () => {
    assert.equal(pickMenuItem(PLAIN, '  5.6 SOL ')!.y, 30)
  })

  test('a value the menu does not offer returns null, never a near miss', () => {
    assert.equal(pickMenuItem(PLAIN, 'GPT-5.6-Sol'), null)   // the old bug, now visible
    assert.equal(pickMenuItem(PLAIN, ''), null)
    assert.equal(pickMenuItem([], '5.4'), null)
  })
})

describe('SetReasoningTrace contract', () => {
  test('the trace names the stage that failed, so "why" is never inferred', () => {
    // Guards the field the whole investigation turned on: three builds shipped
    // with every pick dead because the log recorded only that a choice existed.
    const stages = ['menu-closed', 'axis-row-missing', 'submenu-closed', 'value-absent', 'clicked']
    for (const s of stages) {
      const t: SetReasoningTrace = { axis: 'Model', want: '5.6 Sol', stage: s as never, ok: s === 'clicked', ms: 1 }
      assert.equal(typeof t.stage, 'string')
      assert.equal(t.ok, s === 'clicked')
    }
  })

  test('a click that changed nothing is NOT a success', () => {
    // `ok` means "we clicked a row"; `changed` means "Codex agreed". Only the
    // second is evidence, which is why callers gate their log level on it.
    const t: SetReasoningTrace = {
      axis: 'Effort', want: 'Max', stage: 'clicked', ok: true, ms: 9,
      labelBefore: '5.6 Sol High', labelAfter: '5.6 Sol High', changed: false,
    }
    assert.equal(t.ok && t.changed, false)
  })
})

// ── Computer Use consent reading (added 2026-07-30) ─────────────────────────
// The panel carries NO data-app-action-* hooks — probed live, zero matches — so
// unlike the rest of cdp.ts this reader is structural. These pin the contract
// the evaluate() expression must honour, with the browser stubbed out.

import { readPendingConsent, answerConsent, isAwaitingConsent } from './cdp'

/** A CodexCdp stand-in whose evaluate() returns whatever the DOM would have. */
const fakeCdp = (payload: unknown, clicked: string[] = []) => ({
  evaluate: async (expr: string) => {
    if (/awaiting approval/i.test(expr) && !/querySelectorAll\('\*'\)\].filter/.test(expr)) {
      return payload ? '1' : ''
    }
    return payload ? JSON.stringify(payload) : ''
  },
  clickText: async (t: string) => { clicked.push(t); return true },
}) as never

test('a consent is reported with EVERY option the DOM offers', async () => {
  // Shape copied from the real blocked task on 2026-07-30 — three options, and
  // the third ("Allow this conversation") is why nothing may be hardcoded.
  const c = await readPendingConsent(fakeCdp({
    question: 'Allow ChatGPT to use WhatsApp?',
    options: ['Always allow', 'Deny', 'Allow this conversation'],
  }))
  assert.equal(c?.question, 'Allow ChatGPT to use WhatsApp?')
  assert.deepEqual(c?.options, ['Always allow', 'Deny', 'Allow this conversation'])
})

test('no consent showing reads as null, never as an empty consent', async () => {
  assert.equal(await readPendingConsent(fakeCdp(null)), null)
})

test('a panel with no options is not a consent', async () => {
  assert.equal(await readPendingConsent(fakeCdp({ question: 'Really?', options: [] })), null)
})

test('answering clicks the option by its OWN label', async () => {
  const clicked: string[] = []
  const cdp = fakeCdp({ question: 'Allow ChatGPT to use WhatsApp?',
    options: ['Always allow', 'Deny', 'Allow this conversation'] }, clicked)
  assert.equal(await answerConsent(cdp, 'Deny'), true)
  assert.deepEqual(clicked, ['Deny'])
})

test('answering an option Codex is NOT offering fails instead of guessing', async () => {
  // The options differ per consent. Falling back to "something like it" would
  // click the wrong button on a panel whose wording we have never seen.
  const clicked: string[] = []
  const cdp = fakeCdp({ question: 'Allow ChatGPT to use WhatsApp?',
    options: ['Always allow', 'Deny'] }, clicked)
  assert.equal(await answerConsent(cdp, 'Allow this conversation'), false)
  assert.deepEqual(clicked, [])
})

test('isAwaitingConsent is true whenever Codex shows its parked marker', async () => {
  assert.equal(await isAwaitingConsent(fakeCdp({ question: 'x?', options: ['a', 'b'] })), true)
  assert.equal(await isAwaitingConsent(fakeCdp(null)), false)
})
