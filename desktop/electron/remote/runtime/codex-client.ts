import { CodexHub, type CodexHubDeps, type StartThreadOpts } from '../codex/hub'
import type { TaskInput } from '../task-input'
import { sameQuestion, type QuestionReference } from '../question-reference'
import type { FollowupGate, NewTurnOutcome } from '../task-followup'
import type { RuntimeRpcClient } from './rpc'
import type { CodexMirror, CodexRuntimeEvent, CodexPreparation } from './codex-service'

/** UI projection only. Closing this adapter never terminates daemon work. */
export class PersistentCodexHub extends CodexHub {
  private mirrors = new Map<string, CodexMirror>()
  private listeners = new Set<Parameters<CodexHub['onFollowup']>[0]>()
  private remoteRunning = false
  private remoteUrl = ''
  private answering = new Set<string>()
  constructor(private rpc: RuntimeRpcClient, private callbacks: CodexHubDeps) {
    super(callbacks)
    rpc.on('codex.event', this.receive)
  }
  private receive = (event: CodexRuntimeEvent): void => {
    this.mirrors.set(event.mirror.taskId, event.mirror)
    if (event.kind === 'patch') this.callbacks.onPatch(event.patch)
    else for (const listener of this.listeners) listener(event.event)
  }
  async reconnect(): Promise<void> {
    const snapshot = await this.rpc.call<{ running: boolean; url: string; tasks: CodexMirror[] }>('codex.snapshot')
    this.remoteRunning = snapshot.running; this.remoteUrl = snapshot.url
    this.mirrors.clear()
    for (const mirror of snapshot.tasks) { this.mirrors.set(mirror.taskId, mirror); this.callbacks.onPatch(mirror.patch) }
  }
  private async prepare(id: string, thread?: string): Promise<void> {
    const p: CodexPreparation = {
      bin: await this.callbacks.resolveBin(), config: await this.callbacks.threadConfig?.(id), cap: this.callbacks.approvalCap?.(id),
      plans: thread ? await this.callbacks.loadPlans?.(id, thread) : undefined,
      inputMetadata: thread ? await this.callbacks.loadInputMetadata?.(id, thread) : undefined,
    }
    await this.rpc.call('codex.prepare', id, p, thread)
  }
  override get running(): boolean { return this.rpc.connected && this.remoteRunning }
  override get url(): string { return this.remoteUrl }
  override onFollowup(listener: Parameters<CodexHub['onFollowup']>[0]): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  override followupGate(id: string): FollowupGate {
    return this.rpc.connected ? this.mirrors.get(id)?.gate ?? { kind: 'unavailable', reason: 'Codex is connecting.' } : { kind: 'unavailable', reason: 'Background runtime disconnected.' }
  }
  override threadIdFor(id: string): string | undefined { return this.mirrors.get(id)?.threadId }
  override validationErrorFor(id: string): string | undefined { return this.mirrors.get(id)?.validationError }
  override async startThread(id: string, options: StartThreadOpts): Promise<{ threadId: string; url: string }> {
    await this.prepare(id)
    const result = await this.rpc.call<{ threadId: string; url: string }>('codex.startThread', id, options)
    await this.reconnect(); return result
  }
  override async resumeThread(id: string, thread: string, options: StartThreadOpts, _force = false): Promise<void> {
    await this.prepare(id, thread)
    await this.rpc.call('codex.resumeThread', id, thread, options)
    await this.reconnect()
  }
  override async forkThread(id: string, source: string, options: StartThreadOpts): Promise<{ threadId: string; forkedFromId: string }> {
    await this.prepare(id, source)
    const result = await this.rpc.call<{ threadId: string; forkedFromId: string }>('codex.forkThread', id, source, options)
    await this.reconnect()
    return result
  }
  override async send(id: string, text: string, options: Parameters<CodexHub['send']>[2] = {}): Promise<boolean> {
    return this.rpc.call('codex.send', id, text, options)
  }
  override async sendNewTurn(id: string, text: string, input: TaskInput[], expected: { sessionId: string; generation: number }): Promise<NewTurnOutcome> {
    return this.rpc.call('codex.sendNewTurn', id, text, input, expected)
  }
  override answer(id: string, text: string, expected?: QuestionReference): boolean {
    const question = this.mirrors.get(id)?.patch.question
    if (!this.rpc.connected || !question || this.answering.has(id) || expected && (!question.reference || !sameQuestion(expected, question.reference))) return false
    this.answering.add(id)
    void this.rpc.call<{ accepted: boolean; mirror: CodexMirror }>('codex.answer', id, text, expected ?? question.reference).then(result => {
      this.mirrors.set(id, result.mirror)
      if (!result.accepted) this.callbacks.onPatch({ ...result.mirror.patch, taskId: id, errorReason: result.mirror.validationError ?? 'Answer was not accepted; review the pending question.' })
    }).catch(error => this.callbacks.onPatch({ taskId: id, errorReason: (error as Error).message }))
      .finally(() => this.answering.delete(id))
    return true // queued; only daemon patches clear the pending question
  }
  override async interrupt(id: string): Promise<boolean> { return this.rpc.call('codex.interrupt', id) }
  override async stopAndRelease(id: string): Promise<boolean> { return this.rpc.call('codex.stopAndRelease', id) }
  override async rename(id: string, name: string): Promise<void> { await this.rpc.call('codex.rename', id, name) }
  override async selfCheck(): Promise<{ ok: boolean; reason?: string }> {
    await this.prepare('__self_check__')
    return this.rpc.call('codex.selfCheck')
  }
  override release(id: string): void {
    void this.rpc.call('codex.release', id).then(() => this.mirrors.delete(id))
      .catch(error => this.callbacks.onPatch({ taskId: id, errorReason: (error as Error).message }))
  }
  override stop(): void { this.rpc.off('codex.event', this.receive); this.listeners.clear() }
}
