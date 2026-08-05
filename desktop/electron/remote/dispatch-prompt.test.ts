import test from 'node:test'
import assert from 'node:assert/strict'
import { buildDispatch, buildResumeNudge } from './dispatch-prompt.ts'

test('the dispatch payload is the intent, and nothing else', () => {
  // It used to be a header, a status path, a recipe path, hedged memory leads,
  // stale-skill notes, an "Act now" imperative and — on project-bound spawns —
  // the entire 244-line operating contract, inline, as a user turn.
  assert.equal(buildDispatch({ intent: 'summarize the pricing thread' }), 'summarize the pricing thread')
})

test('nothing Unmute-shaped leaks into the payload', () => {
  const out = buildDispatch({ intent: 'open my inbox' })
  for (const leak of ['status.json', 'Unmute', 'contract', 'recipe', 'Act now']) {
    assert.ok(!out.includes(leak), `payload leaked "${leak}"`)
  }
})

test('the resume nudge still says continue, not restart', () => {
  // This one survives because it is genuinely task content: a resumed REPL comes
  // back idle and would otherwise sit there, or start over.
  const out = buildResumeNudge('fix the flaky test')
  assert.match(out, /do NOT restart/)
  assert.match(out, /fix the flaky test/)
  assert.ok(!out.includes('status'), 'the nudge must not re-anchor a status protocol')
})
