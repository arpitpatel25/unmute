import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CodexHeadlessEventParser,
  CodexHeadlessProcess,
  codexHeadlessArgv,
  type CodexHeadlessChild,
} from './codex-headless'
import { CodexCliProvider } from './codex'
import { ExecutorBackedAgentProcess, type AgentProcessEvent, type AgentProcessLaunch } from '../provider'

const THREAD_ID = '11111111-2222-4333-8444-555555555555'

function launch(session: AgentProcessLaunch['session'] = { kind: 'fresh' }): AgentProcessLaunch {
  return {
    provider: 'codex',
    binary: 'codex',
    argv: session.kind === 'resume' ? ['resume', session.id!] : [],
    cwd: '/Users/test/Library/Application Support/unmute/unmute-agent/runtime',
    taskId: 'run-1',
    environment: {
      PATH: '/usr/bin',
      UNMUTE_MCP_TOKEN: 'secret',
      UNMUTE_MCP_ENDPOINT: 'http://127.0.0.1:42117/mcp',
    },
    systemContext: { type: 'file', path: '/tmp/constitution.md' },
    session,
  }
}

test('Codex runs noninteractively without a repository trust prompt', () => {
  const argv = codexHeadlessArgv(launch(), 'CONSTITUTION')
  assert.deepEqual(argv.slice(0, 6), ['-a', 'never', '-s', 'read-only', '-C', launch().cwd])
  assert.ok(argv.includes('exec'))
  assert.ok(argv.includes('--skip-git-repo-check'))
  assert.ok(argv.includes('--json'))
  assert.equal(argv.at(-1), '-')
})

test('Codex pre-approves only the Unmute Agent MCP server while Claude stays provider-specific', () => {
  const argv = codexHeadlessArgv(launch(), 'CONSTITUTION')
  assert.ok(argv.includes('--ignore-user-config'))
  assert.ok(argv.includes('--ignore-rules'))
  const clear = argv.indexOf('mcp_servers={}')
  const unmute = argv.indexOf('mcp_servers.unmute.url="http://127.0.0.1:42117/mcp"')
  assert.ok(clear >= 0 && clear < unmute, 'ambient MCP servers must be cleared before Unmute is added')
  assert.ok(argv.includes('mcp_servers.unmute.url="http://127.0.0.1:42117/mcp"'))
  assert.ok(argv.includes('mcp_servers.unmute.bearer_token_env_var="UNMUTE_MCP_TOKEN"'))
  assert.ok(argv.includes('mcp_servers.unmute.required=true'))
  assert.ok(argv.includes('mcp_servers.unmute.default_tools_approval_mode="approve"'))
  assert.ok(!argv.includes('--dangerously-bypass-approvals-and-sandbox'))
  assert.ok(!argv.join(' ').includes('secret'), 'the bearer token must stay in the environment')
})

// Left unset, Codex falls back to whatever the selected model's own default
// happens to be — currently medium for the field, but not pinned, and a
// model swap would silently carry it to high. A headless Agent turn (a
// memory lookup, a clipboard copy, a task handoff) is exactly the ordinary
// work Codex's own guidance recommends medium for; a real orchestrator
// SESSION (task-manager.ts's dispatch — actual coding work) is deliberately
// left alone, still following the user's own model/effort picker.
test('the Agent pins Codex to medium effort, not whatever the selected model defaults to', () => {
  const argv = codexHeadlessArgv(launch(), 'CONSTITUTION')
  assert.ok(argv.includes('model_reasoning_effort="medium"'))
})

test('resume uses the exact Codex thread ID selected by the runtime', () => {
  const argv = codexHeadlessArgv(launch({ kind: 'resume', id: THREAD_ID }), 'CONSTITUTION')
  const exec = argv.indexOf('exec')
  assert.deepEqual(argv.slice(exec + 1, exec + 3), ['resume', THREAD_ID])
})

test('Codex JSONL establishes the handle and completes with the final answer', () => {
  const parser = new CodexHeadlessEventParser()
  assert.deepEqual(parser.events({ type: 'thread.started', thread_id: THREAD_ID }), [
    { type: 'handle', sessionId: THREAD_ID },
  ])
  assert.deepEqual(parser.events({
    type: 'item.completed',
    item: { id: 'item_1', type: 'agent_message', text: 'Created the session.' },
  }), [{ type: 'activity', kind: 'message', summary: 'Created the session.' }])
  assert.deepEqual(parser.events({ type: 'turn.completed', usage: {} }), [
    { type: 'completion', outcome: 'completed', finalText: 'Created the session.' },
  ])
})

