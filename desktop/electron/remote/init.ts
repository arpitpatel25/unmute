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

import { ipcMain, BrowserWindow, Notification, shell, app, clipboard, powerMonitor } from 'electron'
import Store from 'electron-store'
import { join, dirname, basename } from 'node:path'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { existsSync, writeFileSync, mkdirSync, statSync, watch, promises as fs } from 'node:fs'
import { execFile } from 'node:child_process'
import { TaskManager, type Task } from './task-manager'
import { TaskDraftStore } from './task-draft'
import { deliverAddressedCapture } from './addressed-capture'
import { Librarian } from './librarian'
import { ClaudeCodeExecutor } from './pty-session'
import { CodexExecutor, isExternalAgent, type AgentKind } from './codex-executor'
import { providerOf, PROVIDERS, isDispatchable, type ProviderId, DEFAULT_PROVIDER } from './providers'
import { CodexDesktopDriver } from './codex/driver'
import { ClaudeDesktopDriver } from './claude-desktop/driver'
import { ClaudeDesktopAx } from './claude-desktop/ax'
import { ClaudeActuator } from './claude-desktop/actuate'
import { readCatalog as readClaudeCatalog, offeredModels as offeredClaudeModels } from './claude-desktop/catalog'
import { installApprovalHook } from './codex/hooks'
import { cleanIntent, nameIntent, type CompleteFn } from './intent-cleanup'
import { MODELS } from './config'
import { initRuntimeConfig, getModels, getKnobs, getModelCatalog, isSelectableModel } from './runtime-config'
import { deriveRemoteKey, type TriggerKey } from './mode-router'
import { configureRemoteLogging, createLogger, getRemoteLogFilePath } from './log'
import { fixPath } from './fix-path'
import { buildSetupChecklist, setupComplete, blockerOf, confirmationKey, type BackendProbe } from './setup-status'
import { createOverlayWindow, presentOrExpand, expandOverlay, openOverlay, dismissOverlay, setDockedMode, reconcileDock, onNewTask, getOverlayMode, setOverlayInteractive, pauseOverlayEscape, resumeOverlayEscape, setOverlaySuppressed } from './overlay'
import { registerOrchestrateShortcut, openOrchestrateWindow } from './orchestrate'
import { Router, type RoutableTask, type AgentAvailability } from './router'
import { CodexRouterEngine } from './codex-router-engine'
import { knownProjects, projectSlug } from './projects'
import { recordSkillUsage, readSkillStats, defaultStatsPath } from './skill-usage'
import { startMcpServer, MCP_PATH, type McpCreateTaskInput } from './mcp-server'
import { SESSION_PREAMBLE } from './session-policy'
import { installHookSettingsSync, hookToken } from './hooks'
import { parseHookEvent } from './observer'
import type { ExecutorFactoryOpts } from './executor'
import { startCuaServer, type CuaServer } from './cua/server'
import { NotchClient } from './notch/notch-client'
import { NotchController } from './notch/notch-controller'
import { PillController, type PillStateP } from './notch/pill-controller'
import { listCodexModels, matchCurrent, type CodexModel } from './codex/appserver'
import { listCodexCliModels, resolveCodexCliChoice, codexCliChoiceLabel } from './codex/cli-models'
import { CodexHub } from './codex/hub'
import { CodexAppServer } from './codex/app-server-client'
import { resolveCodexCli } from './codex/driver'
import { DriverManager } from './cua/driver-manager'
import { CdpLane } from './cua/lanes/cdp'
import { Arming } from './cua/lanes/arming'
import { runAppleScript } from './cua/lanes/applescript'
import { type RouterCtx } from './cua/router'
import { Presence } from './presence'
import { listImportableSessions, findSessionCwd } from './claude-cli-sessions'
import { listImportableCodexSessions, findCodexSessionCwd } from './codex/cli-session'
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
import { createClipboardWatch } from './capture/clipboardWatch'
import { createScreenshotWatch } from './capture/screenshotWatch'
import {
  adoptPersistedPad, armScratchpad, claimShared, deliveryInFlight, discard as discardPad,
  copyHistoryToClipboard, gateDelivery, heldForSurface, initWatchers, padDirOf, pasteAtCursor, recordInsert,
  registerPadObserver, registerSettings, removeFromPad, runDelivery, snapshot,
  type DeliveryTarget,
} from './capture/index'
import { SETTLE_IDLE_MS } from './capture/scratchpadStore'
import type { Entry, InsertKind } from './capture/types'
import { CaptureHistoryStore, clipboardPayload, type CaptureHistoryKind } from './capture/history-store'
import { screenCaptureVisibility } from './screen-capture-visibility'
import type { ScratchpadEntryP, ScratchpadPayloadP } from './notch/notch-client'

