// Unmute Remote — preload bridge. Spread into the OSS engine's electronAPI by
// the build step (same mechanism as paywallPreloadExtensions — see PATCHES.md).
//
// Each method maps to an IPC handler/broadcast registered in remote/init.ts.

import { ipcRenderer } from 'electron'
import type { Proposal } from './remote/curator-store'
// Type-only: erased at compile, so the preload bundle gains no dependency.
import type { ProviderId } from './remote/providers'
import type { ActivationMode, DictationKey, HelpGuide } from './remote/help-guide'

export interface RemoteTaskSnapshot {
  id: string
  intent: string
  origin?: 'unmute-agent'
  agentRunId?: string
  state: 'processing' | 'needs-user' | 'ready' | 'stuck' | 'done' | 'failed'
  category: 'info' | 'navigate' | 'watch' | 'consume' | 'act' | null
  /** Latest short progress label ("Editing X · 12/18 tests"), if any. */
  step: string | null
  createdAt: number
  updatedAt: number
  result: { summary: string; detail?: string; artifacts?: Array<{ type: 'path' | 'url'; value: string }> } | null
  error: { reason: string; detail?: string } | null
  question: { text: string; kind?: 'free_text' | 'choice' | 'confirm'; choices?: string[]; irreversible?: boolean } | null
  mcpGap: { integration: string; fixCommand: string; message: string } | null
  /** PTY still alive (running or parked-warm) — drives the live terminal's
   *  repaint-vs-replay choice. */
  alive: boolean
}

export interface RemoteSettingsSnapshot {
  permissionMode: 'prompt' | 'auto-approve'
  remoteKey: 'fn' | 'right-option'
  agent: 'claude' | 'codex'
  sandboxRoots: string[]
  model: string
  browserEnabled: boolean
  overlayAutoPresent: boolean
  showInScreenCapture: boolean
  overlayDocked: boolean
  osNotifications: boolean
  /** Persistent default: force RAW (no Unmute injection/librarian) for all tasks. */
  forceRawMode: boolean
  logFile: string | null
}

export type UnmuteAgentProvider = 'claude' | 'codex'

export interface UnmuteAgentSettingsSnapshot {
  agentProvider: UnmuteAgentProvider
  /** The user's default model per provider (absent = built-in default). */
  agentModels: Partial<Record<UnmuteAgentProvider, string>>
  /** Continue on another model, then provider, when the chosen one cannot answer. */
  switchWhenUnavailable: boolean
  unmuteAgentAvailable: boolean
  unmuteAgentMaxProcesses: number
}

/** One installed provider's models, as that provider reports them. */
export interface UnmuteAgentModelChoices {
  id: UnmuteAgentProvider
  label: string
  selected: string
  models: Array<{ id: string; label: string }>
}

export interface UnmuteAgentAvailabilitySnapshot {
  available: boolean
  reason?: 'disabled' | 'initializing' | 'keychain-unavailable' | 'storage-unavailable' | 'provider-unavailable'
  providers: Array<{
    id: UnmuteAgentProvider
    label: string
    available: boolean
    reason?: 'not-installed'
  }>
}

export interface UnmuteAgentInteractionInput {
  transcript: string
  attachments?: Array<{ path: string; name?: string; mimeType?: string }>
  selectedText?: string
  priorRunId?: string
  intents?: string[]
  currentContext?: { app?: string; project?: string; activeTaskId?: string; activeTaskName?: string }
}

export interface UnmuteAgentInteractionResult {
  interactionId: string
  agentRunId: string
  provider?: UnmuteAgentProvider
  source: 'provider'
  outcome: 'completed' | 'failed' | 'interrupted'
  presentation: 'transient' | 'task'
  text?: string
  memory?: { id: string; title: string }
  error?: { code: string; message: string }
}

export type UnmuteAgentActivityState =
  | 'listening'
  | 'searching'
  | 'thinking'
  | 'confirming'
  | 'complete'
  | 'failed'

export interface UnmuteAgentActivitySnapshot {
  state: UnmuteAgentActivityState
  summary: string
  interactionId?: string
  agentRunId?: string
  provider?: UnmuteAgentProvider
}

export interface UnmuteMemorySnapshot {
  id: string
  kind: string
  title: string
  tags: string[]
  scope?: { app?: string; project?: string; purpose?: string }
  provenance?: { source: 'voice' | 'selection' | 'attachment' | 'import' }
  content?: string
  attachmentCount?: number
  snippet?: string
  score?: number
  createdAt?: number
  updatedAt: number
  version?: number
  deletedAt?: number
}

export interface CaptureHistorySnapshot {
  id: string
  kind: 'dictation' | 'scratchpad'
  createdAt: number
  finalizedAt: number
  text: string
  destination: 'cursor' | 'task'
  taskId?: string
  attachments: string[]
  saved: boolean
}

export interface RemoteSetupStep {
  key: string
  title: string
  detail: string
  command?: string
  status: 'done' | 'todo'
  auto: boolean
  optional?: boolean
}
export interface RemoteSetupStatus {
  steps: RemoteSetupStep[]
  complete: boolean
}

// Mirrors DBMeeting (engine-overrides/electron/db.ts) and TranscriptSegment
// (engine-overrides/electron/notetaker/transcriptMerge.ts) — NOT imported
// from there. Those live in the engine-overrides/ tree, which
// wire-into-engine.sh copies wholesale onto $engine/electron/ (cp -R
// engine-overrides/. $engine/), while this file lives in the electron/ tree,
// copied wholesale onto $engine/electron/paywall/ (cp -R electron/.
// $engine/electron/paywall/). The two copies preserve relative structure
// only WITHIN themselves, so a relative import from here to db.ts would
// resolve differently pre- and post-copy — the exact cross-tree hazard
// notetakerInit.ts's own header comment documents for init.ts. Duplicating
// the shape here, the same way this file already does for every other
// DB-backed snapshot type (RemoteTaskSnapshot, UnmuteMemorySnapshot, etc.),
// keeps the import graph same-directory and correct both pre- and post-copy.
export type NotetakerPipelineStatus = 'disabled' | 'pending' | 'success' | 'failed'

