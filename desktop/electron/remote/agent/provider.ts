import { execFile } from 'node:child_process'
import type { AgentExecutor, SpawnOpts } from '../executor'

export type AgentProviderId = 'claude' | 'codex'

/** Serializable, provider-owned identity. Consumers must not interpret opaqueId. */
export interface AgentSessionHandle {
  readonly provider: AgentProviderId
  readonly opaqueId: string
}

export interface ProviderProbe {
  provider: AgentProviderId
  available: boolean
  reason?: 'not-installed'
}

export interface AgentMcpContext {
  endpoint: string
  config: string
  token: string
}

export interface AgentStartInput {
  runId: string
  interactionId: string
  cwd: string
  transcript: string
  /** A generated file shared by every provider and consumed as system context. */
  constitutionPath: string
  environment: NodeJS.ProcessEnv
  mcp: AgentMcpContext
}

export type AgentActivityKind = 'progress' | 'tool' | 'message' | 'waiting'

export interface AgentActivity {
  sequence: number
  kind: AgentActivityKind
  summary: string
}

export interface AgentCompletion {
  outcome: 'completed' | 'interrupted' | 'failed'
  finalText?: string
}

export interface AgentSession {
  readonly handle: AgentSessionHandle
  readonly activity: AsyncIterable<AgentActivity>
  readonly completion: Promise<AgentCompletion>
}

export interface AgentProvider {
  readonly id: AgentProviderId
  probe(): Promise<ProviderProbe>
  start(input: AgentStartInput): Promise<AgentSession>
  resume(handle: AgentSessionHandle, input: AgentStartInput): Promise<AgentSession>
  interrupt(handle: AgentSessionHandle): Promise<void>
  close(handle: AgentSessionHandle): Promise<void>
}

export type AgentProviderErrorCode =
  | 'invalid-handle'
  | 'provider-handle-missing'
  | 'session-active'
  | 'session-closed'
  | 'session-not-active'
  | 'provider-unavailable'

/** Public errors are deliberately typed and path/driver-message free. */
export class AgentProviderError extends Error {
  constructor(readonly code: AgentProviderErrorCode) {
    super(publicErrorMessage(code))
    this.name = 'AgentProviderError'
  }
}

function publicErrorMessage(code: AgentProviderErrorCode): string {
  switch (code) {
    case 'invalid-handle': return 'The Agent session handle is invalid.'
    case 'provider-handle-missing': return 'The provider did not establish a resumable session.'
    case 'session-active': return 'That Agent session already has an active turn.'
    case 'session-closed': return 'That Agent session is closed.'
    case 'session-not-active': return 'That Agent session has no active turn.'
    case 'provider-unavailable': return 'The selected Agent provider is unavailable.'
  }
}

export type AgentProcessEvent =
  | { type: 'handle'; sessionId: string }
  | { type: 'activity'; kind: AgentActivityKind; summary: string }
  | { type: 'completion'; outcome: AgentCompletion['outcome']; finalText?: string }
  | { type: 'observer-failure' }
  | { type: 'terminal-output'; chunk: string }
  | { type: 'exit'; exitCode: number }

export interface AgentProcessLaunch {
  provider: AgentProviderId
  binary: string
  argv: string[]
  cwd: string
  taskId: string
  environment: NodeJS.ProcessEnv
  systemContext: { type: 'file'; path: string }
  session: { kind: 'fresh' | 'resume'; id?: string }
}

/**
 * Process ownership boundary used by both real owned-PTY drivers and contract
 * fakes. Only structured observer events can complete a turn; terminal output
 * is intentionally a separate, non-authoritative event.
 */
export interface AgentProcessDriver {
  readonly events: AsyncIterable<AgentProcessEvent>
  start(launch: AgentProcessLaunch): Promise<void>
  submitUserTurn(text: string): Promise<void>
  interrupt(): Promise<void>
  close(): Promise<void>
}

export type AgentProcessFactory = () => AgentProcessDriver
export type ProbeBinary = (binary: string) => Promise<boolean>

const SAFE_ENV = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'COLORTERM',
])

export function buildAgentEnvironment(input: AgentStartInput): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(input.environment)) {
    if (SAFE_ENV.has(key) && typeof value === 'string') environment[key] = value
  }
  environment.UNMUTE_MCP_TOKEN = input.mcp.token
  environment.UNMUTE_MCP_ENDPOINT = input.mcp.endpoint
  environment.UNMUTE_MCP_URL = input.mcp.endpoint
  environment.UNMUTE_MCP_CONFIG = input.mcp.config
  return environment
}

