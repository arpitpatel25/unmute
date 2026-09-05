import { createHash, randomUUID } from 'node:crypto'
import { AGENT_TURN_CEILING } from './continuity'
import { AgentProviderError, type AgentProviderId } from './provider'
import type { AgentInteractionInput, AgentInteractionResult, AgentSubmissionContext } from './controller'
import type { AgentConversationRecord, AgentJournal, JournalAgentRun } from './journal'
import type { AgentConversationSnapshot, AgentConversationStore, AgentPendingSettlement } from './conversation-store'

export interface AgentConversationView { record: AgentConversationRecord; snapshot: AgentConversationSnapshot }
interface Options {
  journal: Pick<AgentJournal, 'read' | 'checkpointConversation'>
  store: Pick<AgentConversationStore, 'write' | 'read' | 'remove' | 'established' | 'markEstablished' | 'writeSettlement' | 'readSettlement' | 'clearSettlement'>
  controller: { submit(input: AgentInteractionInput, context: AgentSubmissionContext): Promise<AgentInteractionResult> }
  selectedProvider(): AgentProviderId
  ceiling?(): number
  prepareFresh(): Promise<void>
  pin(ids: string[]): void
  close(id: string): Promise<void>
  onView?(view: AgentConversationView): void
}
interface Waiting { promise: Promise<AgentInteractionResult>; resolve(result: AgentInteractionResult): void }
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

/** Metadata writes are serialized separately from provider work so new input can
 * be durably queued while the current turn runs. Only drain owns provider sends. */
export class AgentConversationLifecycle {
  private record!: AgentConversationRecord
  private snapshot!: AgentConversationSnapshot
  private initialization?: Promise<void>
  private mutation = Promise.resolve()
  private draining = false
  private stopped = false
  private waiting = new Map<string, Waiting>()
  private pendingSettlement: AgentPendingSettlement | null = null
  constructor(private readonly options: Options) {}

  initialize(): Promise<void> {
    return this.initialization ??= this.restore().catch(error => { this.initialization = undefined; throw error })
  }
  view(): AgentConversationView {
    const view = structuredClone({ record: this.record, snapshot: this.snapshot })
    if (this.pendingSettlement) {
      applySettlement(view, this.pendingSettlement)
      view.snapshot.settlementPending = true
      view.snapshot.error = 'The completed response is retained. Retry saves it without sending the message again.'
    }
    return view
  }
  /** Called only after the host publishes its scoped MCP/token runtime. */
  resumeQueued(): void { void this.initialize().then(() => this.drain()).catch(() => {}) }

  async submit(input: AgentInteractionInput): Promise<AgentInteractionResult> {
    const queued = await this.enqueue(input)
    return queued.completion
  }

  async enqueue(input: AgentInteractionInput, draftRevision?: number): Promise<{ submissionId: string; completion: Promise<AgentInteractionResult> }> {
    await this.initialize()
    const submissionId = input.submissionId ?? randomUUID()
    if (!ID.test(submissionId) || typeof input.transcript !== 'string' || !input.transcript.trim()) throw new Error('Invalid Agent input')
    let completion!: Promise<AgentInteractionResult>
    await this.lock(async () => {
      this.assertLive()
      const existing = this.waiting.get(submissionId)
      if (this.pendingSettlement?.submissionId === submissionId) { completion = Promise.resolve(structuredClone(this.pendingSettlement.result)); return }
      const saved = this.snapshot.results?.[submissionId]
      if (existing) { completion = existing.promise; return }
      if (saved) { completion = Promise.resolve(structuredClone(saved)); return }
      if (this.record.accepted.some(a => a.submissionId === submissionId) || retired(this.record.retired, submissionId)) {
        completion = Promise.resolve(failure('This submission was already accepted; it will not be replayed.', 'run-unavailable')); return
      }
      if (input.priorRunId && input.priorRunId !== this.record.runId) {
        completion = Promise.resolve(failure('That Agent conversation is not the current conversation.', 'run-unavailable')); return
      }
      const snapshot = structuredClone(this.snapshot)
      if (!snapshot.queued.some(q => q.submissionId === submissionId)) snapshot.queued.push({ submissionId, input: structuredClone({ ...input, submissionId }) })
      if (draftRevision !== undefined && snapshot.draft.revision === draftRevision && snapshot.draft.text.trim() === input.transcript.trim()) snapshot.draft.text = ''
      await this.publish(this.record, snapshot)
      const waiter = waiting(); this.waiting.set(submissionId, waiter); completion = waiter.promise
      if (this.record.phase === 'recovery-required' || this.snapshot.error) {
        this.finish(submissionId, failure(this.snapshot.error ?? 'Agent recovery is required.', this.record.phase === 'recovery-required' ? 'acceptance-uncertain' : 'interaction-failed'))
      }
    })
    void this.drain()
    return { submissionId, completion }
  }

