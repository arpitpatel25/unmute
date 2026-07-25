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
  // The assistant side comes from `response_item`, not the `agent_message`
  // event: only the response item carries the phase that separates a running
  // commentary line from the final answer.
  const lines: string[] = [line('task_started', {})]
  for (let i = 0; i < 10; i++) {
    lines.push(line('user_message', { message: `u${i}` }))
    lines.push(JSON.stringify({ type: 'response_item', payload: {
      type: 'message', role: 'assistant', phase: 'final_answer',
      content: [{ type: 'output_text', text: `a${i}` }],
    } }))
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

// ── the rich item stream ─────────────────────────────────────────────────────
//
// Shapes below are verbatim from the real "Open Mr. B's latest YouTube video"
// thread (2026-07-25). Before this, the parser kept only `agent_message`, so a
// turn that opened a browser, searched YouTube, verified the channel and opened
// the video rendered as ONE grey sentence.

/** A `response_item` line — the layer that carries tool calls and phases. */
const item = (payload: Record<string, unknown>) =>
  JSON.stringify({ type: 'response_item', payload })

test("a tool step keeps Codex's own title, code, output and wall time", () => {
  const snap = parseRollout([
    item({
      type: 'custom_tool_call', call_id: 'call_A', name: 'exec',
      input: 'const r = await tools.mcp__node_repl__js({"title":"Search YouTube","code":"await tab.goto(x)"});',
    }),
    item({
      type: 'custom_tool_call_output', call_id: 'call_A',
      output: [{ type: 'input_text', text: 'Script completed\nWall time 99.1 seconds\nOutput:\n' },
               { type: 'input_text', text: 'found the video' }],
    }),
  ].join('\n'))
  const step = snap.turns.find((t) => t.role === 'tool')!
  assert.equal(step.title, 'Search YouTube', "the label Codex showed, not the internal tool name")
  assert.equal(step.durationMs, 99_100, "wall time lifted out of Codex's status preamble")
  assert.match(step.code!, /tab\.goto/)
  assert.equal(step.output, 'found the video', 'preamble stripped, result kept')
  assert.equal(step.ok, true)
})

test('a step titles itself from the command when there is no title', () => {
  const snap = parseRollout(item({
    type: 'custom_tool_call', call_id: 'c1', name: 'exec',
    input: 'const r = await tools.exec_command({"cmd":"sed -n 1,240p SKILL.md"});',
  }))
  assert.equal(snap.turns[0].title, 'sed -n 1,240p SKILL.md')
})

test('an output with no matching call is dropped, not attached to the wrong step', () => {
  const snap = parseRollout([
    item({ type: 'custom_tool_call', call_id: 'mine', name: 'exec', input: '{"title":"Mine"}' }),
    item({ type: 'custom_tool_call_output', call_id: 'someone-elses', output: 'not mine' }),
  ].join('\n'))
  assert.equal(snap.turns.length, 1)
  assert.equal(snap.turns[0].output, undefined)
})

test('commentary and the final answer stay distinguishable', () => {
  // Codex greys the running "I'll do X" line and gives the answer full weight;
  // collapsing them would make a long thread unskimmable.
  const snap = parseRollout([
    item({ type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'I will look it up.' }] }),
    item({ type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'Opened it.' }] }),
  ].join('\n'))
  assert.deepEqual(snap.turns.map((t) => t.role), ['commentary', 'assistant'])
})

test("Codex's injected context is NEVER shown back to the user", () => {
  // <app-context> and <recommended_plugins> arrive as developer- and user-role
  // messages. Rendering them would put pages of prompt scaffolding in the notch
  // and, worse, attribute it to the user.
  const snap = parseRollout([
    item({ type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<app-context>x</app-context>' }] }),
    item({ type: 'message', role: 'user', content: [{ type: 'input_text', text: '<recommended_plugins>y' }] }),
    line('user_message', { message: "Open Mr. B's latest video." }),
  ].join('\n'))
  assert.deepEqual(snap.turns, [{ role: 'user', text: "Open Mr. B's latest video." }])
})

test('an assistant answer appears once, not twice', () => {
  // Both `event_msg agent_message` and `response_item message` carry it; only
  // the latter knows the phase, so only the latter is read.
  const snap = parseRollout([
    line('agent_message', { message: 'Opened it.' }),
    item({ type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'Opened it.' }] }),
  ].join('\n'))
  assert.equal(snap.turns.length, 1)
})

test('a huge tool output is clipped rather than shipped whole to the notch', () => {
  const snap = parseRollout([
    item({ type: 'custom_tool_call', call_id: 'c', name: 'exec', input: '{"title":"Snapshot"}' }),
    item({ type: 'custom_tool_call_output', call_id: 'c', output: 'x'.repeat(50_000) }),
  ].join('\n'))
  assert.ok(snap.turns[0].output!.length < 2_200, 'clipped')
  assert.match(snap.turns[0].output!, /more characters/, 'and says so')
})

test('the headline is still the final answer, not the last tool step', () => {
  // The notch/doorbell reads lastAgentMessage; a tool step must never become
  // the thing the user is told the task produced.
  const snap = parseRollout([
    line('task_started', {}),
    item({ type: 'custom_tool_call', call_id: 'c', name: 'exec', input: '{"title":"Keep video open"}' }),
    item({ type: 'custom_tool_call_output', call_id: 'c', output: 'ok' }),
    line('task_complete', { last_agent_message: 'Opened MrBeast’s latest video.' }),
  ].join('\n'))
  assert.equal(snap.lastAgentMessage, 'Opened MrBeast’s latest video.')
})
