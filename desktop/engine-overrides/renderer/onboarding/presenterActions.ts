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
  return phase === 'ready' && (action === 'notes-dictation'
    || action === 'clipboard-capture'
    || action === 'screenshot-capture'
    || action === 'orchestrator-task'
    || action === 'agent-task-link'
    || action === 'notetaker-save')
}
