import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  HeadlessAgentProcess,
  agentRuntimeMode,
  headlessArgv,
  headlessEvents,
  type HeadlessChild,
} from './claude-headless'
import { ClaudeCodeProvider } from './claude'
import { ExecutorBackedAgentProcess, type AgentProcessEvent, type AgentProcessLaunch } from '../provider'

// Every shape below was copied from a real `claude -p --output-format
// stream-json --verbose` run, not invented. The parser is only worth what its
// fixtures are worth.

function launch(session: AgentProcessLaunch['session']): AgentProcessLaunch {
  return {
    provider: 'claude',
    binary: 'claude',
    argv: session.kind === 'resume' ? ['--resume', session.id!] : ['--session-id', session.id!],
    cwd: '/home/agent',
    taskId: 'run-1',
    environment: { PATH: '/usr/bin', UNMUTE_MCP_TOKEN: 'tok' },
    systemContext: { type: 'file', path: '/tmp/constitution.md' },
    session,
  }
}

const FRESH = '11111111-2222-4333-8444-555555555555'

// ── the parser ────────────────────────────────────────────────────────────

test('the init event is where the conversation identity comes from', () => {
  assert.deepEqual(
    headlessEvents({ type: 'system', subtype: 'init', session_id: FRESH, tools: [] }),
    [{ type: 'handle', sessionId: FRESH }],
  )
})

test('a tool call is named, so "Thinking" can say what it is doing', () => {
  assert.deepEqual(
    headlessEvents({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } }),
    [{ type: 'activity', kind: 'tool', summary: 'using Bash' }],
  )
})

test('assistant prose is progress, not the answer', () => {
  assert.deepEqual(
    headlessEvents({ type: 'assistant', message: { content: [{ type: 'text', text: "I'll run that." }] } }),
    [{ type: 'activity', kind: 'message', summary: "I'll run that." }],
  )
})

// One assistant message can carry prose AND a tool call. Returning a single
// event would silently drop whichever block came second.
test('a message carrying both prose and a tool call reports both, in order', () => {
  assert.deepEqual(
    headlessEvents({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'checking' }, { type: 'tool_use', name: 'Read' }] },
    }),
    [
      { type: 'activity', kind: 'message', summary: 'checking' },
      { type: 'activity', kind: 'tool', summary: 'using Read' },
    ],
  )
})

// THE WHOLE POINT. Under the PTY the turn ended only if an out-of-band hook
// POST arrived; in the field zero arrived and the Agent said "Thinking" for
// 38 minutes. Here the end of the turn IS the process's own stdout.
test('the result event completes the turn and carries the answer', () => {
  assert.deepEqual(
    headlessEvents({ type: 'result', subtype: 'success', is_error: false, result: 'It printed `hi`.' }),
    [{ type: 'completion', outcome: 'completed', finalText: 'It printed `hi`.' }],
  )
})

test('an errored result fails the turn rather than completing it emptily', () => {
  assert.deepEqual(
    headlessEvents({ type: 'result', subtype: 'error_during_execution', is_error: true }),
    [{ type: 'completion', outcome: 'failed' }],
  )
})

// A result whose subtype is not success but which forgot to set is_error must
// still not be reported as a good answer.
test('a non-success subtype fails even when is_error is missing', () => {
  assert.deepEqual(
    headlessEvents({ type: 'result', subtype: 'error_max_turns' }),
    [{ type: 'completion', outcome: 'failed' }],
  )
})

test('stream chatter the Agent has no use for is dropped, not guessed at', () => {
  for (const noise of [
    { type: 'system', subtype: 'hook_started', session_id: FRESH },
    { type: 'rate_limit_event' },
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'hi' }] } },
    { type: 'stream_event' },
    'not an object',
    null,
  ]) {
    assert.deepEqual(headlessEvents(noise), [], `expected nothing from ${JSON.stringify(noise)}`)
  }
})

// ── argv ──────────────────────────────────────────────────────────────────

// The runtime has already folded fresh-vs-resume into launch.argv. Deriving it
// a second time here is how the two paths drift apart.
test('the session flags the runtime computed are used, never re-derived', () => {
  assert.ok(headlessArgv(launch({ kind: 'fresh', id: FRESH }), 'CONSTITUTION')
    .join(' ').includes(`--session-id ${FRESH}`))
  assert.ok(headlessArgv(launch({ kind: 'resume', id: FRESH }), 'CONSTITUTION')
    .join(' ').includes(`--resume ${FRESH}`))
})

test('it runs in print mode with a machine-readable stream', () => {
  const argv = headlessArgv(launch({ kind: 'fresh', id: FRESH }), 'CONSTITUTION')
  assert.ok(argv.includes('-p'))
  assert.deepEqual(
    [argv[argv.indexOf('--output-format') + 1]],
    ['stream-json'],
  )
  // stream-json in print mode is rejected without it; omitting it means the
  // process exits immediately and every turn fails.
  assert.ok(argv.includes('--verbose'))
})

