import { randomUUID } from 'node:crypto'

import {
  type AgentActivity,
  type AgentCompletion,
  type AgentMcpContext,
  type AgentProvider,
  type AgentProviderId,
  AgentProviderError,
  type AgentSession,
  type AgentSessionHandle,
  type AgentStartInput,
} from './provider'
import {
  type AgentExchangeSummary,
  AgentJournalError,
  type AgentJournalSnapshot,
  type AgentJournalStore,
  type AgentRunState,
  type AppendExchangeInput,
  type JournalAgentRun,
} from './journal'

const DEFAULT_IDLE_MS = 15 * 60 * 1_000
const DEFAULT_SWEEP_MS = 60_000
const DEFAULT_TOKEN_TTL_MS = 30 * 60 * 1_000
const DEFAULT_MAX_PROCESSES = 2
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

export type AgentRun = JournalAgentRun

export interface AgentRunTokenStore {
  mint(runId: string, interactionId: string, provider: AgentProviderId, ttlMs: number): string
  closeRun(runId: string): void
  sweep(): void
}

export interface AgentRunMcpContext extends Omit<AgentMcpContext, 'token'> {
  /** Ignored and replaced if a caller passes a token-shaped compatible object. */
  token?: string
}

export interface AgentRunInput extends Omit<AgentStartInput, 'runId' | 'mcp'> {
  runId?: string
  provider?: AgentProviderId
  mcp: AgentRunMcpContext
  tokenTtlMs?: number
}

export type AgentResumeInput = Omit<AgentRunInput, 'runId' | 'provider'>

export interface SupervisedAgentSession extends AgentSession {
  readonly runId: string
  readonly provider: AgentProviderId
  /** Snapshot at the point the provider accepted the turn. */
  readonly run: AgentRun
  readonly completion: Promise<SupervisedAgentCompletion>
}

export type AgentTurnFailureCode =
  | 'provider-crashed'
  | 'interaction-expired'
  | 'journal-unavailable'
  | 'shutdown'

export interface SupervisedAgentCompletion extends AgentCompletion {
  /** Stable, path-free recovery reason; present only for failed turns. */
  errorCode?: AgentTurnFailureCode
}

export interface SupervisorCounts {
  logicalRuns: number
  activeProcesses: number
}

export type AgentSupervisorErrorCode =
  | 'resource-pressure'
  | 'run-not-found'
  | 'run-busy'
  | 'run-closed'
  | 'invalid-request'
  | 'provider-unavailable'
  | 'journal-unavailable'

/** Public lifecycle failures are typed and never interpolate paths or secrets. */
export class AgentSupervisorError extends Error {
  constructor(readonly code: AgentSupervisorErrorCode) {
    super(supervisorErrorMessage(code))
    this.name = 'AgentSupervisorError'
  }
}

export interface AgentSupervisorTimers {
  setInterval(callback: () => void, milliseconds: number): unknown
  clearInterval(handle: unknown): void
}

export interface AgentRunSupervisorOptions {
  providers: ReadonlyMap<AgentProviderId, AgentProvider> | Partial<Record<AgentProviderId, AgentProvider>>
  tokenStore: AgentRunTokenStore
  journal: AgentJournalStore
  now?: () => number
  randomId?: () => string
  selectedProvider?: () => AgentProviderId
  maxActiveProcesses?: number
  idleMs?: number
  tokenTtlMs?: number
  sweepIntervalMs?: number
  timers?: AgentSupervisorTimers
  /**
   * WHERE A CRASH GETS TO SAY WHY.
   *
   * This package is deliberately dependency-free so it can be tested without
   * Electron, which is why it had no logger — and why `provider-crashed` was
   * reported to the user with the cause thrown away by a bare `catch`. Two
   * identical failures in the field produced no exit code, no stderr and no
   * message anywhere. Injected rather than imported, like every other seam here.
   */
  log?: (event: string, data: Record<string, unknown>) => void
}

interface LiveTurn {
  session: AgentSession
  activity: ActivityRelay
  released: boolean
  tokenExpiresAt: number
  journalFailed: boolean
  releaseCode?: AgentTurnFailureCode
}

/**
 * Owns logical Agent runs independently from provider process lifetimes. Every
 * start reserves capacity immediately, while resume always uses the persisted
 * provider and exact opaque handle.
 */