export interface NotetakerMeetingSnapshot {
  id: string
  title: string
  started_at: number
  ended_at: number
  duration_ms: number
  status: 'recording' | 'transcribing' | 'ready' | 'failed'
  transcript_path: string | null
  audio_mic_path: string | null
  audio_system_path: string | null
  cleanup_status: NotetakerPipelineStatus
  summary_status: NotetakerPipelineStatus
  cleaned_transcript_path: string | null
  notes_path: string | null
}

export interface NotetakerTranscriptSegment {
  channel: 'mic' | 'system'
  text: string
  startMs: number
  endMs: number
  speakerName?: string | null
}

// Mirrors db.ts's NotetakerSettingsRow, same cross-tree-duplication reason
// as NotetakerMeetingSnapshot above. summary_prompt is the editable guidance
// for direct note generation (null = built-in default). managed means the
// user's signed-in Unmute Cloud agent; desktop-driver agents are not exposed
// because they cannot safely run a background one-shot note request.
export interface NotetakerPipelineSettings {
  auto_pipeline_enabled: 0 | 1
  provider: 'claude' | 'codex'
  cleanup_prompt: string | null
  summary_prompt: string | null
  availability: { claude: boolean; codex: boolean }
  default_summary_instructions: string
}

// Mirrors notesSummary.ts's MeetingNotes, same reason.
export interface NotetakerMeetingNotes {
  title: string
  summary: string
  keyPoints: string[]
  decisions: string[]
  actionItems: string[]
  openQuestions: string[]
}

export interface NotetakerScreenshot {
  url: string
  capturedAt: number
  mode: 'fullscreen' | 'region'
}

