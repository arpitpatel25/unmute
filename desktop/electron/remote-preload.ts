// Unmute Remote — preload bridge. Spread into the OSS engine's electronAPI by
// the build step (same mechanism as paywallPreloadExtensions — see PATCHES.md).
//
// Each method maps to an IPC handler/broadcast registered in remote/init.ts.

import { ipcRenderer } from 'electron'

export interface RemoteTaskSnapshot {
  id: string
  intent: string
  state: 'processing' | 'needs-user' | 'stuck' | 'done' | 'failed'
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
  logFile: string | null
}

export interface RemoteSetupStep {
  key: string
  title: string
  detail: string
  command?: string
  status: 'done' | 'todo'
  auto: boolean
}
export interface RemoteSetupStatus {
  steps: RemoteSetupStep[]
  complete: boolean
}

export const remotePreloadExtensions = {
  // ── Actions ──
  /** Dispatch a task by text (capture path types its own; this is for UI re-run/manual). */
  remoteDispatch: (intent: string): Promise<string | null> =>
    ipcRenderer.invoke('remote:dispatch', intent),
  /** All tasks, newest first (PRD §13.3 panel + §13.5 history). */
  remoteList: (): Promise<RemoteTaskSnapshot[]> => ipcRenderer.invoke('remote:list'),
  /** Answer a needs-user question — piped into the session stdin (PRD §7). */
  remoteAnswer: (id: string, answer: string): Promise<boolean> =>
    ipcRenderer.invoke('remote:answer', id, answer),
  /** Instant kill (PRD §10.4). */
  remoteKill: (id: string): Promise<boolean> => ipcRenderer.invoke('remote:kill', id),

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

  // ── Onboarding / guided one-time setup (PRD §12) ──
  /** The setup checklist: auto-detected (MCP/Chrome profile) + user-confirmed steps. */
  remoteGetSetupStatus: (): Promise<RemoteSetupStatus> =>
    ipcRenderer.invoke('remote:get-setup-status'),
  /** Mark a manual step done/undone; returns the refreshed checklist. */
  remoteSetSetupConfirmation: (key: string, done: boolean): Promise<RemoteSetupStatus> =>
    ipcRenderer.invoke('remote:set-setup-confirmation', key, done),
  /** User-initiated launch of the dedicated automation Chrome (onboarding). */
  remoteLaunchAutomationChrome: (): Promise<boolean> =>
    ipcRenderer.invoke('remote:launch-automation-chrome'),

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
  /** Tell the PTY the on-screen terminal size so the TUI reflows. */
  remoteTerminalResize: (taskId: string, cols: number, rows: number): void =>
    ipcRenderer.send('remote:terminal-resize', taskId, cols, rows),
  /** Is tmux available? (gates the "open in terminal" pop-out button). */
  remoteTmuxAvailable: (): Promise<boolean> => ipcRenderer.invoke('remote:tmux-available'),
  /** Pop this task's live session out to a real terminal app — SAME session. */
  remoteOpenInTerminal: (taskId: string): Promise<boolean> =>
    ipcRenderer.invoke('remote:open-in-terminal', taskId),

  // ── Live task events (drive the ambient pill + task panel) ──
  remoteOnTaskCreated: (cb: (t: RemoteTaskSnapshot) => void) =>
    ipcRenderer.on('remote:task-created', (_e, t) => cb(t)),
  remoteOnTaskUpdated: (cb: (t: RemoteTaskSnapshot) => void) =>
    ipcRenderer.on('remote:task-updated', (_e, t) => cb(t)),
  remoteOnTaskNeedsUser: (cb: (t: RemoteTaskSnapshot) => void) =>
    ipcRenderer.on('remote:task-needs-user', (_e, t) => cb(t)),
  remoteOnTaskDone: (cb: (t: RemoteTaskSnapshot) => void) =>
    ipcRenderer.on('remote:task-done', (_e, t) => cb(t)),
  remoteOnTaskFailed: (cb: (t: RemoteTaskSnapshot) => void) =>
    ipcRenderer.on('remote:task-failed', (_e, t) => cb(t)),
  remoteOnTaskStuck: (cb: (t: RemoteTaskSnapshot) => void) =>
    ipcRenderer.on('remote:task-stuck', (_e, t) => cb(t)),
}

export type RemoteAPI = typeof remotePreloadExtensions
