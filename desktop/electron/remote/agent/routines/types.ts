import type { RoutineDefinition, RoutineKind } from './definition'

export type RunStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'skipped'
export type RunTrigger =
  | { type: 'schedule'; scheduledFor: number }
  | { type: 'manual' }
  | { type: 'event'; event: 'meeting-notes-ready'; meetingId: string; title?: string; notesPath?: string }
  | { type: 'approval'; parentRunId: string; proposalId: string }
export type ProposalState = 'open' | 'dismissed' | 'running' | 'done' | 'failed'
export interface RoutineProposal { id: string; title: string; detail: string; state: ProposalState; runId?: string }
export interface RoutineRun {
  id: string; routineId: string; name: string; key: string; kind: RoutineKind; trigger: RunTrigger; status: RunStatus
  firedAt: number; startedAt?: number; endedAt?: number
  window?: { start: number; end: number; label: string }; manifestTotals?: { sessions: number; turns: number }
  provider?: 'claude' | 'codex'; providerSessionId?: string; agentRunId?: string
  activity: Array<{ at: number; text: string }>; resultPath?: string; resultPreview?: string
  reason?: 'nothing-in-window' | 'missed' | 'timeout' | 'interrupted' | 'provider' | 'invalid' | 'disabled'
  error?: string; proposals?: RoutineProposal[]; posted: boolean /* has a result entry in chat */; unread: boolean; speak: boolean
}
export interface RoutineState { enabled: boolean; nextFireAt: number | null }
export interface RoutineEntry { id: string; path: string; definition?: RoutineDefinition; error?: string; state: RoutineState }
export interface RoutineItemView {
  id: string; name: string; scheduleLabel: string; kind: RoutineKind; enabled: boolean; nextRunAt: number | null
  nextRunLabel: string; lastRun?: { status: RunStatus; at: number }; running: boolean; error?: string; path: string
}
export interface RoutinesView { available: boolean; reason?: string; items: RoutineItemView[]; runs: RoutineRun[] }
