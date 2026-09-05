import type { RuntimeRpcClient } from './rpc'
import type { AgentRuntimeConfig, AgentRuntimeEvent } from './agent-service'
import type { AgentConversationView } from '../agent/lifecycle'
import type { AgentInteractionActivity, AgentInteractionInput, AgentInteractionResult } from '../agent/controller'
import type { AgentProviderId } from '../agent/provider'
import type { EncryptedRecordStore } from '../agent/memory/record-store'
import type { MemoryService } from '../agent/memory/service'

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
  readonly supervisor = { interrupt: async (runId: string): Promise<void> => { await this.rpc.call('agent.interrupt', runId) } }
  constructor(private rpc: RuntimeRpcClient, private callbacks: { onView(view: AgentConversationView): void; onActivity(activity: AgentInteractionActivity): void }) {
    rpc.on('agent.event', this.receive)
  }
  private receive = (event: AgentRuntimeEvent): void => {
    if (event.kind === 'view') { this.current = event.view; this.callbacks.onView(event.view) }
    else if (event.kind === 'activity') this.callbacks.onActivity(event.activity)
    else { this.completed.set(event.submissionId, event.result); this.waiting.get(event.submissionId)?.(event.result); this.waiting.delete(event.submissionId) }
  }
  private restore(snapshot: { view?: AgentConversationView; activity?: AgentInteractionActivity; availability: unknown }): void {
    this.availability = snapshot.availability
    if (snapshot.view) this.receive({ kind: 'view', view: snapshot.view })
    if (snapshot.activity) this.receive({ kind: 'activity', activity: snapshot.activity })
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
  async setDraft(text: string, revision: number): Promise<void> { await this.rpc.call('agent.setDraft', text, revision) }
  async requestProvider(provider: AgentProviderId): Promise<void> { await this.rpc.call('agent.requestProvider', provider) }
  resumeQueued(): void { /* daemon drains its durable queue independently */ }
  dispose(): void { this.rpc.off('agent.event', this.receive) }
}
