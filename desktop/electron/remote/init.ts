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

import { ipcMain, BrowserWindow, Notification, shell, app } from 'electron'
import Store from 'electron-store'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { TaskManager, type Task } from './task-manager'
import { Librarian } from './librarian'
import { ClaudeCodeExecutor } from './pty-session'
import { CodexExecutor, type AgentKind } from './codex-executor'
import { cleanIntent, type CompleteFn } from './intent-cleanup'
import { deriveRemoteKey, type TriggerKey } from './mode-router'
import { configureRemoteLogging, createLogger, getRemoteLogFilePath } from './log'
import { fixPath } from './fix-path'
import { buildSetupChecklist, setupComplete } from './setup-status'
import { createOverlayWindow, presentOrExpand, expandOverlay, openOverlay, dismissOverlay, setDockedMode, reconcileDock, onNewTask, getOverlayMode, setOverlayInteractive, pauseOverlayEscape, resumeOverlayEscape } from './overlay'
import { Router, type RoutableTask } from './router'
import { resolveTmuxBin, sessionNameFor, tmuxAttachArgs, tmuxKillSessionArgs, TMUX_CONF } from './tmux'
import { planGardening, applyGardening } from './gardening'

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
  // DECIDED: Sonnet by default (router uses a lighter model). '' ⇒ inherit default.
  model: string
  // True once the user explicitly picks a model in the selector — gates the
  // one-time opus→sonnet default migration so an explicit choice is never reset.
  modelUserSet: boolean
  // DECIDED: connect Claude-in-Chrome by default (browser tasks need it; others
  // ignore it). User can disable. Setup of the extension is guided/one-time.
  browserEnabled: boolean
  // Onboarding: user-confirmed manual steps we can't auto-detect (extension
  // installed, signed in, window parked on its own Space). Keyed by step key.
  setupConfirmations: Record<string, boolean>
  // DECIDED: the overlay surfaces task state, not macOS notifications (which get
  // dropped/missed). OFF by default; toggle on to also fire OS notifications.
  osNotifications: boolean
  // DECIDED: the floating overlay auto-presents on terminal/attention states.
  // User can turn the auto-popup off (then they open the app manually).
  overlayAutoPresent: boolean
  // DECIDED: docked mode — a compact bottom-right pill (running/stuck counts)
  // that expands into the full panel on a notify-state event or click, and
  // collapses back on Esc. ON by default; OFF reverts to the legacy pop-the-
  // full-panel behavior.
  overlayDocked: boolean
  // PRD §9: gate for the Librarian's write path. OFF by default (calibration
  // mode — proposals written to proposal.json, never applied). ON ⇒ curation
  // writes are live.
  librarianWriteEnabled: boolean
}

const settings = new Store<RemoteSettings>({
  name: 'unmute-remote-settings',
  defaults: {
    permissionMode: 'prompt',
    dictationKey: 'fn',
    agent: 'claude',
    sandboxRoots: [],
    // DECIDED: Sonnet is the default doer model — fast AND capable for agentic
    // remote tasks. Users switch to Haiku (faster) or Opus (most capable) from
    // the Remote settings or the capture-widget model selector.
    model: 'sonnet',
    modelUserSet: false,
    browserEnabled: true,
    setupConfirmations: {},
    osNotifications: false,
    overlayAutoPresent: true,
    overlayDocked: true,
    librarianWriteEnabled: false,
  },
})

/**
 * Run `claude mcp list` (read-only) to discover which integrations the user has
 * connected in THEIR Claude Code, for the onboarding checklist. Best-effort:
 * resolves '' if the binary is missing or it errors/times out. We do NOT strip
 * env here — listing is read-only and never bills a session (PRD §12.1: Unmute
 * is not in the credential path; this only READS what the user configured).
 */
function claudeMcpList(): Promise<string> {
  return new Promise((resolve) => {
    try {
      execFile('claude', ['mcp', 'list'], { timeout: 8000 }, (err, stdout, stderr) => {
        if (err) {
          log.warn('claude mcp list failed', { error: err.message })
          resolve('')
          return
        }
        resolve(`${stdout || ''}\n${stderr || ''}`)
      })
    } catch (e) {
      log.warn('claude mcp list threw', { error: (e as Error).message })
      resolve('')
    }
  })
}

