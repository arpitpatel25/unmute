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
import { join, dirname, basename } from 'node:path'
import { homedir } from 'node:os'
import { existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { TaskManager, type Task } from './task-manager'
import { Librarian } from './librarian'
import { ClaudeCodeExecutor } from './pty-session'
import { CodexExecutor, type AgentKind } from './codex-executor'
import { cleanIntent, nameIntent, type CompleteFn } from './intent-cleanup'
import { deriveRemoteKey, type TriggerKey } from './mode-router'
import { configureRemoteLogging, createLogger, getRemoteLogFilePath } from './log'
import { fixPath } from './fix-path'
import { buildSetupChecklist, setupComplete } from './setup-status'
import { createOverlayWindow, presentOrExpand, expandOverlay, openOverlay, dismissOverlay, setDockedMode, reconcileDock, onNewTask, getOverlayMode, setOverlayInteractive, pauseOverlayEscape, resumeOverlayEscape } from './overlay'
import { registerOrchestrateShortcut, openOrchestrateWindow } from './orchestrate'
import { Router, type RoutableTask } from './router'
import { knownProjects } from './projects'
import { resolveTmuxBin, sessionNameFor, tmuxAttachArgs, tmuxKillSessionArgs, TMUX_CONF } from './tmux'
import { planGardening, applyGardening, cleanupMemory, memoryUsage, type CleanupResult } from './gardening'

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
  // Persistent default: force every Remote task to RAW mode (no Unmute memory
  // injection + no librarian) regardless of what the router would pick. OFF by
  // default. The pill widget can override this per-session; this is the saved
  // default the Remote screen controls.
  forceRawMode: boolean
  // §6.4 voice-as-doorbell: speak one terse headline when a task becomes
  // actionable (needs-you/stuck/errored). ON by default; the product stays fully
  // usable dead silent with this off — one toggle away (cockpit 🔔 chip).
  voiceHeadlines: boolean
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
    forceRawMode: false,
    voiceHeadlines: true,
  },
})

// Per-SESSION override of forceRawMode, set from the pill widget. null = no
// override (use the persistent setting); true/false = force on/off for this app
// session only (resets to null on relaunch). The pill decides "for this session";
// the Remote screen sets the persistent default above.
let sessionForceRaw: boolean | null = null

/** Effective "skip all Unmute injection + librarian" decision: the per-session
 *  override wins; otherwise the saved default. */
function injectionDisabled(): boolean {
  return sessionForceRaw ?? (settings.get('forceRawMode') === true)
}

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
    name: t.name ?? null,
    state: t.state,
    kind: t.kind ?? 'oneoff',
    // What the user SAYS to address a project session ("the unmute one") — only
    // meaningful when the task runs outside our scratch dir.
    project: t.cwd !== t.home ? basename(t.cwd) : null,
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
    name: t.name ?? null,
    cwd: t.cwd,
    kind: t.kind ?? 'oneoff',
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
// Orchestrate focus (§6.2 — "focus IS the address"). The wall's currently-focused
// session id, or null. Set via remote:set-orchestrate-focus. When set, a capture
// routes to it DETERMINISTICALLY (see the short-circuit below) — the offer-never-move
// spine: the user can SEE where their voice lands before they speak.
let orchestrateFocusId: string | null = null

/** The voice lifecycle, observed (never driven) for the wall's listening surface:
 *  listening (key held) → transcribing (key up, STT running) → routing (deciding
 *  where it lands) → idle (landed; taskId says where). PURELY ADDITIVE — a
 *  broadcast beside the existing capture calls, zero touch of the capture path. */
type CapturePhase = 'listening' | 'transcribing' | 'routing' | 'idle'
function broadcastCapturePhase(phase: CapturePhase, taskId?: string | null): void {
  captureBusy = phase !== 'idle' // the doorbell stays silent while the user speaks
  // The screenshot ledger follows the capture window (remote captures only —
  // this broadcast never fires for plain dictation). The clipboard sweep runs at
  // 'transcribing' (key just lifted, recording stopped) so a mid-hold
  // ⌃-screenshot rides with THIS utterance, before routing delivers it.
  if (phase === 'listening') startCaptureWatch()
  else if (phase === 'transcribing') sweepClipboardOnce()
  else if (phase === 'idle') stopCaptureWatch()
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('remote:capture-phase', { phase, taskId: taskId ?? null })
  }
}

