import { randomUUID } from 'node:crypto'
import type { RuntimeRpcClient } from './rpc'
import { diagnostic, diagnosticError } from '../diagnostics'

interface HostRequest { id: string; method: string; args: unknown[] }

/**
 * How long a host action may wait for a UI that has not taken it.
 *
 * ONLY UNACCEPTED REQUESTS ARE TIMED. Once the app has accepted one, its
 * duration is the action's own — resuming a cold session and delivering into
 * it can legitimately run past forty seconds — and cutting that off would
 * report failure for work that is still happening. What has no natural bound
 * is the other case: with no UI attached, a request sat in `pending` forever,
 * so every tool except memory blocked until the token expired half an hour
 * later and the person got nothing at all.
 */
const UNACCEPTED_TIMEOUT_MS = 20_000
/** UI-only actions wait for a connected UI. Accepted actions are never replayed. */
export class RuntimeHostBridge {
  private pending = new Map<string, { request: HostRequest; accepted: boolean; timer?: NodeJS.Timeout; resolve(value: unknown): void; reject(error: Error): void }>()
  constructor(private emit: (request: HostRequest) => void, private readonly unacceptedTimeoutMs = UNACCEPTED_TIMEOUT_MS) {}
  call(method: string, args: unknown[]): Promise<any> {
    return new Promise((resolve, reject) => {
      const request = { id: randomUUID(), method, args }
      diagnostic('agent-host-request-started', { requestId: request.id, method })
      const timer = setTimeout(() => {
        const pending = this.pending.get(request.id)
        if (!pending || pending.accepted) return
        this.pending.delete(request.id)
        diagnostic('agent-host-request-unattached', { requestId: request.id, method, waitedMs: this.unacceptedTimeoutMs })
        reject(new Error('The Unmute app is not attached right now, so that could not be done. Try again in a moment.'))
      }, this.unacceptedTimeoutMs)
      // Deliberately NOT unref'd: this timer is the only thing that will ever
      // settle the promise, so letting the loop exit past it reinstates the
      // hang it exists to end.
      this.pending.set(request.id, { request, accepted: false, timer, resolve, reject })
      this.emit(request)
    })
  }
  connected(): void {
    for (const [id, pending] of this.pending) {
      if (pending.accepted) {
        if (pending.timer) clearTimeout(pending.timer)
        diagnostic('agent-host-request-uncertain', { requestId: id, method: pending.request.method, reason: 'ui-reconnected-after-acceptance' })
        pending.reject(new Error('The app disconnected during this action. Check its outcome before retrying.'))
        this.pending.delete(id)
      } else this.emit(pending.request)
    }
  }
  accept(id: string): boolean {
    const pending = this.pending.get(id)
    if (!pending || pending.accepted) return false
    pending.accepted = true
    if (pending.timer) clearTimeout(pending.timer)
    diagnostic('agent-host-request-accepted', { requestId: id, method: pending.request.method })
    return true
  }
  response(id: string, result: unknown, error?: string): void {
    const pending = this.pending.get(id)
    if (!pending || !pending.accepted) return
    if (pending.timer) clearTimeout(pending.timer)
    this.pending.delete(id)
    diagnostic('agent-host-request-completed', { requestId: id, method: pending.request.method,
      outcome: error ? 'error' : 'success', ...(error ? diagnosticError(new Error(error)) : {}) })
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
    })().catch(error => { diagnostic('agent-host-response-undelivered', { requestId: request.id, method: request.method, ...diagnosticError(error) }) })
  }
  rpc.on('host.request', receive)
  return () => rpc.off('host.request', receive)
}
