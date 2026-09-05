import { randomUUID } from 'node:crypto'
import type { RuntimeRpcClient } from './rpc'

interface HostRequest { id: string; method: string; args: unknown[] }
/** UI-only actions wait for a connected UI. Accepted actions are never replayed. */
export class RuntimeHostBridge {
  private pending = new Map<string, { request: HostRequest; accepted: boolean; resolve(value: unknown): void; reject(error: Error): void }>()
  constructor(private emit: (request: HostRequest) => void) {}
  call(method: string, args: unknown[]): Promise<any> {
    return new Promise((resolve, reject) => {
      const request = { id: randomUUID(), method, args }
      this.pending.set(request.id, { request, accepted: false, resolve, reject })
      this.emit(request)
    })
  }
  connected(): void {
    for (const [id, pending] of this.pending) {
      if (pending.accepted) {
        pending.reject(new Error('The app disconnected during this action. Check its outcome before retrying.'))
        this.pending.delete(id)
      } else this.emit(pending.request)
    }
  }
  accept(id: string): boolean {
    const pending = this.pending.get(id)
    if (!pending || pending.accepted) return false
    pending.accepted = true
    return true
  }
  response(id: string, result: unknown, error?: string): void {
    const pending = this.pending.get(id)
    if (!pending || !pending.accepted) return
    this.pending.delete(id)
    if (error) pending.reject(new Error(error)); else pending.resolve(result)
  }
}

export function registerRuntimeHost(rpc: RuntimeRpcClient, invoke: (method: string, args: any[]) => Promise<unknown>): () => void {
  const receive = (request: HostRequest) => {
    void (async () => {
      if (!(await rpc.call('host.accept', request.id))) return
      let result: unknown, error: string | undefined
      try { result = await invoke(request.method, request.args) } catch (e) { error = (e as Error).message }
      await rpc.call('host.response', request.id, result, error)
    })().catch(() => { /* The daemon retains acceptance uncertainty across UI disconnect. */ })
  }
  rpc.on('host.request', receive)
  return () => rpc.off('host.request', receive)
}
