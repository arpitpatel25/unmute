export type ProviderId = 'claude' | 'codex'
export type ProviderUiState = 'checking' | 'ready' | 'missing' | 'auth-required' | 'installing' | 'timed-out' | 'failed'
export type ProviderUiStatus = { state: ProviderUiState; detail?: string }

export type ActionId =
  | 'welcome'
  | 'privacy'
  | 'microphone'
  | 'accessibility'
  | 'function-key'
  | 'system-audio'
  | 'provider-choice'
  | 'notes-dictation'
  | 'clipboard-capture'
  | 'screenshot-capture'
  | 'orchestrator-task'
  | 'agent-task-link'
  | 'notetaker-save'
  | 'agent-notes'
  | 'product-orientation'
  | 'sign-in'
  | 'complete'

export interface OnboardingProgress {
  schema: 1
  action: ActionId
  completed: ActionId[]
  skipped: ActionId[]
  provider?: ProviderId
  captureId?: string
  observedCaptureItemIds: string[]
  taskIds: { orchestrator?: string; agent?: string }
  meetingId?: string
  notetakerActive: boolean
  gesture?: { lane: ShortcutLane; started: boolean; stopped: boolean }
  updatedAt: number
}

export type ShortcutLane = 'dictation' | 'orchestrator' | 'agent'

export type OnboardingEvent =
  | { type: 'capability-satisfied'; action: ActionId }
  | { type: 'section-skipped'; action: ActionId }
  | { type: 'provider-selected'; provider: ProviderId }
  | { type: 'function-key-observed' }
  | { type: 'shortcut-started'; lane: ShortcutLane }
  | { type: 'shortcut-stopped'; lane: ShortcutLane }
  | { type: 'transcription-ready'; captureId: string }
  | { type: 'dictation-delivered'; captureId: string; target: string }
  | { type: 'capture-observed'; captureId: string; kind: 'clipboard-text' | 'screenshot'; itemId: string }
  | { type: 'capture-delivered'; captureId: string; includedItemIds: string[] }
  | { type: 'task-created'; source: 'orchestrator' | 'agent'; taskId: string; cwd?: string }
  | { type: 'task-completed'; taskId: string }
  | { type: 'agent-task-linked'; taskId: string; href: string; cwd?: string }
  | { type: 'agent-text'; text: string }
  | { type: 'task-link-opened'; taskId: string }
  | { type: 'notetaker-started'; meetingId: string }
  | { type: 'notetaker-stopped'; meetingId: string }
  | { type: 'notetaker-saved'; meetingId: string }
  | { type: 'notetaker-failed'; meetingId?: string; reason: string }
  | { type: 'boot-revalidated'; satisfied: ActionId[] }
  | { type: 'retry-requested' }
  | { type: 'reset-requested' }

export type PresenterCard = null | {
  kind: 'permission' | 'speak' | 'provider' | 'repair' | 'success'
  title?: string
  phrase?: string
  detail?: string
  providers?: Record<ProviderId, ProviderUiStatus>
}

export type PresenterCommand = {
  type: 'snapshot'
  action: ActionId
  clipId: string
  caption: string
  card: PresenterCard
  step: number
  totalSteps: number
  phase?: 'ready' | 'listening' | 'processing'
}

export interface ChapterDefinition {
  action: ActionId
  clipId: string
  caption: string
  card: PresenterCard
}