test('Codex MCP calls are visible as tool activity and failed turns fail', () => {
  const parser = new CodexHeadlessEventParser()
  assert.deepEqual(parser.events({
    type: 'item.started',
    item: { id: 'item_2', type: 'mcp_tool_call', server: 'unmute', tool: 'create_session' },
  }), [{ type: 'activity', kind: 'tool', summary: 'using unmute.create_session' }])
  assert.deepEqual(parser.events({ type: 'turn.failed', error: { message: 'nope' } }), [
    { type: 'completion', outcome: 'failed' },
  ])
})

class FakeChild implements CodexHeadlessChild {
  written: string | null = null
  readonly stdout: AsyncIterable<string> = {
    async *[Symbol.asyncIterator]() {
      yield `${JSON.stringify({ type: 'thread.started', thread_id: THREAD_ID })}\n`
      yield `${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Done.' } })}\n`
      yield `${JSON.stringify({ type: 'turn.completed', usage: {} })}\n`
    },
  }
  readonly stderr = undefined
  private exit: ((code: number | null) => void) | null = null
  writePrompt(text: string): void { this.written = text }
  kill(): void {}
  onExit(cb: (code: number | null) => void): void { this.exit = cb }
  finish(): void { this.exit?.(0) }
}

class SplitUtf8Child implements CodexHeadlessChild {
  readonly stderr = undefined
  private exit: ((code: number | null) => void) | null = null
  readonly stdout: AsyncIterable<Buffer>

  constructor() {
    const bytes = Buffer.from([
      `${JSON.stringify({ type: 'thread.started', thread_id: THREAD_ID })}\n`,
      `${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Done 🚀' } })}\n`,
      `${JSON.stringify({ type: 'turn.completed', usage: {} })}\n`,
    ].join(''))
    const rocket = Buffer.from('🚀')
    const start = bytes.indexOf(rocket)
    const chunks = [bytes.subarray(0, start + 1), bytes.subarray(start + 1)]
    this.stdout = { async *[Symbol.asyncIterator]() { yield* chunks } }
  }

  writePrompt(): void {}
  kill(): void {}
  onExit(cb: (code: number | null) => void): void { this.exit = cb }
  finish(): void { this.exit?.(0) }
}

async function collect(driver: CodexHeadlessProcess): Promise<AgentProcessEvent[]> {
  const events: AgentProcessEvent[] = []
  for await (const event of driver.events) events.push(event)
  return events
}

test('the headless process sends the prompt, learns the thread, and drains the answer', async () => {
  const child = new FakeChild()
  const spawns: string[][] = []
  const driver = new CodexHeadlessProcess({
    readSystemPrompt: async () => 'CONSTITUTION',
    spawn: (argv) => { spawns.push(argv); return child },
  })
  await driver.start(launch())
  const collected = collect(driver)
  await driver.submitUserTurn('Create the requested session')
  child.finish()
  assert.equal(child.written, 'Create the requested session')
  assert.ok(spawns[0].includes('exec'))
  assert.deepEqual(await collected, [
    { type: 'handle', sessionId: THREAD_ID },
    { type: 'activity', kind: 'message', summary: 'Done.' },
    { type: 'completion', outcome: 'completed', finalText: 'Done.' },
    { type: 'exit', exitCode: 0 },
  ])
})

test('JSONL remains valid when a UTF-8 character is split across pipe chunks', async () => {
  const child = new SplitUtf8Child()
  const driver = new CodexHeadlessProcess({
    readSystemPrompt: async () => 'CONSTITUTION',
    spawn: () => child,
  })
  await driver.start(launch())
  const collected = collect(driver)
  await driver.submitUserTurn('go')
  child.finish()
  assert.deepEqual(await collected, [
    { type: 'handle', sessionId: THREAD_ID },
    { type: 'activity', kind: 'message', summary: 'Done 🚀' },
    { type: 'completion', outcome: 'completed', finalText: 'Done 🚀' },
    { type: 'exit', exitCode: 0 },
  ])
})

test('Codex defaults to headless while the shared rollback still selects the old REPL', () => {
  const headless = new CodexCliProvider()
  const repl = new CodexCliProvider({ runtime: 'repl' })
  assert.ok(headless.createProcess() instanceof CodexHeadlessProcess)
  assert.ok(repl.createProcess() instanceof ExecutorBackedAgentProcess)
})

test('a mode added for Claude must never drop Codex onto the PTY', () => {
  // `codex exec` has no streaming input, so there is no warm driver to pick —
  // but "no persistent driver" must mean HEADLESS, not REPL. Spelled as an
  // equality check against 'headless', the persistent mode silently selected
  // the PTY here and would have shipped as an unexplained return of the hangs
  // the headless rewrite removed.
  assert.ok(new CodexCliProvider({ runtime: 'persistent' }).createProcess()
    instanceof CodexHeadlessProcess)
  assert.ok(new CodexCliProvider({ runtime: 'headless' }).createProcess()
    instanceof CodexHeadlessProcess)
})