  async setDraft(text: string, revision: number): Promise<void> {
    await this.initialize()
    if (typeof text !== 'string' || !Number.isSafeInteger(revision) || revision < 0) throw new Error('Invalid Agent draft')
    await this.lock(async () => {
      this.assertLive()
      if (revision < this.snapshot.draft.revision) return
      const snapshot = structuredClone(this.snapshot)
      snapshot.draft = { text, revision }
      await this.publish(this.record, snapshot)
    })
  }

  async requestProvider(provider: AgentProviderId): Promise<void> {
    await this.initialize()
    if (provider !== 'claude' && provider !== 'codex') throw new Error('Invalid Agent provider')
    await this.lock(async () => {
      const record = { ...this.record }
      record.pendingProvider = provider
      await this.publish(record, this.snapshot)
    })
  }

  async retry(): Promise<AgentInteractionResult> {
    await this.initialize()
    let completion!: Promise<AgentInteractionResult>
    await this.lock(async () => {
      if (this.pendingSettlement) {
        const result = this.pendingSettlement.result
        try { await this.settlePending() } catch { this.options.onView?.(this.view()) }
        completion = Promise.resolve(result)
        return
      }
      if (this.record.phase === 'recovery-required') { completion = Promise.resolve(failure(this.snapshot.error ?? 'Agent recovery is required.', 'acceptance-uncertain')); return }
      const first = this.snapshot.queued[0]
      if (!first) { completion = Promise.resolve(failure('No retained Agent input to retry.')); return }
      const snapshot = { ...this.snapshot }; delete snapshot.error
      await this.publish(this.record, snapshot)
      let waiter = this.waiting.get(first.submissionId)
      if (!waiter) { waiter = waiting(); this.waiting.set(first.submissionId, waiter) }
      completion = waiter.promise
    })
    void this.drain()
    return completion
  }

  dispose(): void {
    this.stopped = true
    for (const [id] of this.waiting) this.finish(id, failure('The Agent stopped. Its conversation and input are retained.', 'agent-shutdown'))
  }

  private async restore(): Promise<void> {
    const state = await this.options.journal.read()
    if (!state.conversation) {
      if (await this.options.store.established()) throw new Error('The established Agent recovery journal is missing.')
      this.record = { generation: 1, phase: 'ready', runId: null, provider: null, ceiling: this.ceiling(), effort: 'medium', accepted: [], snapshotId: 'initial' }
      this.snapshot = { generation: 1, chat: { runId: null, turns: [] }, draft: { text: '', revision: 0 }, queued: [], results: {} }
      await this.publish(this.record, this.snapshot)
      // No provider turn can enter until both first publication and this marker succeed.
      await this.options.store.markEstablished()
      return
    }
    this.record = state.conversation
    this.snapshot = await this.options.store.read(this.record.snapshotId)
    if (this.snapshot.generation !== this.record.generation || this.snapshot.chat.runId !== this.record.runId
      || (this.record.runId && !state.runs.some(r => r.id === this.record.runId && r.provider === this.record.provider && r.providerHandle))) throw new Error('Agent conversation recovery identity is invalid.')
    await this.options.store.markEstablished()
    this.pendingSettlement = await this.options.store.readSettlement()
    if (this.pendingSettlement) {
      const pending = this.pendingSettlement
      if (pending.generation !== this.record.generation || pending.runId !== this.record.runId
        || !this.record.accepted.some(a => a.submissionId === pending.submissionId)) throw new Error('Pending Agent settlement identity is invalid.')
      try { await this.settlePending() } catch { this.options.onView?.(this.view()) }
      return
    }
    if (this.record.prepared) {
      this.record.phase = 'recovery-required'
      this.snapshot.error = 'A previous submission may have reached the provider. Input is retained; automatic replay is disabled.'
    } else {
      for (const accepted of this.record.accepted) {
        if (accepted.outcome) continue
        accepted.outcome = 'interrupted'
        this.snapshot.chat.turns.push({ role: 'agent', text: 'The Agent was interrupted during restart.', at: Date.now(), failed: true })
      }
      this.record.phase = this.record.accepted.length >= this.record.ceiling ? 'reset-due' : 'ready'
    }
    await this.publish(this.record, this.snapshot)
  }

