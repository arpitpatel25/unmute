import type { SessionActionResult } from '../capabilities/sessions'
import type { LocatedSession } from './locate'
import { isReapedScratchCwd, planFork, planResume } from './resume'

interface ContinuationManager {
  list(): Array<{ id: string; sessionId: string; codexRolloutId?: string }>
  resume(taskId: string): Promise<boolean>
  deliverDraft(taskId: string, text: string, attachments: readonly string[]): Promise<boolean>
  attachProviderSession(input: {
    harness: 'claude' | 'codex'; sessionId: string; cwd: string; intent?: string
  }): Promise<{ taskId: string; sessionId: string }>
  forkProviderSession(input: {
    harness: 'claude' | 'codex'; sessionId: string; cwd: string; intent?: string
  }): Promise<{ taskId: string; sessionId: string }>
}

export interface AgentContinuationDeps {
  manager(): ContinuationManager | null
  locate(sessionId: string): Promise<LocatedSession | null>
  scratchRoot: string
  ensureDirectory(path: string): Promise<void>
}

export class AgentContinuationService {
  constructor(readonly deps: AgentContinuationDeps) {}

  private manager(): ContinuationManager {
    const manager = this.deps.manager()
    if (!manager) throw new Error('Unmute Remote is not initialized')
    return manager
  }

  private async locate(sessionId: string): Promise<LocatedSession> {
    const located = await this.deps.locate(sessionId)
    if (!located) throw new Error('That session is not on this machine')
    return located
  }

  private async restoreScratch(cwd: string): Promise<void> {
    if (isReapedScratchCwd(cwd, this.deps.scratchRoot)) await this.deps.ensureDirectory(cwd)
  }

  async resume(input: { sessionId: string; intent?: string }): Promise<SessionActionResult> {
    const manager = this.manager()
    const located = await this.locate(input.sessionId)
    const existing = manager.list().find(task =>
      task.sessionId === input.sessionId || task.codexRolloutId === input.sessionId)
    const plan = planResume({
      located,
      ...(existing ? { existingTaskId: existing.id } : {}),
      ...(input.intent ? { intent: input.intent } : {}),
    })
    if (plan.action === 'refuse') throw new Error(plan.reason)
    if (plan.action === 'wake') {
      if (!(await manager.resume(plan.taskId))) throw new Error('That session could not be resumed')
      if (plan.followUp && !(await manager.deliverDraft(plan.taskId, plan.followUp, []))) {
        throw new Error('The session resumed, but the current request could not be delivered')
      }
      return {
        taskId: plan.taskId, operation: 'resume',
        sourceSessionId: input.sessionId, sessionId: input.sessionId,
      }
    }
    await this.restoreScratch(plan.cwd)
    const { action: _action, ...attachment } = plan
    const result = await manager.attachProviderSession(attachment)
    if (result.sessionId !== input.sessionId) throw new Error('Resume changed the provider session identity')
    return {
      ...result, operation: 'resume', sourceSessionId: input.sessionId,
    }
  }

  async fork(input: { sessionId: string; intent?: string }): Promise<SessionActionResult> {
    const manager = this.manager()
    const located = await this.locate(input.sessionId)
    const plan = planFork({ located, ...(input.intent ? { intent: input.intent } : {}) })
    if (plan.action === 'refuse') throw new Error(plan.reason)
    await this.restoreScratch(plan.cwd)
    const { action: _action, ...fork } = plan
    const result = await manager.forkProviderSession(fork)
    if (result.sessionId === input.sessionId) throw new Error('Fork reused the source provider session identity')
    return {
      ...result, operation: 'fork', sourceSessionId: input.sessionId,
    }
  }
}
