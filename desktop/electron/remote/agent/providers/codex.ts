import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import { CodexExecutor, type CodexExecutorOpts } from '../../codex-executor'
import {
  discoverSessionIdStrict,
  findRolloutCandidates,
  readRolloutSnapshot,
  snapshotRolloutSessionIds,
} from '../../codex/cli-session'
import type { RolloutEvent } from '../../codex/cli-observer'
import {
  CliProviderRuntime,
  ExecutorBackedAgentProcess,
  probeCli,
  type AgentProcessEvent,
  type AgentProcessFactory,
  type AgentProcessLaunch,
  type ProbeBinary,
  type ProviderEventObserver,
} from '../provider'
import { agentRuntimeMode, type AgentRuntimeMode } from './claude-headless'
import { CodexHeadlessProcess } from './codex-headless'
import { CodexPersistentProcess } from './codex-persistent'

export interface CodexCliProviderOptions {
  binary?: string
  processFactory?: AgentProcessFactory
  probeBinary?: ProbeBinary
  observe?: ProviderEventObserver
  executor?: Omit<CodexExecutorOpts, 'codexBin' | 'developerInstructions' | 'extraArgs' | 'remote'>
  rollout?: CodexRolloutObserverOptions
  handleTimeoutMs?: number
  runtime?: AgentRuntimeMode
  /** Required only for injected drivers whose fresh handle follows submission. */
  submitBeforeFreshHandle?: boolean
}

export interface CodexRolloutObserverOptions {
  home?: string
  pollMs?: number
  resumeBaselineTimeoutMs?: number
  liveReadTimeoutMs?: number
}

/** Codex CLI adapter; fresh handles are learned from its structured rollout. */
export class CodexCliProvider extends CliProviderRuntime {
  readonly createProcess: AgentProcessFactory

  constructor(options: CodexCliProviderOptions = {}) {
    const binary = options.binary ?? 'codex'
    const observe = options.observe ?? codexRolloutObserver(options.rollout)
    const replFactory: AgentProcessFactory = () => new ExecutorBackedAgentProcess({
      createExecutor: async (launch) => new CodexExecutor({
        ...options.executor,
        codexBin: binary,
        developerInstructions: await fs.readFile(launch.systemContext.path, 'utf8'),
        extraArgs: [],
        remote: undefined,
      }),
      observe,
    })
    const runtime = options.runtime ?? agentRuntimeMode()
    const usesHeadless = runtime !== 'repl'
    const processFactory = options.processFactory
      ?? (runtime === 'persistent' ? () => new CodexPersistentProcess()
        : usesHeadless ? () => new CodexHeadlessProcess() : replFactory)
    super({
      id: 'codex',
      binary,
      processFactory,
      probeBinary: options.probeBinary ?? probeCli,
      learnsFreshHandle: true,
      submitBeforeFreshHandle: options.submitBeforeFreshHandle
        ?? (options.processFactory ? false : usesHeadless),
      handleTimeoutMs: options.handleTimeoutMs,
      argv: (session) => session.kind === 'resume' ? ['resume', session.id!] : [],
    })
    this.createProcess = processFactory
  }
}

/**
 * Structured Codex observation. Existing rollout parsing discovers the CLI-
 * minted handle and only owned event_msg records can finish a turn.
 */
