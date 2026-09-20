import { createHash, randomUUID } from 'node:crypto'
import { AGENT_TURN_CEILING } from './continuity'
import { AgentProviderError, type AgentProviderId } from './provider'
import type { AgentConversationHandoff, AgentInteractionInput, AgentInteractionResult, AgentSubmissionContext } from './controller'
import type { AgentConversationRecord, AgentJournal, JournalAgentRun } from './journal'
import type { AgentConversationSnapshot, AgentConversationStore, AgentPendingSettlement } from './conversation-store'
import { diagnostic } from '../diagnostics'

export interface AgentConversationView { record: AgentConversationRecord; snapshot: AgentConversationSnapshot; selectedProvider?: AgentProviderId }
interface Options {
  journal: Pick<AgentJournal, 'read' | 'checkpointConversation'>
  store: Pick<AgentConversationStore, 'write' | 'read' | 'remove' | 'established' | 'markEstablished' | 'writeSettlement' | 'readSettlement' | 'clearSettlement'>
  controller: { submit(input: AgentInteractionInput, context: AgentSubmissionContext): Promise<AgentInteractionResult> }
  selectedProvider(): AgentProviderId
  ceiling?(): number
  idleMs?: number
  now?(): number
  prepareFresh(): Promise<void>
  pin(ids: string[]): void
  close(id: string): Promise<void>
  /** Signal the running provider turn to end — supervisor.interrupt. */
  interrupt(id: string): Promise<void>
  onView?(view: AgentConversationView): void
  /** Another installed, usable provider to continue on when this one cannot
   *  answer at all — or undefined when switching is off or impossible. */
  alternateProvider?(current: AgentProviderId): AgentProviderId | undefined
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
  private rotationDue = false
  /** A Stop that arrived before the run existed, held for the moment it does. */
  private interruptRequested: string | null = null
  constructor(private readonly options: Options) {}
  /** Submissions re-sent to another provider, with why — said with the answer
   *  and never re-sent a second time. */
  private readonly switched = new Map<string, string>()

