import type { SessionActionResult } from '../capabilities/sessions'
import { requireMainSession, type LocatedSession } from './locate'
import { resolveAgentMetadata, type WorkspaceRegistry, type MetadataSource } from '../metadata'
import { isReapedScratchCwd, planFork, planResume } from './resume'
import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '../../atomic-file'
import { diagnostic, diagnosticError } from '../../diagnostics'

interface ContinuationManager {
  setName?(id: string, name: string): void
  setGroup?(id: string, group: string): void
  list(): Array<{ id: string; sessionId: string; codexRolloutId?: string } & MetadataSource>
  resume(taskId: string): Promise<boolean>
  deliverDraft(taskId: string, text: string, attachments: readonly string[]): Promise<boolean>
  /** Park text in a card's composer when it could not be sent into the session. */
  saveDraft?(taskId: string, text: string): void
  /** Respawn a cold card's session. `resume()` marks it resumable; THIS wakes it. */
  opened?(taskId: string): void
  isLive?(taskId: string): boolean
  /** Bringing a session back is what un-hides it; see the notch's counterpart. */
  setShelved?(taskId: string, shelved: boolean): void
  setKind?(taskId: string, kind: 'oneoff' | 'session'): void
  attachProviderSession(input: {
    harness: 'claude' | 'codex'; sessionId: string; cwd: string; intent?: string; title?: string; group?: string; groupId?: string
  }): Promise<{ taskId: string; sessionId: string }>
  forkProviderSession(input: {
    harness: 'claude' | 'codex'; sessionId: string; cwd: string; intent?: string; title?: string; group?: string; groupId?: string
  }): Promise<{ taskId: string; sessionId: string }>
}

export interface AgentContinuationDeps {
  interactionId?(): string | undefined
  operationRoot?: string
  manager(): ContinuationManager | null
  locate(sessionId: string): Promise<LocatedSession | null>
  workspaces?(): WorkspaceRegistry | null
  scratchRoot: string
  ensureDirectory(path: string): Promise<void>
  /** Test seam: the delivery retry ladder, in milliseconds. */
  deliveryBackoffMs?: readonly number[]
}

export class AgentContinuationService {
  constructor(readonly deps: AgentContinuationDeps) {}
  private operations = new Map<string, Promise<SessionActionResult>>()
  private once(operation: string, sessionId: string, action: () => Promise<SessionActionResult>): Promise<SessionActionResult> {
    const interaction = this.deps.interactionId?.()
    if (!interaction) return action()
    const key = JSON.stringify([interaction, operation, sessionId])
    diagnostic('continuation-requested', { interactionId: interaction, operation, sourceSessionId: sessionId,
      operationId: createHash('sha256').update(key).digest('hex') })
    const previous = this.operations.get(key)
    if (previous) { diagnostic('continuation-retry-deduplicated', { interactionId: interaction, operation, sourceSessionId: sessionId }); return previous }
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
      diagnostic('continuation-result-persisted', { operationId: createHash('sha256').update(key).digest('hex'), result })
      return result
    } catch (error) {
      diagnostic('continuation-failed', { operationId: createHash('sha256').update(key).digest('hex'), ...diagnosticError(error) })
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
    requireMainSession(located)
    return located
  }

  private async restoreScratch(cwd: string): Promise<void> {
    if (isReapedScratchCwd(cwd, this.deps.scratchRoot)) await this.deps.ensureDirectory(cwd)
  }

  async resume(input: { sessionId: string; intent?: string; title?: string; group?: string }): Promise<SessionActionResult> {
    const located = await this.locate(input.sessionId)
    return this.once('resume', input.sessionId, () => this.resumeOnce(input, located))
  }
  private async resumeOnce(input: { sessionId: string; intent?: string; title?: string; group?: string }, located: LocatedSession): Promise<SessionActionResult> {
    const manager = this.manager()
    const existing = manager.list().find(task =>
      task.sessionId === input.sessionId || task.codexRolloutId === input.sessionId)
    const metadata = resolveAgentMetadata({ ...input, cwd: located.cwd }, this.deps.workspaces?.(), existing)
    const plan = planResume({
      located,
      ...(existing ? { existingTaskId: existing.id } : {}),
      ...(input.intent ? { intent: input.intent } : {}),
    })
    if (plan.action === 'refuse') throw new Error(plan.reason)
    if (plan.action === 'wake') {
      if (existing?.name !== metadata.title) manager.setName?.(plan.taskId, metadata.title)
      if (existing?.groupId !== metadata.groupId || existing?.group !== metadata.group) manager.setGroup?.(plan.taskId, metadata.group)
      if (!(await manager.resume(plan.taskId))) throw new Error('That session could not be resumed')
      // WAKING IS NOT THE SAME AS BEING READY TO LISTEN.
      //
      // `resume()` returns once the respawn is INITIATED, not once the session
      // can receive input, and delivery used to run on the very next line. A
      // cold Claude card therefore failed 85ms after the request — before its
      // PTY could exist — and the whole operation was reported as a failure
      // even though the session HAD reopened. It is not retryable, so the
      // Agent could only apologise and put the text on the clipboard.
      //
      // So: give it a bounded chance to come up, and if it still will not take
      // the message, PARK THE TEXT IN THAT CARD'S COMPOSER rather than losing
      // it. The person then finds their words where the conversation is, which
      // is the worst case worth having.
      // WAKE IT, THEN WAIT FOR IT.
      //
      // `resume()` returns true having spawned NOTHING: a cold Claude card is
      // respawned lazily by `opened()`, which until now only the UI called. So
      // an Agent-driven resume woke nothing, and the first version of this fix
      // politely retried for 6.6s against a session that only came alive 16s
      // later when the person opened the card by hand.
      manager.setShelved?.(plan.taskId, false)
      manager.opened?.(plan.taskId)
      // A RESUME THAT CARRIES A MESSAGE IS A THREAD, AND THREADS STAY IN THE
      // POCKET. Graduation normally waits for a SECOND follow-up, which is the
      // right rule for a task drifting into a conversation on its own. This is
      // not that: something deliberately went looking for this session and
      // brought work back to it, which is the whole definition. Leaving it a
      // one-off meant the card fell out of the pocket the moment it finished,
      // taking an undelivered message with it (2026-09-08).
      if (plan.followUp) manager.setKind?.(plan.taskId, 'session')
      if (plan.followUp) await this.waitUntilLive(plan.taskId)
      const delivered = plan.followUp ? await this.deliverWhenReady(plan.taskId, plan.followUp) : true
      return {
        taskId: plan.taskId, operation: 'resume',
        sourceSessionId: input.sessionId, sessionId: input.sessionId,
        ...(plan.followUp ? { delivered } : {}),
      }
    }
    await this.restoreScratch(plan.cwd)
    const { action: _action, ...attachment } = plan
    const result = await manager.attachProviderSession({ ...attachment, ...metadata })
    if (result.sessionId !== input.sessionId) throw new Error('Resume changed the provider session identity')
    return {
      ...result, operation: 'resume', sourceSessionId: input.sessionId,
    }
  }