/** Resolve the Homebrew binary (so Unmute can install deterministic deps itself
 *  rather than making the user run commands). Null ⇒ no brew → we guide instead. */
function resolveBrew(): string | null {
  for (const p of ['/opt/homebrew/bin/brew', '/usr/local/bin/brew']) {
    if (existsSync(p)) return p
  }
  return null
}

/** Re-resolve tmux + (re)write its config. Called at init and after an install. */
function refreshTmux(): void {
  tmuxBin = resolveTmuxBin((p) => existsSync(p))
  if (tmuxBin) {
    try {
      mkdirSync(dirname(tmuxConfPath), { recursive: true })
      writeFileSync(tmuxConfPath, TMUX_CONF)
    } catch (e) {
      log.warn('tmux conf write failed — disabling tmux', { error: (e as Error).message })
      tmuxBin = null
    }
  }
}

/** Assemble the onboarding checklist from detected + confirmed state (§12). */
async function getSetupStatus() {
  const browserEnabled = settings.get('browserEnabled') !== false
  const mcpListOutput = await claudeMcpList()
  const confirmations = settings.get('setupConfirmations') ?? {}
  const steps = buildSetupChecklist({ mcpListOutput, browserEnabled, tmuxAvailable: tmuxBin !== null, confirmations })
  const complete = setupComplete(steps)
  log.event('setup-status', { complete, todo: steps.filter((s) => s.status === 'todo').map((s) => s.key) })
  return { steps, complete }
}

let manager: TaskManager | null = null
let completeFn: CompleteFn | null = null
// The warm routing classifier (lazy — spawns on first routed utterance).
let router: Router | null = null

/** A minimal, tool-less classifier session for the router: no --chrome, no tmux;
 *  --dangerously-skip-permissions so it can write its decision file unprompted.
 *  Pinned to a light, fast model — classification is thin and must answer in
 *  ~1-2s, and we must NOT inherit the CLI default (the user can change it to
 *  Opus, which is heavy and slow for a one-line judgement). */
function routerExecutorFactory() {
  return new ClaudeCodeExecutor({ model: 'sonnet', extraArgs: ['--dangerously-skip-permissions'], chrome: false })
}

/** Build the router's task snapshot from Unmute's live map (Unmute is the hub —
 *  the router never touches sessions). */
function routableSnapshot(now: number): RoutableTask[] {
  if (!manager) return []
  // routableTasks() is newest-first; the most-recent one is the de-facto
  // "on-screen" task (the overlay auto-expands the last change) — mark it so the
  // router has that prior when the command is terse.
  return manager.routableTasks().map((t, i) => ({
    id: t.id,
    intent: t.intent,
    state: t.state,
    category: t.category ?? null,
    ageSec: Math.max(0, Math.round((now - t.updatedAt) / 1000)),
    surfaced: i === 0,
    awaiting: t.state === 'needs-user',
    question: t.state === 'needs-user' ? (t.question?.text ?? null) : null,
  }))
}

// tmux backing for the live terminal (pop-out to a real terminal = SAME session).
// Resolved once at init; null ⇒ tmux not installed, sessions spawn directly.
let tmuxBin: string | null = null
const tmuxConfPath = join(homedir(), '.unmute', 'remote', 'tmux.conf')

/** Open a task's tmux session in the user's terminal app (iTerm if present, else
 *  Terminal). It ATTACHES to the running session — same claude, not a new one. */
function openInTerminal(taskId: string): boolean {
  if (!tmuxBin) { log.warn('open-in-terminal: tmux unavailable'); return false }
  const session = sessionNameFor(taskId)
  const attachCmd = [tmuxBin, ...tmuxAttachArgs(session)].join(' ')
  const useIterm = existsSync('/Applications/iTerm.app')
  const script = useIterm
    ? `tell application "iTerm"\n  activate\n  create window with default profile command "${attachCmd}"\nend tell`
    : `tell application "Terminal"\n  activate\n  do script "${attachCmd}"\nend tell`
  try {
    execFile('osascript', ['-e', script], (err) => { if (err) log.warn('open-in-terminal osascript failed', { error: err.message }) })
    // The overlay is pinned at 'screen-saver' level (above everything), so the
    // terminal window opens BEHIND it and looks like nothing happened. Dismiss
    // the overlay — the user is leaving for the real terminal anyway.
    dismissOverlay()
    log.event('open-in-terminal', { taskId, session, terminal: useIterm ? 'iterm' : 'terminal' })
    return true
  } catch (e) {
    log.warn('open-in-terminal threw', { error: (e as Error).message })
    return false
  }
}

