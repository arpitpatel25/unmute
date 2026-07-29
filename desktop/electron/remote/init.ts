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
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { existsSync, writeFileSync, mkdirSync, promises as fs } from 'node:fs'
import { execFile } from 'node:child_process'
import { TaskManager, type Task } from './task-manager'
import { Librarian } from './librarian'
import { ClaudeCodeExecutor } from './pty-session'
import { CodexExecutor, isExternalAgent, type AgentKind } from './codex-executor'
import { providerOf, PROVIDERS } from './providers'
import { CodexDesktopDriver } from './codex/driver'
import { installApprovalHook } from './codex/hooks'
import { cleanIntent, nameIntent, type CompleteFn } from './intent-cleanup'
import { MODELS } from './config'
import { initRuntimeConfig, getModels, getKnobs, getModelCatalog, isSelectableModel } from './runtime-config'
import { deriveRemoteKey, type TriggerKey } from './mode-router'
import { configureRemoteLogging, createLogger, getRemoteLogFilePath } from './log'
import { fixPath } from './fix-path'
import { buildSetupChecklist, setupComplete, type BackendProbe } from './setup-status'
import { createOverlayWindow, presentOrExpand, expandOverlay, openOverlay, dismissOverlay, setDockedMode, reconcileDock, onNewTask, getOverlayMode, setOverlayInteractive, pauseOverlayEscape, resumeOverlayEscape, setOverlaySuppressed } from './overlay'
import { registerOrchestrateShortcut, openOrchestrateWindow } from './orchestrate'
import { Router, type RoutableTask, type AgentAvailability } from './router'
import { CodexRouterEngine } from './codex-router-engine'
import { knownProjects, projectSlug } from './projects'
import { recordSkillUsage, readSkillStats, defaultStatsPath } from './skill-usage'
import { startMcpServer, MCP_PATH, type McpCreateTaskInput } from './mcp-server'
import { startCuaServer, type CuaServer } from './cua/server'
import { NotchClient } from './notch/notch-client'
import { NotchController } from './notch/notch-controller'
import { PillController, type PillStateP } from './notch/pill-controller'
import { listCodexModels, matchCurrent, type CodexModel } from './codex/appserver'
import { DriverManager } from './cua/driver-manager'
import { CdpLane } from './cua/lanes/cdp'
import { Arming } from './cua/lanes/arming'
import { runAppleScript } from './cua/lanes/applescript'
import { type RouterCtx } from './cua/router'
import { applyAxRegistration } from './ax/register'
import { normalizePolicy, type AxPolicy } from './ax/policy'
import { locateTranscript } from './trace-reducer'
import { resolveTmuxBin, sessionNameFor, tmuxAttachArgs, tmuxKillSessionArgs, TMUX_CONF } from './tmux'
import { planGardening, applyGardening, cleanupMemory, memoryUsage, type CleanupResult } from './gardening'
import { Curator, makeRunSweep, ProposalConversation, type SessionInfo } from './curator'
import { buildCuratedIndexFrom } from './curator-index'
import {
  curatorPaths, readOwnership, ownedSkillNames, appendRejection, appendFeedback,
  resolveProposal, readProposal, listPendingProposals,
  readCandidates, writeCandidates, setCandidateStatus,
  type CuratorPaths, type Proposal,
} from './curator-store'
import { writeSkill } from './curator-writer'
import { devlog, devEvent } from './curator-devlog'

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
  // Screenshot capture during dictation/Remote: screenshots taken WHILE speaking
  // auto-attach (dictation → pasted after the text; Remote → attached to the
  // task). OFF reverts to plain behavior — Unmute never touches screenshots.
  screenshotCapture: boolean
  // Skills the user pinned to the top of the cockpit rail (manual override of
  // the earned-trust ranking).
  pinnedSkills: string[]
  // How the notch and the pill render their material.
  //   'system' — follow Accessibility → Reduce Transparency (the default, and
  //              the only value that respects an accessibility preference)
  //   'glass'  — always translucent
  //   'solid'  — always opaque
  surfaceAppearance: 'system' | 'glass' | 'solid'
  // The Unmute MCP (agent intercom): may sessions create peer tasks? ON by
  // default — the guardrails (provenance, depth-1, rate caps) carry the
  // safety; this is the master off-switch.
  agentTasksEnabled: boolean
  // Computer Use (ax-mcp): lets Claude Code drive desktop apps in the background
  // via the Accessibility API. OFF by default (opt-in — grants real control).
  // Once enabled, allowAll (default) puts the WHOLE computer in scope; the
  // allowlist is an optional restriction. See ./ax/policy.
  computerUse: AxPolicy
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
    // the Remote settings or the capture-widget model selector. (See MODELS in
    // ./config — the single source for every model choice.)
    model: MODELS.doerDefault,
    modelUserSet: false,
    browserEnabled: true,
    setupConfirmations: {},
    osNotifications: false,
    overlayAutoPresent: true,
    overlayDocked: true,
    librarianWriteEnabled: false,
    forceRawMode: false,
    voiceHeadlines: true,
    screenshotCapture: true,
    pinnedSkills: [],
    // FIXED by default — see Theme.swift. Live glass is opt-in while
    // macOS 26.2 caches its backdrop on all-Spaces panels.
    surfaceAppearance: 'solid',
    agentTasksEnabled: true,
    computerUse: { enabled: false, screenshotEnabled: true, allowAll: true, allowed: [] },
  },
})

// Computer Use (ax-mcp) server handle + a lightweight activity broadcaster the
// menu-bar / overlay can subscribe to (shows what's being driven — the live
// "kill switch" affordance: the user sees an app is under control and can flip
// Computer Use off, which every subsequent tool call reads immediately).
let cuaServer: CuaServer | null = null
let cuaManager: DriverManager | null = null
let notchClient: NotchClient | null = null
let notchController: NotchController | null = null
/** The bottom-centre input surface. Shares the notch's helper process and its
 *  stdio channel — one process owning both panels is what keeps the two
 *  surfaces on literally the same material system rather than on two
 *  implementations that agree by discipline. */
let pillController: PillController | null = null
function broadcastAxActivity(ev: { app?: string; tool: string; ok: boolean }): void {
  try {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('remote:ax-activity', { ...ev, at: Date.now() })
    }
  } catch { /* best-effort telemetry */ }
}

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

/**
 * Probe every backend the app knows about, for the setup checklist.
 *
 * Driven by the provider registry rather than a hand-written list, so a backend
 * added to providers.ts gets a setup row without touching this function or the
 * renderer. `codex` (the CLI adapter) is skipped: it is not a user-selectable
 * backend today — startup migrates a stored 'codex' back to 'claude'.
 */
async function probeBackends(): Promise<BackendProbe[]> {
  const out: BackendProbe[] = []
  for (const p of Object.values(PROVIDERS)) {
    if (p.id === 'codex') continue
    if (p.transport === 'pty') {
      // An owned-PTY backend needs its CLI on the PATH the executors will get.
      const ok = await claudeCliAvailable()
      out.push({ id: p.id, label: p.label, installed: ok, ready: ok, ...(ok ? {} : { reason: 'not-installed' }) })
      continue
    }
    // A driven app: installed is not enough — it has to be reachable as well,
    // which is the state the user has no other way of discovering.
    if (!codexDriver) { out.push({ id: p.id, label: p.label, installed: false, ready: false, reason: 'not-installed' }); continue }
    try {
      const a = await codexDriver.availability()
      const installed = a.ok || a.reason !== 'not-installed'
      out.push({ id: p.id, label: p.label, installed, ready: a.ok, ...(a.ok ? {} : { reason: a.reason }) })
    } catch {
      out.push({ id: p.id, label: p.label, installed: false, ready: false, reason: 'not-installed' })
    }
  }
  log.event('setup-backends', { probed: out.map((b) => ({ id: b.id, ready: b.ready, reason: b.reason ?? null })) })
  return out
}

/** Assemble the onboarding checklist from detected + confirmed state (§12). */
async function getSetupStatus() {
  const browserEnabled = settings.get('browserEnabled') !== false
  const mcpListOutput = await claudeMcpList()
  const confirmations = settings.get('setupConfirmations') ?? {}
  const backends = await probeBackends()
  const steps = buildSetupChecklist({ mcpListOutput, browserEnabled, tmuxAvailable: tmuxBin !== null, confirmations, backends })
  const complete = setupComplete(steps)
  log.event('setup-status', { complete, todo: steps.filter((s) => s.status === 'todo').map((s) => s.key) })
  return { steps, complete }
}

let manager: TaskManager | null = null
/** Codex desktop backend — inert until a task targets it (see codex/driver.ts). */
let codexDriver: CodexDesktopDriver | null = null

/**
 * Which backends can take a task this instant, plus the user's default.
 *
 * Claude Code is always listed: it is Unmute's own owned-PTY lane and needs no
 * external app. Codex desktop is listed only when it is installed AND armed —
 * an installed-but-unarmed Codex would accept the routing decision and then
 * fail at dispatch, which is precisely the "promised it went somewhere it
 * didn't" failure this guards against. The Codex project list rides along so
 * "put it in the unmute project" can be resolved by name.
 */
/**
 * Is the Claude Code CLI actually installed?
 *
 * This used to be ASSUMED — `agents` started as `['claude']` and resolveAgent
 * fell back to it whenever Codex was unreachable. For a user who has the Codex
 * desktop app and no Claude CLI that is exactly backwards: every fallback lands
 * on the one backend they cannot run, and the router (a Claude session) never
 * starts either, so routing silently degrades to failsafeDecision — a new task
 * per utterance, carrying the raw transcript, with no targeting or naming.
 *
 * Checked against the SAME PATH the executors get (fixPath has already run by
 * the time anything routes), cached briefly because it is asked per dispatch.
 */
let claudeCliCache: { at: number; ok: boolean } | null = null
export async function claudeCliAvailable(): Promise<boolean> {
  if (claudeCliCache && Date.now() - claudeCliCache.at < 60_000) return claudeCliCache.ok
  const ok = await new Promise<boolean>((resolve) => {
    execFile('/usr/bin/which', ['claude'], { env: process.env }, (err, stdout) => {
      resolve(!err && !!String(stdout).trim())
    })
  })
  if (claudeCliCache?.ok !== ok) log.event('claude-cli-availability', { ok })
  claudeCliCache = { at: Date.now(), ok }
  return ok
}

async function agentAvailability(): Promise<AgentAvailability> {
  const agents: Array<'claude' | 'codex-desktop'> = []
  if (await claudeCliAvailable()) agents.push('claude')
  let codexProjects: string[] | undefined
  if (codexDriver) {
    try {
      const a = await codexDriver.availability()
      if (a.ok) {
        agents.push('codex-desktop')
        codexProjects = (await codexDriver.projects()).map((p) => p.name)
      }
    } catch { /* availability is best-effort; absence just means "not offered" */ }
  }
  // Prefer what the user chose, but never offer a backend they cannot run. With
  // neither present we still report 'claude' so the caller has something to
  // name in an error — reporting an empty list would read as "no agents" to
  // every consumer and hide the real problem.
  const stored = settings.get('agent')
  const preferred: 'claude' | 'codex-desktop' =
    stored === 'codex-desktop' && agents.includes('codex-desktop') ? 'codex-desktop'
      : agents.includes('claude') ? 'claude'
      : agents[0] ?? 'claude'
  return { agents, preferred, ...(codexProjects?.length ? { codexProjects } : {}) }
}

/**
 * Final backend for a dispatch. Voice wins over the picker; the picker wins
 * over the default. Never returns a backend that isn't reachable — a stale
 * preference silently degrades to Claude (logged) instead of throwing, because
 * losing the task is worse than running it in the other agent.
 */
async function resolveAgent(spoken: 'claude' | 'codex-desktop' | undefined, avail: AgentAvailability): Promise<AgentKind> {
  const want = spoken ?? avail.preferred
  if (avail.agents.includes(want)) return want
  // FALL BACK TO WHAT EXISTS, not to Claude by reflex. A Codex-only user was
  // being sent to a CLI they do not have, which fails at spawn rather than
  // degrading.
  const alt = avail.agents[0]
  if (alt) {
    log.warn('agent-unavailable-fallback', { want, to: alt })
    return alt
  }
  log.warn('no-agent-available', { want })
  return want
}
let completeFn: CompleteFn | null = null
// ONE ROUTER PER BACKEND, both warm, each blind to the other's tasks.
//
// A single shared router is what let a Codex task be proposed as a resume while
// the picker said Claude — the decision then ran the wrong backend entirely.
// Splitting them makes that impossible by construction rather than by rule: the
// Claude router is never handed a Codex task, so it cannot name one.
//
// Both are held warm regardless of the current picker, so switching provider
// costs nothing. The Codex engine warms in ~435ms and answers in ~5s, against
// the Claude REPL's 8-14s measured in the field — this is not a fallback.
let router: Router | null = null            // claude
let codexRouter: Router | null = null       // codex-desktop
// Curator store paths (fixed, homedir-based) — shared by initRemote's wiring and
// the route handler in dispatchFromCaptureInner (both module-scope readers).
const curatorPathsV: CuratorPaths = curatorPaths()

/** A minimal, tool-less classifier session for the router: no --chrome, no tmux;
 *  --dangerously-skip-permissions so it can write its decision file unprompted.
 *  Pinned to a light, fast model — classification is thin and must answer in
 *  ~1-2s, and we must NOT inherit the CLI default (the user can change it to
 *  Opus, which is heavy and slow for a one-line judgement). */
function routerExecutorFactory() {
  return new ClaudeCodeExecutor({ model: getModels().router, extraArgs: ['--dangerously-skip-permissions'], chrome: false })
}

/** Build the router's task snapshot from Unmute's live map (Unmute is the hub —
 *  the router never touches sessions). */
// How long a user interaction keeps a session's thread HOT (auto-routable).
// Past this, a persistent session is focus-only — the consent policy. Runtime-
// configurable via getKnobs().hotThreadMs (read at use, so a live update applies).

function snapshotOf(t: Task, now: number, surfaced: boolean): RoutableTask {
  return {
    id: t.id,
    agent: t.agent === 'codex-desktop' ? 'codex-desktop' : 'claude',
    intent: t.intent,
    name: t.name ?? null,
    state: t.state,
    kind: t.kind ?? 'oneoff',
    // What the user SAYS to address a project session ("the unmute one") — only
    // meaningful when the task runs outside our scratch dir.
    project: t.cwd !== t.home ? basename(t.cwd) : null,
    category: t.category ?? null,
    ageSec: Math.max(0, Math.round((now - t.updatedAt) / 1000)),
    group: t.group ?? null,
    surfaced,
    awaiting: t.state === 'needs-user',
    question: t.state === 'needs-user' ? (t.question?.text ?? null) : null,
  }
}

/** THE CONSENT POLICY (safety, layer 1 of 3): partition the routable tasks.
 *  targetable — the router may auto-continue into these: ONE-OFFS ONLY (quick
 *    errands where a follow-up is the natural next turn).
 *  coldSessions — EVERY persistent session, in EVERY state (working, done, or
 *    blocked on a question). A persistent session is NEVER router-targetable —
 *    not when hot, not when it asked a question, not ever. The ONLY way voice
 *    reaches a session is EXPLICIT FOCUS: you are inside its stage on the wall
 *    (the focus short-circuit), which requires the wall to be focused AND that
 *    session open — leaving the app (blur) or the cockpit grid clears focus. So:
 *    from the cockpit, from another app, or from a task you then left, a session
 *    can never be hijacked. Sessions are shown to the router as context only,
 *    reachable via the declinable offer (alternate) — a tap is the consent.
 *
 *  WHY THE HARD RULE (was: a "hot" session — touched within hotThreadMs — stayed
 *  targetable "so conversations never go deaf mid-flow"). That soft window was the
 *  hole: a session created/touched in the last 10min was auto-targetable, so a
 *  brand-new "create a new worktree" dictated from the cockpit got continued INTO
 *  a running session (proven live, v1.3.22). Focus is now the sole address for a
 *  session — the invariant the product was designed around ("focus IS the
 *  address"), enforced in code rather than left to the router's judgement. */