export function codexRolloutObserver(
  options: CodexRolloutObserverOptions = {},
): ProviderEventObserver {
  const freshDiscoveryTails = new Map<string, Promise<void>>()
  const claimedSessions = new Set<string>()
  return async (launch, emit) => {
    const setupDeadline = new HardDeadline(baselineTimeoutMs(options))
    let releaseFreshDiscovery: (() => void) | null = null
    if (launch.session.kind === 'fresh') {
      const predecessor = freshDiscoveryTails.get(launch.cwd) ?? Promise.resolve()
      let release!: () => void
      const ownGate = new Promise<void>((resolve) => { release = resolve })
      freshDiscoveryTails.set(launch.cwd, ownGate)
      try {
        await setupDeadline.run(() => predecessor)
      } catch (error) {
        release()
        if (freshDiscoveryTails.get(launch.cwd) === ownGate) freshDiscoveryTails.delete(launch.cwd)
        throw error
      }
      releaseFreshDiscovery = () => {
        if (!releaseFreshDiscovery) return
        releaseFreshDiscovery = null
        release()
        if (freshDiscoveryTails.get(launch.cwd) === ownGate) freshDiscoveryTails.delete(launch.cwd)
      }
    }
    let stopped = false
    let polling = false
    let sessionId = launch.session.kind === 'resume' ? launch.session.id : undefined
    let claimedSession = sessionId
    if (claimedSession) claimedSessions.add(claimedSession)
    let lastMessage = ''
    let timer: ReturnType<typeof setInterval> | null = null
    let afterSpawnCalled = false
    let observerFailed = false
    let preSpawnSessions: ReadonlySet<string>
    const turnBaselineHistories = new Map<string, readonly string[]>()
    let activeFileId: string | null = null
    let activeTurnPrefix: readonly string[] = []
    const sinceMs = Date.now()

    try {
      preSpawnSessions = launch.session.kind === 'fresh'
        ? await setupDeadline.run(() => snapshotRolloutSessionIds(options.home))
        : new Set<string>()

      // Keep the pre-spawn availability check: a missing or unreadable exact
      // resume must fail before PTY spawn. The causal boundary itself is reset
      // later, after readiness and immediately before the user turn is sent.
      if (sessionId) {
        const histories = await captureStableExactHistory(sessionId, options, setupDeadline)
        rememberHistories(turnBaselineHistories, histories)
      }
    } catch (error) {
      releaseFreshDiscovery?.()
      if (claimedSession) claimedSessions.delete(claimedSession)
      throw error
    }

    const tick = async () => {
      if (stopped) return
      if (!sessionId) {
        const discovered = await setupDeadline.run(() => discoverSessionIdStrict(
          launch.cwd, sinceMs, options.home, 5_000, preSpawnSessions,
        )) ?? undefined
        if (!discovered || claimedSessions.has(discovered)) return
        sessionId = discovered
        claimedSession = discovered
        claimedSessions.add(discovered)
        emit({ type: 'handle', sessionId })
        releaseFreshDiscovery?.()
      }
      const liveDeadline = new HardDeadline(liveReadTimeoutMs(options))
      const attempt = await readExactHistoryOnce(sessionId, options, liveDeadline)
      if (!attempt.complete || !attempt.histories.length) return
      const selected = selectCurrentTurnEvents(
        attempt.histories,
        turnBaselineHistories,
        activeFileId,
        activeTurnPrefix,
      )
      activeFileId = selected.activeFileId
      activeTurnPrefix = selected.activeTurnPrefix
      for (const event of selected.events) {
        lastMessage = emitCodexEvent(event, emit, lastMessage)
      }
    }

    let operationTail = Promise.resolve()
    const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
      const result = operationTail.then(operation)
      operationTail = result.then(() => undefined, () => undefined)
      return result
    }

    const poll = () => {
      if (observerFailed || stopped || polling) return
      polling = true
      void serialize(tick).catch(() => {
        if (stopped || observerFailed) return
        observerFailed = true
        emit({ type: 'observer-failure' })
      }).finally(() => { polling = false })
    }
    const stop = () => {
      stopped = true
      if (timer) clearInterval(timer)
      releaseFreshDiscovery?.()
      if (claimedSession) claimedSessions.delete(claimedSession)
    }
    return {
      afterSpawn() {
        if (afterSpawnCalled || stopped) return
        afterSpawnCalled = true
        poll()
        timer = setInterval(poll, options.pollMs ?? 100)
        timer.unref?.()
      },
      async beforeSubmit() {
        await serialize(async () => {
          setupDeadline.ensure()
          if (observerFailed) throw new Error('Codex rollout observation failed')
          if (!sessionId) throw new Error('Codex session identity is unavailable')
          const histories = await captureStableExactHistory(sessionId, options, setupDeadline)
          turnBaselineHistories.clear()
          rememberHistories(turnBaselineHistories, histories)
          activeFileId = null
          activeTurnPrefix = []
          lastMessage = ''
        })
      },
      stop,
    }
  }
}

interface KeyedHistory {
  fileId: string
  path: string
  events: readonly RolloutEvent[]
  fingerprints: readonly string[]
}

interface ExactHistoryAttempt {
  complete: boolean
  histories: KeyedHistory[]
}

async function captureStableExactHistory(
  sessionId: string,
  options: CodexRolloutObserverOptions,
  deadline: HardDeadline,
): Promise<KeyedHistory[]> {
  const pollMs = Number.isFinite(options.pollMs) && options.pollMs! > 0
    ? options.pollMs!
    : 100

  while (true) {
    const attempt = await readExactHistoryOnce(sessionId, options, deadline)
    if (attempt.complete && attempt.histories.length) return attempt.histories
    await deadline.wait(pollMs)
  }
}

