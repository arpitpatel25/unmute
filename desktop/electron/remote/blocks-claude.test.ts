import { test } from 'node:test'
import assert from 'node:assert/strict'
import { blocksFromClaudeTranscript } from './blocks-claude'
import type { Block } from './blocks'

// Shapes copied from REAL transcripts measured on 2026-08-16 across 400 files
// (55,956 lines). Content is synthetic: real transcripts are the user's own
// sessions and do not belong in the repo.
const assistant = (content: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5', content }, ...extra })
const user = (content: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'user', message: { role: 'user', content }, ...extra })

const run = (lines: string[]) => blocksFromClaudeTranscript(lines.join('\n'))
const only = <K extends Block['kind']>(bs: Block[], k: K) =>
  bs.filter((b): b is Extract<Block, { kind: K }> => b.kind === k)

test('a plain user prompt becomes a user message', () => {
  const { blocks } = run([user('check the transcripts')])
  const m = only(blocks, 'message')
  assert.equal(m[0].role, 'user')
  assert.equal(m[0].text, 'check the transcripts')
})

test('assistant text becomes an assistant message', () => {
  const { blocks } = run([assistant([{ type: 'text', text: 'confirmed' }])])
  assert.equal(only(blocks, 'message')[0].text, 'confirmed')
})

test('thinking with text becomes a reasoning block', () => {
  const { blocks } = run([assistant([{ type: 'thinking', thinking: 'the counter never rebalances' }])])
  assert.equal(only(blocks, 'reasoning')[0].text, 'the counter never rebalances')
})

test('a redacted thinking block produces NOTHING, not an empty row', () => {
  // MEASURED, AND IT CHANGED THE PLAN: all 6,995 thinking blocks in the
  // reference corpus carry `thinking: ""` with the content encrypted into
  // `signature`. Claude Code's reasoning is not readable from the transcript at
  // all, so the panel cannot show it — and must not draw a blank row implying
  // it could. Codex is the opposite: `agent_reasoning.text` carries real prose,
  // and 2,177 of them render.
  const { blocks } = run([
    assistant([{ type: 'thinking', thinking: '', signature: 'CAISpBMKhwEIEBgCKkB8APuJql73' }]),
  ])
  assert.equal(only(blocks, 'reasoning').length, 0)
  assert.equal(blocks.length, 0)
})

test('a sub-agent transcript yields nothing for the main thread', () => {
  // 284 of 400 real transcripts are entirely sidechain — they are a sub-agent's
  // own file. Producing nothing is correct, not a failure to parse.
  const { blocks } = run([
    user('inner prompt', { isSidechain: true }),
    assistant([{ type: 'text', text: 'inner reply' }], { isSidechain: true }),
  ])
  assert.equal(blocks.length, 0)
})

test('a Bash tool_use and its result pair into one command block', () => {
  const { blocks } = run([
    assistant([{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'grep -c task_started f.jsonl' } }]),
    user([{ type: 'tool_result', tool_use_id: 't1' }], { toolUseResult: { stdout: '72', stderr: '', interrupted: false } }),
  ])
  const c = only(blocks, 'command')
  assert.equal(c.length, 1)
  assert.equal(c[0].command, 'grep -c task_started f.jsonl')
  assert.equal(c[0].output, '72')
  assert.equal(c[0].status, 'ok')
})

test('a failing Bash reads as failed, from stderr not from guesswork', () => {
  const { blocks } = run([
    assistant([{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'false' } }]),
    user([{ type: 'tool_result', tool_use_id: 't1', is_error: true }], { toolUseResult: { stdout: '', stderr: 'boom', interrupted: false } }),
  ])
  assert.equal(only(blocks, 'command')[0].status, 'failed')
})

