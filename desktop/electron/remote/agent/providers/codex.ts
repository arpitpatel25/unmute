import { promises as fs } from 'node:fs'
import { CodexExecutor, type CodexExecutorOpts } from '../../codex-executor'
import {
  discoverSessionId,
  findRollout,
  readRolloutEvents,
  snapshotRolloutSessionIds,
} from '../../codex/cli-session'
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
    let releaseFreshDiscovery: (() => void) | null = null
    if (launch.session.kind === 'fresh') {
      const predecessor = freshDiscoveryTails.get(launch.cwd) ?? Promise.resolve()
      let release!: () => void
      const ownGate = new Promise<void>((resolve) => { release = resolve })
      freshDiscoveryTails.set(launch.cwd, ownGate)
      await predecessor
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
    let rolloutPath: string | null = null
    let cursor = 0
    let lastMessage = ''
    let timer: ReturnType<typeof setInterval> | null = null
    let afterSpawnCalled = false
    let observerFailed = false
    let preSpawnSessions: ReadonlySet<string>
    const sinceMs = Date.now()

    try {
      preSpawnSessions = launch.session.kind === 'fresh'
        ? await snapshotRolloutSessionIds(options.home)
        : new Set<string>()

      // A resumed rollout already contains old completions. Establish a stable
      // exact-session cursor before spawning so relocation cannot replay them.
      if (sessionId) {
        const baseline = await baselineResume(sessionId, options)
        rolloutPath = baseline.path
        cursor = baseline.cursor
      }
    } catch (error) {
      releaseFreshDiscovery?.()
      if (claimedSession) claimedSessions.delete(claimedSession)
      throw error
    }

    const tick = async () => {
      if (stopped || polling) return
      polling = true
      try {
        if (!sessionId) {
          const discovered = await discoverSessionId(
            launch.cwd,
            sinceMs,
            options.home,
            5_000,
            preSpawnSessions,
          ) ?? undefined
          if (!discovered || claimedSessions.has(discovered)) return
          sessionId = discovered
          claimedSession = discovered
          claimedSessions.add(discovered)
          emit({ type: 'handle', sessionId })
          releaseFreshDiscovery?.()
        }
        if (!rolloutPath) rolloutPath = await findRollout(sessionId, options.home)
        if (!rolloutPath) return
        let events = await readRolloutEvents(rolloutPath)
        if (!events.length) {
          const relocated = await findRollout(sessionId, options.home)
          if (relocated && relocated !== rolloutPath) {
            rolloutPath = relocated
            events = await readRolloutEvents(rolloutPath)
          }
        }
        if (events.length < cursor) {
          cursor = 0
          lastMessage = ''
        }
        for (const event of events.slice(cursor)) {
          lastMessage = emitCodexEvent(event, emit, lastMessage)
        }
        cursor = events.length
      } finally {
        polling = false
      }
    }

    const poll = () => {
      if (observerFailed) return
      void tick().catch(() => {
        if (stopped || observerFailed) return
        observerFailed = true
        emit({ type: 'observer-failure' })
      })
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
      stop,
    }
  }
}

async function baselineResume(
  sessionId: string,
  options: CodexRolloutObserverOptions,
): Promise<{ path: string; cursor: number }> {
  const timeoutMs = Number.isFinite(options.resumeBaselineTimeoutMs)
    ? Math.max(0, options.resumeBaselineTimeoutMs!)
    : 8_000
  const pollMs = Number.isFinite(options.pollMs) && options.pollMs! > 0
    ? options.pollMs!
    : 100
  const deadline = Date.now() + timeoutMs

  while (true) {
    const path = await findRollout(sessionId, options.home)
    if (path) {
      const events = await readRolloutEvents(path)
      const confirmedPath = await findRollout(sessionId, options.home)
      if (confirmedPath === path) return { path, cursor: events.length }
    }
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) throw new Error('Codex resume history is unavailable')
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(pollMs, remainingMs)))
  }
}

function emitCodexEvent(
  event: Awaited<ReturnType<typeof readRolloutEvents>>[number],
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