export class AgentRunSupervisor {
  private readonly providers: ReadonlyMap<AgentProviderId, AgentProvider>
  private readonly now: () => number
  private readonly randomId: () => string
  private readonly selectedProvider: () => AgentProviderId
  private readonly maxActiveProcesses: number
  private readonly idleMs: number
  private readonly tokenTtlMs: number
  private readonly timers: AgentSupervisorTimers
  private readonly runs = new Map<string, AgentRun>()
  private readonly live = new Map<string, LiveTurn>()
  private activeProcesses = 0
  private initialized?: Promise<void>
  private disposed = false
  private sweepRunning = false
  private readonly sweepTimer: unknown

  constructor(private readonly options: AgentRunSupervisorOptions) {
    this.providers = normalizeProviders(options.providers)
    this.now = options.now ?? Date.now
    this.randomId = options.randomId ?? randomUUID
    this.selectedProvider = options.selectedProvider ?? (() => 'claude')
    this.maxActiveProcesses = positiveInteger(options.maxActiveProcesses, DEFAULT_MAX_PROCESSES)
    this.idleMs = positiveInteger(options.idleMs, DEFAULT_IDLE_MS)
    this.tokenTtlMs = positiveInteger(options.tokenTtlMs, DEFAULT_TOKEN_TTL_MS)
    this.timers = options.timers ?? {
      setInterval: (callback, milliseconds) => setInterval(callback, milliseconds),
      clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
    }
    const interval = positiveInteger(options.sweepIntervalMs, DEFAULT_SWEEP_MS)
    this.sweepTimer = this.timers.setInterval(() => {
      if (this.sweepRunning || this.disposed) return
      this.sweepRunning = true
      void this.reap()
        .catch(() => { /* the next explicit operation reports durable failures */ })
        .finally(() => { this.sweepRunning = false })
    }, interval)
  }

  /** Loads durable runs and converts interrupted process work into retryable state. */
  initialize(): Promise<void> {
    if (!this.initialized) this.initialized = this.load()
    return this.initialized
  }

  recover(): Promise<void> {
    return this.initialize()
  }

  async start(input: AgentRunInput, provider?: AgentProviderId): Promise<SupervisedAgentSession>
  async start(provider: AgentProviderId, input: AgentRunInput): Promise<SupervisedAgentSession>
  async start(
    inputOrProvider: AgentRunInput | AgentProviderId,
    providerOrInput?: AgentProviderId | AgentRunInput,
  ): Promise<SupervisedAgentSession> {
    await this.initialize()
    this.assertUsable()
    const input = typeof inputOrProvider === 'string'
      ? providerOrInput as AgentRunInput
      : inputOrProvider
    const explicitProvider = typeof inputOrProvider === 'string'
      ? inputOrProvider
      : providerOrInput as AgentProviderId | undefined
    if (!input || typeof input !== 'object') throw new AgentSupervisorError('invalid-request')

    const providerId = explicitProvider ?? input.provider ?? this.selectedProvider()
    const runId = input.runId ?? this.randomId()
    this.validateTurnInput(runId, input)
    if (this.runs.has(runId)) throw new AgentSupervisorError('invalid-request')
    this.reserveProcess()

    const at = this.now()
    const run: AgentRun = {
      id: runId,
      provider: providerId,
      state: 'starting',
      createdAt: at,
      lastUserAt: at,
      lastActivityAt: at,
      providerWorkEnded: false,
    }
    this.runs.set(runId, run)
    try {
      await this.options.journal.upsertRun(run)
      return await this.startProviderTurn(run, input, false)
    } catch (error) {
      await this.failStart(run)
      throw publicFailure(error)
    }
  }

  startRun(input: AgentRunInput, provider?: AgentProviderId): Promise<SupervisedAgentSession> {
    return this.start(input, provider)
  }

  async resume(runId: string, input: AgentResumeInput): Promise<SupervisedAgentSession> {
    await this.initialize()
    this.assertUsable()
    const run = this.runs.get(runId)
    if (!run) throw new AgentSupervisorError('run-not-found')
    if (run.state === 'closed') throw new AgentSupervisorError('run-closed')
    if (!run.providerWorkEnded || this.live.has(runId)) throw new AgentSupervisorError('run-busy')
    this.validateTurnInput(runId, input)
    this.reserveProcess()

    const at = this.now()
    run.state = 'starting'
    run.lastUserAt = at
    run.lastActivityAt = at
    run.completedAt = undefined
    run.providerWorkEnded = false
    try {
      await this.options.journal.upsertRun(run)
      return await this.startProviderTurn(run, input, Boolean(run.providerHandle))
    } catch (error) {
      await this.failStart(run)
      throw publicFailure(error)
    }
  }