// ─── Loose interfaces for the OSS engine singletons we wire into ───
// Accepted as opaque shapes (like paywall/main-extensions' OSSAdapter) so we
// don't entangle with engine internals. main.ts passes its real instances.
interface SessionManagerLike {
  startRemoteCapture(targetTaskId?: string | null): void
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
const captureHistory = new CaptureHistoryStore(join(homedir(), '.unmute', 'remote', 'capture-history'))

/** Called by the ordinary dictation path after its capture composition has
 * landed. Plain speech remains in the engine session history; this companion
 * record adds copied content and images without coupling Remote to engine DB. */
export function recordCapturedDictation(input: {
  id: string
  createdAt: number
  text: string
  destination: 'cursor' | 'task'
  attachments: readonly string[]
}): void {
  if (!input.text.trim()) return
  captureHistory.archive({
    id: input.id,
    kind: 'dictation',
    createdAt: input.createdAt,
    finalizedAt: Date.now(),
    text: input.text,
    destination: input.destination,
    attachments: input.attachments,
  })
}

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
  // Codex CLI's model, in Codex's own vocabulary ('gpt-5.1-codex-max'). A
  // SEPARATE KEY from `model` because the two backends share no ids, and Codex
  // takes whatever it is given (`-c model="…"` is a TOML override, valid for
  // any string) — so a Claude alias stored here would not be rejected, it would
  // run and fail at the API. 'default' ⇒ whatever Codex is already set to.
  //
  // DECLARED HERE rather than written as `settings.get('codexCliModel' as never)`,
  // which is how it started life. An untyped key has no default, so every read
  // site invented its own fallback and the compiler could not tell a typo from
  // a key.
  codexCliModel: string
  // Codex CLI's reasoning effort, as a WIRE value ('xhigh', not 'Extra High').
  // Efforts belong to a model — Sol and Terra offer six, Luna five — so this is
  // only ever meaningful alongside codexCliModel, and picking a model resets it
  // to that model's default. '' ⇒ whatever the model defaults to.
  codexCliEffort: string
  /** Has the user agreed that unmute-launched Codex CLI tasks may run with full
   *  access to their Mac?
   *
   *  DEFAULT FALSE, and it gates REACH only — not whether we interrupt them.
   *  Without it, Codex tasks run at its own defaults (workspace-write, ask on
   *  request), which is what a person gets typing `codex` themselves. Granting
   *  the whole machine is a decision the user makes once, knowingly, and can
   *  take back; assuming it because `permissionMode` happens to say
   *  auto-approve would be reading a convenience setting as consent to
   *  something much larger. */
  codexFullAccessConsent: boolean
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
  /** Open the task surface when something starts needing you, rather than only
   *  tinting the bar amber and waiting for a tap. Default true. */
  notchAutoExpand: boolean
  /** Show a CLI task's terminal the moment it opens. Default off. */
  notchTerminalAutoExpand: boolean
  /** Speak short confirmations ("On it.") through the macOS `say` voice.
   *  DEFAULT OFF — see speakLine for why. */
  voiceFeedback: boolean
  /** Share of the screen an expanded surface fills: 0.7 | 0.8 | 0.9. */
  surfaceFill: number
  /** Whether the notch and recording pill appear in screenshots and sharing. */
  showInScreenCapture: boolean
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
  // Capture: copies and screenshots made during a hot mic land in the
  // transcript at the position they happened. Replaces `screenshotCapture`,
  // widened to cover text as well as images.
  captureEnabled: boolean
  // The scratchpad: can a capture be HELD instead of delivered on stop?
  // Independent of captureEnabled — see capture/captureGate.ts.
  scratchpadEnabled: boolean
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
    // EMPTY, not 'default'. '' means "we have no opinion — run whatever Codex
    // is already set to", which is the honest state for a user who has never
    // opened the picker. The old value was the literal string 'default', an id
    // from the invented catalogue that no Codex has ever had.
    codexCliModel: '',
    codexCliEffort: '',
    codexFullAccessConsent: false,
    browserEnabled: true,
    setupConfirmations: {},
    osNotifications: false,
    overlayAutoPresent: true,
    notchAutoExpand: true,
    // OFF — the behaviour that shipped. The terminal stays one tap away.
    notchTerminalAutoExpand: false,
    voiceFeedback: false,
    surfaceFill: 0.8,
    showInScreenCapture: true,
    overlayDocked: true,
    librarianWriteEnabled: false,
    forceRawMode: false,
    voiceHeadlines: true,
    captureEnabled: true,
    scratchpadEnabled: true,
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
 * backend today.
 */
async function probeBackends(): Promise<BackendProbe[]> {
  const out: BackendProbe[] = []
  for (const p of Object.values(PROVIDERS)) {
    if (p.transport === 'pty') {
      // An owned-PTY backend needs ITS OWN CLI on the PATH the executors get.
      //
      // This asked `claudeCliAvailable()` for every PTY backend and skipped
      // Codex outright, which is why Codex CLI never appeared in the picker
      // however installed and ready it was. Two faults in three lines: a probe
      // hard-coded to one binary, and an explicit `continue` past the provider
      // the registry already described.
      //
      // Asking each backend about its own binary is the whole point of walking
      // the registry — otherwise the loop is a two-entry literal wearing a for.
      const ok = p.id === 'codex' ? await codexCliAvailable() : await claudeCliAvailable()
      out.push({ id: p.id, label: p.label, installed: ok, ready: ok, ...(ok ? {} : { reason: 'not-installed' }) })
      continue
    }
    // A driven app: installed is not enough — it has to be reachable as well,
    // which is the state the user has no other way of discovering.
    //
    // Ask the driver that serves THIS provider. This used to read `codexDriver`
    // for every driver-transport backend, which was correct only while exactly
    // one existed. The moment a second was registered, the new backend reported
    // CODEX's readiness as its own — so a connected Codex would have shown
    // Claude desktop as ready and selectable with nothing behind it. A backend
    // with no driver yet is honestly "not installed" rather than borrowing
    // someone else's answer.
    const driver = driverForProvider(p.id)
    if (!driver) { out.push({ id: p.id, label: p.label, installed: false, ready: false, reason: 'not-installed' }); continue }
    try {
      const a = await driver.availability()
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
  // The blocker travels WITH the status so no surface has to guess which step
  // matters most — the old nudge named the Chrome extension unconditionally.
  const blocker = blockerOf(steps)
  log.event('setup-status', { complete, blocker, todo: steps.filter((s) => s.status === 'todo').map((s) => s.key) })
  return { steps, complete, blocker }
}

let manager: TaskManager | null = null
/** Unsent replies are task-scoped, not owned by any one expanded surface. */
const taskDrafts = new TaskDraftStore()

function draftDeliveryText(text: string, paths: string[]): string {
  return paths.length ? `${text}${text ? '\n\n' : ''}${paths.map((path) => `[image: ${path}]`).join('\n')}` : text
}

async function addDraftImageFromPath(id: string, sourcePath: string, mimeType: string, name: string): Promise<void> {
  if (!manager || !manager.get(id)) return
  const data = await fs.readFile(sourcePath)
  const ext = (basename(name).split('.').pop() || mimeType.split('/').pop() || 'png').replace(/[^a-z0-9]/gi, '')
  const path = await manager.attachFile(id, data, ext)
  if (path) taskDrafts.addAttachment(id, { id: randomUUID(), path, mimeType, name: name || basename(path) })
}

async function deliverTaskDraftSnapshot(id: string, draft: import('./task-draft').TaskDraft): Promise<boolean> {
  if (!manager) return false
  const task = manager.get(id)
  if (!task) return false
  const text = draftDeliveryText(draft.text, isExternalAgent(task.agent) ? [] : draft.attachments.map((attachment) => attachment.path))
  if (!text.trim()) return false
  const accepted = draft.attachments.length
    ? await manager.deliverDraft(id, text, draft.attachments.map((attachment) => attachment.path))
    : manager.tasksAwaitingUser().some((entry) => entry.id === id)
    ? manager.answer(id, text)
    : manager.followUp(id, text)
  return accepted
}

async function sendTaskDraft(id: string): Promise<boolean> {
  const draft = taskDrafts.snapshot(id)
  if (!draft) return false
  const accepted = await deliverTaskDraftSnapshot(id, draft)
  if (accepted) taskDrafts.clearIfUnchanged(id, draft)
  return accepted
}
/** The Codex CLI App Server. One per app; started lazily by the hub itself. */
let codexHub: CodexHub | null = null
/** Codex desktop backend — inert until a task targets it (see codex/driver.ts). */
let codexDriver: CodexDesktopDriver | null = null
/** Claude desktop backend, READ half — see claude-desktop/driver.ts. */
let claudeDesktopDriver: ClaudeDesktopDriver | null = null
/** Claude desktop LIVE state — see claude-desktop/ax.ts. */
let claudeDesktopAx: ClaudeDesktopAx | null = null
/** Claude desktop focus-stealing actions — see claude-desktop/actuate.ts. */
let claudeActuator: ClaudeActuator | null = null

/** The minimum a probe needs from a desktop driver. Declared structurally so a
 *  second backend does not have to inherit CodexDesktopDriver to be probed. */
interface ProbeableDriver {
  availability(): Promise<{ ok: boolean; reason?: string }>
}

/**
 * Which driver serves a backend, or null if it has none yet.
 *
 * Exists so "is this backend ready" is answered by ITS OWN driver. The probe
 * loop previously reached straight for codexDriver, which was indistinguishable
 * from correct while Codex was the only driven app — and silently wrong the
 * moment a second one was registered.
 *
 * A backend with no driver yet stays absent here on purpose, so it reports
 * not-installed rather than borrowing another backend's availability.
 */
function driverForProvider(id: ProviderId): ProbeableDriver | null {
  if (id === 'codex-desktop') return codexDriver
  if (id === 'claude-code-desktop') return claudeDesktopDriver
  return null
}

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
export async function claudeCliAvailable(): Promise<boolean> {
  return cliOnPath('claude', 'claude-cli-availability')
}

/** Is the Codex CLI installed? Same contract as Claude's: a `which`, cached for
 *  a minute. The router may only ever name a backend that appears in
 *  agentAvailability, so without this a Codex CLI task could be promised to
 *  someone who does not have it and would fail at spawn with nothing useful
 *  said — the shape of the setup-probe bug. */
export async function codexCliAvailable(): Promise<boolean> {
  return cliOnPath('codex', 'codex-cli-availability')
}

const cliCache = new Map<string, { at: number; ok: boolean }>()

async function cliOnPath(bin: string, event: string): Promise<boolean> {
  const hit = cliCache.get(bin)
  if (hit && Date.now() - hit.at < 60_000) return hit.ok
  const ok = await new Promise<boolean>((resolve) => {
    execFile('/usr/bin/which', [bin], { env: process.env }, (err, stdout) => {
      resolve(!err && !!String(stdout).trim())
    })
  })
  if (hit?.ok !== ok) log.event(event, { ok })
  cliCache.set(bin, { at: Date.now(), ok })
  return ok
}

/**
 * The Claude Desktop models to OFFER, minus any proven unavailable.
 *
 * Per-family matches the real menu for four of five. The fifth — Mythos 5 —
 * is in the bundle and not in the menu, and nothing on disk says which. So a
 * model that FAILS to select is remembered and stops being offered: the list
 * corrects itself from what the app actually does, instead of us guessing which
 * entries are plan-gated.
 */
async function offeredClaudeDesktopModels(): Promise<Array<{ id: string; label: string; effortLevels: string[]; defaultEffort: string | null }>> {
  const all = offeredClaudeModels(await readClaudeCatalog())
  const dead = new Set((settings.get('claudeDesktopUnavailableModels' as never) as string[] | undefined) ?? [])
  return all.filter((m) => !dead.has(m.label))
}

/**
 * Switch Claude Desktop's model.
 *
 * Addressed BY NAME — the actuator types the model's own label at the menu, so
 * nothing here depends on menu order or position. That replaced a
 * position-counting scheme plus an offset-calibration step, both of which
 * existed only because we could not read the menu; type-ahead means we no
 * longer have to.
 *
 * Steals focus, unavoidably: the popup opens only for a real click.
 */
async function setClaudeDesktopModel(id: string): Promise<void> {
  if (!claudeActuator) return
  const target = (await offeredClaudeDesktopModels()).find((m) => m.id === id)
  if (!target) { log.warn('claude-desktop-model-unknown', { id }); return }

  const res = await claudeActuator.setModel(target.label).catch(() => ({ ok: false as const, reason: 'threw' }))
  if (!res.ok) {
    // Offered by the bundle, refused by the app — the gap the bundle cannot
    // describe (a plan-gated model looks identical on disk). Stop offering it
    // rather than letting the user meet the same dead row again.
    const dead = new Set((settings.get('claudeDesktopUnavailableModels' as never) as string[] | undefined) ?? [])
    dead.add(target.label)
    settings.set('claudeDesktopUnavailableModels' as never, [...dead] as never)
    log.warn('claude-desktop-model-unavailable', {
      label: target.label,
      landedOn: (res as { landedOn?: string }).landedOn ?? null,
      note: 'in the bundle, not selectable in the app — no longer offered',
    })
  }
  void pushPillChips()
}

async function agentAvailability(): Promise<AgentAvailability> {
  const agents: ProviderId[] = []
  if (await claudeCliAvailable()) agents.push('claude')
  // Codex CLI stands on its own footing, separate from Codex DESKTOP below:
  // having the app says nothing about having the binary, and vice versa.
  if (await codexCliAvailable()) agents.push('codex')
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
  // Claude desktop, on the same terms: offered only when its own driver says it
  // is reachable. This list used to be a two-member literal with two pushes, so
  // a third backend could never appear in the picker however ready it was —
  // which is why the only way to get a Claude Desktop task was to start the
  // chat in that app and wait for the adoption sweep.
  if (claudeDesktopDriver) {
    try {
      if ((await claudeDesktopDriver.availability()).ok) agents.push('claude-code-desktop')
    } catch { /* same best-effort contract as above */ }
  }
  // Prefer what the user chose, but never offer a backend they cannot run. With
  // neither present we still report 'claude' so the caller has something to
  // name in an error — reporting an empty list would read as "no agents" to
  // every consumer and hide the real problem.
  // Honour the stored choice whenever that backend is actually reachable —
  // written per-backend, this needed a new clause for every provider and
  // silently ignored the stored value for any backend nobody had added one for.
  const stored = settings.get('agent') as ProviderId | undefined
  const preferred: ProviderId =
    stored && stored !== 'claude' && agents.includes(stored) ? stored
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

/** Unmute's own directory. Everything Unmute writes lives here — never in the
 *  user's working directory. That is the rule session-policy.ts exists to keep. */
const REMOTE_BASE_DIR = join(homedir(), '.unmute', 'remote')

/** Path of the shared hook-settings file, once written. Null until then (and on
 *  failure), in which case sessions launch with no `--settings` and fall back to
 *  status-file polling alone. */
let hookSettingsFile: string | null = null

/** Shared secret the lifecycle hooks present when they POST an event. Read from
 *  disk and STABLE ACROSS LAUNCHES — a task's tmux session outlives the app, so a
 *  per-process token meant every hook from a surviving session was rejected by
 *  our own auth check. See hooks.hookToken(). */
const HOOK_TOKEN = hookToken(REMOTE_BASE_DIR)

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
    // ...and WHICH MODEL of that backend actually ran it. Read STRAIGHT OFF THE
    // TASK, where it was written once at dispatch and persisted to meta.json.
    //
    // Not `settings.get('model')`, not `getModels()`, not the catalogue — a
    // live lookup here would repaint every historical card with the picker's
    // current value, so a task that ran on Sonnet yesterday would claim Opus
    // today and look entirely correct doing it (launch decision D6).
    //
    // Left `undefined` rather than coerced when the task has none: an old task
    // predating this field renders agent-only, which is honest, and a default
    // would be indistinguishable from a real answer.
    model: t.model,
    codexProject: t.codexProject ?? null,
    // The GUI-agent equivalent of the terminal (see Task.conversation).
    conversation: t.conversation ?? null,
    state: t.state,
    category: t.category ?? null,
    step: t.step ?? null,
    // WHAT IT IS DOING RIGHT NOW. Carried as the structured Activity rather
    // than a pre-rendered sentence so the surface can style it (and one day
    // group by it) instead of parsing prose back apart.
    // `undefined`, not null: absent means "not doing anything right now", and
    // TaskLite's optional field says exactly that. A null would have to be
    // handled as a third case by every reader.
    codexActivity: t.codexActivity,
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

/**
 * The model Claude Code is launched with — ONE resolution, used both to build
 * the executor (its `--model` argument) and to record what ran on the task.
 *
 * EMPTY MEANS THE USER'S OWN DEFAULT, and we pass no `--model` at all.
 *
 * This used to fall back to `getModels().doerDefault` ('sonnet'), which pinned
 * EVERY Unmute task to our default and silently overrode the user's own Claude
 * Code configuration. For anyone whose personal default is stronger than ours,
 * every task ran on a weaker model than the sessions they were comparing it to,
 * with nothing anywhere saying so — the most likely single cause of "Claude Code
 * works worse inside Unmute". A picker choice is still honoured, because that is
 * the user's decision; the absence of one is not our invitation to decide.
 *
 * Downstream (D6) an absent model means the card renders the agent alone rather
 * than inventing a value — which was already the documented rule.
 */
function doerModel(): string {
  return settings.get('model') || ''
}

/** Ceiling on the Codex model read at dispatch. The app-server answers in ~1ms;
 *  this only bounds the pathological case so a dispatch can never hang on it. */
const CODEX_MODEL_READ_MS = 1500

/**
 * What a NEW Codex thread will run on, in CODEX'S OWN vocabulary ("5.6 Sol High").
 *
 * Two sources, in order, and both belong to Codex rather than to us:
 *
 *   1. The pick we are about to APPLY to the thread (dispatchCodexDesktop
 *      passes it to createTask). If the user chose a model, that is what runs.
 *   2. Otherwise the thread inherits whatever Codex is currently set to, and
 *      the reasoning button's own label is the only thing that reports it — the
 *      cache is a verbatim record of that read, not a setting of ours.
 *
 * The label is then canonicalised against Codex's own catalogue (`model/list`
 * over the app-server: headless, no window, no arming). NON-FATAL BY
 * CONSTRUCTION: listCodexModels resolves `[]` on a missing app, a timeout or a
 * protocol change, matchCurrent then matches nothing, and the raw label is
 * recorded instead. A closed Codex costs this dispatch nothing.
 *
 * Returns undefined when Codex has told us nothing — dispatch then records no
 * model at all, which is the honest answer (D6, §3).
 */
async function codexDesktopModel(): Promise<string | undefined> {
  const picked = (settings.get('codexModel' as never) as string) || undefined
  const effort = (settings.get('codexEffort' as never) as string) || undefined
  const cached = settings.get('codexReasoningCache' as never) as { label?: string | null } | undefined
  const label = picked ? [picked, effort].filter(Boolean).join(' ') : (cached?.label ?? '').trim()
  if (!label) return undefined
  const models = await listCodexModels({ timeoutMs: CODEX_MODEL_READ_MS }).catch(() => [] as CodexModel[])
  const cur = matchCurrent(label, models)
  return cur.model ? [cur.model, cur.effort].filter(Boolean).join(' ') : label
}

/* ─── One model choice per backend ──────────────────────────────────────────
 *
 * Which key holds a backend's model is answered by the registry
 * (`providerOf(agent).modelSetting`), and these two functions are the only
 * things that touch it. Three surfaces ask the same question — the pill chip,
 * the Remote settings screen, and the executor at spawn — and before this they
 * each answered it themselves. The settings screen answered wrong: it wrote
 * Claude's `model` key from a picker labelled Codex, so choosing a Codex model
 * changed what your CLAUDE tasks ran on and left Codex untouched.
 *
 * A backend whose `modelSetting` is null owns its own choice (the desktop apps
 * — you set the model in the app and Unmute reads it back). Reading gives ''
 * and writing is refused, rather than falling through to Claude's key.
 */

/**
 * Codex CLI's live model list plus the user's resolved choice within it.
 *
 * SELF-HEALING, and that is the point of routing every surface through here.
 * `codex update` can retire a model out from under a stored setting — which is
 * not hypothetical, it is exactly what happened to the four invented ids this
 * replaced. A stored value Codex no longer offers is CLEARED here, so the spawn
 * path (which is synchronous and cannot re-ask) can never pass an id that would
 * start a task and fail at the API.
 *
 * Nothing is cleared when the list is empty: a Codex that could not be asked is
 * not a Codex that dropped your model.
 */
async function codexCliChoice(): Promise<{ models: CodexModel[]; model?: CodexModel; effort?: string }> {
  const models = await listCodexCliModels().catch(() => [] as CodexModel[])
  const storedModel = settings.get('codexCliModel') || undefined
  const storedEffort = settings.get('codexCliEffort') || undefined
  const r = resolveCodexCliChoice(models, storedModel, storedEffort)
  if (models.length && storedModel && !r.model) {
    log.warn('codex-cli-choice-healed', { storedModel, storedEffort: storedEffort ?? null, reason: 'no longer offered' })
    settings.set('codexCliModel', '')
    settings.set('codexCliEffort', '')
  } else if (models.length && storedEffort && r.model && !r.effort) {
    log.warn('codex-cli-effort-healed', { model: r.model.id, storedEffort })
    settings.set('codexCliEffort', '')
  }
  return { models, ...r }
}

/**
 * Record a Codex CLI axis pick.
 *
 * The values arriving here are MENU SPELLINGS ('5.6 Terra', 'Extra High'),
 * because that is what the picker displayed and a control must hand back what
 * it showed. They are translated to wire ids against the live list, and a value
 * that matches nothing is refused rather than stored: an unmatched string
 * written to `codexCliModel` would reach Codex as `-c model="5.6 Terra"`, which
 * is valid TOML for a model that does not exist.
 *
 * PICKING A MODEL RESETS THE EFFORT to that model's default, because efforts
 * belong to models — carrying 'ultra' from Sol onto Luna, which has no 'ultra',
 * would silently produce an invalid pair.
 */
async function pickCodexCliAxis(axis: 'Model' | 'Effort' | 'Speed', value: string): Promise<void> {
  // Codex CLI has no Speed axis — that one is the desktop app's. It never
  // appears in the chips built above, so arriving here means a stale payload.
  if (axis === 'Speed') { log.warn('codex-cli-pick-ignored', { axis, value, reason: 'no such axis' }); return }
  const { models, model: currentModel } = await codexCliChoice()
  if (!models.length) { log.warn('codex-cli-pick-ignored', { axis, value, reason: 'no model list' }); return }

  if (axis === 'Model') {
    const picked = models.find((m) => m.uiLabel === value)
    if (!picked) { log.warn('codex-cli-pick-ignored', { axis, value, offered: models.map((m) => m.uiLabel) }); return }
    settings.set('codexCliModel', picked.id)
    settings.set('codexCliEffort', picked.defaultEffort ?? '')
    log.event('codex-cli-pick', { axis, model: picked.id, effort: picked.defaultEffort ?? null })
  } else {
    const target = currentModel ?? models[0]
    const i = target.effortLabels.indexOf(value)
    if (i < 0) { log.warn('codex-cli-pick-ignored', { axis, value, model: target.id, offered: target.effortLabels }); return }
    // An effort pick on a model the user never explicitly chose pins that model
    // too — otherwise the effort would apply to whatever Codex defaults to next.
    settings.set('codexCliModel', target.id)
    settings.set('codexCliEffort', target.efforts[i])
    log.event('codex-cli-pick', { axis, model: target.id, effort: target.efforts[i] })
  }
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('remote:model-changed', settings.get('codexCliModel'))
  }
  void pushPillChips()
}

/** An effort's menu spelling for a given model ('xhigh' → 'Extra High'), or
 *  undefined. Index-aligned lookup rather than a re-derivation, because the two
 *  spellings are not a transform of each other — 'low' prints as 'Light'. */
function effortLabelOf(model: CodexModel | undefined, effort: string | undefined): string | undefined {
  if (!model || !effort) return undefined
  const i = model.efforts.indexOf(effort)
  return i >= 0 ? model.effortLabels[i] : undefined
}

/**
 * What to pass Codex at spawn: a wire model id and effort, or nothing.
 *
 * NOTHING IS A VALID ANSWER — it means "run on whatever Codex is already set
 * to", which is what a user who never opened the picker wants, and it is also
 * what they get in their own terminal. The alternative that shipped was the
 * literal string 'default' from the invented catalogue, which as `-c
 * model="default"` would have Codex look up a model by that name.
 *
 * Read SYNCHRONOUSLY off settings, which is safe only because every surface
 * that writes them goes through codexCliChoice() and clears a value Codex no
 * longer offers. If that self-heal is ever bypassed, this is where a retired
 * model id would reach the API.
 */
function codexCliSpawnArgs(): { model?: string; effort?: string } {
  const model = settings.get('codexCliModel') || undefined
  const effort = settings.get('codexCliEffort') || undefined
  // An effort without a model is meaningless — efforts are a property OF a
  // model, and Codex would apply it to whichever model it defaults to.
  return model ? { model, effort } : {}
}

/** Just the model id, for the places that record what a task ran on. */
function codexCliModelArg(): string | undefined {
  return codexCliSpawnArgs().model
}

/** What this backend is currently set to run on. '' when the backend owns the
 *  choice itself. */
function currentModelFor(agent: AgentKind): string {
  const key = providerOf(agent).modelSetting
  if (!key) return ''
  if (key === 'model') return settings.get('model') || getModels().doerDefault
  return settings.get('codexCliModel') || ''
}

/**
 * Record a model pick for a backend. Returns the value actually stored, or null
 * if the pick was refused.
 *
 * VALIDATED AGAINST THAT BACKEND'S OWN CATALOG. An id from another backend is
 * refused outright rather than coerced: a Codex id silently replaced by Claude's
 * default is a menu that appears to work and quietly moves a different setting.
 */
function setModelFor(agent: AgentKind, m: string): string | null {
  const p = providerOf(agent)
  const key = p.modelSetting
  if (!key) { log.warn('model-pick-refused', { agent, reason: 'backend owns its own model' }); return null }
  // A BACKEND WHOSE MODELS COME FROM ITS OWN BINARY IS NOT PICKED HERE. Codex
  // CLI's choice is a (model, effort) pair validated against a live list, which
  // this function cannot do synchronously — it goes through pickCodexCliAxis.
  // Falling through would validate a Codex id against Unmute's catalogue, which
  // has no Codex entries by design, and reject every legitimate pick.
  if (p.modelSource !== 'catalog') {
    log.warn('model-pick-refused', { agent, reason: `models come from ${p.modelSource}`, model: m })
    return null
  }
  if (!isSelectableModel(m, agent)) { log.warn('pick-model-rejected', { agent, model: m }); return null }
  if (key === 'model') {
    settings.set('model', m)
    settings.set('modelUserSet', true) // explicit choice — never auto-migrate it
  } else {
    settings.set('codexCliModel', m)
  }
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('remote:model-changed', m)
  }
  log.event('model-set', { agent, model: m })
  return m
}

/**
 * The model to RECORD on a task at dispatch — a historical fact (D6).
 *
 * Resolved ONCE, here, at the moment the work starts, from whatever the chosen
 * backend is actually about to run on. Nothing downstream ever recomputes it:
 * serializeTask reads `t.model` straight off the task, so a card drawn tomorrow
 * shows what ran today no matter where the picker has moved since.
 */
async function modelForDispatch(agent: AgentKind | undefined): Promise<string | undefined> {
  // Mirrors TaskManager.dispatch's OWN default exactly: an absent agent means
  // Claude Code, not the picker's current value. Reading the picker here would
  // resolve a Codex model for a task that lands on Claude — the plausible lie
  // in its purest form.
  switch (agent ?? 'claude') {
    case 'claude':
      return doerModel()
    case 'codex-desktop':
      return codexDesktopModel()
    case 'claude-code-desktop':
      // Claude Desktop names the model per conversation in its OWN session
      // store, and the manager reads it there — which covers both entry points
      // (a conversation we start and one we adopt). Resolving it here would
      // cover only the first, and would attribute the composer's CURRENT model
      // to conversations that never ran on it.
      return undefined
    case 'codex':
      // Codex CLI keeps its own setting, like every other backend: its ids are
      // its own vocabulary ('gpt-5.6-terra'), and sharing Claude's key would
      // record — and then RUN — a model the target does not have.
      // Absent means Codex's own default, which is the honest answer for a user
      // who has never opened the picker. Recorded WITH THE EFFORT, in Codex's
      // own spelling — its header reads `model: gpt-5.6-terra xhigh`, and the
      // model alone would not say what the task actually ran at.
      {
        const { model, effort } = codexCliSpawnArgs()
        return model ? [model, effort].filter(Boolean).join(' ') : undefined
      }
    default:
      return undefined
  }
}

function executorFactory(resume = false, forTask?: AgentKind, factoryOpts?: ExecutorFactoryOpts) {
  const mode = settings.get('permissionMode')
  // WHOSE BACKEND IS THIS? `forTask` = the agent an EXISTING task was created on;
  // it always wins. The global picker answers only "what should NEW work run on",
  // and using it for a resume is what made every Claude session unresumable the
  // moment the picker was flipped to Codex (field report 2026-07-28).
  const agent: AgentKind = forTask ?? settings.get('agent')
  const sandboxRoots = settings.get('sandboxRoots') ?? []
  const sandboxed = sandboxRoots.length > 0
  // THE MODEL OF THE BACKEND BEING BUILT, not Claude's. This line read
  // `doerModel()` unconditionally, so a Codex spawn logged whatever the Claude
  // picker happened to say — the one record of what a task started on, naming a
  // model from the other vendor. (The Claude path below still uses `model`; the
  // Codex branch reads its own key.)
  const model = providerOf(agent).modelSetting === 'model' ? doerModel() : (codexCliModelArg() ?? '')
  // TWO gates now, not one. The setting is the user's master switch; the caller
  // says whether THIS task actually touches a browser. Unconditional --chrome
  // put a browser tool surface into every coding session, and the old contract
  // then told it the browser was its "default tool for anything web" — wrong
  // guidance and extra tool surface for work that never opens a page.
  const browser = settings.get('browserEnabled') !== false && factoryOpts?.browser !== false
  log.event('executor-factory', { agent, forTask: forTask ?? null, permissionMode: mode, sandboxed, sandboxRoots, model: model || '(user default)', browser, resume })
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
    // A GUARD LIVED HERE THAT THREW ON RESUME, and it was right: Codex's
    // continuation is not Claude's, so building a plain executor would have
    // spawned a brand-new context-free REPL behind a button promising "continue
    // with full context". Failing loudly beat that.
    //
    // It is wired now. `codexArgs` emits `codex resume <id>` — a subcommand,
    // not a flag — and `resume()` proves the session exists by finding its
    // rollout rather than asking Claude's transcript resolver. So the guard
    // would now refuse the very thing it was protecting.
    //
    // The model is read here rather than baked into the executor: the picker
    // writes `codexCliModel`, and it reaches Codex as `-c model="…"` (TOML
    // config, NOT --model — see codexArgs).
    // ATTACHED TO A THREAD when the App Server owns the conversation: the PTY
    // is then a VIEW of that thread, not a second one. The model/effort are
    // already baked into the thread by `thread/start`, so they are not repeated
    // here — see modelArgs in codex-executor.ts.
    if (factoryOpts?.codexRemote) return new CodexExecutor({ remote: factoryOpts.codexRemote })
    return new CodexExecutor(codexCliSpawnArgs())
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
    // Empty ⇒ NO --model flag ⇒ the user's own Claude Code default. See doerModel().
    ...(model ? { model } : {}),
    chrome: browser,
    // Lifecycle hooks + the four-line framing. Both point at files/strings we
    // own, so a session is fully instrumented with NOTHING written into the
    // user's working directory (session-policy.ts).
    ...(hookSettingsFile ? { settingsPath: hookSettingsFile } : {}),
    appendSystemPrompt: SESSION_PREAMBLE,
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
  // The pill's model/agent chips come from HERE, not from the capture renderer:
  // main owns the setting and the config-driven catalog, so a second copy in the
  // renderer could only ever disagree. Resolved once as the capture opens —
  // availability changes rarely (Codex opened or closed), and the answer is only
  // needed at the moment the chips appear.
  if (phase === 'listening') void pushPillChips(taskId ?? null)
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('remote:capture-phase', { phase, taskId: taskId ?? null })
  }
  notchController?.notifyCapturePhase(phase, taskId ?? null)
  // THE POCKET DOES NOT OPEN ITSELF. It used to bloom here, the moment the mic
  // went hot — which meant every single utterance had a task on screen, and
  // under "open is aimed" that would make every utterance aim at one. Opening
  // is the user's decision; pressing the key is not opening.
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
async function pushPillChips(taskId: string | null = null): Promise<void> {
  if (!pillController) return
  try {
    const addressed = taskId ? manager?.get(taskId) : undefined
    // An addressed capture is a reply to an existing thread. Its provider is
    // immutable here; only an unaddressed capture reads the new-task default.
    const agent = addressed?.agent ?? (settings.get('agent') as AgentKind) ?? 'claude'
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
    // EVERY reachable backend, from the same probe the picker and setup card
    // use. This was a two-entry literal, so the pill could not show a third
    // backend even while agent-options was already offering it.
    const probes = await probeBackends()
    const agentOptions = probes.map((p) => ({
      id: p.id, label: p.label, available: p.ready,
      terminal: providerOf(p.id as ProviderId).hasTerminal,
    }))
    const selected = agentOptions.find((o) => o.id === agent)
    const chips: PillStateP = {
      taskId: addressed?.id ?? null,
      // The LABEL comes from the registry rather than a ternary, so a new
      // backend names itself instead of falling through to "Claude Code".
      agent: selected?.label ?? providerOf(agent).label,
      agentConnected: selected?.available ?? true,
      agentOptions,
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
      chips.modelEmpty = 'Connect Codex to choose a model'
      // RAW is not offered on Codex at all — dispatchCodexDesktop returns before
      // `mode` is ever read and then records 'managed', so there is nothing for
      // raw to skip. A control that cannot act is worse than no control.
      chips.raw = null
    } else if (agent === 'claude-code-desktop') {
      // Claude desktop's OWN catalogue, read from its app bundle. Falling
      // through to Claude Code's list below would offer aliases ('opus',
      // 'opusplan') that this app does not use — the same wrong-list bug the
      // Codex branch above exists to prevent, one backend later.
      const models = await offeredClaudeDesktopModels()
      chips.modelOptions = models.map((m) => ({
        id: m.id,
        label: m.label,
        detail: m.effortLevels.length ? `effort: ${m.effortLevels.join(' · ')}` : '',
      }))
      // An EMPTY catalogue means the bundle could not be parsed. Show nothing
      // selectable and keep whatever the composer is already set to — a wrong
      // list is worse than no list.
      // The pill shows what a NEW task will actually start on: the composer's
      // own current setting, read live and backgrounded. Falling back to a
      // placeholder only when the app is not readable — an empty chip would
      // read as "no model", which is never true here.
      const composer = claudeDesktopAx ? await claudeDesktopAx.composer().catch(() => ({ model: null, effort: null })) : { model: null, effort: null }
      chips.model = composer.model
        ? (composer.effort ? `${composer.model} · ${composer.effort}` : composer.model)
        : 'From Claude Desktop'
      chips.modelAxes = []
      chips.modelEmpty = 'Open Claude desktop to choose a model'
      // Unmute owns no process here, so there is no injection for raw to skip.
      chips.raw = null
    } else if (agent === 'codex') {
      // CODEX CLI HAS ITS OWN LIST AND ITS OWN SETTING. It used to fall into the
      // Claude branch below — same wrong-list bug the two branches above exist
      // to prevent, one backend later, and this time in the builder rather than
      // the IPC handler. Two places answer "what models does this backend
      // have", and fixing one is not fixing it.
      //
      // Sharing Claude's `model` key would be worse than the wrong labels: the
      // id is passed as `-c model="opus"`, which is valid TOML for a model
      // Codex does not have, so it fails at the API rather than the picker.
      // ASKED OF CODEX, NOT LISTED HERE. This branch used to read a hardcoded
      // catalogue of four ids that were never checked against a running Codex —
      // 'Codex Max', 'Codex', 'Codex Mini' — none of which exist. The real
      // codex-cli 0.147 offers six models under different names entirely, and
      // the line-up turned over completely from the release before it.
      const { models, model, effort } = await codexCliChoice()
      chips.model = codexCliChoiceLabel(model, effort ?? model?.defaultEffort)
      // TWO AXES, because Codex's own picker has two: its header reads
      // `model: gpt-5.6-terra xhigh` and the menu is titled "Select Model and
      // Effort". The line this replaces asserted "Codex CLI exposes no effort
      // axis", which was never true — it was true of the invented catalogue.
      //
      // Efforts follow the SELECTED model rather than being a flat list: Sol and
      // Terra offer six, Luna five, the 5.4/5.5 family four. Offering a model's
      // efforts under another model is the same class of lie as the wrong list.
      const shown = model ?? models[0]
      chips.modelAxes = models.length
        ? [
          { axis: 'Model', values: models.map((m) => m.uiLabel), current: shown?.uiLabel },
          { axis: 'Effort', values: shown?.effortLabels ?? [],
            current: effortLabelOf(shown, effort ?? shown?.defaultEffort) },
        ].filter((a) => a.values.length > 0)
        : []
      // EMPTY, not the catalogue. With axes carrying the choice, a flat list
      // would be a second control for the same setting — and `push` MERGES, so
      // an absent key keeps the previous backend's list (the bug the Codex
      // desktop branch documents above).
      chips.modelOptions = []
      chips.modelEmpty = 'Unmute couldn’t reach the codex command'
      chips.raw = injectionDisabled()
    } else {
      const catalog = getModelCatalog()
      const current = addressed?.model || currentModelFor('claude')
      chips.model = catalog.find((c) => c.id === current)?.label ?? current
      chips.modelOptions = catalog.map((c) => ({
        id: c.id, label: c.label, detail: c.description ?? '',
      }))
      chips.modelAxes = []          // same reasoning — clear, do not omit
      chips.modelEmpty = 'No models available'
      chips.raw = injectionDisabled()
    }

    // An addressed task's persisted receipt is the truth while replying;
    // settings describe only a future, unaddressed task.
    if (addressed?.model) chips.model = addressed.model

    // WHAT WAS ACTUALLY HANDED TO THE PILL. Added after an empty Model column
    // could only be diagnosed by reading Swift: the engine logged the models it
    // read and the agent it switched to, and nothing about the payload between
    // them, so the one broken link was the only one not written down.
    log.event('pill-chips', {
      agent: chips.agent ?? null,
      model: chips.model ?? null,
      axes: (chips.modelAxes ?? []).map((a) => `${a.axis}:${a.values.length}`),
      options: chips.modelOptions?.length ?? null,
    })
    pillController.push(chips)
  } catch (e) {
    log.warn('pill chips push failed', { error: (e as Error).message })
  }
}

let screenshotDirCache: string | null = null

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

// ── The composed capture seam ───────────────────────────────────────────
//
// The two watchers live here because this is where the platform is: Electron's
// clipboard, the native change counter, fs.watch. Everything they FEED is pure
// and tested (capture/*). They are constructed once and armed/disarmed by the
// session lifecycle — never by anything here.

/** The pasteboard change counter. The addon may be absent (build failure,
 *  non-mac); -1 means "cannot observe", which the watcher treats as never
 *  firing — the same fail-quiet posture every other native-addon call site
 *  takes. */
let nativeClipCounter: { clipboardChangeCount(): number } | null = null
let nativeClipTried = false
function clipboardChangeCount(): number {
  if (!nativeClipTried) {
    nativeClipTried = true
    try {
      nativeClipCounter = require('unmute-native-paste') as { clipboardChangeCount(): number }
      if (typeof nativeClipCounter?.clipboardChangeCount !== 'function') nativeClipCounter = null
    } catch { nativeClipCounter = null }
    if (!nativeClipCounter) log.warn('clipboard change counter unavailable — capture will not observe copies', {})
  }
  try { return nativeClipCounter?.clipboardChangeCount() ?? -1 } catch { return -1 }
}

/** The pad changed. One snapshot, read once, so a surface can never see the pad
 *  and the arm state from two different instants. Exactly one place announces a
 *  pad change; the pad panel (Task 14) renders whatever lands here. */
function broadcastScratchpad(): void {
  const s = snapshot()
  // ONE SHAPE, ONE SURFACE. There used to be a raw `scratchpad:changed` push to
  // every BrowserWindow carrying `snapshot()` itself — the live pad of an
  // UNARMED capture included, which is the exact value heldForSurface exists to
  // keep off a surface. Nothing in the renderer ever listened to it. It is gone
  // rather than filtered, along with the five `scratchpad:*` IPC handlers and
  // the preload group behind it: a second shape of the same concept, reachable
  // and unfiltered, is how the filtered one gets bypassed later.
  try { notchController?.notifyScratchpad(scratchpadPayload(s)) } catch { /* helper going away */ }
  // A PAUSED PILL OUTLIVES THE PAD IT WAS ANNOUNCING UNLESS SOMETHING TAKES IT
  // DOWN. Nothing calls hideNativePill on a delivery, a discard or a disarm —
  // those end through here — so a pill left saying "Paused" over an empty
  // screen would be the same lie in the other direction. Only ever touched when
  // the pill is ACTUALLY showing paused: the renderer pushes recording and
  // processing through the same controller, and hiding one of those would kill
  // a live capture's surface.
  try {
    if (pillController?.phase === 'paused' && !pausedPillWanted()) pillController.hide()
  } catch { /* helper going away */ }
  scheduleSettleRebroadcast(s)
}

/** SETTLE, DO NOT NAG (§9) — the half that needs a clock.
 *
 *  heldForSurface stops returning a settled pad once it has been idle past the
 *  threshold, but nothing would ask it again: the pad has, by definition,
 *  stopped changing. So one timer is armed for the exact instant it crosses,
 *  and re-broadcasting then lets the panel take itself off screen. The pad is
 *  untouched on disk and one arm away, which is the whole point — the CONTENT
 *  persists while the DEMAND FOR ATTENTION decays.
 *
 *  It cannot loop: the re-broadcast finds the pad already past the threshold,
 *  computes a non-positive delay, and arms nothing. */
let settleTimer: ReturnType<typeof setTimeout> | null = null
function scheduleSettleRebroadcast(s: ReturnType<typeof snapshot>): void {
  if (settleTimer) { clearTimeout(settleTimer); settleTimer = null }
  const held = s.armed ? null : s.held
  if (!held) return
  const due = held.updatedAt + SETTLE_IDLE_MS - Date.now()
  if (due <= 0) return
  settleTimer = setTimeout(() => { settleTimer = null; broadcastScratchpad() }, due)
  ;(settleTimer as unknown as { unref?: () => void }).unref?.()
}

/** One entry, raw. What it IS, not how to draw it: the surface decides glyph,
 *  preview and duration, because that is layout and layout lives in Swift. */
function toScratchpadEntry(e: Entry): ScratchpadEntryP {
  return e.type === 'segment'
    ? { id: e.id, type: 'segment', text: e.text, startMs: e.startMs, endMs: e.endMs }
    : { id: e.id, type: 'insert', kind: e.kind, content: e.content, atMs: e.atMs }
}

/** What the native pad panel draws.
 *
 *  THE PAD IS `heldForSurface`, NOT `s.pad`. An unarmed capture has a live pad
 *  too — scaffolding for positioning inserts — and showing it meant an ordinary
 *  dictation into Slack popped a panel open the moment the user pressed ⌘C, for
 *  work that was about to be pasted automatically anyway. Worse, its Discard
 *  reached the utterance they were still speaking. See heldForSurface for the
 *  full rule; the point is that a surface may only ever show work the user
 *  actually chose to hold.
 *
 *  `delivering` is the reason Discard can be disabled honestly. Once a pad is
 *  taken for delivery it is work the user tried to SEND, and the delivery seam
 *  deliberately refuses to let discard clear it — a later failure restages it.
 *  A Discard that appeared to cancel a send would be lying about both. */
function scratchpadPayload(s = snapshot()): ScratchpadPayloadP {
  const pad = heldForSurface(s)
  return {
    enabled: settings.get('scratchpadEnabled') !== false,
    armed: s.armed,
    delivering: deliveryInFlight(),
    pad: pad ? { id: pad.id, origin: pad.origin, entries: pad.entries.map(toScratchpadEntry) } : null,
    destinations: scratchpadDestinations(),
  }
}

// ── The scratchpad's four verbs ─────────────────────────────────────────────
//
// ONE IMPLEMENTATION PER VERB, called by both the renderer's IPC handlers and
// the native pad panel's events. Two surfaces reaching the same internals is
// the contract; two surfaces with their own copies of it is how they drift.

/** THE SINGLE GATE POINT. armScratchpad applies canArmScratchpad itself and
 *  returns the state that actually resulted, so a disabled scratchpad refuses
 *  in one place and cannot half-apply. Arming is also what brings a settled pad
 *  back from a previous run. */
function armScratchpadFrom(on: boolean): boolean {
  const armedNow = armScratchpad(on)
  broadcastScratchpad()
  log.event('scratchpad-arm', { requested: on, armed: armedNow })
  return armedNow
}

function removeScratchpadEntry(id: string): void {
  removeFromPad(id, Date.now())
  broadcastScratchpad()
}

function discardScratchpad(): void {
  discardPad()
  broadcastScratchpad()
}

/** Send the pad. Returns where it landed ('cursor' or a task id), or null.
 *
 *  DELIVERY MUST NOT DESTROY HELD WORK. Rendering the pad clears it and takes
 *  pad.json with it, so from that instant until the destination accepts, the
 *  text exists only in a local variable. If nothing takes it, runDelivery puts
 *  the pad back — in memory and on disk — and the user can retry. Held work is
 *  held BECAUSE the user chose not to risk it; losing it here would be the
 *  exact failure this feature exists to prevent.
 *
 *  THE TWO DESTINATIONS FAIL DIFFERENTLY, and that is not papered over. The
 *  cursor is largely SELF-INSURING: injectOutput writes the pasteboard before
 *  it posts ⌘V and swallows a failed keystroke, so the ordinary cursor failure
 *  still leaves the text where the user can paste it — what reaches the
 *  restage path there is the case where nothing was written at all (no paste
 *  effect registered, or the write itself threw). The task path has no such
 *  property: if the router throws, the text reached nothing, and the pad is
 *  the only copy.
 *
 *  A DESTINATION BUTTON THAT IS SHOWN MUST WORK. The panel can be showing a
 *  SETTLED pad — one a previous run left behind — and the delivery seam only
 *  ever reads the LIVE slot, so without a promotion every button on such a pad
 *  was inert: `deliver()` saw a null pad, returned null, and this logged
 *  `empty: true` while nothing happened and nothing on screen changed. The only
 *  button that worked was the destructive one.
 *
 *  WHETHER IT MAY RUN AT ALL IS `gateDelivery`, in capture/, where it can be
 *  unit-tested. This handler owns the log line and the toast; the rule is not
 *  its to keep. */
async function deliverScratchpad(dest: 'cursor' | 'newTask' | 'openTask'): Promise<string | null> {
  const target: DeliveryTarget = dest === 'cursor' ? 'cursor' : dest === 'openTask' ? 'openTask' : 'newTask'

  const gate = gateDelivery()
  if (gate !== 'ok') {
    log.event('scratchpad-deliver-refused', { to: target, reason: gate })
    // No toast for 'nothing-showing': there is no panel on screen to explain
    // it, and a message about "the pad" when the user can see no pad is noise.
    if (gate !== 'nothing-showing') {
      notchController?.toast('finish the recording first — the pad is still held')
    }
    return null
  }

  // pasteAtCursor, NOT a direct injectOutput import: clipboard.ts imports FROM
  // this module, and its header records why that direction is one-way (a lazy
  // require of remote/init fails inside the bundled main, swallowed by a
  // fail-open catch). Importing it here would close exactly that loop.
  const send = target === 'cursor'
    // The attachments ride along: at the cursor an image cannot be a path, so
    // the pasteboard hands the real bytes over after the text (injectOutput).
    // A task needs nothing extra — its rendering already names each file.
    ? async (text: string, attachments: readonly string[]): Promise<string | null> =>
      ((await pasteAtCursor(text, attachments)) ? 'cursor' : null)
    : async (text: string): Promise<string | null> => {
      const mgr = manager
      if (target === 'openTask' && orchestrateFocusId && mgr?.get(orchestrateFocusId)) {
        const fid = orchestrateFocusId
        if (mgr.followUp(fid, text)) return fid
        // It couldn't take it (terminal/gone) — route it as a new task rather
        // than dropping work the user already committed.
        log.warn('focused task refused the pad — routing it as a new task', { taskId: fid })
      }
      return dispatchFromCapture(text)
    }

  const r = await runDelivery(target, send, broadcastScratchpad)
  if (r.landed) {
    if (r.delivered) {
      captureHistory.archive({
        id: r.delivered.pad.id,
        kind: 'scratchpad',
        createdAt: r.delivered.pad.createdAt,
        finalizedAt: Date.now(),
        text: r.delivered.text,
        destination: target === 'cursor' ? 'cursor' : 'task',
        taskId: target === 'cursor' ? undefined : r.landed,
        attachments: r.delivered.attachments,
      })
    }
    log.event('scratchpad-delivered', { to: target, landed: r.landed })
    return r.landed
  }
  if (r.busy) {
    // A second Send while the first is still going. Ignored, and logged as
    // what it is — an empty-pad log line here would be a lie, and the two
    // look identical from the return value alone.
    log.event('scratchpad-deliver-ignored', { to: target, reason: 'already-delivering' })
    return null
  }
  if (r.restaged) {
    // Enough to recover by hand: the pad is back on disk at this path with its
    // entries intact. The TEXT is deliberately not logged — it is the user's
    // own dictation, and the file already has it.
    log.error('scratchpad delivery failed — the pad was put back', {
      to: target,
      padId: r.restaged.id,
      padDir: padDirOf(r.restaged),
      entries: r.restaged.entries.length,
      error: r.error instanceof Error ? r.error.message : String(r.error ?? 'destination declined'),
    })
  } else {
    log.event('scratchpad-delivered', { to: target, landed: null, empty: true })
  }
  return null
}

/** The pad's destinations. THE SET IS DYNAMIC: "add to the open task" appears
 *  only when a task is genuinely focused — the same orchestrateFocusId that
 *  already short-circuits an utterance to a focused session — and only while
 *  that task still exists. A task can end or be removed while a pad is held, so
 *  the id alone is not enough; offering a destination that cannot receive is
 *  worse than not offering it at all. */
function scratchpadDestinations(): {
  cursor: true
  newTask: true
  openTask: { id: string; name: string } | null
} {
  const focused = orchestrateFocusId ? manager?.get(orchestrateFocusId) : undefined
  return {
    cursor: true,
    newTask: true,
    openTask: focused ? { id: focused.id, name: focused.name ?? focused.intent } : null,
  }
}

/** The ONE pasteboard image reader — one process, one PNG encoder. A second
 *  reader with a different encoder is the documented cause of duplicated
 *  pastes. Writes into padDir and returns the path; no baseline, no signature
 *  set, and it never clears the clipboard. */
function rescueClipboardImageViaChild(padDir: string): Promise<string | null> {
  return new Promise((resolve) => {
    try { mkdirSync(padDir, { recursive: true }) } catch { /* exists */ }
    const dest = join(padDir, `insert-${Date.now()}.png`)
    const script = [
      'try',
      'set png to the clipboard as «class PNGf»',
      `set f to open for access POSIX file "${dest}" with write permission`,
      'set eof f to 0',
      'write png to f',
      'close access f',
      'on error',
      'end try',
    ].flatMap((l) => ['-e', l])
    execFile('osascript', script, { timeout: 5000 }, (err) => {
      if (err) { resolve(null); return }
      try { resolve(statSync(dest).size > 0 ? dest : null) } catch { resolve(null) }
    })
  })
}

/** THE ONE PLACE AN INSERT BECOMES VISIBLE.
 *
 *  Announcing is gated on whether the buffer actually RECORDED it. recordInsert
 *  refuses inserts detected while Unmute owned the pasteboard, and it dedups
 *  images across the two detectors; a surface drawn for an insert the pad
 *  rejected would show work that is not in the pad.
 *
 *  screenshotWatch is synchronous and is NOT suspended during our own
 *  pasteboard sequences, so a refusal here is a reachable path, not a
 *  theoretical one. */
function onInsertRecorded(i: { kind: InsertKind; content: string; atMs: number }): void {
  if (!recordInsert(i, Date.now())) return
  broadcastScratchpad()
}

/** Construct both watchers and hand them to the façade. Idempotent. */
function initCaptureWatchers(): void {
  // onInsert is the ONLY path from a watcher into the buffer, so position and
  // dedup are decided in one place.
  const cw = createClipboardWatch({
    changeCount: clipboardChangeCount,
    readText: () => { try { return clipboard.readText() } catch { return '' } },
    hasImage: () => {
      try { return clipboard.availableFormats().some((f) => f.startsWith('image/')) } catch { return false }
    },
    rescueImage: (padDir) => rescueClipboardImageViaChild(padDir),
    exists: (p) => { try { return existsSync(p.replace(/^~/, homedir())) } catch { return false } },
    now: () => Date.now(),
    onInsert: (i) => onInsertRecorded(i),
  })

  const sw = createScreenshotWatch({
    dirs: () => {
      const base = screenshotDir()
      return [
        { dir: base, dedicated: false },
        { dir: join(base, 'Screenshots'), dedicated: true },
        { dir: join(homedir(), 'Desktop', 'Screenshots'), dedicated: true },
      ]
    },
    // FAIL-SOFT PER DIRECTORY. Two of the three candidates usually do not
    // exist, and fs.watch THROWS synchronously on a missing path — an
    // unguarded throw here would abort the whole arm() loop and leave the
    // directories that DO exist unwatched.
    watch: (dir, cb) => {
      try {
        return watch(dir, (_evt, filename) => cb(String(filename ?? '')))
      } catch {
        return { close: () => { /* never opened */ } }
      }
    },
    now: () => Date.now(),
    // Path-keyed, and deliberately NOT the cross-detector dedup — that lives in
    // recordInsert, where the two detectors actually meet. This only stops the
    // SAME file firing twice from fs.watch, which macOS does emit (a write and
    // a rename for one screenshot).
    claim: (hash, atMs) => claimShared(hash, atMs),
    onInsert: (i) => onInsertRecorded(i),
  })

  initWatchers(cw, sw)

  // Settings read through a registered function, not an import — the same
  // inversion, for the same reason (capture/ must not import init.ts).
  registerSettings(() => ({
    scratchpadEnabled: settings.get('scratchpadEnabled') !== false,
    captureEnabled: settings.get('captureEnabled') !== false,
  }))

  // The pad also changes from the capture LIFECYCLE, not just from gestures —
  // a capture ending, a transcript landing, an open segment cancelled. Without
  // this the panel would appear at an armed stop holding a pad whose words had
  // not arrived yet, and never update.
  registerPadObserver(broadcastScratchpad)
}

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
 *
 * EXCEPT WHEN THE SESSION IS PAUSED, NOT OVER. An armed stop holds the work on
 * the pad and the same key resumes the same dictation — but the pill vanished
 * 1.5s later like every other terminal state, which reads as "session over" for
 * something that is a pause. So this one hide is answered with a 'paused' pill
 * instead: same surface, clock swapped for the word, dot amber. Nothing about
 * the capture changes; only the surface stops lying.
 *
 * IT IS DECIDED HERE rather than at the call site because there are twenty-odd
 * call sites and only one of them knows about the scratchpad. The condition is
 * the same one that decides whether a pad is on screen at all (heldForSurface),
 * so the pill and the pad can never disagree about whether there is work.
 */
export function hideNativePill(): void {
  if (pausedPillWanted()) {
    // The transient narration of the capture that just ended goes with it —
    // coaching about a room the user has stopped speaking into, a timer that is
    // no longer running. The model/agent/mic chips are left exactly as they
    // were: they describe where the NEXT stretch will go, which is still true.
    pillController?.push({
      phase: 'paused',
      level: 0,
      coaching: null,
      offline: null,
      micStatus: null,
      draftOffer: false,
      engineNotice: false,
      showDiscardHint: false,
    })
    return
  }
  pillController?.hide()
}

/** Is there held work behind a paused pill? EXACTLY the rule that decides
 *  whether the pad is drawn — `heldForSurface` — so the two surfaces cannot
 *  disagree, plus `armed`, because the pill claims the session is resumable and
 *  a disarmed pad is not. Never throws: a broken read means the ordinary hide. */
function pausedPillWanted(): boolean {
  try {
    const s = snapshot()
    return s.armed && heldForSurface(s) !== null
  } catch {
    return false
  }
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
  // OFF BY DEFAULT.
  //
  // This shells out to macOS `say` with no voice specified, so it speaks in
  // whatever the system default is — on a stock Mac, the compact voice, which
  // sounds like a decade ago. More to the point, the gap it was covering is
  // gone: the notch now says "creating task" during exactly the moment between
  // the recording pill vanishing and the task appearing, which is the only
  // moment the spoken beat was really answering.
  //
  // Kept rather than deleted because spoken confirmation is a genuine
  // accessibility affordance in a voice-first product — but nobody hears it
  // unless they ask for it in Settings.
  if (settings.get('voiceFeedback') !== true) return
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
    } else if ((t.kind ?? 'oneoff') === 'session') {
      // A THREAD finishing is a checkpoint, an ERRAND finishing is the end.
      // Same state now; what differs is what the task is (see TaskState).
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

export async function dispatchFromCapture(rawTranscript: string, attachments: readonly string[] = [], targetTaskId?: string | null): Promise<string | null> {
  // Observe the routing phase for the wall's listening surface — the dispatch
  // logic itself (the inner function) is untouched. `finally` guarantees the
  // surface always returns to idle, whatever path the dispatch takes.
  broadcastCapturePhase('routing')
  pendingBeat = null
  let landed: string | null = null
  try {
    landed = await dispatchFromCaptureInner(rawTranscript, attachments, targetTaskId)
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

async function dispatchFromCaptureInner(rawTranscript: string, attachments: readonly string[] = [], targetTaskId?: string | null): Promise<string | null> {
  if (!manager) {
    log.error('dispatchFromCapture before initRemote')
    return null
  }
  const raw = (rawTranscript || '').trim()
  if (!raw) { log.warn('empty transcript — not dispatching', {}); return null }

  // 0. ORCHESTRATE FOCUS short-circuit (§6.2). If the wall is focused on a session,
  //    the utterance goes THERE — deterministically, bypassing the router. This is
  //    PURELY ADDITIVE: with nothing focused (orchestrateFocusId === null) the block
  //    is skipped and routing below is exactly as before. We reuse the SAME paths
  //    the router uses (answer a blocked task / followUp to continue) — no new send.
  const addressedTaskId = targetTaskId ?? orchestrateFocusId
  if (addressedTaskId && manager.list().some((t) => t.id === addressedTaskId)) {
    const fid = addressedTaskId
    // Hygiene: the deterministic path skips the router, so it must not skip
    // CLEANUP — an STT misfire ("Happy Rates!") would land verbatim otherwise.
    // Best-effort: without a wired completeFn the raw transcript passes through
    // (status quo); delivery stays deterministic either way.
    const text = completeFn ? ((await cleanIntent(raw, completeFn)).intent || raw) : raw
    // Right-Option capture and the visible composer are one draft. Captured
    // images stay as attachments rather than being rendered as filesystem paths.
    const accepted = await deliverAddressedCapture({
      taskId: fid,
      text,
      attachments,
      drafts: taskDrafts,
      onStaged: () => notchController?.refresh(),
      deliver: deliverTaskDraftSnapshot,
    })
    notchController?.refresh()
    log.event('capture-addressed-delivery', { taskId: fid, attachments: attachments.length, accepted })
    pendingBeat = accepted ? '' : 'That didn\u2019t land. Your reply is still in the task.'
    return accepted ? fid : null
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
    // WHICH BACKEND THIS UTTERANCE COMMITTED TO, visible to the catch below.
    //
    // The failsafe there re-dispatches on error, and it used to decide whether
    // that was safe by MATCHING TWO ERROR STRINGS. Anything else fell through —
    // so when the App Server client threw `bufferUtil$1.mask is not a function`
    // in the packaged app, a task the user had explicitly pointed at Codex was
    // silently started on Claude instead. Twice, with no explanation.
    //
    // The rule was never about which error it was. Once a backend has been
    // chosen, a failure belongs to THAT backend; only a routing failure that
    // never got as far as choosing may fall back to a plain task.
    let committedBackend: AgentKind | undefined

    try {
      const tRoute = Date.now()
      // The user's real project universe (curated + recency-ranked, read-only
      // from ~/.claude.json) — what lets the router bind a session to a repo.
      const projects = await knownProjects().catch(() => [])
      // Short-term memory: recently finished tasks (sessions gone) so "change
      // the song" still resolves — as a self-contained NEW intent, never a
      // resurrection.
      const nowMs = Date.now()
      // snapshotOf, NOT a hand-rolled literal. This list used to be built inline
      // and silently omitted `agent`, which was the whole of the 2026-07-31
      // cross-backend misroute: a finished CODEX task arrived with no backend,
      // the `mine` filter defaulted it to 'claude', the Claude router was shown
      // it as one of its own, and resuming it continued a Codex thread. Every
      // other list already went through snapshotOf; this one had drifted.
      const finished = manager.recentlyFinished().map((t) => snapshotOf(t, nowMs, false))
      const { targetable, coldSessions } = partitionRoutable(nowMs)
      // THE WALL for curation: everything the user can currently SEE.
      //
      // This USED to say it mirrored the renderer's visibleOnWall. It no
      // longer does — Pack C gave the renderer a 24-hour window, and this rule
      // (non-shelved sessions always; active states; recent finishes) stayed as
      // it was. That is deliberate: curation must be able to name a session the
      // user has parked for a week, and a filter in one window should not make
      // it unaddressable by voice. Three rules now exist on purpose — this one,
      // the notch's notchVisible(), and the renderer's. Do not "unify" them
      // without deciding which question each is answering.
      //
      // Curation references resolve against what's
      // on screen — a wall the router can't see caused the first field bug
      // (a curation command misrouted into a junk task, 2026-07-16).
      const DONE_FADE_MS = 15 * 60_000
      const ATTN_FADE_MS = 60 * 60_000
      const wall = manager.list().filter((t) => {
        if (t.shelved) return false
        if ((t.kind ?? 'oneoff') === 'session') return true
        if (t.state === 'processing' || t.state === 'needs-user') return true
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
      // NO DEFAULTING. `?? 'claude'` used to sit here, and it is what turned a
      // missing backend into a positive claim: an agent-less task was asserted
      // to be Claude's and handed to the Claude router. Absence of information
      // is not evidence of Claude — a task whose backend we cannot name belongs
      // to NEITHER router, so it is simply not offered to either.
      const mine = (t: RoutableTask) =>
        t.agent === (useCodex ? 'codex-desktop' : 'claude')
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
      // GUARD THE ANSWER, NOT JUST THE QUESTION.
      //
      // The scoping above controls what the router is SHOWN. Nothing checked
      // what it hands back — and on 2026-07-30 a Claude router was given an
      // EMPTY snapshot (tasks:0, hidden:0) and still returned
      // action:"resume" naming a Codex task, which init.ts then resumed. The
      // utterance went to a different agent than the user asked for, silently.
      //
      // The router is a persistent session, so its own history carries ids from
      // earlier turns; "we didn't tell it this time" is not the same as "it
      // cannot say it". This closes that gap without depending on model
      // behaviour at all.
      //
      // Deliberately checks "was this shown AT ALL", not "is this a legal
      // target": cold sessions and finished tasks are legitimately referenced
      // by `speak`/`contextTaskId`, and their own rules already live elsewhere.
      // Anything the router legitimately knows came from one of these lists, so
      // rejecting ids in none of them can never remove working behaviour.
      const offeredIds = new Set(
        [...targetable, ...finished, ...coldSessions, ...wall]
          .filter(mine).map((t) => t.id),
      )
      if (decision.targetTaskId && !offeredIds.has(decision.targetTaskId)) {
        log.warn('router named a task outside its own snapshot — ignoring', {
          engine: useCodex ? 'codex' : 'claude',
          targetTaskId: decision.targetTaskId,
          action: decision.action,
          offered: offeredIds.size,
          namedAgent: manager.get(decision.targetTaskId)?.agent ?? 'unknown',
        })
        decision.targetTaskId = undefined   // falls through to a NEW task
      }

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
            manager.answer(tid, withSkill(decision.intent || raw))
            // Assign-once grouping: the router may group the task it acted on,
            // never regroup one that already has a group (freeze).
            if (decision.group && !target?.group) manager.setGroup(tid, decision.group)
            pendingBeat = `Passed to ${targetName}.`
            return tid
          }
          const targetBusy = target?.state === 'processing' // mid-turn — the follow-up will queue
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
      committedBackend = chosenAgent
      const newId = await manager.dispatch(intentText, {
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
      // COMMITTED ⇒ NEVER SOMEWHERE ELSE. Checked before the string matches
      // below, and it is the rule that actually holds: whatever went wrong
      // after a backend was chosen is that backend's failure to report, not a
      // reason to run the user's words on a different agent.
      if (committedBackend && committedBackend !== DEFAULT_PROVIDER) {
        const label = providerOf(committedBackend).label
        log.error('backend failure after commit — NOT falling back to another agent',
          { agent: committedBackend, error: msg })
        speakLine(`${label} could not take that task.`)
        return null
      }
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
  return manager.dispatch(cleaned, { mode: injectionDisabled() ? 'raw' : undefined })
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

// Curator PARKED for launch (decision D7). The librarian above had a park
// switch from the start; the curator never did, so it kept running while the
// UI claimed otherwise. Same shape, same promise: code and recipes stay on
// disk, flip to false to revive. Reviving it also means restoring the
// Suggestions rail Pack C removed — a curator with no review surface proposes
// into a void. See the guard at the curator.start() call site.
const CURATOR_PARKED = true

export function initRemote(deps: RemoteInitDeps): TaskManager {
  captureHistory.cleanup()
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

  // Resolve tmux once: if present, sessions run inside it so the live terminal
  // can be popped out to a real terminal app (same session). Write the minimal
  // config (no status bar, mouse scroll, fixed size).
  refreshTmux()
  log.event(tmuxBin ? 'tmux-available' : 'tmux-unavailable', { tmuxBin, conf: tmuxConfPath })

  // Build the capture watchers and register the settings reader. Constructing
  // them is inert — neither observes anything until the session lifecycle arms
  // it at the start of a recording.
  try { initCaptureWatchers() } catch (e) { log.warn('capture watchers unavailable', { error: (e as Error).message }) }

  // Held work outlives the process that held it — that promise is the reason
  // the pad is written to disk at all, and reading it back is what makes it
  // true. Adopted UNARMED and SETTLED: a pad the user has forgotten must not
  // pin the pill open, and arming on their behalf would silently swallow the
  // next thing they say. Arming again is what brings it back.
  //
  // A corrupt pad is skipped in silence inside adoptPersistedPad — startup can
  // never be blocked by a file we wrote.
  try {
    const held = adoptPersistedPad()
    if (held) log.event('scratchpad-adopted', { padId: held.id, entries: held.entries.length, heldFor: Date.now() - held.updatedAt })
  } catch (e) {
    log.warn('scratchpad adoption skipped', { error: (e as Error).message })
  }

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
  // The Claude desktop backend, on the same terms: inert until used, and
  // constructed unconditionally so the setup card can report the truth. Its
  // read half touches only files, so building it costs nothing and it works
  // even with Claude Desktop shut.
  claudeDesktopDriver = new ClaudeDesktopDriver({})
  // Live UI reader. Separate from the driver because it has a completely
  // different failure mode: the driver reads files and works with the app shut,
  // this needs a running app whose renderer has attached. Keeping them apart
  // means a dead accessibility tree costs the live signals only — cards, titles
  // and conversations keep working from disk.
  claudeDesktopAx = new ClaudeDesktopAx({})
  // The only Claude-desktop component that steals focus. Serialized internally.
  claudeActuator = new ClaudeActuator({})
  // THE CODEX CLI APP SERVER. Lazily started by the hub on the first Codex CLI
  // task — not here — so a user who never touches Codex never pays for a Codex
  // process, and unmute's launch path (which sits next to the capture path)
  // never waits on someone else's binary.
  //
  // `onPatch` is deliberately a late-bound lookup rather than a captured
  // reference: the hub is constructed BEFORE the manager it feeds, and closing
  // over a `manager` that is still undefined is how a stream of events would
  // land silently on nothing.
  codexHub = new CodexHub({
    resolveBin: () => resolveCodexCli((bin) => new Promise<string | null>((res) => {
      execFile('/usr/bin/which', [bin], { env: process.env }, (err, stdout) => res(err ? null : String(stdout).trim() || null))
    })),
    onPatch: (p) => { try { manager?.applyHubPatch(p) } catch (e) { log.warn('hub patch failed', { error: (e as Error).message }) } },
  })

  manager = new TaskManager({
    executorFactory,
    codexHub,
    // The path fence, read fresh per dispatch so a task started after the
    // setting changed honours the new value. This is what stops Codex walking
    // through a boundary Claude respects.
    sandboxRoots: () => settings.get('sandboxRoots') ?? [],
    // Consent gates full access. Read per dispatch so revoking it takes effect
    // on the next task rather than the next launch.
    codexFullAccess: () => settings.get('codexFullAccessConsent') === true,
    // The WIRE pair, kept apart from the display record the wrapper stamps.
    codexCliChoice: () => codexCliSpawnArgs(),
    codexDriver,
    claudeDesktopDriver,
    claudeDesktopAx,
    claudeActuator,
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
    // Best-effort reaper for an orphan tmux session a past run left on our
    // private socket (app crashed before killAll). Per-session kill, never the
    // server (would hit live ones).
    // Recovery for a task whose cwd is wrong or stale — see TaskManager.resume.
    // BOTH CLIs, or the repair is Claude-only. A Codex thread id looked up
    // among Claude's transcripts is found nowhere, so an imported Codex session
    // whose folder had moved could not be resumed and said nothing about why.
    // Claude first because it is the common case; Codex answers from its
    // rollout, where the cwd is recorded verbatim.
    resolveSessionCwd: async (sessionId) =>
      (await findSessionCwd(sessionId)) ?? (await findCodexSessionCwd(sessionId).catch(() => null)),
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
    manager.dispatch = async (intent, opts = {}) => {
      const placeholder = `pending-${randomUUID()}`
      const env = mintMcpEnvFor(placeholder)
      // The model is stamped HERE, at dispatch, from what the chosen backend is
      // about to run on — the same wrapper, for the same reason, as the per-task
      // MCP identity above. Absent when it cannot be determined; never a
      // default (D6).
      const model = await modelForDispatch(opts.agent)
      const id = await origDispatch(intent, {
        ...opts,
        extraEnv: { ...env, ...(opts.extraEnv ?? {}) },
        ...(model ? { model } : {}),
      })
      remapMcpToken(placeholder, id)
      return id
    }
  }
  // The hook settings file every Claude session is launched with. Written once,
  // shared by all of them — identity comes from each event's own session_id, so
  // nothing in it is per-task. Best-effort: a session with no hooks still runs
  // and still has its status file polled.
  // SYNCHRONOUS ON PURPOSE. Written before anything can dispatch: a task that
  // launches before this lands gets no --settings, therefore no hooks, therefore
  // no observer — and its card sits at "processing" forever. Launch the app,
  // press the key, speak is the ordinary path into that window.
  hookSettingsFile = installHookSettingsSync(REMOTE_BASE_DIR, getKnobs().mcpPort, HOOK_TOKEN)

  void startMcpServer({
    resolveCaller: (token) => {
      if (!token) return null
      const tid = mcpTokens.get(token)
      return tid && !tid.startsWith('pending-') ? tid : null
    },
    createTask: mcpCreateTask,
    taskStatus: mcpTaskStatus,
    // THE OBSERVER'S INTAKE. Claude Code lifecycle hooks curl their event JSON
    // here; everything the old operating contract demanded in prose is derived
    // from these five events plus the session's own transcript.
    hookEvent: (token, payload) => {
      if (token !== HOOK_TOKEN) { log.warn('hook event with a bad token — ignored', {}); return }
      const event = parseHookEvent(payload)
      if (!event) return // unknown/unparseable event: ignorable, never fatal
      manager?.onHookEvent(event)
    },
    // The OPTIONAL precision channel (unmute_status). A session that wants to be
    // exact overwrites what the observer inferred; nothing requires it to.
    setStatus: async (callerTaskId, input) => {
      if (!manager) throw new Error('not ready')
      await manager.setReportedStatus(callerTaskId, {
        schema_version: 1,
        state: input.state,
        updated_at: new Date().toISOString(),
        ...(input.summary || input.detail || input.artifacts
          ? { result: { summary: input.summary ?? '', ...(input.detail ? { detail: input.detail } : {}), ...(input.artifacts ? { artifacts: input.artifacts } : {}) } }
          : {}),
        ...(input.question ? { question: { text: input.question, kind: 'free_text' as const } } : {}),
      })
    },
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
        restartDelayMs: 500,
        bootstrap: () => ({
          type: 'bootstrap',
          appearance: settings.get('surfaceAppearance') || 'solid',
          surfaceFill: settings.get('surfaceFill') ?? 0.8,
          showInScreenCapture: screenCaptureVisibility(settings.get('showInScreenCapture')).show,
          terminalAutoExpand: settings.get('notchTerminalAutoExpand') === true,
          autoPresent: settings.get('overlayAutoPresent') !== false,
        }),
      })
      // Auto-expand is controller state, not a helper command — the decision to
      // open the task surface is made here, before anything is sent.
      const applyAutoExpand = () => notchController?.setAutoExpand(settings.get('notchAutoExpand') !== false)
      notchController = new NotchController(notchClient, mgr, {
        // task runtime — same calls as remote:list/answer/kill/remove/resume/…
        listTasks: () => mgr.list().map(serializeTask),
        getTask: (id) => { const t = mgr.get(id); return t ? serializeTask(t) : undefined },
        answer: (id, text) => mgr.answer(id, text),
        getDraft: (id) => taskDrafts.get(id),
        setDraftText: (id, text) => { taskDrafts.setText(id, text) },
        addDraftImage: (id, path, mimeType, name) => addDraftImageFromPath(id, path, mimeType, name),
        removeDraftAttachment: async (id, attachmentId) => {
          const attachment = taskDrafts.removeAttachment(id, attachmentId)
          if (attachment) await fs.unlink(attachment.path).catch(() => {})
        },
        sendDraft: (id) => sendTaskDraft(id),
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
        remoteKey: () => getRemoteKey(),
        // THE IMPORT RAIL. Sessions this machine has and unmute does not.
        listImportable: async () => {
          const known = new Set(mgr.list().map((t) => t.sessionId).filter(Boolean) as string[])
          // BOTH CLIs IN ONE RAIL. The question the rail answers is "what do I
          // already have that unmute does not", and the user does not think of
          // that per-backend. Interleaved by last activity for the same reason.
          const [claude, codex] = await Promise.all([
            listImportableSessions(known).catch(() => []),
            listImportableCodexSessions(known).catch(() => []),
          ])
          return [
            ...claude.map((r) => ({ ...r, agent: 'claude' as const })),
            ...codex.map((r) => ({ ...r, agent: 'codex' as const })),
          ]
            .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
            .map((r) => ({
              sessionId: r.sessionId, title: r.title, project: r.project,
              lastActivityAt: r.lastActivityAt, agent: r.agent,
            }))
        },
        importSession: async (sessionId) => {
          const known = new Set(mgr.list().map((t) => t.sessionId).filter(Boolean) as string[])
          const [claude, codex] = await Promise.all([
            listImportableSessions(known).catch(() => []),
            listImportableCodexSessions(known).catch(() => []),
          ])
          const codexRow = codex.find((r) => r.sessionId === sessionId)
          const row = claude.find((r) => r.sessionId === sessionId) ?? codexRow
          if (!row) return false
          // GROUPED BY PROJECT, not by the router. An import has no intent to
          // route — only a title and a history — and the directory it ran in is
          // the axis you actually want ("all my unmute-cloud threads"), for
          // free and with no model. A session earns a semantic group later, if
          // the router gives it one when you actually work in it.
          const id = await mgr.adoptCliSession({
            sessionId: row.sessionId, title: row.title, cwd: row.cwd,
            lastActivityAt: row.lastActivityAt, group: row.project,
            agent: codexRow ? 'codex' : 'claude',
          })
          return !!id
        },
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
        getLastSeen: () => notchLastSeen,
        setLastSeen: (ms) => { notchLastSeen = ms },
        // The pad panel's four verbs, straight onto the same functions the
        // scratchpad:* IPC handlers call. Deliver is fire-and-forget here: the
        // surface learns the outcome from the broadcast, not a return value.
        scratchpadArm: (on) => { armScratchpadFrom(on) },
        scratchpadRemove: (id) => removeScratchpadEntry(id),
        scratchpadDeliver: (dest) => { void deliverScratchpad(dest) },
        scratchpadDiscard: () => discardScratchpad(),
        // (pill deps are wired separately, below — see PillController)
      },
      // PRESENCE. Two jobs: it is the ONLY thing allowed to open the surface by
      // itself (idle → active, i.e. you touched the machine after a stretch of
      // not touching it), and it owns the clock that demand windows are spent
      // against — so an afternoon away costs a finished thread nothing.
      //
      // The idle source is system-wide on purpose: it sees you working in any
      // app, which is the whole point. A listener of our own would only see
      // input aimed at us and would call you idle while you typed all day.
      new Presence(() => powerMonitor.getSystemIdleTime()))
      applyAutoExpand()
      // Seed the pad panel. Without this a pad adopted from a previous run is
      // invisible until something else happens to change it.
      //
      // THROUGH broadcastScratchpad, not a direct notifyScratchpad. The direct
      // call drew the panel and skipped scheduleSettleRebroadcast, so a pad
      // adopted less than the threshold stale showed at launch and then never
      // settled on schedule — it sat there until some unrelated broadcast
      // happened to re-evaluate it, which for a user who is not dictating is
      // never. It is the same push with the timer attached, and it is
      // internally try/caught for the same "helper still starting" reason.
      broadcastScratchpad()

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
        pickModel: (m, taskId) => {
          const addressed = taskId ? manager?.get(taskId) : undefined
          const agent = addressed?.agent ?? (settings.get('agent') as AgentKind)
          // CLAUDE DESKTOP HAS NO WRITE PATH. Its model lives in a popup that
          // is not reachable over accessibility (pressing it yields zero new
          // nodes, backgrounded AND frontmost — measured). So a tap cannot take
          // effect there.
          //
          // What it MUST NOT do is fall through to the line below, where
          // isSelectableModel() rejects a Claude Desktop id and quietly writes
          // the CLAUDE CODE model setting instead — changing the model your CLI
          // tasks run on, from a menu that was showing a different backend.
          if (agent === 'claude-code-desktop') {
            void setClaudeDesktopModel(m).then(() => {
              if (addressed) manager?.setModel(addressed.id, m)
              void pushPillChips(addressed?.id ?? null)
            })
            return
          }
          // An addressed task is never silently converted into a new-task
          // default. The receipt changes only after the provider-specific path
          // above has accepted it; CLI providers retain their live session's
          // model until their next provider-supported reconfiguration.
          if (addressed) {
            manager?.setModel(addressed.id, m)
            void pushPillChips(addressed.id)
            return
          }
          // EVERY OTHER BACKEND WRITES ITS OWN KEY, chosen by the registry.
          // Spelled out here per-backend, this was already wrong once: Codex CLI
          // fell into the Claude branch, where `isSelectableModel` rejected the
          // Codex id and silently substituted the Claude default — changing the
          // model your CLAUDE tasks run on, from a menu showing Codex's.
          setModelFor(agent, m)
          // RE-PUSH, or the chip keeps its old label for the rest of the
          // capture. The setting changed correctly and the surface said
          // otherwise, which reads exactly like a dead control.
          void pushPillChips()
        },
        // The agent chip CYCLES on tap (the dropdown is the other way in).
        //
        // "there are only ever two" stopped being true. Written as a flip
        // between claude and codex-desktop, tapping the chip could never reach
        // a third backend and would silently kick you OFF it — select Claude
        // desktop from the list, tap the chip once, and you are on Codex.
        cycleAgent: async () => {
          const now = (settings.get('agent') as AgentKind) ?? 'claude'
          // Cycle through what is actually offered, in the order the picker
          // shows, so the chip and the list agree.
          const offered = (await probeBackends()).filter((b) => b.ready).map((b) => b.id as AgentKind)
          const order = offered.length ? offered : (['claude'] as AgentKind[])
          const i = order.indexOf(now)
          const next: AgentKind = order[(i + 1) % order.length]
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
        pickAxis: (axis, value, taskId) => {
          const addressed = taskId ? manager?.get(taskId) : undefined
          const agent = addressed?.agent ?? (settings.get('agent') as AgentKind)
          // Speed IS a real axis (the menu offers Standard / Fast); it was
          // dropped only because the old reader could not see it.
          if (axis !== 'Model' && axis !== 'Effort' && axis !== 'Speed') return
          // WHOSE AXES ARE THESE? Both Codex backends show a Model/Effort
          // picker and the values look alike, but the write is nothing alike:
          // the DESKTOP one clicks a menu in another app, the CLI one records a
          // setting we pass at spawn. Everything below this line assumes the
          // driver — so without this, picking a Codex CLI model logged
          // 'no-driver' and did nothing, which is the same dead control the
          // agent chip had.
          if (agent === 'codex' && addressed) {
            void listCodexCliModels().then((models) => {
              const current = models.find((m) => addressed.model?.startsWith(m.uiLabel)) ?? models[0]
              const selected = axis === 'Model' ? models.find((m) => m.uiLabel === value) ?? current : current
              const effort = axis === 'Effort' ? selected?.efforts.find((e) => effortLabelOf(selected, e) === value) : undefined
              if (selected) manager?.setModel(addressed.id, codexCliChoiceLabel(selected, effort ?? selected.defaultEffort))
              void pushPillChips(addressed.id)
            }).catch(() => {})
            return
          }
          if (agent === 'codex') {
            void pickCodexCliAxis(axis, value).then(() => {
              void pushPillChips(addressed?.id ?? null)
            })
            return
          }
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
              if (addressed && trace.ok && trace.labelAfter) manager?.setModel(addressed.id, trace.labelAfter)
              void pushPillChips(addressed?.id ?? null)
            })
            .catch((e) => log.warn('codex-pick-done', { axis, value, ok: false, stage: 'threw', error: (e as Error).message }))
        },
        pickAgent: (a) => {
          // Only ever a backend this host can actually dispatch to — an event
          // can arrive from a surface whose options are a moment stale.
          //
          // Registry-driven, not a literal pair. Spelled out, this guard
          // silently DROPPED claude-code-desktop: the row rendered, the tap
          // landed here, and nothing happened — no selection, no log, no error.
          if (!isDispatchable(a)) { log.warn('pick-agent-rejected', { agent: a }); return }
          settings.set('agent', a)
          for (const w of BrowserWindow.getAllWindows()) {
            if (!w.isDestroyed()) w.webContents.send('remote:agent-changed', a)
          }
          log.event('agent-set', { agent: a, from: 'pill' })
          void pushPillChips()   // see pickModel — the label must follow the setting
        },
      })

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
  // PARKED for launch (decision D7), exactly as the librarian is at :2235.
  //
  // This guard is the whole reason Settings can honestly say the curator is
  // switched off. Before it, `curator.start()` ran unconditionally while the
  // Settings screen told the user "Both are being switched off for this
  // release" and rendered a disabled toggle in the OFF position — a
  // kill-switch asserting a state that was not true. Found by Pack B's
  // independent verifier; the librarian had been parked properly and the
  // curator never had been.
  //
  // A constant, not a setting, and deliberately so: D7 retires the curator for
  // this release. A live toggle would promise it can be switched back on,
  // which is a bigger promise than we want to make — and re-enabling it also
  // means restoring the Suggestions surface Pack C removed, since that was the
  // only way a user could ever see what it proposed.
  if (!CURATOR_PARKED) curator.start()
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
      // Snapshot the visible address now. Transcription completes later, during
      // which task lifecycle events may legitimately change the live focus.
      // A capture is an intent addressed at key-down, not at delivery time.
      const targetTaskId = orchestrateFocusId && manager?.get(orchestrateFocusId)
        ? orchestrateFocusId
        : null
      deps.sessionManager.startRemoteCapture(targetTaskId)
      broadcastCapturePhase('listening', targetTaskId) // ADDITIVE observer — the capture itself is untouched
    } else if (e.type === 'remote-stop') {
      log.event('remote-key', { phase: 'stop' })
      resumeOverlayEscape() // give Escape back to a still-visible overlay
      void deps.sessionManager.stopRemoteCapture()
      broadcastCapturePhase('transcribing')
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
  // A STARTUP RESET FORCING CODEX CLI BACK TO CLAUDE LIVED HERE, and it was
  // right when it was written: the CLI adapter was a stub, so a stored 'codex'
  // meant every task failed. It is wired now — dispatch, rollout-driven state,
  // resume, models, import — so the reset would do the opposite of its purpose:
  // silently revert a deliberate choice on every launch.

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
    // A finished THREAD is the natural stopping point curation wants. This
    // keyed on `ready`, which no longer exists; the condition it was really
    // asking — "did a step just end on something the user returns to" — is
    // exactly done-on-a-session.
    if (t.state === 'done' && (t.kind ?? 'oneoff') === 'session') { creditSkillUsage(t); curator.notifyCheckpoint(t.id) }
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
    // OUR app-server dies with us. It is a process unmute spawned on its own
    // port, not Codex's machine-global daemon, so leaving it running would
    // orphan a Codex the user never started and cannot see.
    try { codexHub?.stop() } catch (e) { log.warn('codex hub shutdown failed', { error: (e as Error).message }) }
  })
  // Prove the App Server transport in THIS build, once, at launch. Backgrounded
  // and delayed so it never sits in the startup path — which is next to the
  // capture path, and must not wait on someone else's binary.
  // Reap strays from a previous run BEFORE the self-check starts a new one, so
  // the count cannot creep up across launches.
  CodexAppServer.reapStrays()
  setTimeout(() => { void codexHub?.selfCheck() }, 8000).unref?.()

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

  // Capture history is intentionally a small, filtered IPC surface. The
  // renderer receives only completed records, never a live scratchpad.
  ipcMain.handle('remote:capture-history-list', async (_e, kind?: CaptureHistoryKind) => captureHistory.list(kind))
  ipcMain.handle('remote:capture-history-save', async (_e, id: string, saved: boolean) => captureHistory.setSaved(id, saved))
  ipcMain.handle('remote:capture-history-delete', async (_e, id: string) => captureHistory.delete(id))
  ipcMain.handle('remote:capture-history-copy', async (_e, id: string) => {
    const entry = captureHistory.list().find((candidate) => candidate.id === id)
    if (!entry) return false
    const payload = clipboardPayload(entry)
    return copyHistoryToClipboard(payload.text, payload.attachments)
  })

  // ── The scratchpad has NO IPC surface, deliberately ──
  //
  // Its surface is the native pad panel, which reaches the four verbs through
  // the notch controller (see "the scratchpad's four verbs"). There WAS a
  // parallel set of `scratchpad:*` handlers here plus a preload group for the
  // renderer, and not one of them had a caller. Two of them were actively
  // wrong: `scratchpad:get` and the `scratchpad:changed` broadcast shipped raw
  // `snapshot()`, live unarmed pad and all, which is the precise value
  // heldForSurface exists to keep off a surface. A renderer that wants the pad
  // later gets it through scratchpadPayload, the one filtered shape — not
  // through a second, unfiltered one that already exists.
  // Voice-as-doorbell toggle (§6.4) — read + set from the cockpit's 🔔 chip.
  ipcMain.handle('remote:get-voice-headlines', async () => settings.get('voiceHeadlines') !== false)
  ipcMain.handle('remote:set-voice-headlines', async (_e, on: boolean) => { settings.set('voiceHeadlines', !!on); return true })
  // CAPTURE — text as well as images. The wire key is still `screenshot-capture`
  // because renaming a shipped IPC channel buys nothing; the SETTING it reads
  // (captureEnabled) and the label the user sees are both honest about scope.
  ipcMain.handle('remote:get-screenshot-capture', async () => settings.get('captureEnabled') !== false)
  // The scratchpad's master switch. Independent of capture — see captureGate.ts.
  ipcMain.handle('remote:get-scratchpad-enabled', async () => settings.get('scratchpadEnabled') !== false)
  ipcMain.handle('remote:set-scratchpad-enabled', async (_e, on: boolean) => {
    settings.set('scratchpadEnabled', !!on)
    log.event('scratchpad-enabled-set', { on: !!on })
    // Turning it OFF cannot leave an armed pad behind: armScratchpad refuses
    // while disabled, so the surface would keep showing an armed icon it could
    // no longer act on. Disarming through the same gate SETTLES a pad that is
    // holding work — armScratchpad moves it into the settled slot rather than
    // just clearing the flag, which is what makes the next sentence true.
    //
    // IT MUST NOT STRAND WHAT IS ALREADY HELD. Turning the feature off removes
    // the ICON, not the user's work: the pad stays on screen (see
    // ScratchpadModel.visible, which is content-gated and not enabled-gated),
    // stays deliverable (promoteSettledPad is deliberately not behind the
    // gate), and stays discardable. Off means "hold nothing NEW", never "you
    // can no longer reach what you held".
    if (!on) {
      armScratchpadFrom(false)
      const stranded = snapshot().held
      if (stranded) {
        log.event('scratchpad-disabled-with-held-work',
                  { padId: stranded.id, entries: stranded.entries.length })
      }
    } else {
      broadcastScratchpad()   // the icon appears again
    }
    return true
  })
  // The Unmute MCP master switch (agent-created tasks).
  ipcMain.handle('remote:get-agent-tasks', async () => settings.get('agentTasksEnabled') !== false)
  ipcMain.handle('remote:set-agent-tasks', async (_e, on: boolean) => { settings.set('agentTasksEnabled', !!on); return true })
  /** Consent for full-access Codex CLI tasks. Logged either way: granting the
   *  whole machine to an agent is a decision worth being able to point at
   *  afterwards, and so is taking it back. */
  ipcMain.handle('remote:set-codex-full-access', async (_e, on: boolean) => {
    settings.set('codexFullAccessConsent', !!on)
    log.event('codex-full-access-consent', { granted: !!on })
    return !!on
  })
  ipcMain.handle('remote:set-screenshot-capture', async (_e, on: boolean) => {
    settings.set('captureEnabled', !!on)
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
  // Attachment bytes become a task draft item. They are never typed into a PTY
  // merely because the user pasted or dropped an image.
  ipcMain.handle('remote:attach-image', async (_e, taskId: string, data: ArrayBuffer, ext: string) => {
    if (!manager) return null
    try {
      const path = await manager.attachFile(taskId, new Uint8Array(data), ext)
      if (path) taskDrafts.addAttachment(taskId, { id: randomUUID(), path, mimeType: `image/${ext || 'png'}`, name: basename(path) })
      return path
    } catch (e) {
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
  ipcMain.handle('remote:set-voice-feedback', async (_e, on: boolean) => {
    settings.set('voiceFeedback', !!on)
    log.event('voice-feedback-set', { on: !!on })
    return true
  })
  ipcMain.handle('remote:set-terminal-auto-expand', async (_e, on: boolean) => {
    settings.set('notchTerminalAutoExpand', !!on)
    notchClient?.send({ type: 'terminalAutoExpand', on: !!on })
    log.event('terminal-auto-expand-set', { on: !!on })
    return true
  })
  ipcMain.handle('remote:set-notch-auto-expand', async (_e, on: boolean) => {
    settings.set('notchAutoExpand', !!on)
    notchController?.setAutoExpand(!!on)
    log.event('notch-auto-expand-set', { on: !!on })
    return true
  })
  // Share of the screen the expanded surfaces fill. Clamped to the three
  // offered choices rather than trusted: a stray value here would resize every
  // surface on the machine, and there is no UI path back from a bad one.
  ipcMain.handle('remote:set-surface-fill', async (_e, fill: number) => {
    const allowed = [0.7, 0.8, 0.9]
    const v = allowed.includes(fill) ? fill : 0.8
    settings.set('surfaceFill', v)
    notchClient?.send({ type: 'surfaceFill', fill: v })
    log.event('surface-fill-set', { fill: v })
    return v
  })
  ipcMain.handle('remote:set-show-in-screen-capture', async (_e, on: boolean) => {
    const visibility = screenCaptureVisibility(!!on)
    settings.set('showInScreenCapture', visibility.show)
    notchClient?.send(visibility.command)
    log.event('screen-capture-visibility-set', { show: visibility.show })
    return visibility.show
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
    // ROUTED BY THE SELECTED BACKEND, through the same function the pill uses.
    // This handler used to write `model` unconditionally, so the Remote screen's
    // Codex picker moved Claude's setting — the one bug the pill had already
    // been fixed for, still live one surface over. Two places answering "where
    // does this backend's model live" is how that happens; now there is one.
    const agent = settings.get('agent') as AgentKind
    const model = setModelFor(agent, m) ?? currentModelFor(agent)
    // Keep the pill's chip honest — the two surfaces write the same settings.
    void pushPillChips()
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
    // THE SELECTED BACKEND'S model, not Claude's. The Remote screen draws this
    // as the chosen chip under a picker labelled with the current agent; hard-
    // wiring Claude's key meant that with Codex selected, the screen highlighted
    // a Claude alias that is not in Codex's list — so nothing looked selected.
    model: currentModelFor(settings.get('agent')),
    browserEnabled: settings.get('browserEnabled') !== false,
    overlayAutoPresent: settings.get('overlayAutoPresent') !== false,
    notchAutoExpand: settings.get('notchAutoExpand') !== false,
    notchTerminalAutoExpand: settings.get('notchTerminalAutoExpand') === true,
    voiceFeedback: settings.get('voiceFeedback') === true,
    surfaceFill: settings.get('surfaceFill') ?? 0.8,
    showInScreenCapture: screenCaptureVisibility(settings.get('showInScreenCapture')).show,
    overlayDocked: settings.get('overlayDocked') !== false,
    osNotifications: settings.get('osNotifications') === true,
    librarianWriteEnabled: settings.get('librarianWriteEnabled') === true,
    forceRawMode: settings.get('forceRawMode') === true,
    screenshotCapture: settings.get('captureEnabled') !== false,
    codexFullAccessConsent: settings.get('codexFullAccessConsent') === true,
    logFile: getRemoteLogFilePath(),
  }))
  // ── Onboarding / guided one-time setup (PRD §12) ──
  ipcMain.handle('remote:get-setup-status', async () => getSetupStatus())
  ipcMain.handle('remote:set-setup-confirmation', async (_e, key: string, done: boolean) => {
    const cur = { ...(settings.get('setupConfirmations') ?? {}) }
    // Versioned key — see confirmationKey(). Writing the bare key would make the
    // confirmation invisible the moment a step's requirement is bumped.
    cur[confirmationKey(key)] = !!done
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
    //
    // Built from probeBackends() — the SAME probe the setup card uses, which
    // walks the provider registry and asks each backend's own driver. This used
    // to be a hand-written two-entry array, so a third backend was invisible
    // here even once it was registered, installed and ready. One probe, one
    // answer, and a new provider appears in both places or neither.
    const probes = await probeBackends()
    const result = {
      current: (settings.get('agent') as AgentKind) ?? 'claude',
      options: probes.map((p) => ({
        id: p.id,
        label: p.label,
        // Only offered when it can actually take work right now.
        available: p.ready,
        installed: p.installed,
        // 'not-armed' is the actionable one — the app is there, it just wasn't
        // launched the way we need, so we can't drive it until it relaunches.
        ...(p.ready ? {} : { reason: p.reason ?? 'not-installed' }),
      })),
    }
    log.event('agent-options', {
      current: result.current,
      offered: result.options.filter((o) => o.available || o.installed).length,
      backends: result.options.map((o) => ({ id: o.id, available: o.available, reason: o.reason ?? null })),
    })
    return result
  })

  /**
   * Models for ONE backend, in that backend's own vocabulary.
   *
   * Deliberately per-backend rather than one global list: Claude Code's aliases
   * ('opus', 'opusplan') and Claude Desktop's display names ('Opus 5', with
   * effort as a separate axis) are different vocabularies for different apps.
   * Offering either app the other's list is a picker that lies — pick a model
   * the target does not have and you silently get something else.
   */
  ipcMain.handle('remote:model-options', async (_e, agent: unknown) => {
    const id = (typeof agent === 'string' ? agent : 'claude') as ProviderId
    if (id === 'claude-code-desktop') {
      const models = await readClaudeCatalog()
      // EMPTY means the bundle could not be read or understood. Falling back to
      // the Claude Code catalogue here would be the exact lie this avoids, so
      // the picker shows nothing selectable and the task keeps whatever the
      // composer is already set to.
      log.event('model-options', { agent: id, models: models.length })
      return {
        agent: id,
        models: models.map((m) => ({
          id: m.id, label: m.label, family: m.family,
          effortLevels: m.effortLevels, defaultEffort: m.defaultEffort,
        })),
      }
    }
    if (providerOf(id).modelSource === 'own-binary') {
      // ASKED OF THE BINARY THE TASK WILL RUN. Same treatment as the app-owned
      // backend above, and for the same reason: this list is not Unmute's to
      // write down. Empty means Codex could not be asked, and the surface draws
      // nothing selectable rather than a remembered guess.
      const models = await listCodexCliModels().catch(() => [] as CodexModel[])
      log.event('model-options', { agent: id, models: models.length, source: 'own-binary' })
      return {
        agent: id,
        models: models.map((m) => ({
          id: m.id, label: m.uiLabel, description: m.description,
          effortLevels: m.effortLabels, defaultEffort: m.defaultEffort,
        })),
      }
    }
    // SCOPED TO THE BACKEND ASKED FOR. Unscoped, this returned Claude's list to
    // Codex — and the exact lie the comment above warns about: `-c model="opus"`
    // is valid TOML for a model Codex does not have, so it fails at the API
    // rather than the picker, long after the user chose.
    const catalog = getModelCatalog(id)
    log.event('model-options', { agent: id, models: catalog.length })
    return { agent: id, models: catalog.map((m) => ({ id: m.id, label: m.label, description: m.description })) }
  })

  /**
   * Codex CLI's Model/Effort axes, in the SAME SHAPE the Codex desktop backend
   * reports — so the settings screen renders both with one component.
   *
   * Two axes rather than a flat model list, because that is Codex's own design:
   * its header reads `model: gpt-5.6-terra xhigh` and its picker is titled
   * "Select Model and Effort". The efforts offered follow the SELECTED model
   * (Sol and Terra have six, Luna five), which a flat list cannot express.
   *
   * The values are MENU SPELLINGS in both directions — what is shown is what
   * comes back on a pick — matching the desktop contract so the two cannot
   * drift into different vocabularies.
   */
  ipcMain.handle('remote:codex-cli-reasoning', async () => {
    const { models, model, effort } = await codexCliChoice()
    const shown = model ?? models[0]
    return {
      label: model ? codexCliChoiceLabel(model, effort ?? model.defaultEffort) : null,
      current: {
        ...(shown ? { Model: shown.uiLabel } : {}),
        ...(effortLabelOf(shown, effort ?? shown?.defaultEffort) ? { Effort: effortLabelOf(shown, effort ?? shown?.defaultEffort) } : {}),
      },
      options: {
        Model: models.map((m) => m.uiLabel),
        Effort: shown?.effortLabels ?? [],
      },
    }
  })
  ipcMain.handle('remote:codex-cli-reasoning-set', async (_e, axis: unknown, value: unknown) => {
    if (typeof axis !== 'string' || typeof value !== 'string') return false
    if (axis !== 'Model' && axis !== 'Effort') return false
    await pickCodexCliAxis(axis, value)
    return true
  })

  // Explicit "Connect Codex": quits and relaunches Codex WITH the debug port,
  // in the background (`open -g`). This is the one interruption in the Codex
  // lane, so it is always user-initiated and never happens mid-utterance.
  // ── Claude desktop ──────────────────────────────────────────────────────
  // Three verbs, matching the three things the spike scoped: answer a prompt,
  // send into an existing conversation, start a new one. Each returns a typed
  // reason on failure rather than a bare false, because every failure here is
  // something the user can act on ("open Claude Desktop", "answer it in the
  // app") and a silent false gives them nothing.
  ipcMain.handle('remote:claude-desktop-answer', async (_e, taskId: unknown, option: unknown) => {
    if (!manager) return { ok: false, reason: 'not-ready' }
    if (typeof taskId !== 'string' || typeof option !== 'string') return { ok: false, reason: 'bad-args' }
    const out = await manager.answerClaudeDesktop(taskId, option).catch((e) => ({ ok: false, reason: (e as Error).message }))
    log.event('claude-desktop-answer-requested', { ok: out.ok, reason: out.reason ?? null })
    return out
  })

  ipcMain.handle('remote:claude-desktop-send', async (_e, taskId: unknown, text: unknown) => {
    if (!manager) return { ok: false, reason: 'not-ready' }
    if (typeof taskId !== 'string' || typeof text !== 'string') return { ok: false, reason: 'bad-args' }
    const out = await manager.sendClaudeDesktop(taskId, text).catch((e) => ({ ok: false, reason: (e as Error).message }))
    log.event('claude-desktop-send-requested', { ok: out.ok, reason: out.reason ?? null })
    return out
  })

  ipcMain.handle('remote:claude-desktop-create', async (_e, intent: unknown) => {
    if (!manager) return { ok: false, reason: 'not-ready' }
    if (typeof intent !== 'string') return { ok: false, reason: 'bad-args' }
    const out = await manager.createClaudeDesktop(intent).catch((e) => ({ ok: false, reason: (e as Error).message }))
    log.event('claude-desktop-create-requested', { ok: out.ok, reason: out.reason ?? null })
    return out
  })

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
    // THE FIFTH "COMING SOON" GUARD, and the last. Codex CLI was coerced to
    // Claude here too — so even a selection that survived isDispatchable would
    // be silently rewritten on its way to the setting.
    //
    // Every one of these was correct when written and every one failed
    // SILENTLY once it was not: no error, no log the user sees, just a control
    // that does nothing. They were spread across five files with no common
    // marker, which is why using the feature found them and reading the code
    // did not.
    if (!isDispatchable(agent)) { log.warn('set-agent-rejected', { agent }); return false }
    settings.set('agent', agent)
    const a = agent
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
