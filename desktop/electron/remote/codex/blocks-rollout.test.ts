import { test } from 'node:test'
import assert from 'node:assert/strict'
import { blocksFromRollout } from './blocks-rollout'
import type { Block } from '../blocks'

// Shapes below are copied from REAL rollout files measured on 2026-08-16 across
// 185 sessions (82,385 lines) — the field names and nesting are exactly what
// Codex writes. The CONTENT is synthetic on purpose: real rollouts are the
// user's own conversations and do not belong in the repo.
const ev = (type: string, payload: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'event_msg', payload: { type, ...payload } })
const ri = (type: string, payload: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'response_item', payload: { type, ...payload } })

const run = (lines: string[]) => blocksFromRollout(lines.join('\n'))
const only = <K extends Block['kind']>(bs: Block[], k: K) =>
  bs.filter((b): b is Extract<Block, { kind: K }> => b.kind === k)

test('a user message becomes a user message block', () => {
  const { blocks } = run([ev('user_message', { message: 'audit the numbers' })])
  const m = only(blocks, 'message')
  assert.equal(m.length, 1)
  assert.equal(m[0].role, 'user')
  assert.equal(m[0].text, 'audit the numbers')
})

test('the reply comes from task_complete, which is where the final text lives', () => {
  const { blocks } = run([
    ev('task_started', { turn_id: 't1' }),
    ev('agent_message', { message: 'the answer' }),
    ev('task_complete', { turn_id: 't1', last_agent_message: 'the answer', duration_ms: 2400 }),
  ])
  const m = only(blocks, 'message').filter((x) => x.role === 'assistant')
  assert.equal(m.length, 1, 'agent_message and task_complete must not both emit')
  assert.equal(m[0].text, 'the answer')
})

test('agent_reasoning becomes a reasoning block', () => {
  const { blocks } = run([ev('agent_reasoning', { text: 'Planning the retrieval' })])
  assert.equal(only(blocks, 'reasoning')[0].text, 'Planning the retrieval')
})

test('a tool call and its output pair into ONE command block', () => {
  const { blocks } = run([
    ri('custom_tool_call', { call_id: 'c1', name: 'shell', input: 'rg --files' }),
    ri('custom_tool_call_output', { call_id: 'c1', output: 'Exit code: 0\nWall time: 2.9 seconds\nOutput:\nsrc/a.ts' }),
  ])
  const cmds = only(blocks, 'command')
  assert.equal(cmds.length, 1)
  assert.equal(cmds[0].command, 'rg --files')
  assert.equal(cmds[0].status, 'ok')
  assert.match(cmds[0].output ?? '', /src\/a\.ts/)
})

test('a nonzero exit code in the output marks the command failed', () => {
  const { blocks } = run([
    ri('custom_tool_call', { call_id: 'c1', name: 'shell', input: 'false' }),
    ri('custom_tool_call_output', { call_id: 'c1', output: 'Exit code: 1\nOutput:\nboom' }),
  ])
  assert.equal(only(blocks, 'command')[0].status, 'failed')
})

test('a call with no output yet is still shown, and reads as running', () => {
  // The turn is mid-flight: the call is on disk, its result is not. Dropping it
  // would make a working task look idle.
  const { blocks } = run([ri('custom_tool_call', { call_id: 'c1', name: 'shell', input: 'sleep 30' })])
  assert.equal(only(blocks, 'command')[0].status, 'running')
})

test('patch_apply_end becomes a fileChange per file', () => {
  const { blocks } = run([
    ev('patch_apply_end', {
      success: true, status: 'completed',
      stdout: 'Success. Updated the following files:\nA notes.md\n',
      changes: { '/tmp/notes.md': { type: 'add', content: 'one\ntwo\n' } },
    }),
  ])
  const f = only(blocks, 'fileChange')
  assert.equal(f.length, 1)
  assert.equal(f[0].verb, 'Added')
  assert.equal(f[0].added, 2)
})

test('several files in one patch become several rows', () => {
  const { blocks } = run([
    ev('patch_apply_end', {
      success: true,
      changes: {
        '/tmp/a.ts': { type: 'add', content: 'x\n' },
        '/tmp/b.ts': { type: 'delete', content: 'y\nz\n' },
      },
    }),
  ])
  assert.equal(only(blocks, 'fileChange').length, 2)
})

test('mcp_tool_call_end carries server, tool and a real duration', () => {
  const { blocks } = run([
    ev('mcp_tool_call_end', {
      call_id: 'm1',
      invocation: { server: 'chrome-devtools', tool: 'list_pages', arguments: {} },
      duration: { secs: 1, nanos: 843033625 },
      read_only_hint: true,
    }),
  ])
  const m = only(blocks, 'mcpCall')[0]
  assert.equal(m.server, 'chrome-devtools')
  assert.equal(m.tool, 'list_pages')
  assert.equal(m.durationMs, 1843)
  assert.equal(m.readOnly, true)
})

test('web_search_end becomes a search block with real links', () => {
  const { blocks } = run([
    ev('web_search_end', {
      query: 'posthog pricing',
      results: [
        { type: 'text_result', domain: 'posthog.com', url: 'https://posthog.com/pricing', title: 'Pricing', snippet: 'per event' },
        { type: 'text_result', domain: 'www.cnbc.com', url: 'https://cnbc.com/x', title: 'Analytics' },
      ],
    }),
  ])
  const s = only(blocks, 'search')[0]
  assert.equal(s.query, 'posthog pricing')
  assert.equal(s.results.length, 2)
  assert.equal(s.results[0].url, 'https://posthog.com/pricing')
  assert.equal(s.results[0].title, 'Pricing')
})

