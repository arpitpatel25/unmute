import { EventEmitter } from 'node:events'
import type { OnboardingEvent } from './types'

const bus = new EventEmitter()
bus.setMaxListeners(20)

export function emitOnboardingReceipt(event: OnboardingEvent): void { bus.emit('receipt', event) }
export function onOnboardingReceipt(listener: (event: OnboardingEvent) => void): () => void {
  bus.on('receipt', listener)
  return () => bus.off('receipt', listener)
}

export function acceptsAgentTaskLink(
  event: { taskId: string; cwd?: string },
  workspace: string,
  ownedAgentTasks: ReadonlySet<string>,
): boolean {
  // A continuation capability returns a canonical task id but not a cwd. That
  // structured result is still stronger evidence than Agent prose. Newly
  // created tasks with a cwd remain scoped to the guided workspace (or to a
  // task this onboarding runtime observed the Agent create).
  return event.cwd === undefined || event.cwd === workspace || ownedAgentTasks.has(event.taskId)
}