  /**
   * WHEN A PROVIDER CANNOT ANSWER, THE CHAT MUST NOT STAY BLOCKED.
   *
   * Model fallback inside the provider comes first (its drivers try the next
   * model). This is the step after: every model of that provider unavailable,
   * or the provider itself missing. If switching is allowed and another
   * provider works, the message goes there — a new conversation with the usual
   * handoff, exactly as a manual provider switch — and the answer says why.
   * The user's provider setting is never changed.
   */
  private switchTarget(result: AgentInteractionResult, from: AgentProviderId, submissionId: string): { to: AgentProviderId; why: string } | undefined {
    if (result.outcome !== 'failed' || this.switched.has(submissionId)) return undefined
    const code = result.error?.code
    if (code !== 'model-unavailable' && code !== 'provider-unavailable') return undefined
    const to = this.options.alternateProvider?.(from)
    if (!to || to === from) return undefined
    const detail = code === 'provider-unavailable' ? 'is unavailable' : `could not answer${/\(([^)]+)\)/.exec(result.error?.message ?? '')?.[1] ? ` (${/\(([^)]+)\)/.exec(result.error!.message)![1]})` : ''}`
    return { to, why: `${providerName(from)} ${detail}, so ${providerName(to)} answered. This conversation continues on ${providerName(to)}; your default is unchanged.` }
  }

  initialize(): Promise<void> {
    return this.initialization ??= this.restore().catch(error => { this.initialization = undefined; throw error })
  }
  view(): AgentConversationView {
    const view = structuredClone({
      record: this.record,
      snapshot: this.snapshot,
      selectedProvider: this.record.pendingProvider ?? this.record.provider ?? this.options.selectedProvider(),
    })
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
      if (this.snapshot.retryRequired) {
        completion = Promise.resolve(failure('Retry or discard the retained Agent message before sending another.', 'interaction-failed')); return
      }
      const snapshot = structuredClone(this.snapshot)
      // Prepare lazily on the next interaction: no provider is started solely
      // because a timer fired. Work and queued input can never be split by idle.
      // WHY THIS IS OR IS NOT THE SAME CONVERSATION, written down.
      //
      // The log said `session: "resume"` and never why, so answering "why did
      // it still have yesterday's context" meant reading two constants and
      // doing the arithmetic by hand. Both gates have to pass to rotate, and
      // being one gate short is the interesting case — it is what makes a
      // conversation feel like it should have ended and did not.
      const idleMs = this.options.idleMs ?? 20 * 60_000
      const idleFor = this.now() - (snapshot.lastActivityAt ?? this.now())
      const blocked = this.draining || this.pendingSettlement || !!snapshot.queued.length
        || !!snapshot.draft.text.trim() || !!this.record.prepared || this.record.phase === 'recovery-required'
      const atCeiling = this.record.accepted.length >= this.record.ceiling
      const idleEnough = idleFor >= idleMs
      if (!blocked && atCeiling && idleEnough) this.rotationDue = true
      diagnostic('agent-continuity-decision', {
        rotate: this.rotationDue,
        turns: this.record.accepted.length, ceiling: this.record.ceiling, atCeiling,
        idleForMs: idleFor, idleMs, idleEnough,
        ...(blocked ? { blocked: true } : {}),
        reason: this.rotationDue ? 'ceiling-and-idle'
          : blocked ? 'work-in-flight'
          : !atCeiling && !idleEnough ? 'under-ceiling-and-recently-active'
          : !atCeiling ? 'under-ceiling'
          : 'recently-active',
      })
      snapshot.lastActivityAt = this.now()
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
      snapshot.lastActivityAt = this.now()
      await this.publish(this.record, snapshot)
    })
  }

  async requestProvider(provider: AgentProviderId): Promise<void> {
    await this.initialize()
    if (provider !== 'claude' && provider !== 'codex') throw new Error('Invalid Agent provider')
    await this.lock(async () => {
      const record = { ...this.record }
      const snapshot = structuredClone(this.snapshot)
      const current = record.pendingProvider ?? record.provider ?? this.options.selectedProvider()
      if (provider === current) return
      record.pendingProvider = provider
      if (record.phase !== 'recovery-required' && snapshot.error) {
        delete snapshot.error
        // A provider switch is an explicit fresh-conversation boundary. A
        // recoverable failed submission belongs to the provider that rejected
        // it; retaining it here deadlocks the new provider because enqueue()
        // refuses every new message while retryRequired is set.
        snapshot.queued = []
        delete snapshot.retryRequired
        snapshot.notice = `Provider changed to ${providerName(provider)}. The next message starts a new conversation.`
      }
      await this.publish(record, snapshot)
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
      delete snapshot.retryRequired
      await this.publish(this.record, snapshot)
      let waiter = this.waiting.get(first.submissionId)
      if (!waiter) { waiter = waiting(); this.waiting.set(first.submissionId, waiter) }
      completion = waiter.promise
    })
    void this.drain()
    return completion
  }

  /**
   * STOP THE TURN THAT IS RUNNING.
   *
   * Every other chat in the app has had a Stop at the send position; this one
   * did not, because nothing connected a surface to `supervisor.interrupt`.
   * The provider path has always worked — the driver takes a SIGINT and the
   * turn comes back `interrupted` — it simply had no caller.
   *
   * ONLY `sending` CAN BE SIGNALLED. A settled turn is already over and its run
   * may have been closed out from under us, so signalling it would send a stale
   * id into the supervisor and get back an error for something the user cannot
   * act on. A PREPARED turn is the interesting case and is handled below.
   *
   * NOTHING IS UNDONE HERE. The message stays in the chat as a turn that was
   * stopped, exactly as it would after any other failure, and the queue is left
   * alone: stopping is not a retry, and re-sending what somebody just stopped
   * is the one thing they did not ask for.
   */
  async interrupt(): Promise<{ interrupted: boolean; reason?: string }> {
    await this.initialize()
    const runId = this.record.runId
    if (runId && this.record.phase === 'sending') {
      try { await this.options.interrupt(runId) } catch (error) {
        // REPORTED, NOT THROWN. This is a button; the worst honest outcome is
        // that the turn finishes on its own, which needs no dialog.
        diagnostic('agent-turn-interrupt-refused', { runId, reason: (error as Error).message })
        return { interrupted: false, reason: (error as Error).message }
      }
      diagnostic('agent-turn-interrupted', { runId, generation: this.record.generation })
      return { interrupted: true }
    }
    // STOP PRESSED WHILE THE PROVIDER IS STILL STARTING. There is no run to
    // signal yet and the window is a real one — spawning a CLI takes seconds —
    // so it is HELD rather than refused. Refusing would make the button do
    // nothing for exactly as long as the wait that makes people press it.
    const prepared = this.record.prepared
    if (prepared) {
      this.interruptRequested = prepared.submissionId
      diagnostic('agent-turn-interrupt-held', { submissionId: prepared.submissionId })
      return { interrupted: true }
    }
    return { interrupted: false, reason: 'nothing is running' }
  }

  /**
   * END THIS CONVERSATION AND KEEP NOTHING.
   *
   * There is exactly ONE Agent conversation at a time, and until now the only
   * ways out of it were to burn twenty turns or leave it alone for six hours.
   * A persistent chat you cannot deliberately end is one you can only escape
   * by waiting, and "start again" is an ordinary thing to want — after a wrong
   * turn, before a different subject, or to see what it does with no context.
   *
   * The next submission starts a genuinely new provider session, because the
   * record it would have resumed from is gone: `runId: null` is what makes
   * controller.submit() take supervisor.start() instead of resume().
   *
   * Work in flight is refused rather than abandoned — discarding a
   * conversation whose turn is still running would leave a provider process
   * writing into a record nothing points at any more.
   */
  async discard(): Promise<{ discarded: boolean; reason?: string }> {
    // NOT `draining`: that flag is the drain loop's own, and it is still true
    // for a moment after the caller's promise has resolved — testing it would
    // refuse a discard requested the instant a turn finished. What matters is
    // unsettled WORK: somebody still waiting on a result, input not yet sent,
    // or an acceptance whose outcome we do not know.
    if (this.waiting.size || this.snapshot.queued.length || this.pendingSettlement) {
      return { discarded: false, reason: 'a turn is still running' }
    }
    const previous = this.record.snapshotId
    this.rotationDue = false
    this.record = { generation: this.record.generation + 1, phase: 'ready', runId: null, provider: null,
      ceiling: this.ceiling(), effort: this.record.effort, accepted: [], snapshotId: 'initial' }
    this.snapshot = { generation: this.record.generation, chat: { runId: null, turns: [] },
      draft: { text: '', revision: 0 }, queued: [], results: {} }
    await this.publish(this.record, this.snapshot)
    // Only after the new record is durable: a crash between these two leaves a
    // pointer to a snapshot that still exists, which recovers; the reverse does not.
    if (previous && previous !== 'initial') await this.options.store.remove(previous).catch(() => {})
    await this.options.prepareFresh()
    diagnostic('agent-conversation-discarded', { generation: this.record.generation, previousSnapshotId: previous })
    return { discarded: true }
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
    this.snapshot.lastActivityAt ??= this.now()
    // Only an earlier build's provider switch ever set retryRequired: it kept
    // the failed message and refused every new one until it was retried. A
    // switch now discards that message, so settle the leftover the same way.
    if (this.snapshot.retryRequired) {
      this.snapshot.queued = []
      delete this.snapshot.retryRequired
    }
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
      while (!this.stopped && !this.pendingSettlement && this.snapshot.queued.length && !this.snapshot.error && !this.snapshot.retryRequired && this.record.phase !== 'recovery-required') await this.turn()
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
      fresh = !this.record.runId || this.rotationDue || !!this.record.pendingProvider
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
        ...(fresh && this.record.runId ? { carryoverRunId: this.record.runId } : {}),
        ...(fresh && this.record.runId && this.record.provider
          ? { handoff: conversationHandoff(this.snapshot, this.record.provider) }
          : {}),
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
              snapshot.chat.runId = run.id
              snapshot.results = {}
              if (oldRun) snapshot.notice = record.pendingProvider
                ? `Switched to ${provider === 'claude' ? 'Claude' : 'Codex'} — new conversation`
                : `Started a fresh conversation after idle; earlier messages retained`
              if (record.pendingProvider === provider) delete record.pendingProvider
            }
            record.runId = run.id; record.provider = run.provider; record.model = run.model
            record.accepted.push({ submissionId: prepared.submissionId, interactionId: prepared.interactionId, acceptedAt: Date.now() })
            record.phase = 'sending'; delete record.prepared
            snapshot.chat.runId = run.id
            snapshot.chat.turns.push({ role: 'user', text: input.transcript, at: Date.now() })
            snapshot.queued = snapshot.queued.filter(q => q.submissionId !== prepared.submissionId)
            delete snapshot.error
            delete snapshot.retryRequired
            try { await this.publish(record, snapshot, [run]) }
            catch {
              acceptanceUncertain = true
              throw new AgentProviderError('acceptance-uncertain')
            }
            accepted = true
            if (fresh) this.rotationDue = false
            if (oldRun && oldRun !== run.id) void this.options.close(oldRun).catch(() => {})
            // The Stop that arrived while this was starting, delivered now that
            // there is something to deliver it to.
            if (this.interruptRequested === prepared.submissionId) {
              this.interruptRequested = null
              diagnostic('agent-turn-interrupted', { runId: run.id, generation: record.generation, held: true })
              void this.options.interrupt(run.id).catch(() => {})
            }
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
      // A held Stop belongs to THIS turn. One that was never delivered — the
      // turn failed to start — must not fire at whatever runs next.
      if (this.interruptRequested === prepared.submissionId) this.interruptRequested = null
      const record = structuredClone(this.record), snapshot = structuredClone(this.snapshot)
      if (accepted) {
        if (record.generation !== prepared.generation || record.runId !== prepared.candidateRunId) return
        const submission = record.accepted.find(a => a.submissionId === prepared.submissionId)
        if (!submission || submission.outcome) return
        result = { ...result, provider: record.provider!, model: record.model }
        const why = this.switched.get(prepared.submissionId)
        if (why && result.outcome === 'completed') result = { ...result, notice: [why, result.notice].filter(Boolean).join(' ') }
        this.pendingSettlement = { generation: record.generation, runId: record.runId!, submissionId: prepared.submissionId, at: this.now(), result }
        try { await this.settlePending() } catch { this.options.onView?.(this.view()) }
        this.finish(prepared.submissionId, result)
        // Accepted and then failed: the message is in the chat as a failed
        // turn, so it is sent again, as a new submission, to the other provider.
        const target = this.switchTarget(result, provider, prepared.submissionId)
        if (target && !this.pendingSettlement) {
          const retry = randomUUID()
          this.switched.set(retry, target.why)
          const next = structuredClone(this.record), queued = structuredClone(this.snapshot)
          next.pendingProvider = target.to
          queued.queued.push({ submissionId: retry, input: { ...input, submissionId: retry } })
          diagnostic('agent-provider-switched', { from: provider, to: target.to, reason: result.error?.code, accepted: true })
          await this.publish(next, queued)
        }
        return
      } else {
        this.assertPrepared(prepared)
        // Not accepted: the message is still queued, so it simply goes to the
        // other provider next instead of stopping on an error.
        const target = this.switchTarget(result, provider, prepared.submissionId)
        if (target) {
          this.switched.set(prepared.submissionId, target.why)
          record.pendingProvider = target.to
          delete record.prepared; record.phase = 'ready'
          diagnostic('agent-provider-switched', { from: provider, to: target.to, reason: result.error?.code, accepted: false })
          await this.publish(record, snapshot)
          return
        }
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
  private now(): number { return this.options.now?.() ?? Date.now() }
}