function partitionRoutable(now: number): { targetable: RoutableTask[]; coldSessions: RoutableTask[] } {
  if (!manager) return { targetable: [], coldSessions: [] }
  const targetable: RoutableTask[] = []
  const coldSessions: RoutableTask[] = []
  // routableTasks() is newest-first; the most-recent one is the de-facto
  // "on-screen" task (the overlay auto-expands the last change) — mark it so the
  // router has that prior when the command is terse.
  manager.routableTasks().forEach((t, i) => {
    const snap = snapshotOf(t, now, i === 0)
    // A persistent session is focus-only, unconditionally — never a router target.
    if ((t.kind ?? 'oneoff') === 'session') coldSessions.push(snap)
    else targetable.push(snap)
  })
  return { targetable, coldSessions }
}

// tmux backing for the live terminal (pop-out to a real terminal = SAME session).
// Resolved once at init; null ⇒ tmux not installed, sessions spawn directly.
let tmuxBin: string | null = null
const tmuxConfPath = join(homedir(), '.unmute', 'remote', 'tmux.conf')

/** Compact "22h" / "3m" / "0:42" age from a timestamp, for cockpit cards. */
function relativeAge(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

/** Open a task's tmux session in the user's terminal app (iTerm if present, else
 *  Terminal). It ATTACHES to the running session — same claude, not a new one. */
/**
 * Tap-through for a Codex desktop task: put the user in the REAL Codex chat.
 *
 * This is the Codex analogue of "show me the terminal". A Claude task can show
 * its raw PTY because Unmute owns it; a Codex thread lives in someone else's
 * app, and re-rendering the conversation inside Unmute is the exact thing
 * ORCHESTRATE-VISION §3 forbids ("no chat-bubble transcript re-rendering" — the
 * delete-the-wall test). So we hand them the app itself, focused on that thread.
 *
 * Foreground IS correct here: the user asked to go there. This is the one place
 * in the Codex lane where stealing focus is the feature, not the bug.
 */
function openInCodex(taskId: string): boolean {
  const task = manager?.get(taskId)
  if (!task?.codexThreadId || !codexDriver) { log.warn('open-in-codex: not a codex task', { taskId }); return false }
  const threadId = task.codexThreadId
  void (async () => {
    // The deep link BOTH selects the thread and brings Codex forward, so there
    // is no window to activate separately and no flicker through whatever was
    // last open.
    //
    // Previously this activated Codex unconditionally and merely logged whether
    // the switch worked — so a failed lookup silently dumped the user into some
    // other conversation while reporting success. If we cannot land on the right
    // thread, say so and leave their window alone.
    const switched = await codexDriver!.openThread(threadId).catch(() => false)
    log.event('open-in-codex', { taskId, threadId, switched })
    if (switched) {
      // Get out of the way. We just sent the user to another window; staying
      // pinned in front of it is the opposite of handing off.
      notchController?.collapse()
    } else {
      notchController?.toast('could not open that Codex chat')
      log.warn('open-in-codex-failed', { taskId, threadId })
    }
  })()
  dismissOverlay()
  return true
}

function openInTerminal(taskId: string): boolean {
  // A Codex task has no PTY — route it to the real Codex chat instead. Keeping
  // ONE command from the UI's perspective means the notch/cockpit doesn't need
  // to branch on backend to offer "take me there".
  const t = manager?.get(taskId)
  if (t && t.agent === 'codex-desktop') return openInCodex(taskId)
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
    threadContext: t.threadContext ?? null,
    shelved: t.shelved ?? false,
    note: t.note ?? null,
    spawnedBy: t.spawnedBy ?? null,
    group: t.group ?? null,
    // WHICH backend runs this task. The cockpit tags every card with it so a
    // wall mixing Claude Code and Codex tasks is never ambiguous about where
    // the work actually lives.
    agent: t.agent ?? 'claude',
    // ...and WHAT THAT BACKEND IS, resolved from the one registry (providers.ts).
    // Sent rather than re-derived because the renderer is a separate tsconfig
    // that cannot import from electron/ — the alternative was a second copy of
    // the table in the renderer, which is the exact drift this replaces. The
    // renderer stays dumb: it renders `provider.label` and honours
    // `provider.canResume` without knowing what any backend is.
    provider: providerOf(t.agent),
    codexProject: t.codexProject ?? null,
    // The GUI-agent equivalent of the terminal (see Task.conversation).
    conversation: t.conversation ?? null,
    state: t.state,
    category: t.category ?? null,
    step: t.step ?? null,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    result: t.result ?? null,
    error: t.error ?? null,
    // Resume is seconds long and used to move nothing until it finished; these
    // two are what let the card show it is working, and say so when it isn't.
    resuming: t.resuming ?? false,
    resumeError: t.resumeError ?? null,
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

function executorFactory(resume = false, forTask?: AgentKind) {
  const mode = settings.get('permissionMode')
  // WHOSE BACKEND IS THIS? `forTask` = the agent an EXISTING task was created on;
  // it always wins. The global picker answers only "what should NEW work run on",
  // and using it for a resume is what made every Claude session unresumable the
  // moment the picker was flipped to Codex (field report 2026-07-28).
  const agent: AgentKind = forTask ?? settings.get('agent')
  const sandboxRoots = settings.get('sandboxRoots') ?? []
  const sandboxed = sandboxRoots.length > 0
  const model = settings.get('model') || getModels().doerDefault
  const browser = settings.get('browserEnabled') !== false
  log.event('executor-factory', { agent, forTask: forTask ?? null, permissionMode: mode, sandboxed, sandboxRoots, model, browser, resume })
  // HARD SEPARATION (invariant). Everything below builds a PTY-backed CLI
  // session — i.e. Claude Code. An external backend must never reach here: if
  // it did, the fall-through would hand the user a Claude session for a task
  // they explicitly chose Codex for. That is exactly the crossing that produced
  // a duplicate Claude task on 2026-07-25, so it now throws LOUDLY instead of
  // silently doing the wrong thing.
  if (isExternalAgent(agent)) {
    log.error('executor-factory called for an external backend — this is a bug', { agent })
    throw new Error(`AGENT_SEPARATION_VIOLATION: ${agent} has no PTY executor; dispatch must route it to its driver`)
  }
  if (agent === 'codex') {
    // Codex CLI resume is NOT wired (its continuation mechanism differs from
    // Claude's --resume/--continue). Building a plain executor here would spawn a
    // BRAND-NEW, context-free codex REPL behind a button that promises "continue
    // with full context" — and, now that opening a session can resume it without
    // a tap, it would do so silently. Fail loudly instead: resume() catches this,
    // reports false, and the card keeps its (honest) ended state. Dormant today —
    // the picker offers Claude and Codex desktop only — this is the guard for
    // when the CLI backend ships.
    if (resume) {
      log.error('codex CLI resume is not implemented — refusing to spawn a context-free session', { agent })
      throw new Error('CODEX_CLI_RESUME_UNSUPPORTED: a fresh codex REPL would not continue this task')
    }
    return new CodexExecutor({})
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
  // The pill's model/agent chips come from HERE, not from the capture renderer:
  // main owns the setting and the config-driven catalog, so a second copy in the
  // renderer could only ever disagree. Resolved once as the capture opens —
  // availability changes rarely (Codex opened or closed), and the answer is only
  // needed at the moment the chips appear.
  if (phase === 'listening') void pushPillChips()
  if (phase === 'listening') startCaptureWatch()
  else if (phase === 'transcribing') secureAndClearClipboard() // key just lifted — secure, then clear if consumed
  // idle = the remote capture RESOLVED. Delivery already emptied the tray via
  // takeStaged(); anything auto still here means no delivery (empty transcript,
  // router error) — forfeit it.
  else if (phase === 'idle') stopCaptureWatch({ purgeAuto: true })
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('remote:capture-phase', { phase, taskId: taskId ?? null })
  }
  notchController?.notifyCapturePhase(phase, taskId ?? null)
}

/** The one pending "or send it there?" route offer (only the LATEST matters —
 *  a new utterance supersedes any stale offer). Accepting kills the seconds-old
 *  mis-spawn and reroutes the SAME intent into the alternate; ignoring it costs
 *  nothing and it simply expires in the UI. */
let pendingRouteOffer: { newTaskId: string; altTaskId: string; intent: string; at: number } | null = null

/** At most one background repair in flight, and never a storm of them. */
let reasoningRepairAt = 0
function scheduleReasoningRepair(): void {
  const now = Date.now()
  if (now - reasoningRepairAt < 60_000) return
  reasoningRepairAt = now
  void refreshCodexReasoningForPill()
    .then(() => { void pushPillChips() })
    .catch(() => { /* best-effort; the fallback list still renders */ })
}

/** Re-read Codex's reasoning axes and cache them, so the pill's model half can
 *  be served instantly on the next push. Best-effort: a failed walk must never
 *  erase what we last genuinely saw. */
async function refreshCodexReasoningForPill(): Promise<void> {
  if (!codexDriver) return
  try {
    const state = await codexDriver.reasoningOptions()
    // Only overwrite with a REAL reading — a failed walk must not erase what we
    // last genuinely saw. "Advanced" is a PARENT-menu row, so an axis reporting
    // it is not reporting options at all; treating it as real is what left a
    // poisoned cache on disk and emptied the Effort column.
    const real = (state?.options?.Model ?? []).filter((v) => v && v.toLowerCase() !== 'advanced')
    if (real.length) {
      settings.set('codexReasoningCache' as never, state as never)
      log.event('codex-reasoning-cached', {
        model: state.options.Model?.length, effort: state.options.Effort?.length, speed: state.options.Speed?.length,
      })
    } else {
      log.warn('codex-reasoning-read-unusable', { options: state?.options })
    }
  } catch (e) {
    log.warn('codex reasoning refresh failed', { error: (e as Error).message })
  }
}

/** Push the model / agent / raw chips to the native pill.
 *
 *  Best-effort by design: a chip that cannot be resolved simply does not
 *  render, and a failure here must never surface on the capture path. */
async function pushPillChips(): Promise<void> {
  if (!pillController) return
  try {
    const agent = (settings.get('agent') as AgentKind) ?? 'claude'
    const isCodex = agent === 'codex-desktop'
    const codexOk = codexDriver
      ? await codexDriver.availability().then((a) => a.ok).catch(() => false)
      : false

    // THE MODEL CONTROL FOLLOWS THE PLATFORM.
    //
    // Claude Code and Codex do not share a model list and never can — Claude has
    // a flat catalog, Codex has its own Model / Effort / Speed axes read out of
    // its menus. Serving one list regardless of agent is how the chip ended up
    // offering Claude models while Codex was selected. The renderer already
    // solved this with an `isCodex` gate; this is the same gate, on the side
    // that now owns the data.
    const chips: PillStateP = {
      agent: isCodex ? 'Codex' : 'Claude Code',
      agentConnected: isCodex ? codexOk : true,
      agentOptions: [
        { id: 'claude', label: 'Claude Code', available: true },
        { id: 'codex-desktop', label: 'Codex', available: codexOk },
      ],
      stagedCount: stagedAttachments.length + pendingClipboardCount,
    }

    if (isCodex) {
      // Served from CACHE so the axes are there immediately — reading them live
      // walks Codex's menus (~3s) and a capture is often over before that
      // returns, which is exactly why the chip used to keep showing a Claude
      // model after the switch.
      const cached = settings.get('codexReasoningCache' as never) as
        { label?: string | null; current?: Record<string, string>; options?: Record<string, string[]> } | undefined
      // THE LIVE MENU IS THE AUTHORITY ON WHAT CAN BE PICKED.
      //
      // Every value here has to be clickable, because the write path IS a menu
      // click. So the menu decides — and it can now be read reliably: the
      // pointer-event opener returns all three axes in ~1.5s
      // (Model 6, Effort 5, Speed 2, measured). Before that opener existed the
      // scrape returned "Advanced" as the only value for every axis, and two
      // decisions were made on top of that garbage:
      //
      //   * Effort was taken from the PROTOCOL instead. But `model/list` is a
      //     SUPERSET of what is offerable — it reports Max for 5.6 Sol, which
      //     the menu does not offer at all. Picking it changed nothing.
      //   * Speed was DELETED, on the reasoning that it "was an artefact of
      //     scraping a menu and treating every row as an axis". It is not. The
      //     menu genuinely offers Standard and Fast. A real control was removed
      //     because the reader was broken.
      //
      // The protocol still earns its place: it is the model CATALOGUE, read
      // headless in ~1ms with no arming, and it is the fallback when no menu
      // read has happened yet — better than an empty column on first launch.
      const models = await listCodexModels().catch(() => [] as CodexModel[])

      // Reject a cache written by the OLD reader. Its signature is unmistakable:
      // "Advanced" is a row of the PARENT menu, so an axis offering it is not
      // reporting options at all. Version-stamping the cache would not have
      // helped here — the poison was already on disk — but a shape check does,
      // and it keeps working if a future read degrades the same way.
      const sane = (vals: string[] | undefined): string[] =>
        (vals ?? []).filter((v) => v && v.toLowerCase() !== 'advanced')
      const menu = {
        Model: sane(cached?.options?.Model),
        Effort: sane(cached?.options?.Effort),
        Speed: sane(cached?.options?.Speed),
      }

      const live = matchCurrent(cached?.label ?? null, models)   // returns UI spellings
      chips.model = cached?.label || 'Codex'
      const cur = cached?.current ?? {}
      // Menu first, protocol second. Values carry the UI spelling either way —
      // it is what the writer searches for and what the button already shows.
      // SELF-HEAL. A cache that offers nothing usable — never read, or written
      // by the old scraper — is repaired in the BACKGROUND so this push stays
      // instant. The capture path must never wait on a menu walk; that is the
      // whole reason these values are cached in the first place.
      if (!menu.Model.length || !menu.Effort.length) scheduleReasoningRepair()

      const modelValues = menu.Model.length ? menu.Model : models.map((m) => m.uiLabel)
      const effortValues = menu.Effort.length
        ? menu.Effort
        : (models.find((m) => m.uiLabel === live.model)?.effortLabels ?? models[0]?.effortLabels ?? [])
      chips.modelAxes = [
        { axis: 'Model', values: modelValues, current: cur.Model ?? live.model },
        { axis: 'Effort', values: effortValues, current: cur.Effort ?? live.effort },
        { axis: 'Speed', values: menu.Speed, current: cur.Speed },
      ].filter((a) => a.values.length > 0)
      // AN EMPTY ARRAY, NOT `undefined` — this is the bug that caused the hang.
      // push() merges, so an ABSENT key KEEPS the previous value: the Claude
      // catalog survived into the Codex state, the view fell through to it, and
      // picking a "Codex model" wrote Claude's setting while the Codex label
      // never moved. Absent means keep; empty means cleared.
      chips.modelOptions = []
      // RAW is not offered on Codex at all — dispatchCodexDesktop returns before
      // `mode` is ever read and then records 'managed', so there is nothing for
      // raw to skip. A control that cannot act is worse than no control.
      chips.raw = null
    } else {
      const catalog = getModelCatalog()
      const current = settings.get('model') || getModels().doerDefault
      chips.model = catalog.find((c) => c.id === current)?.label ?? current
      chips.modelOptions = catalog.map((c) => ({
        id: c.id, label: c.label, detail: c.description ?? '',
      }))
      chips.modelAxes = []          // same reasoning — clear, do not omit
      chips.raw = injectionDisabled()
    }

    pillController.push(chips)
  } catch (e) {
    log.warn('pill chips push failed', { error: (e as Error).message })
  }
}

// ── Staging tray (multimodal, capture-first): images pasted/dropped with NO
// target stage here, then ride with the NEXT utterance to wherever it lands —
// new task (paths join the intent), continuation/answer (paths typed into the
// target right before the payload, submitting as ONE message). The tray is to
// images what the router is to words: an address-free buffer resolved at
// speak-time. Files live under ~/.unmute/remote/staging (tiny, swept with age).
const STAGING_DIR = join(homedir(), '.unmute', 'remote', 'staging')
// Two consent models share this tray, and the tag is what keeps them honest:
// `auto` = ambient screenshot captured during a dictation window — its LIFE IS
// THE WINDOW (start → delivery); it must never outlive a capture that ended
// without delivering. `explicit` = the user deliberately pasted/dropped an
// image with no target — that one rides to the next utterance by design
// (visible in the chip, manually removable).
interface StagedEntry { path: string; auto: boolean }
let stagedAttachments: StagedEntry[] = []
/** Clipboard screenshots NOTICED during recording but not yet readable (reading
 *  the image mid-recording corrupts audio; the FORMAT list is free metadata).
 *  Purely a counter for the pill — the real read happens at key-lift. */
let pendingClipboardCount = 0
function broadcastStaged(): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('remote:staged-changed', { count: stagedAttachments.length + pendingClipboardCount, paths: stagedAttachments.map((s) => s.path), pending: pendingClipboardCount })
  }
  notchController?.notifyStagedChanged()
  // The staged-image chip lives on the pill too, and main is the only place
  // that knows the true count (the renderer's chip keeps its own copy).
  pillController?.push({ stagedCount: stagedAttachments.length + pendingClipboardCount })
}