  /**
   * Wait for a woken session to actually be alive.
   *
   * BOUNDED BY THE RPC, not by taste. The runtime's host call times out at
   * 30s (runtime/rpc.ts) and a timeout there reports "outcome is unknown",
   * which is a worse answer than parking the text. So this waits up to 20s
   * and leaves the rest of the budget to delivery — raise one and you must
   * lower the other.
   *
   * Returns whether it came up; delivery is attempted either way, since a
   * session can be live without this having observed it.
   */
  private async waitUntilLive(taskId: string): Promise<boolean> {
    const isLive = this.manager().isLive
    if (!isLive) return true
    const deadline = Date.now() + 20_000
    for (let attempt = 0; Date.now() < deadline; attempt++) {
      if (isLive.call(this.manager(), taskId)) {
        diagnostic('continuation-session-live', { taskId, waitedMs: 20_000 - (deadline - Date.now()), attempt })
        return true
      }
      await new Promise<void>(resolve => setTimeout(resolve, 400))
    }
    diagnostic('continuation-session-never-woke', { taskId, waitedMs: 20_000 })
    return false
  }

  /**
   * Deliver into a session that may still be waking.
   *
   * Bounded on purpose: a session that cannot take a message after this long
   * is not about to, and waiting further would hold a spoken request open with
   * nothing to show for it. The delays are short and few because the common
   * case is a PTY appearing, not a stuck runtime.
   */
  private async deliverWhenReady(taskId: string, text: string): Promise<boolean> {
    // Long enough to WAKE something, not just to catch it already awake. The
    // old ladder totalled five seconds, which was fine when this only ever ran
    // after a PTY had come up and hopeless for a chat session being connected
    // from cold — five failures and a parked draft, every time.
    const backoffMs = [0, 250, 750, 1_500, 2_500, 4_000, 6_000, 8_000]
    for (const wait of backoffMs) {
      if (wait) await new Promise<void>(resolve => setTimeout(resolve, wait))
      if (await this.manager().deliverDraft(taskId, text, []).catch(() => false)) {
        diagnostic('continuation-delivered', { taskId, afterMs: wait })
        return true
      }
    }
    // Never drop what they said. The composer is where they will look for it.
    try { this.manager().saveDraft?.(taskId, text) } catch { /* the card may have gone */ }
    diagnostic('continuation-delivery-deferred', { taskId, chars: text.length })
    return false
  }

  async fork(input: { sessionId: string; intent?: string; title?: string; group?: string }): Promise<SessionActionResult> {
    const located = await this.locate(input.sessionId)
    return this.once('fork', input.sessionId, () => this.forkOnce(input, located))
  }
  private async forkOnce(input: { sessionId: string; intent?: string; title?: string; group?: string }, located: LocatedSession): Promise<SessionActionResult> {
    const manager = this.manager()
    const source = manager.list().find(task => task.sessionId === input.sessionId || task.codexRolloutId === input.sessionId)
    const metadata = resolveAgentMetadata({ ...input, cwd: located.cwd }, this.deps.workspaces?.(), source)
    const plan = planFork({ located, ...(input.intent ? { intent: input.intent } : {}) })
    if (plan.action === 'refuse') throw new Error(plan.reason)
    await this.restoreScratch(plan.cwd)
    const { action: _action, ...fork } = plan
    const result = await manager.forkProviderSession({ ...fork, ...metadata })
    if (result.sessionId === input.sessionId) throw new Error('Fork reused the source provider session identity')
    return {
      ...result, operation: 'fork', sourceSessionId: input.sessionId,
    }
  }
}
