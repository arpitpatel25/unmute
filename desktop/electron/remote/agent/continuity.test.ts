import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  nextConversation,
  AGENT_IDLE_WINDOW_MS,
  AGENT_TURN_CEILING,
  type Conversation,
} from './continuity'

const none: Conversation | null = null
const conv = (runId: string, turns: number, endedAt: number): Conversation => ({ runId, turns, endedAt })

test('the first utterance starts a conversation', () => {
  assert.deepEqual(nextConversation(none, 1_000), { resume: false })
})

// "And what about the other one?" is the exchange that makes it an agent rather
// than a query box, and it only works if the previous turn is still there.
test('a follow-up soon after resumes the same conversation', () => {
  const prior = conv('run-1', 2, 10_000)
  assert.deepEqual(nextConversation(prior, 10_000 + 5_000), { resume: true, runId: 'run-1' })
})

// Unbounded continuity is genuinely harmful: context grows every turn,
// yesterday's topic bleeds into today's unrelated question, and one poisoned
// read contaminates every turn after it.
test('an utterance long afterwards starts fresh', () => {
  const prior = conv('run-1', 2, 10_000)
  assert.deepEqual(nextConversation(prior, 10_000 + AGENT_IDLE_WINDOW_MS + 1), { resume: false })
})

test('the ceiling ends a conversation however lively it is', () => {
  const prior = conv('run-1', AGENT_TURN_CEILING, 10_000)
  assert.deepEqual(nextConversation(prior, 10_100), { resume: false },
    'a long conversation is ended by length, not only by silence')
})

test('one turn below the ceiling still resumes', () => {
  const prior = conv('run-1', AGENT_TURN_CEILING - 1, 10_000)
  assert.deepEqual(nextConversation(prior, 10_100), { resume: true, runId: 'run-1' })
})

// A conversation that never finished has no endedAt to measure from. Starting
// fresh is the safe reading: resuming into an unknown state is how a turn
// inherits someone else's context.
test('a conversation with no recorded ending is not resumed', () => {
  assert.deepEqual(nextConversation(conv('run-1', 1, 0), 10_000), { resume: false })
})
