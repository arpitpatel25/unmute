import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { ClaudeCodeExecutor, type ClaudeCodeExecutorOpts } from '../../pty-session'
import type { HookEvent } from '../../observer'
import {
  CliProviderRuntime,
  ExecutorBackedAgentProcess,
  probeCli,
  type AgentProcessFactory,
  type AgentProcessEvent,
  type ProbeBinary,
  type ProviderEventObserver,
} from '../provider'

export interface ClaudeCodeProviderOptions {
  binary?: string
  processFactory?: AgentProcessFactory
  probeBinary?: ProbeBinary
  randomId?: () => string
  observe?: ProviderEventObserver
  hookEvents?: ClaudeHookEventSource
  executor?: Omit<ClaudeCodeExecutorOpts, 'claudeBin' | 'appendSystemPrompt' | 'extraArgs' | 'tmux'>
}

/** Claude Code CLI adapter with a pinned UUID for every fresh conversation. */
export class ClaudeCodeProvider extends CliProviderRuntime {
  constructor(options: ClaudeCodeProviderOptions = {}) {
    const binary = options.binary ?? 'claude'
    const observe = options.observe ?? (options.hookEvents ? claudeHookObserver(options.hookEvents) : undefined)
    const processFactory = options.processFactory ?? (() => new ExecutorBackedAgentProcess({
      createExecutor: async (launch) => new ClaudeCodeExecutor({
        ...options.executor,
        claudeBin: binary,
        appendSystemPrompt: await fs.readFile(launch.systemContext.path, 'utf8'),
        extraArgs: [],
        tmux: undefined,
      }),
      observe,
    }))
    super({
      id: 'claude',
      binary,
      processFactory,
      probeBinary: options.probeBinary ?? probeCli,
      freshHandle: options.randomId ?? randomUUID,
      learnsFreshHandle: false,
      argv: (session) => session.kind === 'resume'
        ? ['--resume', session.id!]
        : ['--session-id', session.id!],
    })
  }
}

export interface ClaudeHookEventSource {
  subscribe(listener: (event: HookEvent) => void): () => void
}

/** Filter the app's existing hook stream to one pinned Claude conversation. */
export function claudeHookObserver(source: ClaudeHookEventSource): ProviderEventObserver {
  return (launch, emit) => {
    const sessionId = launch.session.id
    return source.subscribe((event) => {
      if (!sessionId || event.sessionId !== sessionId) return
      const mapped = mapHookEvent(event)
      if (mapped) emit(mapped)
    })
  }
}

function mapHookEvent(event: HookEvent): AgentProcessEvent | null {
  switch (event.kind) {
    case 'prompt-submitted': return { type: 'activity', kind: 'progress', summary: 'turn started' }
    case 'tool-used': return { type: 'activity', kind: 'tool', summary: event.tool ? `using ${event.tool}` : 'using a tool' }
    case 'turn-ended': return { type: 'completion', outcome: 'completed', ...(event.lastMessage ? { finalText: event.lastMessage } : {}) }
    case 'waiting': return { type: 'activity', kind: 'waiting', summary: 'waiting for you' }
    case 'ask-opened': return { type: 'activity', kind: 'waiting', summary: 'waiting for your answer' }
    case 'ask-closed': return { type: 'activity', kind: 'progress', summary: 'answer received' }
    case 'permission-asked': return { type: 'activity', kind: 'waiting', summary: 'waiting for permission' }
    case 'session-ended': return { type: 'exit', exitCode: 0 }
  }
}
