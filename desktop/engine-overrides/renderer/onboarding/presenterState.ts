export type ProviderUiState = 'checking' | 'ready' | 'missing' | 'outdated' | 'auth-required' | 'installing' | 'timed-out' | 'failed'

export type PresenterCard = null | {
  kind: 'permission' | 'speak' | 'provider' | 'repair' | 'success'
  title?: string
  phrase?: string
  copyText?: string
  detail?: string
  providers?: Record<'claude' | 'codex', { state: ProviderUiState; detail?: string }>
}

export type PresenterSnapshot = {
  action: string
  clipId: string
  caption: string
  card: PresenterCard
  step: number
  totalSteps: number
  phase?: 'ready' | 'listening' | 'processing'
}

export type PresenterState = PresenterSnapshot & {
  videoUnavailable: boolean
  videoFinished: boolean
  pending: PresenterSnapshot | null
  checkpoint: PresenterSnapshot | null
  history: PresenterSnapshot[]
  historyIndex: number | null
  reviewing: boolean
}

export type PresenterMessage =
  | ({ type: 'snapshot' } & PresenterSnapshot)
  | { type: 'video-unavailable' }
  | { type: 'back' }
  | { type: 'forward' }
  | { type: 'video-ended' | 'skip-video' | 'replay-video' }

const loading: PresenterSnapshot = {
  action: 'loading', clipId: '', caption: '', card: null, step: 0, totalSteps: 0,
}

export function emptyPresenter(): PresenterState {
  return {
    ...loading,
    videoUnavailable: false,
    videoFinished: false,
    pending: null,
    checkpoint: null,
    history: [],
    historyIndex: null,
    reviewing: false,
  }
}

function snapshotFrom(message: Extract<PresenterMessage, { type: 'snapshot' }>): PresenterSnapshot {
  return {
    action: message.action,
    clipId: message.clipId,
    caption: message.caption,
    card: message.card,
    step: message.step ?? 0,
    totalSteps: message.totalSteps ?? 0,
    phase: message.phase,
  }
}

function display(state: PresenterState, snapshot: PresenterSnapshot, historyIndex: number | null): PresenterState {
  return {
    ...state,
    ...snapshot,
    historyIndex,
    reviewing: historyIndex !== null,
    videoUnavailable: false,
    videoFinished: !snapshot.clipId,
    pending: null,
  }
}

export function reducePresenter(state: PresenterState, message: PresenterMessage): PresenterState {
  if (message.type === 'video-unavailable') {
    const updated = { ...state, videoUnavailable: true, videoFinished: true }
    return updated.pending ? advanceTo(updated, updated.pending) : updated
  }
  if (message.type === 'replay-video') return { ...state, videoFinished: false }
  if (message.type === 'video-ended' || message.type === 'skip-video') {
    const updated = { ...state, videoFinished: true }
    return updated.pending ? advanceTo(updated, updated.pending) : updated
  }

  if (message.type === 'back') {
    if (!state.history.length) return state
    const index = state.historyIndex === null
      ? state.history.length - 1
      : Math.max(0, state.historyIndex - 1)
    return display(state, state.history[index], index)
  }

  if (message.type === 'forward') {
    if (state.historyIndex === null || !state.checkpoint) return state
    const index = state.historyIndex + 1
    return index < state.history.length
      ? display(state, state.history[index], index)
      : display(state, state.checkpoint, null)
  }

  const next = snapshotFrom(message)
  if (!state.checkpoint) return display({ ...state, checkpoint: next }, next, null)

  if (state.checkpoint.action === next.action) {
    const updated = { ...state, checkpoint: next }
    return state.reviewing ? updated : { ...updated, ...next }
  }

  if (!state.videoFinished && !state.videoUnavailable && !state.reviewing) {
    return { ...state, pending: next }
  }
  return advanceTo(state, next)
}

function advanceTo(state: PresenterState, next: PresenterSnapshot): PresenterState {
  if (!state.checkpoint) return display({ ...state, checkpoint: next }, next, null)
  const resetJourney = next.step > 0 && next.step <= state.checkpoint.step
  const history = resetJourney
    ? []
    : state.history.at(-1)?.action === state.checkpoint.action
      ? state.history
      : [...state.history, state.checkpoint]
  return display({ ...state, checkpoint: next, history }, next, null)
}

/**
 * Which provider buttons the choice card shows. A provider that is not on this
 * Mac gets no button once the other one is — a Codex-only Mac is never offered
 * "Set up Claude Code", and vice versa. With neither installed, both stay:
 * setting one up is the only way forward.
 */
export function shownProviders(
  providers: NonNullable<PresenterCard>['providers'],
): Array<'claude' | 'codex'> {
  const all = ['claude', 'codex'] as const
  const present = all.filter((id) => {
    const state = providers?.[id]?.state
    return state !== undefined && state !== 'missing' && state !== 'checking'
  })
  return present.length > 0 ? present : [...all]
}