function applySettlement(view: AgentConversationView, pending: AgentPendingSettlement): void {
  const accepted = view.record.accepted.find(a => a.submissionId === pending.submissionId)
  if (!accepted || view.record.generation !== pending.generation || view.record.runId !== pending.runId) throw new Error('Pending Agent settlement identity is invalid.')
  if (!view.snapshot.results?.[pending.submissionId]) {
    // A TURN THE USER STOPPED IS NOT A TURN THAT FAILED.
    //
    // `failed` does three things at once: it paints the turn red in the chat,
    // it latches the card's status to `failed` (agentLine reads it back), and
    // it puts the provider's parting error into the transcript as the answer.
    // All three are wrong for something the person asked for. Red is for what
    // they did not ask for.
    const stopped = pending.result.outcome === 'interrupted'
    view.snapshot.chat.turns.push({
      role: 'agent',
      text: stopped ? 'Stopped.' : pending.result.text ?? pending.result.error?.message ?? 'Done.',
      at: pending.at,
      ...(!stopped && pending.result.outcome !== 'completed' ? { failed: true } : {}),
      ...(pending.result.notice ? { notice: pending.result.notice } : {}),
    })
  }
  view.snapshot.results = { ...view.snapshot.results, [pending.submissionId]: pending.result }
  accepted.outcome = pending.result.outcome
  view.snapshot.lastActivityAt = Math.max(view.snapshot.lastActivityAt ?? 0, pending.at)
  view.record.phase = view.record.accepted.length >= view.record.ceiling ? 'reset-due' : 'ready'
}

