import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { ClaudeTaskChannel } from './task-channel'
import { blocksFromClaudeTranscript } from '../blocks-claude'
import { groupIntoTurns, turnMetaOf } from '../blocks'
import { retainClaudeHistoryDisplay } from './chat-history'

test('pending recovered tools complete after retained display checkpoint through live and replay without loss or duplication', () => {
  const cases = [
    { name: 'mcp__tools__read', input: {}, kind: 'mcpCall', result: { status: 'completed', structuredContent: { finding: 'unique structured finding' } }, content: 'unique completed MCP result', match: /unique completed MCP result/, structured: /unique structured finding/ },
    { name: 'Bash', input: { command: 'read-data' }, kind: 'command', result: { stdout: 'unique command output', exitCode: 0 }, content: 'command completed', match: /unique command output/ },
    { name: 'Edit', input: { file_path: '/file' }, kind: 'fileChange', result: { structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+unique patch'] }] }, content: 'file completed', match: /\+unique patch/ },
    { name: 'Agent', input: { description: 'child' }, kind: 'subAgent', result: { status: 'failed', error: 'unique child error' }, content: 'unique child finding', match: /unique child finding/, structured: /unique child error/ },
  ]
  for (const item of cases) {
    const patches: any[] = [], saved: any[] = []
    const channel = new ClaudeTaskChannel(p => patches.push(p), f => saved.push(structuredClone(f)))
    const recovered = [{ type: 'system', unmuteHistoryIncomplete: true }, { type: 'assistant', uuid: 'pending', message: { content: [{ type: 'tool_use', id: 'pending-tool', name: item.name, input: item.input }] } }]
    channel.restore(retainClaudeHistoryDisplay(recovered, [{ kind: 'message', role: 'user', text: 'Previously readable prompt' }]))
    channel.mergeHistory(recovered); channel.mergeHistory(recovered)
    assert.deepEqual(patches.at(-1).blocks, [{ kind: 'message', role: 'user', text: 'Previously readable prompt' }])
    const completion = { type: 'user', uuid: 'result', tool_use_result: item.result, message: { content: [{ type: 'tool_result', tool_use_id: 'pending-tool', content: item.content }] } }
    channel.event({ type: 'message', message: completion }); channel.event({ type: 'message', message: completion })
    const blocks = patches.at(-1).blocks
    assert.equal(blocks.length, 2); assert.equal(blocks[0].text, 'Previously readable prompt')
    assert.equal(blocks[1].kind, item.kind)
    assert.match(blocks[1].diff ?? blocks[1].output, item.match)
    if (item.structured) assert.match(blocks[1].output, item.structured)
    channel.mergeHistory([...recovered, completion]); channel.mergeHistory([...recovered, completion])
    assert.deepEqual(patches.at(-1).blocks, blocks)
    const replay: any[] = []; new ClaudeTaskChannel(p => replay.push(p)).restore(saved.at(-1))
    assert.deepEqual(replay.at(-1).blocks, blocks)
  }
})

test('result supplied by partial recovery after checkpoint materializes the pending call once', () => {
  const patches: any[] = [], channel = new ClaudeTaskChannel(p => patches.push(p))
  const recovered = [{ type: 'system', unmuteHistoryIncomplete: true }, { type: 'assistant', uuid: 'call', message: { content: [{ type: 'tool_use', id: 'm', name: 'mcp__tools__read', input: {} }] } }]
  channel.restore(retainClaudeHistoryDisplay(recovered, [{ kind: 'message', role: 'user', text: 'Retained' }]))
  const completion = { type: 'user', uuid: 'completed', tool_use_result: { status: 'completed', structuredContent: { finding: 'recovered structured content' } }, message: { content: [{ type: 'tool_result', tool_use_id: 'm', content: 'recovered unique result' }] } }
  channel.mergeHistory([...recovered, completion]); channel.mergeHistory([...recovered, completion])
  assert.equal(patches.at(-1).blocks.length, 2)
  assert.equal(patches.at(-1).blocks[0].text, 'Retained')
  assert.match(patches.at(-1).blocks[1].output, /recovered unique result/)
  assert.match(patches.at(-1).blocks[1].output, /recovered structured content/)
})

test('checkpoint with known pending projection updates its own row and denial cannot remove unrelated retained content', () => {
  const recovered = [{ type: 'system', unmuteHistoryIncomplete: true }, { type: 'assistant', uuid: 'a', message: { content: [{ type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'pending command' } }] } }]
  const projection = blocksFromClaudeTranscript(ClaudeTaskChannel.displayTranscript(recovered))
  const patches: any[] = [], channel = new ClaudeTaskChannel(p => patches.push(p))
  channel.restore(retainClaudeHistoryDisplay(recovered, projection.blocks, (projection as any).pendingTools))
  channel.event({ type: 'message', message: { type: 'user', uuid: 'result', tool_use_result: { stdout: 'unique result', status: 'completed' }, message: { content: [{ type: 'tool_result', tool_use_id: 'b', content: 'completed' }] } } })
  assert.equal(patches.at(-1).blocks.length, 1)
  assert.equal(patches.at(-1).blocks[0].status, 'ok')
  assert.match(patches.at(-1).blocks[0].output, /unique result/)
  channel.restore(retainClaudeHistoryDisplay(recovered, [{ kind: 'message', role: 'user', text: 'Unrelated retained prompt' }]))
  channel.event({ type: 'message', message: { type: 'user', uuid: 'denial', toolDenialKind: 'User denied', message: { content: [{ type: 'tool_result', tool_use_id: 'b', content: 'denied' }] } } })
  assert.equal(patches.at(-1).blocks.length, 2)
  assert.equal(patches.at(-1).blocks[0].text, 'Unrelated retained prompt')
  assert.equal(patches.at(-1).blocks[1].kind, 'denied')
})

test('installed snake_case structured tool results survive live channel and persisted replay', () => {
  for (const field of ['tool_use_result', 'toolUseResult']) {
    const patches: any[] = [], saved: any[] = []
    const channel = new ClaudeTaskChannel(p => patches.push(p), f => saved.push(structuredClone(f)))
    const results = [
      { id: 'edit', name: 'Edit', input: { file_path: '/a' }, result: { structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+new'] }] }, content: 'The file has been updated successfully.' },
      { id: 'cmd', name: 'Bash', input: { command: 'sleep 10' }, result: { interrupted: true, stdout: 'partial stdout', stderr: 'partial stderr', exitCode: 130 }, content: 'Command interrupted' },
      { id: 'mcp', name: 'mcp__server__read', input: {}, result: { status: 'cancelled', structuredContent: { full: 'retained member' }, error: { message: 'cancelled externally' } }, content: 'Partial MCP result' },
    ]
    for (const r of results) {
      channel.event({ type: 'message', message: { type: 'assistant', uuid: `a-${r.id}`, message: { content: [{ type: 'tool_use', id: r.id, name: r.name, input: r.input }] } } })
      channel.event({ type: 'message', message: { type: 'user', uuid: `r-${r.id}`, [field]: r.result, message: { content: [{ type: 'tool_result', tool_use_id: r.id, content: r.content }] } } })
    }
    const blocks = patches.at(-1).blocks
    assert.match(blocks[0].diff, /-old\n\+new/); assert.equal(blocks[0].added, 1); assert.equal(blocks[0].removed, 1)
    assert.equal(blocks[1].status, 'cancelled'); assert.equal(blocks[1].exitCode, 130)
    assert.match(blocks[1].output, /partial stdout/); assert.match(blocks[1].output, /partial stderr/)
    assert.equal(blocks[2].status, 'cancelled'); assert.match(blocks[2].output, /retained member/); assert.match(blocks[2].output, /Partial MCP result/)
    assert.match(blocks[2].error, /cancelled externally/)
    assert.deepEqual(blocksFromClaudeTranscript(saved.at(-1).map((f: any) => JSON.stringify(f)).join('\n')).blocks, blocks)
  }
})

test('Claude subagent complete result and errors survive live and restored frames for each final status', () => {
  for (const status of ['completed', 'failed', 'cancelled', 'denied']) {
    const patches: any[] = [], saved: any[] = []
    const channel = new ClaudeTaskChannel(p => patches.push(p), f => saved.push(structuredClone(f)))
    channel.event({ type: 'message', message: { type: 'assistant', uuid: 'a', message: { content: [{ type: 'tool_use', id: 'agent', name: 'Agent', input: { description: 'inspect' } }] } } })
    channel.event({ type: 'message', message: { type: 'user', uuid: 'r', tool_use_result: { status, ...(status !== 'completed' ? { error: 'Full child failure detail' } : {}) }, message: { content: [{ type: 'tool_result', tool_use_id: 'agent', content: 'The complete child-agent finding', is_error: status === 'failed' }] } } })
    const block = patches.at(-1).blocks[0]
    assert.equal(block.status, status === 'completed' ? 'done' : status)
    assert.match(block.output, /The complete child-agent finding/)
    if (status !== 'completed') assert.match(block.output, /Full child failure detail/)
    const restored: any[] = []; new ClaudeTaskChannel(p => restored.push(p)).restore(saved.at(-1))
    assert.deepEqual(restored.at(-1).blocks, patches.at(-1).blocks)
  }
})

test('explicit MCP cancellation and denial take precedence over the legacy failure flag', () => {
  for (const status of ['cancelled', 'denied'] as const) assert.equal(turnMetaOf([{ kind: 'mcpCall', server: 's', tool: 't', status, ok: false }]).status, status)
  assert.equal(turnMetaOf([{ kind: 'mcpCall', server: 's', tool: 't', ok: false }]).status, 'failed')
})

test('history recovery preserves owned UUID metadata and cancelled boundaries before later prompts', () => {
  const patches: any[] = [], saved: any[] = []
  const channel = new ClaudeTaskChannel(p => patches.push(p), f => saved.push(structuredClone(f)))
  const user = (uuid: string, text: string) => ({ type: 'user', uuid, message: { content: [{ type: 'text', text }] } })
  const local = [
    { type: 'system', unmuteHistoryIncomplete: true },
    { type: 'system', uuid: 's1', unmuteTurnStart: 10 },
    { ...user('u1', 'expanded provider paste'), unmuteDisplayText: 'Review this', unmuteAttachments: [{ path: '/paste.txt', name: 'Pasted text', mimeType: 'text/x-unmute-paste' }] },
    { type: 'system', uuid: 'e1', unmuteTurnEnd: 'cancelled' },
    { type: 'system', uuid: 's2', unmuteTurnStart: 20 },
    user('u2', 'locally readable second prompt'),
  ]
  channel.restore(local)
  channel.mergeHistory([user('u0', 'older prompt'), user('u1', 'expanded provider paste'), user('u3', 'later prompt')])
  const frames = saved.at(-1)
  assert.deepEqual(frames.map((f: any) => f.uuid), ['u0', 's1', 'u1', 'e1', 's2', 'u2', 'u3'])
  assert.equal(frames.find((f: any) => f.uuid === 'u1').unmuteDisplayText, 'Review this')
  assert.equal(patches.at(-1).blocks.filter((b: any) => b.kind === 'attachment').length, 1)
  assert.deepEqual(patches.at(-1).blocks.filter((b: any) => b.kind === 'message').map((b: any) => b.text), ['older prompt', 'Review this', 'locally readable second prompt', 'later prompt'])
  assert.ok(patches.at(-1).blocks.findIndex((b: any) => b.kind === 'turnEnd') < patches.at(-1).blocks.findIndex((b: any) => b.text === 'later prompt'))
  channel.mergeHistory([user('u0', 'older prompt'), user('u1', 'expanded provider paste'), user('u3', 'later prompt')])
  assert.deepEqual(saved.at(-1), frames, 'repeat recovery is idempotent')
})

test('reviewer u1 cancelled u2 recovery keeps cancellation on u1 in actual turn grouping', () => {
  const patches: any[] = [], channel = new ClaudeTaskChannel(p => patches.push(p))
  const user = (uuid: string) => ({ type: 'user', uuid, message: { content: [{ type: 'text', text: uuid }] } })
  channel.restore([{ type: 'system', unmuteHistoryIncomplete: true },
    { ...user('u1'), unmuteDisplayText: 'Original u1', unmuteAttachments: [{ path: '/paste.txt', name: 'Paste', mimeType: 'text/x-unmute-paste' }] },
    { type: 'system', uuid: 'end-u1', unmuteTurnEnd: 'cancelled' }])
  channel.mergeHistory([user('u1'), user('u2')])
  const turns = groupIntoTurns(patches.at(-1).blocks)
  assert.equal(turns.length, 2)
  assert.equal(turns[0].prompt?.text, 'Original u1')
  assert.equal(turns[0].meta.status, 'cancelled')
  assert.equal(turns[0].work.filter(b => b.kind === 'attachment').length, 1)
  assert.equal(turns[1].prompt?.text, 'u2')
  assert.notEqual(turns[1].meta.status, 'cancelled')
})

test('provider-confirmed interruption remains Cancelled through its duplicate error event and persisted replay', () => {
  const patches: any[] = [], saved: any[] = []
  const channel = new ClaudeTaskChannel(p => patches.push(p), f => saved.push(structuredClone(f)))
  channel.event({ type: 'turn-start', submissionId: 'turn', sessionId: 'session' })
  channel.event({ type: 'result', submissionId: 'turn', message: { is_error: true, errors: ['Interrupted by user'], interrupted: true } })
  channel.event({ type: 'error', message: 'Interrupted by user' })
  assert.equal(patches.findLast(p => p.turnOutcome)?.turnOutcome, 'cancelled')
  assert.equal(patches.findLast(p => p.state)?.state, 'done')
  const restored: any[] = []
  new ClaudeTaskChannel(p => restored.push(p)).restore(saved.at(-1))
  assert.equal(restored.at(-1).blocks.at(-1).outcome, 'cancelled')
})

test('Claude initialization MCP status retains provider-exposed failures alongside existing messages', () => {
  const patches: any[] = [], channel = new ClaudeTaskChannel(p => patches.push(p))
  channel.event({ type: 'message', message: { type: 'system', subtype: 'init', mcp_servers: [{ name: 'drive', status: 'failed', error: 'Credentials expired' }] } })
  assert.equal(patches.find(p => p.mcpStatus)?.mcpStatus.error, 'Credentials expired')
})

test('a request preceding the stdin acknowledgement stays visible on turn-start', () => {
  const patches: any[] = []
  const channel = new ClaudeTaskChannel(p => patches.push(p))
  channel.event({ type: 'request', requestId: 'r', kind: 'permission', tool: 'Read', input: {}, payload: {} })
  channel.event({ type: 'turn-start', submissionId: 's', sessionId: 'c' })
  assert.equal(patches.at(-1).state, 'needs-user')
  assert.match(patches.at(-1).question.text, /Read/)
})

test('live compaction frames normalize metadata and expose only provider status', () => {
  const patches: any[] = [], saved: any[] = []
  const channel = new ClaudeTaskChannel(p => patches.push(p), frames => saved.push(structuredClone(frames)))
  channel.event({ type: 'message', message: { type: 'system', subtype: 'status', status: 'compacting' } })
  assert.deepEqual(patches.findLast(p => p.activity)?.activity, { kind: 'lifecycle', label: 'Compacting context' })
  channel.event({ type: 'message', message: { type: 'system', subtype: 'compact_boundary', uuid: 'c', compact_metadata: { trigger: 'auto', pre_tokens: 12345 } } })
  assert.ok(patches.at(-1).blocks.some((b: any) => b.kind === 'compaction' && b.before === 12345))
  assert.deepEqual(saved.at(-1).at(-1).compact_metadata, { trigger: 'auto', pre_tokens: 12345 })
  channel.event({ type: 'message', message: { type: 'system', subtype: 'status', status: null } })
  assert.equal(patches.findLast(p => 'activity' in p).activity, null)
})

test('sent paste display shows prose and a tile while private history retains full content', () => {
  const patches: any[] = [], saved: any[] = []
  const channel = new ClaudeTaskChannel(p => patches.push(p), frames => saved.push(structuredClone(frames)))
  const paste = 'full pasted source\n'.repeat(100)
  channel.expectSubmission('u', [{ type: 'text', text: 'Review ' }, { type: 'text', text: paste, attachment: { path: '/tmp/paste.txt', name: 'Pasted text', mimeType: 'text/x-unmute-paste' } }, { type: 'text', text: ' please' }])
  channel.event({ type: 'message', message: { type: 'user', uuid: 'u', message: { content: [{ type: 'text', text: 'Review ' + paste + ' please' }] } } })
  assert.deepEqual(patches.at(-1).blocks.filter((b: any) => b.kind === 'message').map((b: any) => b.text), ['Review  please'])
  assert.ok(patches.at(-1).blocks.some((b: any) => b.kind === 'attachment' && b.path === '/tmp/paste.txt'))
  assert.equal(saved.at(-1)[0].message.content[0].text, 'Review ' + paste + ' please')
  const restored: any[] = []
  new ClaudeTaskChannel(p => restored.push(p)).restore(saved.at(-1))
  assert.deepEqual(restored.at(-1).blocks, patches.at(-1).blocks)
})

test('a late approval resolution cannot restart a completed turn', () => {
  const patches: any[] = []
  const c = new ClaudeTaskChannel(p => patches.push(p))
  c.event({ type: 'turn-start', submissionId: 's', sessionId: 'c' })
  c.event({ type: 'request', requestId: 'r', kind: 'permission', tool: 'Read', input: {}, payload: {} })
  c.event({ type: 'result', message: { type: 'result', result: 'Done' } })
  c.event({ type: 'request-resolved', requestId: 'r' })
  assert.equal(patches.filter(p => p.state).at(-1).state, 'done')
  assert.equal(c.pending, false)
})

test('streamed text is replaced by the final frame, and replayed messages are deduplicated', () => {
  const patches: any[] = []
  const c = new ClaudeTaskChannel(p => patches.push(p))
  c.event({ type: 'message', message: { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } } } })
  const frame = { type: 'assistant', uuid: 'a', message: { id: 'm', content: [{ type: 'text', text: 'Hello world' }] } }
  c.event({ type: 'message', message: frame })
  c.event({ type: 'message', message: frame })
  const at = patches.at(-1).blocks[0].at
  assert.equal(typeof at, 'number')
  assert.ok(Math.abs(Date.now() - at) < 1000)
  assert.deepEqual(patches.at(-1).blocks, [{ kind: 'message', role: 'assistant', text: 'Hello world', at }])
})

test('questions remain separately correlated and advance only after delivered answers', async () => {
  const patches: any[] = [], answers: any[] = []
  const c = new ClaudeTaskChannel(p => patches.push(p))
  c.event({ type: 'request', requestId: 'r', kind: 'question', tool: 'AskUserQuestion', input: { questions: [{ question: 'First?' }, { question: 'Second?' }] }, payload: {} })
  const driver = { answer: async (...args: any[]) => { answers.push(args) } }
  await c.answer('one', driver as any)
  assert.equal(patches.at(-1).question.text, 'Second?')
  await c.answer('two', driver as any)
  assert.deepEqual(answers[0], ['r', { behavior: 'answer', answers: { 'First?': 'one', 'Second?': 'two' } }])
})
