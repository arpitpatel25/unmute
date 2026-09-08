import assert from 'node:assert/strict'

test('new-turn-only Claude submission refuses unresolved requests without writing user input', async () => {
  const f = fixture(); await f.driver.start()
  f.emit({ type: 'control_request', request_id: 'queue-approval', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'pwd' } } })
  const before = f.writes.length
  assert.equal((await f.driver.sendNewTurn('follow-up', [], 'q')).kind, 'not-sent')
  assert.equal(f.writes.length, before)
  f.driver.close()
})

test('approval arriving during queued image preparation prevents a user frame; attempted write failure is uncertain', async () => {
  let read!: () => void, began!: () => void
  const reading = new Promise<void>(resolve => { began = resolve })
  const f = fixture(false, { readImage: async () => { began(); await new Promise<void>(resolve => { read = resolve }); return Buffer.from('image') } })
  await f.driver.start()
  const next = f.driver.sendNewTurn('', ['/tmp/image.png'], 'q')
  await reading
  f.emit({ type: 'control_request', request_id: 'late', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: {} } })
  read(); assert.equal((await next).kind, 'not-sent')
  assert.equal(f.writes.filter(w => w.type === 'user').length, 0)
  await f.driver.answer('late', { behavior: 'deny' })
  f.child.stdin.on('error', () => {})
  f.child.stdin._write = (_chunk, _encoding, callback) => callback(new Error('write failed'))
  assert.equal((await f.driver.sendNewTurn('possibly written', [], 'q2')).kind, 'uncertain')
  assert.equal((await f.driver.sendNewTurn('must not retry', [], 'q3')).kind, 'not-sent')
  // AND IT SAYS SO IN A WAY SOMETHING CAN ACT ON.
  //
  // The latch is right — replaying a turn that may already have landed would
  // duplicate it — but the process is still alive, so nothing was ever going
  // to clear it. followupUnavailable cannot be that signal: it is also true
  // for a send in flight and for a dead process, and neither wants a
  // reconnect. connectClaude reads acceptanceUnresolved and replaces the
  // session; without it the card refused every delivery and disabled its own
  // composer for the life of the process (2026-09-08).
  // The latch is exposed on its own, so connectClaude can replace the session.
  // followupUnavailable cannot serve: it is also true for a send in flight and
  // for a dead process, and neither of those wants a reconnect.
  assert.equal(f.driver.acceptanceUnresolved, true)
  assert.equal(f.driver.followupUnavailable, true)
  f.driver.close()
})
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { ClaudeTaskSession, type ClaudeTaskEvent } from './task-session'

function fixture(resume = false, extra: Partial<import('./task-session').ClaudeTaskOptions> = {}, initialization: unknown = {}) {
  const events: ClaudeTaskEvent[] = []
  const writes: any[] = []
  let args: string[] = []
  let environment: NodeJS.ProcessEnv = {}
  const child = new EventEmitter() as ChildProcessWithoutNullStreams
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.stdin = new Writable({ write(chunk, _encoding, callback) {
    const frame = JSON.parse(String(chunk)); writes.push(frame); callback()
    if (frame.request?.subtype === 'initialize') queueMicrotask(() => emit({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: initialization } }))
  } })
  child.kill = () => { queueMicrotask(() => child.emit('close', 0, null)); return true }
  const emit = (frame: unknown) => child.stdout.emit('data', Buffer.from(JSON.stringify(frame) + '\n'))
  const driver = new ClaudeTaskSession({ binary: 'claude', cwd: '/tmp', sessionId: '65be0561-443e-4248-8e6c-31556e0bd414', resume, permissionMode: 'bypassPermissions', onEvent: event => events.push(event), spawn: (_binary, argv, options) => { args = argv; environment = options.env; return child }, ...extra })
  return { driver, events, writes, child, emit, args: () => args, environment: () => environment }
}