function waiting(): Waiting { let resolve!: Waiting['resolve']; const promise = new Promise<AgentInteractionResult>(r => { resolve = r }); return { promise, resolve } }
function providerName(provider: AgentProviderId): string { return provider === 'claude' ? 'Claude' : 'Codex' }

const HANDOFF_EXCHANGES = 6
const HANDOFF_RECENT_CODE_POINTS = 24 * 1024
const HANDOFF_SUMMARY_CODE_POINTS = 4 * 1024

function conversationHandoff(snapshot: AgentConversationSnapshot, fromProvider: AgentProviderId): AgentConversationHandoff {
  const pairs: Array<Array<{ role: 'user' | 'agent'; text: string }>> = []
  let user: { role: 'user'; text: string } | undefined
  for (const turn of snapshot.chat.turns) {
    if (turn.role === 'user') user = { role: 'user', text: turn.text }
    else if (user) {
      pairs.push([user, { role: 'agent', text: turn.text }])
      user = undefined
    }
  }
  const recentTurns = boundRecentTurns(pairs.slice(-HANDOFF_EXCHANGES).flat())
  const older = pairs.slice(0, -HANDOFF_EXCHANGES)
  const summarySource = older.length > 0 ? older : pairs.slice(0, 1)
  const header = `Previous ${providerName(fromProvider)} conversation: ${pairs.length} completed exchange${pairs.length === 1 ? '' : 's'}.`
  // FILLED FROM THE RECENT END. The chat is kept across sessions, so the front
  // of it can be a week old; truncating the joined text from the start spent
  // the whole budget there and dropped exactly the work just before the six
  // exchanges copied verbatim. Oldest gives way first, order is preserved.
  const clips: string[] = []
  let budget = HANDOFF_SUMMARY_CODE_POINTS - [...header].length - 1
  for (const pair of [...summarySource].reverse()) {
    const clip = `User: ${excerpt(pair[0].text, 320)}\nAssistant: ${excerpt(pair[1].text, 320)}`
    const cost = [...clip].length + 2
    if (cost > budget) break
    clips.unshift(clip)
    budget -= cost
  }
  const summary = excerpt(header + (clips.length ? `\n${clips.join('\n\n')}` : ''), HANDOFF_SUMMARY_CODE_POINTS)
  return { fromProvider, summary, recentTurns }
}

