export type SuccessButton = {
  label: 'Continue' | 'Explore Unmute' | 'Sign in'
  type: 'continue' | 'complete-orientation' | 'open-sign-in'
}

export function successButtonForAction(action: string): SuccessButton {
  if (action === 'product-orientation') return { label: 'Explore Unmute', type: 'complete-orientation' }
  if (action === 'sign-in') return { label: 'Sign in', type: 'open-sign-in' }
  return { label: 'Continue', type: 'continue' }
}
