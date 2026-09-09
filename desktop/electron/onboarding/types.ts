export type ProviderId = 'claude' | 'codex'

export type ActionId =
  | 'privacy'
  | 'microphone'
  | 'accessibility'
  | 'input-monitoring'
  | 'system-audio'
  | 'provider-choice'
  | 'notes-dictation'
  | 'notes-instruct'
  | 'clipboard-capture'
  | 'screenshot-capture'
  | 'orchestrator-task'
  | 'agent-task-link'
  | 'notetaker-save'
  | 'product-orientation'
  | 'sign-in'
  | 'complete'

export interface OnboardingProgress {
  schema: 1
  action: ActionId
  completed: ActionId[]
  provider?: ProviderId
  captureId?: string
  observedCaptureItemIds: string[]
  taskIds: { orchestrator?: string; agent?: string }
  meetingId?: string
  updatedAt: number
}

export type OnboardingEvent =
  | { type: 'capability-satisfied'; action: ActionId }
  | { type: 'provider-selected'; provider: ProviderId }
  | { type: 'transcription-ready'; captureId: string }
  | { type: 'dictation-delivered'; captureId: string; target: string }
  | { type: 'instruction-delivered'; captureId: string; target: string; changedSelection: boolean }
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
}

export type PresenterCommand = {
  type: 'snapshot'
  action: ActionId
  clipId: string
  caption: string
  card: PresenterCard
}

export interface ChapterDefinition {
  action: ActionId
  clipId: string
  caption: string
  card: PresenterCard
}
