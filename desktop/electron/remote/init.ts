// Unmute Remote — main-process wiring (mirrors paywall/main-extensions.ts).
//
// The build script adds one import + call to the OSS engine's main.ts:
//     import { initRemote } from './remote/init'
//     initRemote(app)
//
// Responsibilities:
//   * configure the session log file (PRD owner ask: logs reconstruct the UX),
//   * construct the TaskManager with a ClaudeCodeExecutor factory whose
//     permission posture follows the Settings toggle (PRD §10.1),
//   * register IPC handlers the renderer uses (dispatch / list / answer / kill
//     / settings),
//   * broadcast task events to all renderers so the ambient pill + task panel
//     stay live (PRD §13.2–13.4),
//   * expose dispatchFromCapture() for the sessionManager Remote seam (§5).
//
// This file is Electron glue (imports electron / electron-store), so it is
// NOT unit-tested — exactly like paywall/main-extensions.ts. The logic it
// orchestrates (TaskManager, executor, status-file) is unit-tested separately.

import { ipcMain, BrowserWindow, Notification } from 'electron'
import Store from 'electron-store'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { TaskManager, type Task } from './task-manager'
import { Librarian } from './librarian'
import { ClaudeCodeExecutor } from './pty-session'
import { CodexExecutor, type AgentKind } from './codex-executor'
import { cleanIntent, type CompleteFn } from './intent-cleanup'
import { deriveRemoteKey, type TriggerKey } from './mode-router'
import { configureRemoteLogging, createLogger, getRemoteLogFilePath } from './log'
import { launchAutomationChrome } from './browser'

// ─── Loose interfaces for the OSS engine singletons we wire into ───
// Accepted as opaque shapes (like paywall/main-extensions' OSSAdapter) so we
// don't entangle with engine internals. main.ts passes its real instances.
interface SessionManagerLike {
  startRemoteCapture(): void
  stopRemoteCapture(): Promise<void>
}
interface KeyboardManagerLike {
  on(event: 'keyboard', cb: (e: { type: string }) => void): unknown
}
export interface RemoteInitDeps {
  sessionManager: SessionManagerLike
  keyboardManager: KeyboardManagerLike
}

const log = createLogger('init')

// PRD §10.1: auto-approve OFF by default (the safe default). ON ⇒ launch claude
// with --dangerously-skip-permissions so routine tool use doesn't pause.
type PermissionMode = 'prompt' | 'auto-approve'

interface RemoteSettings {
  permissionMode: PermissionMode
  // The dictation key already exists as an OSS setting; we read it to DERIVE
  // the Remote key (PRD §2.4.4). Stored here only as a cache/fallback.
  dictationKey: TriggerKey
  // PRD §11: which CLI coding agent executes tasks. Default 'claude'.
  agent: AgentKind
  // PRD §10.6: path sandbox — allowlisted roots. Empty ⇒ OFF (default posture).
  sandboxRoots: string[]
  // DECIDED: executor runs Opus (router uses a lighter model). '' ⇒ inherit default.
  model: string
  // DECIDED: connect Claude-in-Chrome by default (browser tasks need it; others
  // ignore it). User can disable. Setup of the extension is guided/one-time.
  browserEnabled: boolean
}

const settings = new Store<RemoteSettings>({
  name: 'unmute-remote-settings',
  defaults: {
    permissionMode: 'prompt',
    dictationKey: 'fn',
    agent: 'claude',
    sandboxRoots: [],
    model: 'opus',
    browserEnabled: true,
  },
})

let manager: TaskManager | null = null
let completeFn: CompleteFn | null = null

/** Broadcast a task snapshot to every renderer (ambient pill + panel). */
function broadcast(channel: string, task: Task): void {
  const safe = serializeTask(task)
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, safe)
  }
}

/** Plain, structured-clone-safe snapshot of a task for IPC. */
function serializeTask(t: Task) {
  return {
    id: t.id,
    intent: t.intent,
    state: t.state,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    result: t.result ?? null,
    error: t.error ?? null,
    question: t.question ?? null,
    mcpGap: t.mcpGap ?? null,
  }
}

