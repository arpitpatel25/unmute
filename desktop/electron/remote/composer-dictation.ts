import type { DraftInsertion } from './task-draft'
import { randomUUID } from 'node:crypto'

export type ComposerDictationState = 'idle' | 'recording' | 'transcribing'

export interface ComposerDictationDelivery {
  readonly token: string
  readonly taskId: string
  readonly insertion?: Readonly<DraftInsertion>
}

export type ComposerDictationClaim =
  | { readonly kind: 'drop' }
  | { readonly kind: 'deliver'; readonly taskId: string; readonly insertion?: Readonly<DraftInsertion> }

/** Keep composer insertion outside the generic capture lifecycle. The caller
 * supplies the real routing/phase/voice effects; the early composer branch is
 * intentionally the only path that cannot invoke them. */
export async function dispatchCaptureWithLifecycle<T>(options: {
  composer?: () => Promise<T>
  routed: () => Promise<T>
  initialResult: T
  onRouting(): void
  onIdle(result: T): void
  onAcknowledge(result: T): void
}): Promise<T> {
  if (options.composer) return options.composer()

  options.onRouting()
  let result = options.initialResult
  try {
    result = await options.routed()
    return result
  } finally {
    options.onIdle(result)
    options.onAcknowledge(result)
  }
}

export async function applyComposerDictation(
  claim: ComposerDictationClaim,
  text: string,
  attachments: readonly string[],
  sink: {
    drafts: { insertText(taskId: string, text: string, insertion?: DraftInsertion): unknown }
    taskExists(taskId: string): boolean
    stageImage(taskId: string, path: string, insertion?: DraftInsertion): Promise<void>
  },
): Promise<string | null> {
  if (claim.kind === 'drop') return null
  if (!sink.taskExists(claim.taskId)) return null
  sink.drafts.insertText(claim.taskId, text, claim.insertion)
  for (const [index, path] of attachments.entries()) {
    const insertion = claim.insertion?.operationId
      ? { ...claim.insertion, operationId: `${claim.insertion.operationId}:image:${index}` }
      : claim.insertion
    await sink.stageImage(claim.taskId, path, insertion)
  }
  return claim.taskId
}

export function startComposerDictation(
  coordinator: ComposerDictationCoordinator,
  taskId: string,
  insertion: DraftInsertion | undefined,
  start: (delivery: ComposerDictationDelivery) => void,
): { delivery: ComposerDictationDelivery; started: boolean; error?: Error } {
  const delivery = coordinator.begin(taskId, insertion)
  try {
    start(delivery)
    return { delivery, started: true }
  } catch (error) {
    coordinator.abandon(delivery.token)
    return { delivery, started: false, error: error instanceof Error ? error : new Error(String(error)) }
  }
}

export class ComposerDictationCoordinator {
  private active: { delivery: ComposerDictationDelivery; state: Exclude<ComposerDictationState, 'idle'> } | null = null
  private pending = new Map<string, ComposerDictationDelivery>()

  get activeDelivery(): ComposerDictationDelivery | null { return this.active?.delivery ?? null }

  begin(taskId: string, insertion?: DraftInsertion, token = randomUUID()): ComposerDictationDelivery {
    if (this.active) throw new Error('A composer dictation is already active')
    const capturedInsertion = insertion ? Object.freeze({ ...insertion }) : undefined
    const delivery = Object.freeze({ token, taskId, ...(capturedInsertion ? { insertion: capturedInsertion } : {}) })
    this.pending.set(token, delivery)
    this.active = { delivery, state: 'recording' }
    return delivery
  }

  stateFor(taskId: string): ComposerDictationState {
    return this.active?.delivery.taskId === taskId ? this.active.state : 'idle'
  }

  markTranscribing(token: string): boolean {
    if (this.active?.delivery.token !== token) return false
    this.active.state = 'transcribing'
    return true
  }

  /** The delivery is safely on the session queue. Release the mic UI, but keep
   * the token claimable until that queue reaches it. */
  markQueued(token: string): boolean {
    if (!this.pending.has(token)) return false
    if (this.active?.delivery.token === token) this.active = null
    return true
  }

  /** Ended without a queued delivery (cancel, empty audio, STT failure, hold). */
  abandonActive(): string | null {
    if (!this.active) return null
    const token = this.active.delivery.token
    return this.abandon(token) ? token : null
  }

  abandon(token: string): boolean {
    if (this.active?.delivery.token !== token) return false
    this.pending.delete(token)
    this.active = null
    return true
  }

  /** Spend a token exactly once. Unknown/abandoned tokens are an explicit drop,
   * never permission to fall through into ordinary task submission. */
  claim(delivery: ComposerDictationDelivery): ComposerDictationClaim {
    const captured = this.pending.get(delivery.token)
    if (!captured) return { kind: 'drop' }
    this.pending.delete(delivery.token)
    if (this.active?.delivery.token === delivery.token) this.active = null
    return {
      kind: 'deliver',
      taskId: captured.taskId,
      ...(captured.insertion ? { insertion: captured.insertion } : {}),
    }
  }
}