test('persistent turns reject concurrency and duplicate submission IDs and resume exact identity', async () => {
  const f = fixture(true)
  await f.driver.start()
  assert.equal(f.args()[f.args().indexOf('--resume') + 1], f.driver.sessionId)
  assert.ok(f.args().includes('--permission-prompt-tool'))
  await f.driver.send('hello', [], 'turn-1')
  await assert.rejects(f.driver.send('again'), /progress/)
  f.emit({ type: 'result', subtype: 'success', session_id: f.driver.sessionId })
  await assert.rejects(f.driver.send('hello', [], 'turn-1'), /already/)
  await f.driver.send('next')
  assert.equal(f.writes.filter(w => w.type === 'user').length, 2)
  assert.equal(f.child.stdin.writableEnded, false)
  f.driver.close()
})

test('model and effort choices come from initialization capabilities, not screenshot aliases', async () => {
  const f = fixture(false, {}, { models: [
    { value: 'default', displayName: 'Provider default', supportsEffort: true, supportedEffortLevels: ['low', 'high', 7] },
    { value: 'small', displayName: 'Small', supportedEffortLevels: ['max'] },
    { value: 4 },
  ] })
  await f.driver.start()
  assert.deepEqual(f.driver.models, [
    { id: 'default', label: 'Provider default', efforts: ['low', 'high'] },
    { id: 'small', label: 'Small', efforts: [] },
  ])
  assert.equal(f.writes.some(w => w.type === 'user'), false)
  f.driver.close()
})

test('split UTF-8 JSON lines preserve raw messages and stream deltas; result ends only the turn', async () => {
  const f = fixture(); await f.driver.start(); await f.driver.send('hello')
  const bytes = Buffer.from(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '☃' } } }) + '\n')
  const split = bytes.indexOf(Buffer.from('☃')) + 1
  f.child.stdout.emit('data', bytes.subarray(0, split)); f.child.stdout.emit('data', bytes.subarray(split))
  f.emit({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', id: 'tool-1', input: {} }] } })
  f.emit({ type: 'result', subtype: 'success' })
  assert.ok(f.events.some(e => e.type === 'delta' && e.text === '☃'))
  assert.ok(f.events.some(e => e.type === 'message' && e.message.type === 'assistant'))
  assert.equal(f.driver.alive, true)
  assert.equal(f.driver.busy, false)
  f.driver.close()
})

test('permission answers correlate IDs and questions preserve structured answers', async () => {
  const f = fixture(); await f.driver.start(); await f.driver.send('hello')
  f.emit({ type: 'control_request', request_id: 'ask-1', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: [{ question: 'Which?', options: [{ label: 'A' }, { label: 'B' }], multiSelect: true }] } } })
  await assert.rejects(f.driver.answer('ask-1', { behavior: 'allow' }), /answers/)
  await f.driver.answer('ask-1', { behavior: 'answer', answers: { 'Which?': 'A, B' } })
  const response = f.writes.at(-1).response
  assert.equal(response.request_id, 'ask-1')
  assert.deepEqual(response.response.updatedInput.answers, { 'Which?': 'A, B' })
  assert.equal(response.response.updatedInput.questions[0].multiSelect, true)
  await assert.rejects(f.driver.answer('ask-1', { behavior: 'deny' }), /Unknown/)
  f.emit({ type: 'control_request', request_id: 'ask-2', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'pwd' } } })
  await f.driver.answer('ask-2', { behavior: 'deny', message: 'No' })
  assert.equal(f.writes.at(-1).response.response.behavior, 'deny')
  f.driver.close()
})

test('interrupt waits for its matching acknowledgement and result, and exits surface stderr', async () => {
  const f = fixture(); await f.driver.start(); await f.driver.send('hello')
  const interrupted = f.driver.interrupt(); const request = f.writes.at(-1)
  f.emit({ type: 'control_response', response: { subtype: 'success', request_id: request.request_id, response: {} } })
  await interrupted
  assert.equal(f.driver.busy, true)
  f.child.stderr.emit('data', Buffer.from('Please run claude auth login'))
  f.child.emit('close', 1, null)
  assert.equal(f.driver.alive, false)
  assert.ok(f.events.some(e => e.type === 'error' && e.message.includes('auth login')))
})