export const remotePreloadExtensions = {
  remoteGetHelpGuide: (input: { dictationKey: DictationKey; activationMode: ActivationMode }): Promise<HelpGuide> =>
    ipcRenderer.invoke('remote:get-help-guide', input),
  // ── Unmute Agent ──
  remoteGetAgentSettings: (): Promise<UnmuteAgentSettingsSnapshot> =>
    ipcRenderer.invoke('remote:get-agent-settings'),
  remoteSetUnmuteAgentProvider: (provider: UnmuteAgentProvider): Promise<boolean> =>
    ipcRenderer.invoke('remote:set-unmute-agent-provider', provider),
  remoteGetAgentAvailability: (): Promise<UnmuteAgentAvailabilitySnapshot> =>
    ipcRenderer.invoke('remote:get-agent-availability'),
  remoteGetAgentModelChoices: (): Promise<UnmuteAgentModelChoices[]> =>
    ipcRenderer.invoke('remote:get-agent-model-choices'),
  remoteSetUnmuteAgentModel: (provider: UnmuteAgentProvider, model: string): Promise<boolean> =>
    ipcRenderer.invoke('remote:set-unmute-agent-model', provider, model),
  remoteSetUnmuteAgentSwitch: (on: boolean): Promise<boolean> =>
    ipcRenderer.invoke('remote:set-unmute-agent-switch', on),
  remoteAgentSubmit: (input: UnmuteAgentInteractionInput): Promise<UnmuteAgentInteractionResult> =>
    ipcRenderer.invoke('remote:agent-submit', input),
  remoteAgentCancel: (runId: string): Promise<boolean> =>
    ipcRenderer.invoke('remote:agent-cancel', runId),
  remoteOnAgentActivity: (cb: (activity: UnmuteAgentActivitySnapshot) => void): (() => void) => {
    const handler = (_e: unknown, activity: UnmuteAgentActivitySnapshot) => cb(activity)
    ipcRenderer.on('remote:agent-activity', handler)
    return () => ipcRenderer.removeListener('remote:agent-activity', handler)
  },
  remoteListMemories: (query?: string): Promise<UnmuteMemorySnapshot[]> =>
    ipcRenderer.invoke('remote:list-memories', query),
  remoteGetMemory: (id: string): Promise<UnmuteMemorySnapshot | null> =>
    ipcRenderer.invoke('remote:get-memory', id),
  remoteForgetMemory: (id: string): Promise<boolean> =>
    ipcRenderer.invoke('remote:forget-memory', id),
  remoteRestoreMemory: (id: string): Promise<boolean> =>
    ipcRenderer.invoke('remote:restore-memory', id),

  // ── Capture history ──
  remoteListCaptureHistory: (kind?: 'dictation' | 'scratchpad'): Promise<CaptureHistorySnapshot[]> =>
    ipcRenderer.invoke('remote:capture-history-list', kind),
  remoteSetCaptureHistorySaved: (id: string, saved: boolean): Promise<boolean> =>
    ipcRenderer.invoke('remote:capture-history-save', id, saved),
  remoteDeleteCaptureHistory: (id: string): Promise<boolean> =>
    ipcRenderer.invoke('remote:capture-history-delete', id),
  remoteCopyCaptureHistory: (id: string): Promise<boolean> =>
    ipcRenderer.invoke('remote:capture-history-copy', id),

  // ── Computer Use (ax-mcp) ──
  /** Read the current Computer Use policy (enabled / allowAll / allowed / screenshots). */
  remoteGetComputerUse: (): Promise<{ enabled: boolean; screenshotEnabled: boolean; allowAll: boolean; allowed: string[] }> =>
    ipcRenderer.invoke('remote:get-computer-use'),
  /** Patch the policy; returns the normalized result. Toggling `enabled` also
   *  registers/unregisters the MCP server with Claude Code. */
  remoteSetComputerUse: (patch: Record<string, unknown>): Promise<{ enabled: boolean; screenshotEnabled: boolean; allowAll: boolean; allowed: string[] }> =>
    ipcRenderer.invoke('remote:set-computer-use', patch),
  /** Is Unmute trusted for Accessibility? (onboarding hint) */
  remoteAxTrusted: (): Promise<boolean> => ipcRenderer.invoke('remote:ax-trusted'),
  /** Subscribe to live "an app is being driven" activity (menu-bar/overlay indicator). */
  remoteOnAxActivity: (cb: (d: { app?: string; tool: string; ok: boolean; at: number }) => void): (() => void) => {
    const handler = (_e: unknown, d: { app?: string; tool: string; ok: boolean; at: number }) => cb(d)
    ipcRenderer.on('remote:ax-activity', handler)
    return () => ipcRenderer.removeListener('remote:ax-activity', handler)
  },

  // ── Actions ──
  /** Dispatch a task by text (capture path types its own; this is for UI re-run/manual). */
  remoteDispatch: (intent: string): Promise<string | null> =>
    ipcRenderer.invoke('remote:dispatch', intent),
  /** Orchestrate wall focus (§6.2). Tell the main process which session is focused
   *  (or null) so a capture routes there deterministically. Additive. */
  remoteSetOrchestrateFocus: (id: string | null): Promise<boolean> =>
    ipcRenderer.invoke('remote:set-orchestrate-focus', id),
  /** Is the Unmute Agent switched on? Gates its key, its capture destination
   *  and its settings section — see init.ts. */
  remoteGetUnmuteAgentAvailable: (): Promise<boolean> =>
    ipcRenderer.invoke('remote:get-unmute-agent-available'),
  remoteSetUnmuteAgentAvailable: (on: boolean): Promise<boolean> =>
    ipcRenderer.invoke('remote:set-unmute-agent-available', on),
  /** Agent routines: saved prompts that run on a schedule or event. On by default. */
  remoteGetRoutinesEnabled: (): Promise<boolean> =>
    ipcRenderer.invoke('remote:get-routines-enabled'),
  remoteSetRoutinesEnabled: (on: boolean): Promise<boolean> =>
    ipcRenderer.invoke('remote:set-routines-enabled', on),
  /** Current wall-owned terminal session (or null) — read once on mount. */
  remoteGetOrchestrateOwner: (): Promise<string | null> => ipcRenderer.invoke('remote:get-orchestrate-owner'),
  /** Attach an image to a session: bytes are saved under the task's dir and the
   *  path is typed (unsubmitted) into the session's input — speak to send. */
  remoteAttachImage: (taskId: string, data: ArrayBuffer, ext: string): Promise<string | null> =>
    ipcRenderer.invoke('remote:attach-image', taskId, data, ext),
  /** Glance vocabulary: ALL skills (both memory tiers + ~/.claude/skills,
   *  recency-ranked) + known projects. */
  remoteListSkills: (): Promise<Array<{ name: string; lastUsed: string; description: string; runs: number; pinned: boolean; origin?: 'unmute' }>> =>
    ipcRenderer.invoke('remote:list-skills'),
  /** Pin/unpin a skill to the top of the cockpit rail. */
  remotePinSkill: (name: string, on: boolean): Promise<boolean> =>
    ipcRenderer.invoke('remote:pin-skill', name, on),

  // ── Skill Curator (spec §11) — proposal review + tap-to-invoke ──
  /** Pending skill proposals awaiting the user's review. */
  curatorListProposals: (): Promise<Proposal[]> => ipcRenderer.invoke('curator:list-proposals'),
  /** Read one proposal in full (evidence, rationale, editable draft). */
  curatorGetProposal: (id: string): Promise<Proposal | null> =>
    ipcRenderer.invoke('curator:get-proposal', id),
  /** Accept: materialize the skill on disk. On failure, `error` carries the
   *  human-readable reason (collision / invalid-name) for the popup. */
  curatorAccept: (id: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('curator:accept', id),
  /** Reject: record the rejection + resolve the proposal. */
  curatorReject: (id: string, reason?: string): Promise<boolean> =>
    ipcRenderer.invoke('curator:reject', id, reason),
  /** Start the per-proposal review conversation; output streams on
   *  'curator:conv-data' (subscribe via curatorOnConvData). */
  curatorConverseStart: (id: string): Promise<boolean> =>
    ipcRenderer.invoke('curator:converse-start', id),
  /** Raw keystrokes from the popup terminal → the conversation's PTY. */
  curatorConverseWrite: (id: string, data: string): Promise<void> =>
    ipcRenderer.invoke('curator:converse-write', id, data),
  /** Stop + tear down the review conversation. */
  curatorConverseStop: (id: string): Promise<void> =>
    ipcRenderer.invoke('curator:converse-stop', id),
  /** Tap a skill into a live session's input (unsubmitted `/name ` — the user
   *  presses Enter to invoke it). */
  curatorTapSkill: (taskId: string, name: string): Promise<boolean> =>
    ipcRenderer.invoke('curator:tap-skill', taskId, name),
  /** DEV-ONLY full-UX logging (fire-and-forget). Emit for every user-facing
   *  curator action; main writes it only when the dev-log gate is on (single
   *  gate in main — the renderer always calls, a packaged build drops it). */
  curatorDevLog: (payload: Record<string, unknown>): void =>
    ipcRenderer.send('curator:devlog', payload),
  /** Subscribe to review-conversation output chunks. Returns an unsubscribe fn. */
  curatorOnConvData: (cb: (d: { id: string; chunk: string }) => void): (() => void) => {
    const handler = (_e: unknown, d: { id: string; chunk: string }) => cb(d)
    ipcRenderer.on('curator:conv-data', handler)
    return () => ipcRenderer.removeListener('curator:conv-data', handler)
  },
  /** Put a task in the pocket or take it out — pocket-only: it keeps running
   *  and stays in the orchestrator either way. */
  remoteSetInPocket: (taskId: string, inPocket: boolean): Promise<boolean> =>
    ipcRenderer.invoke('remote:set-in-pocket', taskId, inPocket),
  /** Set/clear the user's note on a task card (empty string clears). */
  remoteSetNote: (taskId: string, note: string): Promise<boolean> =>
    ipcRenderer.invoke('remote:set-note', taskId, note),
  /** The workspace streams the user has, newest-touched first. */
  remoteGroupsList: (): Promise<Array<{ id: string; label: string; authored: boolean; tasks: number }>> =>
    ipcRenderer.invoke('remote:groups-list'),
  /** Name a stream yourself. Adopts a matching one rather than duplicating it. */
  remoteGroupsCreate: (label: string): Promise<{ ok: boolean; reason?: string; adopted?: boolean; label?: string }> =>
    ipcRenderer.invoke('remote:groups-create', label),
  /** Rename a stream. Refused when the new name is already another stream. */
  remoteGroupsRename: (id: string, label: string): Promise<{ ok: boolean; reason?: string; clashesWith?: string; label?: string; relabelled?: number }> =>
    ipcRenderer.invoke('remote:groups-rename', id, label),
  remoteListProjects: (): Promise<Array<{ name: string; path: string }>> =>
    ipcRenderer.invoke('remote:list-projects'),
  /** Rename a task (names are voice addresses — fixable by the user). */
  remoteRenameTask: (id: string, name: string): Promise<boolean> =>
    ipcRenderer.invoke('remote:rename-task', id, name),
  /** All tasks, newest first (PRD §13.3 panel + §13.5 history). */
  remoteList: (): Promise<RemoteTaskSnapshot[]> => ipcRenderer.invoke('remote:list'),
  /** Answer a needs-user question — piped into the session stdin (PRD §7). */
  remoteAnswer: (id: string, answer: string): Promise<boolean> =>
    ipcRenderer.invoke('remote:answer', id, answer),
  /** Instant kill / Stop — terminates the session, keeps the row (PRD §10.4). */
  remoteKill: (id: string): Promise<boolean> => ipcRenderer.invoke('remote:kill', id),
  /** Kill/Delete — terminate + erase the task entirely (UI confirms first). */
  remoteRemoveTask: (id: string): Promise<boolean> => ipcRenderer.invoke('remote:remove-task', id),
  /** Resume a finished/reaped task — respawn its session with --continue, full
   *  prior context, alive + warm again (re-attachable terminal, ready for more). */
  remoteResume: (id: string): Promise<boolean> => ipcRenderer.invoke('remote:resume', id),
  /** Master kill switch — terminate every task's session at once. */
  remoteKillAll: (): Promise<boolean> => ipcRenderer.invoke('remote:kill-all'),
  /** A task was erased — drop its row. */
  remoteOnTaskRemoved: (cb: (d: { id: string }) => void) => {
    const h = (_e: unknown, d: { id: string }) => cb(d)
    ipcRenderer.on('remote:task-removed', h)
    return () => ipcRenderer.removeListener('remote:task-removed', h)
  },

  // ── Settings ──
  remoteGetSettings: (): Promise<RemoteSettingsSnapshot> => ipcRenderer.invoke('remote:get-settings'),
  remoteSetPermissionMode: (mode: 'prompt' | 'auto-approve'): Promise<boolean> =>
    ipcRenderer.invoke('remote:set-permission-mode', mode),
  /** Models for ONE backend, in that backend's own vocabulary. Claude Desktop
   *  answers from its own app bundle; Claude Code from the runtime catalogue.
   *  An empty list means "we cannot know" — show nothing selectable rather than
   *  another backend's models. */
  remoteModelOptions: (agent: ProviderId): Promise<{ agent: string; models: Array<{ id: string; label: string; family?: string; description?: string; effortLevels?: string[]; defaultEffort?: string | null }> }> =>
    ipcRenderer.invoke('remote:model-options', agent),

  // ── Claude desktop ──────────────────────────────────────────────────────
  /** Answer the permission prompt a task is stopped on. `option` is the LABEL
   *  the card displayed — not an index — so the choice cannot drift onto a
   *  different button between rendering and acting. */
  remoteClaudeDesktopAnswer: (taskId: string, option: string): Promise<{ ok: boolean; reason?: string }> =>
    ipcRenderer.invoke('remote:claude-desktop-answer', taskId, option),
  /** Send a message into an existing Claude Desktop conversation. */
  remoteClaudeDesktopSend: (taskId: string, text: string): Promise<{ ok: boolean; reason?: string }> =>
    ipcRenderer.invoke('remote:claude-desktop-send', taskId, text),
  /** Start a new Claude Desktop conversation. */
  remoteClaudeDesktopCreate: (intent: string): Promise<{ ok: boolean; id?: string; reason?: string }> =>
    ipcRenderer.invoke('remote:claude-desktop-create', intent),
  remoteSetAgent: (agent: ProviderId): Promise<boolean> =>
    ipcRenderer.invoke('remote:set-agent', agent),
  /** Backends that can take a task RIGHT NOW, for the pill's picker. Includes a
   *  per-option reason so the UI can distinguish "not installed" (hide it) from
   *  "not connected" (offer to connect). */
  remoteAgentOptions: (): Promise<{
    current: string
    options: Array<{ id: string; label: string; available: boolean; installed?: boolean; reason?: string }>
  }> => ipcRenderer.invoke('remote:agent-options'),
  /** Relaunch Codex with the debug port, in the background. User-initiated only. */
  remoteCodexConnect: (): Promise<{ ok: boolean; reason?: string }> =>
    ipcRenderer.invoke('remote:codex-connect'),
  remoteCodexProjects: (): Promise<Array<{ id: string; name: string }>> =>
    ipcRenderer.invoke('remote:codex-projects'),
  remoteSetSandboxRoots: (roots: string[]): Promise<boolean> =>
    ipcRenderer.invoke('remote:set-sandbox-roots', roots),
  remoteSetBrowserEnabled: (enabled: boolean): Promise<boolean> =>
    ipcRenderer.invoke('remote:set-browser-enabled', enabled),
  remoteSetOverlayAutoPresent: (on: boolean): Promise<boolean> =>
    ipcRenderer.invoke('remote:set-overlay-auto-present', on),

  /** Speak short confirmations through the macOS voice. Default off. */
  remoteSetVoiceFeedback: (on: boolean): Promise<boolean> =>
    ipcRenderer.invoke('remote:set-voice-feedback', on),
  /** Open the task surface when something starts needing you, instead of only
   *  tinting the bar and waiting for a tap. */
  remoteSetNotchAutoExpand: (on: boolean): Promise<boolean> =>
    ipcRenderer.invoke('remote:set-notch-auto-expand', on),
  /** Show a CLI task's terminal the moment the task opens. Off by default. */
  remoteSetTerminalAutoExpand: (on: boolean): Promise<boolean> =>
    ipcRenderer.invoke('remote:set-terminal-auto-expand', on),
  /** Share of the screen an expanded surface fills: 0.7 | 0.8 | 0.9. */
  remoteSetSurfaceFill: (fill: number): Promise<number> =>
    ipcRenderer.invoke('remote:set-surface-fill', fill),
  /** Whether native Unmute surfaces appear in screenshots and screen sharing. */
  remoteSetShowInScreenCapture: (on: boolean): Promise<boolean> =>
    ipcRenderer.invoke('remote:set-show-in-screen-capture', on),
  /** Toggle docked mode (compact bottom-right pill that expands on demand). */
  remoteSetOverlayDocked: (on: boolean): Promise<boolean> =>
    ipcRenderer.invoke('remote:set-overlay-docked', on),
  remoteSetOsNotifications: (on: boolean): Promise<boolean> =>
    ipcRenderer.invoke('remote:set-os-notifications', on),

  // ── Doer model selector (Remote only) ──
  /** Current doer model ('haiku' | 'sonnet' | 'opus'). */
  remoteGetModel: (): Promise<string> => ipcRenderer.invoke('remote:get-model'),
  /** The effective, config-driven selectable model catalog (id + label +
   *  description) — the settings selector renders THIS, so new models can arrive
   *  via runtime config without an app rebuild. */
  remoteGetModelCatalog: (): Promise<Array<{ id: string; label: string; description?: string }>> => ipcRenderer.invoke('remote:get-model-catalog'),

  /** Codex's OWN model / effort / speed, read from the running app. The chip
   *  must offer what the chosen agent has — not Claude's tiers under a Codex
   *  label, which is what made "Codex + Opus" a reachable state. */
  remoteCodexReasoning: (): Promise<{
    label: string | null
    current: Partial<Record<'Model' | 'Effort' | 'Speed', string>>
    options: Partial<Record<'Model' | 'Effort' | 'Speed', string[]>>
  }> => ipcRenderer.invoke('remote:codex-reasoning'),
  remoteCodexReasoningSet: (axis: 'Model' | 'Effort' | 'Speed', value: string): Promise<boolean> =>
    ipcRenderer.invoke('remote:codex-reasoning-set', axis, value),
  remoteCodexReasoningRefresh: (): Promise<unknown> => ipcRenderer.invoke('remote:codex-reasoning-refresh'),
  /** The same two axes for the Codex CLI, read from the `codex` binary on PATH
   *  rather than from a running app. Deliberately the SAME SHAPE as the desktop
   *  reader above so one component renders both — the two backends genuinely do
   *  offer the same choice, and giving them different shapes is how one of them
   *  ends up with a picker nobody updated. */
  remoteCodexCliReasoning: (): Promise<{
    label: string | null
    current: Partial<Record<'Model' | 'Effort', string>>
    options: Partial<Record<'Model' | 'Effort', string[]>>
  }> => ipcRenderer.invoke('remote:codex-cli-reasoning'),
  remoteCodexCliReasoningSet: (axis: 'Model' | 'Effort', value: string): Promise<boolean> =>
    ipcRenderer.invoke('remote:codex-cli-reasoning-set', axis, value),
  /** Set the doer model; applies to the next dispatched task. Returns the
   *  validated value actually stored. */
  remoteSetModel: (m: string): Promise<string> => ipcRenderer.invoke('remote:set-model', m),
  /** Grant or revoke full-access for unmute-launched Codex CLI tasks. */
  remoteSetCodexFullAccess: (on: boolean): Promise<boolean> =>
    ipcRenderer.invoke('remote:set-codex-full-access', on),
  // ── Raw mode (no Unmute memory injection / librarian) ──
  /** Current raw state: the saved default, the session override (null = none), and
   *  what's effectively in force right now. */
  remoteGetRawState: (): Promise<{ persistentRawDefault: boolean; sessionOverride: boolean | null; effectiveRaw: boolean }> =>
    ipcRenderer.invoke('remote:get-raw-state'),
  /** Set the PERSISTENT raw default (Remote screen) — applies to all future sessions. */
  remoteSetForceRaw: (on: boolean): Promise<boolean> => ipcRenderer.invoke('remote:set-force-raw', on),
  /** Set the per-SESSION raw override (pill) — resets on relaunch; null clears it. */
  remoteSetSessionRaw: (on: boolean | null): Promise<boolean> => ipcRenderer.invoke('remote:set-session-raw', on),
  // ── Memory footprint + on-demand cleanup ──
  /** On-disk footprint of the memory store + recipe/skill counts (for the UI). */
  remoteGetMemoryUsage: (): Promise<{ bytes: number; recipeCount: number; skillCount: number }> =>
    ipcRenderer.invoke('remote:get-memory-usage'),
  /** Run the deterministic cleanup (dedup + prune + LRU-evict + retire stale-high).
   *  Returns the names touched in each category. */
  remoteCleanupMemory: (): Promise<{ pruned: string[]; evicted: string[]; demoted: string[]; deduped: string[] } | null> =>
    ipcRenderer.invoke('remote:cleanup-memory'),
  /** Fires when the model changes from EITHER surface, so both stay in sync. */
  remoteOnModelChanged: (cb: (model: string) => void): (() => void) => {
    const handler = (_e: unknown, model: string) => cb(model)
    ipcRenderer.on('remote:model-changed', handler)
    return () => ipcRenderer.removeListener('remote:model-changed', handler)
  },

  // ── Floating overlay window ──
  /** Manually open the overlay (a button in the app). */
  remoteOpenOverlay: (): void => ipcRenderer.send('remote:overlay-open'),
  /** User-triggered dismiss (✕) — closes for the session. */
  remoteOverlayDismiss: (): void => ipcRenderer.send('remote:overlay-dismiss'),
  /** Dock pill clicked → expand to the full panel. */
  remoteOverlayExpand: (): void => ipcRenderer.send('remote:overlay-expand'),
  /** Dock hover-toggle: catch clicks while over the pill, pass through otherwise. */
  remoteOverlaySetInteractive: (on: boolean): void => ipcRenderer.send('remote:overlay-set-interactive', on),
  /** Current presentation (pill vs panel) — fetched on mount to avoid a race. */
  remoteOverlayGetMode: (): Promise<{ mode: 'hidden' | 'docked' | 'expanded'; docked: boolean }> =>
    ipcRenderer.invoke('remote:overlay-get-mode'),
  /** Main tells the overlay which presentation to draw. */
  remoteOnOverlayMode: (cb: (d: { mode: 'hidden' | 'docked' | 'expanded'; docked: boolean }) => void): (() => void) => {
    const handler = (_e: unknown, d: { mode: 'hidden' | 'docked' | 'expanded'; docked: boolean }) => cb(d)
    ipcRenderer.on('remote:overlay-mode', handler)
    return () => ipcRenderer.removeListener('remote:overlay-mode', handler)
  },
  /** Main tells the overlay which task to expand when it auto-presents. */
  remoteOnOverlayFocus: (cb: (d: { taskId: string }) => void): (() => void) => {
    const handler = (_e: unknown, d: { taskId: string }) => cb(d)
    ipcRenderer.on('remote:overlay-focus', handler)
    return () => ipcRenderer.removeListener('remote:overlay-focus', handler)
  },
  /** Which session the wall currently OWNS the terminal for (or null). The overlay
   *  collapses its terminal to a glance for that session so the two never conflict. */
  remoteOnOrchestrateOwner: (cb: (d: { taskId: string | null }) => void): (() => void) => {
    const handler = (_e: unknown, d: { taskId: string | null }) => cb(d)
    ipcRenderer.on('remote:orchestrate-owner', handler)
    return () => ipcRenderer.removeListener('remote:orchestrate-owner', handler)
  },
  /** Voice lifecycle for the wall's listening surface: listening → transcribing →
   *  routing → idle (taskId = where it landed). Observed, never driven. */
  remoteOnCapturePhase: (cb: (d: { phase: 'listening' | 'transcribing' | 'routing' | 'idle'; taskId: string | null }) => void): (() => void) => {
    const handler = (_e: unknown, d: { phase: 'listening' | 'transcribing' | 'routing' | 'idle'; taskId: string | null }) => cb(d)
    ipcRenderer.on('remote:capture-phase', handler)
    return () => ipcRenderer.removeListener('remote:capture-phase', handler)
  },
  /** Declinable route offer: the router chose NEW but nearly chose altTaskId.
   *  One-tap redirect; ignoring it costs nothing (it expires in the UI). */
  remoteOnRouteOffer: (cb: (d: { newTaskId: string; altTaskId: string; altName: string }) => void): (() => void) => {
    const handler = (_e: unknown, d: { newTaskId: string; altTaskId: string; altName: string }) => cb(d)
    ipcRenderer.on('remote:route-offer', handler)
    return () => ipcRenderer.removeListener('remote:route-offer', handler)
  },
  /** Accept the pending offer: erases the mis-spawn, reroutes the utterance. */
  remoteAcceptRouteOffer: (newTaskId: string): Promise<boolean> =>
    ipcRenderer.invoke('remote:accept-route-offer', newTaskId),
  /** Pin/unpin a task's species: 'session' = persistent (no idle-kill/purge). */
  remoteSetKind: (id: string, kind: 'oneoff' | 'session'): Promise<boolean> =>
    ipcRenderer.invoke('remote:set-kind', id, kind),
  /** Voice-as-doorbell (§6.4): spoken headlines for needs-you states. */
  remoteGetVoiceHeadlines: (): Promise<boolean> => ipcRenderer.invoke('remote:get-voice-headlines'),
  remoteSetVoiceHeadlines: (on: boolean): Promise<boolean> => ipcRenderer.invoke('remote:set-voice-headlines', on),
  /** Capture during dictation/Remote: copies AND screenshots land in the
   *  transcript where they happened. Off = Unmute never looks at either.
   *  (The channel name predates text capture; the setting is `captureEnabled`.) */
  remoteGetScreenshotCapture: (): Promise<boolean> => ipcRenderer.invoke('remote:get-screenshot-capture'),
  /** The scratchpad: may a capture be HELD instead of delivered on stop?
   *  Independent of capture — a pad can be built from speech alone. */
  remoteGetScratchpadEnabled: (): Promise<boolean> => ipcRenderer.invoke('remote:get-scratchpad-enabled'),
  remoteSetScratchpadEnabled: (on: boolean): Promise<boolean> =>
    ipcRenderer.invoke('remote:set-scratchpad-enabled', on),
  /** Unmute MCP: may sessions create peer tasks? */
  remoteGetAgentTasks: (): Promise<boolean> => ipcRenderer.invoke('remote:get-agent-tasks'),
  remoteSetAgentTasks: (on: boolean): Promise<boolean> => ipcRenderer.invoke('remote:set-agent-tasks', on),
  remoteSetScreenshotCapture: (on: boolean): Promise<boolean> => ipcRenderer.invoke('remote:set-screenshot-capture', on),

  // ── Onboarding / guided one-time setup (PRD §12) ──
  /** The setup checklist: auto-detected (MCP/Chrome profile) + user-confirmed steps. */
  remoteGetSetupStatus: (): Promise<RemoteSetupStatus> =>
    ipcRenderer.invoke('remote:get-setup-status'),
  /** Mark a manual step done/undone; returns the refreshed checklist. */
  remoteSetSetupConfirmation: (key: string, done: boolean): Promise<RemoteSetupStatus> =>
    ipcRenderer.invoke('remote:set-setup-confirmation', key, done),
  /** Unmute installs tmux itself (via Homebrew); returns the refreshed checklist. */
  remoteInstallTmux: (): Promise<RemoteSetupStatus> => ipcRenderer.invoke('remote:install-tmux'),

  // ── Render-on-demand live terminal (PRD §13.4 #8) ──
  /** Recent buffered PTY output for a task (for opening the live view). */
  remoteGetOutput: (taskId: string): Promise<string> => ipcRenderer.invoke('remote:get-output', taskId),
  /** Open a result artifact in the user's default app — URL in the default
   *  browser (background tab, no focus steal), path in Finder. */
  remoteOpenArtifact: (type: 'url' | 'path', value: string): Promise<boolean> =>
    ipcRenderer.invoke('remote:open-artifact', type, value),
  /** Live PTY output chunks for the currently-watched task. Returns an
   *  unsubscribe fn so a re-summoned terminal doesn't leak listeners. */
  remoteOnOutput: (cb: (d: { taskId: string; chunk: string }) => void): (() => void) => {
    const handler = (_e: unknown, d: { taskId: string; chunk: string }) => cb(d)
    ipcRenderer.on('remote:task-output', handler)
    return () => ipcRenderer.removeListener('remote:task-output', handler)
  },
  /** Typeable terminal (PRD §4.3): raw keystrokes from xterm → the task's PTY. */
  remoteTerminalInput: (taskId: string, data: string): void =>
    ipcRenderer.send('remote:terminal-input', taskId, data),
  /** Tell the PTY the on-screen terminal size so the TUI reflows (SIGWINCH). */
  remoteTerminalResize: (taskId: string, cols: number, rows: number): void =>
    ipcRenderer.send('remote:terminal-resize', taskId, cols, rows),
  /** Is tmux available? (gates the "open in terminal" pop-out button). */
  remoteTmuxAvailable: (): Promise<boolean> => ipcRenderer.invoke('remote:tmux-available'),
  /** Pop this task's live session out to a real terminal app — SAME session. */
  remoteOpenInTerminal: (taskId: string): Promise<boolean> =>
    ipcRenderer.invoke('remote:open-in-terminal', taskId),

  // ── Live task events (drive the ambient pill + task panel) ──
  // Each returns an UNSUBSCRIBE fn. Without it the renderer hook leaked a listener
  // per mount; over a long-lived window (the overlay) those pile up. The renderer
  // now calls the returned fn on unmount.
  remoteOnTaskCreated: (cb: (t: RemoteTaskSnapshot) => void) => {
    const h = (_e: unknown, t: RemoteTaskSnapshot) => cb(t)
    ipcRenderer.on('remote:task-created', h)
    return () => ipcRenderer.removeListener('remote:task-created', h)
  },
  remoteOnTaskUpdated: (cb: (t: RemoteTaskSnapshot) => void) => {
    const h = (_e: unknown, t: RemoteTaskSnapshot) => cb(t)
    ipcRenderer.on('remote:task-updated', h)
    return () => ipcRenderer.removeListener('remote:task-updated', h)
  },
  remoteOnTaskNeedsUser: (cb: (t: RemoteTaskSnapshot) => void) => {
    const h = (_e: unknown, t: RemoteTaskSnapshot) => cb(t)
    ipcRenderer.on('remote:task-needs-user', h)
    return () => ipcRenderer.removeListener('remote:task-needs-user', h)
  },
  remoteOnTaskDone: (cb: (t: RemoteTaskSnapshot) => void) => {
    const h = (_e: unknown, t: RemoteTaskSnapshot) => cb(t)
    ipcRenderer.on('remote:task-done', h)
    return () => ipcRenderer.removeListener('remote:task-done', h)
  },
  remoteOnTaskFailed: (cb: (t: RemoteTaskSnapshot) => void) => {
    const h = (_e: unknown, t: RemoteTaskSnapshot) => cb(t)
    ipcRenderer.on('remote:task-failed', h)
    return () => ipcRenderer.removeListener('remote:task-failed', h)
  },
  remoteOnTaskStuck: (cb: (t: RemoteTaskSnapshot) => void) => {
    const h = (_e: unknown, t: RemoteTaskSnapshot) => cb(t)
    ipcRenderer.on('remote:task-stuck', h)
    return () => ipcRenderer.removeListener('remote:task-stuck', h)
  },

  // ── Capture kind (drives the pill's Remote badge) ──
  // The 4th arg of 'recording:start' carries the session KIND ('dictation' |
  // 'remote'). The base onRecordingStart bridge ignores extra args, so this is a
  // second, additive listener that surfaces the kind to the HUD — letting the
  // pill show a distinct Remote marker so the user can tell a Remote capture
  // (dispatches a task) from a dictation capture (types text).
  remoteOnCaptureKind: (cb: (kind: 'dictation' | 'remote') => void) =>
    ipcRenderer.on('recording:start', (_e, _mode, _sessionId, kind) =>
      cb(kind === 'remote' ? 'remote' : 'dictation')),

  // ── The remote capture reached its task ──
  //
  // A Remote capture has no output:ready: the words go to a task, not to the
  // pasteboard, so every terminal event the widget listens for belongs to the
  // dictation lane and none of them fire. sessionManager has always SENT this
  // (`sendToWidget('remote:dispatched', …)`) and nothing has ever listened,
  // which left the widget stuck at `processing` after every Remote capture —
  // and any later re-push of that state object put the pill back on screen.
  remoteOnDispatched: (cb: () => void) => {
    const h = () => cb()
    ipcRenderer.on('remote:dispatched', h)
    return () => ipcRenderer.removeListener('remote:dispatched', h)
  },

  // ── The live capture changed lanes (fn ⇄ right-Option ⇄ right-Command) ──
  //
  // ITS OWN CHANNEL, AND THAT IS THE WHOLE POINT. The obvious way to update
  // the badge mid-capture is to re-send 'recording:start' with the new kind —
  // and the renderer's handler for that calls startRecording(), which
  // re-acquires the microphone and throws away everything spoken so far. A
  // switch must be visible without being audible, so it gets a channel that
  // nothing in the audio path listens to.
  remoteOnCaptureRoute: (cb: (route: 'cursor' | 'task' | 'agent') => void) => {
    const h = (_e: unknown, route: string) => {
      if (route === 'cursor' || route === 'task' || route === 'agent') cb(route)
    }
    ipcRenderer.on('capture:route', h)
    return () => ipcRenderer.removeListener('capture:route', h)
  },

  // ── Meeting Notetaker floating widget (bottom-left) ──
  /** User chose the normal, save-and-generate-notes completion path from the
   *  floating widget. */
  notetakerEndRequested: (): void => ipcRenderer.send('notetaker:end-requested'),
  /** User chose the explicit Discard action from the floating widget. */
  notetakerCancelRequested: (): void => ipcRenderer.send('notetaker:cancel-requested'),
  /** Main tells the widget whether a REAL capture is running right now.
   *  The widget window is REUSED across sessions (hidden, never closed), so
   *  its renderer never unmounts — it must acquire the mic on `true` and
   *  fully release it on `false` rather than at mount/unmount, or one
   *  session would leave a second live mic capture open for the rest of the
   *  app's run (mic indicator stuck on, Bluetooth pinned to HFP, dictation
   *  degraded). Returns an unsubscribe fn, like the other on* bridges. */
  notetakerOnCaptureActive: (cb: (active: boolean) => void): (() => void) => {
    const handler = (_e: unknown, active: boolean) => cb(!!active)
    ipcRenderer.on('notetaker:capture-active', handler)
    return () => ipcRenderer.removeListener('notetaker:capture-active', handler)
  },
  /** Main gives the just-finished widget a momentary completion state before
   *  hiding it. */
  notetakerOnCompleted: (cb: () => void): (() => void) => {
    const handler = () => cb()
    ipcRenderer.on('notetaker:completed', handler)
    return () => ipcRenderer.removeListener('notetaker:completed', handler)
  },
  /** Tells main the widget's IPC listeners (capture-active, stop-pending)
   *  are actually mounted and ready to receive — sent once, right after the
   *  route mounts both. Fixes a real, observed race: on the widget's very
   *  first-ever show() (right after app launch), main's initial
   *  broadcastCaptureActive(true) call and even its own 'did-finish-load'
   *  resend could both land before this window's React effects had
   *  registered their listeners, so the signal was silently dropped and the
   *  meeting never acquired a mic. did-finish-load only proves the page's
   *  script STARTED running, not that React has mounted — this message is
   *  the renderer's own, authoritative confirmation instead of an inferred
   *  one, so main can resend the current state knowing it will actually
   *  arrive. See notetakerWidget.ts's 'notetaker:widget-ready' handler. */
  notetakerWidgetReady: (): void => ipcRenderer.send('notetaker:widget-ready'),
  /** The Unmute Agent asked to open one meeting (notetaker_open) — main has
   *  already shown/focused the window by the time this fires; the renderer's
   *  only job is to land on the Notetaker tab with this meeting selected. */
  notetakerOnOpenRequested: (cb: (meetingId: string) => void): (() => void) => {
    const handler = (_e: unknown, meetingId: string) => cb(meetingId)
    ipcRenderer.on('notetaker:open-meeting-requested', handler)
    return () => ipcRenderer.removeListener('notetaker:open-meeting-requested', handler)
  },
  /** The MIC half of a meeting recording: raw Float32 PCM tapped off the
   *  widget's own (already-open, capture-window-scoped) getUserMedia stream,
   *  handed to NotetakerSession.feedMicChunk() in main. The system half comes
   *  from the native Core Audio process tap and never touches a renderer.
   *
   *  send(), not invoke(): this is a continuous ~12-messages-per-second audio
   *  feed with nothing to return — the same fire-and-forget shape as
   *  notetakerCancelRequested above, and as sendAudioChunk's ArrayBuffer
   *  payload in the dictation path. `samples` is a transferable ArrayBuffer of
   *  little-endian Float32s, NOT an array of numbers: an array would be ~8x
   *  the bytes and pay a full serialize/deserialize per sample. */
  notetakerMicChunk: (samples: ArrayBuffer, sampleRate: number, timestampMs: number): void =>
    ipcRenderer.send('notetaker:mic-chunk', samples, sampleRate, timestampMs),

  // ── Meeting list/detail (Tasks 8-10's UI) ──
  /** All meetings, newest-started first. */
  notetakerListMeetings: (): Promise<NotetakerMeetingSnapshot[]> => ipcRenderer.invoke('notetaker:list-meetings'),
  /** A meeting's merged transcript segments, or [] if none / unreadable. */
  notetakerGetTranscript: (id: string): Promise<NotetakerTranscriptSegment[]> =>
    ipcRenderer.invoke('notetaker:get-transcript', id),
  /** Rename a meeting (title is user-editable, like task names). */
  notetakerRenameMeeting: (id: string, title: string): Promise<void> =>
    ipcRenderer.invoke('notetaker:rename-meeting', id, title),
  /** Delete a meeting's row, transcript, and any remaining audio. */
  notetakerDeleteMeeting: (id: string): Promise<void> => ipcRenderer.invoke('notetaker:delete-meeting', id),
  /** A URL for the user-facing mixed meeting recording (or an internal
   *  channel for compatibility), null after 24h audio retention. */
  notetakerGetAudioUrl: (id: string, channel: 'mic' | 'system' | 'mixed'): Promise<string | null> =>
    ipcRenderer.invoke('notetaker:get-audio-url', id, channel),
  notetakerGetScreenshots: (id: string): Promise<NotetakerScreenshot[]> =>
    ipcRenderer.invoke('notetaker:get-screenshots', id),
  /** Relays a widget-renderer diagnostic (getUserMedia result, device label,
   *  AudioWorklet-vs-ScriptProcessor fallback, tap teardown, etc.) into
   *  main's one durable notetaker log file — see notetakerInit.ts's
   *  'notetaker:widget-log' handler. send(), not invoke(): fire-and-forget,
   *  nothing to return, must never block the renderer on a log line. */
  notetakerWidgetLog: (level: 'debug' | 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>): void =>
    ipcRenderer.send('notetaker:widget-log', level, message, fields),

  // ── Transcript cleanup + auto-summarization (2026-08-25 spec) ──
  /** The CLEANED transcript's segments, or [] if cleanup hasn't succeeded
   *  for this meeting (disabled, pending, or failed) — see
   *  notetakerGetTranscript above for the raw version, always available
   *  regardless of cleanup status. */
  notetakerGetCleanedTranscript: (id: string): Promise<NotetakerTranscriptSegment[]> =>
    ipcRenderer.invoke('notetaker:get-cleaned-transcript', id),
  /** Generated notes, or null if summarization hasn't succeeded for this
   *  meeting. */
  notetakerGetNotes: (id: string): Promise<NotetakerMeetingNotes | null> =>
    ipcRenderer.invoke('notetaker:get-notes', id),
  /** Current pipeline settings, plus live provider availability (spec §8 —
   *  only an actually-usable provider may be selected). */
  notetakerGetPipelineSettings: (): Promise<NotetakerPipelineSettings> =>
    ipcRenderer.invoke('notetaker:get-pipeline-settings'),
  notetakerSavePipelineSettings: (patch: Partial<Pick<NotetakerPipelineSettings, 'auto_pipeline_enabled' | 'provider' | 'summary_prompt'>>): Promise<void> =>
    ipcRenderer.invoke('notetaker:save-pipeline-settings', patch),
  /** Re-runs whichever pipeline stage(s) haven't succeeded yet for this
   *  meeting (spec §6) — never redoes a stage that already succeeded. */
  notetakerRetryPipeline: (id: string): Promise<void> => ipcRenderer.invoke('notetaker:retry-pipeline', id),
  /** Re-transcribes retained meeting audio, replaces the transcript, and
   * regenerates notes. It is deliberately isolated to the note-taker. */
  notetakerRetryTranscription: (id: string): Promise<void> => ipcRenderer.invoke('notetaker:retry-transcription', id),
  /** Just the two status fields — a lightweight poll target while a stage
   *  is 'pending', instead of re-fetching the whole meeting list. */
  notetakerGetPipelineStatus: (id: string): Promise<{ cleanup_status: NotetakerPipelineStatus; summary_status: NotetakerPipelineStatus } | null> =>
    ipcRenderer.invoke('notetaker:get-pipeline-status', id),
}

export type RemoteAPI = typeof remotePreloadExtensions