// PRD §13.6: Unmute OBSERVES completion (it's the parent process) and emits the
// notification itself — Claude never notifies Unmute.
function notify(title: string, body: string): void {
  try {
    if (Notification.isSupported()) new Notification({ title, body }).show()
  } catch (e) {
    log.warn('notification failed', { error: (e as Error).message })
  }
}

function executorFactory() {
  const mode = settings.get('permissionMode')
  const agent = settings.get('agent')
  const sandboxRoots = settings.get('sandboxRoots') ?? []
  const sandboxed = sandboxRoots.length > 0
  const model = settings.get('model') || 'opus'
  const browser = settings.get('browserEnabled') !== false
  log.event('executor-factory', { agent, permissionMode: mode, sandboxed, sandboxRoots, model, browser })
  if (agent === 'codex') {
    return new CodexExecutor({})
  }
  // PRD §10.1/§10.6 interaction: a sandbox is the "fenced yard" — when it's ON
  // we do NOT skip permissions globally (out-of-fence access still prompts via
  // needs-user); claude gets the allowed roots via --add-dir.
  const extraArgs = !sandboxed && mode === 'auto-approve' ? ['--dangerously-skip-permissions'] : []
  return new ClaudeCodeExecutor({
    extraArgs,
    addDirs: sandboxRoots,
    model, // DECIDED: Opus for executor sessions
    chrome: browser, // DECIDED: Claude-in-Chrome on by default (browser lane)
  })
}

/**
 * Register an LLM completion fn for intent-cleanup (PRD §13.7). Wired from the
 * paywall layer (managed/BYOK) when available; if never set, cleanup is a
 * passthrough (raw transcript dispatched) — which still works.
 */
export function registerIntentCleanupLLM(fn: CompleteFn): void {
  completeFn = fn
  log.event('intent-cleanup-llm-registered', {})
}

/**
 * The entry the sessionManager Remote seam calls with the raw STT transcript
 * (PRD §5.1). Cleans the intent (or passes through) then dispatches a task.
 * Returns the taskId.
 */
export async function dispatchFromCapture(rawTranscript: string): Promise<string | null> {
  if (!manager) {
    log.error('dispatchFromCapture before initRemote')
    return null
  }
  const cleaned = completeFn
    ? (await cleanIntent(rawTranscript, completeFn)).intent
    : rawTranscript.trim()
  if (!cleaned) {
    log.warn('empty intent after cleanup — not dispatching', { rawTranscript })
    return null
  }
  return manager.dispatch(cleaned)
}

/** Read the current Remote trigger key (derived from the dictation key, §2.4.4). */
export function getRemoteKey(): TriggerKey {
  return deriveRemoteKey(settings.get('dictationKey'))
}

/** Called by the keyListener seam when it learns the dictation-key setting. */
export function setDictationKey(key: TriggerKey): void {
  settings.set('dictationKey', key)
  log.event('dictation-key-set', { dictationKey: key, derivedRemoteKey: deriveRemoteKey(key) })
}

