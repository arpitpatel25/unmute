// Drives the engine against a FAKE claude that speaks the real stream-json
// protocol, so the contract under test is the wire format rather than a mock's
// opinion of it. The event shapes here are copied from a live run.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { HeadlessRouterEngine, QUALIFIED_TOOL } from './headless-router-engine.ts'

/** A stand-in for the spawned CLI. Records what was written to stdin and lets
 *  a test push stream-json events back. */
function fakeClaude() {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>
  const writes: string[] = []
  const stdout = new EventEmitter()
  child.stdout = stdout
  child.stderr = new EventEmitter()
  child.stdin = { writable: true, write: (s: string) => { writes.push(s); return true } }
  child.killed = false
  child.kill = () => { (child as { killed: boolean }).killed = true }

  const emit = (o: unknown) => stdout.emit('data', Buffer.from(JSON.stringify(o) + '\n'))
  return {
    child, writes, emit, args: [] as string[],
    init: () => emit({ type: 'system', subtype: 'init', tools: [QUALIFIED_TOOL] }),
    toolCall: (input: unknown) => emit({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: QUALIFIED_TOOL, input }] },
    }),
    /** Two events in one chunk, and a split across chunk boundaries — the
     *  framing a real pipe actually delivers. */
    rawChunk: (s: string) => stdout.emit('data', Buffer.from(s)),
  }
}

async function engineWithFake(t?: { recycleEvery?: number }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'headless-router-'))
  const f = fakeClaude()
  const spawnFn = ((_cmd: string, args: string[]) => {
    f.args = args
    setTimeout(() => f.init(), 5)   // the CLI initialises lazily, after input
    return f.child
  }) as unknown as typeof import('node:child_process').spawn
  const eng = new HeadlessRouterEngine({ dir, spawnFn, execPath: '/usr/bin/node', ...t })
  return { eng, f, dir }
}

test('spawns headless with the flags that were actually proven', async () => {
  const { eng, f } = await engineWithFake()
  await eng.warm()
  const a = f.args.join(' ')
  assert.match(a, /-p/)
  assert.match(a, /--input-format stream-json/)
  assert.match(a, /--output-format stream-json/)
  assert.match(a, /--verbose/)               // stream-json output requires it
  // Without this the router inherits the user's own MCP servers — 96 tools and
  // two failed connections, measured on a live run.
  assert.match(a, /--strict-mcp-config/)
  assert.match(a, /--permission-mode bypassPermissions/)
  eng.dispose()
})

test('warm primes the tool so the first real route skips the ToolSearch hop', async () => {
  const { eng, f } = await engineWithFake()
  await eng.warm()
  assert.equal(f.writes.length, 1, 'warm should send exactly one priming message')
  const msg = JSON.parse(f.writes[0]) as { type: string; message: { content: Array<{ text: string }> } }
  assert.equal(msg.type, 'user')
  assert.match(msg.message.content[0].text, /ToolSearch/)
  assert.match(msg.message.content[0].text, /Do not call it/)
  eng.dispose()
})

test('a decision is read off the stream and returned as compact JSON', async () => {
  const { eng, f } = await engineWithFake()
  await eng.warm()
  const p = eng.decide('[Unmute router] route this', 5000)
  await new Promise((r) => setTimeout(r, 30))
  f.toolCall({
    action: 'new', intent: 'plan reddit marketing', name: 'Reddit marketing plan',
    group: 'unmute marketing', kind: 'session',
    targetTaskId: null, dir: null, surface: null, alternate: null, contextTaskId: null, ops: null,
  })
  const raw = await p
  assert.ok(raw)
  const d = JSON.parse(raw!) as Record<string, unknown>
  assert.equal(d.action, 'new')
  assert.equal(d.group, 'unmute marketing')
  assert.ok(!('dir' in d), 'strict-mode nulls should be stripped before parseDecision')
  eng.dispose()
})

test('the engine sends the routing prompt VERBATIM', async () => {
  // The tool instruction lives in buildRoutingPrompt now (the engine declares
  // `answerTool`), so nothing may be appended here. Two halves each adding
  // their own instruction is how the prompt ended up telling the model both to
  // call a tool and to use no tools.
  const { eng, f } = await engineWithFake()
  await eng.warm()
  void eng.decide('[Unmute router] ROUTING PROMPT BODY', 200)
  await new Promise((r) => setTimeout(r, 30))
  const sent = JSON.parse(f.writes[1]) as { message: { content: Array<{ text: string }> } }
  assert.equal(sent.message.content[0].text, '[Unmute router] ROUTING PROMPT BODY')
  eng.dispose()
})

test('the engine declares the tool the prompt must name', async () => {
  const { eng } = await engineWithFake()
  assert.equal(eng.answerTool, QUALIFIED_TOOL)
  assert.match(QUALIFIED_TOOL, /^mcp__[a-z_]+__route_decision$/)
  eng.dispose()
})

test('events split across pipe chunks are still parsed', async () => {
  const { eng, f } = await engineWithFake()
  await eng.warm()
  const p = eng.decide('x', 5000)
  await new Promise((r) => setTimeout(r, 30))
  const ev = JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: QUALIFIED_TOOL, input: { action: 'speak', intent: 'status' } }] },
  }) + '\n'
  f.rawChunk(ev.slice(0, 40))
  f.rawChunk(ev.slice(40))
  const raw = await p
  assert.equal(JSON.parse(raw!).action, 'speak')
  eng.dispose()
})

test('a silent route returns null so the caller can fail safe', async () => {
  const { eng } = await engineWithFake()
  await eng.warm()
  assert.equal(await eng.decide('x', 150), null)
  eng.dispose()
})

test('consecutive routes take their OWN decision, never a stale one', async () => {
  const { eng, f } = await engineWithFake()
  await eng.warm()
  const p1 = eng.decide('first', 5000)
  await new Promise((r) => setTimeout(r, 20))
  f.toolCall({ action: 'new', intent: 'first' })
  assert.equal(JSON.parse((await p1)!).intent, 'first')

  const p2 = eng.decide('second', 5000)
  await new Promise((r) => setTimeout(r, 20))
  f.toolCall({ action: 'new', intent: 'second' })
  assert.equal(JSON.parse((await p2)!).intent, 'second')
  eng.dispose()
})

test('a dead process yields null rather than hanging the route', async () => {
  const { eng, f } = await engineWithFake()
  await eng.warm()
  f.child.kill!()
  assert.equal(await eng.decide('x', 3000), null)
  eng.dispose()
})