function boundRecentTurns(turns: Array<{ role: 'user' | 'agent'; text: string }>): Array<{ role: 'user' | 'agent'; text: string }> {
  let remaining = HANDOFF_RECENT_CODE_POINTS
  const bounded: Array<{ role: 'user' | 'agent'; text: string }> = []
  for (const turn of [...turns].reverse()) {
    if (remaining <= 0) break
    const text = excerpt(turn.text, remaining)
    remaining -= [...text].length
    bounded.push({ role: turn.role, text })
  }
  return bounded.reverse()
}

function excerpt(text: string, cap: number): string {
  const points = [...text.trim()]
  return points.length <= cap ? points.join('') : `${points.slice(0, Math.max(0, cap - 1)).join('')}…`
}

function failure(message: string, code: NonNullable<AgentInteractionResult['error']>['code'] = 'interaction-failed'): AgentInteractionResult {
  return { interactionId: '', agentRunId: '', source: 'provider', outcome: 'failed', presentation: 'transient', error: { code, message } }
}
function bits(id: string): number[] { const hash = createHash('sha256').update(id).digest(); return [0, 4, 8, 12].map(i => hash.readUInt32BE(i) % 32768) }
function retired(filter: string | undefined, id: string): boolean { if (!filter) return false; const bytes = Buffer.from(filter, 'hex'); return bits(id).every(b => (bytes[b >> 3] & (1 << (b & 7))) !== 0) }
function retire(filter: string | undefined, ids: string[]): string { const bytes = filter ? Buffer.from(filter, 'hex') : Buffer.alloc(4096); for (const id of ids) for (const b of bits(id)) bytes[b >> 3] |= 1 << (b & 7); return bytes.toString('hex') }
