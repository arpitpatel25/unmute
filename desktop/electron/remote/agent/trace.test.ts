import test from 'node:test'
import assert from 'node:assert/strict'
import { traceStreamLine, redactSecrets, TRACE_TEXT_MAX } from './trace'
import { summariseArgv } from './traceLog'

// Shapes copied from a real `claude -p --output-format stream-json --verbose`
// run, not invented. The record is only worth what its fixtures are worth.

test('the session line names the conversation, the model and its servers', () => {
  assert.deepEqual(
    traceStreamLine({
      type: 'system', subtype: 'init', session_id: 'abc-123', model: 'claude-sonnet-5',
      tools: ['Read', 'Glob', 'Grep'],
      mcp_servers: [{ name: 'unmute', status: 'connected' }],
    }),
    [{ kind: 'session', sessionId: 'abc-123', model: 'claude-sonnet-5', tools: 3, mcpServers: ['unmute'] }],
  )
})

test('a tool call keeps its ARGUMENTS — the half the activity event drops', () => {
  // "using Read" does not say which file, which is the whole question.
  assert.deepEqual(
    traceStreamLine({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: '/tmp/a.md' } }] },
    }),
    [{ kind: 'tool', tool: 'Read', id: 'tu_1', input: '{"file_path":"/tmp/a.md"}' }],
  )
})

test('reasoning is kept, where it used to be dropped entirely', () => {
  assert.deepEqual(
    traceStreamLine({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'The user wants X.' }] } }),
    [{ kind: 'thinking', text: 'The user wants X.', chars: 17 }],
  )
})

test('one message carrying reasoning, prose and a call reports all three, in order', () => {
  const out = traceStreamLine({
    type: 'assistant',
    message: {
      content: [
        { type: 'thinking', thinking: 'I should look.' },
        { type: 'text', text: "I'll check that." },
        { type: 'tool_use', name: 'Grep', input: { pattern: 'x' } },
      ],
    },
  })
  assert.deepEqual(out.map((t) => t.kind), ['thinking', 'says', 'tool'])
})

test('a tool result is kept, with whether it worked', () => {
  assert.deepEqual(
    traceStreamLine({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', is_error: true, content: 'ENOENT' }] },
    }),
    [{ kind: 'toolResult', id: 'tu_1', ok: false, chars: 6, preview: 'ENOENT' }],
  )
})

test('the result keeps the reason, the cost and the clock', () => {
  assert.deepEqual(
    traceStreamLine({
      type: 'result', subtype: 'success', is_error: false, result: 'Eleven open.',
      duration_ms: 1734, total_cost_usd: 0.21, num_turns: 2,
      usage: { input_tokens: 2, output_tokens: 5, cache_read_input_tokens: 13070, cache_creation_input_tokens: 21110 },
    }),
    [{
      kind: 'result', ok: true, subtype: 'success', text: 'Eleven open.', chars: 12,
      durationMs: 1734, costUsd: 0.21, turns: 2,
      usage: { input: 2, output: 5, cacheRead: 13070, cacheWrite: 21110 },
    }],
  )
})

test('THE LINE THAT NAMED A REAL BUG is kept verbatim', () => {
  // `No conversation found with session ID` was on the stream all along, on a
  // line nobody was keeping. Finding it took a CLI reproduction instead.
  const [rec] = traceStreamLine({
    type: 'result', subtype: 'error_during_execution', is_error: true,
    result: 'No conversation found with session ID: 3822CFEF',
  })
  assert.equal(rec.kind, 'result')
  assert.equal((rec as { ok: boolean }).ok, false)
  assert.match((rec as { text: string }).text, /No conversation found/)
})

test('a long answer is clipped, and says by how much', () => {
  const [rec] = traceStreamLine({ type: 'result', subtype: 'success', result: 'x'.repeat(3000) })
  const text = (rec as { text: string }).text
  assert.ok(text.length < 3000)
  assert.match(text, /…<\+\d+>$/)
  assert.equal((rec as { chars: number }).chars, 3000, 'the true length survives the clip')
})

test('a shape we do not know is kept, never guessed at', () => {
  assert.deepEqual(traceStreamLine({ type: 'something_new' }), [{ kind: 'other', type: 'something_new' }])
  assert.deepEqual(traceStreamLine(null), [])
  assert.deepEqual(traceStreamLine('not an object'), [])
})

test('the Agent bearer token never reaches the log', () => {
  // A log the user is asked to send us must not be the thing that leaks it.
  assert.match(redactSecrets('Authorization: Bearer abcdefghijklmnop1234'), /Bearer <redacted>/)
  assert.match(redactSecrets('{"token":"abcdefghijklmnop"}'), /<redacted>/)
  assert.equal(redactSecrets('nothing secret here'), 'nothing secret here')
})

test('a secret inside a tool argument is redacted too', () => {
  const [rec] = traceStreamLine({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Read', input: { auth: 'Bearer abcdefghijklmnop1234' } }] },
  })
  assert.match((rec as { input: string }).input, /<redacted>/)
})

test('the spawn line keeps every flag but the twelve-thousand-character persona', () => {
  // The prompt would bury the flags that actually differ between a working
  // turn and a broken one — and one token was the entire difference.
  assert.deepEqual(
    summariseArgv(['-p', '--append-system-prompt', 'x'.repeat(12309), '--resume', 'abc']),
    ['-p', '--append-system-prompt', '<12309 chars>', '--resume', 'abc'],
  )
})

test('the clip cap is stated, not implied', () => {
  assert.equal(TRACE_TEXT_MAX, 800)
})
