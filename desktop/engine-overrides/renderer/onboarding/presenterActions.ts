export type SuccessButton = {
  label: 'Continue' | 'Explore Unmute' | 'Sign in'
  type: 'continue' | 'complete-orientation' | 'open-sign-in'
}

export function successButtonForAction(action: string): SuccessButton {
  if (action === 'product-orientation') return { label: 'Explore Unmute', type: 'complete-orientation' }
  if (action === 'sign-in') return { label: 'Sign in', type: 'open-sign-in' }
  return { label: 'Continue', type: 'continue' }
}

export function clipEndActionFor(action: string): 'continue' | 'complete-orientation' | null {
  if (action === 'product-orientation') return 'complete-orientation'
  if (action === 'welcome' || action === 'privacy' || action === 'agent-notes') return 'continue'
  return null
}

export function canSkipAction(action: string, phase: 'ready' | 'listening' | 'processing' = 'ready'): boolean {
  void phase
  return action !== 'loading' && action !== 'complete'
}

export function processingEscapeDelayMs(action: string, phase?: 'ready' | 'listening' | 'processing'): number | null {
  return phase === 'processing' && (action === 'orchestrator-task' || action === 'agent-task-link')
    ? 10_000
    : null
}
