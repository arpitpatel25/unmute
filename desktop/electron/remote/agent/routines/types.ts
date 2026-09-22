import type { RoutineDefinition, RoutineKind, RoutineInput, RoutineContext } from './definition'
import type { RoutineContextCatalog } from './manifest'

/** Each routine's colour, fixed at creation (state.json), in assignment order. */
export const ROUTINE_COLORS = ['white', 'red', 'blue', 'yellow', 'green', 'pink'] as const
export type RoutineColor = typeof ROUTINE_COLORS[number]

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
  /** The routine's colour when the run was created; older runs lack it. */
  color?: string
}
export interface RoutineState { enabled: boolean; nextFireAt: number | null; color?: string }
export interface RoutineEntry { id: string; path: string; definition?: RoutineDefinition; error?: string; state: RoutineState }
export interface RoutineItemView {
  id: string; name: string; scheduleLabel: string; kind: RoutineKind; enabled: boolean; nextRunAt: number | null
  /** The definition's actual window, canonical grammar text from `formatWindow` — '' for an invalid routine. */
  window: string
  /** Canonical schedule text from `formatSchedule`, the prompt body, and the colour — '' for an invalid routine. */
  schedule: string; prompt: string; color: string
  inputs?: RoutineInput[]; context?: RoutineContext
  recentRuns?: Array<{ id: string; status: RunStatus; at: number; preview?: string }>
  nextRunLabel: string; lastRun?: { status: RunStatus; at: number }; running: boolean; error?: string; path: string
}
export interface RoutinesView { available: boolean; reason?: string; items: RoutineItemView[]; runs: RoutineRun[]; contextCatalog?: RoutineContextCatalog }
