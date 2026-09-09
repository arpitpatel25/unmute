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

import { ipcMain, BrowserWindow, Notification, shell, app, clipboard, powerMonitor, safeStorage } from 'electron'
import Store from 'electron-store'
import { join, dirname, basename, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { existsSync, writeFileSync, mkdirSync, statSync, watch, constants as fsConstants, promises as fs } from 'node:fs'
import { execFile } from 'node:child_process'
import { TaskManager, type Task } from './task-manager'
import { draftInput } from './task-input'
import { safeArtifactURL, artifactPathAction } from './artifact-url'
import { ClaudeTaskSession, type ClaudeTaskModel } from './claude/task-session'
import { writeFileAtomic } from './atomic-file'
import { TaskDraftStore } from './task-draft'
import { stageTaskDraftAttachment, persistTaskDraftFile } from './task-draft-attachment'
import { TaskFollowupCoordinator, type SubmitDraftOutcome, type DraftSubmissionRequest } from './task-followup'
import { ComposerDictationCoordinator, applyComposerDictation, dispatchCaptureWithLifecycle, startComposerDictation, type ComposerDictationDelivery } from './composer-dictation'
export type { ComposerDictationDelivery } from './composer-dictation'
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
import { nameIntent, type CompleteFn } from './intent-cleanup'
import { MODELS } from './config'
import { initRuntimeConfig, getModels, getKnobs, getModelCatalog, isSelectableModel } from './runtime-config'
import {
  deriveRemoteKey,
  parseExplicitAgentAddress,
  resolveCaptureDestination,
  type CaptureDestination,
  type TriggerKey,
} from './mode-router'
import { configureRemoteLogging, createLogger, getRemoteLogFilePath } from './log'
import { fixPath } from './fix-path'
import { buildSetupChecklist, setupComplete, blockerOf, confirmationKey, type BackendProbe } from './setup-status'
import { createOverlayWindow, presentOrExpand, expandOverlay, openOverlay, dismissOverlay, setDockedMode, reconcileDock, onNewTask, getOverlayMode, setOverlayInteractive, pauseOverlayEscape, resumeOverlayEscape, setOverlaySuppressed } from './overlay'
import { registerOrchestrateShortcut, openOrchestrateWindow } from './orchestrate'
import { Router, type RoutableTask, type AgentAvailability } from './router'
import { CodexRouterEngine } from './codex-router-engine'
import { prefersCodexRouter, routerScopeMatches } from './router-select'
import { WIDGET_CAPTURE_KEY, setWidgetCaptureReader, refreshWidgetCapturePolicy } from './notetakerWidget'
import { HeadlessRouterEngine } from './headless-router-engine'
import { CodexExecRouterEngine } from './codex-exec-router-engine'
import { knownProjects, projectSlug } from './projects'
import { GroupRegistry, type GroupEntry } from './group-registry'
import type { GroupOption } from './router'
import { provisionalName } from './provisional-name'
import { recordSkillUsage, readSkillStats, defaultStatsPath } from './skill-usage'
import { startMcpServer, MCP_PATH, type McpCreateTaskInput, type McpServer } from './mcp-server'
import { CapabilityRegistry } from './agent/capabilities/registry'
import { MemoryCapability } from './agent/capabilities/memory'
import {
  DeliveryCapability,
  DeliveryCapabilityError,
  type AttachmentDeliveryTransaction,
  type DeliveryAttachmentMetadata,
} from './agent/capabilities/delivery'
import { AgentTokenStore } from './agent/tokens'
import { AgentRunSupervisor } from './agent/supervisor'
import { AgentJournal } from './agent/journal'
import {
  UnmuteAgentController,
  type AgentInteractionActivity,
  type AgentInteractionInput,
  type AgentInteractionResult,
} from './agent/controller'
import { ClaudeCodeProvider } from './agent/providers/claude'
import { agentRuntimeMode, reapHeadlessTurns } from './agent/providers/claude-headless'
import { reapCodexHeadlessTurns } from './agent/providers/codex-headless'
import { agentConstitution } from './agent/constitution'
import { loadPersona } from './agent/persona'
import { AgentConversationLifecycle } from './agent/lifecycle'
import { AgentConversationStore } from './agent/conversation-store'
import { buildHandoffPrompt, HandoffCapability } from './agent/capabilities/handoff'
import { ProviderHealth } from './agent/providerHealth'
import { HistoryCapability } from './agent/capabilities/history'
import { NotetakerCapability, type NotetakerAdapters } from './agent/capabilities/notetaker'
import { SessionsCapability } from './agent/capabilities/sessions'
import { locateSession } from './agent/sessions/locate'
import { SessionTurnIndex } from './agent/sessions/turn-index'
import { AgentContinuationService } from './agent/sessions/service'
import { validateContinuationSources } from './agent/sessions/sources'
import { isDescriptiveTitle, requireWorkspaceLabel } from './agent/metadata'

let unmuteAgentLifecycle: AgentConversationLifecycle | AgentRuntimeClient | null = null
import { CodexCliProvider } from './agent/providers/codex'
import { probeCli, type AgentProviderId, type ProviderProbe } from './agent/provider'
import { SafeStorageKeyProvider } from './agent/memory/key-provider'
import { MemoryCrypto } from './agent/memory/crypto'
import { EncryptedRecordStore, presentMemoryRecord } from './agent/memory/record-store'
import { InteractionAttachmentHandles, EncryptedAttachmentStore } from './agent/memory/attachments'
import { JsonlMemoryAudit } from './agent/memory/audit'
import { DurableMemoryMutationJournal } from './agent/memory/journal'
import { openSqlCipherMemoryIndex } from './agent/memory/sqlcipher-index'
import { MemoryService } from './agent/memory/service'
import { SESSION_PREAMBLE } from './session-policy'
import { installHookSettingsSync, hookToken } from './hooks'
import { parseHookEvent, type HookEvent } from './observer'
import type { ExecutorFactoryOpts } from './executor'
import { startCuaServer, CUA_MCP_PORT, CUA_MCP_PATH, type CuaServer } from './cua/server'
import { NotchClient } from './notch/notch-client'
import { NotchController } from './notch/notch-controller'
import { PillController, type PillStateP } from './notch/pill-controller'
import { listCodexModels, matchCurrent, type CodexModel } from './codex/appserver'
import { listCodexCliModels, resolveCodexCliChoice, codexCliChoiceLabel } from './codex/cli-models'
import { CodexHub, type CodexInputMetadata } from './codex/hub'
import { CodexAppServer } from './codex/app-server-client'
import { PersistentRuntimeClient } from './runtime/client'
import { PersistentCodexHub } from './runtime/codex-client'
import { CompatibleCodexRuntime } from './runtime/codex-routing'
import { CompatibleAgentRuntime, recoverAgentRuntime } from './runtime/agent-routing'
import { PersistentClaudeTaskSession } from './runtime/claude-client'
import { AgentRuntimeClient } from './runtime/agent-client'
import { registerRuntimeHost } from './runtime/host-bridge'
import { resolveCodexCli } from './codex/driver'
import { DriverManager } from './cua/driver-manager'
import { CdpLane } from './cua/lanes/cdp'
import { Arming } from './cua/lanes/arming'
import { runAppleScript } from './cua/lanes/applescript'
import { type RouterCtx } from './cua/router'
import { Presence } from './presence'
import { listImportableSessions, findSessionCwd } from './claude-cli-sessions'
import { listImportableCodexSessions, findCodexSessionCwd } from './codex/cli-session'
import { applyAxRegistration, AX_MCP_NAME, STEER_BODY } from './ax/register'
import { sweepUnmuteFromCodexAfterConnect } from './ax/codex-prune'
import { normalizePolicy, type AxPolicy } from './ax/policy'
import { locateTranscript } from './trace-reducer'
import {
  resolveTmuxBin, sessionNameFor, taskIdsFromTmuxSessionList,
  tmuxAttachArgs, tmuxKillSessionArgs, tmuxListSessionNamesArgs, TMUX_CONF,
} from './tmux'
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
import {
  beginTaskReplyTrace,
  emitTaskReplyInput,
  emitTaskReplyStep,
  finishTaskReplyTrace,
  type TaskReplySource,
  type TaskReplyTrace,
} from './task-reply-trace'
import { createClipboardWatch } from './capture/clipboardWatch'
import { createScreenshotWatch } from './capture/screenshotWatch'
import {
  adoptPersistedPad, armScratchpad, beginOwnClipboardSequence, claimShared, deliveryInFlight, discard as discardPad,
  copyHistoryToClipboard, gateDelivery, heldForSurface, initWatchers, padDirOf, pasteAtCursor, recordInsert,
  registerPadObserver, registerSettings, removeFromPad, runDelivery, snapshot,
  registerComposerImageSink, endOwnClipboardSequence,
  type DeliveryTarget,
} from './capture/index'
import {
  attachToTaskDraft,
  registerTaskDraftAttachmentSink,
} from './task-attachment-paste'
import { SETTLE_IDLE_MS } from './capture/scratchpadStore'
import type { Destination, Entry, InsertKind } from './capture/types'

/**
 * The lane a capture is on — cursor (fn), task (right-Option), agent
 * (right-Command).
 *
 * AN ALIAS, NOT A SECOND UNION. The authority is `captureRoute.ts` in the
 * engine tree, which this file cannot import: engine-overrides/electron/ is a
 * sibling tree, and a relative path that resolves after wire-into-engine.sh's
 * copy does not resolve here (see notetakerInit.ts's header, and the TS2307s
 * that keyboard.ts and db.ts carry for exactly this reason). Aliasing the pad's
 * own `Destination` instead of retyping the three literals means the two cannot
 * drift apart silently — they were deliberately given the same vocabulary so
 * a capture's route and the pad's address are one word, not two that have to
 * be mapped.
 */
type CaptureRoute = Destination
import { CaptureHistoryStore, clipboardPayload, type CaptureHistoryKind } from './capture/history-store'
import { screenCaptureVisibility } from './screen-capture-visibility'
import type { ScratchpadEntryP, ScratchpadPayloadP, ChatConfigP } from './notch/notch-client'

// ─── Loose interfaces for the OSS engine singletons we wire into ───
// Accepted as opaque shapes (like paywall/main-extensions' OSSAdapter) so we
// don't entangle with engine internals. main.ts passes its real instances.
interface SessionManagerLike {
  startRemoteCapture(targetTaskId?: string | null, agentAddressed?: boolean, composerDictation?: ComposerDictationDelivery): void
  stopRemoteCapture(): Promise<void>
  cancelSession?(): void
  onComposerDictationQueued?: ((token: string) => void) | null
  /** Move the LIVE capture to another lane. Returns false when there is
   *  nothing hot to move — the mic is the only window in which this is legal. */
  setCaptureRoute?(route: CaptureRoute): boolean
  /** The live capture's lane, or null when nothing is recording. */
  readonly captureRoute?: CaptureRoute | null
  /** Announced when the live capture changes lanes, so the surfaces this file
   *  owns — the pill's chips, the notch's capture label — can follow. */
  onCaptureRouteChanged?: ((route: CaptureRoute) => void) | null
  /** Fired from every ending the session has — dispatch, cancel, too-short,
   *  junk STT. Declared here so the lane locks can be cleared however a capture
   *  dies, rather than only by its own stop tap. */
  onSessionEnded?: ((identity?: { sessionId: string; composerDictationToken?: string }) => void) | null
}
interface KeyboardManagerLike {
  on(event: 'keyboard', cb: (e: { type: string }) => void): unknown
  /** Clears the Orchestrator and Agent locks. Never dictation's — that lane is
   *  the user's way out when something else is wedged.
   *
   *  IT NOW HAS CALLERS. It was added to fix exactly the failure its name
   *  describes and then never subscribed to — see the refusal paths in the
   *  keyboard handler below, which is where a lane latches with no capture
   *  behind it and therefore no session whose ending could clear it. */
  onCaptureEnded?(): void
  /** Whether the Agent can take work, pushed down so the keyboard can refuse a
   *  press BEFORE it latches the lane rather than after. */
  setUnmuteAgentAvailable?(available: boolean): void
  /** Finish the live capture exactly as its own trigger key would, whichever
   *  lane it is on. Returns false if nothing is recording. See the pill's
   *  `stop` dep below for why the tick needs this and not a widget event. */
  submitActiveCapture?(): boolean
}
export interface RemoteInitDeps {
  sessionManager: SessionManagerLike
  keyboardManager: KeyboardManagerLike
  /** Opaque, injected exactly like sessionManager/keyboardManager above —
   *  the real implementation lives in engine-overrides/electron/notetakerInit.ts,
   *  which cannot be imported directly from this file (see that file's own
   *  header comment on why a cross-tree import breaks local typecheck).
   *  Optional: a build without the notetaker feature wired simply never
   *  registers the capability, same as any other missing dependency. */
  notetaker?: NotetakerAdapters
  /** One-shot call to the user's OWN local CLI, for maintaining session
   *  summaries. Injected for the same reason as `notetaker`: the real
   *  implementation is engine-overrides/electron/notetaker/headlessAgent.ts,
   *  which this tree cannot import. Spends the user's own CLI usage, never
   *  Unmute's managed billing. Absent = summaries are simply never written,
   *  and the Agent falls through to reading transcripts itself. */
  runHeadless?: (
    provider: 'claude' | 'codex',
    input: string,
  ) => Promise<{ ok: true; output: string } | { ok: false; error: string }>
  /** Hold background audio quiet on demand, and give it back. Injected for the
   *  same reason as the two above: the implementation is
   *  engine-overrides/electron/mediaController.ts, which this tree cannot
   *  import. Absent = the control is inert; it never breaks a card. */
  backgroundAudio?: { hold(): void; release(): void }
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
  /** Ground tone beneath expanded surfaces. */
  surfaceTone: 'spaceGray' | 'black' | 'glass'
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
  /** Provider used only by the privileged Unmute Agent, never task routing. */
  unmuteAgentProvider: AgentProviderId
  /** Internal rollout gate. Existing Unmute remains unchanged while false. */
  unmuteAgentAvailable: boolean
  /** Maximum concurrently owned Agent CLI processes. */
  unmuteAgentMaxProcesses: number
  unmuteAgentConversationCeiling: number
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
    surfaceTone: 'glass',
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
    unmuteAgentProvider: 'claude',
    unmuteAgentAvailable: false,
    unmuteAgentMaxProcesses: 2,
    unmuteAgentConversationCeiling: 20,
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
    if (p.surface === 'cli') {
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

/**
 * The notetaker's cleanup/summarization pipeline (2026-08-25 spec) needs to
 * know whether Claude Code CLI / Codex CLI is actually usable right now —
 * reusing probeBackends()'s existing detection rather than re-implementing
 * CLI/sign-in probing a second time. Passed to notetakerInit.ts as the
 * `getAgentAvailability` hook (same cross-tree opaque-injection pattern as
 * onOpenMeeting — see notetakerInit.ts's own header
 * comment on why this OSS-tree file can't import probeBackends directly).
 * Filtered to just the two PTY-transport CLI backends: a driven desktop
 * app can't run headlessly, so it's irrelevant here regardless of its own
 * readiness.
 */
export async function getAgentAvailability(): Promise<{ claude: boolean; codex: boolean }> {
  const probes = await probeBackends()
  return {
    claude: probes.find((b) => b.id === 'claude')?.ready ?? false,
    codex: probes.find((b) => b.id === 'codex')?.ready ?? false,
  }
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
async function createAgentWorkspace(group: unknown) {
  if (!groupRegistry) throw new Error('Workspaces are not initialized')
  const entry = groupRegistry.resolve(requireWorkspaceLabel(group))!
  await groupRegistry.flush()
  return { id: entry.id, label: entry.label }
}
/** What the Agent cannot read off the disk: which sessions Unmute is holding
 *  open. A live card takes a follow-up as it is, so knowing this is what keeps
 *  the Agent from resuming a conversation that never went away. */
function openAgentSessions(limit?: number) {
  if (!manager) return []
  // Warm and in-front-of-you are different questions with different answers;
  // only the notch knows the second one.
  const pocket = notchController?.pocketTaskIds() ?? new Set<string>()
  return manager.list()
    .filter(task => task.state === 'needs-user' || manager!.isLive(task.id))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit ?? 50)
    .map(task => {
      const workspace = groupRegistry?.get(task.groupId) || groupRegistry?.find(task.group)
      return {
        taskId: task.id,
        sessionId: task.codexRolloutId ?? task.sessionId,
        state: task.state,
        live: manager!.isLive(task.id),
        inPocket: pocket.has(task.id),
        updatedAt: task.updatedAt,
        ...(task.agent === 'claude' || task.agent === 'codex' ? { provider: task.agent } : {}),
        ...(task.cwd ? { cwd: task.cwd } : {}),
        ...(isDescriptiveTitle(task.name, task.cwd) ? { title: task.name! } : {}),
        ...(workspace ? { workspace: workspace.label } : {}),
      }
    })
}

/** The undo. Removing a card is an Unmute operation, not a provider one: the
 *  transcript is untouched and the session can be resumed again by id. Closing
 *  one that is already gone is a success, so a correction never fails twice. */
async function closeAgentSession(taskId: string) {
  if (!manager) throw new Error('Unmute Remote is not initialized')
  if (!manager.get(taskId)) return { taskId, closed: false }
  await manager.remove(taskId)
  return { taskId, closed: true }
}
const turnIndex = new SessionTurnIndex()
let continuationInteractionId: string | undefined
const agentContinuations = new AgentContinuationService({
  interactionId: () => continuationInteractionId,
  operationRoot: join(homedir(), '.unmute', 'remote', 'continuation-operations'),
  // Only what the continuation service needs, bound explicitly. A spread of the
  // TaskManager would copy fields and lose prototype methods.
  manager: () => manager && {
    list: () => manager!.list(),
    resume: (id: string) => manager!.resume(id),
    deliverDraft: (id: string, text: string, attachments: readonly string[]) => manager!.deliverDraft(id, text, [...attachments]),
    attachProviderSession: (i: Parameters<TaskManager['attachProviderSession']>[0]) => manager!.attachProviderSession(i),
    forkProviderSession: (i: Parameters<TaskManager['forkProviderSession']>[0]) => manager!.forkProviderSession(i),
    setName: (id: string, name: string) => manager!.setName(id, name),
    setGroup: (id: string, group: string) => manager!.setGroup(id, group),
    // Where a message goes when the session reopened but would not take it yet.
    saveDraft: (id: string, text: string) => { taskDrafts.setText(id, text) },
    // resume() marks a card resumable; opened() is what respawns its session.
    opened: (id: string) => manager!.opened(id),
    isLive: (id: string) => manager!.isLive(id),
    setShelved: (id: string, shelved: boolean) => manager!.setShelved(id, shelved),
    setKind: (id: string, kind: 'oneoff' | 'session') => manager!.setKind(id, kind),
  },
  locate: locateSession,
  workspaces: () => groupRegistry,
  scratchRoot: join(homedir(), '.unmute', 'remote', 'local'),
  ensureDirectory: path => fs.mkdir(path, { recursive: true }).then(() => undefined),
})
/** The OSS engine's session manager, kept so the few things that need to ask
 *  the LIVE capture a question (which lane is it on?) can, without threading
 *  `deps` through every helper. Set once by initRemote; opaque by contract. */
let sessionManagerRef: SessionManagerLike | null = null

type UnmuteAgentUnavailableReason =
  | 'disabled'
  | 'initializing'
  | 'keychain-unavailable'
  | 'storage-unavailable'
  | 'provider-unavailable'

interface UnmuteAgentProviderAvailability {
  id: AgentProviderId
  label: string
  available: boolean
  reason?: 'not-installed'
}

interface UnmuteAgentAvailability {
  available: boolean
  reason?: UnmuteAgentUnavailableReason
  providers: UnmuteAgentProviderAvailability[]
}

function initializationFailureCode(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined
  if (typeof code !== 'string') return 'storage-unavailable'
  const allowed = new Set([
    'keychain-unavailable',
    'index-unavailable',
    'storage-full',
    'recovery-failed',
    'service-unavailable',
    'native-unavailable',
    'cipher-unavailable',
    'open-failed',
  ])
  return allowed.has(code) ? code : 'storage-unavailable'
}

function unavailableAgentError(reason: UnmuteAgentUnavailableReason | undefined) {
  if (reason === 'keychain-unavailable') {
    return {
      code: 'keychain-unavailable',
      message: 'Encrypted Agent memory is unavailable because secure key protection could not be opened.',
    }
  }
  if (reason === 'storage-unavailable') {
    return {
      code: 'storage-unavailable',
      message: 'Encrypted Agent memory is unavailable. Existing Unmute features remain available.',
    }
  }
  return {
    code: 'provider-unavailable',
    message: 'Unmute Agent is unavailable. Check its provider in settings.',
  }
}

let unmuteAgentAvailability: UnmuteAgentAvailability = {
  available: false,
  reason: 'disabled',
  providers: [],
}
let unmuteAgentTokens: AgentTokenStore | null = null
let unmuteAgentRecords: Pick<EncryptedRecordStore, 'list'> | null = null
let unmuteAgentMemory: Pick<MemoryService, 'get' | 'forget' | 'restore'> | null = null
let unmuteAgentRegistry: CapabilityRegistry = new CapabilityRegistry([])
/** Set once, at the top of initRemote(deps), from deps.notetaker — see
 *  RemoteInitDeps's own comment on why this arrives as an injected opaque
 *  shape rather than a direct import. Read by initializeUnmuteAgent() when
 *  it builds the registry below. */
let notetakerAdapters: NotetakerAdapters | null = null
let runHeadlessSummary: RemoteInitDeps['runHeadless'] | null = null

/**
 * Which Agent CLIs are currently working. In-memory and never persisted — see
 * agent/providerHealth.ts for why the user's own setting is left alone.
 */
const agentProviderHealth = new ProviderHealth()

/** Whether a provider's CLI is actually present on this machine. */
function agentProviderInstalled(id: AgentProviderId): boolean {
  return unmuteAgentAvailability.providers.find((p) => p.id === id)?.available === true
}

/**
 * The provider the Agent should USE right now.
 *
 * Distinct from `settings.get('unmuteAgentProvider')`, which is the provider
 * the user CHOSE. They differ only while the chosen one is cooling down after a
 * failure, and they converge again on their own — nothing here writes settings.
 */
function resolveAgentProvider(): AgentProviderId {
  const preferred = settings.get('unmuteAgentProvider')
  const [effective] = agentProviderHealth.order(preferred, agentProviderInstalled)
  if (effective !== preferred) {
    log.event('agent-provider-fallback', {
      chosen: preferred,
      using: effective,
      health: agentProviderHealth.snapshot(),
    })
  }
  return effective
}

/**
 * Runs one headless Agent request, trying the other CLI if the first fails.
 *
 * A failure marks the provider so the NEXT request skips it outright: without
 * that, every call keeps paying for a doomed launch before its working retry.
 */
async function runAgentHeadless(
  input: string,
): Promise<{ ok: true; output: string } | { ok: false; error: string }> {
  const run = runHeadlessSummary
  if (!run) return { ok: false, error: 'headless agent is not wired in this build' }
  const preferred = settings.get('unmuteAgentProvider')
  const order = agentProviderHealth.order(preferred, agentProviderInstalled)
  let last: { ok: false; error: string } = { ok: false, error: 'no agent provider available' }
  for (const provider of order) {
    const result = await run(provider, input)
    if (result.ok) {
      agentProviderHealth.markWorking(provider)
      return result
    }
    agentProviderHealth.markFailed(provider)
    log.warn('agent provider failed — cooling it down', {
      provider, chosen: preferred, error: result.error.slice(0, 200),
    })
    last = result
  }
  return last
}
let unmuteAgentSupervisor: (Pick<AgentRunSupervisor, 'interrupt'> & Partial<Pick<AgentRunSupervisor, 'dispose'>>) | null = null
let unmuteAgentController: UnmuteAgentController | null = null
let unmuteAgentIndex: ReturnType<typeof openSqlCipherMemoryIndex> | null = null
let unmuteAgentGeneration = 0
let mcpServer: McpServer | null = null
let mcpServerGeneration = 0
const agentHookListeners = new Set<(event: HookEvent) => void>()
const AGENT_CLIPBOARD_ATTACHMENT_TTL_MS = 60 * 60 * 1_000

function bufferedAttachmentDelivery(
  metadata: DeliveryAttachmentMetadata,
  publish: (data: Uint8Array) => Promise<void>,
): AttachmentDeliveryTransaction {
  const chunks: Buffer[] = []
  let bytes = 0
  let settled = false
  const clear = () => {
    for (const chunk of chunks) chunk.fill(0)
    chunks.length = 0
    bytes = 0
  }
  return {
    async write(chunk) {
      if (settled) throw new DeliveryCapabilityError('delivery-failed')
      bytes += chunk.byteLength
      if (bytes > metadata.size) {
        settled = true
        clear()
        throw new DeliveryCapabilityError('delivery-failed')
      }
      chunks.push(Buffer.from(chunk))
    },
    async commit() {
      if (settled || bytes !== metadata.size) throw new DeliveryCapabilityError('delivery-failed')
      settled = true
      const data = Buffer.concat(chunks, bytes)
      clear()
      try { await publish(data) } finally { data.fill(0) }
    },
    async rollback() {
      settled = true
      clear()
    },
  }
}

/**
 * Materialise a stored attachment and hand it to whichever application owns it.
 *
 * Records are encrypted at rest and DeliveryAttachment is a stream with no
 * path — deliberately, so a path never crosses the capability boundary. Opening
 * therefore means writing a decrypted copy into the same 0700 delivery root the
 * clipboard path already uses, and asking the system to open THAT. The Agent
 * still never sees or composes a path.
 */
async function openAgentAttachment(
  root: string,
  metadata: DeliveryAttachmentMetadata,
  data: Uint8Array,
): Promise<void> {
  const deliveryRoot = join(root, 'delivery')
  const target = join(deliveryRoot, `${randomUUID()}-${basename(metadata.name)}`)
  await fs.mkdir(deliveryRoot, { recursive: true, mode: 0o700 })
  await fs.writeFile(target, data, { mode: 0o600, flag: 'wx' })
  const failure = await shell.openPath(target)
  if (failure) throw new DeliveryCapabilityError('delivery-failed')
}

async function copyAgentAttachment(
  root: string,
  metadata: DeliveryAttachmentMetadata,
  data: Uint8Array,
): Promise<void> {
  const deliveryRoot = join(root, 'delivery')
  const name = basename(metadata.name)
  const target = join(deliveryRoot, `${randomUUID()}-${name}`)
  let published = false
  try {
    await fs.mkdir(deliveryRoot, { recursive: true, mode: 0o700 })
    await fs.writeFile(target, data, { mode: 0o600, flag: 'wx' })
    const fileUrl = pathToFileURL(target).toString()
    let ownsClipboard = false
    try {
      try { beginOwnClipboardSequence(); ownsClipboard = true } catch { /* watcher may not be armed */ }
      clipboard.writeBuffer('public.file-url', Buffer.from(fileUrl, 'utf8'))
      const confirmed = clipboard.readBuffer('public.file-url')
        .toString('utf8')
        .replace(/\0+$/u, '')
      if (confirmed !== fileUrl) throw new DeliveryCapabilityError('delivery-failed')
      published = true
    } finally {
      if (ownsClipboard) {
        try { endOwnClipboardSequence(Date.now()) } catch { /* watcher may have stopped */ }
      }
    }
  } catch (error) {
    if (!published) await fs.unlink(target).catch(() => {})
    if (error instanceof DeliveryCapabilityError) throw error
    throw new DeliveryCapabilityError('delivery-failed')
  }
  const cleanup = setTimeout(() => { void fs.unlink(target).catch(() => {}) }, AGENT_CLIPBOARD_ATTACHMENT_TTL_MS)
  cleanup.unref()
}

/**
 * What a captured file actually is.
 *
 * The attachment store already infers a type when none is declared; this exists
 * so the declaration itself stops being a lie. Screenshots remain the common
 * case and still resolve to image/png through the same table.
 */
const CAPTURE_MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.heic': 'image/heic',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown',
  '.json': 'application/json', '.csv': 'text/csv',
  '.mov': 'video/quicktime', '.mp4': 'video/mp4', '.m4v': 'video/x-m4v',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
}

function captureMimeType(path: string): string {
  const at = basename(path).lastIndexOf('.')
  const extension = at < 0 ? '' : basename(path).slice(at).toLowerCase()
  return CAPTURE_MIME[extension] ?? 'application/octet-stream'
}

const AGENT_CONSTITUTION = agentConstitution(SESSION_PREAMBLE)

/**
 * An index record as the Agent's tools describe a session.
 *
 * `project` is the one field worth watching: for a session Unmute started it
 * comes from the TASK, because the cwd is a scratch directory named after the
 * task and reporting that uuid as a project is exactly what made the old
 * sessions_list unreadable.
 */

function providerAvailability(probes: readonly ProviderProbe[]): UnmuteAgentProviderAvailability[] {
  return (['claude', 'codex'] as const).map((id) => {
    const probe = probes.find((candidate) => candidate.provider === id)
    return {
      id,
      label: id === 'claude' ? 'Claude Code CLI' : 'Codex CLI',
      available: probe?.available === true,
      ...(probe?.available === true ? {} : { reason: 'not-installed' as const }),
    }
  })
}

async function probeUnmuteAgentProviders(): Promise<UnmuteAgentProviderAvailability[]> {
  const probes = await Promise.all((['claude', 'codex'] as const).map(async (provider) => ({
    provider,
    available: await probeCli(provider).catch(() => false),
    reason: 'not-installed' as const,
  })))
  return providerAvailability(probes)
}

type UnmuteAgentActivityState = 'listening' | 'searching' | 'thinking' | 'confirming' | 'complete' | 'failed'

interface UnmuteAgentActivitySnapshot {
  state: UnmuteAgentActivityState
  summary: string
  interactionId?: string
  agentRunId?: string
  provider?: AgentProviderId
}

function presentUnmuteAgentActivity(activity: AgentInteractionActivity): UnmuteAgentActivitySnapshot {
  const state: UnmuteAgentActivityState = activity.kind === 'searching-memory'
    ? 'searching'
    : activity.kind === 'waiting'
      ? 'confirming'
      : 'thinking'
  return {
    state,
    summary: activity.summary,
    interactionId: activity.interactionId,
    agentRunId: activity.agentRunId,
    ...(activity.provider ? { provider: activity.provider } : {}),
  }
}

function broadcastUnmuteAgentActivity(activity: AgentInteractionActivity | UnmuteAgentActivitySnapshot): void {
  const snapshot = 'state' in activity ? activity : presentUnmuteAgentActivity(activity)
  if (snapshot.interactionId) continuationInteractionId = snapshot.interactionId
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('remote:agent-activity', snapshot)
  }
  notchClient?.send({ type: 'agentActivity', activity: snapshot })
}

async function submitUnmuteAgent(
  input: AgentInteractionInput,
  /**
   * Did the user address this at the Agent by pressing its own key?
   *
   * IF SO, A FOCUSED COMPOSER IS NOT A DESTINATION. The Agent is handed
   * `activeTaskId` so it can act on the thing you are working in, and it can
   * stage text into that task's draft with delivery_copy_text(taskId). That is
   * right for an Agent turn raised from inside a task, and wrong for one you
   * raised by pressing right-Command: the key IS the statement about who you
   * are talking to, and a text box having focus is not. Reported as "the Agent
   * key goes into whatever is open in the pocket".
   */
  addressedByKey = false,
  enqueue?: { revision: number; acknowledged(): void },
): Promise<AgentInteractionResult> {
  if (!unmuteAgentLifecycle) throw new Error('Unmute Agent is unavailable')
  const focusedTaskId = (input.currentContext?.activeTaskId || addressedByKey)
    ? undefined
    : notchController?.focusedComposerTaskId()
  const focusedTask = focusedTaskId ? manager?.get(focusedTaskId) : undefined
  const effectiveInput: AgentInteractionInput = focusedTaskId && focusedTask
    ? {
        ...input,
        currentContext: {
          ...input.currentContext,
          activeTaskId: focusedTaskId,
          ...(focusedTask.name ? { activeTaskName: focusedTask.name } : {}),
        },
      }
    : input
  broadcastUnmuteAgentActivity({
    state: 'listening',
    summary: 'Listening to Unmute Agent',
    ...(input.priorRunId ? { agentRunId: input.priorRunId } : {}),
  })
  try {
    if (!unmuteAgentLifecycle) throw new Error('Unmute Agent conversation is unavailable')
    const queued = await unmuteAgentLifecycle.enqueue(effectiveInput, enqueue?.revision)
    enqueue?.acknowledged()
    const result = await queued.completion
    if (result.presentation === 'task' && result.outcome === 'completed' && result.text?.trim()) {
      await manager?.presentAgentResult({
        agentRunId: result.agentRunId,
        intent: input.transcript,
        text: result.text,
        provider: result.provider,
      })
    }
    broadcastUnmuteAgentActivity({
      state: result.outcome === 'completed' ? 'complete' : 'failed',
      summary: result.outcome === 'completed'
        ? (result.text?.trim() || 'Done')
        : (result.error?.message || 'Unmute Agent could not complete that request'),
      interactionId: result.interactionId,
      agentRunId: result.agentRunId,
      ...(result.provider ? { provider: result.provider } : {}),
    })
    return result
  } catch (error) {
    broadcastUnmuteAgentActivity({
      state: 'failed',
      summary: 'Unmute Agent could not complete that request.',
    })
    throw error
  }
}

function disposeUnmuteAgent(): void {
  unmuteAgentGeneration += 1
  unmuteAgentLifecycle?.dispose()
  unmuteAgentLifecycle = null
  const supervisor = unmuteAgentSupervisor
  const controller = unmuteAgentController
  const index = unmuteAgentIndex
  // The sweeper spends money in the background; it must not outlive the Agent.
  unmuteAgentSupervisor = null
  unmuteAgentController = null
  unmuteAgentTokens = null
  unmuteAgentMemory = null
  unmuteAgentRecords = null
  unmuteAgentRegistry = new CapabilityRegistry([])
  unmuteAgentIndex = null
  unmuteAgentAvailability = { available: false, reason: 'disabled', providers: [] }
  agentHookListeners.clear()
  controller?.dispose()
  void (supervisor?.dispose?.() ?? Promise.resolve())
    .catch(() => {
      log.warn('unmute agent shutdown failed', { code: 'shutdown-failed' })
    })
    .finally(() => {
      try { index?.close() } catch { /* best effort during shutdown */ }
    })
}

function disposeMcpServer(): void {
  mcpServerGeneration += 1
  try { mcpServer?.close() } catch { /* best effort during shutdown */ }
  mcpServer = null
}

async function initializeUnmuteAgentLegacy(): Promise<void> {
  const generation = ++unmuteAgentGeneration
  const gate = settings.get('unmuteAgentAvailable') === true
  if (!gate) {
    unmuteAgentAvailability = { available: false, reason: 'disabled', providers: [] }
    void probeUnmuteAgentProviders().then((providers) => {
      if (generation === unmuteAgentGeneration) {
        unmuteAgentAvailability = { available: false, reason: 'disabled', providers }
      }
    })
    return
  }
  unmuteAgentAvailability = { available: false, reason: 'initializing', providers: [] }
  const providers = await probeUnmuteAgentProviders()
  if (generation !== unmuteAgentGeneration) return
  unmuteAgentAvailability = { available: false, reason: 'initializing', providers }
  const root = join(app.getPath('userData'), 'unmute-agent')
  const memoryRoot = join(root, 'memory')
  let pendingIndex: ReturnType<typeof openSqlCipherMemoryIndex> | null = null
  let pendingSupervisor: AgentRunSupervisor | null = null
  let pendingController: UnmuteAgentController | null = null
  try {
    const keyProvider = new SafeStorageKeyProvider({ root: memoryRoot, protectedValueStore: safeStorage })
    const key = await keyProvider.getMasterKey()
    if (generation !== unmuteAgentGeneration) { key.fill(0); return }
    mkdirSync(join(memoryRoot, 'index'), { recursive: true, mode: 0o700 })
    const crypto = new MemoryCrypto({ keyProvider })
    const handles = new InteractionAttachmentHandles()
    const records = new EncryptedRecordStore({ root: memoryRoot, crypto })
    const attachments = new EncryptedAttachmentStore({ root: memoryRoot, crypto, handles })
    let index: ReturnType<typeof openSqlCipherMemoryIndex>
    try {
      index = openSqlCipherMemoryIndex({
        databasePath: join(memoryRoot, 'index', 'memory.sqlite'),
        key,
        recoverCorruption: true,
      })
    } finally {
      key.fill(0)
    }
    pendingIndex = index
    const memory = new MemoryService({
      records,
      attachments,
      index,
      /**
       * A file the user pointed at, turned into an attachment handle.
       *
       * The checks are here rather than in the tool description because a
       * prompt cannot enforce them: the path is expanded, and the target must
       * exist and be a REGULAR FILE. A directory, a device node or a broken
       * symlink is refused outright rather than half-stored.
       *
       * Nothing here widens the Agent's reach — it already holds Read over the
       * whole disk, so a path it can name is a file it can already open. Size
       * is not checked: the attachment store already keeps anything past its
       * managed ceiling BY REFERENCE to where it lives, so a large video is
       * remembered rather than refused.
       */
      async keepFile(principal, input) {
        const expanded = input.path.startsWith('~')
          ? join(homedir(), input.path.slice(1))
          : input.path
        if (!isAbsolute(expanded)) throw new Error('That path is not absolute')
        const stat = await fs.stat(expanded).catch(() => null)
        if (!stat) throw new Error('There is no file at that path')
        if (!stat.isFile()) throw new Error('That path is not a file')
        await fs.access(expanded, fsConstants.R_OK).catch(() => {
          throw new Error('That file cannot be read')
        })
        const name = input.name ?? basename(expanded)
        const handle = handles.mintCapture(principal, { path: expanded, name })
        log.event('agent-file-kept', { bytes: stat.size, name })
        return handle
      },
      audit: new JsonlMemoryAudit({ root: memoryRoot }),
      journal: new DurableMemoryMutationJournal({ root: memoryRoot }),
    })
    await memory.initialize()
    const tokens = new AgentTokenStore()
    const journal = new AgentJournal({ root: join(root, 'runtime') })
    // SESSION SUMMARIES REMOVED. A background sweep re-derived summaries for
    // every session in a rolling 5-day window, on a 60s timer, by spawning one
    // CLI per session. It invented its own workload: each spawn wrote a rollout
    // file into ~/.codex/sessions, the scanner then found those files as new
    // sessions to summarise, and failures never advanced a cursor so the same
    // work retried forever. Measured on one machine: ~17,000 CLI launches and
    // ~44,000 session files a day, spending the user's own CLI plan on work
    // that produced nothing. The Agent now reads transcripts directly, exactly
    // as a bare Claude Code session does.
    // THE PROMPT COMES FROM THE USER'S FILE, not from the constant.
    //
    // unmute-agent.md is seeded from AGENT_PRINCIPLES on first run and is the
    // prompt from then on — see persona.ts for why it lives in the user's
    // directory rather than in the bundle. The constant remains the default and
    // is still what the eval harness exercises.
    //
    // `constitution.md` stays as the file every provider is pointed at, so the
    // shape of the handoff to the CLI is unchanged: one path, read at spawn.
    const persona = await loadPersona(join(root, 'agent'))
    log.event('unmute-agent-persona', { source: persona.source, chars: persona.text.length })
    const constitutionPath = join(root, 'runtime', 'constitution.md')
    mkdirSync(dirname(constitutionPath), { recursive: true, mode: 0o700 })
    writeFileSync(constitutionPath, agentConstitution(SESSION_PREAMBLE, persona.text),
      { encoding: 'utf8', mode: 0o600 })
    // hookEvents/executor are consumed only by the REPL driver; they stay wired
    // so UNMUTE_AGENT_RUNTIME=repl is a pure environment change. Which driver
    // is live is logged because the two fail in completely different ways.
    // Each interaction receives fresh credentials; conversation continuity uses exact resume.
    const agentRuntime = 'headless' as const
    log.event('unmute-agent-runtime', { runtime: agentRuntime })
    const claude = new ClaudeCodeProvider({
      runtime: agentRuntime,
      hookEvents: {
        subscribe(listener) {
          agentHookListeners.add(listener)
          return () => agentHookListeners.delete(listener)
        },
      },
      executor: { settingsPath: hookSettingsFile ?? undefined },
    })
    const codex = new CodexCliProvider({ runtime: agentRuntime })
    const runtimeProviders = new Map<AgentProviderId, typeof claude | typeof codex>([
      ['claude', claude],
      ['codex', codex],
    ])
    const registry = new CapabilityRegistry([
      new MemoryCapability(memory),
      // WHAT THE USER ACTUALLY SAID, LATELY. The one thing a coding session
      // cannot reach: it lives in Unmute's own archive, not on the filesystem.
      // Read-only, and pasting reuses copyHistoryToClipboard — the same call
      // the History panel's copy button makes, so text and attachments travel
      // together exactly as they do today.
      new HistoryCapability({
        async recent(withinMs) {
          const since = Date.now() - withinMs
          return captureHistory.list()
            .filter((entry) => entry.finalizedAt >= since)
            .sort((a, b) => b.finalizedAt - a.finalizedAt)
            .map((entry) => ({
              id: entry.id,
              lane: entry.kind,
              at: entry.finalizedAt,
              text: entry.text,
              attachments: [...entry.attachments],
              ...(entry.destination ? { destination: entry.destination } : {}),
            }))
        },
        async copy(id) {
          const entry = captureHistory.list().find((candidate) => candidate.id === id)
          if (!entry) return false
          const payload = clipboardPayload(entry)
          return copyHistoryToClipboard(payload.text, payload.attachments)
        },
      }),
      // PICKING PAST WORK BACK UP. The Agent finds the session itself, with
      // the Grep and Read it already holds; this is only the part it cannot
      // do — spawning a process that carries the conversation, and giving it
      // a card, seeing which cards are open, and taking one back. Retrieval is
      // Grep and Read over the transcripts and over the verbatim user-turn
      // index SessionTurnIndex maintains — a FILE, deliberately not a tool,
      // because a tool over readable data caps the Agent at the queries its
      // schema author imagined. That is what sessions_search did.
      new SessionsCapability({
        createWorkspace: createAgentWorkspace,
        workspaces: async () => (groupRegistry?.list() ?? []).map(({ id, label }) => ({ id, label })),
        open: async input => openAgentSessions(input.limit),
        close: input => closeAgentSession(input.taskId),
        resume: input => agentContinuations.resume(input),
        fork: input => agentContinuations.fork(input),
      }),
      // What the user recorded. Optional: only present when the notetaker
      // feature wired its adapters in via RemoteInitDeps.notetaker — a build
      // without it simply never registers this capability, the same as any
      // other missing dependency.
      ...(notetakerAdapters ? [new NotetakerCapability(notetakerAdapters)] : []),
      // Outside work is handed off, never refused and never attempted. The
      // card carries its origin so the user can see the Agent made it.
      new HandoffCapability({
        async createTask(input) {
          if (!manager) throw new Error('Unmute Remote is not initialized')
          await validateContinuationSources(input.sourceSessions, locateSession, input.context)
          // The same dispatch the right-Option key uses. A hand-off is an
          // ordinary Orchestrator task in every respect except that the card
          // can say the Agent asked for it rather than the user (Law IV).
          // Context is BACKGROUND, and the seed says so: the receiving session
          // is fully tooled, and every clause it reads as a request is work it
          // will actually go and do. It used to be a list of bare uuids the new
          // session had no way to resolve.
          const seeded = buildHandoffPrompt(input)
          const taskId = await manager.dispatch(seeded, {
            kind: input.kind,
            agent: input.provider,
            agentMetadata: { title: input.title, group: input.group, agentRunId: input.agentRunId },
            ...(input.cwd ? { cwd: input.cwd } : {}),
          })
          manager.mergeAgentOrigin(taskId, input.agentRunId)
          await manager.mergeContinuationProvenance(taskId, {
            mode: input.sourceSessions?.length ? 'synthesis' : 'fresh',
            sources: input.sourceSessions,
            artifacts: input.artifacts,
          })
          log.event('agent-handoff-created', {
            taskId,
            agentRunId: input.agentRunId,
            kind: input.kind,
            provider: input.provider,
            carriedContext: input.context ? input.context.length : 0,
          })
          return { taskId }
        },
        async taskStatus(taskId) {
          const task = manager?.get(taskId)
          return task ? { state: String(task.state), intent: task.intent } : null
        },
      }),
      new DeliveryCapability({
        resolveAttachment: (principal, handle) => attachments.resolveForDelivery(principal, handle),
        async copyText(text) {
          let ownsClipboard = false
          try {
            try { beginOwnClipboardSequence(); ownsClipboard = true } catch { /* watcher may not be armed */ }
            clipboard.writeText(text)
            if (clipboard.readText() !== text) throw new DeliveryCapabilityError('delivery-failed')
            // The delivery is NOT claimed beyond this write. The clipboard
            // belongs to whatever touches it next, including the user's own
            // next sentence — see the note in clipboard.ts injectOutput.
          } catch (error) {
            if (error instanceof DeliveryCapabilityError) throw error
            throw new DeliveryCapabilityError('delivery-failed')
          } finally {
            if (ownsClipboard) {
              try { endOwnClipboardSequence(Date.now()) } catch { /* watcher may have stopped */ }
            }
          }
        },
        async prepareTaskDraftText(taskId, text) {
          if (!manager?.get(taskId)) throw new DeliveryCapabilityError('destination-unavailable')
          const current = taskDrafts.get(taskId).text
          const prepared = current ? `${current}\n\n${text}` : text
          taskDrafts.setText(taskId, prepared)
          if (taskDrafts.get(taskId).text !== prepared) {
            throw new DeliveryCapabilityError('delivery-failed')
          }
          notchController?.refresh()
        },
        // Opening is not copying. The Agent holds no path — it hands back an
        // opaque handle the app resolves here, so a composed path can never
        // reach the shell.
        async openAttachmentFile(metadata) {
          return bufferedAttachmentDelivery(
            metadata,
            (data) => openAgentAttachment(root, metadata, data),
          )
        },
        async stageAttachmentCopy(metadata) {
          return bufferedAttachmentDelivery(
            metadata,
            (data) => copyAgentAttachment(root, metadata, data),
          )
        },
        async stageTaskDraftAttachment(taskId, metadata) {
          if (!manager?.get(taskId)) throw new DeliveryCapabilityError('destination-unavailable')
          return bufferedAttachmentDelivery(metadata, async (data) => {
            const accepted = await attachToTaskDraft({
              taskId,
              name: metadata.name,
              mimeType: metadata.mimeType,
              data,
            })
            if (!accepted) throw new DeliveryCapabilityError('destination-unavailable')
          })
        },
      }),
    ])
    const supervisor = new AgentRunSupervisor({
      providers: runtimeProviders,
      tokenStore: tokens,
      journal,
      selectedProvider: () => resolveAgentProvider(),
      maxActiveProcesses: settings.get('unmuteAgentMaxProcesses'),
      // WITHOUT THIS THE DIAGNOSTIC IS A NO-OP. The supervisor takes its sink
      // injected because the agent package stays free of electron; leaving it
      // unset is exactly the state that let two identical `provider-crashed`
      // failures reach the user with no cause recorded anywhere.
      log: (event, data) => log.event(event, data),
    })
    pendingSupervisor = supervisor
    const controller = new UnmuteAgentController({
      supervisor,
      tokens,
      attachmentHandles: handles,
      journal,
      capabilities: registry,
      selectedProvider: () => resolveAgentProvider(),
      runtime: () => {
        const endpoint = `http://127.0.0.1:${getKnobs().mcpPort}${MCP_PATH}`
        return {
          // THE AGENT'S OWN GROUND. It used to run in the user's home
          // directory, which meant Claude filed every Agent transcript into
          // ~/.claude/projects/-Users-<user>/ — the same folder as any session
          // the user had ever started from home. Twenty-five files there, ten
          // of them Agent turns, indistinguishable by location.
          //
          // That is fatal to session oversight: asked "what have we been
          // working on?", the Agent would read its own turns back as the
          // user's work, and "consolidate those" could consolidate its own
          // answers. One file is written per turn, forever, so the pollution
          // grows with use. Its own directory gives it its own slug.
          cwd: dirname(constitutionPath),
          constitutionPath,
          environment: process.env,
          mcp: {
            endpoint,
            config: JSON.stringify({
              mcpServers: {
                unmute: {
                  type: 'http',
                  url: endpoint,
                  headers: { Authorization: 'Bearer ${UNMUTE_MCP_TOKEN}' },
                },
              },
            }),
          },
        }
      },
      onActivity: (activity) => { if (generation === unmuteAgentGeneration) broadcastUnmuteAgentActivity(activity) },
    })
    pendingController = controller
    await supervisor.initialize()
    const lifecycle = new AgentConversationLifecycle({
      journal,
      store: new AgentConversationStore({ root: join(root, 'runtime', 'conversations'), crypto }),
      controller,
      selectedProvider: () => resolveAgentProvider(),
      ceiling: () => settings.get('unmuteAgentConversationCeiling') ?? 20,
      prepareFresh: async () => {
        const canonical = await loadPersona(join(root, 'agent'))
        await fs.writeFile(constitutionPath, agentConstitution(SESSION_PREAMBLE, canonical.text), { encoding: 'utf8', mode: 0o600 })
      },
      pin: (ids) => supervisor.pinConversation(ids),
      close: (id) => supervisor.closeRun(id),
      onView: (view) => { if (generation === unmuteAgentGeneration) notchController?.restoreAgentConversation(view) },
    })
    await lifecycle.initialize()
    if (generation !== unmuteAgentGeneration) {
      lifecycle.dispose()
      index.close()
      await supervisor.dispose()
      return
    }
    unmuteAgentTokens = tokens
    unmuteAgentRecords = records
    unmuteAgentMemory = memory
    unmuteAgentRegistry = registry
    unmuteAgentSupervisor = supervisor
    unmuteAgentController = controller
    unmuteAgentLifecycle = lifecycle
    unmuteAgentIndex = index
    lifecycle.resumeQueued()
    pendingIndex = null
    pendingSupervisor = null
    pendingController = null
    const selected = settings.get('unmuteAgentProvider')
    // Availability follows what the Agent will ACTUALLY run on, not just what
    // the user picked. Reporting 'unavailable' because the chosen CLI is
    // cooling down — while the other one is installed and working — would tell
    // the user the Agent is broken at the exact moment it is about to succeed.
    const usable = providers.filter((provider) => provider.available === true)
      .map((provider) => provider.id)
    const selectedReady = usable.includes(selected) || usable.length > 0
    unmuteAgentAvailability = {
      available: selectedReady,
      ...(selectedReady ? {} : { reason: 'provider-unavailable' as const }),
      providers,
    }
    log.event('unmute-agent-initialized', {
      provider: selected, available: selectedReady, usable,
    })
  } catch (error) {
    pendingController?.dispose()
    await pendingSupervisor?.dispose().catch(() => {})
    try { pendingIndex?.close() } catch { /* failed initialization owns this projection */ }
    if (generation !== unmuteAgentGeneration) return
    let keychainAvailable = false
    try { keychainAvailable = safeStorage.isEncryptionAvailable() } catch { /* fail closed */ }
    unmuteAgentAvailability = {
      available: false,
      reason: keychainAvailable ? 'storage-unavailable' : 'keychain-unavailable',
      providers,
    }
    notchController?.agentUnavailable('Unmute Agent conversation is unavailable. Restore its encrypted recovery files or retry after storage/provider access recovers.')
    log.warn('unmute agent unavailable', {
      reason: unmuteAgentAvailability.reason,
      code: initializationFailureCode(error),
    })
  }
}

/** Attach the UI to the daemon-owned Agent. Quitting this process only drops
 * this subscription; the provider conversation, queue, MCP endpoint and
 * encrypted memory remain owned by the background runtime. */
async function initializeUnmuteAgent(): Promise<void> {
  const generation = ++unmuteAgentGeneration
  if (settings.get('unmuteAgentAvailable') !== true) {
    unmuteAgentAvailability = { available: false, reason: 'disabled', providers: await probeUnmuteAgentProviders() }
    return
  }
  const runtime = agentRuntimeRouting
  if (!runtime) throw new Error('Persistent runtime is unavailable')
  unmuteAgentAvailability = { available: false, reason: 'initializing', providers: [] }
  let key: Buffer | undefined
  try {
    const root = join(app.getPath('userData'), 'unmute-agent')
    const keyProvider = new SafeStorageKeyProvider({ root: join(root, 'memory'), protectedValueStore: safeStorage })
    key = await keyProvider.getMasterKey()
    if (generation !== unmuteAgentGeneration) return
    const client = new AgentRuntimeClient(runtime, {
      onView: view => { if (generation === unmuteAgentGeneration) notchController?.restoreAgentConversation(view) },
      onActivity: activity => { if (generation === unmuteAgentGeneration) broadcastUnmuteAgentActivity(activity) },
    })
    await client.configure({
      masterKey: key.toString('base64'),
      selectedProvider: settings.get('unmuteAgentProvider'),
      maxActiveProcesses: settings.get('unmuteAgentMaxProcesses'),
      conversationCeiling: settings.get('unmuteAgentConversationCeiling') ?? 20,
      notetaker: !!notetakerAdapters,
    })
    if (generation !== unmuteAgentGeneration) { client.dispose(); return }
    const raw = client.availability as { available?: boolean; providers?: Array<{ id: AgentProviderId; available: boolean }> }
    const providers = (raw.providers ?? []).map(provider => ({
      id: provider.id,
      label: provider.id === 'claude' ? 'Claude Code CLI' : 'Codex CLI',
      available: provider.available,
      ...(provider.available ? {} : { reason: 'not-installed' as const }),
    }))
    const available = raw.available === true
    unmuteAgentLifecycle = client
    unmuteAgentRecords = client.records
    unmuteAgentMemory = client.memory
    unmuteAgentSupervisor = client.supervisor
    unmuteAgentAvailability = { available, ...(available ? {} : { reason: 'provider-unavailable' as const }), providers }
    log.event('unmute-agent-runtime-attached', { provider: settings.get('unmuteAgentProvider'), available })
  } catch (error) {
    if (generation !== unmuteAgentGeneration) return
    let keychainAvailable = false
    try { keychainAvailable = safeStorage.isEncryptionAvailable() } catch { /* fail closed */ }
    unmuteAgentAvailability = {
      available: false,
      reason: keychainAvailable ? 'storage-unavailable' : 'keychain-unavailable',
      providers: await probeUnmuteAgentProviders(),
    }
    notchController?.agentUnavailable('Unmute Agent conversation is unavailable. Retry after storage or provider access recovers.')
    log.warn('unmute agent runtime attach failed', { error: (error as Error).message })
  } finally {
    key?.fill(0)
  }
}

/** Unsent replies are task-scoped, not owned by any one expanded surface. */
const taskDrafts = new TaskDraftStore()
let taskFollowups: TaskFollowupCoordinator | null = null

registerTaskDraftAttachmentSink(async ({ taskId, name, mimeType, data }) => {
  const taskManager = manager
  if (!taskManager?.get(taskId)) return false
  const extensionFromName = basename(name).includes('.') ? basename(name).split('.').pop() : undefined
  const extensionFromMime = mimeType.split('/').pop()
  const extension = (extensionFromName || extensionFromMime || 'bin').replace(/[^a-z0-9]/giu, '').slice(0, 16) || 'bin'
  let ownedPath: string | null = null
  try {
    ownedPath = await taskManager.attachFile(taskId, data, extension)
    if (!ownedPath) return false
    const attachmentId = randomUUID()
    taskDrafts.addAttachment(taskId, {
      id: attachmentId,
      path: ownedPath,
      mimeType,
      name,
    })
    const confirmed = taskDrafts.get(taskId).attachments.some((attachment) => attachment.id === attachmentId)
    if (!confirmed) await fs.unlink(ownedPath).catch(() => {})
    else notchController?.refresh()
    return confirmed
  } catch {
    if (ownedPath) await fs.unlink(ownedPath).catch(() => {})
    return false
  }
})

async function persistTaskDraftImage(
  id: string,
  sourcePath: string,
  mimeType: string,
  name: string,
): Promise<{ attachment: import('./task-draft').DraftAttachment; bytes: number } | null> {
  return persistTaskDraftFile(taskDrafts, manager, id, sourcePath, mimeType, name)
}

async function addDraftImageFromPath(id: string, sourcePath: string, mimeType: string, name: string, insertion?: import('./task-draft').DraftInsertion): Promise<void> {
  const draftId = taskDrafts.traceId(id)
  const startedAt = Date.now()
  emitTaskReplyInput(log, {
    taskId: id, draftId, source: 'task-composer', action: 'attachment-stage-started',
    sourcePath, mimeType, name,
  })
  await stageTaskDraftAttachment({
    drafts: taskDrafts,
    persist: async () => {
      const persisted = await persistTaskDraftImage(id, sourcePath, mimeType, name)
      const attachment = persisted?.attachment ?? null
      emitTaskReplyInput(log, {
        taskId: id, draftId, source: 'task-composer', action: attachment ? 'attachment-stage-succeeded' : 'attachment-stage-refused',
        sourcePath, ownedPath: attachment?.path ?? null, attachmentId: attachment?.id ?? null,
        mimeType, name, bytes: persisted?.bytes ?? null, elapsedMs: Date.now() - startedAt,
      })
      return attachment
    },
    cleanup: async () => {
      // AppKit creates this solely as an IPC handoff. Once copied into the
      // task-owned directory it must not accumulate in the system temp folder.
      const parent = await fs.realpath(dirname(sourcePath)).catch(() => '')
      const temp = await fs.realpath(tmpdir()).catch(() => '')
      if (parent && parent === temp && /^unmute-draft-[0-9a-f-]+\.[a-z0-9]*$/i.test(basename(sourcePath))) {
        await fs.unlink(sourcePath).catch(() => {})
      }
    },
    failed: error => {
      emitTaskReplyInput(log, {
        taskId: id, draftId, source: 'task-composer', action: 'attachment-stage-failed',
        sourcePath, mimeType, name, elapsedMs: Date.now() - startedAt, error: (error as Error).message,
      })
      log.warn('draft image staging failed', { taskId: id, error: (error as Error).message })
    },
  }, id, insertion)
}

async function deliverTaskDraftSnapshot(
  id: string,
  draft: import('./task-draft').TaskDraft,
  trace?: TaskReplyTrace,
  context: import('./question-reference').AnswerContext = null,
): Promise<boolean> {
  if (!manager) {
    if (trace) emitTaskReplyStep(log, trace, 'delivery-preflight', 'failed', { reason: 'task-manager-unavailable' })
    return false
  }
  const task = manager.get(id)
  if (!task) {
    if (trace) emitTaskReplyStep(log, trace, 'delivery-preflight', 'failed', { reason: 'task-no-longer-exists' })
    return false
  }
  // `draftInput` already carries an armed tool's contract as the leading part —
  // see the note there for why it cannot live out here. `text` is derived from
  // the SAME array the structured transports consume, so the flat string and
  // the parts cannot disagree about what was sent.
  const ordered = await draftInput(draft)
  const text = ordered.flatMap(p => p.type === 'text' ? [p.text] : []).join('')
  const images = draft.attachments.filter((attachment) => attachment.mimeType.startsWith('image/'))
  // MEASURED ON WHAT THE PERSON TYPED, never on the assembled text. An armed
  // tool prefixes a page of instruction, and measuring that would make an empty
  // draft look like a real message — you would arm a tool, press send with
  // nothing written, and the agent would receive rules and no question.
  if (!draft.text.trim() && !draft.attachments.length) {
    if (trace) emitTaskReplyStep(log, trace, 'delivery-preflight', 'refused', { reason: 'empty-draft' })
    return false
  }
  const blocked = manager.tasksAwaitingUser().some((entry) => entry.id === id)
  if (blocked && draft.attachments.length) throw new Error('Answer the pending request before sending attachments')
  const isPendingAnswer = !task.claudeSessionSettings && !task.codexSessionSettings && !draft.attachments.length && blocked
  if (isPendingAnswer && trace) {
    emitTaskReplyStep(log, trace, 'provider-selected', 'succeeded', {
      agent: task.agent ?? 'claude', model: task.model ?? null, taskState: task.state,
      transport: 'pending-question-answer-handler', hasOpenAsk: !!task.openAsk,
    })
  }
  const accepted = isPendingAnswer
    ? manager.answer(id, text)
    : await manager.deliverDraft(id, text, images.map((attachment) => attachment.path), trace, ordered, context)
  if (isPendingAnswer && trace) {
    emitTaskReplyStep(log, trace, 'transport-result', accepted ? 'succeeded' : 'failed', {
      reason: accepted ? 'answer-handler-accepted' : 'answer-handler-refused', draftRetained: !accepted,
    })
  }
  return accepted
}

const draftSubmissions = new Map<string, { promise: Promise<SubmitDraftOutcome>; contextKey: string }>()
function sendTaskDraft(id: string, source: TaskReplySource = 'task-composer', request?: DraftSubmissionRequest, context: import('./question-reference').AnswerContext = request?.answerContext ?? null): Promise<SubmitDraftOutcome> {
  if (taskFollowups && manager?.followupScope(id)) return taskFollowups.submit(id, request, context).then(outcome => {
    log.event('task-draft-outcome', { taskId: id, outcome: outcome.kind })
    if (outcome.kind === 'retained' || outcome.kind === 'uncertain') notchController?.toast(outcome.reason)
    return outcome
  })
  const pending = draftSubmissions.get(id)
  const contextKey = JSON.stringify(context ? [context.requestId, context.stepId] : null)
  if (pending && (request || pending.contextKey !== contextKey)) return Promise.resolve({ kind: 'retained', reason: 'Another message is still sending. Your capture remains in this task draft.' })
  if (pending) return pending.promise
  const submission = performSendTaskDraft(id, source, undefined, context).then((ok): SubmitDraftOutcome => ok ? { kind: 'accepted' } : { kind: 'retained', reason: 'Your draft is kept.' }).catch((error): SubmitDraftOutcome => {
    log.warn('draft submission failed', { taskId: id, error: (error as Error).message })
    notchController?.toast('Could not send this message. Your draft has been kept.')
    return { kind: 'retained', reason: 'Could not send this message. Your draft has been kept.' }
  }).finally(() => { draftSubmissions.delete(id) })
  draftSubmissions.set(id, { promise: submission, contextKey })
  return submission
}

async function performSendTaskDraft(id: string, source: TaskReplySource, onSnapshot?: (snapshot: import('./task-draft').TaskDraft) => void, context: import('./question-reference').AnswerContext = null): Promise<boolean> {
  const before = taskDrafts.get(id)
  const draftId = taskDrafts.traceId(id)
  const trace = beginTaskReplyTrace(log, {
    taskId: id, draftId, source, textChars: before.text.length, attachments: before.attachments.length,
  })
  // A fast Enter after Command-V must include the image whose disk handoff is
  // still in flight; otherwise the text is sent alone and the image appears in
  // a now-empty composer a moment later.
  emitTaskReplyStep(log, trace, 'attachment-staging-barrier', 'started')
  const discarded = taskDrafts.discardFailedAttachmentStages(id)
  if (!(await taskDrafts.whenSettled(id))) {
    emitTaskReplyStep(log, trace, 'attachment-staging-barrier', 'failed', { draftRetained: true })
    finishTaskReplyTrace(log, trace, 'failed', { reason: 'attachment-staging-failed', draftDisposition: 'retained' })
    log.warn('draft send refused while image staging remains unsettled', { taskId: id })
    notchController?.toast('The image is not attached yet. Paste it again before sending.')
    return false
  }
  if (discarded) {
    log.warn('discarded failed image staging before explicit draft retry', { taskId: id, discarded })
    notchController?.toast('The missing image was removed. Sending your reply without it.')
  }
  emitTaskReplyStep(log, trace, 'attachment-staging-barrier', 'succeeded')
  const draft = taskDrafts.snapshot(id)
  if (!draft) {
    finishTaskReplyTrace(log, trace, 'refused', { reason: 'empty-draft', draftDisposition: 'empty' })
    return false
  }
  onSnapshot?.(draft)
  emitTaskReplyStep(log, trace, 'draft-snapshot', 'succeeded', {
    textChars: draft.text.length,
    attachments: draft.attachments.map((attachment, index) => ({
      index, id: attachment.id, path: attachment.path, mimeType: attachment.mimeType, name: attachment.name,
    })),
  })
  const accepted = await deliverTaskDraftSnapshot(id, draft, trace, context)
  if (accepted) taskDrafts.acceptSnapshot(id, draft)
  const cleared = accepted && !taskDrafts.snapshot(id)
  finishTaskReplyTrace(log, trace, accepted ? 'succeeded' : 'failed', {
    reason: accepted ? 'provider-accepted' : 'provider-refused',
    draftDisposition: cleared ? 'cleared' : 'retained',
    draftChangedDuringSend: accepted && !cleared,
  })
  return accepted
}
/** The Codex CLI App Server. One per app; started lazily by the hub itself. */
let codexHub: CodexHub | null = null
/** Detached provider owner. The Electron UI only holds this reconnectable socket. */
let persistentRuntime: PersistentRuntimeClient | null = null
let claudeEditRuntime: PersistentRuntimeClient | null = null
let codexRuntimeRouting: CompatibleCodexRuntime | null = null
let agentRuntimeRouting: CompatibleAgentRuntime | null = null
let releaseAgentRuntimeHost: (() => void) | null = null
let releaseRuntimeHost: (() => void) | null = null
let persistentRuntimeReady: Promise<void> = Promise.resolve()

async function listClaudeRuntimeSessions(): Promise<Array<{ sessionId: string; alive: boolean }>> {
  const runtimes = [persistentRuntime, claudeEditRuntime].filter((r): r is PersistentRuntimeClient => !!r)
  return (await Promise.all(runtimes.map(r => r.call<Array<{ sessionId: string; alive: boolean }>>('claude.list')))).flat()
}

async function persistentSessionEndpoints(taskId: string): Promise<{ env: Record<string, string>; computerUrl: string; computerEnabled: boolean }> {
  const runtime = persistentRuntime
  if (!runtime) throw new Error('Persistent runtime is unavailable')
  await persistentRuntimeReady
  const token = randomUUID()
  const url = await runtime.call<string>('task.register', taskId, token)
  const computerEnabled = normalizePolicy(settings.get('computerUse')).enabled
  const binPath = process.env.CUA_DRIVER_PATH || (app.isPackaged
    ? join(process.resourcesPath, 'cua-driver', 'cua-driver')
    : join(app.getAppPath(), 'vendor', 'cua-driver', 'cua-driver'))
  const port = await runtime.call<number>('computer.configure', { binPath, policy: normalizePolicy(settings.get('computerUse')) })
  return {
    env: { UNMUTE_MCP_TOKEN: token, UNMUTE_MCP_URL: url },
    computerUrl: `http://127.0.0.1:${port}${CUA_MCP_PATH}`,
    computerEnabled,
  }
}
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

// THE DURABLE VOCABULARY of workspace streams. One registry, shared by BOTH
// routers — deliberately, and it is the only thing on the routing interface
// that is not scoped per backend. Task scoping exists so a router cannot name
// another backend's task; a group cannot be dispatched into, so sharing it
// costs none of that guarantee. Withholding it is what let a Claude router and
// a Codex router mint two names for one stream.
let groupRegistry: GroupRegistry | null = null

/** How long a machine-authored stream with no members survives. Generous on
 *  purpose: an empty-but-remembered entry is what lets a returning stream
 *  rejoin its old name instead of minting a new one, so pruning eagerly
 *  re-creates the bug the registry exists to fix. */
const GROUP_IDLE_EVICT_MS = 45 * 86_400_000

/**
 * The streams the router may file work under, newest-touched first.
 *
 * Examples come from the task map across EVERY backend, so belonging can be
 * judged rather than word-matched. Bounded because this rides in every routing
 * prompt: a vocabulary too long to read is one the model stops honouring.
 */
function groupVocabulary(limit = 24): GroupOption[] {
  if (!groupRegistry || !manager) return []
  const examples = new Map<string, string[]>()
  for (const t of manager.list()) {
    if (!t.groupId) continue
    const list = examples.get(t.groupId) ?? []
    if (list.length < 2) list.push((t.name || t.intent).slice(0, 40))
    examples.set(t.groupId, list)
  }
  return groupRegistry.list().slice(0, limit).map((e: GroupEntry) => ({
    label: e.label,
    examples: examples.get(e.id) ?? [],
    authored: e.source === 'user',
  }))
}

/** Forget machine-authored streams nothing has used in a long time. User-named
 *  ones never decay — their absence would be a deletion nobody asked for. */
function pruneGroups(): void {
  if (!groupRegistry || !manager) return
  groupRegistry.prune({ liveIds: manager.liveGroupIds(), idleMs: GROUP_IDLE_EVICT_MS })
}


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
    origin: t.origin,
    agentRunId: t.agentRunId,
    name: t.name ?? null,
    cwd: t.cwd,
    kind: t.kind ?? 'oneoff',
    threadContext: t.threadContext ?? null,
    shelved: t.shelved ?? false,
    note: t.note ?? null,
    spawnedBy: t.spawnedBy ?? null,
    group: t.group ?? null,
    unrouted: t.unrouted ?? false,
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
    // THE CHAT VIEW. This list is hand-copied field by field, which is exactly
    // how blocks came to be built, persisted, and then silently dropped one
    // step before the wire: every other layer had them and this one did not.
    blocks: t.blocks ?? null,
    history: t.history,
    chatUnstarted: t.chatUnstarted,
    turnOutcome: t.turnOutcome,
    chatWritable: !t.importedFromCli && !!(t.claudeSessionSettings || t.codexSessionSettings),
    sessionPermission: t.claudeSessionSettings?.permissionMode ?? t.codexSessionSettings?.sandbox,
    chatResumable: !t.importedFromCli,
    chatOwned: !t.importedFromCli,
    usage: t.usage ?? null,
    state: t.state,
    category: t.category ?? null,
    // Is this `done` a real stop, or an autonomous loop's own scheduled
    // continuation? See Task.checkpoint's doc comment.
    checkpoint: t.checkpoint ?? false,
    checkpointExpiresAt: t.checkpointExpiresAt,
    step: t.step ?? null,
    // WHAT IT IS DOING RIGHT NOW. Carried as the structured Activity rather
    // than a pre-rendered sentence so the surface can style it (and one day
    // group by it) instead of parsing prose back apart.
    // `undefined`, not null: absent means "not doing anything right now", and
    // TaskLite's optional field says exactly that. A null would have to be
    // handled as a third case by every reader.
    codexActivity: t.codexActivity,
    lastUserInputAt: t.lastUserInputAt,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    result: t.result ?? null,
    error: t.error ?? null,
    // Resume is seconds long and used to move nothing until it finished; these
    // two are what let the card show it is working, and say so when it isn't.
    resuming: t.resuming ?? false,
    resumeError: t.resumeError ?? null,
    question: t.question ?? null,
    questionAcknowledgment: t.questionAcknowledgment,
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

let chatCodexModels: CodexModel[] = []
let chatCatalogLoading = false
let chatCatalogAttemptAt = 0
let chatClaudeModels: ClaudeTaskModel[] = []
let chatClaudeCatalogLoading = false
let chatClaudeCatalogAttemptAt = 0
const composerDictation = new ComposerDictationCoordinator()

async function openChatArtifactPath(path: string): Promise<void> {
  const resolved = await fs.realpath(path)
  const stat = await fs.stat(resolved)
  if (!stat.isFile() || artifactPathAction(resolved) === 'reveal') { shell.showItemInFolder(resolved); return }
  const error = await shell.openPath(resolved)
  if (error) throw new Error(error)
}

function chatConfig(id: string): ChatConfigP | undefined {
  const task = manager?.get(id)
  if (!task) return undefined
  const provider = task.agent ?? 'claude'
  const owned = task.claudeSessionSettings ?? task.codexSessionSettings
  if (provider === 'claude' && !chatClaudeModels.length && !chatClaudeCatalogLoading && Date.now() - chatClaudeCatalogAttemptAt > 30_000) {
    chatClaudeCatalogLoading = true
    chatClaudeCatalogAttemptAt = Date.now()
    const probe = new ClaudeTaskSession({ binary: 'claude', cwd: tmpdir(), controlTimeoutMs: 15_000, onEvent: () => {} })
    void probe.start().then(() => { chatClaudeModels = probe.models })
      .catch(error => log.warn('claude-chat-model-catalog', { error: (error as Error).message }))
      .finally(() => { probe.close(); chatClaudeCatalogLoading = false; notchController?.refresh() })
  }
  if (provider === 'codex' && !chatCodexModels.length && !chatCatalogLoading && Date.now() - chatCatalogAttemptAt > 30_000) {
    chatCatalogLoading = true
    chatCatalogAttemptAt = Date.now()
    void listCodexCliModels().then(models => { chatCodexModels = models }).catch(error => log.warn('chat-model-catalog', { error: (error as Error).message }))
      .finally(() => { chatCatalogLoading = false; notchController?.refresh() })
  }
  const codexModel = chatCodexModels.find(m => m.id === owned?.model)
  const claudeModel = chatClaudeModels.find(m => m.id === (owned?.model || 'default'))
  const permission = task.claudeSessionSettings
    ? task.claudeSessionSettings.permissionMode === 'bypassPermissions' ? 'full' : task.claudeSessionSettings.permissionMode === 'plan' ? 'plan' : 'ask'
    : task.codexSessionSettings?.sandbox === 'danger-full-access' ? 'full' : task.codexSessionSettings?.sandbox === 'read-only' ? 'read' : task.codexSessionSettings?.approvalPolicy === 'never' ? 'workspace' : 'ask'
  return {
    provider, providerLabel: providerOf(provider).label, providers: [], cwd: task.cwd,
    model: owned?.model || (provider === 'claude' ? 'default' : ''), modelLabel: task.model ?? owned?.model ?? 'Provider default',
    models: provider === 'codex' ? chatCodexModels.map(m => ({ id: m.id, label: m.uiLabel, description: m.description }))
      : provider === 'claude' ? chatClaudeModels.map(({ id, label, description }) => ({ id, label, description })) : [],
    effort: owned?.effort,
    efforts: codexModel ? codexModel.efforts.map((id, i) => ({ id, label: codexModel.effortLabels[i] }))
      : claudeModel ? claudeModel.efforts.map(id => ({ id, label: ({ low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Maximum' } as Record<string, string>)[id] ?? id })) : [],
    permission, permissions: owned ? [
      ...(provider === 'codex' ? [{ id: 'workspace', label: 'Workspace access', description: 'Work without approval prompts within the configured sandbox.' }] : []),
      ...(manager?.chatFullAccessAllowed(id) ? [{ id: 'full', label: 'Full access', description: 'This Unmute session: filesystem, commands and network without provider approval prompts. macOS consent still applies.' }] : []),
      { id: 'ask', label: 'Ask for approval', description: 'Keep provider approval requests actionable in chat.' },
      ...(provider === 'claude' ? [{ id: 'plan', label: 'Plan mode', description: 'Plan without executing changes.' }] : [{ id: 'read', label: 'Read only', description: 'No workspace writes without permission.' }]),
    ] : [],
    permissionScope: owned ? `This conversation only · global defaults unchanged${task.permissionReason ? ` · ${task.permissionReason}` : ''}` : 'Managed by the original application',
    mutable: !!owned, busy: task.state === 'processing' || task.state === 'needs-user',
    ...(provider === 'codex' && !chatCodexModels.length ? { error: chatCatalogLoading ? 'Loading model choices…' : 'Model choices unavailable. Check Codex installation and sign-in.' } : {}),
    ...(provider === 'claude' && !chatClaudeModels.length ? { error: chatClaudeCatalogLoading ? 'Loading model choices…' : 'Model choices unavailable. Check Claude installation and sign-in.' } : {}),
    ...(sessionManagerRef ? { dictation: composerDictation.stateFor(id) } : {}),
  }
}

async function configureTaskChat(id: string, change: { model?: string; effort?: string; permission?: string }): Promise<void> {
  const config = chatConfig(id)
  if (!config || !manager) throw new Error('Conversation unavailable')
  if (change.model !== undefined && !config.models.some(m => m.id === change.model)) throw new Error('That model is not currently offered by this provider')
  if (change.effort !== undefined && !config.efforts.some(e => e.id === change.effort)) throw new Error('That effort level is not supported by the current model')
  if (change.model && config.provider === 'codex') {
    const model = chatCodexModels.find(m => m.id === change.model)
    change = { ...change, effort: model?.defaultEffort ?? '' }
  }
  if (change.model && config.provider === 'claude') change = { ...change, effort: '' }
  await manager.configureChat(id, change)
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
    //
    // TMUX-WRAP THIS VIEW TOO. `remote` (which protocol carries the prompt —
    // avoids the PTY-typing paste race) and `tmux` (whether the PTY survives
    // an app quit) are independent knobs on the same executor; this used to
    // pass only `remote`, so a one-off Codex task's terminal was always
    // hard-killed on quit while every other Codex/Claude task detached and
    // came back. Reattachment on relaunch falls back to a plain
    // `codex resume <threadId>` (see resume()/reattachPersistent()) — the
    // App Server itself is an ordinary child process and does not survive a
    // quit, but the thread's own rollout on disk does, which is all resume
    // needs.
    const tmux = tmuxBin ? { bin: tmuxBin, confPath: tmuxConfPath, cols: 120, rows: 40 } : undefined
    if (factoryOpts?.codexRemote) return new CodexExecutor({ remote: factoryOpts.codexRemote, tmux })
    return new CodexExecutor({ ...codexCliSpawnArgs(), tmux })
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
/** THE VOICE IS POINTED AT THE AGENT — its card is the one in front of you in
 *  the pocket, or its chat is open. Set by the notch controller, which is the
 *  only thing that knows what the pocket is showing. Deliberately NOT folded
 *  into orchestrateFocusId: that names a task, and the Agent is not one. */
let orchestrateAgentAddressed = false
/** The voice lifecycle, observed (never driven) for the wall's listening surface:
 *  listening (key held) → transcribing (key up, STT running) → routing (deciding
 *  where it lands) → idle (landed; taskId says where). PURELY ADDITIVE — a
 *  broadcast beside the existing capture calls, zero touch of the capture path. */
type CapturePhase = 'listening' | 'transcribing' | 'routing' | 'idle'
function broadcastCapturePhase(phase: CapturePhase, taskId?: string | null): void {
  // WHO ASKED FOR THIS PHASE. A `processing` pill was observed appearing with
  // no keypress, no dictation session and no sleep/wake behind it, and sitting
  // for 68 seconds — and the log could not say who sent it, because only the
  // phase was recorded. The emitter is the one fact needed to answer that, so
  // it is captured here rather than inferred later. `caller` is the frame
  // above this one; `stack` survives across the async boundaries the phase
  // travels through, which a breadcrumb variable would not.
  const caller = (new Error().stack ?? '').split('\n')[2]?.trim().replace(/^at\s+/, '') ?? 'unknown'
  log.event('capture-phase-broadcast', { phase, taskId: taskId ?? null, caller })
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
async function pushPillChips(
  taskId: string | null = null,
  // ASKED FOR, NOT READ FROM A GLOBAL. The lane is a property of the live
  // capture, which can now change lanes mid-utterance — so the caller, which
  // knows what just happened, says which one it is drawing for. Defaulting to
  // whatever the session manager reports keeps every existing call site (task
  // pickers, model changes, settings) correct without passing it explicitly.
  lane: CaptureRoute | null = liveCaptureRoute(),
): Promise<void> {
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
    // NO PICKER IN THE AGENT LANE. A backend and model chooser at invocation
    // reintroduces the one question the Agent exists to abstract away — "which
    // session am I starting?" — and neither control does anything for it: its
    // provider is a setting, chosen once. Blanked rather than skipped, because
    // `push` MERGES and an absent key would leave the previous lane's chips on
    // screen.
    if (lane === 'agent') {
      chips.agent = 'Unmute Agent'
      chips.agentOptions = []
      chips.model = undefined
      chips.modelOptions = []
      chips.modelAxes = []
      chips.modelEmpty = undefined
    }
    log.event('pill-chips', {
      lane: lane === 'agent' ? 'agent' : 'orchestrator',
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
  // THE WHOLE DECISION, EVERY PUSH. Which buttons the panel drew, and the three
  // inputs that decided them. Reading a wrong-destination report without this
  // means inferring the origin from what happened afterwards, which is how an
  // Agent utterance pasted at the cursor was first put down to the scratchpad.
  log.event('scratchpad-state', {
    armed: s.armed,
    delivering: deliveryInFlight(),
    padOrigin: pad?.origin ?? null,
    padEntries: pad?.entries.length ?? 0,
    focusedTask: orchestrateFocusId,
    offers: pad?.origin === 'agent' ? ['agent'] : ['openTask?', 'newTask', 'cursor'],
  })
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
async function deliverScratchpad(dest: 'cursor' | 'newTask' | 'openTask' | 'agent'): Promise<string | null> {
  const target: DeliveryTarget = dest === 'cursor'
    ? 'cursor'
    : dest === 'agent' ? 'agent' : dest === 'openTask' ? 'openTask' : 'newTask'
  log.event('scratchpad-deliver-requested', {
    dest, target, padOrigin: heldForSurface(snapshot())?.origin ?? null,
  })

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
  // THE AGENT IS ITS OWN EXIT. dispatchFromCapture already routes an utterance
  // to the Agent when the destination says so, so the pad hands it the same
  // way an unheld Agent capture would have — the only difference being that
  // the user chose the moment.
  const send = target === 'agent'
    ? async (text: string, attachments: readonly string[]): Promise<string | null> => {
      log.event('scratchpad-deliver-agent', { chars: text.length, attachments: attachments.length })
      return dispatchFromCapture(text, attachments, null, { destination: 'unmute-agent' })
    }
    : target === 'cursor'
    // The attachments ride along: at the cursor an image cannot be a path, so
    // the pasteboard hands the real bytes over after the text (injectOutput).
    // A task needs nothing extra — its rendering already names each file.
    ? async (text: string, attachments: readonly string[]): Promise<string | null> =>
      ((await pasteAtCursor(text, attachments)) ? 'cursor' : null)
    : async (text: string, attachments: readonly string[]): Promise<string | null> => {
      const mgr = manager
      if (target === 'openTask' && orchestrateFocusId && mgr?.get(orchestrateFocusId)) {
        const fid = orchestrateFocusId
        const trace = beginTaskReplyTrace(log, {
          taskId: fid, source: 'scratchpad-open-task', textChars: text.length, attachments: attachments.length,
        })
        const accepted = await mgr.deliverDraft(fid, text, attachments, trace)
        finishTaskReplyTrace(log, trace, accepted ? 'succeeded' : 'failed', {
          reason: accepted ? 'provider-accepted' : 'provider-refused',
          draftDisposition: accepted ? 'scratchpad-delivery-committed' : 'scratchpad-retained',
        })
        if (accepted) return fid
        // It couldn't take it (terminal/gone) — route it as a new task rather
        // than dropping work the user already committed.
        log.warn('focused task refused the pad — routing it as a new task', { taskId: fid })
      }
      return dispatchFromCapture(text, attachments)
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
/**
 * The task a right-Option capture would land in IF IT WERE SUBMITTED NOW.
 *
 * Deliberately a live read rather than anything stored. `applyVoiceTarget()`
 * in the notch controller already maintains exactly this rule — a task
 * expanded wins, otherwise the pocket's current slot when it is open, and
 * nothing at all when it is closed, which means the router and a new task —
 * and re-answering it here is how two copies of one question drift apart.
 */
function liveVoiceTarget(): string | null {
  return orchestrateFocusId && manager?.get(orchestrateFocusId) ? orchestrateFocusId : null
}

/** The lane the live capture is on, or null when nothing is recording. */
/**
 * The voice target moved while something may be recording.
 *
 * LATE BINDING HAS TO BE VISIBLE OR IT IS JUST UNPREDICTABLE. The target is
 * now read at submit, so moving the pocket mid-utterance changes where the
 * words land — and a pill still naming the task you have moved off is worse
 * than the snapshot this replaced. Only the task lane cares: a dictation goes
 * to the cursor and an Agent capture goes to the Agent, whatever is on screen.
 */
function voiceTargetMoved(): void {
  if (liveCaptureRoute() !== 'task') return
  // One call, not two: broadcastCapturePhase re-pushes the chips itself on
  // 'listening', reading the live lane. Pushing here as well was the same
  // payload twice — dropped by push()'s own equality check, but the kind of
  // duplication that later grows a second opinion.
  broadcastCapturePhase('listening', liveVoiceTarget())
}

function liveCaptureRoute(): CaptureRoute | null {
  return sessionManagerRef?.captureRoute ?? null
}

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
function onInsertRecorded(
  i: { kind: InsertKind; content: string; atMs: number },
  detector: 'clipboard' | 'screenshot',
): void {
  if (!recordInsert({ ...i, detector }, Date.now())) return
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
    onInsert: (i) => onInsertRecorded(i, 'clipboard'),
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
    onInsert: (i) => onInsertRecorded(i, 'screenshot'),
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
  // DELIVER INTO OUR OWN COMPOSER DIRECTLY, NOT BY POSTING A KEY AT IT.
  //
  // A dictation carrying an image put the text in the composer and lost the
  // picture: the text ⌘V arrived, and the image's ⌘V — posted 492ms later —
  // never reached this app at all, while the sequencer reported success because
  // it only knows it pressed a key. When the focused text box is one of ours,
  // stage the images as draft attachments instead.
  registerComposerImageSink((paths) => {
    const taskId = notchController?.focusedComposerTaskId()
    if (!taskId || !manager?.get(taskId)) return false
    log.event('composer-image-sink', { taskId, images: paths.length })
    for (const path of paths) {
      void addDraftImageFromPath(taskId, path, 'image/png', basename(path))
        .catch(error => notchController?.toast(`Could not attach image: ${error instanceof Error ? error.message : String(error)}`))
    }
    return true
  })
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
  // The native surface and the capture renderer are two views of the same
  // lifecycle. Hiding only Swift left React parked on `processing`, so any
  // later device/settings render could publish that stale phase and reopen the
  // pill. Reset React at the exact authoritative hide point; paused sessions
  // deliberately return above and remain resumable.
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('pill:event', { type: 'pillSyncHidden' })
  }
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
  // NOTHING TO SAY WHEN THERE IS NOTHING. This used to speak "All clear.
  // Nothing running." — removed at the user's request. The early return stays:
  // without it an empty `parts` falls through and speakLine is handed an empty
  // string, which is a malformed utterance rather than silence.
  if (!needs.length && !working.length) return
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

/** Effects that necessarily belong to the foreground app. The daemon keeps
 * provider work and credentials; these requests wait for a connected UI and
 * are accepted exactly once. */
async function invokeRuntimeHost(method: string, args: any[]): Promise<unknown> {
  if (method === 'task.create') return mcpCreateTask(String(args[0]), args[1])
  if (method === 'task.status') return mcpTaskStatus(String(args[0]), String(args[1]))
  if (method === 'task.setStatus') {
    const [taskId, input] = args as [string, { state: any; summary?: string; detail?: string; artifacts?: any[]; question?: string }]
    if (!manager) throw new Error('Unmute Remote is not initialized')
    await manager.setReportedStatus(taskId, {
      schema_version: 1, state: input.state, updated_at: new Date().toISOString(),
      ...(input.summary || input.detail || input.artifacts ? { result: { summary: input.summary ?? '', ...(input.detail ? { detail: input.detail } : {}), ...(input.artifacts ? { artifacts: input.artifacts } : {}) } } : {}),
      ...(input.question ? { question: { text: input.question, kind: 'free_text' as const } } : {}),
    })
    return true
  }
  if (method === 'history.recent') {
    const since = Date.now() - (Number(args[0]) || 0)
    return captureHistory.list().filter(entry => entry.finalizedAt >= since).sort((a, b) => b.finalizedAt - a.finalizedAt).map(entry => ({
      id: entry.id, lane: entry.kind, at: entry.finalizedAt, text: entry.text,
      attachments: [...entry.attachments], ...(entry.destination ? { destination: entry.destination } : {}),
    }))
  }
  if (method === 'history.copy') {
    const entry = captureHistory.list().find(candidate => candidate.id === String(args[0]))
    if (!entry) return false
    const payload = clipboardPayload(entry)
    return copyHistoryToClipboard(payload.text, payload.attachments)
  }
  if (method === 'sessions.resume') return agentContinuations.resume(args[0])
  if (method === 'sessions.fork') return agentContinuations.fork(args[0])
  if (method === 'sessions.workspaces') return (groupRegistry?.list() ?? []).map(({ id, label }) => ({ id, label }))
  if (method === 'sessions.createWorkspace') return createAgentWorkspace(args[0])
  if (method === 'sessions.open') return openAgentSessions((args[0] as { limit?: number } | undefined)?.limit)
  if (method === 'sessions.close') return closeAgentSession((args[0] as { taskId: string }).taskId)
  if (method === 'handoff.createTask') {
    if (!manager) throw new Error('Unmute Remote is not initialized')
    const input = args[0] as Parameters<typeof buildHandoffPrompt>[0] & { title: string; group: string; sourceSessions?: Array<{ sessionId: string; provider: 'claude' | 'codex' }>; cwd?: string; kind: 'oneoff' | 'session'; provider: AgentKind; agentRunId: string }
    await validateContinuationSources(input.sourceSessions, locateSession, input.context)
    const seeded = buildHandoffPrompt(input)
    const taskId = await manager.dispatch(seeded, { kind: input.kind, agent: input.provider, agentMetadata: { title: input.title, group: input.group, agentRunId: input.agentRunId }, ...(input.cwd ? { cwd: input.cwd } : {}) })
    manager.mergeAgentOrigin(taskId, input.agentRunId)
    await manager.mergeContinuationProvenance(taskId, {
      mode: input.sourceSessions?.length ? 'synthesis' : 'fresh',
      sources: input.sourceSessions,
      artifacts: input.artifacts,
    })
    return { taskId }
  }
  if (method === 'handoff.taskStatus') {
    const task = manager?.get(String(args[0]))
    return task ? { state: String(task.state), intent: task.intent } : null
  }
  if (method.startsWith('notetaker.')) {
    if (!notetakerAdapters) throw new Error('Meeting notetaker is unavailable')
    if (method === 'notetaker.list') return notetakerAdapters.list(args[0])
    if (method === 'notetaker.search') return notetakerAdapters.search(String(args[0]), args[1])
    if (method === 'notetaker.read') return notetakerAdapters.read(String(args[0]))
    if (method === 'notetaker.open') return notetakerAdapters.open(String(args[0]))
  }
  if (method === 'delivery.copyText') {
    const value = String(args[0])
    let ownsClipboard = false
    try {
      try { beginOwnClipboardSequence(); ownsClipboard = true } catch { /* watcher may not be armed */ }
      clipboard.writeText(value)
      if (clipboard.readText() !== value) throw new DeliveryCapabilityError('delivery-failed')
      return true
    } finally { if (ownsClipboard) try { endOwnClipboardSequence(Date.now()) } catch { /* best effort */ } }
  }
  if (method === 'delivery.prepareTaskDraftText') {
    const [taskId, value] = [String(args[0]), String(args[1])]
    if (!manager?.get(taskId)) throw new DeliveryCapabilityError('destination-unavailable')
    const current = taskDrafts.get(taskId).text
    taskDrafts.setText(taskId, current ? `${current}\n\n${value}` : value)
    notchController?.refresh()
    return true
  }
  if (method === 'delivery.openAttachmentFile' || method === 'delivery.stageAttachmentCopy' || method === 'delivery.stageTaskDraftAttachment') {
    const metadata = args[0] as DeliveryAttachmentMetadata
    const data = Buffer.from(String(args[1]), 'base64')
    if (data.byteLength !== metadata.size) throw new DeliveryCapabilityError('delivery-failed')
    const root = join(app.getPath('userData'), 'unmute-agent')
    if (method === 'delivery.openAttachmentFile') return openAgentAttachment(root, metadata, data)
    if (method === 'delivery.stageAttachmentCopy') return copyAgentAttachment(root, metadata, data)
    const taskId = String(args[2])
    if (!manager?.get(taskId)) throw new DeliveryCapabilityError('destination-unavailable')
    const accepted = await attachToTaskDraft({ taskId, name: metadata.name, mimeType: metadata.mimeType, data })
    if (!accepted) throw new DeliveryCapabilityError('destination-unavailable')
    return true
  }
  throw new Error(`Unknown runtime host request: ${method}`)
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

export interface CaptureDispatchOptions {
  /** Explicit capture destination. Omitted is the existing task route. */
  destination?: Extract<CaptureDestination, 'task' | 'unmute-agent'>
  /** Present only when the user explicitly addressed an earlier Agent run. */
  priorAgentRunId?: string
  /**
   * The lane the capture was on WHEN IT WAS SUBMITTED, carried from the
   * session that produced it.
   *
   * THIS REPLACES A MODULE-LEVEL VARIABLE, and the replacement is the point.
   * The address used to live in a `captureAddress` global here, advanced by
   * key-down and spent by dispatch — so a capture that never dispatched, being
   * cancelled or superseded, left it set. Observed 2026-08-18: an Agent
   * capture was cancelled a second after it began and from then on every
   * Remote press was silently readdressed to the Agent; the user's task never
   * ran, and an Agent reply appeared twelve seconds after they released the
   * Remote key, indistinguishable from one they had asked for. The fold that
   * replaced it narrowed the window but kept the shape — and kept a hole, in
   * that the addressed-task branch below returns before ever spending it.
   *
   * A field on the session cannot have that class of bug: the session is
   * nulled on every teardown path there is, and the route rides along with the
   * utterance it belongs to. Nothing outlives the capture that set it.
  */
  route?: CaptureRoute
  /** Immutable composer address stamped at capture creation and spent once. */
  composerDictation?: ComposerDictationDelivery
}

export async function dispatchFromCapture(
  rawTranscript: string,
  attachments: readonly string[] = [],
  targetTaskId?: string | null,
  options: CaptureDispatchOptions = {},
): Promise<string | null> {
  // Composer dictation is not a routed task. It edits an unsent draft and must
  // not touch captureBusy, focus, the generic phase broadcasts, or voice beats
  // if its detached queue happens to drain during a newer recording.
  const composerDelivery = options.composerDictation
  return dispatchCaptureWithLifecycle({
    composer: composerDelivery ? async () => {
      if (!manager) {
        log.error('composer dictation before initRemote')
        return null
      }
      const claim = composerDictation.claim(composerDelivery)
      if (claim.kind === 'drop') {
        log.event('composer-dictation-dropped', { token: composerDelivery.token, reason: 'unknown-or-cancelled-token' })
        return null
      }
      if (!manager.get(claim.taskId)) {
        log.event('composer-dictation-dropped', { token: composerDelivery.token, taskId: claim.taskId, reason: 'task-no-longer-exists' })
        return null
      }
      return applyComposerDictation(claim, (rawTranscript || '').trim(), attachments, {
        drafts: taskDrafts,
        taskExists: id => !!manager?.get(id),
        stageImage: (id, image, insertion) => addDraftImageFromPath(id, image, 'image/png', basename(image), insertion),
      })
    } : undefined,
    routed: async () => {
      // The lane this utterance was on when the user submitted it. Handed in by
      // the session that recorded it (see CaptureDispatchOptions.route), never
      // read from anything that outlives the capture.
      if (options.route === 'agent') options = { ...options, destination: 'unmute-agent' }
      // WHY THIS WENT WHERE IT WENT, recorded rather than left to inference. The
      // failure that made this necessary looked exactly like a normal Agent turn
      // in the logs, twelve seconds after a Remote key release.
      log.event('capture-destination', {
        route: options.route ?? null,
        explicit: options.destination ?? null,
        targetTaskId: targetTaskId ?? null,
      })
      return dispatchFromCaptureInner(rawTranscript, attachments, targetTaskId, options)
    },
    initialResult: null,
    // Observe the routing phase for the wall's listening surface. The helper's
    // composer branch returns before this callback, so detached insertion can
    // never release a newer capture's busy/focus state.
    onRouting: () => {
      broadcastCapturePhase('routing')
      pendingBeat = null
    },
    onIdle: landed => broadcastCapturePhase('idle', landed),
    onAcknowledge: landed => {
      // Speak AFTER the phase returns to idle (captureBusy released) so the beat
      // can't be dropped by the talking-over-the-user guard.
      const beat = pendingBeat !== null ? pendingBeat : landed ? 'On it.' : 'That didn\u2019t land.'
      if (beat) speakLine(beat)
      pendingBeat = null
    },
  })
}

async function dispatchFromCaptureInner(
  rawTranscript: string,
  attachments: readonly string[] = [],
  targetTaskId?: string | null,
  options: CaptureDispatchOptions = {},
): Promise<string | null> {
  if (!manager) {
    log.error('dispatchFromCapture before initRemote')
    return null
  }
  const raw = (rawTranscript || '').trim()

  // 0. ORCHESTRATE FOCUS short-circuit (§6.2). If the wall is focused on a session,
  //    the utterance goes THERE — deterministically, bypassing the router. This is
  //    PURELY ADDITIVE: with nothing focused (orchestrateFocusId === null) the block
  //    is skipped and routing below is exactly as before. We reuse the SAME paths
  //    the router uses (answer a blocked task / followUp to continue) — no new send.
  // AN EXPLICIT ADDRESS OUTRANKS A VISIBLE ONE.
  //
  // The deterministic path below delivers to the task in focus, and it used to
  // run first — so a capture the user had explicitly addressed to the Agent by
  // pressing its own key was handed to whatever task happened to be open, and
  // returned before the destination was ever resolved. Observed in the field:
  // the Agent key captured correctly, then dispatched as an ordinary task reply.
  //
  // Pressing the Agent key is a statement about WHO you are talking to. A task
  // being on screen is not.
  // THREE WAYS TO BE TALKING TO THE AGENT, and they are one statement made
  // three ways: its own key, the scratchpad's Agent button, or its card being
  // the one in front of you in the pocket. The third is new and is the same
  // rule every task already follows — you address what you can see.
  const addressedToAgent = options.route === 'agent'
    || options.destination === 'unmute-agent'
    || orchestrateAgentAddressed
  const addressedTaskId = addressedToAgent ? null : (targetTaskId ?? orchestrateFocusId)
  if (addressedTaskId && manager.list().some((t) => t.id === addressedTaskId)) {
    const fid = addressedTaskId
    // WHAT THEY SAID IS WHAT IS DELIVERED.
    //
    // This used to run cleanIntent() first, so an addressed capture reached the
    // session as an LLM's rewrite of the utterance rather than the utterance.
    // The cleanup was added when this path carried a raw STT string and nothing
    // else; the cost is that the session never sees the person's own words —
    // and neither does the transcript, so neither does the turn index, which
    // promises their words verbatim. A transcription slip is visible and
    // correctable; a paraphrase is neither.
    const text = raw
    // Right-Option capture and the visible composer are one draft. Captured
    // images stay as attachments rather than being rendered as filesystem paths.
    let trace: TaskReplyTrace | null = null
    const captureOutcome = await deliverAddressedCapture({
      taskId: fid,
      text,
      attachments,
      drafts: taskDrafts,
      persistAttachment: async (taskId, sourcePath) => {
        const persisted = await persistTaskDraftImage(taskId, sourcePath, 'image/png', basename(sourcePath))
        if (persisted) {
          emitTaskReplyInput(log, {
            taskId, draftId: taskDrafts.traceId(taskId), source: 'right-option', action: 'attachment-stage-succeeded',
            sourcePath, ownedPath: persisted.attachment.path, attachmentId: persisted.attachment.id,
            mimeType: persisted.attachment.mimeType, name: persisted.attachment.name, bytes: persisted.bytes,
          })
        }
        return persisted?.attachment ?? null
      },
      onAttachmentStageFailed: (taskId, sourcePath, error) => {
        emitTaskReplyInput(log, {
          taskId, draftId: taskDrafts.traceId(taskId), source: 'right-option', action: 'attachment-stage-failed',
          sourcePath, mimeType: 'image/png', name: basename(sourcePath), error: error.message,
        })
        log.warn('addressed capture image staging failed', { taskId, sourcePath, error: error.message })
        notchController?.toast('That screenshot could not be attached. Your reply is still in the task.')
      },
      onStaged: (_taskId, snapshot) => {
        const draftId = taskDrafts.traceId(fid)
        emitTaskReplyInput(log, {
          taskId: fid, draftId, source: 'right-option', action: 'capture-staged',
          rawTextChars: raw.length, cleanedTextChars: text.length,
          attachments: snapshot.attachments.map((attachment, index) => ({
            index, id: attachment.id, path: attachment.path, mimeType: attachment.mimeType, name: attachment.name,
          })),
        })
        trace = beginTaskReplyTrace(log, {
          taskId: fid, draftId, source: 'right-option',
          textChars: snapshot.text.length, attachments: snapshot.attachments.length,
        })
        notchController?.refresh()
      },
      submitDraft: (taskId, request) => sendTaskDraft(taskId, 'right-option', request),
    })
    const accepted = captureOutcome.kind === 'accepted'
    const queued = captureOutcome.kind === 'queued'
    if (trace) {
      finishTaskReplyTrace(log, trace, accepted || queued ? 'succeeded' : 'failed', {
        reason: queued ? 'queued-locally' : accepted ? 'provider-accepted' : captureOutcome.kind,
        draftDisposition: queued ? 'transferred-to-queue' : accepted ? 'handled-by-submission-owner' : 'retained',
      })
    }
    notchController?.refresh()
    log.event('capture-addressed-delivery', { taskId: fid, attachments: attachments.length, accepted, outcome: captureOutcome.kind })
    if (queued) notchController?.toast('Follow-up queued — sends after this turn.')
    pendingBeat = accepted ? '' : queued ? 'Follow-up queued for after this turn.' : 'That didn\u2019t land. Your reply is still in the task.'
    return accepted || queued ? fid : null
  }

  if (!raw) {
    log.warn('empty transcript without an addressed task — not dispatching', { attachments: attachments.length })
    return null
  }

  // 0b. EXPLICIT UNMUTE AGENT destination. This is intentionally below the
  // task-address short-circuit: a capture addressed at key-down remains a task
  // follow-up even if its text happens to begin with "Unmute". Ordinary Remote
  // speech still falls through to the unchanged router below, and ordinary
  // dictation/Instruct never enter dispatchFromCapture at all.
  const agentAddress = parseExplicitAgentAddress(raw)
  const destination = resolveCaptureDestination({
    captureMode: 'remote',
    recordingMode: 'dictation',
    addressedTaskId,
    explicitDestination: options.destination,
    transcript: raw,
  })
  if (destination === 'unmute-agent') {
    const transcript = agentAddress?.transcript ?? raw
    if (!unmuteAgentLifecycle || !unmuteAgentAvailability.available) {
      log.warn('explicit agent capture refused — Agent unavailable', {
        reason: unmuteAgentAvailability.reason ?? 'not-initialized',
        attachments: attachments.length,
      })
      pendingBeat = 'Unmute Agent is unavailable.'
      return null
    }

    // Captured images stay in the established buffer as host-owned paths.
    // The main-process controller converts each source into an opaque,
    // interaction-scoped handle before a provider can see it.
    const input: AgentInteractionInput = {
      transcript,
      attachments: attachments.map((path) => ({
        path,
        name: basename(path),
        // Declared from the file, not assumed. Every capture used to be
        // labelled image/png regardless of what it was, so a PDF or a video
        // the user pointed at arrived describing itself as a screenshot — and
        // the mime type is what a delivery later opens it by.
        mimeType: captureMimeType(path),
      })),
      ...(options.priorAgentRunId ? { priorRunId: options.priorAgentRunId } : {}),
    }
    // `route === 'agent'` means the user pressed (or switched to) the Agent's
    // own key. An explicit `destination` covers the scratchpad's Agent button,
    // which is the same statement made with a different gesture. Either way a
    // task's focused composer must not capture this turn.
    const result = await submitUnmuteAgent(
      input,
      options.route === 'agent' || options.destination === 'unmute-agent',
    )
    log.event('agent-capture-complete', {
      interactionId: result.interactionId,
      agentRunId: result.agentRunId,
      source: result.source,
      outcome: result.outcome,
      presentation: result.presentation,
      attachments: attachments.length,
      // Traces this run to its provider transcript (for Claude, the file in
      // ~/.claude/projects). Without it the only way back to what the Agent
      // actually did is to hunt for session files by modification time.
      providerSessionId: result.providerSessionId ?? null,
    })
    // THE AGENT SPEAKS INTO ITS OWN CHAT.
    //
    // It used to speak in a caption: one line, a few seconds, gone. That shape
    // is what forced the 200-character cap, the instruction never to write a
    // long answer, and the standing question of where a long answer should go
    // instead — the clipboard, a file, a task. All of it was a workaround for
    // having nowhere to put words.
    //
    // The Agent is an element of the pocket now. Its card carries the opening
    // line and the card opens into the whole exchange, so the answer is simply
    // said, at the length it takes, and read where it was said.
    const spoken = result.outcome === 'completed'
      ? (result.text?.trim() || 'Done.')
      : (result.error?.message || 'That did not land.')
    // The common durable lifecycle publishes the complete Agent conversation.
    pendingBeat = spoken
    return result.agentRunId || null
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
      // EITHER Codex surface picks the Codex router — see router-select.ts.
      // This read `=== 'codex-desktop'`, from when the desktop app was the only
      // one, so a user on the Codex CLI silently kept the Claude router.
      const useCodex = prefersCodexRouter(avail.preferred, { claude: !!router, codex: !!codexRouter })
      const activeRouter = useCodex ? codexRouter! : router!
      // NO DEFAULTING. `?? 'claude'` used to sit here, and it is what turned a
      // missing backend into a positive claim: an agent-less task was asserted
      // to be Claude's and handed to the Claude router. Absence of information
      // is not evidence of Claude — a task whose backend we cannot name belongs
      // to NEITHER router, so it is simply not offered to either.
      // Same vendor, either surface. This compared against 'codex-desktop'
      // alone, so even once the router was selected correctly it would have
      // been shown NO Codex CLI tasks — it could never have continued one.
      const mine = (t: RoutableTask) => routerScopeMatches(useCodex, t.agent as ProviderId | undefined)
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
        // NOT filtered by `mine`: the vocabulary is shared across backends on
        // purpose. See groupVocabulary().
        groupVocabulary(),
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
            manager.answer(tid, withSkill(raw))
            // An attachment is content, not an answer to a pending question —
            // deliverDraft refuses that combination on purpose. Say so rather
            // than dropping the image without a word.
            if (attachments.length) log.warn('attachments not delivered: task is waiting on a question', { taskId: tid, count: attachments.length })
            // Assign-once grouping: the router may group the task it acted on,
            // never regroup one that already has a group (freeze).
            if (decision.group && !target?.group) manager.setGroup(tid, decision.group)
            // Silence is what made the old attachment loss so confusing: the
            // gesture looked identical whether the image arrived or not.
            pendingBeat = attachments.length
              ? `Passed to ${targetName}. The attachment stayed behind — it\u2019s waiting on a question.`
              : `Passed to ${targetName}.`
            return tid
          }
          const targetBusy = target?.state === 'processing' // mid-turn — the follow-up will queue
          if (await manager.followUpWith(tid, withSkill(raw), attachments)) {
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
            if (await manager.followUpWith(tid, withSkill(raw), attachments)) {
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
      // The payload is the person's exact utterance. decision.intent is the
      // router's one-line REWRITE of it: useful as a label, never as the thing
      // the session is asked to act on. It is applied with setIntent after
      // dispatch, so the card stays readable without the words being replaced.
      let intentText = withSkill(raw)
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
        // Carried so the card can distinguish "the router never answered" from
        // "naming and grouping did not work" - they look identical otherwise.
        unrouted: decision.unrouted,
        ...(chosenAgent === 'codex-desktop' ? { project: decision.codexProject ?? null } : {}),
        attachments,
      })
      // The card's label. dispatch() stored the verbatim utterance as the
      // task's intent because that is what it delivered; the router's cleaned
      // line is the better one-line summary for a list, so it is applied here
      // rather than being sent to the session.
      if (decision.intent) manager.setIntent(newId, decision.intent)
      // The router minted the display name in the same turn — instant, no extra
      // call. (The completeFn-based nameIntent below stays as the non-router path.)
      if (decision.name) manager.setName(newId, decision.name)
      // GROUP EVERY NEW TASK THAT HAS A SUBJECT, one-offs included.
      //
      // This used to read `decision.kind === 'session'`, inherited from spec
      // 2026-07-16 (which put one-off grouping before graduation out of scope on
      // the grounds that the wall groups streams, not errands). Two live
      // dispatches on 2026-08-27 settled it the other way: the router answered
      // group:"unmute marketing" for a one-off about Unmute's Twitter posts —
      // the RIGHT stream, joined rather than invented — and this line binned it,
      // so the card landed in Ungrouped with no trace of the decision anywhere.
      //
      // `kind` is about how long a task lives. It was never about whether the
      // work is about something. An errand on a project belongs to that
      // project's stream exactly as a session does, and the wall is far more
      // legible for it. The router's own contract says the same thing now — the
      // two have to agree or the model simply omits the group and this line
      // never sees one.
      if (decision.group) manager.setGroup(newId, decision.group)
      // THE LABEL, ARRIVING AFTER THE TASK IS ALREADY RUNNING.
      //
      // With deferNaming the router answers the gating question first and is
      // asked for name+group afterwards, so the user's wait ends here rather
      // than after the two heaviest rule blocks in the prompt. Deliberately not
      // awaited: the whole point is that the card is live before this lands.
      //
      // A provisional name goes up immediately so the card is never blank in
      // the gap \u2014 derived locally from the utterance, no model involved, and
      // replaced the moment the real one arrives.
      if (decision.enrich) {
        const taskManager = manager
        if (!decision.name) manager.setName(newId, provisionalName(decision.intent || raw))
        void decision.enrich.then((late) => {
          if (late.name && taskManager.get(newId)?.origin !== 'unmute-agent') taskManager.setName(newId, late.name)
          // Assign-once still holds: only fill a group the task does not have.
          if (late.group && !taskManager.get(newId)?.group) taskManager.setGroup(newId, late.group)
          log.event('late-label-applied', { taskId: newId, name: late.name ?? null, group: late.group ?? null })
        }).catch(() => {})
      }
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
      // This used to `return null` whenever anything was attached, so a router
      // hiccup threw away the whole utterance AND the image rather than
      // falling back. dispatch() takes attachments; the fallback can too.
      return manager.dispatch(raw, { mode: injectionDisabled() ? 'raw' : undefined, attachments })
    }
  }

  // 3. Nothing to route among → straight to a new task, carrying exactly what
  //    was said. This ran cleanIntent() first and dispatched the rewrite; the
  //    last path that still replaced the person's words with a model's.
  if (!raw) { log.warn('empty transcript — not dispatching', {}); return null }
  return manager.dispatch(raw, { mode: injectionDisabled() ? 'raw' : undefined, attachments })
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
  taskDrafts.connectFile(join(REMOTE_BASE_DIR, 'drafts.json'), (error) => {
    log.warn('draft persistence failed', { error: (error as Error).message })
  })
  notetakerAdapters = deps.notetaker ?? null
  sessionManagerRef = deps.sessionManager
  runHeadlessSummary = deps.runHeadless ?? null
  captureHistory.cleanup()
  if (manager) return manager

  // Session teardown happens before the detached remote queue necessarily
  // drains. A queued token stays claimable; every other ending abandons the
  // active token so empty/error/cancel paths cannot wedge or leak dictation.
  const previousSessionEnded = deps.sessionManager.onSessionEnded
  deps.sessionManager.onSessionEnded = (identity) => {
    try { previousSessionEnded?.(identity) }
    finally {
      const abandoned = identity?.composerDictationToken
        ? composerDictation.abandon(identity.composerDictationToken)
        : composerDictation.abandonActive() !== null
      if (abandoned) notchController?.refresh()
    }
  }
  const previousComposerQueued = deps.sessionManager.onComposerDictationQueued
  deps.sessionManager.onComposerDictationQueued = (token) => {
    try { previousComposerQueued?.(token) }
    finally { if (composerDictation.markQueued(token)) notchController?.refresh() }
  }

  // THE AGENT'S GATE, ANSWERED BEFORE THE LANE LATCHES. Pushed down the same
  // way paywall-glue pushes the Orchestrator's entitlement into
  // remoteTriggerGate: this file owns the setting, the keyboard only asks. The
  // check used to live here, on the agent-start we RECEIVE — by which point
  // the keyboard had already set its lock, with no capture behind it and no
  // session whose ending could clear it.
  deps.keyboardManager.setUnmuteAgentAvailable?.(settings.get('unmuteAgentAvailable') === true)

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

  const runtimeRoot = join(app.getPath('userData'), 'persistent-runtime')
  persistentRuntime = new PersistentRuntimeClient(runtimeRoot, join(__dirname, 'unmute-runtime.js'))
  // Checkpoint forks need the updated CLI adapter; existing live sessions keep their owner.
  claudeEditRuntime = new PersistentRuntimeClient(join(runtimeRoot, 'claude-edits-v1'), join(__dirname, 'unmute-runtime.js'))
  claudeEditRuntime.on('reconnected', () => {
    void (async () => {
      const sessions = await claudeEditRuntime!.call<Array<{ sessionId: string; alive: boolean }>>('claude.list')
      const live = new Set(sessions.filter(session => session.alive).map(session => session.sessionId))
      await Promise.all(manager?.list().filter(task => task.claudeResumeSessionAt && live.has(task.sessionId))
        .map(task => manager!.resume(task.id, { touchActivity: false })) ?? [])
      notchController?.refresh()
    })().catch(error => log.warn('Claude edit runtime recovery failed', { error: (error as Error).message }))
  })
  releaseRuntimeHost = registerRuntimeHost(persistentRuntime, invokeRuntimeHost)
  const agentWorker = new PersistentRuntimeClient(join(app.getPath('userData'), 'persistent-runtime-agent-metadata-v1'), join(__dirname, 'unmute-runtime.js'))
  releaseAgentRuntimeHost = registerRuntimeHost(agentWorker, invokeRuntimeHost)
  agentRuntimeRouting = new CompatibleAgentRuntime(persistentRuntime, agentWorker)
  agentRuntimeRouting.on('reconnected', () => {
    if (unmuteAgentLifecycle instanceof AgentRuntimeClient) {
      const client = unmuteAgentLifecycle
      const runtime = agentRuntimeRouting!
      void agentWorker.call('hello').then(() => recoverAgentRuntime(runtime, async () => {
        if (settings.get('unmuteAgentAvailable') !== true || unmuteAgentLifecycle !== client) return false as const
        const root = join(app.getPath('userData'), 'unmute-agent')
        const keyProvider = new SafeStorageKeyProvider({ root: join(root, 'memory'), protectedValueStore: safeStorage })
        const key = await keyProvider.getMasterKey()
        try {
          if (settings.get('unmuteAgentAvailable') !== true || unmuteAgentLifecycle !== client) return false as const
          await client.configure({ masterKey: key.toString('base64'), selectedProvider: settings.get('unmuteAgentProvider'),
            maxActiveProcesses: settings.get('unmuteAgentMaxProcesses'), conversationCeiling: settings.get('unmuteAgentConversationCeiling') ?? 20,
            notetaker: !!notetakerAdapters })
        } finally { key.fill(0) }
      }, () => client.reconnect())).catch(error => log.warn('Agent runtime recovery failed', { error: (error as Error).message }))
    }
  })
  agentWorker.on('computer.activity', event => broadcastAxActivity(event as Parameters<typeof broadcastAxActivity>[0]))
  persistentRuntime.on('computer.activity', event => broadcastAxActivity(event as Parameters<typeof broadcastAxActivity>[0]))
  persistentRuntimeReady = persistentRuntime.call('hello').then(info => {
    log.event('persistent-runtime-connected', info as Record<string, unknown>)
  }).catch(error => {
    log.warn('persistent runtime unavailable', { error: (error as Error).message })
    throw error
  })
  persistentRuntime.on('reconnected', () => {
    const runtime = persistentRuntime
    if (!runtime) return
    void (async () => {
      await runtime.call('hello')
      await (codexHub as PersistentCodexHub | null)?.reconnect()
      if (unmuteAgentLifecycle instanceof AgentRuntimeClient) await unmuteAgentLifecycle.reconnect()
      const sessions = await listClaudeRuntimeSessions()
      const live = new Set(sessions.filter(session => session.alive).map(session => session.sessionId))
      await Promise.all(manager?.list().filter(task => task.claudeSessionSettings && live.has(task.sessionId))
        .map(task => manager!.resume(task.id, { touchActivity: false })) ?? [])
      notchController?.refresh()
      log.event('persistent-runtime-recovered', { liveClaude: live.size })
    })().catch(error => log.warn('persistent runtime recovery failed', { error: (error as Error).message }))
  })

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
  // Preserve older live owners. New forks/edits use v4, which supports
  // operation-scoped fork receipts, rollback, and forced recovery.
  codexRuntimeRouting = new CompatibleCodexRuntime(
    new CompatibleCodexRuntime(
      new CompatibleCodexRuntime(persistentRuntime!,
        new PersistentRuntimeClient(join(runtimeRoot, 'continuity-v2'), join(__dirname, 'unmute-runtime.js'))),
      new PersistentRuntimeClient(join(runtimeRoot, 'continuity-v3'), join(__dirname, 'unmute-runtime.js'))),
    new PersistentRuntimeClient(join(runtimeRoot, 'continuity-v4'), join(__dirname, 'unmute-runtime.js')))
  codexHub = new PersistentCodexHub(codexRuntimeRouting, {
    approvalCap: taskId => ({ fullAccessAllowed: manager?.chatFullAccessAllowed(taskId) === true, roots: settings.get('sandboxRoots') ?? [] }),
    loadPlans: async (taskId, threadId) => {
      const task = manager?.get(taskId)
      if (!task) throw new Error('Conversation storage is unavailable')
      try {
        const saved = JSON.parse(await fs.readFile(join(task.home, 'chat-plans.json'), 'utf8'))
        if (saved.threadId !== threadId || !Array.isArray(saved.plans)) throw new Error('Saved plans do not match this conversation')
        return saved.plans
      } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
    },
    savePlans: async (taskId, threadId, plans) => {
      const task = manager?.get(taskId)
      if (!task) throw new Error('Conversation storage is unavailable')
      const path = join(task.home, 'chat-plans.json')
      await writeFileAtomic(path, JSON.stringify({ threadId, plans }))
      await fs.chmod(path, 0o600)
    },
    loadInputMetadata: async (taskId, threadId) => {
      const task = manager?.get(taskId)
      if (!task) throw new Error('Conversation storage is unavailable')
      try {
        const saved = JSON.parse(await fs.readFile(join(task.home, 'chat-inputs.json'), 'utf8'))
        if (saved.threadId !== threadId || !Array.isArray(saved.records)) throw new Error('Conversation attachment history does not match this session')
        return saved.records as CodexInputMetadata[]
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw error
      }
    },
    saveInputMetadata: async (taskId, threadId, record) => {
      const task = manager?.get(taskId)
      if (!task) throw new Error('Conversation storage is unavailable')
      const path = join(task.home, 'chat-inputs.json')
      let records: CodexInputMetadata[] = []
      try {
        const saved = JSON.parse(await fs.readFile(path, 'utf8'))
        if (saved.threadId !== threadId || !Array.isArray(saved.records)) throw new Error('Conversation attachment history does not match this session')
        records = saved.records
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      const index = records.findIndex(item => item.id === record.id)
      if (index >= 0) records[index] = record
      else records.push(record)
      await writeFileAtomic(path, JSON.stringify({ threadId, records }))
      await fs.chmod(path, 0o600)
    },
    threadConfig: async taskId => {
      const { env, computerEnabled, computerUrl } = await persistentSessionEndpoints(taskId)
      return { developer_instructions: SESSION_PREAMBLE + (computerEnabled ? '\n\n' + STEER_BODY : ''), mcp_servers: {
        unmute: { url: env.UNMUTE_MCP_URL, http_headers: { Authorization: `Bearer ${env.UNMUTE_MCP_TOKEN}` } },
        [AX_MCP_NAME]: { url: computerUrl, enabled: computerEnabled },
      } }
    },
    resolveBin: () => resolveCodexCli((bin) => new Promise<string | null>((res) => {
      execFile('/usr/bin/which', [bin], { env: process.env }, (err, stdout) => res(err ? null : String(stdout).trim() || null))
    })),
    onPatch: (p) => { try { manager?.applyHubPatch(p) } catch (e) { log.warn('hub patch failed', { error: (e as Error).message }) } },
  })

  // Load the stream vocabulary BEFORE the task manager, so rehydrate can
  // resolve every persisted label into an entry on the first pass — which is
  // also where pre-registry duplicates ('unmute' / 'Unmute') collapse.
  groupRegistry = new GroupRegistry({ path: join(REMOTE_BASE_DIR, 'groups.json') })
  void groupRegistry.load().catch(() => { /* metadata, never a gate */ })
  manager = new TaskManager({
    executorFactory,
    claudeChoice: context => ({
      ...(doerModel() ? { model: doerModel() } : {}),
      permissionMode: settings.get('permissionMode') === 'auto-approve' && !(settings.get('sandboxRoots') ?? []).length ? 'bypassPermissions' : 'manual',
      addDirs: settings.get('sandboxRoots') ?? [],
      chrome: settings.get('browserEnabled') !== false && (!context || !!context.managedProjectId || context.cwd === context.home || context.cwd.startsWith(context.home + '/')),
    }),
    claudeSessionOptions: async task => {
      const promptPath = join(task.home, 'task-instructions.md')
      const mcpPath = join(task.home, 'task-mcp.json')
      const { env, computerEnabled, computerUrl } = await persistentSessionEndpoints(task.id)
      await writeFileAtomic(promptPath, SESSION_PREAMBLE + (computerEnabled ? '\n\n' + STEER_BODY : ''))
      await writeFileAtomic(mcpPath, JSON.stringify({ mcpServers: {
        unmute: { type: 'http', url: env.UNMUTE_MCP_URL, headers: { Authorization: `Bearer ${env.UNMUTE_MCP_TOKEN}` } },
        ...(computerEnabled ? { [AX_MCP_NAME]: { type: 'http', url: computerUrl } } : {}),
      } }))
      await fs.chmod(mcpPath, 0o600)
      return {
        binary: 'claude', cwd: task.cwd, sessionId: task.sessionId,
        appendSystemPromptFile: promptPath, mcpConfigFile: mcpPath,
        ...(hookSettingsFile ? { settingsFile: hookSettingsFile } : {}),
        chrome: task.claudeSessionSettings?.chrome ?? (settings.get('browserEnabled') !== false && (!!task.managedProjectId || task.cwd === task.home || task.cwd.startsWith(task.home + '/'))),
        env,
      }
    },
    claudeTaskFactory: (options, task) => new PersistentClaudeTaskSession(task.claudeResumeSessionAt ? claudeEditRuntime! : persistentRuntime!, options),
    groupRegistry,
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
    listLiveRuntimeIds: async () => {
      if (!tmuxBin) return new Set<string>()
      return await new Promise<ReadonlySet<string>>((resolve) => {
        execFile(tmuxBin!, tmuxListSessionNamesArgs(), { timeout: 2_000 }, (error, stdout) => {
          // tmux exits 1 when its private server has no sessions. That is a
          // healthy empty registry, not a reason to probe every saved ticket.
          if (error) return resolve(new Set<string>())
          resolve(taskIdsFromTmuxSessionList(String(stdout)))
        })
      })
    },
  })
  // File watchers are best-effort across macOS sleep and renderer suspension.
  // One immediate, serialized reconciliation on wake/activation repairs any
  // coalesced event without restoring high-frequency background polling.
  powerMonitor.on('resume', () => manager?.reconcileNow())
  app.on('activate', () => manager?.reconcileNow())
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

  const mcpGeneration = ++mcpServerGeneration
  const startLocalMcp = () => startMcpServer({
    resolveCaller: (token) => {
      if (!token) return null
      const tid = mcpTokens.get(token)
      if (tid && !tid.startsWith('pending-')) return { kind: 'task' as const, taskId: tid }
      return null
    },
    capabilityContext: () => ({}),
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
      for (const listener of agentHookListeners) {
        try { listener(event) } catch { /* one observer cannot block the others */ }
      }
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
  }, getKnobs().mcpPort, unmuteAgentRegistry)
  void initializeUnmuteAgent()
  void startLocalMcp().then((server) => {
      if (mcpGeneration !== mcpServerGeneration) { server.close(); return }
      mcpServer = server
    })
    .catch((e) => log.warn('mcp server not started', { error: (e as Error).message }))
  // Owned sessions receive their MCP configuration at launch. Never mutate
  // the user's global Claude configuration; pre-existing registrations remain.

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
  // Owned structured sessions receive computer tools and steering in their
  // per-session configuration. Startup does not rewrite provider global files.
  // Explicit Computer Use toggle actions retain their existing registration behavior.

  // Shared by optional native notch and always-registered renderer IPC.
  const appendSkillToOwnedTask = (taskId: string, name: string): boolean => {
    const task = manager?.get(taskId)
    if (!task || task.importedFromCli || (!task.claudeSessionSettings && !task.codexSessionSettings)) return false
    taskDrafts.appendText(taskId, `/${name} `)
    notchController?.refresh()
    return true
  }

  // ONE WRITER FOR BOTH SIZE CONTROLS. Settings invokes it through IPC; the
  // live notch invokes it through its helper event. Whichever the user changes
  // last becomes the value every later expansion receives at bootstrap.
  const persistSurfaceFill = (fill: number): number => {
    const value = Number.isFinite(fill)
      ? Math.round(Math.min(Math.max(fill, 0.4), 0.95) * 100) / 100
      : 0.8
    settings.set('surfaceFill', value)
    notchClient?.send({ type: 'surfaceFill', fill: value })
    log.event('surface-fill-set', { fill: value })
    return value
  }

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
          // Sent at bootstrap, not only on change: otherwise a black surface
          // paints Space Gray for the first frames of every launch.
          surfaceTone: settings.get('surfaceTone') || 'glass',
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
        ...(deps.backgroundAudio ? {
          holdBackgroundAudio: () => deps.backgroundAudio!.hold(),
          releaseBackgroundAudio: () => deps.backgroundAudio!.release(),
        } : {}),
        canEditLatestMessage: id => mgr.canEditLatestMessage(id) && !taskFollowups?.view(id) && !taskFollowups?.isSubmitting(id),
        editLatestMessage: async (id, expected, text) => {
          if (taskFollowups?.view(id) || taskFollowups?.isSubmitting(id)) return false
          try { return await mgr.editLatestMessage(id, expected, text) }
          catch (error) {
            const draft = taskDrafts.get(id)
            if (!draft.text && !draft.attachments.length) taskDrafts.setText(id, text)
            throw error
          }
        },
        getDraft: (id) => taskDrafts.get(id),
        getFollowup: id => taskFollowups?.view(id),
        getComposerMode: id => manager?.followupScope(id) ? taskFollowups?.composerMode(id) : undefined,
        draftSubmitting: id => taskFollowups?.isSubmitting(id) ?? false,
        cancelTaskFollowup: (id, queueId) => taskFollowups?.cancel(id, queueId) ?? false,
        restoreTaskFollowup: (id, queueId, confirmed) => taskFollowups?.restore(id, queueId, confirmed) ?? false,
        queueSavedTaskFollowup: (id, queueId) => taskFollowups?.queueSaved(id, queueId) ?? false,
        answerAsync: async (id, text, reference) => {
          const task = manager?.get(id)
          if (!task || !manager || task.sending) return false
          if (!task.claudeSessionSettings && !task.codexSessionSettings) return manager.answer(id, text)
          task.sending = true
          notchController?.refresh()
          try { return reference ? await manager.answerQuestion(id, text, reference) : false }
          finally { task.sending = false; notchController?.refresh() }
        },
        getChatConfig: chatConfig,
        configureChat: configureTaskChat,
        createChat: async options => {
          if (!manager) throw new Error('Task service is not ready')
          return manager.createChat(options)
        },
        previewChat: async options => {
          if (!manager) throw new Error('Task service is not ready')
          return manager.previewChat(options)
        },
        cancelDraftDictation: id => {
          const delivery = composerDictation.activeDelivery
          if (delivery?.taskId !== id) return
          sessionManagerRef?.cancelSession?.()
          // cancelSession normally triggers onSessionEnded synchronously. Keep
          // this as a fail-safe for a partial/older engine implementation.
          composerDictation.abandon(delivery.token)
          notchController?.refresh()
        },
        toggleDraftDictation: (id, insertion) => {
          if (!sessionManagerRef) return
          const active = composerDictation.activeDelivery
          if (active?.taskId === id && composerDictation.stateFor(id) === 'recording') {
            composerDictation.markTranscribing(active.token)
            void sessionManagerRef.stopRemoteCapture().catch(error => {
              notchController?.toast(`Dictation failed: ${(error as Error).message}`)
            }).finally(() => {
              // Every normal engine path signals queued or ended. If an older
              // implementation throws without either callback, still release.
              composerDictation.abandon(active.token)
              notchController?.refresh()
            })
          } else {
            if (sessionManagerRef.captureRoute || active) { notchController?.toast('Finish the current recording first'); return }
            const started = startComposerDictation(composerDictation, id, insertion, delivery => {
              sessionManagerRef!.startRemoteCapture(id, false, delivery)
            })
            if (!started.started || !sessionManagerRef.captureRoute) {
              composerDictation.abandon(started.delivery.token)
              if (!started.started) sessionManagerRef.cancelSession?.()
              const detail = started.error ? `: ${started.error.message}` : ''
              notchController?.toast(`Recording could not start${detail}. Check microphone access and finish any active capture.`)
            }
          }
          notchController?.refresh()
        },
        setDraftText: (id, text, clientRevision) => {
          const before = taskDrafts.get(id)
          const draftId = taskDrafts.traceId(id)
          taskDrafts.setText(id, text, clientRevision)
          emitTaskReplyInput(log, {
            taskId: id, draftId, source: 'task-composer', action: 'text-edited',
            beforeChars: before.text.length, afterChars: text.length,
            deltaChars: text.length - before.text.length, attachments: before.attachments.length,
          })
        },
        setDraftTool: (id, tool) => {
          taskDrafts.setTool(id, tool)
          log.event('canvas-tool-armed', { taskId: id, tool })
        },
        addDraftImage: (id, path, mimeType, name, insertion) => addDraftImageFromPath(id, path, mimeType, name, insertion),
        reserveDraftAttachment: (id, operationId, name, insertion) => taskDrafts.reserveAttachment(id, operationId, name, insertion),
        failDraftAttachment: (id, operationId, error) => taskDrafts.failAttachment(id, operationId, error),
        restoreDraftAttachment: async (id, attachmentId) => {
          const item = taskDrafts.get(id).attachments.find(a => a.id === attachmentId)
          if (!item || item.mimeType !== 'text/x-unmute-paste') throw new Error('This pasted text is no longer in the draft')
          const text = await fs.readFile(item.path, 'utf8')
          taskDrafts.restoreAttachment(id, attachmentId, text)
        },
        undoDraftAttachment: async (id, attachmentId) => {
          await taskDrafts.whenSettled(id)
          taskDrafts.undoAttachment(id, attachmentId)
        },
        redoDraftAttachment: (id, attachmentId) => taskDrafts.redoAttachment(id, attachmentId),
        removeDraftAttachment: async (id, attachmentId) => {
          const draftId = taskDrafts.traceId(id)
          const attachment = taskDrafts.removeAttachment(id, attachmentId)
          emitTaskReplyInput(log, {
            taskId: id, draftId, source: 'task-composer', action: attachment ? 'attachment-removed' : 'attachment-remove-missed',
            attachmentId, path: attachment?.path ?? null, remainingAttachments: taskDrafts.get(id).attachments.length,
          })
          // Retain task-owned files for in-flight snapshots and Undo. Task
          // cleanup deletes them; removal never touches the original file.
        },
        sendDraft: (id, context) => sendTaskDraft(id, 'task-composer', undefined, context ?? null),
        kill: (id) => mgr.kill(id),
        remove: (id) => mgr.remove(id),
        killAll: () => mgr.killAll(),
        resume: (id) => mgr.resume(id),
        rerun: (intent) => { void dispatchFromCapture(intent) },
        setKind: (id, kind) => mgr.setKind(id, kind, { pinned: kind === 'session' }),
        setName: (id, name) => { if (name.trim()) mgr.setName(id, name.trim().slice(0, 48)) },
        setShelved: (id, on) => mgr.setShelved(id, on),
        setNote: (id, note) => mgr.setNote(id, note),
        focus: (id) => {
          orchestrateFocusId = id
          log.event('orchestrate-focus-set', { taskId: orchestrateFocusId, via: 'notch' })
          voiceTargetMoved()
          // Same reason as the IPC setter: the pad's destinations are computed
          // per push, so a focus change has to announce itself or the
          // "Add to <task>" button never appears on an already-open pad.
          try { broadcastScratchpad() } catch { /* nothing showing */ }
        },
        agentSend: (text, submission) => new Promise<void>((resolve, reject) => {
          void submitUnmuteAgent({ transcript: text, submissionId: submission.submissionId }, true, { revision: submission.revision, acknowledged: resolve }).catch(reject)
        }),
        agentDraftChanged: (text, revision) => unmuteAgentLifecycle?.setDraft(text, revision) ?? Promise.reject(new Error('Agent unavailable')),
        agentRetry: async () => { await unmuteAgentLifecycle?.retry() },
        // ONE CONVERSATION AT A TIME: starting a new one ends the old one, it
        // does not sit beside it. Refused rather than forced while a turn is
        // running, so nothing is discarded out from under a live provider.
        agentNewConversation: async () => {
          const outcome = await unmuteAgentLifecycle?.discard()
          log.event('agent-new-conversation', { discarded: outcome?.discarded ?? false, ...(outcome?.reason ? { reason: outcome.reason } : {}) })
        },
        addressAgent: (on) => {
          if (orchestrateAgentAddressed === on) return
          orchestrateAgentAddressed = on
          log.event('agent-addressed', { on })
          voiceTargetMoved()
        },
        opened: (id) => mgr.opened(id),
        setSurfaceFill: persistSurfaceFill,
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
          //
          // But the basename is EVIDENCE, NOT AN AUTHORITY. It used to be
          // written straight through, which made this the second independent
          // namer of the same field: imports produced "unmute-cloud" from the
          // directory while the router produced "unmute" from what the user
          // actually says, and nothing ever reconciled them. That is a
          // mechanical source of near-duplicate groups with no judgement in it
          // at all. Resolving through the registry folds the two spellings onto
          // one stream, and only mints an entry when the project genuinely
          // names a new one.
          const group = row.project ? groupRegistry?.resolve(row.project)?.label ?? row.project : undefined
          const id = await mgr.adoptCliSession({
            sessionId: row.sessionId, title: row.title, cwd: row.cwd,
            lastActivityAt: row.lastActivityAt, group,
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
        tapSkill: appendSkillToOwnedTask,
        openProject: (path, name) => {
          if (!manager) return
          const provider = settings.get('agent') === 'codex' ? 'codex' : 'claude'
          void manager.createChat({ provider, cwd: path }).then(id => notchController?.openTask(id))
            .catch(error => notchController?.toast(`Could not open ${name}: ${(error as Error).message}`))
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
              if (type === 'path') await openChatArtifactPath(value)
              else await shell.openExternal(safeArtifactURL(value), { activate: false })
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
        loadBlocks: async (taskId, retry) => {
          await manager?.loadBlocksFor(taskId, retry)
          manager?.reconcileNow(taskId)
        },
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
      if (unmuteAgentLifecycle) notchController.restoreAgentConversation(unmuteAgentLifecycle.view())
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
        // THE TICK IS THE TRIGGER KEY, NOT A WIDGET GESTURE.
        //
        // This was `toWidget('stop')`, which reached the RENDERER only: it
        // stopped the renderer's own recorder and drew "Processing", while
        // main — which owns the session and runs transcribe-and-paste — was
        // never told the capture had ended. The pill then sat spinning until
        // the user pressed the trigger key, and THAT is what actually
        // delivered the text. Reported as "pressing the tick just stays in
        // processing and then I have to press the function key again".
        //
        // Routing it through the keyboard manager makes the tick literally the
        // same act as releasing the key, on every lane — fn, Caps Lock,
        // right-Option and the Agent's double-tap — because that is the one
        // place that knows how each lane ends. Main then emits
        // `recording:stop` and the renderer follows exactly as it always has.
        //
        // The fallback is deliberate and must NOT pre-empt: if the keyboard
        // says nothing is live, the old path still runs, so a state this
        // change did not anticipate degrades to today's behaviour instead of
        // to a dead button.
        stop: () => {
          if (deps.keyboardManager.submitActiveCapture?.() === true) return
          toWidget('stop')
        },
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
  void manager.rehydrate().then(async () => {
    await persistentRuntimeReady
    await (codexHub as PersistentCodexHub).reconnect()
    const claudeSessions = await listClaudeRuntimeSessions()
    const liveClaude = new Set(claudeSessions.filter(session => session.alive).map(session => session.sessionId))
    await Promise.all(manager!.list().filter(task => task.claudeSessionSettings && liveClaude.has(task.sessionId))
      .map(task => manager!.resume(task.id, { touchActivity: false })))
    await manager?.reattachPersistent()
  }).catch(error => {
    log.warn('persistent task recovery failed', { error: (error as Error).message })
  }).finally(() => {
    // Auto-purge dead tasks (>24h): in-memory aged-out tasks AND orphan on-disk
    // dirs from past runs. Kills any leftover session + erases OUR scratch dir +
    // row. Runs once now then hourly. Never touches ~/.claude.
    manager?.startMaintenance()
    // The user's own turns, verbatim, kept current by tailing both transcript
    // roots. Pure file work — no model call and no tokens — so it runs whether
    // or not anyone ever speaks to the Agent.
    turnIndex.start().catch(error => log.warn('turn index failed to start', { error: (error as Error).message }))
    // Forget machine-authored streams nothing has used in weeks. Runs AFTER
    // rehydrate, so a task that still holds an entry is counted as a member
    // before anything is dropped. User-named streams never decay.
    pruneGroups()
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
  // TRANSPORT, chosen by knob (see ConfigKnobs.routerHeadless).
  //
  // headless: a pipe and a schema. One JSON line in, one schema-checked MCP
  //   tool call out — no PTY, so no paste that lands one Enter short, no
  //   /clear that never submits, no trust dialog, no decision file.
  // repl:     the original PTY classifier, kept whole and tested, so this is
  //   a switch rather than a deletion.
  //
  // Everything either side of the transport — buildRoutingPrompt, parse,
  // validate, the failsafe, dispatch — is shared and untouched.
  const headlessRouting = getKnobs().routerHeadless === 1
  log.event('router-transport', { transport: headlessRouting ? 'headless' : 'repl' })
  router = new Router({
    executorFactory: routerExecutorFactory,
    engine: headlessRouting ? new HeadlessRouterEngine({ model: getModels().router }) : undefined,
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
  // The Codex lane takes the same switch. It needs no MCP tool: `codex exec
  // --output-schema` binds the schema to the model's response_format directly,
  // which is structured output at the strongest point in the chain.
  codexRouter = new Router({
    executorFactory: routerExecutorFactory,   // unused: `engine` takes the path
    engine: headlessRouting ? new CodexExecRouterEngine() : new CodexRouterEngine(),
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

  // ── The live capture changed lanes: redraw the pill's chips ──
  //
  // A FULL PUSH, NEVER A DELTA. PillController.push MERGES, so an absent key
  // leaves the previous lane's value on screen — which is exactly why
  // pushPillChips blanks the model column explicitly in the Agent lane rather
  // than omitting it. Switching lanes mid-capture is the case that makes that
  // matter most: without this the pill would still be offering "Codex CLI" to
  // someone who is now talking to the Agent.
  deps.sessionManager.onCaptureRouteChanged = (route: CaptureRoute) => {
    void pushPillChips(route === 'task' ? liveVoiceTarget() : null, route)
    pillController?.push({ kind: route === 'cursor' ? 'dictation' : 'remote' })
  }

  // ── Wire the Remote trigger key → capture (PRD §2.4.4 / §5) ──
  // keyboard.ts emits 'remote-start'/'remote-stop' for the non-dictation key;
  // route them to the sessionManager's Remote capture (which reuses the STT
  // pipeline then calls dispatchFromCapture).
  deps.keyboardManager.on('keyboard', (e) => {
    if (e.type === 'pocket-chord') {
      // ONE GESTURE, TWO RUNGS — the controller decides which, because it is
      // the only thing that knows whether the pocket is already open. Deciding
      // here would mean a second copy of that state, and the two would drift.
      log.event('pocket-chord', { lane: 'pocket' })
      notchController?.pocketChord()
      return
    }
    if (e.type === 'remote-start') {
      // WHICH KEY, AND WHAT IT DECIDED. Every diagnosis on 18 August meant
      // reconstructing ownership from timestamps; the address is now stated
      // here, at key-down, where it is decided.
      log.event('remote-key', { phase: 'start', lane: 'orchestrator', address: 'task' })
      void router?.warm() // ensure the classifier is ready before the utterance lands (re-warms if it died)
      pauseOverlayEscape() // capture owns Escape (cancel) while recording
      // NO SNAPSHOT. This used to freeze the visible address at key-down —
      // "a capture is an intent addressed at key-down, not at delivery time".
      // That is the position this change reverses, deliberately: which task
      // you mean is the one you are looking at when you finish speaking, not
      // the one that happened to be on screen when you started. People move
      // the pocket mid-sentence precisely BECAUSE they are choosing.
      //
      // Passing null lets dispatchFromCaptureInner fall through to the live
      // `orchestrateFocusId`, which applyVoiceTarget() already keeps exactly
      // in step with the surface — pocket open aims at the slot under the
      // index, pocket closed means the router and a new task. No new state,
      // and no second copy of a rule that already exists.
      deps.sessionManager.startRemoteCapture(null)
      broadcastCapturePhase('listening', liveVoiceTarget()) // ADDITIVE observer — the capture itself is untouched
    } else if (e.type === 'agent-start') {
      log.event('agent-key', { phase: 'start', lane: 'agent', address: 'agent' })
      if (settings.get('unmuteAgentAvailable') !== true) {
        // BELT AS WELL AS BRACES. The keyboard now refuses this press before
        // it latches the lane (setUnmuteAgentAvailable, pushed below), so this
        // branch should be unreachable. If availability changed in the gap, the
        // lane is latched with no capture behind it and therefore no session
        // whose ending could clear it — which is precisely the failure
        // onCaptureEnded was written for, and never wired to until now.
        log.event('agent-key', { phase: 'ignored', reason: 'not-available' })
        deps.keyboardManager.onCaptureEnded?.()
        return
      }
      void router?.warm()
      pauseOverlayEscape()
      // Addressed at the AGENT, not at whatever task happens to be in focus —
      // that is the whole point of giving it its own key. The session carries
      // that address itself now; there is no module-level copy to set.
      deps.sessionManager.startRemoteCapture(null, true)
      broadcastCapturePhase('listening', null)
    } else if (e.type === 'capture-route') {
      // THE LIVE CAPTURE CHANGED LANES. Nothing here starts, stops or touches
      // the recording — the recorder is not even reachable from this file. The
      // session moves its own route (and the pad's address with it); this
      // side only redraws what the two surfaces are saying.
      const route = (e as { route?: CaptureRoute }).route
      if (!route) return
      const moved = deps.sessionManager.setCaptureRoute?.(route) ?? false
      log.event('capture-route', { route, applied: moved })
      if (!moved) return
      if (route !== 'cursor') void router?.warm()
      // Escape belongs to the capture for every lane; pauseOverlayEscape is a
      // plain release, not a counter, so saying it again is free and saying it
      // once too often cannot leak.
      pauseOverlayEscape()
      // The task lane aims at whatever is live; the other two aim at nothing.
      broadcastCapturePhase('listening', route === 'task' ? liveVoiceTarget() : null)
    } else if (e.type === 'key-state') {
      // THE SEQUENCE, IN FULL. Every key and the state it left behind, so a
      // transition bug can be read straight off the log instead of inferred.
      const k = e as unknown as Record<string, unknown>
      log.event('key-state', {
        trigger: k.trigger,
        dictation: k.dictationActive, instruction: k.instructionActive,
        remote: k.remoteActive, agent: k.agentActive,
        agentHeld: k.agentHeld, agentSpoiled: k.agentSpoiled, agentPendingTap: k.agentPendingTap,
      })
    } else if (e.type === 'agent-ignored' || e.type === 'remote-ignored') {
      log.event('key-ignored', {
        lane: e.type === 'agent-ignored' ? 'agent' : 'orchestrator',
        reason: (e as { reason?: string }).reason ?? 'unknown',
      })
    } else if (e.type === 'agent-stop') {
      // ARMED MEANS PAUSE, NOT SUBMIT. holdIfArmed decides that downstream; this
      // records what the key MEANT at the moment it was pressed, so a capture
      // that vanished can be told apart from one that was parked on purpose.
      let padArmed = false
      try { padArmed = snapshot().armed } catch { padArmed = false }
      log.event('agent-key', { phase: 'stop', armed: padArmed, meaning: padArmed ? 'pause' : 'submit' })
      resumeOverlayEscape()
      void deps.sessionManager.stopRemoteCapture()
      broadcastCapturePhase('transcribing')
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
  taskFollowups = new TaskFollowupCoordinator({
    store: taskDrafts,
    onOutcome: event => log.event('task-followup-outcome', event),
    assetsRoot: id => join(manager!.get(id)!.home, 'attachments'),
    scope: id => manager?.followupScope(id),
    gate: id => manager?.followupGate(id) ?? { kind: 'unavailable', reason: 'Task manager unavailable' },
    deliver: (id, record, idle) => manager!.deliverQueuedDraft(id, record, idle),
    immediate: async (id, onSnapshot, context) => {
      const accepted = await performSendTaskDraft(id, 'task-composer', onSnapshot, context ?? null)
      return accepted ? { kind: 'accepted' } : { kind: 'retained', reason: manager?.get(id)?.deliveryError ?? 'Your draft is kept.' }
    },
    changed: id => { const task = manager?.get(id); if (task) manager?.emit('updated', task) },
  })
  manager.on('followup-turn-ended', e => taskFollowups?.turnEnded(e))
  manager.on('followup-ready', ({ taskId }) => taskFollowups?.readinessChanged(taskId))
  manager.on('followup-disarm', ({ taskId }) => taskFollowups?.disarm(taskId, 'Session stopped or connection changed — follow-up saved'))
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
    taskDrafts.forget(t.id)
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('remote:task-removed', { id: t.id })
    }
    reconcileDock(activeTaskCount())
    curator.notifyCheckpoint(t.id) // kill/delete → whatever ran is a closed chapter, sweep-eligible
  })

  // Closing Unmute detaches persistent tmux clients so their work keeps moving;
  // one-offs stay bounded and headless Agent turns are still reaped below.
  app.on('before-quit', () => {
    taskDrafts.flush()
    try { manager?.shutdown() } catch (e) { log.warn('before-quit shutdown failed', { error: (e as Error).message }) }
    // The Agent and owned structured task providers intentionally outlive the
    // UI. Explicit Stop still interrupts them through their structured control
    // channels; app quit only disconnects this view.
    disposeUnmuteAgent()
    disposeMcpServer()
    try { cuaManager?.dispose(); cuaServer?.close(); void cuaArming.disposeAll() } catch (e) { log.warn('cua shutdown failed', { error: (e as Error).message }) }
    try { pillController?.hide() } catch { /* best-effort */ }
    try { notchController?.dispose(); notchClient?.dispose() } catch (e) { log.warn('notch shutdown failed', { error: (e as Error).message }) }
    try { router?.dispose() } catch { /* best-effort */ }
    // This only removes the UI projection/listeners; the daemon keeps the
    // app-server and its active threads alive.
    try { codexHub?.stop() } catch (e) { log.warn('codex hub shutdown failed', { error: (e as Error).message }) }
    releaseRuntimeHost?.(); releaseRuntimeHost = null
    releaseAgentRuntimeHost?.(); releaseAgentRuntimeHost = null
    agentRuntimeRouting?.disconnect(); agentRuntimeRouting = null
    codexRuntimeRouting?.disconnect(); codexRuntimeRouting = null
    claudeEditRuntime?.disconnect(); claudeEditRuntime = null
    persistentRuntime?.disconnect(); persistentRuntime = null
  })
  // Prove the App Server transport in THIS build, once, at launch. Backgrounded
  // and delayed so it never sits in the startup path — which is next to the
  // capture path, and must not wait on someone else's binary.
  // Daemon-owned app servers are not reaped here: they are the continuity
  // mechanism for work that is still active while the UI is closed.
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
    voiceTargetMoved()
    // THE PAD'S DESTINATIONS ARE LIVE, NOT A SNAPSHOT. scratchpadDestinations()
    // runs only inside a pad push, so without this the "Add to <task>" button
    // reflected whichever task was focused the last time the PAD changed —
    // expanding a task while a pad was already on screen added nothing.
    try { broadcastScratchpad() } catch { /* nothing showing */ }
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
  // THE SWITCH THAT WAS MISSING. `unmuteAgentAvailable` was read in five places
  // and written in none: initialised false, with no IPC, no setter and no
  // control anywhere in the UI. The feature was complete behind a gate that
  // nothing could open, which is why the Agent never appeared in the capture
  // picker no matter what was configured.
  ipcMain.handle('remote:get-unmute-agent-available', async () =>
    settings.get('unmuteAgentAvailable') === true)
  ipcMain.handle('remote:set-unmute-agent-available', async (_e, on: boolean) => {
    settings.set('unmuteAgentAvailable', on === true)
    // Keep the keyboard's copy in step, so its refusal happens before the lane
    // latches rather than after — see initRemote's own push of this.
    deps.keyboardManager.setUnmuteAgentAvailable?.(on === true)
    if (on === true) {
      disposeUnmuteAgent()
      await initializeUnmuteAgent()
    } else {
      await agentRuntimeRouting?.call('agent.disable').catch(() => {})
      disposeUnmuteAgent()
    }
    log.event('unmute-agent-availability', { enabled: on === true })
    return settings.get('unmuteAgentAvailable') === true
  })

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
    manager.setKind(id, kind, { pinned: kind === 'session' })
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
    return appendSkillToOwnedTask(taskId, name)
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
  // ── The stream vocabulary (Orchestrator → Settings → Groups) ─────────────
  //
  // Add and edit only. Delete is deliberately absent for now: a task filed under
  // an entry renders that entry's label, so removing one would leave those cards
  // pointing at a stream that no longer exists — a bigger decision than this
  // screen should be making. Machine-authored streams already decay on their own.
  ipcMain.handle('remote:groups-list', async () => (
    (groupRegistry?.list() ?? []).map((e) => ({
      id: e.id,
      label: e.label,
      authored: e.source === 'user',
      tasks: (manager?.list() ?? []).filter((t) => t.groupId === e.id).length,
    }))
  ))
  // Naming a stream makes it the user's: it stops being a router guess, and it
  // is from then on exempt from decay.
  ipcMain.handle('remote:groups-create', async (_e, label: string) => {
    if (!groupRegistry) return { ok: false, reason: 'unavailable' }
    const existing = groupRegistry.find(label)
    const out = groupRegistry.define(label)
    if (!out.ok) return { ok: false, reason: out.reason ?? 'blank' }
    // `define` ADOPTS a matching entry rather than duplicating it, so say so —
    // silently doing nothing visible reads as a bug.
    return { ok: true, adopted: !!existing, label: out.entry?.label }
  })
  ipcMain.handle('remote:groups-rename', async (_e, id: string, label: string) => {
    if (!groupRegistry) return { ok: false, reason: 'unavailable' }
    const entry = groupRegistry.get(id)
    if (!entry) return { ok: false, reason: 'unknown' }
    const moved = manager?.renameGroup(entry.label, label) ?? 0
    const after = groupRegistry.get(id)
    if (after?.label === entry.label) {
      const clash = groupRegistry.find(label)
      return { ok: false, reason: 'duplicate', clashesWith: clash?.label }
    }
    return { ok: true, label: after?.label, relabelled: moved }
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
        await openChatArtifactPath(value)
      } else {
        await shell.openExternal(safeArtifactURL(value), { activate: false })
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
  // Share of the screen the expanded surfaces fill. CLAMPED TO THE RANGE, not
  // to a list: the control is a slider now (40–95%), so every whole percent
  // between the ends is a legitimate value. Still never trusted — a stray
  // number would resize every surface on the machine and there is no UI path
  // back from a bad one — but an out-of-range value is brought back in rather
  // than replaced with the default, which would look like the drag was ignored.
  // The same bounds live in SurfaceSizeStep on the Swift side; both clamp,
  // because the notch process outlives any one engine run.
  ipcMain.handle('remote:set-surface-fill', async (_e, fill: number) => {
    return persistSurfaceFill(fill)
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
  // The widget module owns the window; the settings store lives here. One
  // injection rather than an import cycle.
  setWidgetCaptureReader(() => settings.get(WIDGET_CAPTURE_KEY) === true)

  ipcMain.handle('remote:get-surface-appearance', async () => settings.get('surfaceAppearance') || 'solid')
  ipcMain.handle('remote:set-surface-appearance', async (_e, v: string) => {
    const value = v === 'glass' || v === 'solid' ? v : 'system'
    settings.set('surfaceAppearance', value)
    notchClient?.send({ type: 'appearance', value } as never)
    log.event('surface-appearance-set', { value })
    return value
  })

  // THE GROUND COLOUR, separate from the material above. Space Gray is what
  // shipped before this was a choice and stays the default, so no existing
  // surface changes under anyone; black matches the notch housing's own colour
  // so an expanded surface reads as one object with the mass above it.
  // THE NOTETAKER'S OWN capture visibility — see notetakerWidget.ts for why it
  // is not `showInScreenCapture`. Default false: hidden from recordings.
  ipcMain.handle('remote:get-notetaker-capture-visible', async () => settings.get(WIDGET_CAPTURE_KEY) === true)
  ipcMain.handle('remote:set-notetaker-capture-visible', async (_e, on: boolean) => {
    settings.set(WIDGET_CAPTURE_KEY, !!on)
    // Re-apply to a widget that is already up, so the change is immediate
    // rather than waiting for the next meeting.
    refreshWidgetCapturePolicy()
    log.event('notetaker-capture-visible-set', { on: !!on })
    return !!on
  })

  ipcMain.handle('remote:get-surface-tone', async () => settings.get('surfaceTone') || 'glass')
  // Validated against the list, not against one name. The ternary this
  // replaces rewrote every value that was not exactly 'black' back to
  // 'spaceGray', so a third tone would have been accepted by the renderer,
  // stored as Space Gray, and read back as Space Gray — a setting that appears
  // to do nothing rather than one that fails.
  const SURFACE_TONES = ['spaceGray', 'black', 'glass'] as const
  ipcMain.handle('remote:set-surface-tone', async (_e, v: string) => {
    const value = (SURFACE_TONES as readonly string[]).includes(v) ? v : 'glass'
    settings.set('surfaceTone', value)
    notchClient?.send({ type: 'surfaceTone', value } as never)
    log.event('surface-tone-set', { value })
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

  // ── Unmute Agent — independent provider, availability, and memory IPC ──
  ipcMain.handle('remote:get-agent-settings', async () => ({
    agentProvider: settings.get('unmuteAgentProvider'),
    unmuteAgentAvailable: settings.get('unmuteAgentAvailable') === true,
    unmuteAgentMaxProcesses: settings.get('unmuteAgentMaxProcesses'),
    unmuteAgentConversationCeiling: settings.get('unmuteAgentConversationCeiling'),
  }))
  ipcMain.handle('remote:set-unmute-agent-provider', async (_e, provider: unknown) => {
    if (provider !== 'claude' && provider !== 'codex') return false
    await unmuteAgentLifecycle?.requestProvider(provider)
    settings.set('unmuteAgentProvider', provider)
    const selectedReady = unmuteAgentAvailability.providers
      .find((candidate) => candidate.id === provider)?.available === true
    // Preferred provider is pending; the active conversation retains its actual identity.
    log.event('unmute-agent-provider-set', { provider, available: selectedReady })
    return true
  })
  ipcMain.handle('remote:get-agent-availability', async () => structuredClone(unmuteAgentAvailability))
  ipcMain.handle('remote:agent-retry', async () => unmuteAgentLifecycle?.retry())
  ipcMain.handle('remote:get-agent-conversation', async () => unmuteAgentLifecycle?.view())
  ipcMain.handle('remote:set-agent-conversation-ceiling', async (_event, ceiling: unknown) => {
    if (typeof ceiling !== 'number' || !Number.isSafeInteger(ceiling) || ceiling < 1) return false
    settings.set('unmuteAgentConversationCeiling', ceiling)
    await agentRuntimeRouting?.call('agent.update', { conversationCeiling: ceiling })
    return true
  })
  ipcMain.handle('remote:agent-submit', async (_e, input: AgentInteractionInput) => {
    if (!unmuteAgentLifecycle) {
      return {
        interactionId: '',
        agentRunId: '',
        source: 'provider',
        outcome: 'failed',
        presentation: 'transient',
        error: unavailableAgentError(unmuteAgentAvailability.reason),
      }
    }
    return submitUnmuteAgent(input)
  })
  ipcMain.handle('remote:agent-cancel', async (_e, runId: unknown) => {
    if (!unmuteAgentSupervisor || typeof runId !== 'string' || !runId) return false
    try { await unmuteAgentSupervisor.interrupt(runId); return true } catch { return false }
  })
  ipcMain.handle('remote:list-memories', async (_e, query?: unknown) => {
    if (!unmuteAgentMemory || !unmuteAgentRecords) return []
    const needle = typeof query === 'string' ? query.trim().toLocaleLowerCase() : ''
    return (await unmuteAgentRecords.list())
      .filter((record) => !needle || [
        record.title, record.kind, record.provenance.source,
        ...record.tags, record.scope?.app, record.scope?.project, record.scope?.purpose,
        record.deletedAt === undefined ? undefined : 'trash',
      ].some((value) => value?.toLocaleLowerCase().includes(needle)))
      .map((record) => {
        const presented = presentMemoryRecord(record)
        return {
          id: presented.id,
          kind: presented.kind,
          title: presented.title,
          tags: [...presented.tags],
          ...(presented.scope ? { scope: { ...presented.scope } } : {}),
          provenance: { source: presented.provenance.source },
          attachmentCount: presented.attachments.length,
          createdAt: presented.createdAt,
          updatedAt: presented.updatedAt,
          version: presented.version,
          ...(presented.deletedAt === undefined ? {} : { deletedAt: presented.deletedAt }),
        }
      })
  })
  ipcMain.handle('remote:get-memory', async (_e, id: unknown) => {
    if (!unmuteAgentMemory || !unmuteAgentRecords || typeof id !== 'string') return null
    const now = Date.now()
    const interactionId = randomUUID()
    const principal = {
      kind: 'unmute-agent' as const,
      runId: `settings-${randomUUID()}`,
      interactionId,
      expiresAt: now + 60_000,
    }
    try {
      const record = (await unmuteAgentRecords.list()).find((candidate) => candidate.id === id)
      if (!record) return null
      const view = await unmuteAgentMemory.get(
        {
          principal,
          now,
        },
        id,
        { includeContent: true, includeDeleted: true },
      )
      return {
        id: view.id,
        kind: view.kind,
        title: view.title,
        tags: [...view.tags],
        ...(view.scope ? { scope: { ...view.scope } } : {}),
        provenance: { source: view.provenance.source },
        content: view.content,
        attachmentCount: record.attachments.length,
        createdAt: view.createdAt,
        updatedAt: view.updatedAt,
        version: view.version,
        ...(view.deletedAt === undefined ? {} : { deletedAt: view.deletedAt }),
      }
    } catch { return null }
  })
  ipcMain.handle('remote:forget-memory', async (_e, id: unknown) => {
    if (!unmuteAgentMemory || typeof id !== 'string') return false
    const now = Date.now()
    const interactionId = randomUUID()
    const principal = {
      kind: 'unmute-agent' as const,
      runId: `settings-${randomUUID()}`,
      interactionId,
      expiresAt: now + 60_000,
    }
    try {
      await unmuteAgentMemory.forget(
        { principal, now, interaction: { id: interactionId, active: true, intents: ['memory.forget'] } },
        id,
      )
      return true
    } catch { return false }
  })
  ipcMain.handle('remote:restore-memory', async (_e, id: unknown) => {
    if (!unmuteAgentMemory || typeof id !== 'string') return false
    const now = Date.now()
    const interactionId = randomUUID()
    const principal = {
      kind: 'unmute-agent' as const,
      runId: `settings-${randomUUID()}`,
      interactionId,
      expiresAt: now + 60_000,
    }
    try {
      await unmuteAgentMemory.restore(
        { principal, now, interaction: { id: interactionId, active: true, intents: ['memory.restore'] } },
        id,
      )
      return true
    } catch { return false }
  })
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
    // CONNECTING IS WHAT BRINGS THE IMPORT BACK. Pressing this launches the
    // ChatGPT app, and the app re-imports the user's Claude setup on the way
    // up — every MCP server plus CLAUDE.md into AGENTS.md. Startup pruning
    // cannot help: the pollution arrives seconds AFTER this returns, and would
    // then survive until the next launch.
    //
    // Swept whether or not the connect succeeded. The import is the app
    // starting, not the CDP handshake — the failure on 19 August still got the
    // entries back fourteen seconds later.
    sweepUnmuteFromCodexAfterConnect()
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
    log[hook.ok ? 'event' : 'warn']('codex-hook-install', { ...hook })
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
    if ('Model' in state.options && state.options.Model?.length) settings.set('codexReasoningCache' as never, state as never)
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
  disposeUnmuteAgent()
  disposeMcpServer()
  try { manager?.stopMaintenance() } catch { /* ignore */ }
  try { turnIndex.stop() } catch { /* ignore */ }
  manager = null
  completeFn = null
  try { router?.dispose() } catch { /* ignore */ }
  router = null
}