// ── Utterance-scoped screenshot capture (the pill ledger). The dictation window
// is the CONSENT signal: screenshots taken while addressing Unmute — or in the
// short gap since the last utterance — belong to what's being said. Everything
// staged is VISIBLE on the pill (🖼 n, prunable with ✕) before it sends; nothing
// rides invisibly. Only ever active for REMOTE captures, never plain dictation.
// Max screenshots auto-staged per remote capture — runtime-configurable via
// getKnobs().captureMaxAuto (read at use so a live update applies).
let captureWatchTimer: ReturnType<typeof setInterval> | null = null
let captureWatchGen = 0 // generation guard: a stale safety-stop must not kill a newer watch
let screenshotDirCache: string | null = null
/** Signatures (size + head-hash) of every clipboard image we've seen — staged
 *  OR marked known at a capture boundary. One image never attaches twice, and
 *  a stale pre-existing clipboard image never auto-attaches. */
const knownClipSigs = new Set<string>()

/** Cheap, consistent signature: byte length + md5 of the first 4KB. Never
 *  hashes a whole multi-MB PNG. */
function sigOf(buf: Buffer): string {
  const head = buf.subarray(0, 4096)
  const md5 = require('node:crypto').createHash('md5').update(head).digest('hex') as string
  return `${buf.length}:${md5}`
}


// ── The multi-screenshot enabler: rescue each ⌃-clipboard screenshot the moment
// it lands — BEFORE the next one overwrites it — without main ever touching the
// image while recording. An osascript CHILD PROCESS dumps the pasteboard PNG to
// a probe file (all decode/write cost lives in the child); main only stats the
// result and reads 4KB for the signature. New signature → copy into staging
// (APFS clone, ~instant) → the pill chip counts up live with a REAL file.
const CLIP_PROBE_FILE = () => join(STAGING_DIR, '.clip-probe.png')
let clipProbeBusy = false
/** Has THIS capture window completed its baseline probe? The baseline learns
 *  whatever image was already in the clipboard BEFORE the trigger, so it never
 *  attaches. Until it has verifiably completed, every probe runs learn-only —
 *  a skipped baseline (previous probe still in flight) or a failed osascript
 *  must NEVER let a pre-dictation image slip through as "new". */
let clipBaselined = false
/** Did any clipboard image get STAGED during the current capture? Drives the
 *  consume-then-clear at key-lift (we only clear what we delivered). */
let clipStagedThisCapture = false
function probeClipboardViaChild(markOnly = false, onDone?: (sawImage: boolean, stagedNew: boolean) => void): void {
  if (clipProbeBusy || (!markOnly && stagedAttachments.length >= getKnobs().captureMaxAuto)) { onDone?.(false, false); return }
  clipProbeBusy = true
  try { mkdirSync(STAGING_DIR, { recursive: true }) } catch { /* ignore */ }
  const probe = CLIP_PROBE_FILE()
  // Fresh slate: a leftover probe file from an earlier capture must not read as
  // "the clipboard's current image" when the child's PNGf coercion errors out
  // (empty clipboard) and leaves the file untouched.
  try { (require('node:fs') as typeof import('node:fs')).rmSync(probe, { force: true }) } catch { /* ignore */ }
  const script = [
    'try',
    'set png to the clipboard as «class PNGf»',
    `set f to open for access POSIX file "${probe}" with write permission`,
    'set eof f to 0',
    'write png to f',
    'close access f',
    'on error',
    'end try',
  ].flatMap((l) => ['-e', l])
  execFile('osascript', script, { timeout: 5000 }, (err) => {
    clipProbeBusy = false
    if (err) { onDone?.(false, false); return } // osascript itself failed — clipboard state UNKNOWN, stay unbaselined
    try {
      const { statSync, openSync, readSync, closeSync, copyFileSync, rmSync } = require('node:fs') as typeof import('node:fs')
      let st: import('node:fs').Stats
      try { st = statSync(probe) } catch { clipBaselined = true; onDone?.(false, false); return } // no file = no image on the clipboard — baseline trivially done
      if (!st.size) { clipBaselined = true; onDone?.(false, false); return }
      const head = Buffer.alloc(Math.min(4096, st.size))
      const fd = openSync(probe, 'r')
      readSync(fd, head, 0, head.length, 0)
      closeSync(fd)
      const md5 = require('node:crypto').createHash('md5').update(head).digest('hex') as string
      const sig = `${st.size}:${md5}`
      if (knownClipSigs.has(sig)) { clipBaselined = true; onDone?.(true, false); return }
      knownClipSigs.add(sig)
      clipBaselined = true
      if (markOnly) { onDone?.(true, false); return } // baseline: pre-dictation image learned, never attached
      const dest = join(STAGING_DIR, `capture-${Date.now()}-clipboard.png`)
      copyFileSync(probe, dest)
      try { rmSync(probe, { force: true }) } catch { /* next probe overwrites anyway */ }
      stagedAttachments.push({ path: dest, auto: true })
      clipStagedThisCapture = true
      broadcastStaged()
      log.event('capture-staged', { file: dest, via: 'clipboard-probe' })
      onDone?.(true, true)
    } catch { onDone?.(false, false) /* probe unreadable — skip */ }
  })
}

/** Key-lift: secure any last clipboard screenshot, then — if this capture
 *  consumed clipboard images — CLEAR the clipboard. Transcription (1-3s) gives
 *  the clear ages to propagate, so the TEXT paste later races against an empty,
 *  long-settled pasteboard = the ancient fast path that never failed. We only
 *  clear what we delivered: a pre-dictation image we never staged is left alone. */
function secureAndClearClipboard(): void {
  if (settings.get('screenshotCapture') === false) return
  // If the baseline never completed this capture, this probe is LEARN-ONLY: an
  // image of unknown provenance (could predate the trigger) must not attach.
  probeClipboardViaChild(!clipBaselined, (sawImage, stagedNew) => {
    if (sawImage && (stagedNew || clipStagedThisCapture)) {
      try {
        const { clipboard } = require('electron') as typeof import('electron')
        clipboard.clear()
        log.event('clipboard-cleared-after-consume', {})
      } catch { /* best-effort */ }
    }
  })
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
  if (stagedAttachments.length >= getKnobs().captureMaxAuto) return
  try {
    mkdirSync(STAGING_DIR, { recursive: true })
    const file = join(STAGING_DIR, `capture-${Date.now()}-${tag}.png`)
    writeFileSync(file, buf)
    stagedAttachments.push({ path: file, auto: true })
    broadcastStaged()
    log.event('capture-staged', { file, via: tag })
  } catch (e) { log.warn('stageBuffer failed', { error: (e as Error).message }) }
}

/** Stage screenshot FILES newer than `sinceMs`. Scans the system screenshot
 *  location PLUS common user arrangements (a Screenshots subfolder on the
 *  Desktop / in the location). Inside a dedicated Screenshots folder any image
 *  counts; elsewhere only Screenshot-named files (never random Desktop pngs). */
function stageRecentScreenshotFiles(sinceMs: number): void {
  const { readdirSync, statSync } = require('node:fs') as typeof import('node:fs')
  const base = screenshotDir()
  const dirs = [
    { dir: base, anyImage: false },
    { dir: join(base, 'Screenshots'), anyImage: true },
    { dir: join(homedir(), 'Desktop', 'Screenshots'), anyImage: true },
  ]
  for (const { dir, anyImage } of dirs) {
    let entries: string[]
    try { entries = readdirSync(dir) } catch { continue }
    let matched = 0
    for (const entry of entries) {
      if (stagedAttachments.length >= getKnobs().captureMaxAuto) break
      if (!/\.(png|jpe?g)$/i.test(entry)) continue
      if (!anyImage && !/^screen ?shot/i.test(entry)) continue
      const full = join(dir, entry)
      try {
        const st = statSync(full)
        if (st.mtimeMs > sinceMs && !stagedAttachments.some((s) => s.path === full)) {
          matched++
          stagedAttachments.push({ path: full, auto: true }) // reference in place — never copy/move user files
          broadcastStaged()
          log.event('capture-staged', { file: full, via: 'file' })
        }
      } catch { /* skip */ }
    }
    if (matched) log.event('capture-sweep', { dir, matched, sinceMs })
  }
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
  if (settings.get('screenshotCapture') === false) return // feature off — never touch screenshots
  captureWatchGen++
  if (captureWatchTimer) clearInterval(captureWatchTimer)
  const startedAt = Date.now()
  pendingClipboardCount = 0
  clipStagedThisCapture = false
  // CLEAR-FIRST (the lifecycle rule's backstop): any auto-captured screenshot
  // still in the tray belongs to a PREVIOUS window that ended without
  // delivering — it must never ride this one.
  purgeAutoStaged('new-capture-window')
  log.event('capture-watch-start', { dir: screenshotDir() })
  // DURING-DICTATION ONLY (the whole idea): what existed before key-down never
  // attaches. Baseline probe LEARNS the pre-existing clipboard image (markOnly);
  // file sweeps start from startedAt. Zero main-thread image work while
  // recording — the osascript child does all pasteboard reads (the ONLY reader;
  // a second reader with a different PNG encoder is what duplicated pastes).
  clipBaselined = false
  probeClipboardViaChild(true)
  captureWatchTimer = setInterval(() => {
    stageRecentScreenshotFiles(startedAt)
    // Staging unlocks only once a baseline has COMPLETED for this window; until
    // then each tick retries the baseline (learn-only) instead.
    probeClipboardViaChild(!clipBaselined)
  }, 900)
  ;(captureWatchTimer as { unref?: () => void }).unref?.()
}


/** Kill every AUTO-captured screenshot in the tray (files we copied into our
 *  own staging dir are deleted; referenced user files are only de-listed).
 *  THE lifecycle rule: an ambient screenshot lives from capture-start to
 *  delivery — a window that ends without delivering forfeits its captures.
 *  Explicit paste/drop stages are deliberate and survive (tray design). */
function purgeAutoStaged(reason: string): void {
  const auto = stagedAttachments.filter((s) => s.auto)
  if (!auto.length) return
  stagedAttachments = stagedAttachments.filter((s) => !s.auto)
  for (const { path } of auto) {
    // Only ever delete OUR copies — a swept Desktop screenshot is the user's file.
    if (path.startsWith(STAGING_DIR)) {
      try { (require('node:fs') as typeof import('node:fs')).rmSync(path, { force: true }) } catch { /* best-effort */ }
    }
  }
  log.event('auto-staged-purged', { count: auto.length, reason })
  broadcastStaged()
}

function stopCaptureWatch(opts: { purgeAuto?: boolean } = {}): void {
  if (captureWatchTimer) { clearInterval(captureWatchTimer); captureWatchTimer = null }
  pendingClipboardCount = 0
  // A window closing WITHOUT delivery forfeits its auto-captures (discard,
  // cancel, empty transcript, the 20s safety stop). The delivery path calls
  // with purgeAuto:false because takeStaged() is about to take everything.
  if (opts.purgeAuto) purgeAutoStaged('watch-closed-undelivered')
  broadcastStaged()
}

/** Dictation delivery seam (clipboard.ts calls this after pasting the text):
 *  hand over everything staged and close the watch window. The ledger's contract
 *  holds across BOTH capture kinds — what the pill showed is what got delivered. */
/**
 * Hide the native input surface, whatever the renderer thinks its state is.
 *
 * THE DOM PILL NEVER NEEDED THIS. It lived inside the HUD window, so
 * hideHUD() removed it from the screen regardless of the React state machine —
 * and that state machine does NOT reach a terminal state on every path. The
 * remote one is the clearest case: sessionManager sends 'remote:dispatched'
 * and schedules the hide, and NOTHING in the widget handles that event, so the
 * renderer sits on 'processing' forever. Invisible while the window was doing
 * the hiding; permanent once the pill moved into its own Swift window.
 *
 * So the pill is hidden by the same authority that hides the window, at the
 * same moments. Every scheduleAutoHide and every direct hideHUD in
 * sessionManager funnels through here — which matters, because there are more
 * than twenty of them (timeouts, cancels, undo expiry, quiet-miss, engine
 * failures) and the renderer only models a subset.
 */
export function hideNativePill(): void {
  pillController?.hide()
}

export function consumeStagedForDictation(): string[] {
  stopCaptureWatch({ purgeAuto: false }) // delivery: takeStaged() takes it all
  return takeStaged()
}
/** Consume the tray (one landing takes everything). */
function takeStaged(): string[] {
  if (!stagedAttachments.length) return []
  const taken = stagedAttachments.map((s) => s.path)
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
  speakLine(`${name} ${label}`)
}

/** Speak one line aloud (serialized; silent while the user is mid-capture).
 *  Shared by the doorbell and the 'speak' router verb. */
function speakLine(text: string): void {
  const line = text.trim().slice(0, 500)
  if (!line) return
  sayChain = sayChain.then(() => new Promise<void>((resolve) => {
    if (captureBusy) { resolve(); return } // the user is speaking — stay silent
    try { execFile('say', [line], () => resolve()) } catch { resolve() }
  })).catch(() => {})
}

/** Compose + speak the answer to a 'speak' meta-command — DETERMINISTIC string
 *  building from the task map, zero LLM in the speech path. The router only
 *  picked the target; the data (question/state/context) is already here. */
function speakAbout(taskId: string | undefined): void {
  if (!manager) return
  if (taskId) {
    const t = manager.get(taskId)
    if (!t) { speakLine('That task is gone.'); return }
    const name = (t.name || t.intent || 'the task').slice(0, 60)
    if (t.question?.text) {
      let line = `${name} asks: ${t.question.text.slice(0, 280)}`
      const choices = t.question.choices ?? []
      if (choices.length) line += '. ' + choices.map((c, i) => `Option ${i + 1}: ${c}`).join('. ')
      speakLine(line)
    } else if (t.state === 'processing') {
      speakLine(`${name} is working. ${t.step ? t.step : t.threadContext ?? ''}`)
    } else if (t.state === 'failed' || t.state === 'stuck') {
      speakLine(`${name} ${t.state === 'stuck' ? 'is stuck' : 'errored'}. ${t.error?.reason ?? ''}`)
    } else if (t.state === 'ready') {
      speakLine(`${name} is ready for your next step. ${t.result?.summary ?? t.threadContext ?? ''}`)
    } else {
      speakLine(`${name} is done. ${t.result?.summary ?? t.threadContext ?? ''}`)
    }
    return
  }
  // Overall status — one glanceable sentence.
  const all = manager.list()
  const needs = all.filter((t) => t.state === 'needs-user' || t.state === 'failed' || t.state === 'stuck')
  const working = all.filter((t) => t.state === 'processing')
  if (!needs.length && !working.length) { speakLine('All clear. Nothing running.'); return }
  const parts: string[] = []
  if (needs.length) {
    const first = needs[0]
    parts.push(`${needs.length} need${needs.length === 1 ? 's' : ''} you — ${(first.name || first.intent).slice(0, 50)}${first.question?.text ? `, asking: ${first.question.text.slice(0, 120)}` : ''}`)
  }
  if (working.length) parts.push(`${working.length} working`)
  speakLine(parts.join('. '))
}