test('invalid images fail before acceptance and malformed protocol terminates safely', async () => {
  const f = fixture(); await f.driver.start()
  await assert.rejects(f.driver.send('image', ['/missing.png']))
  assert.equal(f.driver.busy, false)
  assert.equal(f.writes.filter(w => w.type === 'user').length, 0)
  f.child.stdout.emit('data', Buffer.from('not-json\n'))
  assert.ok(f.events.some(e => e.type === 'error' && e.message.includes('JSON')))
  assert.equal(f.driver.alive, false)
})

test('images submit base64 blocks with text and fresh sessions use the requested UUID', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'claude-task-test-'))
  const f = fixture()
  try {
    const path = join(directory, 'image.png')
    await writeFile(path, Buffer.from('89504e470d0a1a0a', 'hex'))
    await f.driver.send('inspect', [path])
    assert.equal(f.args()[f.args().indexOf('--session-id') + 1], f.driver.sessionId)
    assert.deepEqual(f.writes.at(-1).message.content, [
      { type: 'text', text: 'inspect' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
    ])
  } finally { f.driver.close(); await rm(directory, { recursive: true, force: true }) }
})

test('spawn failures reject pending initialization and preserve actionable error context', async () => {
  const f = fixture()
  const starting = f.driver.start()
  f.child.emit('error', new Error('spawn ENOENT'))
  await assert.rejects(starting)
  assert.ok(f.events.some(e => e.type === 'error' && e.message.includes('ENOENT')))
  assert.equal(f.driver.alive, false)
})

test('cancelled permission requests cannot be answered and session mismatches fail closed', async () => {
  const f = fixture(); await f.driver.start(); await f.driver.send('hello')
  f.emit({ type: 'control_request', request_id: 'ask', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'pwd' } } })
  f.emit({ type: 'control_cancel_request', request_id: 'ask' })
  await assert.rejects(f.driver.answer('ask', { behavior: 'allow' }), /Unknown/)
  f.emit({ type: 'system', subtype: 'init', session_id: 'different' })
  assert.equal(f.driver.alive, false)
  assert.ok(f.events.some(e => e.type === 'error' && e.message.includes('different session')))
})

test('append prompt preserves the built-in system prompt and asks CLI to echo user messages', async () => {
  const f = fixture(false, { appendSystemPromptFile: '/tmp/task-instructions.md' })
  await f.driver.start()
  assert.equal(f.args()[f.args().indexOf('--append-system-prompt-file') + 1], '/tmp/task-instructions.md')
  assert.equal(f.args().includes('--system-prompt-file'), false)
  assert.ok(f.args().includes('--replay-user-messages'))
  f.driver.close()
})

test('failed approval writes keep a request actionable when the process remains available', async () => {
  const f = fixture(); await f.driver.start()
  f.emit({ type: 'control_request', request_id: 'ask', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'pwd' } } })
  const original = f.child.stdin.write
  f.child.stdin.write = () => { throw new Error('transient write failure') }
  await assert.rejects(f.driver.answer('ask', { behavior: 'allow' }), /transient/)
  f.child.stdin.write = original
  await f.driver.answer('ask', { behavior: 'deny' })
  assert.equal(f.writes.at(-1).response.request_id, 'ask')
  f.driver.close()
})

test('interrupt during initialization cancels the pending send before any user frame', async () => {
  const f = fixture()
  const sending = f.driver.send('must not run')
  const rejected = assert.rejects(sending, /cancelled/i)
  const stopping = f.driver.interrupt()
  // A pre-submission cancellation must not issue a CLI interrupt before user input.
  assert.equal(f.writes.filter(w => w.request?.subtype === 'interrupt').length, 0)
  await stopping; await rejected
  assert.equal(f.writes.filter(w => w.type === 'user').length, 0)
  assert.equal(f.driver.busy, false)
  await f.driver.send('new turn')
  assert.equal(f.writes.filter(w => w.type === 'user').length, 1)
  f.driver.close()
})