test('a result with no url is dropped rather than rendered as a dead link', () => {
  const { blocks } = run([
    ev('web_search_end', { query: 'q', results: [{ type: 'text_result', domain: 'x.com' }] }),
  ])
  assert.equal(only(blocks, 'search')[0].results.length, 0)
})

test('sub_agent_activity becomes a subAgent block', () => {
  const { blocks } = run([ev('sub_agent_activity', { agent_path: '/root/research', kind: 'interacted' })])
  assert.equal(only(blocks, 'subAgent')[0].name, '/root/research')
})

test('context_compacted becomes a compaction marker', () => {
  const { blocks } = run([ev('context_compacted', {})])
  assert.equal(only(blocks, 'compaction').length, 1)
})

test('an error event becomes an error block', () => {
  const { blocks } = run([ev('error', { message: 'model refused' })])
  assert.equal(only(blocks, 'error')[0].message, 'model refused')
})

test('token_count yields usage against the real context window', () => {
  const { usage } = run([
    ev('token_count', {
      info: {
        total_token_usage: { total_tokens: 11240 },
        last_token_usage: { total_tokens: 9100 },
        model_context_window: 258400,
      },
      rate_limits: { primary: { used_percent: 5, resets_at: 1785559411 } },
    }),
  ])
  assert.equal(usage?.used, 9100)
  assert.equal(usage?.window, 258400)
  assert.equal(usage?.rateLimitPercent, 5)
})

test('the meter reads CURRENT context, not the thread lifetime', () => {
  // MEASURED ON A REAL 72-TURN THREAD: total_token_usage reaches 33,595,604
  // against a 258,400 window — a meter 13,000% full — because it is cumulative
  // spend. last_token_usage is what the window actually holds.
  const { usage } = run([
    ev('token_count', {
      info: {
        total_token_usage: { total_tokens: 33595604 },
        last_token_usage: { total_tokens: 167452 },
        model_context_window: 258400,
      },
    }),
  ])
  assert.equal(usage?.used, 167452)
  assert.ok((usage!.used / usage!.window) < 1, 'the meter must not exceed full')
})

test('an interrupted turn is recorded, not silently dropped', () => {
  // turn_aborted is how Escape ends a turn. It was ignored for so long that it
  // poisoned nine threads on this machine into permanent `processing`.
  const { blocks } = run([
    ev('task_started', { turn_id: 't1' }),
    ev('turn_aborted', { turn_id: 't1', reason: 'interrupted' }),
  ])
  assert.equal(only(blocks, 'denied').length, 1)
})

test('an unknown event type does not produce a row', () => {
  const { blocks } = run([ev('world_state_something', { x: 1 })])
  assert.equal(blocks.length, 0)
})

test('a torn last line does not throw — Codex writes while we read', () => {
  const { blocks } = run([ev('user_message', { message: 'hi' }), '{"type":"event_msg","pay'])
  assert.equal(only(blocks, 'message').length, 1)
})

test('the ordering of the file is preserved, with the turn clock around it', () => {
  const { blocks } = run([
    ev('task_started', { turn_id: 't', started_at: 1786552973 }),
    ev('user_message', { message: 'q' }),
    ev('agent_reasoning', { text: 'thinking' }),
    ri('custom_tool_call', { call_id: 'c1', name: 'shell', input: 'ls' }),
    ri('custom_tool_call_output', { call_id: 'c1', output: 'Exit code: 0\nOutput:\na' }),
    ev('task_complete', { turn_id: 't', last_agent_message: 'done', duration_ms: 63000 }),
  ])
  assert.deepEqual(blocks.map((b) => b.kind),
    ['turnStart', 'message', 'reasoning', 'command', 'turnEnd', 'message'])
})

test('the turn clock carries elapsed time, not summed step time', () => {
  // THE BUG THIS EXISTS FOR: the surface used to add up each step's wall time
  // and call it "Worked for 44s" while Codex's own window read 4m 19s. Steps
  // only account for subprocess seconds, never the minutes spent thinking
  // between them. task_complete reports the real wall time.
  const { blocks } = run([
    ev('task_started', { turn_id: 't', started_at: 1786552973 }),
    ri('custom_tool_call', { call_id: 'c1', name: 'shell', input: 'sleep 1' }),
    ri('custom_tool_call_output', { call_id: 'c1', output: 'Exit code: 0\nWall time: 1.0 seconds\nOutput:\n' }),
    ev('task_complete', { turn_id: 't', duration_ms: 259000 }),
  ])
  const start = blocks.find((b) => b.kind === 'turnStart') as Extract<Block, { kind: 'turnStart' }>
  const end = blocks.find((b) => b.kind === 'turnEnd') as Extract<Block, { kind: 'turnEnd' }>
  assert.equal(start.startedAt, 1786552973000, 'epoch seconds are scaled to ms')
  assert.equal(end.durationMs, 259000, 'the reported wall time, not the 1s of subprocess')
})

test('a command is named by what it did, not by "exec"', () => {
  const { blocks } = run([
    ri('function_call', { call_id: 'c1', name: 'exec_command', arguments: '{"cmd":"rg --files -g \'*.md\'"}' }),
  ])
  const cmd = blocks.find((b) => b.kind === 'command') as Extract<Block, { kind: 'command' }>
  assert.equal(cmd.label, 'Searched files')
  assert.equal(cmd.command, "rg --files -g '*.md'", 'the JSON wrapper is unwrapped')
})
