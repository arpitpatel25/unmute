// USER MESSAGES MUST STAY WHERE THEY WERE SAID.
//
// Codex records a prompt TWICE — once as a `user_message` event and once as a
// `response_item` with role user. Emitting both printed every question on
// screen twice, so the response_items were held back and used only when the
// thread had no events at all, and then `unshift`ed to the front.
//
// Both halves of that turned out to be wrong for CURRENT threads:
//
//   * a modern Codex rollout can carry NO user_message events at all — only
//     response_items. Observed 29 Aug on a live two-turn thread.
//   * so the "older rollout" fallback fired on a brand-new one, and unshift
//     hoisted EVERY question above EVERY answer. On screen: both questions
//     stacked at the top, then the answer to the first one underneath.
//
// The rule that actually holds: emit a user message at the position it occurs,
// whichever record carries it, and never emit the same one twice.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { blocksFromRollout } from './blocks-rollout.ts'

const line = (o: unknown) => JSON.stringify(o)

/** A two-turn thread recorded the way Codex actually wrote it on 29 Aug:
 *  response_items only, no user_message events. */
const RESPONSE_ITEMS_ONLY = [
  line({ type: 'event_msg', payload: { type: 'task_started' } }),
  line({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n  <cwd>/tmp</cwd>\n</environment_context>' }] } }),
  line({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Go through the unmute-cloud repository.' }] } }),
  line({ type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'Unmute Cloud is the commercial layer.' } }),
  line({ type: 'event_msg', payload: { type: 'task_started' } }),
  line({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: "What's your take on it?" }] } }),
  line({ type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'The core idea is strong.' } }),
].join('\n')

const roles = (bs: Array<{ kind: string; role?: string; text?: string }>) =>
  bs.filter((b) => b.kind === 'message').map((b) => `${b.role}:${b.text?.slice(0, 24)}`)

test('questions and answers interleave — not all questions first', () => {
  const { blocks } = blocksFromRollout(RESPONSE_ITEMS_ONLY)
  assert.deepEqual(roles(blocks), [
    'user:Go through the unmute-cl',
    'assistant:Unmute Cloud is the comm',
    "user:What's your take on it?",
    'assistant:The core idea is strong.',
  ])
})

test('the second question comes AFTER the first answer', () => {
  const { blocks } = blocksFromRollout(RESPONSE_ITEMS_ONLY)
  const idx = (t: string) => blocks.findIndex((b) => (b as { text?: string }).text?.startsWith(t))
  assert.ok(idx('Unmute Cloud is') < idx("What's your take"),
    'the follow-up was hoisted above the answer it followed')
})

test('the injected environment_context block is still hidden', () => {
  const { blocks } = blocksFromRollout(RESPONSE_ITEMS_ONLY)
  assert.ok(!blocks.some((b) => (b as { text?: string }).text?.includes('environment_context')))
})

test('a thread recorded BOTH ways shows each question once', () => {
  // The duplicate-render this hold-back was originally protecting against.
  const both = [
    line({ type: 'event_msg', payload: { type: 'task_started' } }),
    line({ type: 'event_msg', payload: { type: 'user_message', message: 'Only once please.' } }),
    line({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Only once please.' }] } }),
    line({ type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'Understood.' } }),
  ].join('\n')
  const { blocks } = blocksFromRollout(both)
  assert.deepEqual(roles(blocks), ['user:Only once please.', 'assistant:Understood.'])
})

test('an event-only thread is unchanged', () => {
  const evOnly = [
    line({ type: 'event_msg', payload: { type: 'task_started' } }),
    line({ type: 'event_msg', payload: { type: 'user_message', message: 'First.' } }),
    line({ type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'A1.' } }),
    line({ type: 'event_msg', payload: { type: 'user_message', message: 'Second.' } }),
    line({ type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'A2.' } }),
  ].join('\n')
  const { blocks } = blocksFromRollout(evOnly)
  assert.deepEqual(roles(blocks), ['user:First.', 'assistant:A1.', 'user:Second.', 'assistant:A2.'])
})

test('the same question asked twice, genuinely, is shown twice', () => {
  // Dedupe must be per-record-pair, not global: repeating yourself is allowed.
  const twice = [
    line({ type: 'event_msg', payload: { type: 'task_started' } }),
    line({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'again?' }] } }),
    line({ type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'yes' } }),
    line({ type: 'event_msg', payload: { type: 'task_started' } }),
    line({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'again?' }] } }),
    line({ type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'still yes' } }),
  ].join('\n')
  const { blocks } = blocksFromRollout(twice)
  assert.deepEqual(roles(blocks), ['user:again?', 'assistant:yes', 'user:again?', 'assistant:still yes'])
})
