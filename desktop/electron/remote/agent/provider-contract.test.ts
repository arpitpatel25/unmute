import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SpawnOpts } from '../executor'
import {
  AgentProviderError,
  ExecutorBackedAgentProcess,
  type AgentProcessDriver,
  type AgentProcessEvent,
  type AgentProcessLaunch,
  type AgentProvider,
  type AgentStartInput,
  type ProviderEventObserver,
} from './provider'
import { ClaudeCodeProvider, claudeHookObserver } from './providers/claude'
import { CodexCliProvider, codexRolloutObserver } from './providers/codex'

class EventQueue implements AsyncIterable<AgentProcessEvent> {
  private readonly queued: AgentProcessEvent[] = []
  private readonly waiting: Array<(value: IteratorResult<AgentProcessEvent>) => void> = []
  private ended = false

  emit(event: AgentProcessEvent): void {
    const waiter = this.waiting.shift()
    if (waiter) waiter({ done: false, value: event })
    else this.queued.push(event)
  }

  end(): void {
    this.ended = true
    for (const waiter of this.waiting.splice(0)) waiter({ done: true, value: undefined })
  }

  [Symbol.asyncIterator](): AsyncIterator<AgentProcessEvent> {
    return {
      next: async () => {
        const value = this.queued.shift()
        if (value) return { done: false, value }
        if (this.ended) return { done: true, value: undefined }
        return new Promise((resolve) => this.waiting.push(resolve))
      },
    }
  }
}

class FakeProcess implements AgentProcessDriver {
  readonly events = new EventQueue()
  launch: AgentProcessLaunch | null = null
  submitted: string[] = []
  interrupts = 0
  closes = 0

  constructor(private readonly onStart?: (process: FakeProcess) => void) {}

  async start(launch: AgentProcessLaunch): Promise<void> {
    this.launch = launch
    this.onStart?.(this)
  }

  async submitUserTurn(text: string): Promise<void> {
    this.submitted.push(text)
  }

  async interrupt(): Promise<void> {
    this.interrupts++
  }

  async close(): Promise<void> {
    this.closes++
    this.events.end()
  }
}

interface ManagedExecutorResource {
  emit(event: AgentProcessEvent): void
  kills: number
  stops: number
}

function managedExecutorHarness() {
  const resources: ManagedExecutorResource[] = []
  const ids = [
    CODEX_ID,
    '00000002-2222-4222-8222-222222222222',
    '00000003-2222-4222-8222-222222222222',
  ]
  const provider = new CodexCliProvider({
    processFactory: () => {
      const id = ids[resources.length]
      const resource: ManagedExecutorResource = { emit() {}, kills: 0, stops: 0 }
      resources.push(resource)
      return new ExecutorBackedAgentProcess({
        createExecutor: () => ({
          alive: true,
          async spawn() { resource.emit({ type: 'handle', sessionId: id }) },
          async isReady() {},
          writeStdin() {},
          write() {},
          resize() {},
          onData() {},
          kill() { resource.kills++ },
        }),
        observe: (_launch, emit) => {
          resource.emit = emit
          return () => { resource.stops++ }
        },
      })
    },
    probeBinary: async () => true,
  })
  return { provider, resources }
}

const CLAUDE_ID = '11111111-1111-4111-8111-111111111111'
const CODEX_ID = '22222222-2222-4222-8222-222222222222'
const CONSTITUTION = '/private/unmute/agent-constitution.md'
const TOKEN = 'interaction-secret-token'

function input(runId: string, overrides: Partial<AgentStartInput> = {}): AgentStartInput {
  return {
    runId,
    interactionId: `interaction-${runId}`,
    cwd: `/work/${runId}`,
    transcript: `help with ${runId}`,
    constitutionPath: CONSTITUTION,
    environment: {
      PATH: '/usr/local/bin:/usr/bin',
      HOME: '/Users/tester',
      LANG: 'en_US.UTF-8',
      ANTHROPIC_API_KEY: 'anthropic-secret',
      ANTHROPIC_AUTH_TOKEN: 'anthropic-auth-secret',
      CLAUDE_API_KEY: 'claude-secret',
      OPENAI_API_KEY: 'openai-secret',
      OPENAI_API_BASE: 'https://api.example.invalid',
      RANDOM_PRIVATE_VALUE: 'must-not-be-forwarded',
    },
    mcp: {
      endpoint: 'http://127.0.0.1:42117/mcp',
      config: '{"server":"unmute"}',
      token: TOKEN,
    },
    ...overrides,
  }
}

function harness(kind: 'claude' | 'codex', opts: { available?: boolean } = {}) {
  const processes: FakeProcess[] = []
  let claudeIds = 0
  const processFactory = () => {
    const process = new FakeProcess((p) => {
      if (kind === 'codex') {
        const resumedId = p.launch?.argv[0] === 'resume' ? p.launch.argv[1] : undefined
        const freshId = processes.length === 1
          ? CODEX_ID
          : `${String(processes.length).padStart(8, '0')}-2222-4222-8222-222222222222`
        p.events.emit({ type: 'handle', sessionId: resumedId ?? freshId })
      }
    })
    processes.push(process)
    return process
  }
  const provider: AgentProvider = kind === 'claude'
    ? new ClaudeCodeProvider({
      processFactory,
      probeBinary: async () => opts.available ?? true,
      randomId: () => claudeIds++ === 0
        ? CLAUDE_ID
        : `${String(claudeIds).padStart(8, '0')}-1111-4111-8111-111111111111`,
    })
    : new CodexCliProvider({
      processFactory,
      probeBinary: async () => opts.available ?? true,
    })
  return { provider, processes }
}

async function nextActivity(session: Awaited<ReturnType<AgentProvider['start']>>) {
  return session.activity[Symbol.asyncIterator]().next()
}

function assertProviderError(error: unknown, code: AgentProviderError['code']): boolean {
  assert.ok(error instanceof AgentProviderError)
  assert.equal(error.code, code)
  return true
}