/** Broadcast a task snapshot to every renderer (ambient pill + panel + overlay). */
function broadcast(channel: string, task: Task): void {
  const safe = serializeTask(task)
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, safe)
  }
}

/** Bring the user to a navigate task's target (DECIDED: for "open X" tasks the
 *  deliverable is BEING there, so focus the tab/app instead of a popup). Focusing
 *  steals focus — which is correct ONLY for this category. Best-effort. */
// Find the EXACT Chrome tab the executor left on a URL and raise it — right
// window AND right tab, switching Spaces if the window lives on another one.
// Matching is by normalized URL (drop scheme, leading "www.", trailing "/",
// #fragment and ?query) so the executor's reported URL and Chrome's own tab
// URL join reliably despite cosmetic drift. Returns "focused" or "notfound".
// Because we search every window/tab first and only open when nothing matches,
// we can never create a duplicate tab.
const FOCUS_CHROME_TAB = `
on run argv
  set target to my normURL(item 1 of argv)
  tell application "Google Chrome"
    repeat with w in every window
      set i to 0
      repeat with t in every tab of w
        set i to i + 1
        if my normURL(URL of t) is target then
          set index of w to 1
          set active tab index of w to i
          activate
          return "focused"
        end if
      end repeat
    end repeat
  end tell
  return "notfound"
end run

on normURL(u)
  try
    if u contains "://" then set u to text ((offset of "://" in u) + 3) thru -1 of u
    if u contains "#" then set u to text 1 thru ((offset of "#" in u) - 1) of u
    if u contains "?" then set u to text 1 thru ((offset of "?" in u) - 1) of u
    if u starts with "www." then set u to text 5 thru -1 of u
    if u ends with "/" then set u to text 1 thru -2 of u
  end try
  return u
end normURL
`

function focusTarget(task: Task): void {
  const arts = task.result?.artifacts ?? []
  const path = arts.find((a) => a.type === 'path')?.value
  const url = arts.find((a) => a.type === 'url')?.value
  try {
    if (path) {
      void shell.openPath(path) // opens the file/folder + brings its app forward
      log.event('focus-target', { taskId: task.id, hasPath: true, hasUrl: false })
      return
    }
    if (!url) {
      log.event('focus-target', { taskId: task.id, hasPath: false, hasUrl: false })
      return
    }
    // Raise the precise tab the executor navigated. Only if NO tab currently
    // holds this URL do we open it once (foreground) — never a duplicate.
    execFile('osascript', ['-e', FOCUS_CHROME_TAB, url], { timeout: 5000 }, (err, stdout) => {
      const result = (stdout || '').trim()
      if (err || result !== 'focused') {
        log.event('focus-target-open', { taskId: task.id, reason: err ? 'osascript-error' : result })
        void shell.openExternal(url, { activate: true }) // genuinely absent → open once, foreground
      } else {
        log.event('focus-target-raised', { taskId: task.id })
      }
    })
  } catch (e) {
    log.warn('focus-target failed', { error: (e as Error).message })
  }
}

/** Present a terminal/attention state, keyed on category (DECIDED):
 *   navigate → focus the target tab/app, no popup.
 *   watch    → focus the video tab (the user wants to see it); no popup.
 *   consume  → stay out of the way (audio playing in the background); no popup.
 *   info/act/needs-user/unknown → the overlay.
 *  Honors the auto-present toggle (off ⇒ user opens the app manually). */
function maybePresent(task: Task): void {
  if (settings.get('overlayAutoPresent') === false) return
  if (task.state === 'done' && (task.category === 'navigate' || task.category === 'watch')) { focusTarget(task); return }
  if (task.state === 'done' && task.category === 'consume') return
  presentOrExpand(task.id)
}

/** Count of tasks that are running or awaiting attention — drives the dock. */
function activeTaskCount(): number {
  return (manager?.list() ?? []).filter(
    (t) => t.state === 'processing' || t.state === 'needs-user' || t.state === 'stuck',
  ).length
}

