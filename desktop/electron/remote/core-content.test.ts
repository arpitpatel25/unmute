import { test } from 'node:test'
import assert from 'node:assert/strict'
import { blockFromCodexItem, CodexBlockStream, foldAppServerBlocks } from './codex/blocks-app-server'
import { blocksFromClaudeTranscript } from './blocks-claude'
import { turnMetaOf } from './blocks'
import { reduceAppServerEvent, questionFromApproval, responseForApproval } from './codex/app-server-events'
import { TaskManager } from './task-manager'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readClaudeHistory } from './claude/chat-history'

test('Codex retains every changed file and complete patch in one stable item', () => {
  const changes = [{ path: '/a', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-old\n+new\n' },
    { path: '/b', kind: { type: 'add' }, diff: '+second\n' }]
  const events = ['item/started', 'item/completed'].map(method => ({ method, params: { item: { type: 'fileChange', id: 'f', status: 'completed', changes } } }))
  const blocks = foldAppServerBlocks(events).blocks
  assert.equal(blocks.length, 1)
  assert.deepEqual((blocks[0] as any).changes.map((c: any) => [c.path, c.diff]), changes.map(c => [c.path, c.diff]))
  assert.equal(turnMetaOf(blocks).files, 2)
})

test('legacy approval requests cannot bypass immutable escalation caps', () => {
  const cap = { roots: ['/allowed'], fullAccessAllowed: false }
  for (const method of ['execCommandApproval', 'applyPatchApproval']) {
    const params = { command: ['touch', '/outside/file'], cwd: '/allowed', fileChanges: { '/outside/file': { diff: '+full content' } } }
    const question = questionFromApproval(method, params, undefined, cap)!
    assert.deepEqual(question.choices, ['Deny'])
    assert.match(question.details!, /enforced roots/)
    assert.equal(responseForApproval(method, params, 'Approve', cap), undefined)
    assert.deepEqual(responseForApproval(method, params, 'Deny', cap), { decision: 'denied' })
  }
})

test('Claude creation with no patch hunks retains complete created content', () => {
  const content = 'first\nsecond\n'
  const frames = [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'f', name: 'Write', input: { file_path: '/a', content } }] } },
    { type: 'user', toolUseResult: { structuredPatch: [], content, type: 'create' }, message: { content: [{ type: 'tool_result', tool_use_id: 'f', content: 'created' }] } },
  ]
  const block = blocksFromClaudeTranscript(frames.map(f => JSON.stringify(f)).join('\n')).blocks[0] as any
  assert.equal(block.diff, content)
})

test('explicit failed, denied and interrupted commands cannot become successful without exit codes', () => {
  for (const [status, expected] of [['failed', 'failed'], ['declined', 'denied'], ['interrupted', 'cancelled']]) {
    assert.equal((blockFromCodexItem({ type: 'commandExecution', command: 'echo x', status }) as any).status, expected)
  }
})

test('Codex MCP results and errors retain full content and final status', () => {
  const body = 'long tool output\n'.repeat(4000)
  for (const [status, expected] of [['completed', 'succeeded'], ['failed', 'failed'], ['cancelled', 'cancelled']]) {
    const b = blockFromCodexItem({ type: 'mcpToolCall', server: 'tools', tool: 'read', status,
      result: { content: [{ type: 'text', text: body }] }, error: status === 'failed' ? { message: 'Denied by server' } : null }) as any
    assert.equal(b.status, expected)
    assert.equal(JSON.parse(b.output).content[0].text, body)
    if (status === 'failed') assert.match(b.error, /Denied by server/)
  }
})

