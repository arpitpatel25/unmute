import { RuntimeRpcClient } from './rpc'
import type { AgentRuntimeConfig } from './agent-service'
import type { AgentConversationView } from '../agent/lifecycle'
import { diagnostic } from '../diagnostics'
import { AGENT_RUNTIME_SCHEMA } from './agent-schema'

type Snapshot = { view?: AgentConversationView }
/** Refresh configuration only after process loss, obtaining keys from the UI
 * when needed rather than retaining them throughout the socket's lifetime. */
export async function recoverAgentRuntime(rpc: RuntimeRpcClient, configure: () => Promise<void | false>, reconnect: () => Promise<void>): Promise<void> {
  if (!(await rpc.call<Snapshot>('agent.snapshot')).view) {
    if (await configure() === false) return
    diagnostic('agent-runtime-reconfigured', { runtimeSchema: AGENT_RUNTIME_SCHEMA, reason: 'worker-restarted' })
  }
  await reconnect()
}
function busy(snapshot: Snapshot): boolean {
  const view = snapshot.view
  return !!view && (view.record.phase === 'sending' || !!view.record.prepared
    || view.snapshot.queued.length > 0 || !!view.snapshot.settlementPending)
}

/** Upgrade only the Agent storage owner. Claude/Codex task daemons stay alive. */
export class CompatibleAgentRuntime extends RuntimeRpcClient {
  private owner?: RuntimeRpcClient
  private config?: AgentRuntimeConfig
  private serial: Promise<unknown> = Promise.resolve()
  constructor(private legacy: RuntimeRpcClient, private current: RuntimeRpcClient) {
    super('unused')
    legacy.on('agent.event', this.oldEvent)
    current.on('agent.event', this.newEvent)
    current.on('reconnected', this.reconnected)
  }
  private oldEvent = (event: unknown): void => { if (this.owner === this.legacy) this.emit('agent.event', event) }
  private newEvent = (event: unknown): void => { if (this.owner === this.current) this.emit('agent.event', event) }
  private reconnected = (): void => { if (this.owner === this.current) this.emit('reconnected') }
  override get connected(): boolean { return this.owner?.connected ?? this.legacy.connected }
  override async connect(): Promise<void> { await (this.owner ?? this.legacy).connect() }
  private async select(upgrade: boolean): Promise<boolean> {
    if (this.owner === this.current) return false
    const old = await this.legacy.call<Snapshot>('agent.snapshot')
    if (!this.owner) {
      const modern = await this.current.call<Snapshot>('agent.snapshot')
      if (modern.view) {
        if (busy(old)) throw new Error('Both Agent runtimes may be active; refusing shared storage handover')
        if (old.view) await this.legacy.call('agent.disable')
        this.owner = this.current
        this.config = undefined
        await this.current.call('hello')
        diagnostic('agent-runtime-owner-selected', { runtimeSchema: AGENT_RUNTIME_SCHEMA, reused: true })
        return false
      }
      this.owner = this.legacy
    }
    if (!upgrade || !this.config) return false
    if (busy(old)) {
      diagnostic('agent-runtime-upgrade-deferred', { runtimeSchema: AGENT_RUNTIME_SCHEMA, reason: 'legacy-busy' })
      return false
    }
    if (old.view) await this.legacy.call('agent.disable')
    // Set owner before configure so initialization events reach the UI. A failed
    // configure stays on current, never reopening legacy storage underneath it.
    this.owner = this.current
    await this.current.call('agent.configure', this.config)
    this.config = undefined
    diagnostic('agent-runtime-upgraded', { runtimeSchema: AGENT_RUNTIME_SCHEMA })
    return true
  }
  override async call<T = any>(method: string, ...args: unknown[]): Promise<T> {
    if (!method.startsWith('agent.')) throw new Error('Agent router accepts Agent commands only')
    const operation = this.serial.then(async () => {
      if (method === 'agent.configure') this.config = { ...args[0] as AgentRuntimeConfig }
      const configured = await this.select(['agent.configure', 'agent.discard', 'agent.enqueue', 'agent.retry', 'agent.submit'].includes(method))
      if (method === 'agent.update' && this.config) Object.assign(this.config, args[0])
      if (method === 'agent.requestProvider' && this.config) this.config.selectedProvider = args[0] as AgentRuntimeConfig['selectedProvider']
      if (method === 'agent.disable') this.config = undefined
      // select already configured a newly migrated worker. A busy legacy owner
      // keeps its in-flight configuration until it can safely move.
      if (method === 'agent.configure' && (this.owner === this.legacy || configured)) {
        return { result: Promise.resolve(await this.owner!.call<T>('agent.snapshot')) }
      }
      const result = this.owner!.call<T>(method, ...args)
      // A full turn must not hold the routing lock: interrupt still needs access.
      if (method === 'agent.retry' || method === 'agent.submit') return { result }
      const value = await result
      if (this.owner === this.current) this.config = undefined
      return { result: Promise.resolve(value) }
    })
    this.serial = operation.catch(() => {})
    return (await operation).result
  }
  override disconnect(): void {
    this.config = undefined
    this.legacy.off('agent.event', this.oldEvent)
    this.current.off('agent.event', this.newEvent)
    this.current.off('reconnected', this.reconnected)
    this.current.disconnect()
  }
}