/** Plain, structured-clone-safe snapshot of a task for IPC. */
function serializeTask(t: Task) {
  return {
    id: t.id,
    intent: t.intent,
    state: t.state,
    category: t.category ?? null,
    step: t.step ?? null,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    result: t.result ?? null,
    error: t.error ?? null,
    question: t.question ?? null,
    mcpGap: t.mcpGap ?? null,
    // PTY still alive (running or parked-warm) → the live terminal can repaint
    // it clean instead of replaying stale-width history (PRD §13.4 #8).
    alive: manager?.isAlive(t.id) ?? false,
  }
}

// PRD §13.6: Unmute OBSERVES completion (it's the parent process). We no longer
// emit macOS notifications — they're unreliable (silently dropped for unsigned/
// dev builds and easy to miss) and the floating task OVERLAY now surfaces every
// terminal/attention state in-place. Kept behind a setting (default OFF) so it
// can be re-enabled, but the overlay is the canonical surface.
function notify(title: string, body: string): void {
  if (settings.get('osNotifications') !== true) return
  try {
    if (Notification.isSupported()) new Notification({ title, body }).show()
  } catch (e) {
    log.warn('notification failed', { error: (e as Error).message })
  }
}

function executorFactory(resume = false) {
  const mode = settings.get('permissionMode')
  const agent = settings.get('agent')
  const sandboxRoots = settings.get('sandboxRoots') ?? []
  const sandboxed = sandboxRoots.length > 0
  const model = settings.get('model') || 'sonnet'
  const browser = settings.get('browserEnabled') !== false
  log.event('executor-factory', { agent, permissionMode: mode, sandboxed, sandboxRoots, model, browser, resume })
  if (agent === 'codex') {
    return new CodexExecutor({}) // NOTE: Codex resume isn't wired yet (different mechanism)
  }
  // PRD §10.1/§10.6 interaction: a sandbox is the "fenced yard" — when it's ON
  // we do NOT skip permissions globally (out-of-fence access still prompts via
  // needs-user); claude gets the allowed roots via --add-dir.
  // `--continue` resumes the MOST RECENT session in the cwd. Each task has its
  // own cwd with exactly one session, so this reliably continues THAT task with
  // full prior context (no session-id tracking needed). Claude's resume is
  // scoped to the working dir, which is exactly our per-task isolation.
  const resumeArgs = resume ? ['--continue'] : []
  const extraArgs = [...resumeArgs, ...(!sandboxed && mode === 'auto-approve' ? ['--dangerously-skip-permissions'] : [])]
  // Run inside tmux when available so the live terminal can be popped out to a
  // real terminal app as the SAME session (private socket keeps env stripped).
  const tmux = tmuxBin ? { bin: tmuxBin, confPath: tmuxConfPath, cols: 120, rows: 40 } : undefined
  return new ClaudeCodeExecutor({
    extraArgs,
    addDirs: sandboxRoots,
    model, // DECIDED: Opus for executor sessions
    chrome: browser, // DECIDED: Claude-in-Chrome on by default (browser lane)
    tmux,
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
  const raw = (rawTranscript || '').trim()
  if (!raw) { log.warn('empty transcript — not dispatching', {}); return null }

  // 1. ALL routing goes through the warm router — including answering a task that
  //    is blocked on a question. There is no deterministic short-circuit: the
  //    router sees blocked tasks (flagged "awaiting" with their question) in its
  //    snapshot and decides intelligently whether this utterance answers one,
  //    continues another, or starts something new. The router is resident/warm,
  //    so routing everything through it is still instant.
  const routable = manager.routableTasks()
  if (routable.length && router) {
    const awaitingIds = new Set(manager.tasksAwaitingUser().map((t) => t.id))
    try {
      const tRoute = Date.now()
      const decision = await router.route(raw, routableSnapshot(Date.now()))
      // Phase timing: how long the utterance spent in the router (warm → decision).
      log.event('phase-timing', { phase: 'router', ms: Date.now() - tRoute, action: decision.action })
      if (decision.action === 'continue' && decision.targetTaskId) {
        const tid = decision.targetTaskId
        // Continuing a BLOCKED task means piping the utterance in as its answer;
        // continuing a live task means a fresh follow-up turn.
        if (awaitingIds.has(tid)) {
          log.event('routed-as-answer', { taskId: tid, via: 'router' })
          manager.answer(tid, decision.intent || raw)
          return tid
        }
        if (manager.followUp(tid, decision.intent)) {
          log.event('routed-as-continuation', { taskId: tid, via: 'router' })
          return tid
        }
      }
      log.event('routed-as-new', { via: 'router', surface: decision.surface ?? null, mode: decision.mode ?? null })
      return manager.dispatch(decision.intent || raw, { surface: decision.surface, mode: decision.mode })
    } catch (e) {
      log.warn('router error — dispatching new', { error: (e as Error).message })
      return manager.dispatch(raw)
    }
  }

  // 3. Nothing to route among → straight to a new task. Cleanup is optional (the
  //    executor tolerates raw); use the managed LLM only if it's wired.
  const cleaned = completeFn ? (await cleanIntent(raw, completeFn)).intent : raw
  if (!cleaned) { log.warn('empty intent after cleanup — not dispatching', {}); return null }
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

  // Adopt the user's real login-shell PATH FIRST. A Finder/Dock-launched app
  // gets a minimal PATH without ~/.local/bin etc., so `claude` isn't found and
  // sessions die at 0s. Sessions spawn with env: process.env, so this fixes them
  // all. Must run before claudeMcpList() / any spawn below.
  fixPath()

  const logDir = join(homedir(), '.unmute', 'remote', 'logs')
  const runId = String(Date.now())
  const logFile = configureRemoteLogging({ dir: logDir, runId })
  log.event('init-remote', { logFile, permissionMode: settings.get('permissionMode') })

  // Resolve tmux once: if present, sessions run inside it so the live terminal
  // can be popped out to a real terminal app (same session). Write the minimal
  // config (no status bar, mouse scroll, fixed size).
  refreshTmux()
  log.event(tmuxBin ? 'tmux-available' : 'tmux-unavailable', { tmuxBin, conf: tmuxConfPath })

  // DECIDED isolation: browser tasks run in a DEDICATED Chrome (its own profile)
  // so automation + the "debugging" banner never touch the user's real browser.
  // We do NOT launch it on boot — popping a Chrome window to the foreground every
  // launch is exactly the interruption this design avoids. It's launched
  // on-demand instead: from the onboarding step (user clicks "Launch"), when the
  // user toggles the browser lane on, and lazily before a browser task needs it.

  // PRD §9: the serialized recipe librarian — another interactive claude session
  // on the user's plan (§9.3), but it gets its OWN factory, NOT the doer's. The
  // librarian runs fully autonomously (no user present to answer anything) and
  // never touches the browser, so it must:
  //   * ALWAYS --dangerously-skip-permissions — a permission prompt would hang it
  //     forever with no one to confirm (regardless of the doer's permissionMode).
  //   * NEVER --chrome — it does no browser work, and attaching contends with the
  //     doer's parked Chrome session, which wedged the librarian.
  //   * No sandbox/--add-dir — it only writes the skill library under ~/.unmute.
  // This is what lets the curation prompt actually submit instead of sitting at
  // an idle welcome screen until the backstop kills it.
  function librarianExecutorFactory() {
    // PINNED to opus, independent of the user's doer-model selection: curation
    // is background (latency-insensitive) and benefits from strong reasoning, so
    // picking Haiku for speed on tasks shouldn't degrade long-term memory.
    const model = 'opus'
    const tmux = tmuxBin ? { bin: tmuxBin, confPath: tmuxConfPath, cols: 120, rows: 40 } : undefined
    log.event('librarian-executor-factory', { model })
    return new ClaudeCodeExecutor({
      extraArgs: ['--dangerously-skip-permissions'],
      model,
      chrome: false,
      tmux,
    })
  }
  const librarian = new Librarian({ executorFactory: librarianExecutorFactory, writeEnabled: settings.get('librarianWriteEnabled') === true })
  manager = new TaskManager({
    executorFactory,
    librarian,
    // Best-effort reaper for an orphan tmux session a past run left on our
    // private socket (app crashed before killAll). Per-session kill, never the
    // server (would hit live ones).
    reapSession: (id) => {
      if (!tmuxBin) return
      try { execFile(tmuxBin, tmuxKillSessionArgs(sessionNameFor(id)), () => {}) } catch { /* best-effort */ }
    },
  })
  // Recover the user's tasks after an app crash/restart: rebuild the rows from
  // the on-disk meta + status files (they were never lost — just invisible once
  // the in-memory list reset on relaunch). Then start maintenance so the sweep
  // can purge any rehydrated rows that are too old.
  void manager.rehydrate().finally(() => {
    // Auto-purge dead tasks (>24h): in-memory aged-out tasks AND orphan on-disk
    // dirs from past runs. Kills any leftover session + erases OUR scratch dir +
    // row. Runs once now then hourly. Never touches ~/.claude.
    manager?.startMaintenance()
  })
  // Daily gardening sweep — consolidates/prunes the skill library. Gated on the
  // write-enabled setting so calibration-mode users are never affected.
  const GARDEN_MS = 24 * 60 * 60 * 1000
  const gardenTimer = setInterval(() => {
    if (settings.get('librarianWriteEnabled') !== true) return
    void (async () => {
      const actions = await planGardening({ nowMs: Date.now() })
      // TEMP(memory-debug): remove after calibration
      log.event('gardening-sweep', { MEMORY_DEBUG: true, planned: actions.length })
      await applyGardening(actions, {})
    })().catch((e) => log.warn('gardening sweep failed', { error: (e as Error).message }))
  }, GARDEN_MS)
  ;(gardenTimer as { unref?: () => void }).unref?.()
  // The warm routing classifier (lazy — spawns on the first routed utterance,
  // idle-kills itself; tool-less, no glow). Star topology: Unmute is the hub.
  router = new Router({ executorFactory: routerExecutorFactory })
  // Resident from startup — bring the classifier up now so the FIRST follow-up
  // utterance hits a warm session, never a cold spawn + timeout. Fire-and-forget.
  void router.warm()

  // ── Wire the Remote trigger key → capture (PRD §2.4.4 / §5) ──
  // keyboard.ts emits 'remote-start'/'remote-stop' for the non-dictation key;
  // route them to the sessionManager's Remote capture (which reuses the STT
  // pipeline then calls dispatchFromCapture).
  deps.keyboardManager.on('keyboard', (e) => {
    if (e.type === 'remote-start') {
      log.event('remote-key', { phase: 'start' })
      void router?.warm() // ensure the classifier is ready before the utterance lands (re-warms if it died)
      pauseOverlayEscape() // capture owns Escape (cancel) while recording
      deps.sessionManager.startRemoteCapture()
    } else if (e.type === 'remote-stop') {
      log.event('remote-key', { phase: 'stop' })
      resumeOverlayEscape() // give Escape back to a still-visible overlay
      void deps.sessionManager.stopRemoteCapture()
    }
  })

  // Pre-warm the floating overlay window (hidden) so the first present is instant.
  createOverlayWindow()
  // Apply the docked-mode preference (default ON).
  setDockedMode(settings.get('overlayDocked') !== false)
  // One-time: move users still on the OLD opus default to the new sonnet default
  // — but ONLY if they never explicitly picked a model (modelUserSet stays false
  // until they touch the selector, so a deliberate opus choice is preserved).
  if (!settings.get('modelUserSet') && settings.get('model') === 'opus') {
    settings.set('model', 'sonnet')
    log.event('model-migrated-opus-to-sonnet', {})
  }
  // Codex isn't wired yet (shown as "coming soon"). If a past build stored it as
  // the agent, reset to claude so Remote works instead of failing every task.
  if (settings.get('agent') === 'codex') { settings.set('agent', 'claude'); log.event('agent-reset-codex-to-claude', {}) }

  // Fan task lifecycle out to renderers (PRD §13). Terminal/attention states
  // also AUTO-PRESENT the overlay (the canonical surface; OS notifications off).
  // A new task clears any prior ✕ dismissal and re-shows the dock (docked mode).
  manager.on('created', (t: Task) => { broadcast('remote:task-created', t); onNewTask(activeTaskCount()) })
  manager.on('updated', (t: Task) => { broadcast('remote:task-updated', t); reconcileDock(activeTaskCount()) })
  manager.on('needs-user', (t: Task) => {
    broadcast('remote:task-needs-user', t)
    maybePresent(t)
    reconcileDock(activeTaskCount())
  })
  manager.on('done', (t: Task) => {
    broadcast('remote:task-done', t)
    maybePresent(t)
    reconcileDock(activeTaskCount())
    notify('Task done', t.result?.summary ? `${t.intent} — ${t.result.summary}` : t.intent)
  })
  manager.on('failed', (t: Task) => {
    broadcast('remote:task-failed', t)
    maybePresent(t)
    reconcileDock(activeTaskCount())
    notify('Task failed', t.mcpGap ? t.mcpGap.message : (t.error?.reason ?? t.intent))
  })
  manager.on('stuck', (t: Task) => {
    broadcast('remote:task-stuck', t)
    maybePresent(t)
    reconcileDock(activeTaskCount())
    notify('Task may be stuck', t.intent)
  })
  // Task erased (Kill/Delete) → tell renderers to drop the row + update the dock.
  manager.on('removed', (t: Task) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('remote:task-removed', { id: t.id })
    }
    reconcileDock(activeTaskCount())
  })

  // Master kill switch: closing Unmute terminates every Claude/tmux session so
  // none is left orphaned on the user's machine/plan (PRD §10.4).
  app.on('before-quit', () => {
    try { manager?.killAll() } catch (e) { log.warn('before-quit killAll failed', { error: (e as Error).message }) }
    try { router?.dispose() } catch { /* best-effort */ }
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
  // Kill/Delete a task entirely (terminate + erase). UI confirms before calling.
  ipcMain.handle('remote:remove-task', async (_e, id: string) => {
    await manager?.remove(id)
    return true
  })
  // Resume a finished/reaped task — respawn its session with --continue in the
  // same cwd (full prior context). For when a complex task was killed but the
  // user wants to keep working on it. Returns whether it resumed.
  ipcMain.handle('remote:resume', async (_e, id: string) => (await manager?.resume(id)) ?? false)
  // Master kill switch from the UI ("kill all tasks" above the table).
  ipcMain.handle('remote:kill-all', async () => {
    manager?.killAll()
    return true
  })
  ipcMain.handle('remote:get-output', async (_e, id: string) => manager?.getOutput(id) ?? '')
  // Open a result artifact in the USER's default app (PRD §13.4 #3 + the
  // consumption handoff): URLs open in the default browser, paths in Finder.
  // activate:false ⇒ open in a background tab WITHOUT stealing focus from what
  // the user is currently doing (DECIDED: never yank the user to it).
  ipcMain.handle('remote:open-artifact', async (_e, type: 'url' | 'path', value: string) => {
    try {
      if (type === 'path') {
        const err = await shell.openPath(value)
        if (err) { log.warn('open-artifact path failed', { value, err }); return false }
      } else {
        await shell.openExternal(value, { activate: false })
      }
      log.event('artifact-opened', { type, value })
      return true
    } catch (e) {
      log.warn('open-artifact failed', { type, value, error: (e as Error).message })
      return false
    }
  })
  // Typeable live terminal (PRD §4.3): raw keystrokes + viewport resize → PTY.
  ipcMain.on('remote:terminal-input', (_e, id: string, data: string) => manager?.sendInput(id, data))
  ipcMain.on('remote:terminal-resize', (_e, id: string, cols: number, rows: number) => manager?.resize(id, cols, rows))
  // Pop the live terminal out to a real terminal app — SAME tmux session.
  ipcMain.handle('remote:tmux-available', async () => tmuxBin !== null)
  ipcMain.handle('remote:open-in-terminal', async (_e, id: string) => openInTerminal(id))
  // Floating overlay: user-triggered dismiss (✕ → dismiss for the session).
  ipcMain.on('remote:overlay-dismiss', () => dismissOverlay())
  // Dock pill clicked → expand to the full panel.
  ipcMain.on('remote:overlay-expand', () => expandOverlay())
  // Dock hover-toggle → make the click-through window catch clicks over the pill.
  ipcMain.on('remote:overlay-set-interactive', (_e, on: boolean) => setOverlayInteractive(!!on))
  // Renderer asks for the current presentation on mount (avoids a mode race).
  ipcMain.handle('remote:overlay-get-mode', async () => getOverlayMode())
  // Manual open from the app (a button next to "Kill all").
  ipcMain.on('remote:overlay-open', () => openOverlay())
  ipcMain.handle('remote:set-overlay-auto-present', async (_e, on: boolean) => {
    settings.set('overlayAutoPresent', !!on)
    log.event('overlay-auto-present-set', { on: !!on })
    return true
  })
  // Doer model selector (Remote only). Validated to the three supported tiers;
  // applies to the NEXT dispatched task (each task reads the setting at spawn).
  // Broadcast so both surfaces — Remote settings + the capture-widget badge —
  // stay in sync when either changes it.
  ipcMain.handle('remote:get-model', async () => settings.get('model') || 'sonnet')
  ipcMain.handle('remote:set-model', async (_e, m: string) => {
    const model = (m === 'haiku' || m === 'sonnet' || m === 'opus') ? m : (settings.get('model') || 'sonnet')
    settings.set('model', model)
    settings.set('modelUserSet', true) // explicit choice — never auto-migrate it
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('remote:model-changed', model)
    }
    log.event('model-set', { model })
    return model
  })
  ipcMain.handle('remote:set-overlay-docked', async (_e, on: boolean) => {
    settings.set('overlayDocked', !!on)
    setDockedMode(!!on)
    reconcileDock(activeTaskCount())
    log.event('overlay-docked-set', { on: !!on })
    return true
  })
  ipcMain.handle('remote:set-os-notifications', async (_e, on: boolean) => {
    settings.set('osNotifications', !!on)
    log.event('os-notifications-set', { on: !!on })
    return true
  })
  ipcMain.handle('remote:set-librarian-write-enabled', async (_e, on: boolean) => {
    settings.set('librarianWriteEnabled', !!on)
    log.event('librarian-write-enabled-set', { on: !!on })
    return true
  })
  ipcMain.handle('remote:get-settings', async () => ({
    permissionMode: settings.get('permissionMode'),
    remoteKey: getRemoteKey(),
    agent: settings.get('agent'),
    sandboxRoots: settings.get('sandboxRoots') ?? [],
    model: settings.get('model') || 'sonnet',
    browserEnabled: settings.get('browserEnabled') !== false,
    overlayAutoPresent: settings.get('overlayAutoPresent') !== false,
    overlayDocked: settings.get('overlayDocked') !== false,
    osNotifications: settings.get('osNotifications') === true,
    librarianWriteEnabled: settings.get('librarianWriteEnabled') === true,
    logFile: getRemoteLogFilePath(),
  }))
  // ── Onboarding / guided one-time setup (PRD §12) ──
  ipcMain.handle('remote:get-setup-status', async () => getSetupStatus())
  ipcMain.handle('remote:set-setup-confirmation', async (_e, key: string, done: boolean) => {
    const cur = { ...(settings.get('setupConfirmations') ?? {}) }
    cur[key] = !!done
    settings.set('setupConfirmations', cur)
    log.event('setup-confirmation-set', { key, done: !!done })
    return getSetupStatus()
  })
  // Unmute installs the deterministic dep itself (tmux via Homebrew) — the user
  // shouldn't run terminal commands. If Homebrew is absent we guide instead
  // (the checklist still shows the `brew install tmux` command to copy).
  ipcMain.handle('remote:install-tmux', async () => {
    const brew = resolveBrew()
    if (!brew) { log.warn('install-tmux: no Homebrew found — user must install manually'); return getSetupStatus() }
    log.event('install-tmux-start', { brew })
    await new Promise<void>((resolve) => {
      execFile(brew, ['install', 'tmux'], { timeout: 180_000 }, (err) => {
        if (err) log.warn('brew install tmux failed', { error: err.message })
        resolve()
      })
    })
    refreshTmux()
    log.event('install-tmux-done', { tmuxBin })
    return getSetupStatus()
  })
  ipcMain.handle('remote:set-browser-enabled', async (_e, enabled: boolean) => {
    // Browser tasks use the user's REAL Chrome via --chrome; nothing to launch.
    settings.set('browserEnabled', !!enabled)
    log.event('browser-enabled-set', { enabled: !!enabled })
    return true
  })
  ipcMain.handle('remote:set-permission-mode', async (_e, mode: PermissionMode) => {
    settings.set('permissionMode', mode)
    log.event('permission-mode-set', { mode }) // PRD §10.1
    return true
  })
  ipcMain.handle('remote:set-agent', async (_e, agent: AgentKind) => {
    // Codex isn't wired yet (shown as "coming soon", not selectable). Coerce any
    // non-claude request to claude so Remote can't be put into a broken state.
    const a: AgentKind = agent === 'codex' ? 'claude' : agent
    settings.set('agent', a)
    log.event('agent-set', { agent: a, requested: agent }) // PRD §11
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
  try { manager?.stopMaintenance() } catch { /* ignore */ }
  manager = null
  completeFn = null
  try { router?.dispose() } catch { /* ignore */ }
  router = null
}
