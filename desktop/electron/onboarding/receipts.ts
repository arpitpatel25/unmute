import { EventEmitter } from 'node:events'
import type { OnboardingEvent } from './types'

const bus = new EventEmitter()
bus.setMaxListeners(20)

export function emitOnboardingReceipt(event: OnboardingEvent): void { bus.emit('receipt', event) }
export function onOnboardingReceipt(listener: (event: OnboardingEvent) => void): () => void {
  bus.on('receipt', listener)
  return () => bus.off('receipt', listener)
}
