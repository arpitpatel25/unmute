// THE LOGS ARE THE PRODUCT HERE.
//
// Every failure mode of this transport is SILENT from the outside — the model
// answers in prose, or never loads the deferred tool, or the MCP server never
// connected — and all three surface identically as "no decision". The point of
// the instrumentation is that a single log read names which one happened,
// without the user having to describe what they saw.
//
// So the diagnostics are pinned like behaviour, because a log line that
// quietly stops being emitted is exactly as bad as one that was never written.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { HeadlessRouterEngine, QUALIFIED_TOOL } from './headless-router-engine.ts'

/** Captures what the module logged, by standing in for the logger's sink. */
function captureLogs() {
  const seen: Array<{ level: string; name: string; payload: Record<string, unknown> }> = []
  const orig = { log: console.log, warn: console.warn, error: console.error }
  const grab = (level: string) => (...a: unknown[]) => {
    const line = a.map(String).join(' ')
    const m = /event ([a-z-]+) (\{.*\})\s*$/.exec(line) ?? /\] ([^{]+) (\{.*\})\s*$/.exec(line)
    if (m) { try { seen.push({ level, name: m[1].trim(), payload: JSON.parse(m[2]) as Record<string, unknown> }) } catch { /* not ours */ } }
  }
  console.log = grab('info'); console.warn = grab('warn'); console.error = grab('error')
  return { seen, restore: () => { console.log = orig.log; console.warn = orig.warn; console.error = orig.error } }
}

function fakeClaude() {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>
  const stdout = new EventEmitter(); const stderr = new EventEmitter()
  child.stdout = stdout; child.stderr = stderr
  child.stdin = { writable: true, write: () => true }
  child.killed = false
  child.kill = () => { (child as { killed: boolean }).killed = true }
  const emit = (o: unknown) => stdout.emit('data', Buffer.from(JSON.stringify(o) + '\n'))
  return {
    child, emit, stderr,
    init: (tools: string[] = [QUALIFIED_TOOL], servers: unknown = [{ name: 'unmute_router', status: 'connected' }]) =>
      emit({ type: 'system', subtype: 'init', tools, mcp_servers: servers }),
    text: (t: string) => emit({ type: 'assistant', message: { content: [{ type: 'text', text: t }] } }),
    toolSearch: () => emit({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'ToolSearch', input: { query: 'x' } }] } }),
    call: (input: unknown) => emit({ type: 'assistant', message: { content: [{ type: 'tool_use', name: QUALIFIED_TOOL, input }] } }),
    result: () => emit({ type: 'result', subtype: 'success', duration_ms: 42, num_turns: 3, is_error: false }),
  }
}

async function harness(initNow = true) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'headless-log-'))
  const f = fakeClaude()
  const spawnFn = (() => { if (initNow) setTimeout(() => f.init(), 5); return f.child }) as unknown as typeof import('node:child_process').spawn
  return { eng: new HeadlessRouterEngine({ dir, spawnFn, execPath: '/usr/bin/node' }), f }
}

const find = (seen: ReturnType<typeof captureLogs>['seen'], n: string) => seen.find((e) => e.name === n)

test('the MCP handshake result is recorded — connected, and our tool present', async () => {
  const c = captureLogs()
  try {
    const { eng } = await harness()
    await eng.warm()
    const st = find(c.seen, 'headless-mcp-status')
    assert.ok(st, 'headless-mcp-status was not logged')
    assert.equal(st!.payload.toolVisible, true)
    assert.ok(Array.isArray(st!.payload.servers))
    eng.dispose()
  } finally { c.restore() }
})

test('a broken MCP handshake is visible as such, not as a mystery timeout', async () => {
  const c = captureLogs()
  try {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'headless-log-'))
    const f = fakeClaude()
    const spawnFn = (() => {
      // The tool missing is the difference between "slow" and "will never work".
      setTimeout(() => f.init([], [{ name: 'unmute_router', status: 'failed' }]), 5)
      return f.child
    }) as unknown as typeof import('node:child_process').spawn
    const eng = new HeadlessRouterEngine({ dir, spawnFn, execPath: '/usr/bin/node' })
    await eng.warm()
    const st = find(c.seen, 'headless-mcp-status')
    assert.equal(st!.payload.toolVisible, false)
    eng.dispose()
  } finally { c.restore() }
})

test('the decision is logged as fields, not a byte count', async () => {
  const c = captureLogs()
  try {
    const { eng, f } = await harness()
    await eng.warm()
    const p = eng.decide('prompt', 4000)
    setTimeout(() => { f.result(); f.call({ action: 'new', name: 'Reddit marketing plan', group: 'unmute marketing', kind: 'session' }) }, 20)
    await p
    const d = find(c.seen, 'headless-decision')
    assert.ok(d, 'headless-decision was not logged')
    // The line that answers "why did it get that name / that group".
    assert.equal(d!.payload.group, 'unmute marketing')
    assert.equal(d!.payload.name, 'Reddit marketing plan')
    assert.equal(d!.payload.action, 'new')
    eng.dispose()
  } finally { c.restore() }
})

test('prose instead of a tool call is captured verbatim in the failure', async () => {
  const c = captureLogs()
  try {
    const { eng, f } = await harness()
    await eng.warm()
    const p = eng.decide('prompt', 400)
    // The failure that has bitten us twice on the old transport: it answers,
    // conversationally, instead of routing. Without the words, unexplainable.
    setTimeout(() => f.text('I don’t have an actual task to name here.'), 20)
    assert.equal(await p, null)
    const w = c.seen.find((e) => e.level === 'warn' && Array.isArray(e.payload.assistantText))
    assert.ok(w, 'the no-decision warning did not carry the assistant text')
    assert.match(String((w!.payload.assistantText as string[])[0]), /actual task to name/)
    eng.dispose()
  } finally { c.restore() }
})

test('the failure line says whether the tool was ever loaded', async () => {
  const c = captureLogs()
  try {
    const { eng, f } = await harness()
    await eng.warm()
    const p = eng.decide('prompt', 400)
    setTimeout(() => f.toolSearch(), 20)
    await p
    const w = c.seen.find((e) => e.level === 'warn' && 'toolSearchUsed' in e.payload)
    assert.ok(w)
    assert.equal(w!.payload.toolSearchUsed, true)
    eng.dispose()
  } finally { c.restore() }
})

test('CLI stderr reaches the log instead of being dropped', async () => {
  const c = captureLogs()
  try {
    const { eng, f } = await harness()
    await eng.warm()
    f.stderr.emit('data', Buffer.from('Invalid API key · Please run /login'))
    const w = c.seen.find((e) => e.level === 'warn' && typeof e.payload.line === 'string')
    assert.ok(w, 'stderr was swallowed — the one place the CLI explains itself')
    assert.match(String(w!.payload.line), /Invalid API key/)
    eng.dispose()
  } finally { c.restore() }
})
