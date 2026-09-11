import type { CaptureRoute } from './captureRoute'

/** Agent work and unrelated task work must never share one head-of-line lock. */
export function remoteDispatchQueueKey(
  route: CaptureRoute,
  targetTaskId: string | null,
  composerToken?: string,
): string {
  if (composerToken) return `composer:${composerToken}`
  if (route === 'agent') return 'agent'
  if (route === 'task') return targetTaskId ? `task:${targetTaskId}` : 'task:router'
  return 'cursor'
}

/** Serialise only deliveries to the same immutable destination. */
export class KeyedRemoteDispatchQueue {
  private readonly tails = new Map<string, Promise<void>>()

  enqueue(key: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    const result = previous.catch(() => undefined).then(operation)
    const tail = result.then(() => undefined, () => undefined)
    this.tails.set(key, tail)
    void tail.finally(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key)
    })
    return result
  }
}
