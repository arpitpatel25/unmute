import type { RuntimeRpcClient } from './rpc'
import type { AgentRuntimeConfig, AgentRuntimeEvent } from './agent-service'
import type { AgentConversationView } from '../agent/lifecycle'
import type { AgentInteractionActivity, AgentInteractionInput, AgentInteractionResult } from '../agent/controller'
import type { AgentProviderId } from '../agent/provider'
import type { EncryptedRecordStore } from '../agent/memory/record-store'
import type { MemoryService } from '../agent/memory/service'
import type { RoutineService } from '../agent/routines/service'
import type { RoutineRun, RoutinesView } from '../agent/routines/types'

type Rpc<T extends (...args: any[]) => any> = (...args: Parameters<T>) => Promise<Awaited<ReturnType<T>>>

/** Disposable UI subscription; the daemon owns conversation and provider life. */
export class AgentRuntimeClient {
  private current?: AgentConversationView
  private waiting = new Map<string, (result: AgentInteractionResult) => void>()
  private completed = new Map<string, AgentInteractionResult>()
  availability: unknown
  readonly records: Pick<EncryptedRecordStore, 'list'> = { list: (...args) => this.rpc.call('agent.records.list', ...args) }
  readonly memory: Pick<MemoryService, 'get' | 'forget' | 'restore'> = {
    get: (...args) => this.rpc.call('agent.memory.get', ...args),
    forget: (...args) => this.rpc.call('agent.memory.forget', ...args),
    restore: (...args) => this.rpc.call('agent.memory.restore', ...args),
  }
  readonly routines: {
    view: Rpc<RoutineService['view']>; create: Rpc<RoutineService['create']>; update: Rpc<RoutineService['update']>
    remove: Rpc<RoutineService['remove']>; setEnabled: Rpc<RoutineService['setEnabled']>; runNow: Rpc<RoutineService['runNow']>
    event: Rpc<RoutineService['event']>; wake: Rpc<RoutineService['wake']>; cancel: Rpc<RoutineService['cancel']>
    proposal: Rpc<RoutineService['decideProposal']>; markRead: Rpc<RoutineService['markRead']>
    run(runId: string): Promise<{ run: RoutineRun; result: string | null } | null>
    path(id: string): Promise<string>; transcriptPath(runId: string): Promise<string | null>
  } = {
    view: (...args) => this.rpc.call('agent.routines.view', ...args),
    create: (...args) => this.rpc.call('agent.routines.create', ...args),
    update: (...args) => this.rpc.call('agent.routines.update', ...args),
    remove: (...args) => this.rpc.call('agent.routines.remove', ...args),
    setEnabled: (...args) => this.rpc.call('agent.routines.setEnabled', ...args),
    runNow: (...args) => this.rpc.call('agent.routines.runNow', ...args),
    event: (...args) => this.rpc.call('agent.routines.event', ...args),
    wake: (...args) => this.rpc.call('agent.routines.wake', ...args),
    cancel: (...args) => this.rpc.call('agent.routines.cancel', ...args),
    proposal: (...args) => this.rpc.call('agent.routines.proposal', ...args),
    markRead: (...args) => this.rpc.call('agent.routines.markRead', ...args),
    run: (...args) => this.rpc.call('agent.routines.run', ...args),
    path: (...args) => this.rpc.call('agent.routines.path', ...args),
    transcriptPath: (...args) => this.rpc.call('agent.routines.transcriptPath', ...args),
  }
  readonly supervisor = { interrupt: async (runId: string): Promise<void> => { await this.rpc.call('agent.interrupt', runId) } }
  constructor(private rpc: RuntimeRpcClient, private callbacks: { onView(view: AgentConversationView): void; onActivity(activity: AgentInteractionActivity): void; onRoutines?(view: RoutinesView): void }) {
    rpc.on('agent.event', this.receive)
  }
  private receive = (event: AgentRuntimeEvent): void => {
    if (event.kind === 'view') { this.current = event.view; this.callbacks.onView(event.view) }
    else if (event.kind === 'activity') this.callbacks.onActivity(event.activity)
    else if (event.kind === 'routines') this.callbacks.onRoutines?.(event.view)
    else { this.completed.set(event.submissionId, event.result); this.waiting.get(event.submissionId)?.(event.result); this.waiting.delete(event.submissionId) }
  }
  private restore(snapshot: { view?: AgentConversationView; activity?: AgentInteractionActivity; availability: unknown; routines?: RoutinesView }): void {
    this.availability = snapshot.availability
    if (snapshot.view) this.receive({ kind: 'view', view: snapshot.view })
    if (snapshot.activity) this.receive({ kind: 'activity', activity: snapshot.activity })
    if (snapshot.routines) this.receive({ kind: 'routines', view: snapshot.routines })
  }
  async configure(config: AgentRuntimeConfig): Promise<void> { this.restore(await this.rpc.call('agent.configure', config)) }
  async reconnect(): Promise<void> {
    this.restore(await this.rpc.call('agent.snapshot'))
    for (const [id, resolve] of this.waiting) {
      const result = await this.rpc.call<AgentInteractionResult | null>('agent.completion', id)
      if (result) { resolve(result); this.waiting.delete(id) }
    }
  }
  view(): AgentConversationView { if (!this.current) throw new Error('Agent conversation is connecting'); return this.current }
  async enqueue(input: AgentInteractionInput, draftRevision?: number): Promise<{ submissionId: string; completion: Promise<AgentInteractionResult> }> {
    const { submissionId } = await this.rpc.call<{ submissionId: string }>('agent.enqueue', input, draftRevision)
    const result = this.completed.get(submissionId)
    return { submissionId, completion: result ? Promise.resolve(result) : new Promise(resolve => this.waiting.set(submissionId, resolve)) }
  }
  async submit(input: AgentInteractionInput): Promise<AgentInteractionResult> { return (await this.enqueue(input)).completion }
  async retry(): Promise<AgentInteractionResult> { return this.rpc.call('agent.retry') }
  async discard(): Promise<{ discarded: boolean; reason?: string }> { return this.rpc.call('agent.discard') }
  async interrupt(): Promise<{ interrupted: boolean; reason?: string }> { return this.rpc.call('agent.interruptTurn') }
  async setDraft(text: string, revision: number): Promise<void> { await this.rpc.call('agent.setDraft', text, revision) }
  async requestProvider(provider: AgentProviderId): Promise<void> { await this.rpc.call('agent.requestProvider', provider) }
  resumeQueued(): void { /* daemon drains its durable queue independently */ }
  dispose(): void { this.rpc.off('agent.event', this.receive) }
}