// ── The acknowledgment beat (the addiction dashboard's first number): every
// voice dispatch ends in ONE terse spoken confirmation — "On it", "Passed to
// X", "Queued for X" — or an honest "That didn't land." NEVER silence: a
// spoken utterance that vanishes without a trace is the single worst event in
// the product (it poisons the press-and-forget reflex itself). The inner
// routing sets the beat per branch; '' means deliberately silent (speak verb
// answers for itself; a focused stage is already being watched). Spoken via
// speakLine ⇒ serialized + gated by the same doorbell toggle.
let pendingBeat: string | null = null

// ── The Unmute MCP (the intercom) ─────────────────────────────────────────
// Sessions may ADD work to the attention layer, never TOUCH it (see
// mcp-server.ts). Identity = a per-task bearer token injected into every
// Unmute-spawned session's environment; it maps back to the task, which is
// what makes provenance, depth-1 and rate caps enforceable.
const mcpTokens = new Map<string, string>() // token -> taskId
const mcpSpawnLedger = new Map<string, { count: number; lastAt: number }>() // caller taskId -> rate state
// MCP spawn rate caps — runtime-configurable via getKnobs().mcpMaxSpawnsPerTask
// / .mcpMinSpawnGapMs (read at enforcement so a live update applies).

/** Issue the per-task intercom identity (env for the spawned session). The
 *  taskId isn't known until dispatch returns, so tokens are minted against a
 *  unique placeholder and remapped to the real id right after. */
function mintMcpEnvFor(placeholder: string): Record<string, string> {
  const token = randomUUID()
  mcpTokens.set(token, placeholder)
  return { UNMUTE_MCP_TOKEN: token, UNMUTE_MCP_URL: `http://127.0.0.1:${getKnobs().mcpPort}${MCP_PATH}` }
}
function remapMcpToken(placeholder: string, taskId: string): void {
  for (const [tok, tid] of mcpTokens) if (tid === placeholder) mcpTokens.set(tok, taskId)
}

/** Locate a Claude session transcript anywhere in ~/.claude/projects and make
 *  sure a copy exists in the TARGET cwd's slug — a fork can only resume a
 *  session the target directory can see. */
async function stageForkSource(sessionIdToFork: string, targetCwd: string): Promise<boolean> {
  const { promises: fsp } = await import('node:fs')
  const projectsDir = join(homedir(), '.claude', 'projects')
  const targetSlug = targetCwd.replace(/[/.]/g, '-')
  const targetDir = join(projectsDir, targetSlug)
  const targetFile = join(targetDir, `${sessionIdToFork}.jsonl`)
  if (existsSync(targetFile)) return true
  try {
    for (const d of await fsp.readdir(projectsDir)) {
      const candidate = join(projectsDir, d, `${sessionIdToFork}.jsonl`)
      if (existsSync(candidate)) {
        await fsp.mkdir(targetDir, { recursive: true })
        await fsp.copyFile(candidate, targetFile)
        log.event('mcp-fork-source-staged', { sessionId: sessionIdToFork, targetSlug })
        return true
      }
    }
  } catch (e) {
    log.warn('mcp fork-source staging failed', { error: (e as Error).message })
  }
  return false
}

async function mcpCreateTask(callerTaskId: string, input: McpCreateTaskInput): Promise<{ task_id: string; name?: string; note?: string }> {
  if (!manager) throw new Error('Unmute Remote is not initialized')
  if (settings.get('agentTasksEnabled') === false) throw new Error('agent-created tasks are disabled in Unmute settings')
  const caller = manager.get(callerTaskId)
  if (!caller) throw new Error('calling task no longer exists')
  // DEPTH-1: an agent-spawned task may not spawn (no colonies).
  if (caller.spawnedBy) throw new Error('depth limit: agent-created tasks cannot themselves create tasks — ask the user to dispatch it')
  // RATE: bounded fan-out per task.
  const ledger = mcpSpawnLedger.get(callerTaskId) ?? { count: 0, lastAt: 0 }
  const { mcpMaxSpawnsPerTask, mcpMinSpawnGapMs } = getKnobs()
  if (ledger.count >= mcpMaxSpawnsPerTask) throw new Error(`rate limit: this task already created ${ledger.count} tasks (max ${mcpMaxSpawnsPerTask})`)
  if (Date.now() - ledger.lastAt < mcpMinSpawnGapMs) throw new Error('rate limit: wait a few seconds between task creations')
  // Validate dir (same fail-safe semantics as voice dispatch: bad dir → scratch
  // would be surprising for an explicit request, so reject instead).
  if (input.dir && !existsSync(input.dir)) throw new Error(`dir does not exist: ${input.dir}`)
  let note: string | undefined
  let forkFrom = input.fork_from_session_id
  if (forkFrom) {
    const staged = await stageForkSource(forkFrom, input.dir ?? '')
    if (!input.dir) { throw new Error('fork_from_session_id requires dir (the fork must resume inside a specific project directory)') }
    if (!staged) { note = `fork source ${forkFrom} not found — started a fresh session instead`; forkFrom = undefined }
  }

  ledger.count++; ledger.lastAt = Date.now()
  mcpSpawnLedger.set(callerTaskId, ledger)

  // Identity env is injected by the dispatch wrapper (initRemote) — every
  // Unmute-spawned session gets one, agent-spawned or not.
  const newId = await manager.dispatch(input.intent, {
    kind: input.kind ?? 'oneoff',
    cwd: input.dir,
    spawnedBy: callerTaskId,
    forkFromSessionId: forkFrom,
  })
  if (input.name) manager.setName(newId, input.name.slice(0, 48))
  if (forkFrom) setTimeout(() => { void manager?.adoptForkSessionId(newId, forkFrom!) }, 8000)
  log.event('mcp-task-created', { by: callerTaskId, child: newId, kind: input.kind ?? 'oneoff', forked: !!forkFrom })
  return { task_id: newId, name: input.name, note }
}

async function mcpTaskStatus(callerTaskId: string, taskId: string): Promise<Record<string, unknown>> {
  if (!manager) throw new Error('Unmute Remote is not initialized')
  const t = manager.get(taskId)
  if (!t || t.spawnedBy !== callerTaskId) throw new Error('unknown task (you can only view tasks you created)')
  return {
    task_id: t.id,
    name: t.name ?? null,
    state: t.state,
    summary: t.result?.summary ?? null,
    error: t.error?.reason ?? null,
    question: t.question?.text ?? null,
  }
}

/** Invokable skill names the router may reference (explicit "use my X skill" or
 *  skill_feedback): ~/.claude/skills folders + loose .md files — the /name set.
 *  A cheap disk walk; called per routed utterance (freshness over caching). */
async function listClaudeSkillNames(): Promise<string[]> {
  const dir = join(homedir(), '.claude', 'skills')
  const names: string[] = []
  for (const entry of await fs.readdir(dir).catch(() => [] as string[])) {
    if (entry.startsWith('.')) continue
    names.push(entry.replace(/\.md$/, ''))
  }
  return names
}

