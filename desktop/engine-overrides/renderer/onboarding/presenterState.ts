export type PresenterCard = null | {
  kind: 'permission' | 'speak' | 'provider' | 'repair' | 'success'
  title?: string
  phrase?: string
  detail?: string
}

export type PresenterState = {
  action: string
  clipId: string
  caption: string
  card: PresenterCard
  videoUnavailable: boolean
}

export type PresenterMessage =
  | { type: 'snapshot'; action: string; clipId: string; caption: string; card: PresenterCard }
  | { type: 'video-unavailable' }

export function emptyPresenter(): PresenterState {
  return { action: 'loading', clipId: '', caption: '', card: null, videoUnavailable: false }
}

export function reducePresenter(state: PresenterState, message: PresenterMessage): PresenterState {
  if (message.type === 'video-unavailable') return { ...state, videoUnavailable: true }
  return { ...message, videoUnavailable: false }
}