export function probeCli(binary: string, environment: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(environment)) {
    if (SAFE_ENV.has(key) && typeof value === 'string') env[key] = value
  }
  return new Promise((resolve) => {
    execFile(binary, ['--version'], { env, timeout: 5_000 }, (error) => resolve(!error))
  })
}

class ActivityQueue implements AsyncIterable<AgentActivity> {
  private readonly queued: AgentActivity[] = []
  private readonly waiting: Array<(value: IteratorResult<AgentActivity>) => void> = []
  private ended = false

  emit(value: AgentActivity): void {
    if (this.ended) return
    const waiter = this.waiting.shift()
    if (waiter) waiter({ done: false, value })
    else this.queued.push(value)
  }

  end(): void {
    if (this.ended) return
    this.ended = true
    for (const waiter of this.waiting.splice(0)) waiter({ done: true, value: undefined })
  }

  [Symbol.asyncIterator](): AsyncIterator<AgentActivity> {
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

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

interface LiveSession {
  handle: AgentSessionHandle | null
  driver: AgentProcessDriver
  input: AgentStartInput
  activity: ActivityQueue
  completion: Deferred<AgentCompletion>
  learnedHandle: Deferred<AgentSessionHandle>
  sequence: number
  settled: boolean
  closed: boolean
}

export interface CliProviderRuntimeOptions {
  id: AgentProviderId
  binary: string
  processFactory: AgentProcessFactory
  probeBinary: ProbeBinary
  freshHandle?: () => string
  argv(session: AgentProcessLaunch['session']): string[]
  learnsFreshHandle: boolean
  handleTimeoutMs?: number
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** Shared state machine; adapters own only argv, executable, and handle source. */
export class CliProviderRuntime implements AgentProvider {
  readonly id: AgentProviderId
  private readonly active = new Map<string, LiveSession>()
  private readonly closed = new Set<string>()

  constructor(private readonly options: CliProviderRuntimeOptions) {
    this.id = options.id
  }

  async probe(): Promise<ProviderProbe> {
    let available = false
    try { available = await this.options.probeBinary(this.options.binary) } catch { /* boolean boundary */ }
    return available
      ? { provider: this.id, available: true }
      : { provider: this.id, available: false, reason: 'not-installed' }
  }

  async start(input: AgentStartInput): Promise<AgentSession> {
    const pinned = this.options.learnsFreshHandle ? undefined : this.options.freshHandle?.()
    if (!this.options.learnsFreshHandle && !validSessionId(pinned)) {
      throw new AgentProviderError('provider-handle-missing')
    }
    return this.startTurn(input, pinned
      ? { provider: this.id, opaqueId: pinned }
      : null, 'fresh')
  }

  async resume(handle: AgentSessionHandle, input: AgentStartInput): Promise<AgentSession> {
    const key = this.handleKey(handle)
    if (this.closed.has(key)) throw new AgentProviderError('session-closed')
    const current = this.active.get(key)
    if (current && !current.settled) throw new AgentProviderError('session-active')
    if (current) {
      await this.closeDriver(current)
      this.active.delete(key)
    }
    return this.startTurn(input, { provider: this.id, opaqueId: handle.opaqueId }, 'resume')
  }

  async interrupt(handle: AgentSessionHandle): Promise<void> {
    const key = this.handleKey(handle)
    if (this.closed.has(key)) throw new AgentProviderError('session-closed')
    const current = this.active.get(key)
    if (!current || current.settled) throw new AgentProviderError('session-not-active')
    await current.driver.interrupt().catch(() => {
      throw new AgentProviderError('provider-unavailable')
    })
  }

  async close(handle: AgentSessionHandle): Promise<void> {
    const key = this.handleKey(handle)
    if (this.closed.has(key)) return
    const current = this.active.get(key)
    if (!current) throw new AgentProviderError('invalid-handle')
    this.closed.add(key)
    await this.closeDriver(current)
    this.active.delete(key)
    if (!current.settled) this.settle(current, { outcome: 'failed' })
  }

  private async startTurn(
    input: AgentStartInput,
    handle: AgentSessionHandle | null,
    mode: AgentProcessLaunch['session']['kind'],
  ): Promise<AgentSession> {
    const driver = this.options.processFactory()
    const activity = new ActivityQueue()
    const live: LiveSession = {
      handle,
      driver,
      input,
      activity,
      completion: deferred<AgentCompletion>(),
      learnedHandle: deferred<AgentSessionHandle>(),
      sequence: 0,
      settled: false,
      closed: false,
    }
    if (handle) live.learnedHandle.resolve(handle)

    const sessionShape: AgentProcessLaunch['session'] = handle
      ? { kind: mode, id: handle.opaqueId }
      : { kind: 'fresh' }
    const launch: AgentProcessLaunch = {
      provider: this.id,
      binary: this.options.binary,
      argv: this.options.argv(sessionShape),
      cwd: input.cwd,
      taskId: input.runId,
      environment: buildAgentEnvironment(input),
      systemContext: { type: 'file', path: input.constitutionPath },
      session: sessionShape,
    }

    try {
      await driver.start(launch)
    } catch {
      await this.closeDriver(live)
      throw new AgentProviderError('provider-unavailable')
    }
    void this.consume(live)

    let learned: AgentSessionHandle
    try {
      learned = await withTimeout(
        live.learnedHandle.promise,
        this.options.handleTimeoutMs ?? 8_000,
      )
    } catch {
      await this.closeDriver(live)
      throw new AgentProviderError('provider-handle-missing')
    }
    const key = this.key(learned)
    if (this.closed.has(key) || this.active.has(key)) {
      await this.closeDriver(live)
      throw new AgentProviderError('session-active')
    }
    this.active.set(key, live)

    try {
      await driver.submitUserTurn(input.transcript)
    } catch {
      this.active.delete(key)
      await this.closeDriver(live)
      throw new AgentProviderError('provider-unavailable')
    }
    return { handle: learned, activity, completion: live.completion.promise }
  }

  private async consume(live: LiveSession): Promise<void> {
    try {
      for await (const event of live.driver.events) {
        if (live.closed) break
        if (event.type === 'terminal-output') continue
        if (event.type === 'handle') {
          if (!validSessionId(event.sessionId)) {
            if (!live.handle) {
              live.learnedHandle.reject(new AgentProviderError('provider-handle-missing'))
              await this.closeDriver(live)
            } else {
              await this.failAndClose(live)
            }
            break
          }
          if (!live.handle) {
            live.handle = { provider: this.id, opaqueId: event.sessionId }
            live.learnedHandle.resolve(live.handle)
          } else if (live.handle.opaqueId !== event.sessionId) {
            await this.failAndClose(live)
            break
          }
          continue
        }
        if (event.type === 'activity') {
          if (!live.settled) {
            live.activity.emit({
              sequence: ++live.sequence,
              kind: event.kind,
              summary: redact(event.summary, live.input),
            })
          }
          continue
        }
        if (event.type === 'completion') {
          if (!live.handle) {
            live.learnedHandle.reject(new AgentProviderError('provider-handle-missing'))
            await this.closeDriver(live)
          } else {
            this.settle(live, {
              outcome: event.outcome,
              ...(event.finalText ? { finalText: redact(event.finalText, live.input) } : {}),
            })
          }
          continue
        }
        if (event.type === 'observer-failure') {
          if (!live.handle) {
            live.learnedHandle.reject(new AgentProviderError('provider-handle-missing'))
            await this.closeDriver(live)
          } else {
            await this.failAndClose(live)
          }
          break
        }
        if (event.type === 'exit') {
          if (!live.handle) {
            live.learnedHandle.reject(new AgentProviderError('provider-handle-missing'))
            await this.closeDriver(live)
          } else if (!live.settled) {
            await this.failAndClose(live)
          }
          break
        }
      }
      if (!live.closed && live.handle && !live.settled) await this.failAndClose(live)
    } catch {
      if (!live.handle) {
        live.learnedHandle.reject(new AgentProviderError('provider-handle-missing'))
        await this.closeDriver(live)
      } else {
        await this.failAndClose(live)
      }
    }
  }

  private async failAndClose(live: LiveSession): Promise<void> {
    await this.closeDriver(live)
    this.settle(live, { outcome: 'failed' })
  }

  private settle(live: LiveSession, result: AgentCompletion): void {
    if (live.settled) return
    live.settled = true
    live.activity.end()
    live.completion.resolve(result)
  }

  private async closeDriver(live: LiveSession): Promise<void> {
    if (live.closed) return
    live.closed = true
    try { await live.driver.close() } catch { /* close remains idempotent */ }
  }

  private handleKey(handle: AgentSessionHandle): string {
    if (handle.provider !== this.id || !validSessionId(handle.opaqueId)) {
      throw new AgentProviderError('invalid-handle')
    }
    return this.key(handle)
  }

  private key(handle: AgentSessionHandle): string {
    return `${handle.provider}:${handle.opaqueId}`
  }
}

function validSessionId(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value)
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new AgentProviderError('provider-handle-missing')), timeoutMs)
    void promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) },
    )
  })
}