test('Claude retains structured patches and complete MCP results from tool result envelopes', () => {
  const patch = [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+new'] }]
  const output = 'full output\n'.repeat(4000)
  const frames = [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'f', name: 'Edit', input: { file_path: '/a' } }, { type: 'tool_use', id: 'm', name: 'mcp__x__read', input: {} }] } },
    { type: 'user', toolUseResult: { structuredPatch: patch }, message: { content: [{ type: 'tool_result', tool_use_id: 'f', content: 'edited' }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'm', content: [{ type: 'text', text: output }], is_error: true }] } },
  ]
  const blocks = blocksFromClaudeTranscript(frames.map(f => JSON.stringify(f)).join('\n')).blocks as any[]
  assert.match(blocks[0].diff, /-old\n\+new/)
  assert.equal(blocks[1].status, 'failed')
  assert.equal(JSON.parse(blocks[1].output)[0].text, output)
})

test('plans update only their own turn and cancelled turn boundaries retain outcome', () => {
  const stream = new CodexBlockStream()
  for (const turnId of ['one', 'two']) {
    stream.push({ method: 'turn/started', params: { turn: { id: turnId } } })
    stream.push({ method: 'turn/plan/updated', params: { turnId, plan: [{ step: turnId, status: 'inProgress' }] } })
    stream.push({ method: 'turn/completed', params: { turn: { id: turnId, status: 'interrupted' } } })
  }
  const blocks = stream.snapshot().blocks
  assert.deepEqual(blocks.filter(b => b.kind === 'plan').map(b => b.steps[0].text), ['one', 'two'])
  assert.equal((blocks.at(-1) as any).outcome, 'cancelled')
  assert.equal(turnMetaOf(blocks).status, 'cancelled')
})

test('literal XML, comments and AGENTS headings survive both replay and owned overlay exactly once', () => {
  for (const text of ['<example>literal</example>', '<!-- my comment -->', '# AGENTS.md\nMy requested instructions']) {
    const stream = new CodexBlockStream()
    stream.registerInputMetadata([{ type: 'text', text }], 'turn')
    const event = { method: 'item/completed', params: { turnId: 'turn', item: { type: 'userMessage', id: 'u', content: [{ type: 'text', text }] } } }
    assert.deepEqual(foldAppServerBlocks([event]).blocks, [{ kind: 'message', role: 'user', text }])
    stream.push(event); stream.push(event)
    assert.deepEqual(stream.snapshot().blocks, [{ kind: 'message', role: 'user', text }])
  }
})

test('provider cancellation and MCP startup errors remain authoritative visible patches', () => {
  assert.equal((reduceAppServerEvent({ method: 'turn/completed', params: { turn: { status: 'interrupted' } } }) as any).turnOutcome, 'cancelled')
  const patch = reduceAppServerEvent({ method: 'mcpServer/startupStatus/updated', params: { name: 'drive', status: 'failed', error: 'Token expired', failureReason: 'reauthenticationRequired' } }) as any
  assert.equal(patch.mcpStatus.name, 'drive')
  assert.equal(patch.mcpStatus.error, 'Token expired')
})

test('owned Claude distinguishes unstarted, missing, failed and recovered history without losing the old transcript', async t => {
  const baseDir = await fs.mkdtemp(join(tmpdir(), 'core-content-history-'))
  const manager = new TaskManager({ baseDir, executorFactory: () => { throw new Error('No provider launch') } })
  t.after(async () => { manager.shutdown(); await Promise.all([...(manager as any).metaChains.values()]); await fs.rm(baseDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 }) })
  const id = await manager.createChat({ provider: 'claude' }), task = manager.get(id)!
  await manager.loadBlocksFor(id)
  assert.equal((task as any).history?.phase, 'empty')
  task.chatUnstarted = false; task.sessionId = undefined as any
  await manager.loadBlocksFor(id, true)
  assert.equal((task as any).history?.phase, 'missing')
  task.blocks = [{ kind: 'message', role: 'user', text: 'prior prompt' }]
  await fs.writeFile(join(task.home, 'chat-frames.json'), '{bad json')
  await manager.loadBlocksFor(id, true)
  assert.equal((task as any).history?.phase, 'failed')
  assert.equal((task.blocks[0] as any).text, 'prior prompt')
  await fs.writeFile(join(task.home, 'chat-frames.json'), JSON.stringify([{ type: 'system', unmuteHistoryIncomplete: true }, { type: 'user', uuid: 'partial', message: { content: [{ type: 'text', text: 'partial recovered prompt' }] } }]))
  await manager.loadBlocksFor(id, true)
  assert.equal(task.history?.phase, 'partial')
  assert.equal((task.blocks[0] as any).text, 'prior prompt', 'partial recovery must not replace readable disconnected content')
  await fs.writeFile(join(task.home, 'chat-frames.json'), JSON.stringify([{ type: 'user', uuid: 'u', message: { content: [{ type: 'text', text: '<literal>recovered</literal>' }] } }]))
  await manager.loadBlocksFor(id, true)
  assert.equal((task as any).history?.phase, 'ready')
  assert.equal((task.blocks[0] as any).text, '<literal>recovered</literal>')
})

