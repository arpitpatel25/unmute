import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  noteAgentDelivery,
  shouldRestoreAgentDelivery,
  AGENT_DELIVERY_PROTECTION_MS,
  clearAgentDelivery,
} from './agentDelivery'

// THE TRAP THIS CLOSES. The Agent's only text channel is the clipboard, and
// dictation delivers through that same clipboard — so the user's next sentence
// erases the answer they just asked for. Worse, to report the problem they
// have to speak, which erases it again. Observed 18 August: three retrievals,
// all successful, all destroyed within seconds by the user's own dictation.

test('a dictation shortly after an Agent delivery restores it', () => {
  clearAgentDelivery()
  noteAgentDelivery('rishi@example.com', 1_000)
  assert.deepEqual(
    shouldRestoreAgentDelivery(1_000 + 5_000),
    { restore: true, text: 'rishi@example.com' },
  )
})

test('a dictation long afterwards leaves the clipboard alone', () => {
  clearAgentDelivery()
  noteAgentDelivery('rishi@example.com', 1_000)
  const late = 1_000 + AGENT_DELIVERY_PROTECTION_MS + 1
  assert.deepEqual(shouldRestoreAgentDelivery(late), { restore: false })
})

// The user pasting is the whole point. Once they have used it, the clipboard
// belongs to whatever they do next.
test('once consumed, the delivery is no longer protected', () => {
  clearAgentDelivery()
  noteAgentDelivery('rishi@example.com', 1_000)
  clearAgentDelivery()
  assert.deepEqual(shouldRestoreAgentDelivery(1_500), { restore: false })
})

test('with no Agent delivery there is nothing to protect', () => {
  clearAgentDelivery()
  assert.deepEqual(shouldRestoreAgentDelivery(9_999), { restore: false })
})

// A second delivery supersedes the first: the newest answer is the one the
// user is holding.
test('a newer delivery replaces the one before it', () => {
  clearAgentDelivery()
  noteAgentDelivery('first', 1_000)
  noteAgentDelivery('second', 2_000)
  assert.deepEqual(shouldRestoreAgentDelivery(2_500), { restore: true, text: 'second' })
})

test('an empty delivery is not worth protecting', () => {
  clearAgentDelivery()
  noteAgentDelivery('   ', 1_000)
  assert.deepEqual(shouldRestoreAgentDelivery(1_500), { restore: false })
})