/** The one pending "or send it there?" route offer (only the LATEST matters —
 *  a new utterance supersedes any stale offer). Accepting kills the seconds-old
 *  mis-spawn and reroutes the SAME intent into the alternate; ignoring it costs
 *  nothing and it simply expires in the UI. */
let pendingRouteOffer: { newTaskId: string; altTaskId: string; intent: string; at: number } | null = null

// ── Staging tray (multimodal, capture-first): images pasted/dropped with NO
// target stage here, then ride with the NEXT utterance to wherever it lands —
// new task (paths join the intent), continuation/answer (paths typed into the
// target right before the payload, submitting as ONE message). The tray is to
// images what the router is to words: an address-free buffer resolved at
// speak-time. Files live under ~/.unmute/remote/staging (tiny, swept with age).
const STAGING_DIR = join(homedir(), '.unmute', 'remote', 'staging')
let stagedAttachments: string[] = []
function broadcastStaged(): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('remote:staged-changed', { count: stagedAttachments.length, paths: stagedAttachments })
  }
}

// ── Utterance-scoped screenshot capture (the pill ledger). The dictation window
// is the CONSENT signal: screenshots taken while addressing Unmute — or in the
// short gap since the last utterance — belong to what's being said. Everything
// staged is VISIBLE on the pill (🖼 n, prunable with ✕) before it sends; nothing
// rides invisibly. Only ever active for REMOTE captures, never plain dictation.
const PREHOLD_WINDOW_MS = 3 * 60_000
const CAPTURE_MAX_AUTO = 5
let lastUtteranceEndedAt = 0
let lastClipboardHash = ''
let captureWatchTimer: ReturnType<typeof setInterval> | null = null
let captureWatchGen = 0 // generation guard: a stale safety-stop must not kill a newer watch
let screenshotDirCache: string | null = null

function clipboardImage(): { hash: string; buf: Buffer } | null {
  try {
    // Lazy-require: electron.clipboard is main-process-safe but keep the top
    // import surface unchanged.
    const { clipboard } = require('electron') as { clipboard: { readImage(): { isEmpty(): boolean; toPNG(): Buffer } } }
    const img = clipboard.readImage()
    if (img.isEmpty()) return null
    const buf = img.toPNG()
    const hash = require('node:crypto').createHash('md5').update(buf).digest('hex') as string
    return { hash, buf }
  } catch { return null }
}

function screenshotDir(): string {
  if (screenshotDirCache) return screenshotDirCache
  screenshotDirCache = join(homedir(), 'Desktop') // macOS default
  try {
    execFile('defaults', ['read', 'com.apple.screencapture', 'location'], { timeout: 2000 }, (err, stdout) => {
      const loc = (stdout || '').trim()
      if (!err && loc) screenshotDirCache = loc.replace(/^~/, homedir())
    })
  } catch { /* keep Desktop */ }
  return screenshotDirCache
}

function stageBuffer(buf: Buffer, tag: string): void {
  if (stagedAttachments.length >= CAPTURE_MAX_AUTO) return
  try {
    mkdirSync(STAGING_DIR, { recursive: true })
    const file = join(STAGING_DIR, `capture-${Date.now()}-${tag}.png`)
    writeFileSync(file, buf)
    stagedAttachments.push(file)
    broadcastStaged()
    log.event('capture-staged', { file, via: tag })
  } catch (e) { log.warn('stageBuffer failed', { error: (e as Error).message }) }
}

/** Stage screenshot FILES newer than `sinceMs` from the user's screenshot dir. */
function stageRecentScreenshotFiles(sinceMs: number): void {
  try {
    const { readdirSync, statSync } = require('node:fs') as typeof import('node:fs')
    const dir = screenshotDir()
    for (const entry of readdirSync(dir)) {
      if (stagedAttachments.length >= CAPTURE_MAX_AUTO) break
      if (!/^screen ?shot/i.test(entry) || !/\.(png|jpe?g)$/i.test(entry)) continue
      const full = join(dir, entry)
      try {
        const st = statSync(full)
        if (st.mtimeMs > sinceMs && !stagedAttachments.includes(full)) {
          stagedAttachments.push(full) // reference in place — never copy/move user files
          broadcastStaged()
          log.event('capture-staged', { file: full, via: 'file' })
        }
      } catch { /* skip */ }
    }
  } catch { /* no screenshot dir — fine */ }
}