  resumeRun(runId: string, input: AgentResumeInput): Promise<SupervisedAgentSession> {
    return this.resume(runId, input)
  }

  retry(runId: string, input: AgentResumeInput): Promise<SupervisedAgentSession> {
    return this.resume(runId, input)
  }

  get(runId: string): AgentRun | undefined {
    const run = this.runs.get(runId)
    return run ? structuredClone(run) : undefined
  }

  getRun(runId: string): AgentRun | undefined {
    return this.get(runId)
  }

  list(): AgentRun[] {
    return [...this.runs.values()]
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
      .map((run) => structuredClone(run))
  }

  listRuns(): AgentRun[] {
    return this.list()
  }

  counts(): SupervisorCounts {
    return { logicalRuns: this.runs.size, activeProcesses: this.activeProcesses }
  }

  get logicalRunCount(): number {
    return this.runs.size
  }

  get activeProcessCount(): number {
    return this.activeProcesses
  }

  async recordExchange(exchange: AppendExchangeInput): Promise<void> {
    await this.initialize()
    if (!this.runs.has(exchange.runId)) throw new AgentSupervisorError('run-not-found')
    try { await this.options.journal.appendExchange(exchange) } catch (error) { throw publicFailure(error) }
  }

  async recentExchanges(): Promise<AgentExchangeSummary[]> {
    try { return (await this.options.journal.read()).exchanges } catch (error) { throw publicFailure(error) }
  }

  async interrupt(runId: string): Promise<void> {
    await this.initialize()
    const run = this.runs.get(runId)
    const turn = this.live.get(runId)
    if (!run) throw new AgentSupervisorError('run-not-found')
    if (!turn || run.providerWorkEnded || !run.providerHandle) {
      throw new AgentSupervisorError('run-busy')
    }
    try {
      await this.provider(run.provider).interrupt(handleOf(run))
    } catch (error) {
      throw publicFailure(error)
    }
  }

  /** Reaps only terminal runs whose provider turn has definitively ended. */
  async reap(): Promise<string[]> {
    await this.initialize()
    this.options.tokenStore.sweep()
    const at = this.now()
    const reaped: string[] = []
    for (const run of [...this.runs.values()]) {
      if (!run.providerWorkEnded || !isReapable(run.state) || run.completedAt === undefined
        || run.completedAt + this.idleMs > at) continue
      if (run.providerHandle) {
        try { await this.provider(run.provider).close(handleOf(run)) } catch { /* stale after restart */ }
      }
      this.options.tokenStore.closeRun(run.id)
      await this.options.journal.removeRun(run.id).catch((error) => { throw publicFailure(error) })
      this.runs.delete(run.id)
      reaped.push(run.id)
    }
    return reaped
  }

  async closeRun(runId: string): Promise<void> {
    await this.initialize()
    const run = this.runs.get(runId)
    if (!run) throw new AgentSupervisorError('run-not-found')
    const turn = this.live.get(runId)
    if (turn) this.release(runId, turn)
    if (run.providerHandle) {
      try { await this.provider(run.provider).close(handleOf(run)) } catch { /* closing is final */ }
    }
    this.options.tokenStore.closeRun(runId)
    run.state = 'closed'
    run.providerWorkEnded = true
    run.completedAt = this.now()
    run.lastActivityAt = run.completedAt
    await this.options.journal.upsertRun(run).catch((error) => { throw publicFailure(error) })
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.timers.clearInterval(this.sweepTimer)
    await this.initialize().catch(() => {})
    for (const run of this.runs.values()) {
      const turn = this.live.get(run.id)
      const interrupted = Boolean(turn) || !run.providerWorkEnded
      if (turn) {
        turn.releaseCode = 'shutdown'
        this.release(run.id, turn)
      }
      if (run.providerHandle) {
        try { await this.provider(run.provider).close(handleOf(run)) } catch { /* shutdown is final */ }
      }
      this.options.tokenStore.closeRun(run.id)
      if (interrupted) {
        run.providerWorkEnded = true
        run.lastActivityAt = this.now()
        run.state = 'failed'
        run.completedAt = run.lastActivityAt
        await this.options.journal.upsertRun(run).catch(() => {})
      }
    }
  }