for (const kind of ['claude', 'codex'] as const) {
  test(`${kind}: fresh start and exact-handle resume use isolated provider argv`, async () => {
    const { provider, processes } = harness(kind)
    const first = await provider.start(input('one'))

    assert.equal(first.handle.provider, kind)
    assert.equal(processes[0].launch?.binary, kind)
    assert.deepEqual(
      processes[0].launch?.argv,
      kind === 'claude' ? ['--session-id', CLAUDE_ID] : [],
    )
    assert.deepEqual(processes[0].submitted, ['help with one'])
    assert.deepEqual(processes[0].launch?.systemContext, { type: 'file', path: CONSTITUTION })

    processes[0].events.emit({ type: 'completion', outcome: 'completed', finalText: 'first done' })
    await first.completion
    const resumed = provider.resume(first.handle, input('follow-up'))
    if (kind === 'codex') await new Promise<void>((resolve) => setImmediate(resolve))
    const second = await resumed

    assert.deepEqual(
      processes[1].launch?.argv,
      kind === 'claude' ? ['--resume', CLAUDE_ID] : ['resume', CODEX_ID],
    )
    assert.equal(second.handle.opaqueId, first.handle.opaqueId)
    assert.deepEqual(processes[1].submitted, ['help with follow-up'])
  })

  test(`${kind}: simultaneous sessions do not share output, completion, or cancellation`, async () => {
    const { provider, processes } = harness(kind)
    const a = await provider.start(input('a'))
    const b = await provider.start(input('b'))

    processes[0].events.emit({ type: 'activity', kind: 'tool', summary: 'A only' })
    processes[1].events.emit({ type: 'activity', kind: 'progress', summary: 'B only' })
    assert.equal((await nextActivity(a)).value?.summary, 'A only')
    assert.equal((await nextActivity(b)).value?.summary, 'B only')

    processes[0].events.emit({ type: 'completion', outcome: 'completed', finalText: 'A done' })
    assert.equal((await a.completion).finalText, 'A done')
    let bSettled = false
    void b.completion.then(() => { bSettled = true })
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(bSettled, false)

    await provider.interrupt(b.handle)
    assert.equal(processes[0].interrupts, 0)
    assert.equal(processes[1].interrupts, 1)
  })

  test(`${kind}: activity remains ordered and a duplicate or late completion settles once`, async () => {
    const { provider, processes } = harness(kind)
    const session = await provider.start(input('ordered'))
    const iterator = session.activity[Symbol.asyncIterator]()

    processes[0].events.emit({ type: 'activity', kind: 'progress', summary: 'first' })
    processes[0].events.emit({ type: 'activity', kind: 'tool', summary: 'second' })
    processes[0].events.emit({ type: 'completion', outcome: 'completed', finalText: 'the final' })
    processes[0].events.emit({ type: 'completion', outcome: 'failed', finalText: 'must be ignored' })
    assert.equal((await iterator.next()).value?.summary, 'first')
    assert.equal((await iterator.next()).value?.summary, 'second')
    assert.equal((await iterator.next()).done, true)
    assert.deepEqual(await session.completion, { outcome: 'completed', finalText: 'the final' })
  })

  test(`${kind}: arbitrary terminal output and quiet time cannot complete a turn`, async () => {
    const { provider, processes } = harness(kind)
    const session = await provider.start(input('heuristic'))
    processes[0].events.emit({ type: 'terminal-output', chunk: 'Done!\n' })
    let settled = false
    void session.completion.then(() => { settled = true })
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
    assert.equal(settled, false)
    processes[0].events.emit({ type: 'completion', outcome: 'completed', finalText: 'owned event' })
    assert.equal((await session.completion).finalText, 'owned event')
  })

  test(`${kind}: interrupt targets one active turn and the durable handle remains resumable`, async () => {
    const { provider, processes } = harness(kind)
    const first = await provider.start(input('interrupt'))
    await provider.interrupt(first.handle)
    assert.equal(processes[0].interrupts, 1)
    processes[0].events.emit({ type: 'completion', outcome: 'interrupted' })
    assert.equal((await first.completion).outcome, 'interrupted')

    const resumedPromise = provider.resume(first.handle, input('resume-interrupt'))
    if (kind === 'codex') await new Promise<void>((resolve) => setImmediate(resolve))
    const resumed = await resumedPromise
    assert.equal(resumed.handle.opaqueId, first.handle.opaqueId)
  })

  test(`${kind}: close is addressed and idempotent; closed handles fail honestly`, async () => {
    const { provider, processes } = harness(kind)
    const a = await provider.start(input('close-a'))
    const b = await provider.start(input('close-b'))
    await provider.close(a.handle)
    await provider.close(a.handle)
    assert.equal(processes[0].closes, 1)
    assert.equal(processes[1].closes, 0)

    await assert.rejects(provider.interrupt(a.handle), (e) => assertProviderError(e, 'session-closed'))
    await assert.rejects(provider.resume(a.handle, input('closed-resume')), (e) => assertProviderError(e, 'session-closed'))

    processes[1].events.emit({ type: 'completion', outcome: 'completed', finalText: 'still alive' })
    assert.equal((await b.completion).finalText, 'still alive')
  })

  test(`${kind}: probe exposes only availability`, async () => {
    const available = await harness(kind).provider.probe()
    const unavailable = await harness(kind, { available: false }).provider.probe()
    assert.deepEqual(available, { provider: kind, available: true })
    assert.deepEqual(unavailable, { provider: kind, available: false, reason: 'not-installed' })
    assert.doesNotMatch(JSON.stringify(unavailable), /PATH|secret|command|output/i)
  })

  test(`${kind}: each process gets a fresh allowlisted environment and scoped MCP values`, async () => {
    const before = {
      token: process.env.UNMUTE_MCP_TOKEN,
      endpoint: process.env.UNMUTE_MCP_ENDPOINT,
      config: process.env.UNMUTE_MCP_CONFIG,
    }
    const { provider, processes } = harness(kind)
    await provider.start(input('env-a'))
    await provider.start(input('env-b', { mcp: { endpoint: 'http://127.0.0.1:9/mcp', config: '{"b":true}', token: 'token-b' } }))
    const a = processes[0].launch!
    const b = processes[1].launch!

    assert.equal(a.environment.PATH, '/usr/local/bin:/usr/bin')
    assert.equal(a.environment.HOME, '/Users/tester')
    assert.equal(a.environment.ANTHROPIC_API_KEY, undefined)
    assert.equal(a.environment.ANTHROPIC_AUTH_TOKEN, undefined)
    assert.equal(a.environment.CLAUDE_API_KEY, undefined)
    assert.equal(a.environment.OPENAI_API_KEY, undefined)
    assert.equal(a.environment.OPENAI_API_BASE, undefined)
    assert.equal(a.environment.RANDOM_PRIVATE_VALUE, undefined)
    assert.equal(a.environment.UNMUTE_MCP_TOKEN, TOKEN)
    assert.equal(a.environment.UNMUTE_MCP_ENDPOINT, 'http://127.0.0.1:42117/mcp')
    assert.equal(a.environment.UNMUTE_MCP_URL, 'http://127.0.0.1:42117/mcp')
    assert.equal(a.environment.UNMUTE_MCP_CONFIG, '{"server":"unmute"}')
    assert.equal(b.environment.UNMUTE_MCP_TOKEN, 'token-b')
    assert.notEqual(a.environment, b.environment)
    assert.deepEqual({
      token: process.env.UNMUTE_MCP_TOKEN,
      endpoint: process.env.UNMUTE_MCP_ENDPOINT,
      config: process.env.UNMUTE_MCP_CONFIG,
    }, before)
  })

  test(`${kind}: token and system context never become argv or a user turn`, async () => {
    const { provider, processes } = harness(kind)
    await provider.start(input('separation'))
    const launch = processes[0].launch!
    assert.doesNotMatch(JSON.stringify(launch.argv), new RegExp(TOKEN))
    assert.deepEqual(processes[0].submitted, ['help with separation'])
    assert.ok(!processes[0].submitted.some((turn) => turn.includes(CONSTITUTION)))
    for (const forbidden of ['-p', '--print', 'exec']) assert.ok(!launch.argv.includes(forbidden))
  })

  test(`${kind}: secrets are redacted from activity and final results`, async () => {
    const { provider, processes } = harness(kind)
    const session = await provider.start(input('redaction'))
    processes[0].events.emit({ type: 'activity', kind: 'progress', summary: `using ${TOKEN} at /Users/alice/private.txt and /etc/passwd` })
    processes[0].events.emit({
      type: 'completion',
      outcome: 'failed',
      finalText: `${TOKEN} at ${CONSTITUTION} and C:\\Users\\alice\\private.txt`,
    })

    const activity = (await nextActivity(session)).value!
    const result = await session.completion
    assert.doesNotMatch(JSON.stringify(activity), new RegExp(TOKEN))
    assert.doesNotMatch(JSON.stringify(result), new RegExp(TOKEN))
    assert.doesNotMatch(JSON.stringify(result), /agent-constitution\.md/)
    assert.doesNotMatch(JSON.stringify(activity), /Users\/alice/)
    assert.doesNotMatch(JSON.stringify(activity), /etc\/passwd/)
    assert.doesNotMatch(JSON.stringify(result), /Users\\\\alice/)
    assert.doesNotMatch(JSON.stringify(session.handle), new RegExp(TOKEN))
  })
}