/** A capture began (remote OR dictation): sweep the pre-hold window, then watch live.
 *
 *  PERFORMANCE IS SACRED HERE: this runs WHILE audio is being recorded. Reading
 *  the clipboard image means decoding + PNG-encoding a potentially huge Retina
 *  screenshot on the main process — doing that on an interval stalled the
 *  recording pipeline and corrupted the audio (ffmpeg: "Invalid data"). So the
 *  clipboard is read exactly TWICE per capture — once at start (pre-hold sweep),
 *  once at stop — never on a timer. Only the cheap file-dir scan polls live
 *  (readdir + stat, microseconds), so ⌘⇧3/⌘⇧4 file captures still count up in
 *  real time; a ⌃-clipboard capture taken mid-hold appears when the key lifts. */
function startCaptureWatch(): void {
  captureWatchGen++
  const preholdSince = Math.max(lastUtteranceEndedAt, Date.now() - PREHOLD_WINDOW_MS)
  // ZERO clipboard reads here — PROVEN live: one PNG encode of a Retina
  // screenshot at key-down blocked main exactly as the recorder's FIRST chunk
  // (the EBML header) arrived → corrupt webm → every dictation failed. The
  // clipboard is swept ONLY at key-lift (recording stopped); a pre-hold
  // clipboard screenshot still rides with the utterance — its chip just appears
  // at lift instead of at start. Files are different: readdir+stat is
  // microseconds, safe to sweep and poll live.
  stageRecentScreenshotFiles(preholdSince)
  if (captureWatchTimer) clearInterval(captureWatchTimer)
  const startedAt = Date.now()
  captureWatchTimer = setInterval(() => stageRecentScreenshotFiles(startedAt), 700)
  ;(captureWatchTimer as { unref?: () => void }).unref?.()
}

/** One clipboard read — only ever called when recording is NOT running. */
function sweepClipboardOnce(): void {
  const c = clipboardImage()
  if (c && c.hash !== lastClipboardHash) { stageBuffer(c.buf, 'clipboard') }
  lastClipboardHash = c?.hash ?? lastClipboardHash // same image never re-attaches
}

function stopCaptureWatch(): void {
  if (captureWatchTimer) { clearInterval(captureWatchTimer); captureWatchTimer = null }
  lastUtteranceEndedAt = Date.now()
  // End-of-capture sweep — catches a ⌃-screenshot taken mid-hold (recording has
  // stopped by now, so the cost can't touch audio).
  sweepClipboardOnce()
}

/** Dictation delivery seam (clipboard.ts calls this after pasting the text):
 *  hand over everything staged and close the watch window. The ledger's contract
 *  holds across BOTH capture kinds — what the pill showed is what got delivered. */
export function consumeStagedForDictation(): string[] {
  stopCaptureWatch()
  return takeStaged()
}
/** Consume the tray (one landing takes everything). */
function takeStaged(): string[] {
  if (!stagedAttachments.length) return []
  const taken = stagedAttachments
  stagedAttachments = []
  broadcastStaged()
  return taken
}
/** Type staged paths into a live session's input (unsubmitted — the payload that
 *  follows submits them together). Best-effort. */
function typeStagedInto(taskId: string, staged: string[]): void {
  if (!staged.length || !manager) return
  manager.sendInput(taskId, ` ${staged.join(' ')} `)
  log.event('staged-delivered', { taskId, count: staged.length, via: 'typed' })
}
/** Fold staged paths into a NEW task's intent (Claude Code reads images by path). */
function intentWithStaged(intent: string, staged: string[]): string {
  if (!staged.length) return intent
  log.event('staged-delivered', { count: staged.length, via: 'intent' })
  return `${intent}\n[The user attached ${staged.length} image${staged.length === 1 ? '' : 's'} — view: ${staged.join(' ')}]`
}

// ── Voice-as-doorbell (§6.4): one terse spoken headline when a task becomes
// actionable — names the task, states the state, nothing else. Spoken ONLY for
// attention-required states (needs-you / stuck / errored); "done" pops silently.
// Serialized (one line at a time), deduped per task+state, NEVER spoken while a
// capture is live (talking over the user's own dictation is the cardinal sin of
// audio), and one toggle away (settings.voiceHeadlines; default ON). macOS `say`
// — zero dependencies, fully offline, no own intelligence.
let captureBusy = false
const spokenState = new Map<string, string>()
let sayChain: Promise<void> = Promise.resolve()
function speakHeadline(t: Task, state: 'needs-user' | 'stuck' | 'failed'): void {
  if (settings.get('voiceHeadlines') === false) return
  // Dedupe on state + question text: the same blocked question never re-rings,
  // but a NEW question on the same task rings again (it IS newly actionable).
  const ringKey = `${state}:${t.question?.text ?? ''}`
  if (spokenState.get(t.id) === ringKey) return
  spokenState.set(t.id, ringKey)
  const label = state === 'needs-user' ? 'needs you' : state === 'stuck' ? 'is stuck' : 'failed'
  const name = (t.name || t.intent || 'a task').slice(0, 60)
  sayChain = sayChain.then(() => new Promise<void>((resolve) => {
    if (captureBusy) { resolve(); return } // the user is speaking — stay silent
    try { execFile('say', [`${name} ${label}`], () => resolve()) } catch { resolve() }
  })).catch(() => {})
}

