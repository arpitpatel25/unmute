import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseRollout } from './rollout'

// Shapes below are copied from REAL rollout files on a live machine
// (~/.codex/sessions/2026/07/25/rollout-*.jsonl), not invented — the whole
// value of this parser is that it matches what Codex actually writes.
const line = (type: string, payload: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'event_msg', payload: { type, ...payload } })

test('a turn in flight is processing', () => {
  const snap = parseRollout([
    line('task_started', { turn_id: 't1', started_at: 1784927426 }),
    line('user_message', { message: 'do the thing' }),
  ].join('\n'))
  assert.equal(snap.state, 'processing')
  assert.equal(snap.everCompleted, false)
})

test('a completed turn is READY, not done — the ball is with the user', () => {
  // ORCHESTRATE-VISION §3: "the step is over but the ball is with you". A Codex
  // thread is always continuable, so it must never settle straight to `done`.
  const snap = parseRollout([
    line('task_started', { turn_id: 't1', started_at: 1784927426 }),
    line('user_message', { message: 'reply pong' }),
    line('agent_message', { message: 'pong' }),
    line('task_complete', { turn_id: 't1', last_agent_message: 'pong' }),
  ].join('\n'))
  assert.equal(snap.state, 'ready')
  assert.equal(snap.lastAgentMessage, 'pong')
  assert.equal(snap.everCompleted, true)
})

test('a second turn started after one completed returns to processing', () => {
  const snap = parseRollout([
    line('task_started', { turn_id: 't1' }),
    line('task_complete', { turn_id: 't1', last_agent_message: 'first' }),
    line('task_started', { turn_id: 't2' }),
  ].join('\n'))
  assert.equal(snap.state, 'processing')
  // The headline still reflects the last COMPLETED turn.
  assert.equal(snap.lastAgentMessage, 'first')
})

test('turns are captured in order and capped', () => {
  const lines: string[] = [line('task_started', {})]
  for (let i = 0; i < 10; i++) {
    lines.push(line('user_message', { message: `u${i}` }))
    lines.push(line('agent_message', { message: `a${i}` }))
  }
  lines.push(line('task_complete', { last_agent_message: 'a9' }))
  const snap = parseRollout(lines.join('\n'), 4)
  assert.equal(snap.turns.length, 4)
  assert.deepEqual(snap.turns.map((t) => t.text), ['u8', 'a8', 'u9', 'a9'])
  assert.equal(snap.turns[0].role, 'user')
})

test('a torn final line (Codex mid-write) is ignored, not fatal', () => {
  // Rollouts are appended live; a poll can read a half-written last line.
  const snap = parseRollout([
    line('task_started', {}),
    line('task_complete', { last_agent_message: 'ok' }),
    '{"type":"event_msg","payload":{"type":"tok',
  ].join('\n'))
  assert.equal(snap.state, 'ready')
  assert.equal(snap.lastAgentMessage, 'ok')
})

test('an error event marks the task failed', () => {
  const snap = parseRollout([
    line('task_started', {}),
    line('error', { message: 'stream broke' }),
  ].join('\n'))
  assert.equal(snap.state, 'failed')
})

test('empty transcript is processing, never a crash', () => {
  const snap = parseRollout('')
  assert.equal(snap.state, 'processing')
  assert.equal(snap.turns.length, 0)
  assert.equal(snap.lastAgentMessage, null)
})

test('second-precision timestamps are normalised to ms', () => {
  // Codex writes started_at in SECONDS; Unmute's staleness clock is in ms, so a
  // raw copy would look ~55 years stale and instantly mark every task stuck.
  const snap = parseRollout(line('task_started', { started_at: 1784927426 }))
  assert.equal(snap.updatedAt, 1784927426_000)
})

test('unknown event types are ignored (forward compatible)', () => {
  const snap = parseRollout([
    line('task_started', {}),
    line('some_future_event_openai_adds', { whatever: 1 }),
    line('task_complete', { last_agent_message: 'fine' }),
  ].join('\n'))
  assert.equal(snap.state, 'ready')
  assert.equal(snap.lastAgentMessage, 'fine')
})
