import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import type { AgentControllerRuntime, AgentInteractionActivity, UnmuteAgentController } from '../controller'
import type { AgentRunMcpContext, AgentRunSupervisor } from '../supervisor'
import type { RoutineDefinition } from './definition'
import { routineConstitutionSection } from './prompt'
import type { RoutineRun } from './types'
import { referenceContext } from './context'

/**
 * Read plus the two Chrome MCP surfaces a takes-actions run needs. Passed as
 * `--allowedTools` to the Claude driver dedicated to the actor pair — never
 * to the reader, which never sees Chrome at all.
 */
export const ACTOR_ALLOWED_TOOLS = 'mcp__unmute,mcp__claude-in-chrome,Read,Glob,Grep'

export interface ExecuteInput {
  run: RoutineRun
  definition: RoutineDefinition
  transcript: string
  runDir: string
  provider: 'claude' | 'codex'
  onActivity(text: string): void
}

export interface ExecuteOutcome {
  outcome: 'completed' | 'failed' | 'interrupted'
  text?: string
  error?: string
  providerSessionId?: string
  agentRunId: string
}

export interface RoutineExecutorHandle {
  agentRunId: string
  completion: Promise<ExecuteOutcome>
  cancel(): Promise<void>
}

export interface RoutineExecutor {
  start(input: ExecuteInput): RoutineExecutorHandle
  dispose(): Promise<void>
}

/** §4: a read-only routine runs through `reader`; a takes-actions routine
 *  runs through a wholly separate `actor` pair (its own supervisor and Claude
 *  provider, so it can never take the Agent's own process slot or the
 *  reader's). */
export interface RoutineRunPair {
  controller: Pick<UnmuteAgentController, 'submit'>
  supervisor: Pick<AgentRunSupervisor, 'interrupt' | 'closeRun'>
}

export interface RoutineAgentExecutorOptions {
  reader: RoutineRunPair
  actor?: RoutineRunPair
  /** agentConstitution(SESSION_PREAMBLE, persona) — the same constitution the
   *  live Agent runs on, before the routine section is appended. */
  baseConstitution(): Promise<string>
  /** Registry tools filtered to consequence === 'read'. Listed to the model
   *  as its capabilities; anything else is refused by authorizeCapabilityCall
   *  because a routine's interaction is never registered as live. */
  readTools(): readonly { name: string; description: string }[]
  mcp(): AgentRunMcpContext
  environment: NodeJS.ProcessEnv
  randomId?: () => string
}

/**
 * Runs one routine as an independent, one-shot provider session — its own
 * runId, its own constitution file, no chat history. §4 "Executor".
 */
export class RoutineAgentExecutor implements RoutineExecutor {
  private readonly randomId: () => string
  private readonly onActivityByRun = new Map<string, (text: string) => void>()

  constructor(private readonly options: RoutineAgentExecutorOptions) {
    this.randomId = options.randomId ?? randomUUID
  }

  start(input: ExecuteInput): RoutineExecutorHandle {
    const agentRunId = this.randomId()
    const pair = input.definition.kind === 'takes-actions' ? this.options.actor : this.options.reader

    if (!pair) {
      const outcome: ExecuteOutcome = {
        outcome: 'failed',
        error: 'Takes-actions routines need Claude',
        agentRunId,
      }
      return { agentRunId, completion: Promise.resolve(outcome), cancel: async () => {} }
    }

    let cancelled = false
    const completion = this.run(agentRunId, input, pair, () => cancelled)

    return {
      agentRunId,
      completion,
      cancel: async () => {
        try {
          await pair.supervisor.interrupt(agentRunId)
        } catch {
          // The run has not been observed as accepted yet (or has already
          // settled): there is nothing live to interrupt. Remember the
          // intent so the eventual settle is still reported as cancelled,
          // and never let a cancel request throw.
          cancelled = true
        }
      },
    }
  }

