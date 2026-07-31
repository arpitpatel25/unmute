import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ClaudeActuator, shortcutDigit } from './actuate'
import type { ClaudeConsent } from './ax'

const consent = (labels: string[]): ClaudeConsent => ({
  question: 'Allow Claude to write a file?',
  options: labels.map((label, i) => ({ id: i + 1, label })),
})

/** Records every focus change and bridge call, so tests assert on behaviour
 *  rather than on internals. */
function harness(opts: { activateOk?: boolean; typeResult?: unknown } = {}) {
  const calls: Array<{ fn: string; args: unknown[] }> = []
  const focus: string[] = []
  const actuator = new ClaudeActuator({
    frontmost: async () => 'com.user.previousapp',
    activate: async (b) => { focus.push(b); return opts.activateOk ?? true },
    bridge: {
      call: async (m: string, a: unknown[]) => {
        calls.push({ fn: m, args: a })
        return opts.typeResult ?? {}
      },
      trusted: async () => true,
      dispose: () => {},
    } as never,
  })
  return { actuator, calls, focus }
}

// ── the shortcut digit ────────────────────────────────────────────────────

test('the digit is parsed from the label the app itself numbered', () => {
  // Real labels captured from a live prompt.
  assert.equal(shortcutDigit('Deny 1'), '1')
  assert.equal(shortcutDigit('Always allow 2'), '2')
  assert.equal(shortcutDigit('Allow once 3 ⌘ ⏎'), '3')
})

test('a label with no digit yields null — never a guess', () => {
  assert.equal(shortcutDigit('Deny'), null)
  assert.equal(shortcutDigit('Allow'), null)
})

test('a digit inside a word is not a shortcut', () => {
  // "unmute-keytest2.txt" must not be read as option 2.
  assert.equal(shortcutDigit('Allow Claude to write file2.txt'), null)
})

// ── answering a prompt ────────────────────────────────────────────────────

test('answering types the option own digit, not its position', () => {
  // Order is not guaranteed; the app's numbering is. Answering by position
  // would answer a different question than the one shown.
  const h = harness()
  return h.actuator.answerConsent(consent(['Deny 1', 'Always allow 2', 'Allow once 3 ⌘ ⏎']), 'Allow once 3 ⌘ ⏎')
    .then((r) => {
      assert.equal(r.ok, true)
      const typed = h.calls.find((c) => c.fn === 'typeText')!
      assert.equal(typed.args[1], '3')
    })
})

test('an option with no digit FAILS rather than pressing something', async () => {
  const h = harness()
  const r = await h.actuator.answerConsent(consent(['Deny', 'Allow']), 'Deny')
  assert.deepEqual(r, { ok: false, reason: 'no-shortcut' })
  assert.equal(h.calls.length, 0, 'must not touch the app at all')
})

test('an unknown option label is refused', async () => {
  const h = harness()
  const r = await h.actuator.answerConsent(consent(['Deny 1']), 'Something else')
  assert.equal(r.ok, false)
  assert.equal(h.calls.length, 0)
})

// ── focus discipline ──────────────────────────────────────────────────────

test('the user app is restored after acting', async () => {
  const h = harness()
  await h.actuator.answerConsent(consent(['Deny 1']), 'Deny 1')
  assert.deepEqual(h.focus, ['com.anthropic.claudefordesktop', 'com.user.previousapp'])
})

test('the user app is restored even when the action THROWS', async () => {
  // Leaving the user staring at an app they did not open is the most visible
  // way this can misbehave.
  const calls: string[] = []
  const focus: string[] = []
  const a = new ClaudeActuator({
    frontmost: async () => 'com.user.previousapp',
    activate: async (b) => { focus.push(b); return true },
    bridge: { call: async () => { calls.push('x'); throw new Error('boom') }, trusted: async () => true, dispose: () => {} } as never,
  })
  await a.answerConsent(consent(['Deny 1']), 'Deny 1').catch(() => {})
  assert.deepEqual(focus, ['com.anthropic.claudefordesktop', 'com.user.previousapp'])
})

test('a failed activation does not act, and reports why', async () => {
  const h = harness({ activateOk: false })
  const r = await h.actuator.answerConsent(consent(['Deny 1']), 'Deny 1')
  assert.deepEqual(r, { ok: false, reason: 'activate-failed' })
  assert.equal(h.calls.filter((c) => c.fn === 'typeText').length, 0)
})

test('a bridge error is reported, not swallowed as success', async () => {
  const h = harness({ typeResult: { error: 'app not running' } })
  const r = await h.actuator.answerConsent(consent(['Deny 1']), 'Deny 1')
  assert.deepEqual(r, { ok: false, reason: 'bridge-failed' })
})

// ── serialization ─────────────────────────────────────────────────────────

test('actions are serialized — never two fronting fights at once', async () => {
  const order: string[] = []
  const a = new ClaudeActuator({
    frontmost: async () => 'prev',
    activate: async () => true,
    bridge: {
      call: async (_m: string, args: unknown[]) => {
        order.push(`start:${String(args[1])}`)
        await new Promise((r) => setTimeout(r, 20))
        order.push(`end:${String(args[1])}`)
        return {}
      },
      trusted: async () => true, dispose: () => {},
    } as never,
  })
  await Promise.all([a.send('first'), a.send('second')])
  // Fully nested would mean interleaving; serialized means each completes first.
  assert.deepEqual(order, ['start:first', 'end:first', 'start:second', 'end:second'])
})

test('one failure does not wedge the queue for everything after it', async () => {
  let n = 0
  const a = new ClaudeActuator({
    frontmost: async () => 'prev',
    activate: async () => true,
    bridge: {
      call: async () => { if (n++ === 0) throw new Error('boom'); return {} },
      trusted: async () => true, dispose: () => {},
    } as never,
  })
  await a.send('doomed').catch(() => {})
  assert.equal((await a.send('later')).ok, true)
})

// ── sending ───────────────────────────────────────────────────────────────

test('send types the text and submits it', async () => {
  const h = harness()
  const r = await h.actuator.send('hello there')
  assert.equal(r.ok, true)
  const typed = h.calls.find((c) => c.fn === 'typeText')!
  assert.equal(typed.args[1], 'hello there')
  assert.equal(typed.args[3], true, 'submit must be set, or the message just sits in the composer')
})

test('empty text is refused before any focus is stolen', async () => {
  const h = harness()
  const r = await h.actuator.send('   ')
  assert.equal(r.ok, false)
  assert.deepEqual(h.focus, [], 'must not front the app to send nothing')
})