export async function dispatchFromCapture(rawTranscript: string): Promise<string | null> {
  // Observe the routing phase for the wall's listening surface — the dispatch
  // logic itself (the inner function) is untouched. `finally` guarantees the
  // surface always returns to idle, whatever path the dispatch takes.
  broadcastCapturePhase('routing')
  pendingBeat = null
  let landed: string | null = null
  try {
    landed = await dispatchFromCaptureInner(rawTranscript)
    return landed
  } finally {
    broadcastCapturePhase('idle', landed)
    // Speak AFTER the phase returns to idle (captureBusy released) so the beat
    // can't be dropped by the talking-over-the-user guard.
    const beat = pendingBeat !== null ? pendingBeat : landed ? 'On it.' : 'That didn\u2019t land.'
    if (beat) speakLine(beat)
    pendingBeat = null
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
      pendingBeat = '' // the stage is on screen — the beat would be noise
      return fid
    }
    typeStagedInto(fid, staged)
    if (manager.followUp(fid, text)) {
      log.event('routed-to-focus', { taskId: fid, kind: 'continue' })
      pendingBeat = ''
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
  // EITHER router will do — a Codex-only user has no Claude REPL, and gating on
  // `router` alone would skip routing entirely for them (the old behaviour, and
  // the reason their utterances fell to failsafeDecision).
  if (router || codexRouter) {
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
      const { targetable, coldSessions } = partitionRoutable(nowMs)
      // THE WALL for curation: everything the user can currently SEE (mirrors
      // the renderer's visibleOnWall: non-shelved sessions always; active
      // states; recent finishes). Curation references resolve against what's
      // on screen — a wall the router can't see caused the first field bug
      // (a curation command misrouted into a junk task, 2026-07-16).
      const DONE_FADE_MS = 15 * 60_000
      const ATTN_FADE_MS = 60 * 60_000
      const wall = manager.list().filter((t) => {
        if (t.shelved) return false
        if ((t.kind ?? 'oneoff') === 'session') return true
        if (t.state === 'processing' || t.state === 'needs-user' || t.state === 'ready') return true
        const age = nowMs - t.updatedAt
        return t.state === 'done' ? age < DONE_FADE_MS : age < ATTN_FADE_MS
      }).map((t) => snapshotOf(t, nowMs, false))
      // The user's skills (names only) — lets the router honor an explicit
      // "use my X skill" (prefixes the intent below) and record skill_feedback.
      const skillNames = await listClaudeSkillNames()
      // What can actually run a task RIGHT NOW. Availability is dynamic (Codex
      // may be closed or unarmed), and the router may only ever name a backend
      // that appears here — so a task can never be promised to an app the user
      // doesn't have. Probing is cheap: a HEAD on the CDP port plus a DOM read.
      const avail = await agentAvailability()

      // ROUTE ON THE PICKER'S BACKEND, AND SHOW THAT ROUTER ONLY ITS OWN WORK.
      //
      // Two independent guarantees, and both matter:
      //
      //   * the ENGINE is one the user actually has — a Codex-only user used to
      //     get no router at all, because routeOnce spawned a Claude REPL,
      //     threw, and fell to failsafeDecision (a new task per utterance, raw
      //     transcript, no targeting or naming);
      //   * the SNAPSHOT is scoped, so a router cannot name a task belonging to
      //     the other backend. That is the cross-provider bleed that sent a
      //     resume decision for a Codex thread into `claude --continue`.
      //
      // The picker governs NEW work. Continuing existing work still follows the
      // task's own backend at dispatch (see TaskManager.resume / followUp) — so
      // scoping here narrows what can be PROPOSED, never where a chosen task runs.
      // Prefer the picker's engine; fall back to whichever exists, because one of
      // the two may legitimately be absent (no Claude CLI, or no Codex app).
      const useCodex = (avail.preferred === 'codex-desktop' || !router) && !!codexRouter
      const activeRouter = useCodex ? codexRouter! : router!
      const mine = (t: RoutableTask) =>
        (t.agent ?? 'claude') === (useCodex ? 'codex-desktop' : 'claude')
      log.event('router-selected', {
        engine: useCodex ? 'codex' : 'claude',
        preferred: avail.preferred,
        tasks: targetable.filter(mine).length,
        hidden: targetable.length - targetable.filter(mine).length,
      })
      const decision = await activeRouter.route(
        raw,
        targetable.filter(mine),
        projects,
        finished.filter(mine),
        coldSessions.filter(mine),
        wall.filter(mine),
        skillNames,
        avail,
      )
      // Phase timing: how long the utterance spent in the router (warm → decision).
      log.event('phase-timing', { phase: 'router', ms: Date.now() - tRoute, action: decision.action })
      // Explicit-skill prefix: when the user named a skill, prefix the
      // dispatched/injected intent with `/name ` (trailing space per preflight —
      // it dismisses the autocomplete so the user's Enter submits). Only ever set
      // on a WORK decision (new/continue/resume); undefined for speak/curate.
      const withSkill = (t: string): string => decision.skill ? `/${decision.skill} ${t}` : t
      if (decision.action === 'continue' && decision.targetTaskId) {
        const tid = decision.targetTaskId
        // CONSENT GUARD (layer 3 of 3 — parse validation should make this
        // unreachable): never auto-inject into a cold persistent session.
        const target = manager.get(tid)
        const targetHot = (target?.lastUserInputAt ?? 0) > Date.now() - getKnobs().hotThreadMs
        if (target && (target.kind ?? 'oneoff') === 'session' && target.state !== 'needs-user' && !targetHot) {
          log.warn('consent guard: refused continue into cold session — dispatching new', { taskId: tid })
        } else {
          // Continuing a BLOCKED task means piping the utterance in as its answer;
          // continuing a live task means a fresh follow-up turn.
          const targetName = (target?.name || target?.intent || 'it').slice(0, 50)
          if (awaitingIds.has(tid)) {
            log.event('routed-as-answer', { taskId: tid, via: 'router' })
            typeStagedInto(tid, staged)
            manager.answer(tid, withSkill(decision.intent || raw))
            // Assign-once grouping: the router may group the task it acted on,
            // never regroup one that already has a group (freeze).
            if (decision.group && !target?.group) manager.setGroup(tid, decision.group)
            pendingBeat = `Passed to ${targetName}.`
            return tid
          }
          const targetBusy = target?.state === 'processing' // mid-turn — the follow-up will queue
          typeStagedInto(tid, staged)
          if (manager.followUp(tid, withSkill(decision.intent))) {
            log.event('routed-as-continuation', { taskId: tid, via: 'router' })
            // Assign-once grouping — covers graduation too: a one-off's 2nd
            // follow-up (which just promoted it to a session inside followUp)
            // gets its group in the same routed turn. Zero extra LLM calls.
            if (decision.group && !target?.group) manager.setGroup(tid, decision.group)
            pendingBeat = targetBusy
              ? `Queued for ${targetName} — it\u2019s mid-task, I\u2019ll pass it on when it\u2019s free.`
              : `Passed to ${targetName}.`
            return tid
          }
        }
      }
      // CURATE (wall organization): the user spoke about the wall itself —
      // "group these two as X", "rename that group". Nothing is spawned or
      // injected; ops were hard-validated at parse (known ids, live groups).
      // Sessions still cannot touch the wall — this path exists only for the
      // user's own routed voice commands (the MCP invariant stands).
      if (decision.action === 'curate' && decision.ops?.length) {
        let touched = 0
        const groupNames = new Set<string>()
        for (const op of decision.ops) {
          if (op.op === 'set_group') {
            for (const id of op.taskIds) { manager.setGroup(id, op.group); touched++ }
            groupNames.add(op.group)
          } else if (op.op === 'rename_group') {
            touched += manager.renameGroup(op.from, op.to)
            groupNames.add(op.to)
          }
        }
        log.event('routed-as-curate', { ops: decision.ops.length, touched })
        pendingBeat = touched ? `Regrouped — ${[...groupNames].join(', ')}.` : 'Nothing matched that.'
        return null
      }
      // SPEAK (meta-command): the user asked to HEAR something — read-only,
      // nothing spawned, nothing injected. Speech is composed deterministically
      // from the task map; the router only chose the target.
      if (decision.action === 'speak') {
        log.event('routed-as-speak', { taskId: decision.targetTaskId ?? null })
        speakAbout(decision.targetTaskId)
        pendingBeat = '' // the spoken answer IS the acknowledgment
        return null
      }
      // SKILL FEEDBACK (meta-command): the user gave feedback ABOUT a listed
      // skill's behavior — nothing is spawned or injected. If it's a skill the
      // curator MANAGES, record it against that skill's next review; otherwise
      // say so plainly. (The router only sets this with a known-listed skill.)
      if (decision.action === 'skill_feedback' && decision.skill) {
        const managed = ownedSkillNames(await readOwnership(curatorPathsV)).has(decision.skill)
        if (managed) {
          await appendFeedback(curatorPathsV, { at: new Date().toISOString(), skill: decision.skill, note: decision.intent })
          log.event('routed-as-skill-feedback', { skill: decision.skill, managed: true })
          speakLine("Noted — I'll factor that into the skill's next review.")
        } else {
          log.event('routed-as-skill-feedback', { skill: decision.skill, managed: false })
          speakLine("Noted, but that skill isn't one I manage.")
        }
        pendingBeat = '' // the spoken acknowledgment stands on its own
        return null
      }
      // RESUME-ROUTING: the utterance follows up a recently-finished one-off
      // (≤15min, capped). Revive that exact session (`--continue` restores its
      // full context), then deliver — the thread literally continues on its own
      // card. Failure falls through to a safe new task; the utterance is never
      // lost.
      if (decision.action === 'resume' && decision.targetTaskId) {
        const tid = decision.targetTaskId
        log.event('routed-as-resume', { taskId: tid, via: 'router' })
        try {
          if (await manager.resume(tid)) {
            typeStagedInto(tid, staged) // images + words submit as one message
            if (manager.followUp(tid, withSkill(decision.intent || raw))) {
              pendingBeat = `Continuing ${(manager.get(tid)?.name || 'it').slice(0, 50)}.`
              return tid
            }
          }
          log.warn('resume-routing failed — falling through to new task', { taskId: tid })
        } catch (e) {
          log.warn('resume-routing threw — falling through to new task', { taskId: tid, error: (e as Error).message })
        }
      }
      // The user's raw override (pill/Remote screen) forces RAW regardless of
      // the router's pick — a clean Claude Code session with no Unmute injection.
      const forcedRaw = injectionDisabled()
      const mode = forcedRaw ? 'raw' as const : decision.mode
      log.event('routed-as-new', { via: 'router', surface: decision.surface ?? null, mode: mode ?? null, forcedRaw, kind: decision.kind ?? null, dir: decision.dir ?? null })
      // RECALL pointer (§6.6): the command asks about another task's work — hand
      // the new task that task's ACTUAL record (status + Claude transcript) so it
      // reads ground truth instead of guessing. Read-only; works for any known
      // task including cold sessions (hearing about one is not injecting into it).
      let intentText = withSkill(decision.intent || raw)
      if (decision.contextTaskId) {
        const ctx = manager.get(decision.contextTaskId)
        if (ctx) {
          const transcript = join(homedir(), '.claude', 'projects', projectSlug(ctx.cwd), `${ctx.sessionId}.jsonl`)
          intentText += `\n[This refers to a previous task: "${(ctx.name || ctx.intent).slice(0, 80)}". Read its record before answering — status: ${ctx.statusPath}${existsSync(transcript) ? ` — full transcript: ${transcript}` : ''}. Answer from what it actually did, not from assumption.]`
          log.event('recall-pointer-attached', { contextTaskId: decision.contextTaskId, transcript: existsSync(transcript) })
        }
      }
      // Backend selection: the user's spoken choice wins, else their picker
      // default. `resolveAgent` also degrades gracefully — if Codex went away
      // between the probe and the dispatch, the task lands on Claude with a log
      // rather than throwing in the user's face mid-sentence.
      const chosenAgent = await resolveAgent(decision.agent, avail)
      const newId = await manager.dispatch(intentWithStaged(intentText, staged), {
        surface: decision.surface, mode, kind: decision.kind, cwd: decision.dir,
        agent: chosenAgent,
        ...(chosenAgent === 'codex-desktop' ? { project: decision.codexProject ?? null } : {}),
      })
      // The router minted the display name in the same turn — instant, no extra
      // call. (The completeFn-based nameIntent below stays as the non-router path.)
      if (decision.name) manager.setName(newId, decision.name)
      // Group new PERSISTENT sessions at birth (one-offs stay ungrouped until
      // they graduate — the wall groups streams, not errands).
      if (decision.group && decision.kind === 'session') manager.setGroup(newId, decision.group)
      pendingBeat = decision.name ? `On it \u2014 ${decision.name}.` : 'On it.'
      // Declinable offer (§6.2 — never a silent reroute, never a blocking prompt):
      // the router chose NEW but seriously weighed one open task. Surface a
      // one-tap "or send it there?"; ignoring it costs nothing.
      if (decision.alternate && manager.get(decision.alternate)) {
        pendingRouteOffer = { newTaskId: newId, altTaskId: decision.alternate, intent: decision.intent || raw, at: Date.now() }
        const altName = manager.get(decision.alternate)!.name ?? manager.get(decision.alternate)!.intent
        for (const w of BrowserWindow.getAllWindows()) {
          if (!w.isDestroyed()) w.webContents.send('remote:route-offer', { newTaskId: newId, altTaskId: decision.alternate, altName })
        }
        notchController?.notifyRouteOffer({ newTaskId: newId, altTaskId: decision.alternate, altName })
        log.event('route-offer-surfaced', { newTaskId: newId, altTaskId: decision.alternate })
      }
      return newId
    } catch (e) {
      const msg = (e as Error).message
      // HARD SEPARATION. This failsafe exists for ROUTING failures (timeout,
      // unparseable decision) where starting a plain task is the safe move. It
      // must NEVER re-dispatch a task whose backend was already chosen: doing so
      // silently moved a Codex task onto Claude Code and ran the user's work
      // twice, on an agent they did not pick (2026-07-25). A backend failure is
      // a FAILED TASK on that backend, never a task somewhere else.
      if (msg.startsWith('CODEX_UNAVAILABLE') || msg.startsWith('AGENT_SEPARATION_VIOLATION')) {
        log.error('backend failure — NOT falling back to another agent', { error: msg })
        speakLine('Codex could not take that task.')
        return null
      }
      log.warn('router error — dispatching new', { error: msg })
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

// Librarian PARKED (skill-curator spec §12): no librarian sessions spawn — the
// curator supersedes it. Code + recipes stay on disk; flip to false to revive.
const LIBRARIAN_PARKED = true

export function initRemote(deps: RemoteInitDeps): TaskManager {
  if (manager) return manager

  // DEV-ONLY curator diagnostics gate — set VERY EARLY, before the Curator is
  // constructed. An UNPACKAGED dev/test run auto-enables comprehensive curator
  // logging (engine reasoning + full UX timeline). A PACKAGED public build never
  // sets it, so it stays off (privacy: the logs hold session transcripts +
  // reasoning) — a developer can still opt in by exporting the var explicitly.
  // Fail-safe-off: devLogEnabled() checks === '1', so `||=` only fills a blank.
  if (!app.isPackaged) process.env.UNMUTE_CURATOR_DEVLOG ||= '1'

  // Adopt the user's real login-shell PATH FIRST. A Finder/Dock-launched app
  // gets a minimal PATH without ~/.local/bin etc., so `claude` isn't found and
  // sessions die at 0s. Sessions spawn with env: process.env, so this fixes them
  // all. Must run before claudeMcpList() / any spawn below.
  fixPath()

  // Runtime config: load the compiled floor ⊕ disk cache ⊕ optional local
  // override synchronously (instant boot), then refresh from our hosted config
  // in the BACKGROUND (non-blocking) + a slow 6h timer. Everything below reads
  // effective values via getModels()/getKnobs()/getPrompts(). Must run before
  // any of those reads (executor factories, snapshots, MCP caps, TaskManager).
  initRuntimeConfig({ userDataDir: app.getPath('userData'), autoRefresh: true })

  const logDir = join(homedir(), '.unmute', 'remote', 'logs')
  const runId = String(Date.now())
  const logFile = configureRemoteLogging({ dir: logDir, runId })
  log.event('init-remote', { logFile, permissionMode: settings.get('permissionMode') })

  // Staging hygiene: clipboard screenshots are WRITTEN to the staging dir (file
  // screenshots are only referenced, never copied) and can't be deleted at send
  // time — a Remote session may read the path minutes later. Age-sweep instead:
  // anything older than 48h goes, once per launch. Keeps the disk honest.
  try {
    const { readdirSync, statSync, rmSync } = require('node:fs') as typeof import('node:fs')
    const cutoff = Date.now() - 48 * 3600_000
    let swept = 0
    for (const entry of readdirSync(STAGING_DIR)) {
      const full = join(STAGING_DIR, entry)
      try { if (statSync(full).mtimeMs < cutoff) { rmSync(full, { force: true }); swept++ } } catch { /* skip */ }
    }
    if (swept) log.event('staging-swept', { swept })
  } catch { /* staging dir doesn't exist yet — fine */ }

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
    const model = getModels().librarian
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
  // The Codex desktop backend. Constructed unconditionally (it is inert until a
  // task actually targets it) so availability can be probed for the picker even
  // when the user has never used Codex.
  codexDriver = new CodexDesktopDriver({})
  manager = new TaskManager({
    executorFactory,
    codexDriver,
    // Read fresh per dispatch: the Codex composer's permission level is set from
    // the SAME user setting that decides --dangerously-skip-permissions for
    // Claude, so the two backends behave alike (capped by what the device
    // actually offers — see codex/approval.ts).
    permissionMode: () => (settings.get('permissionMode') === 'auto-approve' ? 'auto-approve' : 'ask'),
    // Read fresh per dispatch, and only what the user actually chose — an
    // absent value means "leave Codex on whatever it is set to".
    codexReasoning: () => ({
      model: (settings.get('codexModel' as never) as string) || undefined,
      effort: (settings.get('codexEffort' as never) as string) || undefined,
      speed: (settings.get('codexSpeed' as never) as string) || undefined,
    }),
    // PARKED: withholding the librarian trips the `!this.opts.librarian` gate in
    // handToLibrarian, so no session is ever spawned. (§12)
    librarian: LIBRARIAN_PARKED ? undefined : librarian,
    // Behavioral knobs from runtime config (Tier B) — read once at construction.
    // A live update takes effect on the next relaunch (lifecycle timers are set
    // at construction); the values still ratchet forward via the cache.
    staleMs: getKnobs().taskStaleMs,
    warmMs: getKnobs().taskWarmMs,
    navigateWarmMs: getKnobs().taskNavigateWarmMs,
    purgeAgeMs: getKnobs().taskPurgeAgeMs,
    readyDecayMs: getKnobs().readyDecayMs,
    // Best-effort reaper for an orphan tmux session a past run left on our
    // private socket (app crashed before killAll). Per-session kill, never the
    // server (would hit live ones).
    reapSession: (id) => {
      if (!tmuxBin) return
      try { execFile(tmuxBin, tmuxKillSessionArgs(sessionNameFor(id)), () => {}) } catch { /* best-effort */ }
    },
  })
  // ── The Unmute MCP: identity injection + server + registration ──
  // Every dispatched session gets a per-task intercom identity. Wrapping
  // dispatch here (rather than teaching TaskManager about MCP) keeps the
  // lifecycle layer MCP-free and catches every dispatch path — voice, UI,
  // and agent-created alike.
  {
    const origDispatch = manager.dispatch.bind(manager)
    manager.dispatch = (intent, opts = {}) => {
      const placeholder = `pending-${randomUUID()}`
      const env = mintMcpEnvFor(placeholder)
      return origDispatch(intent, { ...opts, extraEnv: { ...env, ...(opts.extraEnv ?? {}) } })
        .then((id) => { remapMcpToken(placeholder, id); return id })
    }
  }
  void startMcpServer({
    resolveCaller: (token) => {
      if (!token) return null
      const tid = mcpTokens.get(token)
      return tid && !tid.startsWith('pending-') ? tid : null
    },
    createTask: mcpCreateTask,
    taskStatus: mcpTaskStatus,
  }, getKnobs().mcpPort).catch((e) => log.warn('mcp server not started', { error: (e as Error).message }))
  // Register the server in the user's Claude Code config (idempotent). The
  // header uses env expansion so each session presents ITS OWN token.
  execFile('claude', ['mcp', 'get', 'unmute'], { timeout: 10_000 }, (err) => {
    if (!err) return // already registered
    const cfg = JSON.stringify({ type: 'http', url: `http://127.0.0.1:${getKnobs().mcpPort}${MCP_PATH}`, headers: { Authorization: 'Bearer ${UNMUTE_MCP_TOKEN}' } })
    execFile('claude', ['mcp', 'add-json', 'unmute', cfg, '--scope', 'user'], { timeout: 15_000 }, (e2, _o, stderr2) => {
      if (e2) log.warn('mcp registration failed', { error: String(stderr2 || e2.message) })
      else log.event('mcp-registered-user-scope', {})
    })
  })

  // ── Computer Use v2: cua-driver, EMBEDDED. Unmute (this process — the
  // signed .app) is the DIRECT SPAWNER of every driver child, so each child
  // runs inside Unmute's TCC responsibility chain and inherits its
  // Accessibility + Screen Recording grants. A Claude-Code-spawned stdio
  // server would inherit the TERMINAL's identity and silently have no grants
  // (cua EMBEDDING.md's hard rule) — that spawn must never move out of here.
  // The bridge keeps v1's port/path/name, so existing registrations just work.
  const driverBin = process.env.CUA_DRIVER_PATH
    || (app.isPackaged
      ? join(process.resourcesPath, 'cua-driver', 'cua-driver')
      : join(app.getAppPath(), 'vendor', 'cua-driver', 'cua-driver'))
  cuaManager = new DriverManager({
    binPath: driverBin,
    hostBundleId: 'unmute',
    // Opt-in principle: the 30s permission poll must not spawn a resident
    // driver child for users who never turned Computer Use on. User-initiated
    // paths (IPC ax-trusted check, bridge tool calls) still spawn on demand.
    getEnabled: () => normalizePolicy(settings.get('computerUse')).enabled,
  })
  const cuaArming = new Arming()
  const cuaCdp = new CdpLane((app) => cuaArming.portFor(app))
  const cuaLaneRouter: RouterCtx = {
    cdp: cuaCdp,
    arming: cuaArming,
    runAppleScript,
    getPolicy: () => normalizePolicy(settings.get('computerUse')),
  }
  void startCuaServer({
    manager: cuaManager,
    getPolicy: () => normalizePolicy(settings.get('computerUse')),
    onActivity: (ev) => broadcastAxActivity(ev),
    router: cuaLaneRouter,
  }).then((s) => { cuaServer = s }).catch((e) => log.warn('cua server not started', { error: (e as Error).message }))
  void applyAxRegistration(normalizePolicy(settings.get('computerUse')).enabled)

  // ── Notch shell (native Swift helper) ──
  // The single task/attention surface (spec 2026-07-24). Spawned by THIS signed
  // process (like cua-driver) so its NSPanel carries the app's identity and never
  // steals focus. Every dep maps 1:1 onto the SAME internals the legacy IPC
  // handlers call — the native cockpit cannot drift from the web one. Gated by
  // UNMUTE_NOTCH_ENABLED so the legacy overlay can be toggled back (default: on).
  if (process.env.UNMUTE_NOTCH_ENABLED !== '0' && manager) {
    const mgr = manager
    // Digest baseline ("while you were away"): per-run memory, mirrors the old
    // renderer-localStorage behavior closely enough (30-min threshold).
    let notchLastSeen = Date.now()
    try {
      const notchBin = process.env.UNMUTE_NOTCH_PATH
        || (app.isPackaged
          ? join(process.resourcesPath, 'unmute-notch', 'unmute-notch')
          : join(app.getAppPath(), 'native-notch', '.build', 'release', 'unmute-notch'))
      notchClient = new NotchClient({
        binPath: notchBin,
        onExit: (code) => log.warn('notch helper exited', { code }),
      })
      notchController = new NotchController(notchClient, mgr, {
        // task runtime — same calls as remote:list/answer/kill/remove/resume/…
        listTasks: () => mgr.list().map(serializeTask),
        getTask: (id) => { const t = mgr.get(id); return t ? serializeTask(t) : undefined },
        answer: (id, text) => mgr.answer(id, text),
        kill: (id) => mgr.kill(id),
        remove: (id) => mgr.remove(id),
        killAll: () => mgr.killAll(),
        resume: (id) => mgr.resume(id),
        rerun: (intent) => { void dispatchFromCapture(intent) },
        setKind: (id, kind) => mgr.setKind(id, kind),
        setName: (id, name) => { if (name.trim()) mgr.setName(id, name.trim().slice(0, 48)) },
        setShelved: (id, on) => mgr.setShelved(id, on),
        setNote: (id, note) => mgr.setNote(id, note),
        focus: (id) => { orchestrateFocusId = id },
        opened: (id) => mgr.opened(id),
        // terminal — same as remote:get-output/terminal-input/terminal-resize
        getOutput: (id) => mgr.getOutput(id),
        sendInput: (id, data) => mgr.sendInput(id, data),
        resizeTerm: (id, cols, rows) => mgr.resize(id, cols, rows),
        openInTerminal: (id) => { void openInTerminal(id) },
        tmuxAvailable: () => tmuxBin !== null,
        // rails — the shared implementations
        listSkills: () => listSkillsForRail(),
        listProjects: async () => {
          const projects = await knownProjects(8).catch(() => [])
          const home = homedir()
          const kept = projects.filter((p) => p.path !== home)
          const counts = new Map<string, number>()
          for (const p of kept) counts.set(p.name, (counts.get(p.name) ?? 0) + 1)
          return kept.slice(0, 6).map((p) => ({
            name: (counts.get(p.name) ?? 0) > 1 ? `${basename(dirname(p.path))}/${p.name}` : p.name,
            path: p.path,
          }))
        },
        pinSkill: (name, on) => {
          const cur = new Set(settings.get('pinnedSkills') ?? [])
          if (on) cur.add(name); else cur.delete(name)
          settings.set('pinnedSkills', [...cur])
        },
        tapSkill: (taskId, name) => { mgr.typeUnsubmitted(taskId, `/${name} `) },
        openProject: (path, name) => {
          void dispatchFromCapture(`Start a working session in the ${name} project (${path}).`)
        },
        // curator — the same hoisted accept/reject + conversation machinery
        listProposals: () => listPendingProposals(curatorPathsV),
        getProposal: (id) => readProposal(curatorPathsV, id),
        acceptProposal: (id) => acceptProposalById(id),
        rejectProposal: async (id, reason) => { await rejectProposalById(id, reason) },
        converseStart: async (id, onData) => {
          const existing = curatorConversations.get(id)
          if (existing) { existing.stop(); curatorConversations.delete(id) }
          const conv = new ProposalConversation({
            executorFactory: librarianExecutorFactory,
            paths: curatorPathsV,
            proposalId: id,
            onData,
          })
          curatorConversations.set(id, conv)
          const ok = await conv.start()
          if (!ok) curatorConversations.delete(id)
          return ok
        },
        converseWrite: (id, text) => { curatorConversations.get(id)?.write(text) },
        converseStop: (id) => { curatorConversations.get(id)?.stop(); curatorConversations.delete(id) },
        // chrome
        openArtifact: (type, value) => {
          void (async () => {
            try {
              if (type === 'path') { const err = await shell.openPath(value); if (err) log.warn('open-artifact path failed', { value, err }) }
              else await shell.openExternal(value, { activate: false })
            } catch (e) { log.warn('open-artifact failed', { type, value, error: (e as Error).message }) }
          })()
        },
        acceptRouteOffer: async (newTaskId) => {
          const offer = pendingRouteOffer
          if (!offer || offer.newTaskId !== newTaskId) return false
          pendingRouteOffer = null
          const alt = mgr.get(offer.altTaskId)
          if (!alt) return false
          await mgr.remove(newTaskId)
          if (mgr.tasksAwaitingUser().some((t) => t.id === offer.altTaskId)) {
            mgr.answer(offer.altTaskId, offer.intent)
          } else if (!mgr.followUp(offer.altTaskId, offer.intent)) {
            void mgr.resume(offer.altTaskId)
          }
          return true
        },
        getDoorbell: () => settings.get('voiceHeadlines') !== false,
        setDoorbell: (on) => settings.set('voiceHeadlines', !!on),
        getStagedCount: () => stagedAttachments.length,
        clearStaged: () => { stagedAttachments = []; broadcastStaged() },
        getLastSeen: () => notchLastSeen,
        setLastSeen: (ms) => { notchLastSeen = ms },
        // (pill deps are wired separately, below — see PillController)
      })

      // ── The input surface ──
      //
      // Same helper, same channel — the pill is a second NSPanel in the process
      // the notch already owns. Every dep here is a RELAY: the capture renderer
      // still owns the behaviour (it owns the audio), main only forwards the
      // gesture back to it. The two exceptions are model and agent, which are
      // real settings and are set here exactly as remote:set-model does.
      const toWidget = (type: string, value?: unknown) => {
        for (const w of BrowserWindow.getAllWindows()) {
          if (!w.isDestroyed()) w.webContents.send('pill:event', { type, value })
        }
      }
      pillController = new PillController(notchClient, {
        stop:        () => toWidget('stop'),
        cancel:      () => toWidget('cancel'),
        undo:        () => toWidget('undo'),
        acceptDraft: () => toWidget('acceptDraft'),
        pickMic:     (id) => toWidget('pickMic', id),
        // Main owns sessionForceRaw, so set it HERE rather than bouncing through
        // the renderer and back. The old round-trip also never re-pushed, so the
        // chip kept reporting the previous value — the same "dead control" the
        // model and agent labels had.
        toggleRaw: (on) => {
          sessionForceRaw = on
          log.event('force-raw-set', { on, scope: 'session', from: 'pill' })
          toWidget('rawChanged', on)   // keep the DOM toggle in step
          void pushPillChips()
        },
        dismissOffline:    () => toWidget('dismissOffline'),
        openBillingPortal: () => toWidget('openBillingPortal'),
        pickModel: (m) => {
          const model = isSelectableModel(m) ? m : (settings.get('model') || getModels().doerDefault)
          settings.set('model', model)
          settings.set('modelUserSet', true) // explicit choice — never auto-migrate it
          for (const w of BrowserWindow.getAllWindows()) {
            if (!w.isDestroyed()) w.webContents.send('remote:model-changed', model)
          }
          log.event('model-set', { model, from: 'pill' })
          // RE-PUSH, or the chip keeps its old label for the rest of the
          // capture. The setting changed correctly and the surface said
          // otherwise, which reads exactly like a dead control.
          void pushPillChips()
        },
        // The agent control CYCLES — there are only ever two, and the original
        // made it a tap rather than a list.
        cycleAgent: () => {
          const now = (settings.get('agent') as AgentKind) ?? 'claude'
          const next: AgentKind = now === 'codex-desktop' ? 'claude' : 'codex-desktop'
          settings.set('agent', next)
          for (const w of BrowserWindow.getAllWindows()) {
            if (!w.isDestroyed()) w.webContents.send('remote:agent-changed', next)
          }
          log.event('agent-set', { agent: next, from: 'pill-cycle' })
          // Refresh Codex's axes on the way IN, then re-push — otherwise the
          // model half keeps the other platform's list.
          if (next === 'codex-desktop') {
            void refreshCodexReasoningForPill().finally(() => { void pushPillChips() })
          } else {
            void pushPillChips()
          }
        },
        pickAxis: (axis, value) => {
          // Speed IS a real axis (the menu offers Standard / Fast); it was
          // dropped only because the old reader could not see it.
          if (axis !== 'Model' && axis !== 'Effort' && axis !== 'Speed') return
          log.event('codex-pick-start', { axis, value, from: 'pill', hasDriver: !!codexDriver })
          if (!codexDriver) {
            // Say so. This returned silently, and a pick that never left the
            // building looked identical to one the menu rejected.
            log.warn('codex-pick-done', { axis, value, ok: false, stage: 'no-driver' })
            return
          }
          // Remember the CHOICE even if the live write misses, so dispatch can
          // still apply it — the same contract the IPC path already honours.
          settings.set(
            (axis === 'Model' ? 'codexModel' : axis === 'Effort' ? 'codexEffort' : 'codexSpeed') as never,
            value as never)
          void codexDriver.setReasoningAxis(axis, value)
            .then((trace) => {
              // ONE LINE WITH THE WHOLE STORY: what was clicked, how the menu
              // opened, what it offered, what we matched, and whether Codex's
              // own label actually moved.
              log[trace.ok && trace.changed ? 'event' : 'warn']('codex-pick-done', {
                axis, value, from: 'pill', ok: trace.ok, changed: trace.changed,
                stage: trace.stage, via: trace.via, matched: trace.matched,
                offered: trace.offered, label: `${trace.labelBefore ?? '?'} -> ${trace.labelAfter ?? '?'}`,
                ms: trace.ms,
              })
              // The trace already carries the new label, so the chip updates
              // from it directly. This used to trigger a FULL menu walk per
              // pick — seconds long, over the very menu the next pick needs.
              if (trace.labelAfter || trace.offered?.length) {
                const cached = (settings.get('codexReasoningCache' as never) ?? {}) as
                  { label?: string | null; current?: Record<string, string>; options?: Record<string, string[]> }
                // The trace carries what the submenu ACTUALLY offered. That is a
                // first-hand reading of the one authority that matters, so it
                // replaces whatever the cache held — including the "Advanced"
                // garbage the retired scraper left behind.
                settings.set('codexReasoningCache' as never, {
                  ...cached,
                  label: trace.labelAfter || cached.label,
                  current: { ...(cached.current ?? {}), ...(trace.changed ? { [axis]: value } : {}) },
                  options: trace.offered?.length
                    ? { ...(cached.options ?? {}), [axis]: trace.offered }
                    : cached.options,
                } as never)
              }
              void pushPillChips()
            })
            .catch((e) => log.warn('codex-pick-done', { axis, value, ok: false, stage: 'threw', error: (e as Error).message }))
        },
        pickAgent: (a) => {
          // Only ever a backend this host can actually dispatch to — the same
          // guard the picker itself applies, repeated here because an event can
          // arrive from a surface whose options are a moment stale.
          if (a !== 'claude' && a !== 'codex-desktop') return
          settings.set('agent', a)
          for (const w of BrowserWindow.getAllWindows()) {
            if (!w.isDestroyed()) w.webContents.send('remote:agent-changed', a)
          }
          log.event('agent-set', { agent: a, from: 'pill' })
          void pushPillChips()   // see pickModel — the label must follow the setting
        },
        clearStaged: () => { stagedAttachments = []; broadcastStaged() },
      })

      // Push the stored preference immediately: the helper starts on 'system',
      // so without this a user who chose Solid would see one glassy frame on
      // every launch.
      notchClient.send({ type: 'appearance', value: settings.get('surfaceAppearance') || 'solid' } as never)

      log.info('notch shell started', { bin: notchBin })
    } catch (e) {
      log.warn('notch shell not started', { error: (e as Error).message })
    }
  }

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
    if (LIBRARIAN_PARKED) return // PARKED: no autonomous gardening sweeps (§12)
    if (settings.get('librarianWriteEnabled') !== true) return
    // Run the prune INSIDE the librarian's serial queue so it never overlaps a
    // write-mode librarian session (single-writer invariant covers gardening).
    void librarian.runMaintenance(async () => {
      const actions = await planGardening({ nowMs: Date.now() })
      devEvent(log, 'gardening-sweep', { planned: actions.length })
      await applyGardening(actions, {})
    }).catch((e) => log.warn('gardening sweep failed', { error: (e as Error).message }))
  }, GARDEN_MS)
  ;(gardenTimer as { unref?: () => void }).unref?.()
  // The warm routing classifier (lazy — spawns on the first routed utterance,
  // idle-kills itself; tool-less, no glow). Star topology: Unmute is the hub.
  router = new Router({
    executorFactory: routerExecutorFactory,
    slot: 'claude',
    decisionTimeoutMs: getKnobs().routerDecisionTimeoutMs,
    maxSessionMs: getKnobs().routerMaxSessionMs,
  })
  // Resident from startup — bring the classifier up now so the FIRST follow-up
  // utterance hits a warm session, never a cold spawn + timeout. Fire-and-forget.
  // Only when the CLI is actually there: warming a binary the user does not have
  // just logs a spawn failure every launch.
  void claudeCliAvailable().then((ok) => { if (ok) void router?.warm() })

  // The Codex router. Same prompt, different transport — and a separate slot so
  // the two can never read each other's decision file.
  codexRouter = new Router({
    executorFactory: routerExecutorFactory,   // unused: `engine` takes the path
    engine: new CodexRouterEngine(),
    slot: 'codex',
    decisionTimeoutMs: getKnobs().routerDecisionTimeoutMs,
    maxSessionMs: getKnobs().routerMaxSessionMs,
  })
  void codexRouter.warm().catch(() => { /* no Codex CLI — the Claude router stands */ })

  // ── The Skill Curator (spec §11) — supersedes the parked librarian ──
  // A background scheduler that sweeps session transcripts, distills recurring
  // procedures, and PROPOSES skills for the user to review. It reuses the SAME
  // tool-less, autonomous spawn profile as the librarian (skip-permissions, no
  // browser) — see librarianExecutorFactory. All heavy lifting (Tasks 2–11) is
  // injected; this is pure wiring. (curatorPathsV is module-scoped — the route
  // handler reads it too.)
  const curatorSkillsRoot = join(homedir(), '.claude', 'skills')
  // curatedIndex: the skills the judge should treat as "already exists" —
  // GLOBAL (~/.claude/skills) ∪ PROJECT-SCOPED (<project>/.claude/skills)
  // skills, deduped by name, PLUS every name we own even if its SKILL.md is
  // gone from disk (ownership-record authority — see curator-index.ts for
  // why: without the project-scoped half, the curator was blind to skills a
  // user keeps in a repo's own .claude/skills/ and kept re-proposing
  // duplicates of them). Read logic (list + parse SKILL.md, strip
  // frontmatter for the D19 diff body) lives in curator-index.ts.
  const buildCuratedIndex = async (): Promise<Array<{ name: string; description: string; body: string }>> => {
    const ownedNames = ownedSkillNames(await readOwnership(curatorPathsV))
    const projectRoots = (await knownProjects()).map((proj) => proj.path)
    return buildCuratedIndexFrom(ownedNames, curatorSkillsRoot, projectRoots)
  }
  const curator = new Curator({
    paths: curatorPathsV,
    sweepIntervalMs: () => getKnobs().curatorSweepIntervalMs,
    listSessions: async () => {
      // Session-kind tasks from disk: ~/.unmute/remote/local/*/meta.json.
      const base = join(homedir(), '.unmute', 'remote', 'local')
      const out: SessionInfo[] = []
      for (const id of await fs.readdir(base).catch(() => [] as string[])) {
        try {
          const m = JSON.parse(await fs.readFile(join(base, id, 'meta.json'), 'utf8'))
          if (m.kind === 'session') out.push({ taskId: id, intent: m.intent ?? '', cwd: m.cwd ?? join(base, id), kind: 'session', sessionId: m.sessionId })
        } catch { /* skip unreadable/partial meta */ }
      }
      return out
    },
    // Idle-preference (§4.1): defer a sweep while any task is mid-turn OR an
    // utterance is in flight (captureBusy is true through listening/transcribing/
    // routing, false at idle) — never compete with live work for the window.
    isBusy: () => (manager?.hasProcessingTask() ?? false) || captureBusy,
    runSweep: makeRunSweep({ executorFactory: librarianExecutorFactory, paths: curatorPathsV, curatedIndex: buildCuratedIndex }),
  })
  curator.start()
  // One live review conversation per proposal (Task 10). Held HERE so a second
  // start for the same id stops the first — ProposalConversation does not
  // self-guard; that carry-forward enforcement is this map's responsibility.
  const curatorConversations = new Map<string, ProposalConversation>()

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
      // Key lifted → recording ended → secure a last-second ⌃-shot, then clear
      // the clipboard if this capture consumed images — so the text paste later
      // never races a slow image payload. Transcription absorbs the latency.
      secureAndClearClipboard()
      // Safety stop for a cancelled/failed dictation (generation-guarded:
      // never kills a NEWER capture's watch).
      const gen = captureWatchGen
      setTimeout(() => { if (captureWatchGen === gen) stopCaptureWatch({ purgeAuto: true }) }, 20_000)
    }
  })

  // The notch is the single task/attention surface (spec 2026-07-24). When it's
  // on, the legacy right-side overlay is retired: suppressed here and never even
  // pre-warmed. UNMUTE_NOTCH_ENABLED=0 restores the old surface wholesale.
  const notchOwnsAttention = process.env.UNMUTE_NOTCH_ENABLED !== '0'
  setOverlaySuppressed(notchOwnsAttention)
  if (!notchOwnsAttention) {
    // Pre-warm the floating overlay window (hidden) so the first present is instant.
    createOverlayWindow()
  }
  // Orchestrate cockpit: ⌘⇧O stays as a fallback entry point; the primary way in
  // is now the notch's "open dashboard" (→ showCockpit → openOrchestrateWindow).
  registerOrchestrateShortcut()
  // Apply the docked-mode preference (default ON).
  setDockedMode(settings.get('overlayDocked') !== false)
  // One-time: move users still on the OLD opus default to the new sonnet default
  // — but ONLY if they never explicitly picked a model (modelUserSet stays false
  // until they touch the selector, so a deliberate opus choice is preserved).
  if (!settings.get('modelUserSet') && settings.get('model') === 'opus') {
    settings.set('model', 'sonnet')
    log.event('model-migrated-opus-to-sonnet', {})
  }
  // One-time: move users off the OLD 'system' surface default.
  //
  // 'system' was the previous DEFAULT, written into every existing install, so
  // it carries no signal that anyone chose it — and it resolves to translucent,
  // which on macOS 26.2 means a cached backdrop showing the previous Space's
  // colours (developer.apple.com/forums/thread/810314). Changing the default
  // alone reached nobody who had already run the app, which is precisely how
  // this shipped looking unfixed. An explicit 'glass' choice is preserved.
  if (settings.get('surfaceAppearance') === 'system') {
    settings.set('surfaceAppearance', 'solid')
    log.event('surface-migrated-system-to-fixed', {})
  }
  // Codex isn't wired yet (shown as "coming soon"). If a past build stored it as
  // the agent, reset to claude so Remote works instead of failing every task.
  // Only the unwired CLI adapter is reset; 'codex-desktop' is a supported choice.
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
  manager.on('updated', (t: Task) => {
    broadcast('remote:task-updated', t)
    reconcileDock(activeTaskCount())
    // Self-healed back to work (stuck→processing via hook activity): reset the
    // doorbell dedupe so a LATER re-stuck rings again — it's newly actionable.
    if (t.state === 'processing') spokenState.delete(t.id)
  })
  manager.on('needs-user', (t: Task) => {
    broadcast('remote:task-needs-user', t)
    maybePresent(t)
    reconcileDock(activeTaskCount())
    speakHeadline(t, 'needs-user') // §6.4 doorbell: terse, serialized, toggleable
  })
  // ── Skill-usage ledger (deterministic trust fuel): when a task reaches a
  // successful turn-over (done or ready), credit any Skill invocations in its
  // transcript to the sidecar ledger. Idempotent (delta-cursored), serialized,
  // per-task cooldown so a chatty session can't spam transcript reads. The
  // JUDGED stat (runs_confirmed) stays with the librarian behind its gate.
  const usageCreditAt = new Map<string, number>()
  const creditSkillUsage = (t: Task) => {
    const last = usageCreditAt.get(t.id) ?? 0
    if (Date.now() - last < 60_000) return
    usageCreditAt.set(t.id, Date.now())
    setTimeout(() => {
      void (async () => {
        // Exact path first (sessionId is pinned at dispatch); locate as fallback.
        const exact = join(homedir(), '.claude', 'projects', projectSlug(t.cwd), `${t.sessionId}.jsonl`)
        const transcriptPath = existsSync(exact) ? exact : await locateTranscript(t.cwd)
        if (!transcriptPath) return
        await recordSkillUsage({ taskId: t.id, transcriptPath, statsPath: defaultStatsPath() })
      })().catch((e) => log.warn('skill-usage credit failed', { taskId: t.id, error: (e as Error).message }))
    }, 3000) // let Claude flush the transcript tail
  }
  manager.on('updated', (t: Task) => {
    if (t.state === 'ready') { creditSkillUsage(t); curator.notifyCheckpoint(t.id) } // ready = a natural stopping point → sweep-eligible
  })

  manager.on('done', (t: Task) => {
    broadcast('remote:task-done', t)
    maybePresent(t)
    reconcileDock(activeTaskCount())
    notify('Task done', t.result?.summary ? `${t.intent} — ${t.result.summary}` : t.intent)
    creditSkillUsage(t)
    curator.notifyCheckpoint(t.id) // done → the session's delta is sweep-eligible
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
  // A RESUME THAT DID NOT HAPPEN. The renderer fires resume and discards the
  // result (`void api().remoteResume?.(id)`), so without this a failure was
  // visible only in the log — the button simply did nothing. Spoken because the
  // user just pressed something and is owed an answer; the card carries the
  // detail via `resumeError`.
  manager.on('resume-failed', ({ taskId, error }: { taskId: string; error: string }) => {
    const t = manager?.get(taskId)
    log.error('resume failed — telling the user', { taskId, error })
    if (t) { broadcast('remote:task-updated', t); maybePresent(t) }
    speakLine(
      error.startsWith('AGENT_SEPARATION_VIOLATION')
        ? 'That session belongs to a different agent.'
        : "I couldn't bring that session back.",
    )
  })
  // Task erased (Kill/Delete) → tell renderers to drop the row + update the dock.
  manager.on('removed', (t: Task) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('remote:task-removed', { id: t.id })
    }
    reconcileDock(activeTaskCount())
    curator.notifyCheckpoint(t.id) // kill/delete → whatever ran is a closed chapter, sweep-eligible
  })

  // Master kill switch: closing Unmute terminates every Claude/tmux session so
  // none is left orphaned on the user's machine/plan (PRD §10.4).
  app.on('before-quit', () => {
    try { manager?.killAll() } catch (e) { log.warn('before-quit killAll failed', { error: (e as Error).message }) }
    try { cuaManager?.dispose(); cuaServer?.close(); void cuaArming.disposeAll() } catch (e) { log.warn('cua shutdown failed', { error: (e as Error).message }) }
    try { pillController?.hide() } catch { /* best-effort */ }
    try { notchController?.dispose(); notchClient?.dispose() } catch (e) { log.warn('notch shutdown failed', { error: (e as Error).message }) }
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
    // Opening a session on the wall is the same gesture as opening it in the
    // notch: if the quit switch closed its PTY, bring it back (no Resume tap).
    if (orchestrateFocusId) manager?.opened(orchestrateFocusId)
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
  ipcMain.handle('remote:get-screenshot-capture', async () => settings.get('screenshotCapture') !== false)
  // The Unmute MCP master switch (agent-created tasks).
  ipcMain.handle('remote:get-agent-tasks', async () => settings.get('agentTasksEnabled') !== false)
  ipcMain.handle('remote:set-agent-tasks', async (_e, on: boolean) => { settings.set('agentTasksEnabled', !!on); return true })
  ipcMain.handle('remote:set-screenshot-capture', async (_e, on: boolean) => {
    settings.set('screenshotCapture', !!on)
    if (!on) stopCaptureWatch() // kill a live watcher immediately on disable
    log.event('screenshot-capture-set', { on: !!on })
    return true
  })
  // ── Computer Use (ax-mcp) settings IPC ──
  ipcMain.handle('remote:get-computer-use', async () => normalizePolicy(settings.get('computerUse')))
  ipcMain.handle('remote:set-computer-use', async (_e, patch: Partial<AxPolicy>) => {
    const prev = normalizePolicy(settings.get('computerUse'))
    const next = normalizePolicy({ ...prev, ...patch })
    settings.set('computerUse', next)
    // The server reads policy live, so enforcement is already in effect. Only
    // the Claude registration + steer need side effects, and only when the
    // master toggle actually changed.
    if (next.enabled !== prev.enabled) {
      void applyAxRegistration(next.enabled)
      log.event('computer-use-toggled', { enabled: next.enabled })
    }
    return next
  })
  // Is this process trusted for Accessibility? (Onboarding: tells the user
  // whether they still need to grant permission to Unmute.)
  ipcMain.handle('remote:ax-trusted', async () => {
    try { return (await cuaManager!.checkPermissions()).accessibility } catch { return false }
  })

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
  // Hoisted so BOTH the IPC handler and the notch controller share it (same
  // data, one implementation).
  const listSkillsForRail = async () => {
    // ALL skills — the rail is the full vocabulary; an unlisted skill is a skill
    // nobody says. The recipe-store reader only walks surface SUBFOLDERS, which
    // hid the older root-level skill files — so scan recursively ourselves:
    // ~/.unmute/remote/{skills,recipes}/**/*.md + ~/.claude/skills entries.
    // Name = filename (they ARE the names); recency = file mtime. Zero tokens.
    const { readdirSync, statSync, readFileSync } = await import('node:fs')
    // Provenance: names the curator authored (ownership-record authority) get an
    // 'unmute' origin badge on the rail. Read once at the top of the handler.
    const curatedNames = ownedSkillNames(await readOwnership(curatorPathsV))
    // The tooltip's substance: the skill's own frontmatter description (first
    // ~4KB read, single-line 'description:' field — the format both stores use).
    const metaOf = (mdPath: string): { description: string; runs: number; lastUsed: string } => {
      try {
        const head = readFileSync(mdPath, 'utf8').slice(0, 4096)
        const d = /^description:\s*(.+)$/m.exec(head)
        const r = /^runs_confirmed:\s*(\d+)/m.exec(head)
        const u = /^last_used:\s*(\S+)/m.exec(head)
        return {
          description: (d?.[1] ?? '').trim().slice(0, 600),
          runs: r ? Number(r[1]) : 0,
          lastUsed: (u?.[1] ?? '').slice(0, 10),
        }
      } catch { return { description: '', runs: 0, lastUsed: '' } }
    }
    const out: Array<{ name: string; lastUsed: string; description: string; runs: number; pinned: boolean }> = []
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
          const meta = metaOf(full)
          out.push({ name: entry.replace(/\.md$/, ''), lastUsed: meta.lastUsed || new Date(st.mtimeMs).toISOString().slice(0, 10), description: meta.description, runs: meta.runs, pinned: false })
        } catch { /* skip unreadable */ }
      }
    }
    walk(join(homedir(), '.unmute', 'remote', 'skills'), 0)
    walk(join(homedir(), '.unmute', 'remote', 'recipes'), 0)
    // ~/.claude/skills: loose .md files AND skill folders (dir name = skill name,
    // description in <dir>/SKILL.md).
    const claudeDir = join(homedir(), '.claude', 'skills')
    try {
      for (const entry of readdirSync(claudeDir)) {
        if (entry.startsWith('.')) continue
        try {
          const full = join(claudeDir, entry)
          const st = statSync(full)
          const meta = st.isDirectory() ? metaOf(join(full, 'SKILL.md')) : metaOf(full)
          out.push({ name: entry.replace(/\.md$/, ''), lastUsed: meta.lastUsed || new Date(st.mtimeMs).toISOString().slice(0, 10), description: meta.description, runs: meta.runs, pinned: false })
        } catch { /* skip */ }
      }
    } catch { /* no ~/.claude/skills — fine */ }
    const seen = new Set<string>()
    const pinned = new Set(settings.get('pinnedSkills') ?? [])
    // Merge the usage ledger: frontmatter runs_confirmed (librarian-judged, for
    // Unmute-owned skills) + sidecar runs (deterministic invocation credit, for
    // ALL skills incl. the user's own — whose files we never write). lastUsed
    // takes the freshest of the two.
    const ledger = await readSkillStats(defaultStatsPath())
    // Earned-trust ranking: pinned first (the user's override), then proven use
    // (confirmed + used runs), then recency. A junk skill touched yesterday no
    // longer outranks the workhorse used forty times last month.
    return out
      .filter((s) => s.name && !seen.has(s.name) && (seen.add(s.name), true))
      .map((s) => {
        const u = ledger.skills[s.name]
        return {
          ...s,
          runs: s.runs + (u?.runs ?? 0),
          lastUsed: u?.lastUsed && u.lastUsed > (s.lastUsed || '') ? u.lastUsed : s.lastUsed,
          pinned: pinned.has(s.name),
          origin: curatedNames.has(s.name) ? 'unmute' as const : undefined,
        }
      })
      .sort((a, b) =>
        Number(b.pinned) - Number(a.pinned) ||
        b.runs - a.runs ||
        (b.lastUsed || '').localeCompare(a.lastUsed || ''))
      .slice(0, 30)
  }
  ipcMain.handle('remote:list-skills', async () => listSkillsForRail())
  // ── Skill Curator IPC (spec §11) — thin calls into Tasks 2/6/10 ──
  // The review surface: list pending proposals, read one, accept (materialize the
  // skill on disk) or reject (record + resolve), drive the per-proposal review
  // conversation, and tap a skill into a live session.
  ipcMain.handle('curator:list-proposals', async (): Promise<Proposal[]> =>
    listPendingProposals(curatorPathsV))
  ipcMain.handle('curator:get-proposal', async (_e, id: string): Promise<Proposal | null> =>
    readProposal(curatorPathsV, id))
  // Hoisted so the notch controller shares the exact accept/reject paths.
  const acceptProposalById = async (id: string): Promise<{ ok: boolean; error?: string }> => {
    const proposal = await readProposal(curatorPathsV, id)
    if (!proposal) return { ok: false, error: 'proposal not found' }

    // retire — a DELETE, no body: skip the draft.md/edited-body/userEdited logic
    // entirely. writeSkill removes the owned skill's dir + ownership entry; on
    // success the linked ledger entries move to 'retired' (not 'live').
    if (proposal.kind === 'retire') {
      const res = await writeSkill({
        draft: proposal.draft,
        kind: 'retire',
        targetSkill: proposal.targetSkill,
        proposalId: id,
        paths: curatorPathsV,
        originStamp: true,
      })
      if (res.ok) {
        await resolveProposal(curatorPathsV, id, { action: 'accepted', at: new Date().toISOString(), userEdited: false })
        if (proposal.sourceKeys && proposal.sourceKeys.length) {
          let ledger = await readCandidates(curatorPathsV)
          for (const key of proposal.sourceKeys) ledger = setCandidateStatus(ledger, key, 'retired')
          await writeCandidates(curatorPathsV, ledger)
        }
        return { ok: true }
      }
      return { ok: false, error: res.detail ?? res.error ?? 'write failed' }
    }

    // create / narrow / split / merge — a WRITE. The user may have edited
    // draft.md in the review conversation — if the on-disk draft differs from the
    // proposal's stored body, that edit wins and marks the acceptance user-edited
    // (the accepted content is recorded either way).
    let body = proposal.draft.body
    let userEdited = false
    try {
      const onDisk = await fs.readFile(join(curatorPathsV.proposalsDir, id, 'draft.md'), 'utf8')
      if (onDisk !== proposal.draft.body) { body = onDisk; userEdited = true }
    } catch { /* no draft.md — accept the proposal body as-is */ }
    const res = await writeSkill({
      draft: { ...proposal.draft, body },
      kind: proposal.kind,
      targetSkill: proposal.targetSkill,
      proposalId: id,
      paths: curatorPathsV,
      originStamp: true, // preflight confirmed the `origin: unmute` key is tolerated (§11)
    })
    if (res.ok) {
      await resolveProposal(curatorPathsV, id, { action: 'accepted', at: new Date().toISOString(), userEdited })
      // Lifecycle: the accepted skill is now LIVE. Move every ledger candidate
      // this proposal drew from to 'live' and link it to the materialized skill.
      if (proposal.sourceKeys && proposal.sourceKeys.length) {
        let ledger = await readCandidates(curatorPathsV)
        for (const key of proposal.sourceKeys) ledger = setCandidateStatus(ledger, key, 'live', { linkedSkillId: proposal.draft.name })
        await writeCandidates(curatorPathsV, ledger)
      }
      return { ok: true }
    }
    // Surface the human-readable reason for the popup (collision / invalid-name / io).
    return { ok: false, error: res.detail ?? res.error ?? 'write failed' }
  }
  ipcMain.handle('curator:accept', async (_e, id: string) => acceptProposalById(id))
  const rejectProposalById = async (id: string, reason?: string): Promise<boolean> => {
    const proposal = await readProposal(curatorPathsV, id)
    if (!proposal) return false
    const at = new Date().toISOString()
    await appendRejection(curatorPathsV, { at, name: proposal.draft.name, reason })
    await resolveProposal(curatorPathsV, id, { action: 'rejected', at, userEdited: false, reason })
    // Lifecycle: move every ledger candidate this proposal drew from to 'rejected'.
    if (proposal.sourceKeys && proposal.sourceKeys.length) {
      let ledger = await readCandidates(curatorPathsV)
      for (const key of proposal.sourceKeys) ledger = setCandidateStatus(ledger, key, 'rejected')
      await writeCandidates(curatorPathsV, ledger)
    }
    return true
  }
  ipcMain.handle('curator:reject', async (_e, id: string, reason?: string) => rejectProposalById(id, reason))
  ipcMain.handle('curator:converse-start', async (_e, id: string): Promise<boolean> => {
    // Second-start-stops-first (Task 10 carry-forward): ProposalConversation does
    // NOT self-guard, so we retire any existing session for this id here.
    const existing = curatorConversations.get(id)
    if (existing) { existing.stop(); curatorConversations.delete(id) }
    const conv = new ProposalConversation({
      executorFactory: librarianExecutorFactory, // same autonomous, no-browser profile the sweep uses
      paths: curatorPathsV,
      proposalId: id,
      // Raw PTY output → the review popup terminal, mirroring the task-output send.
      onData: (chunk) => {
        for (const w of BrowserWindow.getAllWindows()) {
          if (!w.isDestroyed()) w.webContents.send('curator:conv-data', { id, chunk })
        }
      },
    })
    curatorConversations.set(id, conv)
    const ok = await conv.start()
    if (!ok) curatorConversations.delete(id) // failed to spawn — don't leave a dead entry
    return ok
  })
  ipcMain.handle('curator:converse-write', async (_e, id: string, data: string): Promise<void> => {
    curatorConversations.get(id)?.write(data)
  })
  ipcMain.handle('curator:converse-stop', async (_e, id: string): Promise<void> => {
    curatorConversations.get(id)?.stop()
    curatorConversations.delete(id)
  })
  ipcMain.handle('curator:tap-skill', async (_e, taskId: string, name: string): Promise<boolean> => {
    if (!manager) return false
    // Trailing space per preflight: it dismisses the autocomplete menu so the
    // user's Enter submits the typed `/name` as a real skill invocation.
    return manager.typeUnsubmitted(taskId, `/${name} `)
  })
  // DEV-ONLY full-UX logging (fire-and-forget). The renderer emits this
  // UNCONDITIONALLY for every user-facing curator action; the single gate lives
  // HERE — devlog() drops it when the dev-log gate is off (no file, no dir). So a
  // packaged public build logs nothing even though the renderer keeps calling.
  ipcMain.on('curator:devlog', (_e, payload: Record<string, unknown>) => {
    devlog({ stage: 'ux', ...(payload && typeof payload === 'object' ? payload : {}) })
  })
  // Pin/unpin a skill (the manual override of earned-trust ranking).
  ipcMain.handle('remote:pin-skill', async (_e, name: string, on: boolean) => {
    const cur = new Set(settings.get('pinnedSkills') ?? [])
    if (on) cur.add(name); else cur.delete(name)
    settings.set('pinnedSkills', [...cur])
    return true
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
  // Shelve/unshelve — preserved-but-out-of-the-way (hidden from the wall grid,
  // purge-exempt, findable in the rail's Shelf).
  ipcMain.handle('remote:set-shelved', async (_e, id: string, on: boolean) => {
    if (!manager) return false
    manager.setShelved(id, !!on)
    return true
  })
  // Card note — the user's annotation (ticket link, context); never fed to the agent.
  ipcMain.handle('remote:set-note', async (_e, id: string, note: string) => {
    if (!manager) return false
    manager.setNote(id, typeof note === 'string' ? note : '')
    return true
  })
  // Staging tray: stage an image with no target (rides with the next utterance).
  ipcMain.handle('remote:stage-image', async (_e, data: ArrayBuffer, ext: string) => {
    try {
      mkdirSync(STAGING_DIR, { recursive: true })
      const safeExt = (ext || 'png').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'png'
      const file = join(STAGING_DIR, `staged-${Date.now()}-${stagedAttachments.length}.${safeExt}`)
      writeFileSync(file, Buffer.from(data))
      stagedAttachments.push({ path: file, auto: false }) // explicit — rides to the next utterance
      broadcastStaged()
      log.event('image-staged', { file, count: stagedAttachments.length })
      return file
    } catch (e) {
      log.warn('stage-image failed', { error: (e as Error).message })
      return null
    }
  })
  ipcMain.handle('remote:get-staged', async () => stagedAttachments.map((s) => s.path))
  // Thumbnails for the pill ledger's dropdown — you can't judge "should I remove
  // this?" from a number. Small data-URLs (CSP-proof; file:// is blocked in the
  // renderer), freshly derived per call.
  ipcMain.handle('remote:staged-previews', async () => {
    // While a capture is live, decoding images for thumbnails is the SAME class
    // of main-thread work that corrupted recordings — placeholder rows instead;
    // real previews the moment the capture ends.
    if (captureWatchTimer) return stagedAttachments.map(({ path }) => ({ path, dataUrl: '' }))
    const { nativeImage } = require('electron') as typeof import('electron')
    return stagedAttachments.map(({ path }) => {
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
    stagedAttachments = stagedAttachments.filter((s) => s.path !== path)
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
  ipcMain.handle('remote:get-model', async () => settings.get('model') || getModels().doerDefault)
  // The effective, config-driven selectable catalog (renderer renders THIS,
  // not a hardcoded list) — so new models arrive via config without a rebuild.
  ipcMain.handle('remote:get-model-catalog', async () => getModelCatalog())
  ipcMain.handle('remote:set-model', async (_e, m: string) => {
    const model = isSelectableModel(m) ? m : (settings.get('model') || getModels().doerDefault)
    settings.set('model', model)
    settings.set('modelUserSet', true) // explicit choice — never auto-migrate it
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('remote:model-changed', model)
    }
    log.event('model-set', { model })
    return model
  })
  // ── The input surface: renderer → native pill ──
  //
  // `send`, not `invoke`. These are fire-and-forget on the CAPTURE PATH and a
  // round-trip per animation frame is exactly the kind of main-process work
  // that corrupts audio. The controller drops unchanged payloads, and
  // pill:level is a no-op unless a capture is actually running.
  ipcMain.on('pill:state', (_e, state: PillStateP) => {
    try { pillController?.push(state ?? {}) } catch { /* never break a capture */ }
  })
  ipcMain.on('pill:level', (_e, level: number, elapsed?: number) => {
    try { pillController?.level(level, elapsed) } catch { /* never break a capture */ }
  })
  ipcMain.on('pill:hide', () => {
    try { pillController?.hide() } catch { /* best-effort */ }
  })

  // ── Surface appearance (Glass / Solid / Follow system) ──
  //
  // macOS already owns this preference twice — Accessibility → Reduce
  // Transparency, and the global Liquid Glass opacity slider on 26+. So
  // 'system' is the default and the helper honours it. The explicit options
  // exist because a hand-built pre-26 surface cannot follow the system slider
  // at all, and because a persistent always-on-top panel over someone else's
  // work is a reasonable thing to want solid regardless.
  ipcMain.handle('remote:get-surface-appearance', async () => settings.get('surfaceAppearance') || 'solid')
  ipcMain.handle('remote:set-surface-appearance', async (_e, v: string) => {
    const value = v === 'glass' || v === 'solid' ? v : 'system'
    settings.set('surfaceAppearance', value)
    notchClient?.send({ type: 'appearance', value } as never)
    log.event('surface-appearance-set', { value })
    return value
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
    devEvent(log, 'cleanup-memory-ipc', {
      pruned: r?.pruned.length ?? 0, evicted: r?.evicted.length ?? 0, demoted: r?.demoted.length ?? 0, deduped: r?.deduped.length ?? 0 })
    return r
  })
  ipcMain.handle('remote:get-settings', async () => ({
    permissionMode: settings.get('permissionMode'),
    remoteKey: getRemoteKey(),
    agent: settings.get('agent'),
    sandboxRoots: settings.get('sandboxRoots') ?? [],
    model: settings.get('model') || getModels().doerDefault,
    browserEnabled: settings.get('browserEnabled') !== false,
    overlayAutoPresent: settings.get('overlayAutoPresent') !== false,
    overlayDocked: settings.get('overlayDocked') !== false,
    osNotifications: settings.get('osNotifications') === true,
    librarianWriteEnabled: settings.get('librarianWriteEnabled') === true,
    forceRawMode: settings.get('forceRawMode') === true,
    screenshotCapture: settings.get('screenshotCapture') !== false,
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
  // What the picker should offer, and why an option is disabled. The UI needs
  // the REASON (not just a boolean) so it can show "Connect Codex" for an
  // installed-but-unarmed app versus hiding the option entirely when Codex
  // isn't installed at all.
  ipcMain.handle('remote:agent-options', async () => {
    // Logged because this decides whether the picker is visible AT ALL, and a
    // silent empty result is indistinguishable from "feature missing" (field
    // report 2026-07-25: chip never appeared, nothing in any log to say why).
    const installed = codexDriver ? await codexDriver.isInstalled().catch(() => false) : false
    const avail = codexDriver ? await codexDriver.availability().catch(() => ({ ok: false, reason: 'not-installed' as const })) : { ok: false, reason: 'not-installed' as const }
    const result = {
      current: (settings.get('agent') as AgentKind) ?? 'claude',
      options: [
        { id: 'claude', label: 'Claude Code', available: true },
        {
          id: 'codex-desktop',
          label: 'Codex',
          // Only offered when it can actually take work right now.
          available: avail.ok,
          installed,
          // 'not-armed' is the actionable one — the app is there, it just wasn't
          // launched with the debug port, so we can't drive it until it relaunches.
          reason: avail.ok ? undefined : ('reason' in avail ? avail.reason : 'not-installed'),
        },
      ],
    }
    log.event('agent-options', {
      current: result.current,
      installed,
      codexAvailable: avail.ok,
      offered: result.options.filter((o) => o.available || o.installed).length,
    })
    return result
  })

  // Explicit "Connect Codex": quits and relaunches Codex WITH the debug port,
  // in the background (`open -g`). This is the one interruption in the Codex
  // lane, so it is always user-initiated and never happens mid-utterance.
  ipcMain.handle('remote:codex-connect', async () => {
    if (!codexDriver) return { ok: false, reason: 'not-configured' }
    const cdp = await codexDriver.connect({ autoArm: true }).catch(() => null)
    const ok = !!cdp
    log.event('codex-connect-requested', { ok })
    if (!ok) return { ok: false, reason: 'arm-failed' }

    // CONNECTING IS ALSO WHEN THE APPROVAL CHANNEL GETS INSTALLED.
    //
    // Without it, a Codex task that stops for permission is invisible to unmute
    // and the crank silently skips it. Doing it here — rather than at every
    // launch — keeps it tied to an explicit user action, and re-running it is
    // free: the files are rewritten and re-trusted from the hash Codex reports,
    // so a moved or updated app repairs itself on the next connect.
    const hook = await installApprovalHook({ runtime: process.execPath }).catch((e) => {
      log.warn('codex-hook-install-threw', { error: (e as Error).message })
      return { ok: false, reason: 'threw' as const }
    })
    log[hook.ok ? 'event' : 'warn']('codex-hook-install', hook)
    // A failed hook install does NOT fail the connect: everything else about
    // Codex still works, the user just gets Codex's own approval dialog.
    return { ok: true, approvals: hook.ok, approvalsReason: hook.ok ? undefined : hook.reason }
  })

  // Live Codex project list for the picker ("create it in <project>").
  /**
   * The Codex model catalog, read from the app itself.
   *
   * The capture chip used to show haiku/sonnet/opus regardless of which agent
   * the picker was on, so "Codex + Opus" was a reachable state — the task went
   * to Codex and the model choice was written to unmute's CLAUDE setting and
   * silently discarded. The chip must offer what the chosen agent actually has.
   *
   * Read live rather than listed here: model names change every few releases,
   * and a managed plan may not offer every tier.
   */
  /**
   * INSTANT, from cache. Reading it live walks Codex's menus over CDP three
   * times (~3s measured) — far too slow for a chip that has to be correct
   * within a two-second capture, and it was being polled every 1.5s, which
   * re-entered before the previous walk finished and hammered menus in the
   * user's Codex window.
   */
  ipcMain.handle('remote:codex-reasoning', async () => {
    const cached = settings.get('codexReasoningCache' as never) as unknown
    if (cached) return cached
    return await refreshCodexReasoning()
  })

  /** Walk the menus and cache the result. Called on connect and on agent switch. */
  const refreshCodexReasoning = async () => {
    if (!codexDriver) return { label: null, current: {}, options: {} }
    const state = await codexDriver.reasoningOptions().catch((e) => {
      log.warn('codex-reasoning-read-failed', { error: (e as Error).message })
      return { label: null, current: {}, options: {} }
    })
    // Only overwrite the cache with a REAL reading — a failed walk must not
    // erase what we last genuinely saw.
    if (state.options.Model?.length) settings.set('codexReasoningCache' as never, state as never)
    return state
  }
  ipcMain.handle('remote:codex-reasoning-refresh', async () => await refreshCodexReasoning())

  ipcMain.handle('remote:codex-reasoning-set', async (_e, axis: 'Model' | 'Effort' | 'Speed', value: string) => {
    if (!codexDriver) return false
    // Store the CHOICE regardless of whether we could apply it now: dispatch
    // re-applies it on the fresh composer anyway, so a closed Codex must not
    // lose what the user picked.
    const key = axis === 'Model' ? 'codexModel' : axis === 'Effort' ? 'codexEffort' : 'codexSpeed'
    settings.set(key as never, value as never)
    // Keep the cache honest so the chip reflects the pick immediately, without
    // another menu walk.
    const cached = settings.get('codexReasoningCache' as never) as { current?: Record<string, string> } | undefined
    if (cached?.current) settings.set('codexReasoningCache' as never, { ...cached, current: { ...cached.current, [axis]: value } } as never)
    log.event('codex-reasoning-choice', { axis, value, from: 'settings' })
    const trace = await codexDriver.setReasoningAxis(axis, value).catch((e) => ({
      axis, want: value, stage: 'threw' as const, ok: false, ms: 0, error: (e as Error).message,
    }))
    return trace.ok
  })

  ipcMain.handle('remote:codex-projects', async () => {
    if (!codexDriver) return []
    return codexDriver.projects().catch(() => [])
  })

  ipcMain.handle('remote:set-agent', async (_e, agent: AgentKind) => {
    // 'codex' (the CLI adapter) is still unwired, so it is coerced away. But
    // 'codex-desktop' IS wired (codex/driver.ts) and must pass through — it is
    // the whole point of the per-task picker.
    const a: AgentKind = agent === 'codex' ? 'claude' : agent
    settings.set('agent', a)
    // Warm the catalog in the background so the chip has real values ready the
    // moment the user looks at it, instead of on a 3s delay mid-capture.
    if (a === 'codex-desktop') void refreshCodexReasoning()
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
