import assert from 'node:assert/strict'
import test from 'node:test'

import { codexIdentity, parseCodexTurnLine, parseTurnsFor } from './transcript'

const responseItem = (role: string, text: string, type = 'input_text') => JSON.stringify({
  type: 'response_item',
  timestamp: '2026-08-25T00:32:51.255Z',
  payload: { type: 'message', role, content: [{ type, text }] },
})

test('a Codex response_item becomes a Turn', () => {
  const turn = parseCodexTurnLine(responseItem('user', 'Look into Palmier Pro'))
  assert.deepEqual(turn, {
    role: 'user',
    text: 'Look into Palmier Pro',
    at: '2026-08-25T00:32:51.255Z',
  })
})

test('assistant output_text is a turn too', () => {
  const turn = parseCodexTurnLine(responseItem('assistant', 'It has no MCP server.', 'output_text'))
  assert.equal(turn?.role, 'assistant')
  assert.equal(turn?.text, 'It has no MCP server.')
})

/**
 * A rollout carries the same conversation twice — response_item AND event_msg.
 * Measured on a real file: 17/312 in one, 17/313 in the other. Taking both
 * doubles every turn, which would corrupt every summary built from it.
 */
test('event_msg is ignored, so turns are never counted twice', () => {
  const raw = [
    responseItem('user', 'the only real turn'),
    JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'the only real turn' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'a reply' } }),
  ].join('\n')
  const turns = parseTurnsFor('codex', raw)
  assert.equal(turns.length, 1)
  assert.equal(turns[0]!.text, 'the only real turn')
})

test('reasoning and tool output are dropped, as thinking is on the Claude side', () => {
  const raw = [
    JSON.stringify({ type: 'response_item', payload: { type: 'reasoning', content: [{ type: 'text', text: 'thinking aloud' }] } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'shell' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', output: 'a megabyte of stdout' } }),
    responseItem('assistant', 'I ran the tests.', 'output_text'),
  ].join('\n')
  const turns = parseTurnsFor('codex', raw)
  assert.equal(turns.length, 1)
  assert.equal(turns[0]!.text, 'I ran the tests.')
})

test('session_meta yields identity and nothing else', () => {
  const line = JSON.stringify({
    type: 'session_meta',
    payload: { session_id: 'cx-1', cwd: '/Users/me/proj', base_instructions: { text: 'x'.repeat(500) } },
  })
  assert.deepEqual(codexIdentity(line), { sessionId: 'cx-1', cwd: '/Users/me/proj' })
  assert.equal(parseCodexTurnLine(line), null)
})

test('a truncated or foreign line is skipped, never thrown', () => {
  assert.equal(parseCodexTurnLine('{"type":"response_item","payl'), null)
  assert.equal(parseCodexTurnLine(''), null)
  assert.deepEqual(codexIdentity('not json'), {})
})

test('the Claude side still routes to its own parser', () => {
  const raw = [
    JSON.stringify({ type: 'user', message: { content: 'a person typed this' } }),
    // Tool results ride user-role messages as arrays — 194 of 211 on a real session.
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'noise' }] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'a reply' }] } }),
  ].join('\n')
  const turns = parseTurnsFor('claude', raw)
  assert.equal(turns.length, 2)
  assert.deepEqual(turns.map((t) => t.role), ['user', 'assistant'])
})

test('a subagent sidechain is never the user conversation', () => {
  const raw = JSON.stringify({
    type: 'user', isSidechain: true, message: { content: 'a fork talking to itself' },
  })
  assert.equal(parseTurnsFor('claude', raw).length, 0)
})