async function readExactHistoryOnce(
  sessionId: string,
  options: CodexRolloutObserverOptions,
  deadline: HardDeadline,
): Promise<ExactHistoryAttempt> {
  const candidates = await deadline.run(() => findRolloutCandidates(sessionId, options.home))
  if (!candidates.length) return { complete: true, histories: [] }
  const histories: KeyedHistory[] = []
  let complete = true
  for (const candidate of candidates) {
    const snapshot = await deadline.run(() => readRolloutSnapshot(candidate.path))
    if (snapshot.status === 'missing' || !snapshot.stable || snapshot.fileId !== candidate.fileId) {
      complete = false
      continue
    }
    if (!snapshot.sessionId) {
      complete = false
      continue
    }
    if (snapshot.sessionId.toLowerCase() !== sessionId.toLowerCase()) {
      throw new Error('Codex rollout identity mismatch')
    }
    histories.push({
      fileId: snapshot.fileId,
      path: candidate.path,
      events: snapshot.events,
      fingerprints: snapshot.events.map(eventFingerprint),
    })
  }
  const confirmed = await deadline.run(() => findRolloutCandidates(sessionId, options.home))
  if (!sameCandidateSet(candidates, confirmed, histories)) complete = false
  return { complete, histories }
}

function sameCandidateSet(
  before: Awaited<ReturnType<typeof findRolloutCandidates>>,
  after: Awaited<ReturnType<typeof findRolloutCandidates>>,
  histories: readonly KeyedHistory[],
): boolean {
  if (before.length !== after.length || histories.length !== before.length) return false
  const afterByPath = new Map(after.map((candidate) => [candidate.path, candidate]))
  const historyIds = new Map(histories.map((history) => [history.path, history.fileId]))
  return before.every((candidate) => {
    const confirmed = afterByPath.get(candidate.path)
    return confirmed?.fileId === candidate.fileId
      && confirmed.mtimeMs === candidate.mtimeMs
      && historyIds.get(candidate.path) === candidate.fileId
  })
}

function rememberHistories(
  known: Map<string, readonly string[]>,
  histories: readonly KeyedHistory[],
): void {
  for (const history of histories) known.set(history.fileId, history.fingerprints)
}

function selectCurrentTurnEvents(
  histories: readonly KeyedHistory[],
  baseline: ReadonlyMap<string, readonly string[]>,
  activeFileId: string | null,
  activeTurnPrefix: readonly string[],
): { events: RolloutEvent[]; activeFileId: string | null; activeTurnPrefix: readonly string[] } {
  const unique = uniqueFileHistories(histories)
  const lineages = unique
    .map((history) => turnLineage(history, baseline))
    .filter((lineage): lineage is TurnLineage => lineage !== null)

  if (!activeFileId) {
    if (!lineages.length) return { events: [], activeFileId: null, activeTurnPrefix: [] }
    if (lineages.length !== 1) throw new Error('Ambiguous exact-session rollout writer')
    const selected = lineages[0]
    return {
      events: selected.history.events.slice(selected.start),
      activeFileId: selected.history.fileId,
      activeTurnPrefix: selected.fingerprints,
    }
  }

  const owner = lineages.find((lineage) => lineage.history.fileId === activeFileId)
  if (owner) {
    if (!isPrefix(activeTurnPrefix, owner.fingerprints)) {
      throw new Error('Divergent exact-session rollout writer')
    }
    for (const candidate of lineages) {
      if (candidate === owner) continue
      if (!isPrefix(candidate.fingerprints, activeTurnPrefix)) {
        throw new Error('Competing exact-session rollout writer')
      }
    }
    return {
      events: owner.history.events.slice(owner.start + activeTurnPrefix.length),
      activeFileId,
      activeTurnPrefix: owner.fingerprints,
    }
  }

  const migrations: TurnLineage[] = []
  for (const candidate of lineages) {
    if (isPrefix(activeTurnPrefix, candidate.fingerprints)) migrations.push(candidate)
    else if (!isPrefix(candidate.fingerprints, activeTurnPrefix)) {
      throw new Error('Divergent exact-session rollout writer')
    }
  }
  if (!migrations.length) return { events: [], activeFileId, activeTurnPrefix }
  if (migrations.length !== 1) throw new Error('Ambiguous exact-session rollout migration')
  const migrated = migrations[0]
  return {
    events: migrated.history.events.slice(migrated.start + activeTurnPrefix.length),
    activeFileId: migrated.history.fileId,
    activeTurnPrefix: migrated.fingerprints,
  }
}

interface TurnLineage {
  history: KeyedHistory
  start: number
  fingerprints: readonly string[]
}

function uniqueFileHistories(histories: readonly KeyedHistory[]): KeyedHistory[] {
  const unique = new Map<string, KeyedHistory>()
  for (const history of histories) {
    const prior = unique.get(history.fileId)
    if (prior && !sameSequence(prior.fingerprints, history.fingerprints)) {
      throw new Error('Unstable exact-session rollout inode')
    }
    if (!prior) unique.set(history.fileId, history)
  }
  return [...unique.values()]
}

