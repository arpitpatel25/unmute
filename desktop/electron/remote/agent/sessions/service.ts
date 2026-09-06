import type { SessionActionResult } from '../capabilities/sessions'
import type { LocatedSession } from './locate'
import { isReapedScratchCwd, planFork, planResume } from './resume'
import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '../../atomic-file'

interface ContinuationManager {
  setName?(id: string, name: string): void
  setGroup?(id: string, group: string): void
  list(): Array<{ id: string; sessionId: string; codexRolloutId?: string }>
  resume(taskId: string): Promise<boolean>
  deliverDraft(taskId: string, text: string, attachments: readonly string[]): Promise<boolean>
  attachProviderSession(input: {
    harness: 'claude' | 'codex'; sessionId: string; cwd: string; intent?: string; title?: string; group?: string
  }): Promise<{ taskId: string; sessionId: string }>
  forkProviderSession(input: {
    harness: 'claude' | 'codex'; sessionId: string; cwd: string; intent?: string; title?: string; group?: string
  }): Promise<{ taskId: string; sessionId: string }>
}

export interface AgentContinuationDeps {
  interactionId?(): string | undefined
  operationRoot?: string
  manager(): ContinuationManager | null
  locate(sessionId: string): Promise<LocatedSession | null>
  scratchRoot: string
  ensureDirectory(path: string): Promise<void>
}

export class AgentContinuationService {
  constructor(readonly deps: AgentContinuationDeps) {}
  private operations = new Map<string, Promise<SessionActionResult>>()
  private once(operation: string, sessionId: string, action: () => Promise<SessionActionResult>): Promise<SessionActionResult> {
    const interaction = this.deps.interactionId?.()
    if (!interaction) return action()
    const key = JSON.stringify([interaction, operation, sessionId])
    const previous = this.operations.get(key)
    if (previous) return previous
    const pending = this.recordOperation(key, action)
    this.operations.set(key, pending)
    // Bound retained completed interactions; retries in the current interaction stay pinned.
    if (this.operations.size > 256) this.operations.delete(this.operations.keys().next().value!)
    return pending
  }
  private async recordOperation(key: string, action: () => Promise<SessionActionResult>): Promise<SessionActionResult> {
    const root = this.deps.operationRoot
    if (!root) return action()
    await mkdir(root, { recursive: true, mode: 0o700 })
    const file = join(root, createHash('sha256').update(key).digest('hex') + '.json')
    let previous: { result?: SessionActionResult; error?: string } | undefined
    try { previous = JSON.parse(await readFile(file, 'utf8')) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if (previous) {
      if (previous.result) return previous.result
      throw new Error(previous.error || 'The prior continuation outcome is unknown. Do not create another fork; reconcile the existing operation first.')
    }
    await writeFileAtomic(file, JSON.stringify({ pending: true }))
    try {
      const result = await action()
      await writeFileAtomic(file, JSON.stringify({ result }))
      return result
    } catch (error) {
      await writeFileAtomic(file, JSON.stringify({ error: (error as Error).message }))
      throw error
    }
  }

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

  async resume(input: { sessionId: string; intent?: string; title?: string; group?: string }): Promise<SessionActionResult> {
    return this.once('resume', input.sessionId, () => this.resumeOnce(input))
  }
  private async resumeOnce(input: { sessionId: string; intent?: string; title?: string; group?: string }): Promise<SessionActionResult> {
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
      if (input.title?.trim()) manager.setName?.(plan.taskId, input.title.trim())
      if (input.group?.trim()) manager.setGroup?.(plan.taskId, input.group.trim())
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
    const result = await manager.attachProviderSession({ ...attachment, ...(input.title ? { title: input.title } : {}), ...(input.group ? { group: input.group } : {}) })
    if (result.sessionId !== input.sessionId) throw new Error('Resume changed the provider session identity')
    return {
      ...result, operation: 'resume', sourceSessionId: input.sessionId,
    }
  }

  async fork(input: { sessionId: string; intent?: string; title?: string; group?: string }): Promise<SessionActionResult> {
    return this.once('fork', input.sessionId, () => this.forkOnce(input))
  }
  private async forkOnce(input: { sessionId: string; intent?: string; title?: string; group?: string }): Promise<SessionActionResult> {
    const manager = this.manager()
    const located = await this.locate(input.sessionId)
    const plan = planFork({ located, ...(input.intent ? { intent: input.intent } : {}) })
    if (plan.action === 'refuse') throw new Error(plan.reason)
    await this.restoreScratch(plan.cwd)
    const { action: _action, ...fork } = plan
    const result = await manager.forkProviderSession({ ...fork, ...(input.title ? { title: input.title } : {}), ...(input.group ? { group: input.group } : {}) })
    if (result.sessionId === input.sessionId) throw new Error('Fork reused the source provider session identity')
    return {
      ...result, operation: 'fork', sourceSessionId: input.sessionId,
    }
  }
}
