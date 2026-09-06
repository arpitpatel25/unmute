import { RuntimeRpcClient } from './rpc'

/** Rolling compatibility: existing threads keep their owner. Only new forks
 * use the current worker. No daemon or in-progress turn is killed to upgrade. */
export class CompatibleCodexRuntime extends RuntimeRpcClient {
  private owned = new Set<string>()
  private preparations = new Map<string, unknown[]>()
  constructor(private legacy: RuntimeRpcClient, private current: RuntimeRpcClient) {
    super('unused')
    legacy.on('codex.event', this.oldEvent)
    current.on('codex.event', this.newEvent)
  }
  private oldEvent = (event: any): void => { if (!this.owned.has(event.mirror.taskId)) this.emit('codex.event', event) }
  private newEvent = (event: any): void => { this.owned.add(event.mirror.taskId); this.emit('codex.event', event) }
  override get connected(): boolean { return this.legacy.connected || this.current.connected }
  override async connect(): Promise<void> { await this.legacy.connect() }
  override async call<T = any>(method: string, ...args: unknown[]): Promise<T> {
    if (method === 'codex.snapshot') {
      const [old, current] = await Promise.all([
        this.legacy.call<any>(method), this.current.call<any>(method),
      ])
      for (const task of current.tasks) this.owned.add(task.taskId)
      return { running: old.running || current.running, url: current.url || old.url,
        tasks: [...old.tasks.filter((t: any) => !this.owned.has(t.taskId)), ...current.tasks] } as T
    }
    const id = String(args[0])
    if (method === 'codex.prepare') this.preparations.set(id, args)
    if (method === 'codex.forkThread') {
      const info = await this.current.call<{ capabilities: string[] }>('runtime.info')
      if (!info.capabilities.includes(method)) throw new Error('Background runtime needs an update; do not retry this fork')
      this.owned.add(id)
      const preparation = this.preparations.get(id)
      if (preparation) await this.current.call('codex.prepare', ...preparation)
    }
    return (this.owned.has(id) ? this.current : this.legacy).call<T>(method, ...args)
  }
  override disconnect(): void {
    this.legacy.off('codex.event', this.oldEvent)
    this.current.off('codex.event', this.newEvent)
    this.current.disconnect() // disconnect UI only; current worker also persists
  }
}