test('both providers receive the same generated constitution through the system channel', async () => {
  const claude = harness('claude')
  const codex = harness('codex')
  await Promise.all([claude.provider.start(input('claude')), codex.provider.start(input('codex'))])
  assert.deepEqual(claude.processes[0].launch?.systemContext, codex.processes[0].launch?.systemContext)
  assert.equal(claude.processes[0].submitted[0], 'help with claude')
  assert.equal(codex.processes[0].submitted[0], 'help with codex')
})

test('Claude completion comes only from the pinned session Stop hook', async () => {
  const source: { listener: ((event: import('../observer').HookEvent) => void) | null } = { listener: null }
  const observe = claudeHookObserver({
    subscribe(cb) { source.listener = cb; return () => { source.listener = null } },
  })
  const seen: AgentProcessEvent[] = []
  const stop = await beginObservation(observe, {
    provider: 'claude',
    binary: 'claude',
    argv: ['--session-id', CLAUDE_ID],
    cwd: '/work/claude',
    taskId: 'claude-hooks',
    environment: {},
    systemContext: { type: 'file', path: CONSTITUTION },
    session: { kind: 'fresh', id: CLAUDE_ID },
  }, (event) => seen.push(event))

  source.listener?.({ kind: 'turn-ended', sessionId: CODEX_ID, lastMessage: 'wrong session' })
  source.listener?.({ kind: 'tool-used', sessionId: CLAUDE_ID, tool: 'Read' })
  source.listener?.({ kind: 'turn-ended', sessionId: CLAUDE_ID, lastMessage: 'Pinned final.' })
  assert.deepEqual(seen, [
    { type: 'activity', kind: 'tool', summary: 'using Read' },
    { type: 'completion', outcome: 'completed', finalText: 'Pinned final.' },
  ])
  stop?.()
})

test('a handle cannot cross provider boundaries', async () => {
  const claude = harness('claude')
  const codex = harness('codex')
  const session = await claude.provider.start(input('claude'))
  await assert.rejects(codex.provider.resume(session.handle, input('wrong-provider')), (e) =>
    assertProviderError(e, 'invalid-handle'))
})

test('executor-backed close still kills the PTY when observer cleanup throws', async () => {
  let kills = 0
  const driver = new ExecutorBackedAgentProcess({
    createExecutor: () => ({
      alive: true,
      async spawn() {},
      async isReady() {},
      writeStdin() {},
      write() {},
      resize() {},
      onData() {},
      kill() { kills++ },
    }),
    observe: () => () => { throw new Error('observer cleanup failed') },
  })
  await driver.start(codexLaunch('/tmp/provider-close', { kind: 'resume', id: CODEX_ID }))
  await driver.close()
  await driver.close()
  assert.equal(kills, 1)
})

test('Codex fails closed when its rollout observer reports a malformed or missing minted handle', async () => {
  for (const event of [
    { type: 'handle', sessionId: '../not-a-session' } as const,
    { type: 'completion', outcome: 'completed', finalText: 'too early' } as const,
    { type: 'exit', exitCode: 1 } as const,
  ]) {
    const provider = new CodexCliProvider({
      processFactory: () => new FakeProcess((p) => p.events.emit(event)),
      probeBinary: async () => true,
    })
    await assert.rejects(provider.start(input('bad-codex-handle')), (e) =>
      assertProviderError(e, 'provider-handle-missing'))
  }
})

test('Codex closes a live process whose minted handle never becomes observable', { timeout: 500 }, async () => {
  const process = new FakeProcess()
  const provider = new CodexCliProvider({
    processFactory: () => process,
    probeBinary: async () => true,
    handleTimeoutMs: 20,
  })
  await assert.rejects(provider.start(input('missing-handle-timeout')), (e) =>
    assertProviderError(e, 'provider-handle-missing'))
  assert.equal(process.closes, 1)
})

test('malformed or conflicting late handles close only their own identified run', async () => {
  const { provider, resources } = managedExecutorHarness()
  const a = await provider.start(input('a'))
  const b = await provider.start(input('b'))

  resources[0].emit({ type: 'handle', sessionId: '../not-a-session' })
  assert.equal((await a.completion).outcome, 'failed')
  assert.deepEqual({ kills: resources[0].kills, stops: resources[0].stops }, { kills: 1, stops: 1 })
  assert.deepEqual({ kills: resources[1].kills, stops: resources[1].stops }, { kills: 0, stops: 0 })

  const c = await provider.start(input('c'))
  resources[2].emit({ type: 'handle', sessionId: '33333333-3333-4333-8333-333333333333' })
  resources[1].emit({ type: 'completion', outcome: 'completed', finalText: 'B done' })
  assert.equal((await c.completion).outcome, 'failed')
  assert.deepEqual({ kills: resources[2].kills, stops: resources[2].stops }, { kills: 1, stops: 1 })
  assert.deepEqual({ kills: resources[1].kills, stops: resources[1].stops }, { kills: 0, stops: 0 })
  assert.equal((await b.completion).finalText, 'B done')
})

test('an observer failure after identity closes its own process exactly once', { timeout: 500 }, async () => {
  const { provider, resources } = managedExecutorHarness()
  const a = await provider.start(input('observer-failure-a'))
  const b = await provider.start(input('observer-failure-b'))

  try {
    resources[0].emit({ type: 'observer-failure' })
    const completion = await Promise.race([
      a.completion,
      new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 30)),
    ])
    assert.deepEqual(completion, { outcome: 'failed' })
    assert.deepEqual({ kills: resources[0].kills, stops: resources[0].stops }, { kills: 1, stops: 1 })
    assert.deepEqual({ kills: resources[1].kills, stops: resources[1].stops }, { kills: 0, stops: 0 })

    resources[1].emit({ type: 'completion', outcome: 'completed', finalText: 'B survived' })
    assert.equal((await b.completion).finalText, 'B survived')
  } finally {
    await provider.close(a.handle).catch(() => {})
    await provider.close(b.handle).catch(() => {})
  }
})