test('interrupt during image loading rejects promptly and never submits after the read finishes', async () => {
  let finishRead!: (buffer: Buffer) => void
  let beganRead!: () => void
  const reading = new Promise<void>(resolve => { beganRead = resolve })
  const f = fixture(false, { readImage: () => { beganRead(); return new Promise(resolve => { finishRead = resolve }) } })
  await f.driver.start()
  const sending = f.driver.send('must not run', ['/tmp/image.png'])
  const rejected = assert.rejects(sending, /cancelled/i)
  await reading
  await f.driver.interrupt(); await rejected
  assert.equal(f.driver.busy, false)
  await f.driver.send('replacement')
  finishRead(Buffer.from('image'))
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(f.writes.filter(w => w.type === 'user').map(w => w.message.content[0].text), ['replacement'])
  f.driver.close()
})

test('per-session directories and Chrome settings preserve MCP env while removing API credentials', async () => {
  const f = fixture(false, { addDirs: ['/tmp/one', '/tmp/two'], chrome: true, env: { ANTHROPIC_API_KEY: 'secret', ANTHROPIC_AUTH_TOKEN: 'secret', CLAUDE_API_KEY: 'secret', UNMUTE_MCP_TOKEN: 'keep' } })
  await f.driver.start()
  assert.deepEqual(f.args().flatMap((arg, index, args) => arg === '--add-dir' ? [args[index + 1]] : []), ['/tmp/one', '/tmp/two'])
  assert.ok(f.args().includes('--chrome'))
  assert.equal(f.environment().ANTHROPIC_API_KEY, undefined)
  assert.equal(f.environment().ANTHROPIC_AUTH_TOKEN, undefined)
  assert.equal(f.environment().CLAUDE_API_KEY, undefined)
  assert.equal(f.environment().UNMUTE_MCP_TOKEN, 'keep')
  f.driver.close()
  const disabled = fixture(false, { chrome: false })
  await disabled.driver.start()
  assert.ok(disabled.args().includes('--no-chrome'))
  disabled.driver.close()
})

test('fork resumes source into a pinned distinct session and validates returned child identity', async () => {
  const source = '1e4c15ad-258f-4ae0-8910-dbb15858c087'
  const f = fixture(false, { forkFromSessionId: source })
  await f.driver.start()
  assert.equal(f.args()[f.args().indexOf('--resume') + 1], source)
  assert.ok(f.args().includes('--fork-session'))
  assert.equal(f.args()[f.args().indexOf('--session-id') + 1], f.driver.sessionId)
  assert.notEqual(f.driver.sessionId, source)
  f.emit({ type: 'system', subtype: 'init', session_id: f.driver.sessionId })
  assert.equal(f.driver.alive, true)
  f.emit({ type: 'system', subtype: 'init', session_id: source })
  assert.equal(f.driver.alive, false)
  assert.throws(() => fixture(false, { forkFromSessionId: source, sessionId: source }), /distinct/)
})

test('a result before the stdin write callback cannot be followed by a late turn-start', async () => {
  const f = fixture(); await f.driver.start()
  let finishWrite!: () => void
  let didWrite!: () => void
  const written = new Promise<void>(resolve => { didWrite = resolve })
  f.child.stdin._write = (_chunk, _encoding, callback) => {
    finishWrite = () => callback()
    f.emit({ type: 'result', subtype: 'success', session_id: f.driver.sessionId })
    didWrite()
  }
  const sending = f.driver.send('finish immediately')
  await written
  assert.equal(f.driver.busy, false)
  assert.equal((await f.driver.sendNewTurn('must wait for acceptance', [], 'queue-next')).kind, 'not-sent')
  finishWrite(); await sending
  assert.deepEqual(f.events.filter(e => e.type === 'turn-start' || e.type === 'result').map(e => e.type), ['result'])
  assert.equal(f.driver.busy, false)
  f.driver.close()
})

test('editing forks from an exact message checkpoint', async () => {
 const source = 'f58420a1-6377-4c87-815f-df099cb194ce'
 const f = fixture(false, { forkFromSessionId: source, resumeSessionAt: 'prior-assistant' })
 await f.driver.start()
 assert.equal(f.args()[f.args().indexOf('--resume-session-at') + 1], 'prior-assistant')
 f.driver.close()
})

