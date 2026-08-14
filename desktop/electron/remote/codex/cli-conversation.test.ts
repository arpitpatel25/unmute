// A Codex CLI task's chat view rendered `task.conversation`, and that array was
// only ever filled from a Claude Code `Stop` hook. Codex installs no such hook
// — ~/.codex/hooks.json carries PermissionRequest and nothing else — so the
// view stayed on "no messages yet" for the whole life of the task while the
// terminal mirror beside it showed the real exchange.
//
// Codex writes that exchange to its rollout without being asked, which is the
// same file this poller already reads for status.
import test from 'node:test'
import assert from 'node:assert/strict'
import { conversationFromCodexEvents, type RolloutEvent } from './cli-observer'

const msg = (kind: string, message: string): RolloutEvent => ({
  type: 'event_msg',
  payload: { type: kind, message },
})

test('a rollout exchange becomes an alternating conversation', () => {
  assert.deepEqual(
    conversationFromCodexEvents([
      msg('user_message', 'Hi'),
      msg('agent_message', 'Hi — what would you like to work on?'),
      msg('user_message', 'Hi'),
      msg('agent_message', 'Hi again.'),
    ]),
    [
      { role: 'user', text: 'Hi' },
      { role: 'assistant', text: 'Hi — what would you like to work on?' },
      { role: 'user', text: 'Hi' },
      { role: 'assistant', text: 'Hi again.' },
    ],
  )
})

test('agent text is read from whichever field this Codex version wrote', () => {
  assert.deepEqual(
    conversationFromCodexEvents([
      { type: 'event_msg', payload: { type: 'agent_message', text: 'written as text' } },
    ]),
    [{ role: 'assistant', text: 'written as text' }],
  )
})

test('non-message rollout records are not conversation', () => {
  assert.deepEqual(
    conversationFromCodexEvents([
      { type: 'session_meta', payload: { type: 'session_meta' } },
      { type: 'response_item', payload: { type: 'reasoning', message: 'private thinking' } },
      msg('user_message', 'the only real turn'),
      { type: 'event_msg', payload: { type: 'token_count' } },
    ]),
    [{ role: 'user', text: 'the only real turn' }],
  )
})

test('blank messages never become empty bubbles', () => {
  assert.deepEqual(
    conversationFromCodexEvents([msg('user_message', '   '), msg('agent_message', '')]),
    [],
  )
})

test('an empty rollout yields no conversation rather than an empty one', () => {
  assert.deepEqual(conversationFromCodexEvents([]), [])
})
