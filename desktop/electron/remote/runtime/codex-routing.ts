import { RuntimeRpcClient } from './rpc'
import { diagnostic } from '../diagnostics'
import type { CodexIdentity } from './codex-identity'
import { sessionLifecycleDev } from '../session-lifecycle-devlog'

/** Durable record of which tasks belong to the current worker.
 *
 *  WHY THIS IS NOT JUST A SET. Ownership is a fact about the thread on disk,
 *  but it used to be inferred from liveness — a task counted as owned only
 *  while the current worker still listed it in a snapshot or emitted events
 *  for it. Both of those are lost when the app restarts, and the worker also
 *  reaps its own idle sessions, so a thread that was forked hours ago stops
 *  looking owned and silently falls back to the superseded worker. That worker
 *  still holds the writer lock on the PRE-fork thread, so every resume after
 *  that fails with `-32600 already has an active writer` and the task is stuck
 *  as "Working" forever. Measured 2026-09-09: forked 19:40, app restarted
 *  20:45, dead until manual repair. */
export interface CodexOwnershipStore {
  /** Task ids known to belong to the current worker, read once at construction. */
  initial(): Iterable<string>
  /** Persist a newly claimed task id so the next process still knows. */
  remember(taskId: string): void
  recoverIdentity?(taskId: string, source?: string): Promise<CodexIdentity | null>
}

/** Rolling compatibility: existing threads keep their owner. Only new forks
 * use the current worker. No daemon or in-progress turn is killed to upgrade. */
export class CompatibleCodexRuntime extends RuntimeRpcClient {
  private owned = new Set<string>()
  private preparations = new Map<string, unknown[]>()
  constructor(private legacy: RuntimeRpcClient, private current: RuntimeRpcClient, private store?: CodexOwnershipStore) {
    super('unused')
    for (const id of store?.initial() ?? []) this.owned.add(id)
    legacy.on('codex.event', this.oldEvent)
    current.on('codex.event', this.newEvent)
  }
  /** Ownership is durable, so every route that learns it must write it down. */
  private claim(id: string): void {
    if (this.owned.has(id)) return
    this.store?.remember(id)
    this.owned.add(id)
  }
  private oldEvent = (event: any): void => { if (!this.owned.has(event.mirror.taskId)) this.emit('codex.event', event) }
  private newEvent = (event: any): void => { this.claim(event.mirror.taskId); this.emit('codex.event', event) }
  override get connected(): boolean { return this.legacy.connected || this.current.connected }
  override async connect(): Promise<void> { await this.legacy.connect() }
  override async call<T = any>(method: string, ...args: unknown[]): Promise<T> {
    if (method === 'codex.snapshot' && !args.length) {
      const [old, current] = await Promise.all([
        this.legacy.call<any>(method), this.current.call<any>(method),
      ])
      for (const task of current.tasks) this.claim(task.taskId)
      return { running: old.running || current.running, url: current.url || old.url,
        tasks: [...old.tasks.filter((t: any) => !this.owned.has(t.taskId)), ...current.tasks] } as T
    }
    const id = String(args[0])
    if (method === 'codex.identity') {
      // Recovery belongs to the upgraded client too: old live daemons cannot
      // execute newly installed code. Consult this generation's receipts first.
      const durable = await this.store?.recoverIdentity?.(id, args[1] as string | undefined)
      if (durable) {
        this.claim(id)
        sessionLifecycleDev('durable-client-identity-recovered', { taskId: id, sourceSessionId: args[1], sessionId: durable.threadId })
        return durable as T
      }
    }
    if (method === 'codex.prepare') this.preparations.set(id, args)
    if (method === 'codex.forkThread') {
      const info = await this.current.call<{ capabilities: string[] }>('runtime.info')
      const required = ['codex.forkThread', 'codex.forkResult', 'codex.targetedSnapshot']
      if (args[3]) required.push('codex.editLatestMessage')
      if (!required.every(cap => info.capabilities?.includes(cap))) {
        diagnostic('codex-runtime-incompatible', { taskId: id, capabilities: info.capabilities })
        throw new Error('Background runtime needs an update; do not retry this fork')
      }
      diagnostic('codex-fork-routed', { taskId: id, sourceSessionId: args[1], capabilities: info.capabilities })
      this.claim(id)
      const preparation = this.preparations.get(id)
      if (preparation) await this.current.call('codex.prepare', ...preparation)
    }
    return (this.owned.has(id) ? this.current : this.legacy).call<T>(method, ...args)
  }
  override disconnect(): void {
    this.legacy.off('codex.event', this.oldEvent)
    this.current.off('codex.event', this.newEvent)
    if (this.legacy instanceof CompatibleCodexRuntime) this.legacy.disconnect()
    this.current.disconnect() // disconnect UI only; current worker also persists
  }
}