  /** In service wiring, the routine controller's own `onActivity` option
   *  calls this for every activity event it emits, keyed by the agentRunId
   *  this executor minted for the run. */
  routeActivity(activity: AgentInteractionActivity): void {
    this.onActivityByRun.get(activity.agentRunId)?.(activity.summary)
  }

  async dispose(): Promise<void> {
    this.onActivityByRun.clear()
  }

  private async run(
    agentRunId: string,
    input: ExecuteInput,
    pair: RoutineRunPair,
    isCancelled: () => boolean,
  ): Promise<ExecuteOutcome> {
    this.onActivityByRun.set(agentRunId, input.onActivity)
    try {
      await fs.mkdir(input.runDir, { recursive: true })
      const constitutionPath = join(input.runDir, 'constitution.md')
      const constitution = `${await this.options.baseConstitution()}\n\n${routineConstitutionSection(input.definition)}`
      await fs.writeFile(constitutionPath, constitution, { mode: 0o600 })

      const runtime: AgentControllerRuntime = {
        cwd: input.runDir,
        constitutionPath,
        environment: this.options.environment,
        mcp: this.options.mcp(),
      }

      const references = input.run.trigger.type === 'approval' ? '' : await referenceContext(input.definition)
      const referencePath = join(input.runDir, 'references.jsonl')
      if (references) await fs.writeFile(referencePath, references, { mode: 0o600 })

      const result = await pair.controller.submit(
        { transcript: [input.transcript, ...(references ? [`Read the reference file snapshots and availability notes at ${referencePath}. This is the bounded reference context for this run.`] : [])].join('\n\n') },
        {
          interactionId: this.randomId(),
          runId: agentRunId,
          provider: input.provider,
          onAccepted: async () => {},
          runtime,
          capabilities: this.options.readTools().filter(tool => routineToolSelected(tool.name, input.definition)),
        },
      )

      if (isCancelled()) {
        return { outcome: 'interrupted', agentRunId, ...providerSessionId(result.providerSessionId) }
      }
      if (result.outcome === 'completed' && result.text) {
        return { outcome: 'completed', text: result.text, agentRunId, ...providerSessionId(result.providerSessionId) }
      }
      if (result.outcome === 'interrupted') {
        return { outcome: 'interrupted', agentRunId, ...providerSessionId(result.providerSessionId) }
      }
      return {
        outcome: 'failed',
        error: result.error?.message ?? 'The routine did not complete.',
        agentRunId,
        ...providerSessionId(result.providerSessionId),
      }
    } catch (error) {
      if (isCancelled()) return { outcome: 'interrupted', agentRunId }
      return { outcome: 'failed', error: error instanceof Error ? error.message : String(error), agentRunId }
    } finally {
      this.onActivityByRun.delete(agentRunId)
      // The run already settled above — a failure closing it here has
      // nothing left to report to, so it is deliberately swallowed rather
      // than turning a completed/failed routine result into a second error.
      void pair.supervisor.closeRun(agentRunId).catch(() => {})
    }
  }
}

export function routineToolSelected(name: string, d: RoutineDefinition): boolean {
  if (name.startsWith('memory_')) return d.inputs.includes('memory')
  if (name.startsWith('notetaker_')) return d.inputs.includes('meetings')
  if (name.startsWith('unmute_history_')) return d.inputs.includes('dictation')
  // index_search cannot filter by project/session. Scoped runs already have a
  // manifest, so do not advertise a whole-library search as an alternative.
  if (name === 'index_search' && d.context && (d.context.folders.length || d.context.sessionIds.length || d.context.excludedFolders.length || d.context.excludedSessionIds.length)) return false
  if (name === 'index_search' || name.startsWith('session') || name.startsWith('workspace')) return d.inputs.includes('sessions')
  return true
}

function providerSessionId(id: string | undefined): { providerSessionId: string } | Record<string, never> {
  return id ? { providerSessionId: id } : {}
}
