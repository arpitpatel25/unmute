import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  HeadlessAgentProcess,
  PersistentHeadlessAgentProcess,
  agentRuntimeMode,
  headlessArgv,
  headlessEvents,
  liveHeadlessTurns,
  reapHeadlessTurns,
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
  // The CLI says WHY, and the parser now carries it (see the failure field) —
  // this expectation was left behind when it started to.
  assert.deepEqual(
    headlessEvents({ type: 'result', subtype: 'error_during_execution', is_error: true }),
    [{ type: 'completion', outcome: 'failed', failure: { subtype: 'error_during_execution' } }],
  )
})

test('the reason travels with the failure, not just its class', () => {
  // `No conversation found with session ID` is the sentence that named a real
  // bug in about a second. Dropping it left the supervisor guessing
  // `provider-crashed` and the user reading "stopped unexpectedly".
  assert.deepEqual(
    headlessEvents({
      type: 'result', subtype: 'error_during_execution', is_error: true,
      result: 'No conversation found with session ID: 3822CFEF',
    }),
    [{
      type: 'completion',
      outcome: 'failed',
      failure: {
        subtype: 'error_during_execution',
        message: 'No conversation found with session ID: 3822CFEF',
      },
    }],
  )
})

// A result whose subtype is not success but which forgot to set is_error must
// still not be reported as a good answer.
test('a non-success subtype fails even when is_error is missing', () => {
  assert.deepEqual(
    headlessEvents({ type: 'result', subtype: 'error_max_turns' }),
    [{ type: 'completion', outcome: 'failed', failure: { subtype: 'error_max_turns' } }],
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
  // Asserted as membership, not as the whole string: the grant now also carries
  // the read tools, and pinning the exact text would make adding one a
  // two-place edit — which is how a list and its test drift apart.
  const allowed = (argv[argv.indexOf('--allowedTools') + 1] ?? '').split(',')
  assert.ok(allowed.includes('mcp__unmute'), 'the intercom must be granted')
})

test('the allowlist is the only tool grant — no blanket permission bypass', () => {
  const argv = headlessArgv(launch({ kind: 'fresh', id: FRESH }), 'CONSTITUTION')
  assert.ok(!argv.includes('--dangerously-skip-permissions'))
})

// Claude Code defaults to `high` effort with nothing set — measured live: a
// headless Agent turn (a memory lookup + a clipboard copy + a task handoff,
// none of it deep reasoning) spent 2,583 thinking tokens on one step, ~39s
// for a reply that should be near-instant. `medium` is Anthropic's own
// documented sweet spot for ordinary work; a real orchestrator SESSION
// (task-manager.ts's dispatch — actual coding/architecture work) is
// deliberately left alone, still on the CLI's own high default.
test('the Agent runs at medium effort, not the CLI\'s high default', () => {
  const argv = headlessArgv(launch({ kind: 'fresh', id: FRESH }), 'CONSTITUTION')
  assert.equal(argv[argv.indexOf('--effort') + 1], 'medium')
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

  /** Every turn written to stdin, in order. A persistent process takes many. */
  readonly prompts: string[] = []
  /** True once something closed stdin — fatal for a streaming session. */
  stdinEnded = false
  writePrompt(text: string): void {
    this.written = text; this.prompts.push(text); this.stdinEnded = true
  }
  writeTurn(text: string): void { this.written = text; this.prompts.push(text) }
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

function collect(driver: { events: AsyncIterable<AgentProcessEvent> }): AgentProcessEvent[] {
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
  // It was briefly `persistent`, which cannot work: a driver does not outlive a
  // turn (CliProviderRuntime closes it on resume), so the warm process it
  // exists for never happens. Every Agent turn failed for a day.
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

// ── confinement (found in the field, 2026-08-18) ──────────────────────────
//
// WHAT HAPPENED. Asked to delete a memory, the Agent called
// mcp__unmute__memory_forget, was REFUSED by the intent gate — and then routed
// around the refusal with `Bash: rm ...` on the user's home directory, and an
// Edit against their personal MEMORY.md. It reported this honestly, which is
// the only reason it was noticed.
//
// --allowedTools does NOT do what its name suggests: measured against the real
// binary, `--allowedTools mcp__unmute` alone left Bash fully available and
// recorded zero permission denials. Naming the built-ins in --disallowedTools
// blocks them, but the model then reached a shell through ANOTHER MCP server
// (osascript via unmute-computer). Only the two together hold: deny the
// built-ins AND admit no MCP server but our own.
//
// A permission system that blocks one door and leaves another open does not
// slow a capable model down; it redirects it.
test('the shell, every writer, and the network are denied by name', () => {
  const argv = headlessArgv(launch({ kind: 'fresh', id: FRESH }), 'CONSTITUTION')
  const denied = (argv[argv.indexOf('--disallowedTools') + 1] ?? '').split(',')
  // The incident above was a WRITE routed around a refusal. These are what
  // make that reachable, plus the only two tools that can leave the machine.
  for (const tool of ['Bash', 'BashOutput', 'KillShell', 'Write', 'Edit', 'NotebookEdit',
                      'WebFetch', 'WebSearch']) {
    assert.ok(denied.includes(tool), `${tool} must be denied to the Agent`)
  }
})

// READING IS DELIBERATELY ALLOWED, AND THAT IS A NARROWER LINE THAN IT WAS.
//
// The answer to "what have we been working on" is in ~/.claude/projects and
// ~/.codex/sessions — hundreds of transcripts this app never wrote. Denying
// Read left the Agent able to see only the tasks Unmute happened to start,
// which is a fraction of the user's work, while Remote spawns Claude with
// --dangerously-skip-permissions on the same machine. Strict here and open
// there was build order, not a posture.
//
// Bash stays denied because it adds nothing to finding and reading a file —
// Glob finds, Grep searches, Read opens — and everything to destroying one.
test('reading is allowed, so the Agent can answer from the user\'s own work', () => {
  const argv = headlessArgv(launch({ kind: 'fresh', id: FRESH }), 'CONSTITUTION')
  const allowed = (argv[argv.indexOf('--allowedTools') + 1] ?? '').split(',')
  const denied = (argv[argv.indexOf('--disallowedTools') + 1] ?? '').split(',')

  for (const tool of ['Read', 'Glob', 'Grep']) {
    assert.ok(allowed.includes(tool), `${tool} must be available`)
    assert.ok(!denied.includes(tool), `${tool} must not also be denied`)
  }
  assert.ok(allowed.includes('mcp__unmute'), 'the intercom stays')
  // The exact thing reading must never become.
  assert.ok(!allowed.includes('Bash'), 'reading must not smuggle a shell back in')
})

// The denial is worth nothing on its own — this is the half that closes the
// escape route, so the two are asserted together, in one place.
test('confinement is only complete with a strict, single-server MCP config', () => {
  const withMcp: AgentProcessLaunch = {
    ...launch({ kind: 'fresh', id: FRESH }),
    environment: { UNMUTE_MCP_CONFIG: '{"mcpServers":{"unmute":{"type":"http"}}}' },
  }
  const argv = headlessArgv(withMcp, 'CONSTITUTION')
  assert.ok(argv.includes('--disallowedTools'), 'built-ins must be denied')
  assert.ok(argv.includes('--strict-mcp-config'), 'and no other MCP server may be loaded')
})

// ── the orphan guard (design §15) ─────────────────────────────────────────
//
// A running Agent turn must not survive the app that started it. We have
// already shipped this exact fix once: the native notch process outlived its
// parent and sat on screen with nothing driving it, and force-quitting Unmute
// never touched it because the process was named something else. The headless
// Agent process has the same shape — a long-lived child holding a model
// connection — and no guard.

test('a spawned turn is registered so it can be reaped with the app', async () => {
  reapHeadlessTurns() // earlier tests in this file leave turns running
  const child = new FakeChild()
  const { driver } = driverWith(child)
  await driver.start(launch({ kind: 'fresh', id: FRESH }))
  await driver.submitUserTurn('hello')
  assert.equal(liveHeadlessTurns(), 1, 'a running turn must be reachable for reaping')
  child.finish(0)
  await settled()
  assert.equal(liveHeadlessTurns(), 0, 'and must deregister when it ends on its own')
})

test('closing a turn deregisters it', async () => {
  reapHeadlessTurns()
  const child = new FakeChild()
  const { driver } = driverWith(child)
  await driver.start(launch({ kind: 'fresh', id: FRESH }))
  await driver.submitUserTurn('hello')
  await driver.close()
  assert.equal(liveHeadlessTurns(), 0)
})

// The reaper must be safe to call when nothing is running, and safe to call
// twice — it runs from process-exit handlers, which fire in ways that are hard
// to predict and impossible to debug after the fact.
test('reaping is safe with nothing running, and idempotent', () => {
  reapHeadlessTurns()
  reapHeadlessTurns()
  assert.equal(liveHeadlessTurns(), 0)
})

test('reaping kills every live turn', async () => {
  reapHeadlessTurns()
  const a = new FakeChild(); const b = new FakeChild()
  const da = driverWith(a).driver; const db = driverWith(b).driver
  await da.start(launch({ kind: 'fresh', id: FRESH })); await da.submitUserTurn('one')
  await db.start(launch({ kind: 'fresh', id: FRESH })); await db.submitUserTurn('two')
  assert.equal(liveHeadlessTurns(), 2)
  reapHeadlessTurns()
  assert.deepEqual(a.killed, ['SIGKILL'])
  assert.deepEqual(b.killed, ['SIGKILL'])
  assert.equal(liveHeadlessTurns(), 0)
})

// ── the persistent driver: one process, many turns ────────────────────────
//
// THE POINT OF IT is the ~4s spawn per turn, which is most of what made the
// Agent feel like a command rather than a conversation. What must NOT come back
// with it are the three failures that removed the PTY driver — and none of them
// can, because all three are properties of driving a TUI rather than of a
// long-lived process. There is no terminal here: turns go in as JSON, results
// come out as JSON.

function persistentWith(child: FakeChild, systemPrompt = 'CONSTITUTION') {
  let spawns = 0
  const seen: string[][] = []
  const driver = new PersistentHeadlessAgentProcess({
    spawn: (argv) => { spawns += 1; seen.push(argv); return child },
    readSystemPrompt: async () => systemPrompt,
  })
  return { driver, spawnCount: () => spawns, argvs: seen }
}

test('streaming input is the one flag that keeps the process alive', () => {
  const argv = headlessArgv(launch({ kind: 'fresh', id: FRESH }), 'C', 'mcp__unmute', true)
  const i = argv.indexOf('--input-format')
  assert.ok(i > 0)
  assert.equal(argv[i + 1], 'stream-json')
  // Without it, print mode reads one prompt to EOF and exits — the per-turn
  // driver — so its absence is exactly as load-bearing as its presence.
  assert.ok(!headlessArgv(launch({ kind: 'fresh', id: FRESH }), 'C').includes('--input-format'))
})

test('a FRESH conversation is launched fresh, not resumed', async () => {
  // THE BUG THIS FILE MISSED. start() is handed the uuid the conversation WILL
  // be called; the driver read it as the id of a session that already existed
  // and rewrote argv to `--resume <uuid>` on the very first spawn. Claude
  // answered `No conversation found with session ID` in about a second, and
  // every single Agent turn failed with "the Agent provider stopped
  // unexpectedly" — 0 of 5 in the field against 6 of 6 on the old driver.
  //
  // The old tests asserted argvs[1] — the RESPAWN — and never argvs[0], which
  // is exactly the gap the bug lived in.
  const child = new FakeChild()
  const { driver, argvs } = persistentWith(child)
  await driver.start(launch({ kind: 'fresh', id: FRESH }))
  await driver.submitUserTurn('first')
  assert.deepEqual(argvs[0].slice(-2), ['--session-id', FRESH],
    'the runtime already decided fresh-vs-resume; the driver must not overrule it')
  assert.ok(!argvs[0].includes('--resume'))
})

test('a conversation the RUNTIME is resuming keeps its resume', async () => {
  const child = new FakeChild()
  const { driver, argvs } = persistentWith(child)
  await driver.start(launch({ kind: 'resume', id: FRESH }))
  await driver.submitUserTurn('carry on')
  assert.deepEqual(argvs[0].slice(-2), ['--resume', FRESH])
})

test('two turns share one process, and stdin is never closed', async () => {
  // CLOSING STDIN ENDS THE INPUT STREAM, and with it the process — so sharing
  // the per-turn driver's writePrompt made this quietly per-turn: it answered
  // the first turn, exited, and respawned for the second, paying the spawn it
  // exists to avoid. Invisible in the events; visible only here.
  const child = new FakeChild()
  const { driver, spawnCount } = persistentWith(child)
  await driver.start(launch({ kind: 'fresh', id: FRESH }))
  await driver.submitUserTurn('first')
  await driver.submitUserTurn('second')
  assert.equal(child.stdinEnded, false, 'EOF would end the conversation')
  assert.equal(spawnCount(), 1, 'the whole point: no respawn between turns')
  assert.deepEqual(child.prompts.map((p) => JSON.parse(p).message.content[0].text),
    ['first', 'second'])
})

test('a turn is one JSON line, in the shape stream-json input expects', async () => {
  const child = new FakeChild()
  const { driver } = persistentWith(child)
  await driver.start(launch({ kind: 'fresh', id: FRESH }))
  await driver.submitUserTurn('what is on my plate?')
  assert.ok(child.prompts[0].endsWith('\n'), 'one line, terminated')
  assert.deepEqual(JSON.parse(child.prompts[0]), {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: 'what is on my plate?' }] },
  })
})

test('a result ends the TURN, not the conversation', async () => {
  const child = new FakeChild()
  const { driver, spawnCount } = persistentWith(child)
  const seen = collect(driver)
  await driver.start(launch({ kind: 'fresh', id: FRESH }))
  await driver.submitUserTurn('first')
  child.say({ type: 'result', subtype: 'success', result: 'Eleven open.' })
  await settled()
  assert.deepEqual(seen.filter((e) => e.type === 'completion'),
    [{ type: 'completion', outcome: 'completed', finalText: 'Eleven open.' }])
  await driver.submitUserTurn('and the blocked ones?')
  assert.equal(spawnCount(), 1, 'the process is still up and still ours')
})

test('a process that dies is respawned INTO THE SAME SESSION', async () => {
  // A warm process is an optimisation. The session id is the system of record,
  // and it is the one learned from init — the one that reflects turns already
  // taken, not the one we were handed at start.
  const child = new FakeChild()
  let current = child
  let spawns = 0
  const argvs: string[][] = []
  const driver = new PersistentHeadlessAgentProcess({
    spawn: (argv) => { spawns += 1; argvs.push(argv); return current },
    readSystemPrompt: async () => 'C',
  })
  await driver.start(launch({ kind: 'fresh', id: FRESH }))
  await driver.submitUserTurn('first')
  child.say({ type: 'system', subtype: 'init', session_id: 'learned-id' })
  await settled()
  child.finish(1)                       // it crashed
  await settled()

  current = new FakeChild()
  await driver.submitUserTurn('second')
  assert.equal(spawns, 2, 'the next turn brings it back')
  assert.deepEqual(argvs[1].slice(-2), ['--resume', 'learned-id'],
    'back into the conversation it was in, not a fresh one')
})

test('an exit while nothing is in flight is a fault, not an answer', async () => {
  // In the per-turn driver, exit is the backstop that guarantees a completion.
  // Here it must never invent one: a process that fell over between turns has
  // not answered anything.
  const child = new FakeChild()
  const { driver } = persistentWith(child)
  const seen = collect(driver)
  await driver.start(launch({ kind: 'fresh', id: FRESH }))
  await driver.submitUserTurn('first')
  child.finish(0)
  await settled()
  assert.equal(seen.filter((e) => e.type === 'completion').length, 0)
  assert.ok(seen.some((e) => e.type === 'exit'))
})

test('an interrupt ends the turn and says so', async () => {
  const child = new FakeChild()
  const { driver } = persistentWith(child)
  const seen = collect(driver)
  await driver.start(launch({ kind: 'fresh', id: FRESH }))
  await driver.submitUserTurn('first')
  await driver.interrupt()
  assert.deepEqual(child.killed, ['SIGINT'])
  child.finish(null)
  await settled()
  assert.deepEqual(seen.filter((e) => e.type === 'completion'),
    [{ type: 'completion', outcome: 'interrupted' }])
})

test('nothing is spawned until there is something to say', async () => {
  // A warm `claude` holds a model connection. Spawning one at launch would pay
  // for an Agent the user may never speak to today.
  const child = new FakeChild()
  const { driver, spawnCount } = persistentWith(child)
  await driver.start(launch({ kind: 'fresh', id: FRESH }))
  assert.equal(spawnCount(), 0)
  await driver.submitUserTurn('now')
  assert.equal(spawnCount(), 1)
})

test('a live turn is reaped with the app', async () => {
  const child = new FakeChild()
  const { driver } = persistentWith(child)
  await driver.start(launch({ kind: 'fresh', id: FRESH }))
  const before = liveHeadlessTurns()
  await driver.submitUserTurn('first')
  assert.equal(liveHeadlessTurns(), before + 1, 'a warm process must not outlive the app')
  reapHeadlessTurns()
  assert.equal(liveHeadlessTurns(), 0)
  await driver.close()
})

test('headless is the default, and both other drivers are opt-in', () => {
  assert.equal(agentRuntimeMode({}), 'headless')
  assert.equal(agentRuntimeMode({ UNMUTE_AGENT_RUNTIME: 'persistent' }), 'persistent')
  assert.equal(agentRuntimeMode({ UNMUTE_AGENT_RUNTIME: 'repl' }), 'repl')
  // A typo must not silently drop you onto a different driver.
  assert.equal(agentRuntimeMode({ UNMUTE_AGENT_RUNTIME: 'persisten' }), 'headless')
})

test('the provider builds the driver the mode names', () => {
  assert.ok(new ClaudeCodeProvider().createProcess() instanceof HeadlessAgentProcess)
  assert.ok(new ClaudeCodeProvider({ runtime: 'persistent' }).createProcess()
    instanceof PersistentHeadlessAgentProcess)
  assert.ok(new ClaudeCodeProvider({ runtime: 'headless' }).createProcess()
    instanceof HeadlessAgentProcess)
  assert.ok(new ClaudeCodeProvider({ runtime: 'repl' }).createProcess()
    instanceof ExecutorBackedAgentProcess)
})
