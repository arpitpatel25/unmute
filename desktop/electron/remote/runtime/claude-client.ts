import { ClaudeTaskSession, type ClaudeTaskOptions, type ClaudeTaskAnswer } from '../claude/task-session'
import type { TaskInput } from '../task-input'
import type { RuntimeRpcClient } from './rpc'
import { CLAUDE_RUNTIME_RELEASED, type ClaudeRuntimeEvent, type ClaudeRuntimeState } from './claude-service'

/** UI-side projection. Provider pipes and continuations belong to the daemon. */
export class PersistentClaudeTaskSession extends ClaudeTaskSession {
  private runtimeState: ClaudeRuntimeState = { alive: false, busy: false, followupBlocked: false, followupUnavailable: true, models: [] }
  private attached?: Promise<void>
  private sequence = 0
  private buffered: ClaudeRuntimeEvent[] = []
  private replaying = true
  private detached = false
  private receiveEvent = (event: ClaudeRuntimeEvent) => {
    if (event.sessionId !== this.sessionId || this.detached) return
    if (this.replaying) { this.buffered.push(event); return }
    this.apply(event)
  }
  private disconnected = () => {
    const interrupted = this.runtimeState.busy || !!this.runtimeState.activeSubmissionId || this.runtimeState.followupBlocked
    this.attached = undefined
    this.replaying = true
    this.buffered = []
    this.runtimeState = { ...this.runtimeState, alive: false, followupUnavailable: true }
    if (interrupted) this.remoteOptions.onEvent({ type: 'error', message: 'Background runtime connection lost; reconnect before sending again.' })
  }
  constructor(private rpc: RuntimeRpcClient, private remoteOptions: ClaudeTaskOptions) {
    super(remoteOptions)
    rpc.on('claude.event', this.receiveEvent)
    rpc.on('disconnected', this.disconnected)
  }
  override get alive(): boolean { return !this.detached && this.runtimeState.alive }
  override get busy(): boolean { return this.runtimeState.busy }
  override get activeSubmissionId(): string | undefined { return this.runtimeState.activeSubmissionId }
  override get followupBlocked(): boolean { return this.runtimeState.followupBlocked }
  override get followupUnavailable(): boolean { return this.detached || this.runtimeState.followupUnavailable }
  override get pid(): number | undefined { return this.runtimeState.pid }
  override start(): Promise<void> {
    return this.attached ??= this.attach().catch(error => {
      this.attached = undefined
      throw error
    })
  }
  private async attach(): Promise<void> {
    const { onEvent: _onEvent, spawn: _spawn, readImage: _readImage, ...options } = this.remoteOptions
    if (options.resumeSessionAt) {
      const info = await this.rpc.call<{ capabilities?: string[] }>('runtime.info')
      if (!info.capabilities?.includes('claude.resumeSessionAt')) throw new Error('Claude background runtime needs checkpoint support before editing.')
    }
    const opened = await this.rpc.call<ClaudeRuntimeState & { sequence: number; replayFrom?: number }>('claude.open', this.sessionId, { ...options, sessionId: this.sessionId })
    if (opened.sequence < this.sequence) this.sequence = 0
    // Older daemons omit replayFrom and retain the original behavior. New
    // daemons give a bounded boundary so a fresh UI cannot replay the
    // runtime's entire event lifetime into the Electron heap.
    if (opened.replayFrom !== undefined && this.sequence < opened.replayFrom) this.sequence = opened.replayFrom
    while (this.sequence < opened.sequence) {
      const events = await this.rpc.call<ClaudeRuntimeEvent[]>('claude.replay', this.sessionId, this.sequence)
      if (!events.length) throw new Error('Background runtime replay is incomplete')
      const before = this.sequence
      for (const event of events) this.apply(event)
      if (this.sequence <= before) throw new Error('Background runtime replay did not advance')
    }
    this.runtimeState = opened
    this.models = opened.models
    this.replaying = false
    for (const event of this.buffered.splice(0).sort((a, b) => a.sequence - b.sequence)) this.apply(event)
  }
  private async sendAfterReopen<T>(send: () => Promise<T>): Promise<T> {
    try { return await send() }
    catch (error) {
      // This rejection happens before the daemon can hand the message to a
      // provider, so retrying cannot duplicate a turn. Connection errors and
      // timeouts remain uncertain and must never be retried automatically.
      if ((error as Error).message !== CLAUDE_RUNTIME_RELEASED) throw error
      this.attached = undefined
      this.replaying = true
      this.buffered = []
      await this.start()
      return send()
    }
  }
  private apply(record: ClaudeRuntimeEvent): void {
    if (record.sequence <= this.sequence) return
    this.sequence = record.sequence
    this.runtimeState = record.state
    this.models = record.state.models
    // The daemon may release an idle provider process while this client stays
    // connected. Forget the completed attachment so the next send calls open
    // again and resumes the same durable conversation identity.
    if (record.event.type === 'closed') {
      this.attached = undefined
      this.replaying = true
      this.buffered = []
    }
    this.remoteOptions.onEvent(record.event)
  }
  override async send(text: string, images: string[] = [], submissionId?: string, ordered?: TaskInput[], newTurnOnly = false) {
    await this.start()
    return this.sendAfterReopen(() => this.rpc.call<{ submissionId: string; sessionId: string }>('claude.send', this.sessionId, text, images, submissionId, ordered, newTurnOnly))
  }
  override async sendNewTurn(text: string, images: string[], submissionId: string, ordered?: TaskInput[]) {
    await this.start()
    return this.sendAfterReopen(() => this.rpc.call<import('../task-followup').NewTurnOutcome>('claude.sendNewTurn', this.sessionId, text, images, submissionId, ordered))
  }
  override async answer(id: string, decision: ClaudeTaskAnswer): Promise<void> {
    this.runtimeState = await this.rpc.call('claude.answer', this.sessionId, id, decision)
  }
  override async interrupt(): Promise<void> { this.runtimeState = await this.rpc.call('claude.interrupt', this.sessionId) }
  override async stopState(): Promise<{ alive: boolean; busy: boolean }> {
    this.runtimeState = await this.rpc.call<ClaudeRuntimeState>('claude.state', this.sessionId)
    return { alive: this.runtimeState.alive, busy: this.runtimeState.busy }
  }
  override async terminate(): Promise<void> {
    try {
      this.runtimeState = await this.rpc.call('claude.close', this.sessionId)
      if (this.runtimeState.alive) throw new Error('Claude session is still alive')
    } catch (error) {
      if ((error as Error).message !== CLAUDE_RUNTIME_RELEASED) throw error
    } finally { this.detach() }
  }
  override close(): void {
    void this.rpc.call('claude.close', this.sessionId).catch(error => this.remoteOptions.onEvent({ type: 'error', message: error.message }))
    this.detach()
  }
  detach(): void {
    this.detached = true
    this.rpc.off('claude.event', this.receiveEvent)
    this.rpc.off('disconnected', this.disconnected)
  }
}
