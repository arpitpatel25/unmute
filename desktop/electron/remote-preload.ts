// Unmute Remote — preload bridge. Spread into the OSS engine's electronAPI by
// the build step (same mechanism as paywallPreloadExtensions — see PATCHES.md).
//
// Each method maps to an IPC handler/broadcast registered in remote/init.ts.

import { ipcRenderer } from 'electron'
import type { Proposal } from './remote/curator-store'

export interface RemoteTaskSnapshot {
  id: string
  intent: string
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
  overlayDocked: boolean
  osNotifications: boolean
  /** Persistent default: force RAW (no Unmute injection/librarian) for all tasks. */
  forceRawMode: boolean
  logFile: string | null
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

export const remotePreloadExtensions = {
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
  /** Open the Orchestrate cockpit window from the in-app Remote screen. */
  remoteOpenOrchestrate: (): Promise<boolean> => ipcRenderer.invoke('remote:open-orchestrate'),
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
  /** Shelve/unshelve a task — kept but out of the way (hidden from the wall grid). */
  remoteSetShelved: (taskId: string, on: boolean): Promise<boolean> =>
    ipcRenderer.invoke('remote:set-shelved', taskId, on),
  /** Set/clear the user's note on a task card (empty string clears). */
  remoteSetNote: (taskId: string, note: string): Promise<boolean> =>
    ipcRenderer.invoke('remote:set-note', taskId, note),
  remoteListProjects: (): Promise<Array<{ name: string; path: string }>> =>
    ipcRenderer.invoke('remote:list-projects'),
  /** Rename a task (names are voice addresses — fixable by the user). */
  remoteRenameTask: (id: string, name: string): Promise<boolean> =>
    ipcRenderer.invoke('remote:rename-task', id, name),
  /** Staging tray: stage an image with NO target — it rides with the next
   *  utterance to wherever that lands (new task / continuation / answer). */
  remoteStageImage: (data: ArrayBuffer, ext: string): Promise<string | null> =>
    ipcRenderer.invoke('remote:stage-image', data, ext),
  remoteGetStaged: (): Promise<string[]> => ipcRenderer.invoke('remote:get-staged'),
  remoteClearStaged: (): Promise<boolean> => ipcRenderer.invoke('remote:clear-staged'),
  remoteUnstageImage: (path: string): Promise<boolean> => ipcRenderer.invoke('remote:unstage-image', path),
  /** Small data-URL thumbnails of the staged images (for the pill dropdown). */
  remoteGetStagedPreviews: (): Promise<Array<{ path: string; dataUrl: string }>> =>
    ipcRenderer.invoke('remote:staged-previews'),
  remoteOnStagedChanged: (cb: (d: { count: number; paths: string[] }) => void): (() => void) => {
    const handler = (_e: unknown, d: { count: number; paths: string[] }) => cb(d)
    ipcRenderer.on('remote:staged-changed', handler)
    return () => ipcRenderer.removeListener('remote:staged-changed', handler)
  },
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
  remoteSetAgent: (agent: 'claude' | 'codex'): Promise<boolean> =>
    ipcRenderer.invoke('remote:set-agent', agent),
  remoteSetSandboxRoots: (roots: string[]): Promise<boolean> =>
    ipcRenderer.invoke('remote:set-sandbox-roots', roots),
  remoteSetBrowserEnabled: (enabled: boolean): Promise<boolean> =>
    ipcRenderer.invoke('remote:set-browser-enabled', enabled),
  remoteSetOverlayAutoPresent: (on: boolean): Promise<boolean> =>
    ipcRenderer.invoke('remote:set-overlay-auto-present', on),
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
  /** Set the doer model; applies to the next dispatched task. Returns the
   *  validated value actually stored. */
  remoteSetModel: (m: string): Promise<string> => ipcRenderer.invoke('remote:set-model', m),
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
  /** Screenshot auto-capture during dictation/Remote (off = never touch screenshots). */
  remoteGetScreenshotCapture: (): Promise<boolean> => ipcRenderer.invoke('remote:get-screenshot-capture'),
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
}

export type RemoteAPI = typeof remotePreloadExtensions