  private async load(): Promise<void> {
    let snapshot: AgentJournalSnapshot
    try { snapshot = await this.options.journal.read() } catch (error) { throw publicFailure(error) }
    const at = this.now()
    for (const persisted of snapshot.runs) {
      const run = structuredClone(persisted)
      if (!run.providerWorkEnded) {
        run.providerWorkEnded = true
        run.lastActivityAt = at
        if (run.state === 'starting' || run.state === 'running') {
          run.state = 'failed'
          run.completedAt = at
        }
        await this.options.journal.upsertRun(run).catch((error) => { throw publicFailure(error) })
      }
      this.runs.set(run.id, run)
    }
  }

  private async startProviderTurn(
    run: AgentRun,
    input: AgentRunInput | AgentResumeInput,
    resume: boolean,
  ): Promise<SupervisedAgentSession> {
    const provider = this.provider(run.provider)
    const token = this.options.tokenStore.mint(
      run.id,
      input.interactionId,
      run.provider,
      positiveInteger(input.tokenTtlMs, this.tokenTtlMs),
    )
    const tokenExpiresAt = this.now() + positiveInteger(input.tokenTtlMs, this.tokenTtlMs)
    const providerInput: AgentStartInput = {
      runId: run.id,
      interactionId: input.interactionId,
      cwd: input.cwd,
      transcript: input.transcript,
      constitutionPath: input.constitutionPath,
      environment: input.environment,
      mcp: { endpoint: input.mcp.endpoint, config: input.mcp.config, token },
    }

    const session = resume && run.providerHandle
      ? await provider.resume(handleOf(run), providerInput)
      : await provider.start(providerInput)
    try {
      if (this.disposed) throw new AgentSupervisorError('run-closed')
      if (session.handle.provider !== run.provider) throw new AgentProviderError('invalid-handle')
      run.providerHandle = session.handle.opaqueId
      run.state = 'running'
      run.lastActivityAt = this.now()
      await this.options.journal.upsertRun(run)
    } catch (error) {
      try { await provider.close(session.handle) } catch { /* prevent an untracked provider turn */ }
      throw error
    }

    const activity = new ActivityRelay()
    const turn: LiveTurn = {
      session,
      activity,
      released: false,
      tokenExpiresAt,
      journalFailed: false,
    }
    this.live.set(run.id, turn)
    void this.pumpActivity(run, turn)
    const completion = this.settleCompletion(run, turn)
    return {
      runId: run.id,
      provider: run.provider,
      run: structuredClone(run),
      handle: session.handle,
      activity,
      completion,
    }
  }

  private async pumpActivity(run: AgentRun, turn: LiveTurn): Promise<void> {
    try {
      for await (const event of turn.session.activity) {
        if (turn.released) break
        run.state = event.kind === 'waiting' ? 'waiting' : 'running'
        run.lastActivityAt = this.now()
        turn.activity.emit(event)
        try {
          await this.options.journal.upsertRun(run)
        } catch {
          turn.journalFailed = true
          break
        }
      }
    } catch {
      // Completion remains the single authoritative provider-work boundary.
    } finally {
      turn.activity.end()
    }
  }

  private async settleCompletion(run: AgentRun, turn: LiveTurn): Promise<SupervisedAgentCompletion> {
    let completion: SupervisedAgentCompletion
    try {
      completion = await turn.session.completion
    } catch (cause) {
      // THE ONE PLACE THAT KNOWS WHY, AND IT USED TO THROW IT AWAY.
      //
      // A bare `catch` here turned every provider death into the same opaque
      // sentence on screen. Whatever the provider rejected with is the only
      // account of the failure that exists — the process is already gone — so
      // it is recorded before being collapsed into a code.
      this.options.log?.('agent-provider-crashed', {
        runId: run.id,
        provider: run.provider,
        message: cause instanceof Error ? cause.message : String(cause),
        stack: cause instanceof Error ? cause.stack?.split('\n').slice(0, 4).join('\n') : undefined,
      })
      completion = { outcome: 'failed', errorCode: 'provider-crashed' }
    }
    if (turn.released) {
      return turn.releaseCode
        ? { outcome: 'failed', errorCode: turn.releaseCode }
        : completion
    }

    if (this.now() >= turn.tokenExpiresAt) {
      completion = { outcome: 'failed', errorCode: 'interaction-expired' }
    } else if (turn.journalFailed) {
      completion = { outcome: 'failed', errorCode: 'journal-unavailable' }
    } else if (completion.outcome === 'failed' && !completion.errorCode) {
      completion = { outcome: 'failed', errorCode: 'provider-crashed' }
    }

    const at = this.now()
    run.state = completion.outcome === 'completed' ? 'complete' : 'failed'
    run.providerWorkEnded = true
    run.completedAt = at
    run.lastActivityAt = at
    this.release(run.id, turn)
    this.options.tokenStore.closeRun(run.id)
    try {
      await this.options.journal.upsertRun(run)
    } catch {
      return { outcome: 'failed', errorCode: 'journal-unavailable' }
    }
    return completion
  }