export function initRemote(deps: RemoteInitDeps): TaskManager {
  if (manager) return manager

  const logDir = join(homedir(), '.unmute', 'remote', 'logs')
  const runId = String(Date.now())
  const logFile = configureRemoteLogging({ dir: logDir, runId })
  log.event('init-remote', { logFile, permissionMode: settings.get('permissionMode') })

  // DECIDED isolation: when the browser lane is on, launch a DEDICATED Chrome
  // (its own profile) so automation + the "debugging" banner never touch the
  // user's real browser. One-time on-device steps (install the extension in
  // this profile, sign in, place it on a separate Space) are guided in
  // onboarding; this just makes sure the isolated instance is running.
  if (settings.get('browserEnabled') !== false) {
    launchAutomationChrome()
  }

  // PRD §9: the serialized recipe librarian, sharing the same executor factory
  // (another interactive claude session on the user's plan — §9.3).
  const librarian = new Librarian({ executorFactory })
  manager = new TaskManager({ executorFactory, librarian })

  // ── Wire the Remote trigger key → capture (PRD §2.4.4 / §5) ──
  // keyboard.ts emits 'remote-start'/'remote-stop' for the non-dictation key;
  // route them to the sessionManager's Remote capture (which reuses the STT
  // pipeline then calls dispatchFromCapture).
  deps.keyboardManager.on('keyboard', (e) => {
    if (e.type === 'remote-start') {
      log.event('remote-key', { phase: 'start' })
      deps.sessionManager.startRemoteCapture()
    } else if (e.type === 'remote-stop') {
      log.event('remote-key', { phase: 'stop' })
      void deps.sessionManager.stopRemoteCapture()
    }
  })

  // Fan task lifecycle out to renderers (PRD §13).
  manager.on('created', (t: Task) => broadcast('remote:task-created', t))
  manager.on('updated', (t: Task) => broadcast('remote:task-updated', t))
  manager.on('needs-user', (t: Task) => broadcast('remote:task-needs-user', t))
  manager.on('done', (t: Task) => {
    broadcast('remote:task-done', t)
    notify('Task done', t.result?.summary ? `${t.intent} — ${t.result.summary}` : t.intent)
  })
  manager.on('failed', (t: Task) => {
    broadcast('remote:task-failed', t)
    notify('Task failed', t.mcpGap ? t.mcpGap.message : (t.error?.reason ?? t.intent))
  })
  manager.on('stuck', (t: Task) => {
    broadcast('remote:task-stuck', t)
    notify('Task may be stuck', t.intent)
  })
  // Live PTY output → renderer (render-on-demand terminal, PRD §13.4#8).
  manager.on('output', (d: { taskId: string; chunk: string }) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('remote:task-output', d)
    }
  })

  // ── IPC: actions the renderer (or a future menu) can trigger ──
  ipcMain.handle('remote:dispatch', async (_e, intent: string) => dispatchFromCapture(intent))
  ipcMain.handle('remote:list', async () => (manager?.list() ?? []).map(serializeTask))
  ipcMain.handle('remote:answer', async (_e, id: string, answer: string) => {
    manager?.answer(id, answer)
    return true
  })
  ipcMain.handle('remote:kill', async (_e, id: string) => {
    manager?.kill(id)
    return true
  })
  ipcMain.handle('remote:get-output', async (_e, id: string) => manager?.getOutput(id) ?? '')
  ipcMain.handle('remote:get-settings', async () => ({
    permissionMode: settings.get('permissionMode'),
    remoteKey: getRemoteKey(),
    agent: settings.get('agent'),
    sandboxRoots: settings.get('sandboxRoots') ?? [],
    model: settings.get('model') || 'opus',
    browserEnabled: settings.get('browserEnabled') !== false,
    logFile: getRemoteLogFilePath(),
  }))
  ipcMain.handle('remote:set-browser-enabled', async (_e, enabled: boolean) => {
    settings.set('browserEnabled', !!enabled)
    log.event('browser-enabled-set', { enabled: !!enabled })
    if (enabled) launchAutomationChrome()
    return true
  })
  ipcMain.handle('remote:set-permission-mode', async (_e, mode: PermissionMode) => {
    settings.set('permissionMode', mode)
    log.event('permission-mode-set', { mode }) // PRD §10.1
    return true
  })
  ipcMain.handle('remote:set-agent', async (_e, agent: AgentKind) => {
    settings.set('agent', agent)
    log.event('agent-set', { agent }) // PRD §11
    return true
  })
  ipcMain.handle('remote:set-sandbox-roots', async (_e, roots: string[]) => {
    const clean = Array.isArray(roots) ? roots.filter((r) => typeof r === 'string' && r.trim()) : []
    settings.set('sandboxRoots', clean)
    log.event('sandbox-roots-set', { count: clean.length, roots: clean }) // PRD §10.6
    return true
  })

  log.event('init-remote-done', {})
  return manager
}

/** Test/teardown helper. */
export function _resetForTest(): void {
  manager = null
  completeFn = null
}