function turnLineage(
  history: KeyedHistory,
  baseline: ReadonlyMap<string, readonly string[]>,
): TurnLineage | null {
  const oldPrefix = baselinePrefixForHistory(history, baseline)
  const start = history.events.findIndex((event, index) =>
    index >= oldPrefix && event.type === 'event_msg' && event.payload?.type === 'task_started')
  return start < 0 ? null : {
    history,
    start,
    fingerprints: history.fingerprints.slice(start),
  }
}

function baselinePrefixForHistory(
  history: KeyedHistory,
  baseline: ReadonlyMap<string, readonly string[]>,
): number {
  const sameFile = baseline.get(history.fileId)
  if (sameFile) {
    if (!isPrefix(sameFile, history.fingerprints)) {
      throw new Error('Exact-session rollout history regressed')
    }
    return sameFile.length
  }
  return knownPrefixLength(history.fingerprints, baseline.values())
}

function isPrefix(prefix: readonly string[], sequence: readonly string[]): boolean {
  if (prefix.length > sequence.length) return false
  for (let index = 0; index < prefix.length; index++) {
    if (prefix[index] !== sequence[index]) return false
  }
  return true
}

function sameSequence(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && isPrefix(a, b)
}

function knownPrefixLength(
  sequence: readonly string[],
  histories: Iterable<readonly string[]>,
): number {
  let best = 0
  for (const known of histories) {
    let knownIndex = 0
    let matched = 0
    while (matched < sequence.length) {
      while (knownIndex < known.length && known[knownIndex] !== sequence[matched]) knownIndex++
      if (knownIndex >= known.length) break
      knownIndex++
      matched++
    }
    best = Math.max(best, matched)
  }
  return best
}

function eventFingerprint(event: RolloutEvent): string {
  return createHash('sha256').update(JSON.stringify(event)).digest('hex')
}

function baselineTimeoutMs(options: CodexRolloutObserverOptions): number {
  return Number.isFinite(options.resumeBaselineTimeoutMs)
    ? Math.max(0, options.resumeBaselineTimeoutMs!)
    : 8_000
}

function liveReadTimeoutMs(options: CodexRolloutObserverOptions): number {
  return Number.isFinite(options.liveReadTimeoutMs)
    ? Math.max(1, options.liveReadTimeoutMs!)
    : 8_000
}

class HardDeadline {
  private readonly expiresAt: number

  constructor(timeoutMs: number) {
    this.expiresAt = Date.now() + timeoutMs
  }

  ensure(): void {
    if (Date.now() >= this.expiresAt) throw new Error('Codex rollout setup timed out')
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    this.ensure()
    const remaining = Math.max(0, this.expiresAt - Date.now())
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const value = await Promise.race([
        operation(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Codex rollout setup timed out')), remaining)
        }),
      ])
      this.ensure()
      return value
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  async wait(delayMs: number): Promise<void> {
    this.ensure()
    const remaining = this.expiresAt - Date.now()
    await this.run(() => new Promise<void>((resolve) => setTimeout(resolve, Math.min(delayMs, remaining))))
  }
}

function emitCodexEvent(
  event: RolloutEvent,
  emit: (event: AgentProcessEvent) => void,
  lastMessage: string,
): string {
  if (event.type !== 'event_msg') return lastMessage
  const kind = event.payload?.type
  const message = typeof event.payload?.message === 'string'
    ? event.payload.message
    : typeof event.payload?.text === 'string' ? event.payload.text : ''
  if (kind === 'task_started') lastMessage = ''
  else if (kind === 'agent_message' && message) {
    lastMessage = message
  }
  else if (kind === 'task_complete') {
    const finalText = typeof event.payload?.last_agent_message === 'string'
      ? event.payload.last_agent_message
      : lastMessage
    emit({ type: 'completion', outcome: 'completed', ...(finalText ? { finalText } : {}) })
  }
  else if (kind === 'turn_aborted') emit({ type: 'completion', outcome: 'interrupted' })
  else if (/^(mcp_tool_call|patch_apply|web_search|exec_command)_(begin|end)$/.test(kind ?? '')) {
    emit({ type: 'activity', kind: 'tool', summary: codexActivity(kind!) })
  }
  return lastMessage
}

function codexActivity(kind: string): string {
  if (kind.startsWith('patch_apply')) return 'editing files'
  if (kind.startsWith('web_search')) return 'searching the web'
  if (kind.startsWith('exec_command')) return 'running a command'
  return 'using a tool'
}
