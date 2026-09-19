export type ProviderUiState = 'checking' | 'ready' | 'missing' | 'auth-required' | 'installing' | 'timed-out' | 'failed'

export type PresenterCard = null | {
  kind: 'permission' | 'speak' | 'provider' | 'repair' | 'success'
  title?: string
  phrase?: string
  detail?: string
  providers?: Record<'claude' | 'codex', { state: ProviderUiState; detail?: string }>
}

export type PresenterState = {
  action: string
  clipId: string
  caption: string
  card: PresenterCard
  videoUnavailable: boolean
  phase?: 'ready' | 'listening' | 'processing'
}

export type PresenterMessage =
  | { type: 'snapshot'; action: string; clipId: string; caption: string; card: PresenterCard; phase?: 'ready' | 'listening' | 'processing' }
  | { type: 'video-unavailable' }

export function emptyPresenter(): PresenterState {
  return { action: 'loading', clipId: '', caption: '', card: null, videoUnavailable: false }
}

export function reducePresenter(state: PresenterState, message: PresenterMessage): PresenterState {
  if (message.type === 'video-unavailable') return { ...state, videoUnavailable: true }
  return { ...message, videoUnavailable: false }
}
