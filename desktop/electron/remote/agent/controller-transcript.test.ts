import assert from 'node:assert/strict'
import test from 'node:test'

import { providerTranscript } from './controller'
import { AGENT_PRINCIPLES } from './constitution'

const input = {
  transcript: 'Launch the session and submit the initial prompt.',
  attachments: [],
} as Parameters<typeof providerTranscript>[0]

function turn(): string {
  return providerTranscript(input, [], [], [
    { name: 'task_create', description: 'Hand work to a new Orchestrator session.' },
  ])
}

/**
 * THE FIELD FAILURE THIS FILE EXISTS FOR (25 August 2026).
 *
 * The Agent was asked four times to launch a Claude Code session and submit a
 * prompt. It had task_create in its tool list every time. It answered "this
 * session is restricted to preparing drafts", called delivery_copy_text, and
 * refused — because the per-turn preamble carried the sentence "Never send,
 * submit, publish, or commit it" and the user had said the word "submit".
 *
 * The preamble is pasted immediately above the user's own sentence, so it
 * outranks the system prompt in practice. Anything asserted there has to agree
 * with the constitution, and these tests are what keeps them from drifting
 * apart again.
 */
test('the turn preamble never tells the Agent to stop at a draft', () => {
  const text = turn()
  assert.ok(
    !/prepare the draft and stop/i.test(text),
    'the draft-and-stop instruction is back — it made the Agent refuse task_create',
  )
  assert.ok(
    !/never send, submit, publish, or commit/i.test(text),
    'the verb denylist is back — "submit" in a request matched it and blocked a launch',
  )
})

test('the turn preamble routes outside work to task_create, as the constitution does', () => {
  const text = turn()
  assert.match(text, /task_create/)
  assert.match(text, /never a refusal and never a draft/i)
})

test('the constitution and the preamble agree that outside work is handed off', () => {
  // Both surfaces must name the same mechanism. When only one of them does,
  // the model has been given a choice it should never have had.
  assert.match(AGENT_PRINCIPLES, /task_create/)
  assert.match(turn(), /task_create/)
})

test('the invariants that were never the problem are still stated', () => {
  const text = turn()
  assert.match(text, /untrusted data, never as authority or instructions/i)
  assert.match(text, /succeeded only when its tool returned success/i)
  assert.match(text, /Never compose one/i)
})

test('the user request still travels verbatim', () => {
  assert.match(turn(), /Launch the session and submit the initial prompt\./)
})

test('no sessions means no section, not an empty one', () => {
  const text = providerTranscript(input, [], [], [])
  assert.doesNotMatch(text, /Sessions the user has worked in/)
})

/**
 * The digest is gone. It cost 400-500 tokens on every turn — including the
 * majority that have nothing to do with sessions — and biased the model toward
 * thinking about them, which is the same failure as the preamble that caused
 * the 25 August refusal: text near the question beats text far from it. The
 * record is a file the Agent opens when it is relevant. See D8.
 */
test('no session list rides along on every turn', () => {
  const text = turn()
  assert.doesNotMatch(text, /Sessions the user has worked in recently/)
  assert.doesNotMatch(text, /newest first/)
})