test('discovery timeout kills the spawned PTY and stops observation exactly once', { timeout: 500 }, async () => {
  let kills = 0
  let stops = 0
  const provider = new CodexCliProvider({
    processFactory: () => new ExecutorBackedAgentProcess({
      createExecutor: () => ({
        alive: true,
        async spawn() {},
        async isReady() {},
        writeStdin() {},
        write() {},
        resize() {},
        onData() {},
        kill() { kills++ },
      }),
      observe: () => () => { stops++ },
    }),
    probeBinary: async () => true,
    handleTimeoutMs: 20,
  })

  await assert.rejects(provider.start(input('observer-timeout')), (e) =>
    assertProviderError(e, 'provider-handle-missing'))
  assert.equal(kills, 1)
  assert.equal(stops, 1)
})

test('a start failure after PTY spawn cleans observer and process exactly once', async () => {
  let kills = 0
  let stops = 0
  const provider = new CodexCliProvider({
    processFactory: () => new ExecutorBackedAgentProcess({
      createExecutor: () => ({
        alive: true,
        async spawn() { throw new Error(`${TOKEN} at /Users/alice/private.txt`) },
        async isReady() {},
        writeStdin() {},
        write() {},
        resize() {},
        onData() {},
        kill() { kills++ },
      }),
      observe: () => () => { stops++ },
    }),
    probeBinary: async () => true,
  })

  await assert.rejects(provider.start(input('spawn-failure')), (e) => {
    assertProviderError(e, 'provider-unavailable')
    assert.doesNotMatch(String(e), new RegExp(`${TOKEN}|Users/alice`))
    return true
  })
  assert.equal(kills, 1)
  assert.equal(stops, 1)
})

async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 1_000
  while (!predicate() && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
  assert.equal(predicate(), true, message)
}

async function completionWithin<T>(completion: Promise<T>, timeoutMs = 1_000): Promise<T | 'timed-out'> {
  return Promise.race([
    completion,
    new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), timeoutMs)),
  ])
}

async function beginObservation(
  observe: ProviderEventObserver,
  launch: AgentProcessLaunch,
  emit: (event: AgentProcessEvent) => void,
): Promise<void | (() => void)> {
  const observation = await observe(launch, emit)
  if (!observation || typeof observation === 'function') return observation
  await observation.afterSpawn()
  return observation.stop.bind(observation)
}

function codexLaunch(home: string, session: AgentProcessLaunch['session']): AgentProcessLaunch {
  return {
    provider: 'codex',
    binary: 'codex',
    argv: session.kind === 'resume' ? ['resume', session.id!] : [],
    cwd: join(home, 'repo'),
    taskId: 'rollout-run',
    environment: {},
    systemContext: { type: 'file', path: join(home, 'constitution.md') },
    session,
  }
}

function rolloutLine(type: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ type, timestamp: new Date().toISOString(), payload })
}

test('Codex rollout observation learns a fresh handle and completes from task_complete', async () => {
  const home = join(tmpdir(), `unmute-agent-provider-${randomUUID()}`)
  const sessions = join(home, '.codex', 'sessions', '2026', '08', '17')
  const cwd = join(home, 'repo')
  await fs.mkdir(sessions, { recursive: true })
  await fs.mkdir(cwd, { recursive: true })
  const seen: AgentProcessEvent[] = []
  const stop = await beginObservation(
    codexRolloutObserver({ home, pollMs: 5 }),
    codexLaunch(home, { kind: 'fresh' }),
    (event) => seen.push(event),
  )
  const rollout = join(sessions, `rollout-now-${CODEX_ID}.jsonl`)
  await fs.writeFile(rollout, [
    rolloutLine('session_meta', { session_id: CODEX_ID, cwd, timestamp: new Date().toISOString() }),
    rolloutLine('event_msg', { type: 'task_started' }),
    rolloutLine('event_msg', { type: 'exec_command_end' }),
    rolloutLine('event_msg', { type: 'agent_message', message: 'Finished safely.' }),
    rolloutLine('event_msg', { type: 'task_complete', last_agent_message: 'Canonical final.' }),
  ].join('\n') + '\n')

  await waitUntil(() => seen.some((event) => event.type === 'completion'), 'structured completion was observed')
  assert.deepEqual(seen, [
    { type: 'handle', sessionId: CODEX_ID },
    { type: 'activity', kind: 'tool', summary: 'running a command' },
    { type: 'completion', outcome: 'completed', finalText: 'Canonical final.' },
  ])
  stop?.()
  await fs.rm(home, { recursive: true, force: true })
})

test('Codex resume baselines old rollout completions before observing the new turn', async () => {
  const home = join(tmpdir(), `unmute-agent-provider-${randomUUID()}`)
  const sessions = join(home, '.codex', 'sessions', '2026', '08', '17')
  const cwd = join(home, 'repo')
  await fs.mkdir(sessions, { recursive: true })
  await fs.mkdir(cwd, { recursive: true })
  const rollout = join(sessions, `rollout-now-${CODEX_ID}.jsonl`)
  await fs.writeFile(rollout, [
    rolloutLine('session_meta', { session_id: CODEX_ID, cwd, timestamp: new Date().toISOString() }),
    rolloutLine('event_msg', { type: 'agent_message', message: 'Old answer.' }),
    rolloutLine('event_msg', { type: 'task_complete', last_agent_message: 'Old final.' }),
  ].join('\n') + '\n')
  const seen: AgentProcessEvent[] = []
  const stop = await beginObservation(
    codexRolloutObserver({ home, pollMs: 5 }),
    codexLaunch(home, { kind: 'resume', id: CODEX_ID }),
    (event) => seen.push(event),
  )
  await fs.appendFile(rollout, [
    rolloutLine('event_msg', { type: 'task_started' }),
    rolloutLine('event_msg', { type: 'agent_message', message: 'New answer.' }),
    rolloutLine('event_msg', { type: 'task_complete', last_agent_message: 'Canonical new final.' }),
  ].join('\n') + '\n')

  await waitUntil(() => seen.some((event) => event.type === 'completion'), 'new completion was observed')
  assert.deepEqual(seen, [
    { type: 'completion', outcome: 'completed', finalText: 'Canonical new final.' },
  ])
  stop?.()
  await fs.rm(home, { recursive: true, force: true })
})