test('the constitution is system context, never typed as a user turn', () => {
  const argv = headlessArgv(launch({ kind: 'fresh', id: FRESH }), 'CONSTITUTION')
  assert.equal(argv[argv.indexOf('--append-system-prompt') + 1], 'CONSTITUTION')
})

// Nobody is watching a print-mode run, so an unallowed tool is denied in
// silence and the Agent reports a confident, wrong "I couldn't find it".
test('the Unmute intercom is allowed so an unattended turn is not silently denied', () => {
  const argv = headlessArgv(launch({ kind: 'fresh', id: FRESH }), 'CONSTITUTION')
  assert.equal(argv[argv.indexOf('--allowedTools') + 1], 'mcp__unmute')
})

test('the allowlist is the only tool grant — no blanket permission bypass', () => {
  const argv = headlessArgv(launch({ kind: 'fresh', id: FRESH }), 'CONSTITUTION')
  assert.ok(!argv.includes('--dangerously-skip-permissions'))
})

// ── the driver ────────────────────────────────────────────────────────────

class FakeChild implements HeadlessChild {
  written: string | null = null
  killed: NodeJS.Signals[] = []
  private exit: ((code: number | null) => void) | null = null
  private readonly chunks: string[] = []
  private waiter: (() => void) | null = null
  private done = false

  readonly stdout: AsyncIterable<string> = {
    [Symbol.asyncIterator]: () => ({
      next: async (): Promise<IteratorResult<string>> => {
        for (;;) {
          const value = this.chunks.shift()
          if (value !== undefined) return { done: false, value }
          if (this.done) return { done: true, value: undefined }
          await new Promise<void>((resolve) => { this.waiter = resolve })
        }
      },
    }),
  }
  readonly stderr = undefined

  writePrompt(text: string): void { this.written = text }
  kill(signal: NodeJS.Signals): void { this.killed.push(signal) }
  onExit(cb: (code: number | null) => void): void { this.exit = cb }

  say(line: unknown): void {
    this.chunks.push(`${JSON.stringify(line)}\n`)
    this.waiter?.(); this.waiter = null
  }

  /** Split a line across chunks — a real pipe does not respect line boundaries. */
  sayInPieces(line: unknown): void {
    const text = `${JSON.stringify(line)}\n`
    const cut = Math.floor(text.length / 2)
    this.chunks.push(text.slice(0, cut), text.slice(cut))
    this.waiter?.(); this.waiter = null
  }

  finish(code: number | null): void {
    this.done = true
    this.waiter?.(); this.waiter = null
    this.exit?.(code)
  }
}

function collect(driver: HeadlessAgentProcess): AgentProcessEvent[] {
  const seen: AgentProcessEvent[] = []
  void (async () => { for await (const event of driver.events) seen.push(event) })()
  return seen
}

async function settled(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r))
}

function driverWith(child: FakeChild, systemPrompt = 'CONSTITUTION') {
  const spawns: Array<{ argv: string[]; cwd: string; env: NodeJS.ProcessEnv }> = []
  const driver = new HeadlessAgentProcess({
    readSystemPrompt: async () => systemPrompt,
    spawn: (argv, opts) => { spawns.push({ argv, ...opts }); return child },
  })
  return { driver, spawns }
}

// The PTY driver had to wait for a side channel to tell it which conversation
// it had started. Here the id was pinned by the runtime, so it is knowable
// before a single byte is spawned — and the 8s handle timeout can never fire.
test('the conversation identity is known before anything is spawned', async () => {
  const child = new FakeChild()
  const { driver, spawns } = driverWith(child)
  const seen = collect(driver)
  await driver.start(launch({ kind: 'fresh', id: FRESH }))
  await settled()
  assert.deepEqual(seen, [{ type: 'handle', sessionId: FRESH }])
  assert.equal(spawns.length, 0, 'starting must not spawn — the prompt is not known yet')
})

test('the prompt is handed to the process at spawn, not typed at a REPL', async () => {
  const child = new FakeChild()
  const { driver, spawns } = driverWith(child)
  collect(driver)
  await driver.start(launch({ kind: 'fresh', id: FRESH }))
  await driver.submitUserTurn('remember that I like oat milk')
  assert.equal(spawns.length, 1)
  assert.equal(child.written, 'remember that I like oat milk')
  assert.equal(spawns[0]!.cwd, '/home/agent')
  assert.equal(spawns[0]!.env.UNMUTE_MCP_TOKEN, 'tok')
})