test('owned Codex history loads from durable rollout without acquiring a writer', async t => {
  const baseDir = await fs.mkdtemp(join(tmpdir(), 'core-content-codex-history-'))
  let resumes = 0
  const hub = { running: true, threadIdFor() { return undefined },
    async resumeThread() { resumes++; throw new Error('active writer') } }
  const manager = new TaskManager({ baseDir, codexHub: hub as never,
    executorFactory: () => { throw new Error('No provider launch') }, codexFullAccess: () => true, permissionMode: () => 'auto-approve' })
  t.after(async () => { manager.shutdown(); await Promise.all([...(manager as any).metaChains.values()]); await fs.rm(baseDir, { recursive: true, force: true }) })
  const id = await manager.createChat({ provider: 'codex' }), task = manager.get(id)!
  task.chatUnstarted = false; task.sessionId = 'thread'; task.codexRolloutId = 'thread'
  ;(manager as any).refreshCodexBlocks = async () => { task.blocks = [{ kind: 'message', role: 'assistant', text: 'Recovered' }] }
  await manager.loadBlocksFor(id, true)
  assert.equal(resumes, 0)
  assert.equal(task.history?.phase, 'ready')
  assert.equal((task.blocks?.[0] as any).text, 'Recovered')
})

test('same-state starting activity and error-only failure emit updates while keeping prior blocks', async t => {
  const baseDir = await fs.mkdtemp(join(tmpdir(), 'core-content-state-'))
  const manager = new TaskManager({ baseDir, executorFactory: () => { throw new Error('No provider') } })
  t.after(async () => { manager.shutdown(); await Promise.all([...(manager as any).metaChains.values()]); await fs.rm(baseDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 }) })
  const id = await manager.createChat({ provider: 'claude' }), task = manager.get(id)!
  task.blocks = [{ kind: 'message', role: 'assistant', text: 'Prior answer' }]; task.state = 'processing'
  let updates = 0; manager.on('updated', () => updates++)
  manager.applyHubPatch({ taskId: id, state: 'processing', activity: { kind: 'lifecycle', label: 'Starting' } })
  assert.ok(updates > 0)
  manager.applyHubPatch({ taskId: id, state: 'failed', errorReason: 'Context limit reached' })
  assert.equal(task.error?.reason, 'Context limit reached')
  assert.equal((task.blocks[0] as any).text, 'Prior answer')
})

