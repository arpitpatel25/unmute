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

export interface CodexCliProviderOptions {
  binary?: string
  processFactory?: AgentProcessFactory
  probeBinary?: ProbeBinary
  observe?: ProviderEventObserver
  executor?: Omit<CodexExecutorOpts, 'codexBin' | 'developerInstructions' | 'extraArgs' | 'remote'>
  rollout?: CodexRolloutObserverOptions
  handleTimeoutMs?: number
}

export interface CodexRolloutObserverOptions {
  home?: string
  pollMs?: number
  resumeBaselineTimeoutMs?: number
  liveReadTimeoutMs?: number
}

/** Codex CLI adapter; fresh handles are learned from its structured rollout. */
export class CodexCliProvider extends CliProviderRuntime {
  constructor(options: CodexCliProviderOptions = {}) {
    const binary = options.binary ?? 'codex'
    const observe = options.observe ?? codexRolloutObserver(options.rollout)
    const processFactory = options.processFactory ?? (() => new ExecutorBackedAgentProcess({
      createExecutor: async (launch) => new CodexExecutor({
        ...options.executor,
        codexBin: binary,
        developerInstructions: await fs.readFile(launch.systemContext.path, 'utf8'),
        extraArgs: [],
        remote: undefined,
      }),
      observe,
    }))
    super({
      id: 'codex',
      binary,
      processFactory,
      probeBinary: options.probeBinary ?? probeCli,
      learnsFreshHandle: true,
      handleTimeoutMs: options.handleTimeoutMs,
      argv: (session) => session.kind === 'resume' ? ['resume', session.id!] : [],
    })
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
    const knownHistories = new Map<string, readonly string[]>()
    let activeFileIds = new Set<string>()
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
        rememberHistories(knownHistories, histories)
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
        knownHistories,
        activeFileIds,
        activeTurnPrefix,
      )
      activeFileIds = selected.activeFileIds
      activeTurnPrefix = selected.activeTurnPrefix
      for (const event of selected.events) {
        lastMessage = emitCodexEvent(event, emit, lastMessage)
      }
      rememberHistories(knownHistories, attempt.histories)
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
      },
      async beforeSubmit() {
        await serialize(async () => {
          setupDeadline.ensure()
          if (!sessionId) throw new Error('Codex session identity is unavailable')
          const histories = await captureStableExactHistory(sessionId, options, setupDeadline)
          knownHistories.clear()
          rememberHistories(knownHistories, histories)
          activeFileIds = new Set()
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
  known: ReadonlyMap<string, readonly string[]>,
  activeFileIds: ReadonlySet<string>,
  activeTurnPrefix: readonly string[],
): { events: RolloutEvent[]; activeFileIds: Set<string>; activeTurnPrefix: readonly string[] } {
  if (!activeFileIds.size) {
    const candidates: Array<{ history: KeyedHistory; start: number }> = []
    for (const history of histories) {
      const oldPrefix = knownPrefixForHistory(history, known)
      const start = history.events.findIndex((event, index) =>
        index >= oldPrefix && event.type === 'event_msg' && event.payload?.type === 'task_started')
      if (start >= 0) candidates.push({ history, start })
    }
    if (!candidates.length) return { events: [], activeFileIds: new Set(), activeTurnPrefix: [] }
    const selected = longestCompatibleLineage(candidates.map(({ history, start }) => ({
      history,
      start,
      fingerprints: history.fingerprints.slice(start),
    })))
    const ids = new Set<string>()
    for (const candidate of candidates) {
      const lineage = candidate.history.fingerprints.slice(candidate.start)
      if (prefixCompatible(lineage, selected.fingerprints)) ids.add(candidate.history.fileId)
    }
    return {
      events: selected.history.events.slice(selected.start),
      activeFileIds: ids,
      activeTurnPrefix: selected.fingerprints,
    }
  }

  const continuations: Array<{ history: KeyedHistory; start: number; fingerprints: readonly string[] }> = []
  const ids = new Set(activeFileIds)
  for (const history of histories) {
    const ownsTurn = activeFileIds.has(history.fileId)
      || contiguousIndex(history.fingerprints, activeTurnPrefix) >= 0
    if (!ownsTurn) continue
    ids.add(history.fileId)
    const start = knownPrefixForHistory(history, known)
    if (start < history.events.length) {
      continuations.push({
        history,
        start,
        fingerprints: history.fingerprints.slice(start),
      })
    }
  }
  if (!continuations.length) {
    return { events: [], activeFileIds: ids, activeTurnPrefix }
  }
  const selected = longestCompatibleLineage(continuations)
  return {
    events: selected.history.events.slice(selected.start),
    activeFileIds: ids,
    activeTurnPrefix: [...activeTurnPrefix, ...selected.fingerprints],
  }
}

function longestCompatibleLineage<T extends { fingerprints: readonly string[] }>(candidates: readonly T[]): T {
  const sorted = [...candidates].sort((a, b) => b.fingerprints.length - a.fingerprints.length)
  const selected = sorted[0]
  for (const candidate of sorted.slice(1)) {
    if (!prefixCompatible(candidate.fingerprints, selected.fingerprints)) {
      throw new Error('Divergent exact-session rollout histories')
    }
  }
  return selected
}

function prefixCompatible(a: readonly string[], b: readonly string[]): boolean {
  const count = Math.min(a.length, b.length)
  for (let index = 0; index < count; index++) {
    if (a[index] !== b[index]) return false
  }
  return true
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

function knownPrefixForHistory(
  history: KeyedHistory,
  known: ReadonlyMap<string, readonly string[]>,
): number {
  const sameFile = known.get(history.fileId)
  return knownPrefixLength(
    history.fingerprints,
    sameFile ? [sameFile] : known.values(),
  )
}

function contiguousIndex(sequence: readonly string[], part: readonly string[]): number {
  if (!part.length) return -1
  outer: for (let index = 0; index <= sequence.length - part.length; index++) {
    for (let offset = 0; offset < part.length; offset++) {
      if (sequence[index + offset] !== part[offset]) continue outer
    }
    return index
  }
  return -1
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