test('a turn completes from the process stdout alone', async () => {
  const child = new FakeChild()
  const { driver } = driverWith(child)
  const seen = collect(driver)
  await driver.start(launch({ kind: 'fresh', id: FRESH }))
  await driver.submitUserTurn('hello')
  child.say({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read' }] } })
  child.say({ type: 'result', subtype: 'success', is_error: false, result: 'done' })
  child.finish(0)
  await settled()
  assert.deepEqual(seen, [
    { type: 'handle', sessionId: FRESH },
    { type: 'activity', kind: 'tool', summary: 'using Read' },
    { type: 'completion', outcome: 'completed', finalText: 'done' },
    { type: 'exit', exitCode: 0 },
  ])
})

test('a line split across pipe chunks is still one event', async () => {
  const child = new FakeChild()
  const { driver } = driverWith(child)
  const seen = collect(driver)
  await driver.start(launch({ kind: 'fresh', id: FRESH }))
  await driver.submitUserTurn('hello')
  child.sayInPieces({ type: 'result', subtype: 'success', is_error: false, result: 'whole' })
  child.finish(0)
  await settled()
  assert.deepEqual(
    seen.filter((e) => e.type === 'completion'),
    [{ type: 'completion', outcome: 'completed', finalText: 'whole' }],
  )
})

// THE HANG THIS REPLACES. Whatever else goes wrong, a dead process is an
// answer — the Agent must never be left saying "Thinking" with nothing running.
test('a process that dies without a result still ends the turn', async () => {
  const child = new FakeChild()
  const { driver } = driverWith(child)
  const seen = collect(driver)
  await driver.start(launch({ kind: 'fresh', id: FRESH }))
  await driver.submitUserTurn('hello')
  child.finish(1)
  await settled()
  assert.deepEqual(seen.at(-1), { type: 'exit', exitCode: 1 })
})

test('an interrupted turn is reported as interrupted, not as a crash', async () => {
  const child = new FakeChild()
  const { driver } = driverWith(child)
  const seen = collect(driver)
  await driver.start(launch({ kind: 'fresh', id: FRESH }))
  await driver.submitUserTurn('hello')
  await driver.interrupt()
  assert.deepEqual(child.killed, ['SIGINT'])
  child.finish(null)
  await settled()
  assert.ok(seen.some((e) => e.type === 'completion' && e.outcome === 'interrupted'))
})

// Once the answer is in, a late SIGINT-driven exit must not overwrite it.
test('interrupting after the answer arrived does not rewrite the outcome', async () => {
  const child = new FakeChild()
  const { driver } = driverWith(child)
  const seen = collect(driver)
  await driver.start(launch({ kind: 'fresh', id: FRESH }))
  await driver.submitUserTurn('hello')
  child.say({ type: 'result', subtype: 'success', is_error: false, result: 'answered' })
  await settled()
  await driver.interrupt()
  child.finish(null)
  await settled()
  const completions = seen.filter((e) => e.type === 'completion')
  assert.deepEqual(completions, [{ type: 'completion', outcome: 'completed', finalText: 'answered' }])
})

test('closing kills the process and stays safe to call twice', async () => {
  const child = new FakeChild()
  const { driver } = driverWith(child)
  await driver.start(launch({ kind: 'fresh', id: FRESH }))
  await driver.submitUserTurn('hello')
  await driver.close()
  await driver.close()
  assert.deepEqual(child.killed, ['SIGKILL'])
})

// Diagnosis without authority: stderr explains a failure but can never end a
// turn, exactly as PTY bytes cannot.
test('stderr is reported as terminal output and never completes a turn', async () => {
  const child = new FakeChild()
  const stderrChunks: string[] = ['boom\n']
  const driver = new HeadlessAgentProcess({
    readSystemPrompt: async () => 'CONSTITUTION',
    spawn: () => Object.assign(child, {
      stderr: { [Symbol.asyncIterator]: async function* () { yield* stderrChunks } },
    }),
  })
  const seen = collect(driver)
  await driver.start(launch({ kind: 'fresh', id: FRESH }))
  await driver.submitUserTurn('hello')
  child.finish(2)
  await settled()
  assert.ok(seen.some((e) => e.type === 'terminal-output' && e.chunk === 'boom\n'))
  assert.ok(!seen.some((e) => e.type === 'completion'))
})

// ── the revert switch ─────────────────────────────────────────────────────

// Headless is the default because the REPL path's turn-completion signal is an
// out-of-band hook POST that was observed never arriving. The switch back must
// stay a one-word environment change, with no code edit and no rebuild.
test('headless is the default runtime', () => {
  assert.equal(agentRuntimeMode({}), 'headless')
  assert.equal(agentRuntimeMode({ UNMUTE_AGENT_RUNTIME: '' }), 'headless')
})

test('one environment variable reverts to the REPL', () => {
  assert.equal(agentRuntimeMode({ UNMUTE_AGENT_RUNTIME: 'repl' }), 'repl')
  assert.equal(agentRuntimeMode({ UNMUTE_AGENT_RUNTIME: '  REPL  ' }), 'repl')
})

// A typo must not quietly land you on the path that hangs.
test('an unrecognised value keeps the default rather than guessing', () => {
  assert.equal(agentRuntimeMode({ UNMUTE_AGENT_RUNTIME: 'ptty' }), 'headless')
})

test('the chosen runtime is the driver that actually gets built', () => {
  const headless = new ClaudeCodeProvider({ runtime: 'headless' })
  assert.ok(headless.createProcess() instanceof HeadlessAgentProcess)

  const repl = new ClaudeCodeProvider({ runtime: 'repl' })
  assert.ok(repl.createProcess() instanceof ExecutorBackedAgentProcess)
})

// The contract fakes inject their own driver; the runtime flag must not
// override an explicit one or every provider test would spawn real processes.
test('an explicitly injected driver still wins over the flag', () => {
  const injected = new HeadlessAgentProcess({ spawn: () => { throw new Error('unused') } })
  const provider = new ClaudeCodeProvider({ runtime: 'repl', processFactory: () => injected })
  assert.equal(provider.createProcess(), injected)
})

// Observed in the real smoke run: the id is announced twice — once because we
// pinned it, once because the CLI's init event echoes it back. That is kept on
// purpose. The runtime ignores a matching repeat and fails the turn on a
// mismatch, so the echo is free proof that the CLI honoured the id we asked
// for rather than adopting some other conversation.
test('the CLI echo of the session id is kept as confirmation, not suppressed', async () => {
  const child = new FakeChild()
  const { driver } = driverWith(child)
  const seen = collect(driver)
  await driver.start(launch({ kind: 'fresh', id: FRESH }))
  await driver.submitUserTurn('hello')
  child.say({ type: 'system', subtype: 'init', session_id: FRESH })
  child.say({ type: 'result', subtype: 'success', is_error: false, result: 'ok' })
  child.finish(0)
  await settled()
  assert.deepEqual(
    seen.filter((e) => e.type === 'handle'),
    [{ type: 'handle', sessionId: FRESH }, { type: 'handle', sessionId: FRESH }],
  )
})

// The failure this echo exists to catch: the CLI hands back a different
// conversation than the one we pinned. The runtime turns a mismatched handle
// into a failed turn, so it must reach it rather than being filtered here.
test('a session id that is not the one we pinned is reported, not swallowed', async () => {
  const child = new FakeChild()
  const { driver } = driverWith(child)
  const seen = collect(driver)
  await driver.start(launch({ kind: 'fresh', id: FRESH }))
  await driver.submitUserTurn('hello')
  child.say({ type: 'system', subtype: 'init', session_id: '99999999-2222-4333-8444-555555555555' })
  child.finish(0)
  await settled()
  assert.deepEqual(seen.filter((e) => e.type === 'handle').map((e) => e.type === 'handle' && e.sessionId), [
    FRESH,
    '99999999-2222-4333-8444-555555555555',
  ])
})

// ── the Agent's tool surface ──────────────────────────────────────────────

// MEASURED IN THE FIELD: a real Agent turn took 15.4s to its first tool call,
// against ~6s in isolation. The CLI had loaded the user's whole user-scope MCP
// config — 166 tools across 11 servers (chrome-devtools, cua, Gmail, Drive…) —
// and every one of those schemas rides in the request. Headless pays that per
// turn, where the long-lived REPL paid it once.
//
// None of them were ever usable: --allowedTools already restricts the Agent to
// mcp__unmute, so the other 165 were cost without capability. The runtime
// hands us the Agent's own single-server config; using it changes nothing the
// Agent can do and removes everything it cannot.
test('the Agent loads only its own intercom, not the user\'s whole MCP config', () => {
  const withMcp: AgentProcessLaunch = {
    ...launch({ kind: 'fresh', id: FRESH }),
    environment: { UNMUTE_MCP_CONFIG: '{"mcpServers":{"unmute":{"type":"http"}}}' },
  }
  const argv = headlessArgv(withMcp, 'CONSTITUTION')
  assert.equal(argv[argv.indexOf('--mcp-config') + 1], '{"mcpServers":{"unmute":{"type":"http"}}}')
  // Without this the flag ADDS to the user's servers instead of replacing them.
  assert.ok(argv.includes('--strict-mcp-config'))
})

// A turn must still run if the config is missing — losing the intercom is bad,
// but passing `--mcp-config undefined` fails the spawn outright.
test('a missing intercom config omits the flags rather than spawning a broken command', () => {
  const argv = headlessArgv(launch({ kind: 'fresh', id: FRESH }), 'CONSTITUTION')
  assert.ok(!argv.includes('--mcp-config'))
  assert.ok(!argv.includes('--strict-mcp-config'))
})