  private async drain(): Promise<void> {
    if (this.draining || this.stopped) return
    this.draining = true
    try {
      while (!this.stopped && !this.pendingSettlement && this.snapshot.queued.length && !this.snapshot.error && this.record.phase !== 'recovery-required') await this.turn()
    } catch {
      if (!this.stopped) {
        this.snapshot.error = 'The Agent conversation could not be saved. Input has been retained; retry after storage recovers.'
        this.options.onView?.(this.view())
        for (const [id] of this.waiting) this.finish(id, failure(this.snapshot.error, 'journal-unavailable'))
      }
    } finally { this.draining = false }
  }

  private async turn(): Promise<void> {
    let prepared!: NonNullable<AgentConversationRecord['prepared']>
    let input!: AgentInteractionInput
    let provider!: AgentProviderId
    let fresh = false
    await this.lock(async () => {
      this.assertLive()
      const first = this.snapshot.queued[0]
      input = structuredClone(first.input)
      fresh = !this.record.runId || this.record.accepted.length >= this.record.ceiling || !!this.record.pendingProvider
      provider = this.record.pendingProvider ?? this.record.provider ?? this.options.selectedProvider()
      prepared = { submissionId: first.submissionId, interactionId: randomUUID(), candidateRunId: fresh ? randomUUID() : this.record.runId!, generation: fresh && this.record.runId ? this.record.generation + 1 : this.record.generation }
      await this.publish({ ...this.record, prepared }, this.snapshot)
    })
    let accepted = false
    let acceptanceUncertain = false
    let result: AgentInteractionResult
    try {
      if (fresh) await this.options.prepareFresh()
      this.assertLive()
      result = await this.options.controller.submit({ ...input, priorRunId: fresh ? undefined : prepared.candidateRunId }, {
        interactionId: prepared.interactionId, runId: prepared.candidateRunId, provider,
        onAccepted: async run => {
          await this.lock(async () => {
            this.assertPrepared(prepared)
            if (run.id !== prepared.candidateRunId || run.provider !== provider || !run.providerHandle) throw new AgentProviderError('acceptance-uncertain')
            const oldRun = this.record.runId
            const record = structuredClone(this.record)
            const snapshot = structuredClone(this.snapshot)
            if (fresh) {
              record.retired = retire(record.retired, record.accepted.map(a => a.submissionId))
              record.accepted = []
              record.generation = prepared.generation
              record.ceiling = this.ceiling()
              snapshot.generation = prepared.generation
              snapshot.chat = { runId: run.id, turns: [] }
              snapshot.results = {}
              if (oldRun) snapshot.notice = record.pendingProvider
                ? `Switched to ${provider === 'claude' ? 'Claude' : 'Codex'} — new conversation`
                : `Conversation cleared after ${this.record.ceiling} messages`
              if (record.pendingProvider === provider) delete record.pendingProvider
            }
            record.runId = run.id; record.provider = run.provider; record.model = run.model
            record.accepted.push({ submissionId: prepared.submissionId, interactionId: prepared.interactionId, acceptedAt: Date.now() })
            record.phase = 'sending'; delete record.prepared
            snapshot.chat.runId = run.id
            snapshot.chat.turns.push({ role: 'user', text: input.transcript, at: Date.now() })
            snapshot.queued = snapshot.queued.filter(q => q.submissionId !== prepared.submissionId)
            delete snapshot.error
            try { await this.publish(record, snapshot, [run]) }
            catch {
              acceptanceUncertain = true
              throw new AgentProviderError('acceptance-uncertain')
            }
            accepted = true
            if (oldRun && oldRun !== run.id) void this.options.close(oldRun).catch(() => {})
          })
        },
      })
    } catch (error) {
      result = failure(error instanceof AgentProviderError ? error.message : 'The Agent could not initialize. Input has been retained.', error instanceof AgentProviderError && error.code === 'acceptance-uncertain' ? 'acceptance-uncertain' : 'interaction-failed')
    }
    if (this.stopped) return
    if (acceptanceUncertain) result = failure('Provider acceptance could not be saved. Input is retained; automatic replay is disabled.', 'acceptance-uncertain')
    await this.lock(async () => {
      this.assertLive()
      const record = structuredClone(this.record), snapshot = structuredClone(this.snapshot)
      if (accepted) {
        if (record.generation !== prepared.generation || record.runId !== prepared.candidateRunId) return
        const submission = record.accepted.find(a => a.submissionId === prepared.submissionId)
        if (!submission || submission.outcome) return
        result = { ...result, provider: record.provider!, model: record.model }
        this.pendingSettlement = { generation: record.generation, runId: record.runId!, submissionId: prepared.submissionId, at: Date.now(), result }
        try { await this.settlePending() } catch { this.options.onView?.(this.view()) }
        this.finish(prepared.submissionId, result)
        return
      } else {
        this.assertPrepared(prepared)
        snapshot.error = result.error?.message ?? 'The Agent could not initialize. Input has been retained.'
        if (result.error?.code === 'acceptance-uncertain' || result.error?.code === 'journal-unavailable') record.phase = 'recovery-required'
        else { delete record.prepared; record.phase = record.accepted.length >= record.ceiling ? 'reset-due' : 'ready' }
      }
      await this.publish(record, snapshot)
      this.finish(prepared.submissionId, result)
    })
  }