test('Codex resume re-baselines exact archived history before spawn and emits only the current turn', async () => {
  const home = join(tmpdir(), `unmute-agent-provider-${randomUUID()}`)
  const sessions = join(home, '.codex', 'sessions', '2026', '08', '17')
  const archived = join(home, '.codex', 'archived_sessions')
  const cwd = join(home, 'repo')
  const live = join(sessions, `rollout-now-${CODEX_ID}.jsonl`)
  const moved = join(archived, `rollout-now-${CODEX_ID}.jsonl`)
  await fs.mkdir(sessions, { recursive: true })
  await fs.mkdir(archived, { recursive: true })
  await fs.mkdir(cwd, { recursive: true })
  await fs.writeFile(live, [
    rolloutLine('session_meta', { session_id: CODEX_ID, cwd, timestamp: new Date().toISOString() }),
    rolloutLine('event_msg', { type: 'task_started' }),
    rolloutLine('event_msg', { type: 'exec_command_end' }),
    rolloutLine('event_msg', { type: 'task_complete', last_agent_message: 'Old final.' }),
  ].join('\n') + '\n')

  const readFileDescriptor = Object.getOwnPropertyDescriptor(fs, 'readFile')
  if (!readFileDescriptor) assert.fail('fs.readFile descriptor was unavailable')
  const originalReadFile = fs.readFile
  let movedDuringBaseline = false
  Object.defineProperty(fs, 'readFile', {
    configurable: true,
    writable: true,
    value: async (...args: unknown[]) => {
      if (String(args[0]) === live && !movedDuringBaseline) {
        movedDuringBaseline = true
        await fs.rename(live, moved)
      }
      return Reflect.apply(originalReadFile, fs, args)
    },
  })

  let spawns = 0
  const observe = codexRolloutObserver({ home, pollMs: 5 })
  const provider = new CodexCliProvider({
    processFactory: () => new ExecutorBackedAgentProcess({
      createExecutor: () => ({
        alive: true,
        async spawn(opts) {
          spawns++
          assert.equal(opts.resumeSessionId, CODEX_ID)
          await fs.appendFile(moved, [
            rolloutLine('event_msg', { type: 'task_started' }),
            rolloutLine('event_msg', { type: 'task_complete', last_agent_message: 'Current final.' }),
          ].join('\n') + '\n')
        },
        async isReady() {},
        writeStdin() {},
        write() {},
        resize() {},
        onData() {},
        kill() {},
      }),
      observe,
    }),
    probeBinary: async () => true,
  })
  const handle = { provider: 'codex' as const, opaqueId: CODEX_ID }

  try {
    const resumed = await provider.resume(handle, input('resume-relocated-baseline', {
      cwd,
      constitutionPath: join(home, 'constitution.md'),
    }))
    const activities = []
    for await (const activity of resumed.activity) activities.push(activity)
    assert.equal(spawns, 1)
    assert.deepEqual(activities, [])
    assert.deepEqual(await resumed.completion, { outcome: 'completed', finalText: 'Current final.' })
  } finally {
    Object.defineProperty(fs, 'readFile', readFileDescriptor)
    await provider.close(handle).catch(() => {})
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('Codex resume baseline timeout fails closed before PTY spawn', { timeout: 500 }, async () => {
  const home = join(tmpdir(), `unmute-agent-provider-${randomUUID()}`)
  const cwd = join(home, 'repo')
  await fs.mkdir(cwd, { recursive: true })
  let spawns = 0
  const observe = codexRolloutObserver({
    home,
    pollMs: 5,
    resumeBaselineTimeoutMs: 20,
  })
  const provider = new CodexCliProvider({
    processFactory: () => new ExecutorBackedAgentProcess({
      createExecutor: () => ({
        alive: true,
        async spawn() { spawns++ },
        async isReady() {},
        writeStdin() {},
        write() {},
        resize() {},
        onData() {},
        kill() {},
      }),
      observe,
    }),
    probeBinary: async () => true,
  })
  const handle = { provider: 'codex' as const, opaqueId: CODEX_ID }
  let failure: unknown

  try {
    await provider.resume(handle, input('resume-missing-baseline', {
      cwd,
      constitutionPath: join(home, 'constitution.md'),
    }))
  } catch (error) {
    failure = error
  } finally {
    await provider.close(handle).catch(() => {})
    await fs.rm(home, { recursive: true, force: true })
  }
  assert.equal(spawns, 0)
  assertProviderError(failure, 'provider-unavailable')
})

test('Codex observation follows a rollout archived during an active resumed turn', async () => {
  const home = join(tmpdir(), `unmute-agent-provider-${randomUUID()}`)
  const sessions = join(home, '.codex', 'sessions', '2026', '08', '17')
  const archived = join(home, '.codex', 'archived_sessions')
  const cwd = join(home, 'repo')
  await fs.mkdir(sessions, { recursive: true })
  await fs.mkdir(archived, { recursive: true })
  await fs.mkdir(cwd, { recursive: true })
  const live = join(sessions, `rollout-now-${CODEX_ID}.jsonl`)
  const moved = join(archived, `rollout-now-${CODEX_ID}.jsonl`)
  await fs.writeFile(live, rolloutLine('session_meta', {
    session_id: CODEX_ID,
    cwd,
    timestamp: new Date().toISOString(),
  }) + '\n')
  const seen: AgentProcessEvent[] = []
  const stop = await beginObservation(
    codexRolloutObserver({ home, pollMs: 5 }),
    codexLaunch(home, { kind: 'resume', id: CODEX_ID }),
    (event) => seen.push(event),
  )
  await fs.rename(live, moved)
  await fs.appendFile(moved, [
    rolloutLine('event_msg', { type: 'task_started' }),
    rolloutLine('event_msg', { type: 'task_complete', last_agent_message: 'Archived final.' }),
  ].join('\n') + '\n')

  await waitUntil(() => seen.some((event) => event.type === 'completion'), 'archived completion was observed')
  assert.deepEqual(seen, [
    { type: 'completion', outcome: 'completed', finalText: 'Archived final.' },
  ])
  stop?.()
  await fs.rm(home, { recursive: true, force: true })
})

test('Codex fresh observation re-resolves an archive move before its first successful rollout read', async () => {
  const home = join(tmpdir(), `unmute-agent-provider-${randomUUID()}`)
  const sessions = join(home, '.codex', 'sessions', '2026', '08', '17')
  const archived = join(home, '.codex', 'archived_sessions')
  const cwd = join(home, 'repo')
  const live = join(sessions, `rollout-now-${CODEX_ID}.jsonl`)
  const moved = join(archived, `rollout-now-${CODEX_ID}.jsonl`)
  await fs.mkdir(sessions, { recursive: true })
  await fs.mkdir(archived, { recursive: true })
  await fs.mkdir(cwd, { recursive: true })
  const seen: AgentProcessEvent[] = []
  const observation = await codexRolloutObserver({ home, pollMs: 5 })(
    codexLaunch(home, { kind: 'fresh' }),
    (event) => seen.push(event),
  )
  if (!observation || typeof observation === 'function') assert.fail('Codex observation lifecycle was not returned')
  await fs.writeFile(live, rolloutLine('session_meta', {
    session_id: CODEX_ID,
    cwd,
    timestamp: new Date().toISOString(),
  }) + '\n')

  const readFileDescriptor = Object.getOwnPropertyDescriptor(fs, 'readFile')
  if (!readFileDescriptor) assert.fail('fs.readFile descriptor was unavailable')
  const originalReadFile = fs.readFile
  let liveReads = 0
  Object.defineProperty(fs, 'readFile', {
    configurable: true,
    writable: true,
    value: async (...args: unknown[]) => {
      if (String(args[0]) === live && ++liveReads === 2) {
        await fs.rename(live, moved)
        await fs.appendFile(moved, [
          rolloutLine('event_msg', { type: 'task_started' }),
          rolloutLine('event_msg', { type: 'task_complete', last_agent_message: 'Fresh archived final.' }),
        ].join('\n') + '\n')
      }
      return Reflect.apply(originalReadFile, fs, args)
    },
  })

  try {
    observation.afterSpawn()
    await waitUntil(() => seen.some((event) => event.type === 'completion'), 'fresh cursor-zero archive completion was observed')
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
    assert.deepEqual(seen.filter((event) => event.type === 'handle'), [
      { type: 'handle', sessionId: CODEX_ID },
    ])
    assert.deepEqual(seen.filter((event) => event.type === 'completion'), [
      { type: 'completion', outcome: 'completed', finalText: 'Fresh archived final.' },
    ])
  } finally {
    Object.defineProperty(fs, 'readFile', readFileDescriptor)
    observation.stop()
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('Codex resume re-resolves an archive move when its pre-spawn baseline cursor is zero', async () => {
  const home = join(tmpdir(), `unmute-agent-provider-${randomUUID()}`)
  const sessions = join(home, '.codex', 'sessions', '2026', '08', '17')
  const archived = join(home, '.codex', 'archived_sessions')
  const cwd = join(home, 'repo')
  const live = join(sessions, `rollout-now-${CODEX_ID}.jsonl`)
  const moved = join(archived, `rollout-now-${CODEX_ID}.jsonl`)
  await fs.mkdir(sessions, { recursive: true })
  await fs.mkdir(archived, { recursive: true })
  await fs.mkdir(cwd, { recursive: true })
  await fs.writeFile(live, '')
  const seen: AgentProcessEvent[] = []
  const observation = await codexRolloutObserver({ home, pollMs: 5 })(
    codexLaunch(home, { kind: 'resume', id: CODEX_ID }),
    (event) => seen.push(event),
  )
  if (!observation || typeof observation === 'function') assert.fail('Codex observation lifecycle was not returned')
  await fs.rename(live, moved)
  await fs.appendFile(moved, [
    rolloutLine('session_meta', { session_id: CODEX_ID, cwd, timestamp: new Date().toISOString() }),
    rolloutLine('event_msg', { type: 'task_started' }),
    rolloutLine('event_msg', { type: 'task_complete', last_agent_message: 'Resume archived final.' }),
  ].join('\n') + '\n')

  try {
    observation.afterSpawn()
    await waitUntil(() => seen.some((event) => event.type === 'completion'), 'resume cursor-zero archive completion was observed')
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
    assert.deepEqual(seen, [
      { type: 'completion', outcome: 'completed', finalText: 'Resume archived final.' },
    ])
  } finally {
    observation.stop()
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('Codex serializes only fresh handle discovery so simultaneous same-cwd runs cannot cross-adopt', async () => {
  const home = join(tmpdir(), `unmute-agent-provider-${randomUUID()}`)
  const sessions = join(home, '.codex', 'sessions', '2026', '08', '17')
  const cwd = join(home, 'repo')
  const secondId = '44444444-4444-4444-8444-444444444444'
  await fs.mkdir(sessions, { recursive: true })
  await fs.mkdir(cwd, { recursive: true })
  const observe = codexRolloutObserver({ home, pollMs: 5 })
  const a: AgentProcessEvent[] = []
  const b: AgentProcessEvent[] = []
  const stopA = await beginObservation(observe, codexLaunch(home, { kind: 'fresh' }), (event) => a.push(event))
  let bReady = false
  const stopBPromise = beginObservation(observe, codexLaunch(home, { kind: 'fresh' }), (event) => b.push(event))
    .then((stop) => { bReady = true; return stop })
  await new Promise<void>((resolve) => setTimeout(resolve, 10))
  assert.equal(bReady, false, 'the second process must not spawn until the first rollout is claimed')

  await fs.writeFile(join(sessions, `rollout-a-${CODEX_ID}.jsonl`), rolloutLine('session_meta', {
    session_id: CODEX_ID,
    cwd,
    timestamp: new Date().toISOString(),
  }) + '\n')
  await waitUntil(() => a.some((event) => event.type === 'handle'), 'first handle was claimed')
  const stopB = await stopBPromise

  await fs.writeFile(join(sessions, `rollout-b-${secondId}.jsonl`), rolloutLine('session_meta', {
    session_id: secondId,
    cwd,
    timestamp: new Date().toISOString(),
  }) + '\n')
  await waitUntil(() => b.some((event) => event.type === 'handle'), 'second handle was claimed')
  assert.deepEqual(a.filter((event) => event.type === 'handle'), [{ type: 'handle', sessionId: CODEX_ID }])
  assert.deepEqual(b.filter((event) => event.type === 'handle'), [{ type: 'handle', sessionId: secondId }])
  stopA?.()
  stopB?.()
  await fs.rm(home, { recursive: true, force: true })
})

test('Codex fresh discovery ignores a recent same-cwd rollout present before its PTY spawn', async () => {
  const home = join(tmpdir(), `unmute-agent-provider-${randomUUID()}`)
  const sessions = join(home, '.codex', 'sessions', '2026', '08', '17')
  const cwd = join(home, 'repo')
  const foreignId = '55555555-5555-4555-8555-555555555555'
  const ownId = '66666666-6666-4666-8666-666666666666'
  const foreign = join(sessions, `rollout-foreign-${foreignId}.jsonl`)
  const own = join(sessions, `rollout-own-${ownId}.jsonl`)
  await fs.mkdir(sessions, { recursive: true })
  await fs.mkdir(cwd, { recursive: true })
  await fs.writeFile(foreign, rolloutLine('session_meta', {
    session_id: foreignId,
    cwd,
    timestamp: new Date().toISOString(),
  }) + '\n')

  const observe = codexRolloutObserver({ home, pollMs: 5 })
  const spawns: SpawnOpts[] = []
  const provider = new CodexCliProvider({
    processFactory: () => new ExecutorBackedAgentProcess({
      createExecutor: () => ({
        alive: true,
        async spawn(opts) {
          spawns.push(opts)
          if (!opts.resumeSessionId) {
            await fs.writeFile(own, rolloutLine('session_meta', {
              session_id: ownId,
              cwd,
              timestamp: new Date().toISOString(),
            }) + '\n')
          }
        },
        async isReady() {},
        writeStdin() {},
        write() {},
        resize() {},
        onData() {},
        kill() {},
      }),
      observe,
    }),
    probeBinary: async () => true,
    handleTimeoutMs: 500,
  })
  let handle: Awaited<ReturnType<typeof provider.start>>['handle'] | null = null

  try {
    const started = await provider.start(input('foreign-rollout', {
      cwd,
      constitutionPath: join(home, 'constitution.md'),
    }))
    handle = started.handle
    assert.equal(started.handle.opaqueId, ownId)

    await fs.appendFile(own, [
      rolloutLine('event_msg', { type: 'task_started' }),
      rolloutLine('event_msg', { type: 'task_complete', last_agent_message: 'Own final.' }),
    ].join('\n') + '\n')
    assert.equal((await started.completion).finalText, 'Own final.')

    const resumed = await provider.resume(started.handle, input('foreign-rollout-resume', {
      cwd,
      constitutionPath: join(home, 'constitution.md'),
    }))
    handle = resumed.handle
    assert.equal(spawns.at(-1)?.resumeSessionId, ownId)
    assert.ok(!spawns.some((spawn) => spawn.resumeSessionId === foreignId))
  } finally {
    if (handle) await provider.close(handle).catch(() => {})
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('Codex same-path growth during resume setup cannot publish historical activity or completion', { timeout: 3_000 }, async () => {
  const home = join(tmpdir(), `unmute-agent-provider-${randomUUID()}`)
  const sessions = join(home, '.codex', 'sessions', '2026', '08', '17')
  const cwd = join(home, 'repo')
  const rollout = join(sessions, `rollout-now-${CODEX_ID}.jsonl`)
  await fs.mkdir(sessions, { recursive: true })
  await fs.mkdir(cwd, { recursive: true })
  await fs.writeFile(rollout, [
    rolloutLine('session_meta', { session_id: CODEX_ID, cwd, timestamp: new Date().toISOString() }),
    rolloutLine('event_msg', { type: 'task_started' }),
  ].join('\n') + '\n')

  const oldTail = [
    rolloutLine('event_msg', { type: 'exec_command_end' }),
    rolloutLine('event_msg', { type: 'task_complete', last_agent_message: 'Historical final.' }),
  ].join('\n') + '\n'
  const currentTail = [
    rolloutLine('event_msg', { type: 'task_started' }),
    rolloutLine('event_msg', { type: 'task_complete', last_agent_message: 'Current final.' }),
  ].join('\n') + '\n'
  const readDescriptor = Object.getOwnPropertyDescriptor(fs, 'readFile')
  if (!readDescriptor) assert.fail('fs.readFile descriptor was unavailable')
  const originalRead = fs.readFile
  let historicalTailWritten = false
  Object.defineProperty(fs, 'readFile', {
    configurable: true,
    writable: true,
    value: async (...args: unknown[]) => {
      const text = await Reflect.apply(originalRead, fs, args)
      if (String(args[0]) === rollout && !historicalTailWritten) {
        await fs.appendFile(rollout, oldTail)
        historicalTailWritten = true
      }
      return text
    },
  })

  let currentWrite: Promise<void> | null = null
  const observe = codexRolloutObserver({ home, pollMs: 5 })
  const provider = new CodexCliProvider({
    processFactory: () => new ExecutorBackedAgentProcess({
      createExecutor: () => ({
        alive: true,
        async spawn() {},
        async isReady() {},
        writeStdin() { currentWrite = fs.appendFile(rollout, currentTail) },
        write() {},
        resize() {},
        onData() {},
        kill() {},
      }),
      observe,
    }),
    probeBinary: async () => true,
  })
  const handle = { provider: 'codex' as const, opaqueId: CODEX_ID }

  try {
    const resumed = await provider.resume(handle, input('same-path-growth', {
      cwd,
      constitutionPath: join(home, 'constitution.md'),
    }))
    if (currentWrite) await currentWrite
    const activitiesPromise = (async () => {
      const activities = []
      for await (const activity of resumed.activity) activities.push(activity)
      return activities
    })()
    assert.equal(historicalTailWritten, true)
    assert.deepEqual(await completionWithin(resumed.completion), {
      outcome: 'completed',
      finalText: 'Current final.',
    })
    assert.deepEqual(await activitiesPromise, [])
  } finally {
    Object.defineProperty(fs, 'readFile', readDescriptor)
    await provider.close(handle).catch(() => {})
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('Codex reconciles divergent exact-ID live and archive candidates around the current writer', { timeout: 3_000 }, async () => {
  const home = join(tmpdir(), `unmute-agent-provider-${randomUUID()}`)
  const sessions = join(home, '.codex', 'sessions', '2026', '08', '17')
  const archived = join(home, '.codex', 'archived_sessions')
  const cwd = join(home, 'repo')
  const live = join(sessions, `rollout-live-${CODEX_ID}.jsonl`)
  const archive = join(archived, `rollout-archive-${CODEX_ID}.jsonl`)
  await fs.mkdir(sessions, { recursive: true })
  await fs.mkdir(archived, { recursive: true })
  await fs.mkdir(cwd, { recursive: true })
  const metaLine = rolloutLine('session_meta', { session_id: CODEX_ID, cwd, timestamp: new Date().toISOString() })
  await fs.writeFile(live, metaLine + '\n')
  await fs.writeFile(archive, [
    metaLine,
    rolloutLine('event_msg', { type: 'task_started' }),
    rolloutLine('event_msg', { type: 'task_complete', last_agent_message: 'Archived historical final.' }),
  ].join('\n') + '\n')
  const past = new Date(Date.now() - 60_000)
  const future = new Date(Date.now() + 60_000)
  await fs.utimes(live, past, past)
  await fs.utimes(archive, future, future)

  const currentTail = [
    rolloutLine('event_msg', { type: 'task_started' }),
    rolloutLine('event_msg', { type: 'task_complete', last_agent_message: 'Live current final.' }),
  ].join('\n') + '\n'
  let currentWrite: Promise<void> | null = null
  const provider = new CodexCliProvider({
    processFactory: () => new ExecutorBackedAgentProcess({
      createExecutor: () => ({
        alive: true,
        async spawn() {},
        async isReady() {},
        writeStdin() { currentWrite = fs.appendFile(live, currentTail) },
        write() {},
        resize() {},
        onData() {},
        kill() {},
      }),
      observe: codexRolloutObserver({ home, pollMs: 5 }),
    }),
    probeBinary: async () => true,
  })
  const handle = { provider: 'codex' as const, opaqueId: CODEX_ID }

  try {
    const resumed = await provider.resume(handle, input('duplicate-exact-id', {
      cwd,
      constitutionPath: join(home, 'constitution.md'),
    }))
    if (currentWrite) await currentWrite
    assert.deepEqual(await completionWithin(resumed.completion), {
      outcome: 'completed',
      finalText: 'Live current final.',
    })
  } finally {
    await provider.close(handle).catch(() => {})
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('Codex relocation to a shorter exact-ID copy never regresses and replays an old completion', { timeout: 3_000 }, async () => {
  const home = join(tmpdir(), `unmute-agent-provider-${randomUUID()}`)
  const sessions = join(home, '.codex', 'sessions', '2026', '08', '17')
  const archived = join(home, '.codex', 'archived_sessions')
  const cwd = join(home, 'repo')
  const live = join(sessions, `rollout-live-${CODEX_ID}.jsonl`)
  const shorter = join(archived, `rollout-short-${CODEX_ID}.jsonl`)
  await fs.mkdir(sessions, { recursive: true })
  await fs.mkdir(archived, { recursive: true })
  await fs.mkdir(cwd, { recursive: true })
  const metaLine = rolloutLine('session_meta', { session_id: CODEX_ID, cwd, timestamp: new Date().toISOString() })
  const oldStart = rolloutLine('event_msg', { type: 'task_started' })
  const oldTool = rolloutLine('event_msg', { type: 'exec_command_end' })
  const oldCompletion = rolloutLine('event_msg', { type: 'task_complete', last_agent_message: 'Old replayed final.' })
  await fs.writeFile(live, [metaLine, oldStart, oldTool, oldCompletion].join('\n') + '\n')

  const currentStart = rolloutLine('event_msg', { type: 'task_started' })
  const currentCompletion = rolloutLine('event_msg', { type: 'task_complete', last_agent_message: 'Short-copy current final.' })
  let relocation: Promise<void> | null = null
  const provider = new CodexCliProvider({
    processFactory: () => new ExecutorBackedAgentProcess({
      createExecutor: () => ({
        alive: true,
        async spawn() {},
        async isReady() {},
        writeStdin() {
          relocation = (async () => {
            await fs.rm(live)
            await fs.writeFile(shorter, [oldCompletion, currentStart, currentCompletion].join('\n') + '\n')
          })()
        },
        write() {},
        resize() {},
        onData() {},
        kill() {},
      }),
      observe: codexRolloutObserver({ home, pollMs: 5 }),
    }),
    probeBinary: async () => true,
  })
  const handle = { provider: 'codex' as const, opaqueId: CODEX_ID }

  try {
    const resumed = await provider.resume(handle, input('shorter-copy', {
      cwd,
      constitutionPath: join(home, 'constitution.md'),
    }))
    if (relocation) await relocation
    assert.deepEqual(await completionWithin(resumed.completion), {
      outcome: 'completed',
      finalText: 'Short-copy current final.',
    })
  } finally {
    await provider.close(handle).catch(() => {})
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('Codex resume setup hard-times-out a hung history read before spawning', { timeout: 1_000 }, async () => {
  const home = join(tmpdir(), `unmute-agent-provider-${randomUUID()}`)
  const sessions = join(home, '.codex', 'sessions', '2026', '08', '17')
  const cwd = join(home, 'repo')
  const rollout = join(sessions, `rollout-now-${CODEX_ID}.jsonl`)
  await fs.mkdir(sessions, { recursive: true })
  await fs.mkdir(cwd, { recursive: true })
  await fs.writeFile(rollout, rolloutLine('session_meta', {
    session_id: CODEX_ID,
    cwd,
    timestamp: new Date().toISOString(),
  }) + '\n')

  const readDescriptor = Object.getOwnPropertyDescriptor(fs, 'readFile')
  if (!readDescriptor) assert.fail('fs.readFile descriptor was unavailable')
  const originalRead = fs.readFile
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  Object.defineProperty(fs, 'readFile', {
    configurable: true,
    writable: true,
    value: async (...args: unknown[]) => {
      if (String(args[0]) === rollout) await gate
      return Reflect.apply(originalRead, fs, args)
    },
  })

  let spawns = 0
  const provider = new CodexCliProvider({
    processFactory: () => new ExecutorBackedAgentProcess({
      createExecutor: () => ({
        alive: true,
        async spawn() { spawns++ },
        async isReady() {},
        writeStdin() {},
        write() {},
        resize() {},
        onData() {},
        kill() {},
      }),
      observe: codexRolloutObserver({ home, pollMs: 5, resumeBaselineTimeoutMs: 20 }),
    }),
    probeBinary: async () => true,
  })
  const handle = { provider: 'codex' as const, opaqueId: CODEX_ID }
  const attempt = provider.resume(handle, input('hung-history', {
    cwd,
    constitutionPath: join(home, 'constitution.md'),
  }))

  try {
    const result = await Promise.race([
      attempt.then(() => 'resolved', () => 'rejected'),
      new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 100)),
    ])
    assert.equal(result, 'rejected')
    assert.equal(spawns, 0)
  } finally {
    release()
    await attempt.catch(() => null)
    Object.defineProperty(fs, 'readFile', readDescriptor)
    await provider.close(handle).catch(() => {})
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('Codex resume treats rollout EIO as fatal before spawn or prompt submission', async () => {
  const home = join(tmpdir(), `unmute-agent-provider-${randomUUID()}`)
  const sessions = join(home, '.codex', 'sessions', '2026', '08', '17')
  const cwd = join(home, 'repo')
  const rollout = join(sessions, `rollout-now-${CODEX_ID}.jsonl`)
  await fs.mkdir(sessions, { recursive: true })
  await fs.mkdir(cwd, { recursive: true })
  await fs.writeFile(rollout, rolloutLine('session_meta', {
    session_id: CODEX_ID,
    cwd,
    timestamp: new Date().toISOString(),
  }) + '\n')

  const readDescriptor = Object.getOwnPropertyDescriptor(fs, 'readFile')
  if (!readDescriptor) assert.fail('fs.readFile descriptor was unavailable')
  const originalRead = fs.readFile
  Object.defineProperty(fs, 'readFile', {
    configurable: true,
    writable: true,
    value: async (...args: unknown[]) => {
      if (String(args[0]) === rollout) {
        const failure = new Error(`${TOKEN} /Users/alice/private.txt`) as NodeJS.ErrnoException
        failure.code = 'EIO'
        throw failure
      }
      return Reflect.apply(originalRead, fs, args)
    },
  })

  let spawns = 0
  let writes = 0
  let kills = 0
  const provider = new CodexCliProvider({
    processFactory: () => new ExecutorBackedAgentProcess({
      createExecutor: () => ({
        alive: true,
        async spawn() { spawns++ },
        async isReady() {},
        writeStdin() { writes++ },
        write() {},
        resize() {},
        onData() {},
        kill() { kills++ },
      }),
      observe: codexRolloutObserver({ home, pollMs: 5 }),
    }),
    probeBinary: async () => true,
  })
  const handle = { provider: 'codex' as const, opaqueId: CODEX_ID }

  try {
    await assert.rejects(provider.resume(handle, input('rollout-eio', {
      cwd,
      constitutionPath: join(home, 'constitution.md'),
    })), (error) => {
      assertProviderError(error, 'provider-unavailable')
      assert.doesNotMatch(String(error), new RegExp(`${TOKEN}|Users/alice`))
      return true
    })
    assert.deepEqual({ spawns, writes, kills }, { spawns: 0, writes: 0, kills: 1 })
  } finally {
    Object.defineProperty(fs, 'readFile', readDescriptor)
    await provider.close(handle).catch(() => {})
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('a failing pre-submit observation boundary prevents the prompt and cleans its PTY', async () => {
  let spawns = 0
  let writes = 0
  let kills = 0
  let stops = 0
  const provider = new CodexCliProvider({
    processFactory: () => new ExecutorBackedAgentProcess({
      createExecutor: () => ({
        alive: true,
        async spawn() { spawns++ },
        async isReady() {},
        writeStdin() { writes++ },
        write() {},
        resize() {},
        onData() {},
        kill() { kills++ },
      }),
      observe: () => ({
        afterSpawn() {},
        async beforeSubmit() { throw new Error(`EIO ${TOKEN} /Users/alice/private.txt`) },
        stop() { stops++ },
      }),
    }),
    probeBinary: async () => true,
  })
  const handle = { provider: 'codex' as const, opaqueId: CODEX_ID }

  await assert.rejects(provider.resume(handle, input('pre-submit-failure')), (error) => {
    assertProviderError(error, 'provider-unavailable')
    assert.doesNotMatch(String(error), new RegExp(`${TOKEN}|Users/alice`))
    return true
  })
  assert.deepEqual({ spawns, writes, kills, stops }, { spawns: 1, writes: 0, kills: 1, stops: 1 })
})
