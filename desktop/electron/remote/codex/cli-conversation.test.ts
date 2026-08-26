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

// ─── Codex changed the wrapper (2026-08-24 onward) ───────────────────────────
//
// Newer Codex stopped emitting the fine-grained event_msg records this parser
// was built on. `user_message` / `agent_message` / `agent_reasoning` are all
// gone, replaced by ONE envelope — event_msg → item_completed → item.type —
// and function_call became custom_tool_call alongside it.
//
// The parser found none of what it was looking for and returned zero turns. It
// is read for the chat view AND, through codexUserTurns, as the PROOF that a
// dictated reply reached the CLI: zero before, zero after, forever, so every
// reply to such a task timed out after 7s and reported failure while the text
// had in fact landed half a second in. The retained draft was then appended to
// by the next capture and resent, growing each time.
//
// Field case 2026-08-26 (rollout 01a03d5e-…, gpt-5.6-terra): 38 of 366 rollouts
// on one machine already unreadable, all from the preceding two days.
//
// Shapes below are copied verbatim from that rollout — note `content[].type` is
// lowercase 'text' on a UserMessage and capitalised 'Text' on an AgentMessage.

const item = (itemType: string, text: string, contentType = 'text'): RolloutEvent => ({
  type: 'event_msg',
  payload: { type: 'item_completed', item: { type: itemType, id: 'x', content: [{ type: contentType, text }] } },
})

test('the item_completed envelope newer Codex writes is a conversation', () => {
  assert.deepEqual(
    conversationFromCodexEvents([
      item('UserMessage', 'Open MrBeast’s latest YouTube video in Chrome'),
      item('AgentMessage', 'Opened it.', 'Text'),
    ]),
    [
      { role: 'user', text: 'Open MrBeast’s latest YouTube video in Chrome' },
      { role: 'assistant', text: 'Opened it.' },
    ],
  )
})

test('item_completed records that are not messages stay out of the conversation', () => {
  assert.deepEqual(
    conversationFromCodexEvents([
      item('Reasoning', 'thinking about it'),
      item('CommandExecution', 'ls -la'),
      item('McpToolCall', 'called a tool'),
      item('UserMessage', 'Only this one'),
    ]),
    [{ role: 'user', text: 'Only this one' }],
  )
})

// The durable record present in BOTH formats. Anchoring on one event_msg
// wrapper is what broke twice; this is the shape that has survived every
// version seen, so it is the last resort before giving up.
test('response_item messages are read when no event_msg shape is present', () => {
  assert.deepEqual(
    conversationFromCodexEvents([
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'What I said' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'What it said' }] } },
    ]),
    [
      { role: 'user', text: 'What I said' },
      { role: 'assistant', text: 'What it said' },
    ],
  )
})

test('a developer-role response_item is not the user talking', () => {
  assert.deepEqual(
    conversationFromCodexEvents([
      { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<environment_context>' }] } },
    ]),
    [],
  )
})

// THE REGRESSION THIS FIX COULD EASILY CAUSE, PINNED.
//
// An old rollout carries BOTH shapes for the same exchange — one measured file
// had 8 event_msg/user_message records and 8 response_item/message:user records
// describing the same 8 messages. Reading the new shapes IN ADDITION would
// double every turn in the chat view of every task that works today. So the new
// readers are a FALLBACK, reached only when the event_msg pass found nothing at
// all, and never a second source added to a first.
test('a rollout carrying both the old and new shapes is not counted twice', () => {
  assert.deepEqual(
    conversationFromCodexEvents([
      msg('user_message', 'Hi'),
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hi' }] } },
      msg('agent_message', 'Hello'),
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hello' }] } },
    ]),
    [
      { role: 'user', text: 'Hi' },
      { role: 'assistant', text: 'Hello' },
    ],
  )
})
