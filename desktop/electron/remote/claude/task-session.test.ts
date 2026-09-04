import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { ClaudeTaskSession, type ClaudeTaskEvent } from './task-session'

function fixture(resume = false) {
  const events: ClaudeTaskEvent[] = []
  const writes: any[] = []
  let args: string[] = []
  const child = new EventEmitter() as ChildProcessWithoutNullStreams
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.stdin = new Writable({ write(chunk, _encoding, callback) {
    const frame = JSON.parse(String(chunk)); writes.push(frame); callback()
    if (frame.request?.subtype === 'initialize') queueMicrotask(() => emit({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: {} } }))
  } })
  child.kill = () => { queueMicrotask(() => child.emit('close', 0, null)); return true }
  const emit = (frame: unknown) => child.stdout.emit('data', Buffer.from(JSON.stringify(frame) + '\n'))
  const driver = new ClaudeTaskSession({ binary: 'claude', cwd: '/tmp', sessionId: '65be0561-443e-4248-8e6c-31556e0bd414', resume, permissionMode: 'bypassPermissions', onEvent: event => events.push(event), spawn: (_binary, argv) => { args = argv; return child } })
  return { driver, events, writes, child, emit, args: () => args }
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