  private async settlePending(): Promise<void> {
    this.assertLive()
    const pending = this.pendingSettlement
    if (!pending) return
    // This recovery file precedes the terminal snapshot/journal checkpoint.
    // If all storage is unavailable, pending also remains in memory for retry.
    await this.options.store.writeSettlement(pending)
    const next = structuredClone({ record: this.record, snapshot: this.snapshot })
    applySettlement(next, pending)
    delete next.snapshot.error
    await this.publish(next.record, next.snapshot)
    await this.options.store.clearSettlement()
    this.pendingSettlement = null
    this.options.onView?.(this.view())
  }

  private async publish(record: AgentConversationRecord, snapshot: AgentConversationSnapshot, runs: JournalAgentRun[] = []): Promise<void> {
    this.assertLive()
    const previous = this.record?.snapshotId
    const snapshotId = await this.options.store.write(snapshot)
    this.assertLive()
    const next = { ...record, snapshotId }
    await this.options.journal.checkpointConversation({ conversation: next, runs })
    this.record = structuredClone(next); this.snapshot = structuredClone(snapshot)
    this.options.pin([next.runId, next.prepared?.candidateRunId].filter((id): id is string => !!id))
    if (!this.stopped) {
      try { this.options.onView?.(this.view()) } catch { /* UI failure cannot undo durable provider acceptance. */ }
    }
    if (previous && previous !== 'initial' && previous !== snapshotId) await this.options.store.remove(previous)
  }
  private lock<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.mutation.then(operation)
    this.mutation = next.then(() => {}, () => {})
    return next
  }
  private assertLive(): void { if (this.stopped) throw new Error('Agent lifecycle stopped; stale callback ignored.') }
  private assertPrepared(p: NonNullable<AgentConversationRecord['prepared']>): void {
    this.assertLive()
    if (this.record.prepared?.generation !== p.generation || this.record.prepared?.submissionId !== p.submissionId) throw new Error('Stale Agent acceptance ignored.')
  }
  private finish(id: string, result: AgentInteractionResult): void { this.waiting.get(id)?.resolve(result); this.waiting.delete(id) }
  private ceiling(): number { const n = this.options.ceiling?.() ?? AGENT_TURN_CEILING; if (!Number.isSafeInteger(n) || n < 1) throw new Error('Invalid Agent conversation ceiling'); return n }
}

function applySettlement(view: AgentConversationView, pending: AgentPendingSettlement): void {
  const accepted = view.record.accepted.find(a => a.submissionId === pending.submissionId)
  if (!accepted || view.record.generation !== pending.generation || view.record.runId !== pending.runId) throw new Error('Pending Agent settlement identity is invalid.')
  if (!view.snapshot.results?.[pending.submissionId]) {
    view.snapshot.chat.turns.push({ role: 'agent', text: pending.result.text ?? pending.result.error?.message ?? 'Done.', at: pending.at, ...(pending.result.outcome !== 'completed' ? { failed: true } : {}) })
  }
  view.snapshot.results = { ...view.snapshot.results, [pending.submissionId]: pending.result }
  accepted.outcome = pending.result.outcome
  view.record.phase = view.record.accepted.length >= view.record.ceiling ? 'reset-due' : 'ready'
}

function waiting(): Waiting { let resolve!: Waiting['resolve']; const promise = new Promise<AgentInteractionResult>(r => { resolve = r }); return { promise, resolve } }
function failure(message: string, code: NonNullable<AgentInteractionResult['error']>['code'] = 'interaction-failed'): AgentInteractionResult {
  return { interactionId: '', agentRunId: '', source: 'provider', outcome: 'failed', presentation: 'transient', error: { code, message } }
}
function bits(id: string): number[] { const hash = createHash('sha256').update(id).digest(); return [0, 4, 8, 12].map(i => hash.readUInt32BE(i) % 32768) }
function retired(filter: string | undefined, id: string): boolean { if (!filter) return false; const bytes = Buffer.from(filter, 'hex'); return bits(id).every(b => (bytes[b >> 3] & (1 << (b & 7))) !== 0) }
function retire(filter: string | undefined, ids: string[]): string { const bytes = filter ? Buffer.from(filter, 'hex') : Buffer.alloc(4096); for (const id of ids) for (const b of bits(id)) bytes[b >> 3] |= 1 << (b & 7); return bytes.toString('hex') }