test('Claude authoritative history recovery selects only the exact session and labels torn records partial', async t => {
  const root = await fs.mkdtemp(join(tmpdir(), 'content-recovery-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const home = join(root, 'receipt'), projects = join(root, 'projects'), project = join(projects, 'moved')
  await fs.mkdir(home); await fs.mkdir(project, { recursive: true })
  const frame = { type: 'user', uuid: 'u', sessionId: 'exact', message: { content: [{ type: 'text', text: '<literal>correct</literal>' }] } }
  await fs.writeFile(join(project, 'neighbor.jsonl'), JSON.stringify({ ...frame, sessionId: 'neighbor' }))
  const task = { home, cwd: '/never-accessed-project', sessionId: 'exact' }
  assert.equal((await readClaudeHistory(task, projects)).history.phase, 'missing')
  await fs.writeFile(join(project, 'exact.jsonl'), JSON.stringify(frame) + '\n{torn')
  const partial = await readClaudeHistory(task, projects)
  assert.equal(partial.history.phase, 'partial')
  assert.ok(partial.frames.some(f => f.uuid === 'u'))
  await fs.writeFile(join(home, 'chat-frames.json'), JSON.stringify(partial.frames))
  await fs.writeFile(join(project, 'exact.jsonl'), JSON.stringify(frame) + '\n')
  const ready = await readClaudeHistory(task, projects)
  assert.equal(ready.history.phase, 'ready')
  assert.equal(ready.frames.length, 1)
  assert.equal(ready.frames[0].message.content[0].text, '<literal>correct</literal>')
})

test('exact-session disk recovery merges saved owned metadata and local-only frames even from partial provider history', async t => {
  const root = await fs.mkdtemp(join(tmpdir(), 'content-owned-recovery-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const home = join(root, 'receipt'), projects = join(root, 'projects'), project = join(projects, 'moved')
  await fs.mkdir(home); await fs.mkdir(project, { recursive: true })
  const user = { type: 'user', uuid: 'u1', sessionId: 'exact', message: { content: [{ type: 'text', text: 'full expanded provider text' }] } }
  const local = [{ type: 'system', unmuteHistoryIncomplete: true }, { type: 'system', uuid: 's1', unmuteTurnStart: 1 },
    { ...user, unmuteDisplayText: 'Original display', unmuteAttachments: [{ path: '/image.png', name: 'image.png', mimeType: 'image/png' }] },
    { type: 'assistant', uuid: 'local-answer', message: { content: [{ type: 'text', text: 'Retained local answer' }] } }, { type: 'system', uuid: 'e1', unmuteTurnEnd: 'cancelled' }]
  await fs.writeFile(join(home, 'chat-frames.json'), JSON.stringify(local))
  await fs.writeFile(join(project, 'exact.jsonl'), JSON.stringify({ ...user, message: { content: [{ type: 'text', text: 'partial text' }] } }) + '\n{torn')
  const task = { home, cwd: '/never-accessed-project', sessionId: 'exact' }
  const partial = await readClaudeHistory(task, projects)
  assert.equal(partial.history.phase, 'partial')
  assert.deepEqual(partial.frames, local)
  await fs.writeFile(join(project, 'exact.jsonl'), [user, { ...user, uuid: 'u2' }].map(f => JSON.stringify(f)).join('\n'))
  const ready = await readClaudeHistory(task, projects)
  assert.equal(ready.history.phase, 'ready')
  assert.deepEqual(ready.frames.map(f => f.uuid), ['s1', 'u1', 'local-answer', 'e1', 'u2'])
  assert.equal(ready.frames[1].unmuteDisplayText, 'Original display')
  assert.deepEqual(ready.frames[1].unmuteAttachments, (local[2] as any).unmuteAttachments)
})

test('Codex subagent interruption and Claude multi-result frames retain all exposed outcomes', () => {
  assert.equal((blockFromCodexItem({ type: 'collabAgentToolCall', tool: 'wait', status: 'interrupted', agentsStates: { child: { status: 'interrupted', message: 'stopped' } } }) as any).status, 'cancelled')
  const frames = [{ type: 'assistant', message: { content: ['one', 'two'].map(id => ({ type: 'tool_use', id, name: 'mcp__s__read', input: {} })) } },
    { type: 'user', message: { content: ['one', 'two'].map(id => ({ type: 'tool_result', tool_use_id: id, content: id })) } }]
  const blocks = blocksFromClaudeTranscript(frames.map(f => JSON.stringify(f)).join('\n')).blocks as any[]
  assert.deepEqual(blocks.map(b => b.output), ['one', 'two'])
  assert.deepEqual(blocks.map(b => b.status), ['succeeded', 'succeeded'])
})