  private async failStart(run: AgentRun): Promise<void> {
    const at = this.now()
    run.state = 'failed'
    run.providerWorkEnded = true
    run.completedAt = at
    run.lastActivityAt = at
    this.activeProcesses = Math.max(0, this.activeProcesses - 1)
    this.options.tokenStore.closeRun(run.id)
    await this.options.journal.upsertRun(run).catch(() => {})
  }

  private release(runId: string, turn: LiveTurn): void {
    if (turn.released) return
    turn.released = true
    this.live.delete(runId)
    this.activeProcesses = Math.max(0, this.activeProcesses - 1)
    turn.activity.end()
  }

  private reserveProcess(): void {
    if (this.activeProcesses >= this.maxActiveProcesses) {
      throw new AgentSupervisorError('resource-pressure')
    }
    this.activeProcesses += 1
  }

  private provider(id: AgentProviderId): AgentProvider {
    const provider = this.providers.get(id)
    if (!provider) throw new AgentSupervisorError('provider-unavailable')
    return provider
  }

  private validateTurnInput(runId: string, input: AgentRunInput | AgentResumeInput): void {
    if (!ID.test(runId) || !ID.test(input.interactionId)
      || typeof input.cwd !== 'string' || !input.cwd
      || typeof input.transcript !== 'string'
      || typeof input.constitutionPath !== 'string' || !input.constitutionPath
      || !input.environment || typeof input.environment !== 'object'
      || !input.mcp || typeof input.mcp.endpoint !== 'string' || !input.mcp.endpoint
      || typeof input.mcp.config !== 'string') {
      throw new AgentSupervisorError('invalid-request')
    }
  }

  private assertUsable(): void {
    if (this.disposed) throw new AgentSupervisorError('run-closed')
  }
}

class ActivityRelay implements AsyncIterable<AgentActivity> {
  private readonly values: AgentActivity[] = []
  private readonly waiters: Array<(value: IteratorResult<AgentActivity>) => void> = []
  private ended = false

  emit(value: AgentActivity): void {
    if (this.ended) return
    const waiter = this.waiters.shift()
    if (waiter) waiter({ done: false, value })
    else this.values.push(value)
  }

  end(): void {
    if (this.ended) return
    this.ended = true
    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined })
  }

  [Symbol.asyncIterator](): AsyncIterator<AgentActivity> {
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

function normalizeProviders(
  providers: AgentRunSupervisorOptions['providers'],
): ReadonlyMap<AgentProviderId, AgentProvider> {
  if (providers instanceof Map) return new Map(providers)
  const entries = Object.entries(providers)
    .filter((entry): entry is [AgentProviderId, AgentProvider] => Boolean(entry[1]))
  return new Map(entries)
}

function handleOf(run: AgentRun): AgentSessionHandle {
  if (!run.providerHandle) throw new AgentSupervisorError('invalid-request')
  return { provider: run.provider, opaqueId: run.providerHandle }
}

function isReapable(state: AgentRunState): boolean {
  return state === 'complete' || state === 'failed'
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value <= 0) throw new AgentSupervisorError('invalid-request')
  return value
}

function publicFailure(error: unknown): Error {
  if (error instanceof AgentSupervisorError || error instanceof AgentProviderError) return error
  if (error instanceof AgentJournalError) return new AgentSupervisorError('journal-unavailable')
  return new AgentSupervisorError('provider-unavailable')
}

function supervisorErrorMessage(code: AgentSupervisorErrorCode): string {
  switch (code) {
    case 'resource-pressure': return 'The Agent is at process capacity. Try again after an active run finishes.'
    case 'run-not-found': return 'That Agent run is unavailable.'
    case 'run-busy': return 'That Agent run already has active provider work.'
    case 'run-closed': return 'That Agent run is closed.'
    case 'invalid-request': return 'The Agent run request is invalid.'
    case 'provider-unavailable': return 'The selected Agent provider is unavailable.'
    case 'journal-unavailable': return 'The Agent recovery journal is unavailable.'
  }
}