test('an Edit becomes a fileChange with lines counted from structuredPatch', () => {
  const { blocks } = run([
    assistant([{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/repo/a.ts' } }]),
    user([{ type: 'tool_result', tool_use_id: 't1' }], {
      toolUseResult: {
        filePath: '/repo/a.ts',
        structuredPatch: [{ oldStart: 30, oldLines: 6, newStart: 30, newLines: 45,
          lines: [' ctx', '+one', '+two', '+three', '-gone'] }],
      },
    }),
  ])
  const f = only(blocks, 'fileChange')[0]
  assert.equal(f.path, '/repo/a.ts')
  assert.equal(f.verb, 'Edited')
  assert.equal(f.added, 3)
  assert.equal(f.removed, 1)
})

test('a Write with an empty patch is Added, counted from content', () => {
  const { blocks } = run([
    assistant([{ type: 'tool_use', id: 't1', name: 'Write', input: { file_path: '/repo/new.md' } }]),
    user([{ type: 'tool_result', tool_use_id: 't1' }], {
      toolUseResult: { type: 'create', filePath: '/repo/new.md', content: 'a\nb\nc\n', structuredPatch: [] },
    }),
  ])
  const f = only(blocks, 'fileChange')[0]
  assert.equal(f.verb, 'Added')
  assert.equal(f.added, 3)
})

test('a Read becomes a fileRead, not a command', () => {
  const { blocks } = run([
    assistant([{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/repo/x.ts' } }]),
    user([{ type: 'tool_result', tool_use_id: 't1' }], {
      toolUseResult: { type: 'text', file: { filePath: '/repo/x.ts', content: 'a\nb\n' } },
    }),
  ])
  assert.equal(only(blocks, 'fileRead')[0].path, '/repo/x.ts')
})

test('WebSearch becomes a search block with real links', () => {
  const { blocks } = run([
    assistant([{ type: 'tool_use', id: 't1', name: 'WebSearch', input: { query: 'posthog pricing' } }]),
    user([{ type: 'tool_result', tool_use_id: 't1' }], {
      toolUseResult: { query: 'posthog pricing', results: [
        { title: 'Pricing', url: 'https://posthog.com/pricing' },
      ] },
    }),
  ])
  const s = only(blocks, 'search')[0]
  assert.equal(s.query, 'posthog pricing')
  assert.equal(s.results[0].domain, 'posthog.com')
})

test('an MCP tool becomes an mcpCall with its server split out', () => {
  const { blocks } = run([
    assistant([{ type: 'tool_use', id: 't1', name: 'mcp__unmute-computer__click', input: { x: 1 } }],
      { attributionMcpServer: 'unmute-computer', attributionMcpTool: 'click' }),
  ])
  const m = only(blocks, 'mcpCall')[0]
  assert.equal(m.server, 'unmute-computer')
  assert.equal(m.tool, 'click')
})

test('an MCP tool name parses even without attribution fields', () => {
  const { blocks } = run([
    assistant([{ type: 'tool_use', id: 't1', name: 'mcp__chrome-devtools__list_pages', input: {} }]),
  ])
  const m = only(blocks, 'mcpCall')[0]
  assert.equal(m.server, 'chrome-devtools')
  assert.equal(m.tool, 'list_pages')
})

// ── the things that were invisible ─────────────────────────────────────────

test('a REJECTED tool call is a denied block, not a silent success', () => {
  // 33 of these in the reference corpus. They rendered identically to a
  // successful call, which is the UI lying about what happened.
  const { blocks } = run([
    assistant([{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'rm -rf ./cache' } }]),
    user([{ type: 'tool_result', tool_use_id: 't1' }], { toolDenialKind: 'user-rejected' }),
  ])
  const d = only(blocks, 'denied')
  assert.equal(d.length, 1)
  assert.match(d[0].what, /rm -rf/)
  assert.equal(only(blocks, 'command').length, 0, 'a rejected call must not also read as run')
})

test('a sub-agent turn becomes a subAgent block, so nested work is not a stall', () => {
  const { blocks } = run([
    assistant([{ type: 'tool_use', id: 't1', name: 'Agent', input: { description: 'search the parsers' } }]),
  ])
  assert.match(only(blocks, 'subAgent')[0].name, /search the parsers/)
})

test('an api error becomes an error block', () => {
  const { blocks } = run([
    assistant([{ type: 'text', text: 'overloaded' }], { isApiErrorMessage: true, apiErrorStatus: 529 }),
  ])
  assert.equal(only(blocks, 'error').length, 1)
})

test('compaction reports what it cost', () => {
  const { blocks } = run([
    JSON.stringify({ type: 'system', subtype: 'compact_boundary',
      compactMetadata: { trigger: 'auto', preTokens: 1000709, postTokens: 27284 } }),
  ])
  const c = only(blocks, 'compaction')[0]
  assert.equal(c.before, 1000709)
  assert.equal(c.after, 27284)
  assert.equal(c.trigger, 'auto')
})

test('usage is read from the last assistant message', () => {
  const { usage } = run([
    assistant([{ type: 'text', text: 'x' }]),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'y' }],
      usage: { input_tokens: 2, output_tokens: 1317, cache_read_input_tokens: 20623, cache_creation_input_tokens: 36516 } } }),
  ])
  assert.ok(usage && usage.used > 20000, 'cache reads count toward the window')
})

// ── hygiene ────────────────────────────────────────────────────────────────

test('a sidechain entry does not pollute the main thread', () => {
  // Sub-agent internals live in the same file, flagged isSidechain. Inlining
  // them would interleave another agent's work into this conversation.
  const { blocks } = run([
    user('real prompt'),
    assistant([{ type: 'text', text: 'inner monologue' }], { isSidechain: true }),
  ])
  assert.equal(only(blocks, 'message').length, 1)
})

test('meta and command-output entries are not shown as user speech', () => {
  const { blocks } = run([
    user('<local-command-stdout></local-command-stdout>', { isMeta: true }),
    user('real prompt'),
  ])
  const m = only(blocks, 'message')
  assert.equal(m.length, 1)
  assert.equal(m[0].text, 'real prompt')
})

test('a torn last line does not throw', () => {
  const { blocks } = run([user('hi'), '{"type":"assist'])
  assert.equal(only(blocks, 'message').length, 1)
})

test('ordering is preserved across mixed entries', () => {
  const { blocks } = run([
    user('q'),
    assistant([{ type: 'thinking', thinking: 'hm' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }]),
    user([{ type: 'tool_result', tool_use_id: 't1' }], { toolUseResult: { stdout: 'a', stderr: '', interrupted: false } }),
    assistant([{ type: 'text', text: 'done' }]),
  ])
  assert.deepEqual(blocks.map((b) => b.kind), ['message', 'reasoning', 'command', 'message'])
})