export async function dispatchFromCapture(rawTranscript: string): Promise<string | null> {
  // Observe the routing phase for the wall's listening surface — the dispatch
  // logic itself (the inner function) is untouched. `finally` guarantees the
  // surface always returns to idle, whatever path the dispatch takes.
  broadcastCapturePhase('routing')
  let landed: string | null = null
  try {
    landed = await dispatchFromCaptureInner(rawTranscript)
    return landed
  } finally {
    broadcastCapturePhase('idle', landed)
  }
}

async function dispatchFromCaptureInner(rawTranscript: string): Promise<string | null> {
  if (!manager) {
    log.error('dispatchFromCapture before initRemote')
    return null
  }
  const raw = (rawTranscript || '').trim()
  if (!raw) { log.warn('empty transcript — not dispatching', {}); return null }
  // The staging tray rides with THIS utterance to wherever it lands.
  const staged = takeStaged()

  // 0. ORCHESTRATE FOCUS short-circuit (§6.2). If the wall is focused on a session,
  //    the utterance goes THERE — deterministically, bypassing the router. This is
  //    PURELY ADDITIVE: with nothing focused (orchestrateFocusId === null) the block
  //    is skipped and routing below is exactly as before. We reuse the SAME paths
  //    the router uses (answer a blocked task / followUp to continue) — no new send.
  if (orchestrateFocusId && manager.list().some((t) => t.id === orchestrateFocusId)) {
    const fid = orchestrateFocusId
    // Hygiene: the deterministic path skips the router, so it must not skip
    // CLEANUP — an STT misfire ("Happy Rates!") would land verbatim otherwise.
    // Best-effort: without a wired completeFn the raw transcript passes through
    // (status quo); delivery stays deterministic either way.
    const text = completeFn ? ((await cleanIntent(raw, completeFn)).intent || raw) : raw
    const awaiting = manager.tasksAwaitingUser().some((t) => t.id === fid)
    if (awaiting) {
      typeStagedInto(fid, staged) // images + answer submit as one message
      manager.answer(fid, text)
      log.event('routed-to-focus', { taskId: fid, kind: 'answer' })
      return fid
    }
    typeStagedInto(fid, staged)
    if (manager.followUp(fid, text)) {
      log.event('routed-to-focus', { taskId: fid, kind: 'continue' })
      return fid
    }
    // Focused task couldn't take it (terminal/gone) → fall through to normal routing.
  }

  // 1. ALL routing goes through the warm router — including answering a task that
  //    is blocked on a question, and including the ZERO-open-tasks case: the
  //    router also decides the new task's species (oneoff vs persistent session)
  //    and its project binding ("work on the unmute repo" → that exact dir), so
  //    even a cold first utterance needs its judgement. It folds transcript
  //    cleanup into the same turn, and it's resident/warm — still instant.
  if (router) {
    const awaitingIds = new Set(manager.tasksAwaitingUser().map((t) => t.id))
    try {
      const tRoute = Date.now()
      // The user's real project universe (curated + recency-ranked, read-only
      // from ~/.claude.json) — what lets the router bind a session to a repo.
      const projects = await knownProjects().catch(() => [])
      // Short-term memory: recently finished tasks (sessions gone) so "change
      // the song" still resolves — as a self-contained NEW intent, never a
      // resurrection.
      const nowMs = Date.now()
      const finished = manager.recentlyFinished().map((t) => ({
        id: t.id, intent: t.intent, name: t.name ?? null, state: t.state,
        kind: t.kind ?? 'oneoff', category: t.category ?? null,
        ageSec: Math.max(0, Math.round((nowMs - t.updatedAt) / 1000)),
      }))
      const decision = await router.route(raw, routableSnapshot(nowMs), projects, finished)
      // Phase timing: how long the utterance spent in the router (warm → decision).
      log.event('phase-timing', { phase: 'router', ms: Date.now() - tRoute, action: decision.action })
      if (decision.action === 'continue' && decision.targetTaskId) {
        const tid = decision.targetTaskId
        // Continuing a BLOCKED task means piping the utterance in as its answer;
        // continuing a live task means a fresh follow-up turn.
        if (awaitingIds.has(tid)) {
          log.event('routed-as-answer', { taskId: tid, via: 'router' })
          typeStagedInto(tid, staged)
          manager.answer(tid, decision.intent || raw)
          return tid
        }
        typeStagedInto(tid, staged)
        if (manager.followUp(tid, decision.intent)) {
          log.event('routed-as-continuation', { taskId: tid, via: 'router' })
          return tid
        }
      }
      // The user's raw override (pill/Remote screen) forces RAW regardless of
      // the router's pick — a clean Claude Code session with no Unmute injection.
      const forcedRaw = injectionDisabled()
      const mode = forcedRaw ? 'raw' as const : decision.mode
      log.event('routed-as-new', { via: 'router', surface: decision.surface ?? null, mode: mode ?? null, forcedRaw, kind: decision.kind ?? null, dir: decision.dir ?? null })
      const newId = await manager.dispatch(intentWithStaged(decision.intent || raw, staged), { surface: decision.surface, mode, kind: decision.kind, cwd: decision.dir })
      // The router minted the display name in the same turn — instant, no extra
      // call. (The completeFn-based nameIntent below stays as the non-router path.)
      if (decision.name) manager.setName(newId, decision.name)
      // Declinable offer (§6.2 — never a silent reroute, never a blocking prompt):
      // the router chose NEW but seriously weighed one open task. Surface a
      // one-tap "or send it there?"; ignoring it costs nothing.
      if (decision.alternate && manager.get(decision.alternate)) {
        pendingRouteOffer = { newTaskId: newId, altTaskId: decision.alternate, intent: decision.intent || raw, at: Date.now() }
        const altName = manager.get(decision.alternate)!.name ?? manager.get(decision.alternate)!.intent
        for (const w of BrowserWindow.getAllWindows()) {
          if (!w.isDestroyed()) w.webContents.send('remote:route-offer', { newTaskId: newId, altTaskId: decision.alternate, altName })
        }
        log.event('route-offer-surfaced', { newTaskId: newId, altTaskId: decision.alternate })
      }
      return newId
    } catch (e) {
      log.warn('router error — dispatching new', { error: (e as Error).message })
      return manager.dispatch(raw, { mode: injectionDisabled() ? 'raw' : undefined })
    }
  }

  // 3. Nothing to route among → straight to a new task. Cleanup is optional (the
  //    executor tolerates raw); use the managed LLM only if it's wired.
  const cleaned = completeFn ? (await cleanIntent(raw, completeFn)).intent : raw
  if (!cleaned) { log.warn('empty intent after cleanup — not dispatching', {}); return null }
  return manager.dispatch(intentWithStaged(cleaned, staged), { mode: injectionDisabled() ? 'raw' : undefined })
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
    // Run the prune INSIDE the librarian's serial queue so it never overlaps a
    // write-mode librarian session (single-writer invariant covers gardening).
    void librarian.runMaintenance(async () => {
      const actions = await planGardening({ nowMs: Date.now() })
      // TEMP(memory-debug): remove after calibration
      log.event('gardening-sweep', { MEMORY_DEBUG: true, planned: actions.length })
      await applyGardening(actions, {})
    }).catch((e) => log.warn('gardening sweep failed', { error: (e as Error).message }))
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
      broadcastCapturePhase('listening') // ADDITIVE observer — the capture itself is untouched
    } else if (e.type === 'remote-stop') {
      log.event('remote-key', { phase: 'stop' })
      resumeOverlayEscape() // give Escape back to a still-visible overlay
      void deps.sessionManager.stopRemoteCapture()
      broadcastCapturePhase('transcribing')
    } else if (e.type === 'session-start') {
      // DICTATION captures get the screenshot ledger too (the pill 🖼 chip):
      // capture-while-dictating pastes the images into the target app right
      // after the text (see clipboard.ts injectOutput). Watch-only — the
      // dictation flow itself is untouched.
      startCaptureWatch()
    } else if (e.type === 'session-stop') {
      // Delivery consumes+stops in injectOutput; this is the safety stop for a
      // cancelled/failed dictation so the watcher never polls indefinitely.
      // Generation-guarded: never kills a NEWER capture's watch.
      const gen = captureWatchGen
      setTimeout(() => { if (captureWatchGen === gen) stopCaptureWatch() }, 20_000)
    }
  })

  // Pre-warm the floating overlay window (hidden) so the first present is instant.
  createOverlayWindow()
  // Orchestrate cockpit (NEW surface, handoff §3 #3): register the ⌘⇧O toggle.
  registerOrchestrateShortcut()
  // DEV-only convenience during build-out: auto-open the cockpit so it's
  // discoverable without hunting for the shortcut. (ELECTRON_RENDERER_URL is set
  // only in `electron-vite dev`.) Remove once a real entry point exists.
  if (process.env.ELECTRON_RENDERER_URL) openOrchestrateWindow()
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
  manager.on('created', (t: Task) => {
    broadcast('remote:task-created', t)
    onNewTask(activeTaskCount())
    // Async: derive a short session name (non-blocking — the capture/dispatch path
    // already returned; this just swaps the truncated-intent fallback in the UI).
    // The router usually mints the name in its own turn (instant); this managed-LLM
    // path is the fallback and must never OVERWRITE a name that already landed.
    if (completeFn) {
      void nameIntent(t.intent, completeFn)
        .then((n) => { if (n && !manager?.get(t.id)?.name) manager?.setName(t.id, n) })
        .catch(() => {})
    }
  })
  manager.on('updated', (t: Task) => { broadcast('remote:task-updated', t); reconcileDock(activeTaskCount()) })
  manager.on('needs-user', (t: Task) => {
    broadcast('remote:task-needs-user', t)
    maybePresent(t)
    reconcileDock(activeTaskCount())
    speakHeadline(t, 'needs-user') // §6.4 doorbell: terse, serialized, toggleable
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
    speakHeadline(t, 'failed')
  })
  manager.on('stuck', (t: Task) => {
    broadcast('remote:task-stuck', t)
    maybePresent(t)
    reconcileDock(activeTaskCount())
    notify('Task may be stuck', t.intent)
    speakHeadline(t, 'stuck')
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
  // The wall reports its focused session here; null clears it. Focus = the voice
  // address (§6.2). Additive: clearing it restores pure router behaviour.
  ipcMain.handle('remote:set-orchestrate-focus', async (_e, id: string | null) => {
    orchestrateFocusId = id || null
    log.event('orchestrate-focus-set', { taskId: orchestrateFocusId })
    // Announce the new terminal owner to every renderer. The overlay defers to a
    // glance for the wall-owned session, so exactly one surface renders a terminal
    // for a session at a time — no two LiveTerminals fighting over the PTY width.
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('remote:orchestrate-owner', { taskId: orchestrateFocusId })
    }
    return true
  })
  // Open the cockpit from the in-app Remote screen (the user-facing entry point;
  // ⌘⇧O stays as the power-user toggle).
  ipcMain.handle('remote:open-orchestrate', async () => { openOrchestrateWindow(); return true })
  // Current terminal owner — lets a freshly-mounted overlay card learn it owns
  // nothing (or that the wall already owns its session) without waiting for an event.
  ipcMain.handle('remote:get-orchestrate-owner', async () => orchestrateFocusId)
  // Voice-as-doorbell toggle (§6.4) — read + set from the cockpit's 🔔 chip.
  ipcMain.handle('remote:get-voice-headlines', async () => settings.get('voiceHeadlines') !== false)
  ipcMain.handle('remote:set-voice-headlines', async (_e, on: boolean) => { settings.set('voiceHeadlines', !!on); return true })
  // Pin/unpin a task's species from the UI (manual graduation §5): 'session'
  // exempts it from idle-kill + purge; 'oneoff' re-arms normal lifecycle.
  ipcMain.handle('remote:set-kind', async (_e, id: string, kind: 'oneoff' | 'session') => {
    if (!manager || (kind !== 'oneoff' && kind !== 'session')) return false
    manager.setKind(id, kind)
    return true
  })
  // Accept the pending route offer: erase the seconds-old mis-spawn and deliver
  // the SAME intent to the alternate task instead (answer if blocked, else
  // follow-up — the router's own delivery paths). Validated against main's own
  // pendingRouteOffer state, so a stale/forged accept is a no-op.
  ipcMain.handle('remote:accept-route-offer', async (_e, newTaskId: string) => {
    const offer = pendingRouteOffer
    if (!manager || !offer || offer.newTaskId !== newTaskId) return false
    pendingRouteOffer = null
    const alt = manager.get(offer.altTaskId)
    if (!alt) return false
    log.event('route-offer-accepted', { newTaskId, altTaskId: offer.altTaskId })
    await manager.remove(newTaskId) // the mis-spawn: seconds old, nothing of value
    if (manager.tasksAwaitingUser().some((t) => t.id === offer.altTaskId)) {
      manager.answer(offer.altTaskId, offer.intent)
    } else if (!manager.followUp(offer.altTaskId, offer.intent)) {
      // Alternate no longer warm — resume it, then the user can re-speak. Honest
      // fallback; never silently lose the utterance (it stays visible in the log).
      void manager.resume(offer.altTaskId)
    }
    return true
  })
  // Glance vocabulary (the rails): skills + projects, read straight from disk —
  // zero tokens. Skills have no surface anywhere in Claude Code's own UX; giving
  // them a face is what makes people actually say them.
  ipcMain.handle('remote:list-skills', async () => {
    // ALL skills — the rail is the full vocabulary; an unlisted skill is a skill
    // nobody says. The recipe-store reader only walks surface SUBFOLDERS, which
    // hid the older root-level skill files — so scan recursively ourselves:
    // ~/.unmute/remote/{skills,recipes}/**/*.md + ~/.claude/skills entries.
    // Name = filename (they ARE the names); recency = file mtime. Zero tokens.
    const { readdirSync, statSync } = await import('node:fs')
    const out: Array<{ name: string; lastUsed: string }> = []
    const walk = (dir: string, depth: number) => {
      if (depth > 3) return
      let entries: string[]
      try { entries = readdirSync(dir) } catch { return }
      for (const entry of entries) {
        if (entry.startsWith('.')) continue
        const full = join(dir, entry)
        try {
          const st = statSync(full)
          if (st.isDirectory()) { walk(full, depth + 1); continue }
          if (!entry.endsWith('.md')) continue
          out.push({ name: entry.replace(/\.md$/, ''), lastUsed: new Date(st.mtimeMs).toISOString().slice(0, 10) })
        } catch { /* skip unreadable */ }
      }
    }
    walk(join(homedir(), '.unmute', 'remote', 'skills'), 0)
    walk(join(homedir(), '.unmute', 'remote', 'recipes'), 0)
    // ~/.claude/skills: loose .md files AND skill folders (dir name = skill name).
    const claudeDir = join(homedir(), '.claude', 'skills')
    try {
      for (const entry of readdirSync(claudeDir)) {
        if (entry.startsWith('.')) continue
        try {
          const st = statSync(join(claudeDir, entry))
          out.push({ name: entry.replace(/\.md$/, ''), lastUsed: new Date(st.mtimeMs).toISOString().slice(0, 10) })
        } catch { /* skip */ }
      }
    } catch { /* no ~/.claude/skills — fine */ }
    const seen = new Set<string>()
    return out
      .filter((s) => s.name && !seen.has(s.name) && (seen.add(s.name), true))
      .sort((a, b) => (b.lastUsed || '').localeCompare(a.lastUsed || ''))
      .slice(0, 30)
  })
  ipcMain.handle('remote:list-projects', async () => {
    const projects = await knownProjects(8).catch(() => [])
    const home = homedir()
    const kept = projects.filter((p) => p.path !== home) // ran-claude-in-~ is not a project
    // Duplicate basenames (backend/calorify_ai vs frontend/calorify_ai) are
    // indistinguishable — disambiguate with the parent dir.
    const counts = new Map<string, number>()
    for (const p of kept) counts.set(p.name, (counts.get(p.name) ?? 0) + 1)
    return kept.slice(0, 6).map((p) => ({
      name: (counts.get(p.name) ?? 0) > 1 ? `${basename(dirname(p.path))}/${p.name}` : p.name,
      path: p.path,
    }))
  })
  // Rename a task — names are VOICE ADDRESSES, so users must be able to fix a
  // bad auto-name. Persists via setName (survives restarts).
  ipcMain.handle('remote:rename-task', async (_e, id: string, name: string) => {
    if (!manager || !name?.trim()) return false
    manager.setName(id, name.trim().slice(0, 48))
    return true
  })
  // Staging tray: stage an image with no target (rides with the next utterance).
  ipcMain.handle('remote:stage-image', async (_e, data: ArrayBuffer, ext: string) => {
    try {
      mkdirSync(STAGING_DIR, { recursive: true })
      const safeExt = (ext || 'png').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'png'
      const file = join(STAGING_DIR, `staged-${Date.now()}-${stagedAttachments.length}.${safeExt}`)
      writeFileSync(file, Buffer.from(data))
      stagedAttachments.push(file)
      broadcastStaged()
      log.event('image-staged', { file, count: stagedAttachments.length })
      return file
    } catch (e) {
      log.warn('stage-image failed', { error: (e as Error).message })
      return null
    }
  })
  ipcMain.handle('remote:get-staged', async () => stagedAttachments)
  // Thumbnails for the pill ledger's dropdown — you can't judge "should I remove
  // this?" from a number. Small data-URLs (CSP-proof; file:// is blocked in the
  // renderer), freshly derived per call.
  ipcMain.handle('remote:staged-previews', async () => {
    const { nativeImage } = require('electron') as typeof import('electron')
    return stagedAttachments.map((path) => {
      try {
        const img = nativeImage.createFromPath(path)
        if (img.isEmpty()) return { path, dataUrl: '' }
        return { path, dataUrl: img.resize({ height: 80 }).toDataURL() }
      } catch { return { path, dataUrl: '' } }
    })
  })
  ipcMain.handle('remote:clear-staged', async () => { stagedAttachments = []; broadcastStaged(); return true })
  // Prune one staged image (the pill strip's ✕) — reversibility before send.
  ipcMain.handle('remote:unstage-image', async (_e, path: string) => {
    const before = stagedAttachments.length
    stagedAttachments = stagedAttachments.filter((p) => p !== path)
    if (stagedAttachments.length !== before) broadcastStaged()
    return true
  })
  // Attach an image to a session (voice-era screenshot paste/drag). Bytes arrive
  // as an ArrayBuffer from the renderer; saved under the task's own dir and the
  // path is TYPED (unsubmitted) into the session — see TaskManager.attachFile.
  ipcMain.handle('remote:attach-image', async (_e, taskId: string, data: ArrayBuffer, ext: string) => {
    if (!manager) return null
    try { return await manager.attachFile(taskId, new Uint8Array(data), ext) } catch (e) {
      log.warn('attach-image failed', { taskId, error: (e as Error).message })
      return null
    }
  })
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
  // Raw-mode (no-injection) controls. Persistent default — set from the Remote
  // screen; applies to all future sessions.
  ipcMain.handle('remote:set-force-raw', async (_e, on: boolean) => {
    settings.set('forceRawMode', !!on)
    log.event('force-raw-set', { on: !!on, scope: 'persistent' })
    return true
  })
  // Per-session override — set from the pill widget; resets on relaunch. Passing
  // null clears the override (fall back to the persistent default).
  ipcMain.handle('remote:set-session-raw', async (_e, on: boolean | null) => {
    sessionForceRaw = on === null ? null : !!on
    log.event('force-raw-set', { on: sessionForceRaw, scope: 'session' })
    return true
  })
  // The effective state for UIs: the saved default, and what's in force right now
  // (session override applied over the default).
  ipcMain.handle('remote:get-raw-state', async () => ({
    persistentRawDefault: settings.get('forceRawMode') === true,
    sessionOverride: sessionForceRaw, // null | boolean
    effectiveRaw: injectionDisabled(),
  }))
  // ── Memory footprint + on-demand cleanup (user-triggered; storage courtesy) ──
  ipcMain.handle('remote:get-memory-usage', async () => {
    try { return await memoryUsage({}) }
    catch (e) { log.warn('memory-usage failed', { error: (e as Error).message }); return { bytes: 0, recipeCount: 0, skillCount: 0 } }
  })
  ipcMain.handle('remote:cleanup-memory', async () => {
    // A writer — run inside the librarian's serial queue (single-writer invariant).
    // runMaintenance resolves void, so capture the result via closure.
    let res: CleanupResult | null = null
    await librarian.runMaintenance(async () => { res = await cleanupMemory({ nowMs: Date.now() }) })
    const r = res as CleanupResult | null
    log.event('cleanup-memory-ipc', { MEMORY_DEBUG: true,
      pruned: r?.pruned.length ?? 0, evicted: r?.evicted.length ?? 0, demoted: r?.demoted.length ?? 0, deduped: r?.deduped.length ?? 0 })
    return r
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
    forceRawMode: settings.get('forceRawMode') === true,
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