function redact(value: string, input: AgentStartInput): string {
  let out = value
  for (const secret of [input.mcp.token, input.constitutionPath, input.cwd]) {
    if (secret) out = out.split(secret).join('[redacted]')
  }
  return out
    .replace(/(^|[\s("'`])\/(?!\/)[^\s,;:)\]}"'`]+/g, '$1[path]')
    .replace(/[A-Za-z]:\\[^\s,;:)\]}"']+/g, '[path]')
}

export interface ProviderObservation {
  /** Starts live polling only after the addressed PTY has been spawned. */
  afterSpawn(): void | Promise<void>
  /** Establishes the current-turn boundary after readiness, immediately before input. */
  beforeSubmit?(): void | Promise<void>
  stop(): void
}

export type ProviderEventObserver = (
  launch: AgentProcessLaunch,
  emit: (event: AgentProcessEvent) => void,
) => void | (() => void) | ProviderObservation | Promise<void | (() => void) | ProviderObservation>

interface ExecutorBackedDriverOptions {
  createExecutor(launch: AgentProcessLaunch): AgentExecutor | Promise<AgentExecutor>
  observe?: ProviderEventObserver
}

type ObservableAgentExecutor = AgentExecutor & {
  onExit?(cb: (event: { exitCode: number }) => void): void
  interrupt?(): void
}

class DriverEventQueue implements AsyncIterable<AgentProcessEvent> {
  private readonly values: AgentProcessEvent[] = []
  private readonly waiters: Array<(value: IteratorResult<AgentProcessEvent>) => void> = []
  private ended = false

  emit = (event: AgentProcessEvent): void => {
    if (this.ended) return
    const waiter = this.waiters.shift()
    if (waiter) waiter({ done: false, value: event })
    else this.values.push(event)
  }

  end(): void {
    if (this.ended) return
    this.ended = true
    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined })
  }

  [Symbol.asyncIterator](): AsyncIterator<AgentProcessEvent> {
    return {
      next: async () => {
        const value = this.values.shift()
        if (value) return { done: false, value }
        if (this.ended) return { done: true, value: undefined }
        return new Promise((resolve) => this.waiters.push(resolve))
      },
    }
  }
}

/** Real driver adapter: one existing executor instance owns exactly one PTY. */
export class ExecutorBackedAgentProcess implements AgentProcessDriver {
  private readonly queue = new DriverEventQueue()
  readonly events: AsyncIterable<AgentProcessEvent> = this.queue
  private executor: ObservableAgentExecutor | null = null
  private observation: ProviderObservation | null = null
  private stopObserving: (() => void) | null = null
  private observationArmed = false
  private closed = false

  constructor(private readonly options: ExecutorBackedDriverOptions) {}

  async start(launch: AgentProcessLaunch): Promise<void> {
    const executor = await this.options.createExecutor(launch) as ObservableAgentExecutor
    this.executor = executor
    executor.onData((chunk) => this.queue.emit({ type: 'terminal-output', chunk }))
    executor.onExit?.(({ exitCode }) => this.queue.emit({ type: 'exit', exitCode }))
    const emitObserved = (event: AgentProcessEvent) => {
      const turnEvent = event.type === 'activity'
        || event.type === 'completion'
        || event.type === 'observer-failure'
      if (!turnEvent || this.observationArmed) this.queue.emit(event)
    }
    const observation = await this.options.observe?.(launch, emitObserved)
    this.observation = observation && typeof observation !== 'function' ? observation : null
    this.stopObserving = typeof observation === 'function'
      ? observation
      : observation?.stop.bind(observation) ?? null
    const spawn: SpawnOpts = {
      cwd: launch.cwd,
      env: launch.environment,
      taskId: launch.taskId,
      ...(launch.session.kind === 'fresh' && launch.session.id ? { sessionId: launch.session.id } : {}),
      ...(launch.session.kind === 'resume' && launch.session.id ? { resumeSessionId: launch.session.id } : {}),
    }
    await executor.spawn(spawn)
    if (observation && typeof observation !== 'function') await observation.afterSpawn()
  }

  async submitUserTurn(text: string): Promise<void> {
    if (!this.executor) throw new Error('not started')
    await this.executor.isReady()
    await this.observation?.beforeSubmit?.()
    if (this.closed) throw new Error('closed')
    this.observationArmed = true
    this.executor.writeStdin(text)
  }

  async interrupt(): Promise<void> {
    if (!this.executor?.alive) return
    if (this.executor.interrupt) this.executor.interrupt()
    else this.executor.write('\x03')
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    try { this.stopObserving?.() } catch { /* observer cleanup cannot leak the PTY */ }
    try { this.executor?.kill() } catch { /* process may already have exited */ }
    this.queue.end()
  }
}
