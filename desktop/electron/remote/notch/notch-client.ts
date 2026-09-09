// NotchClient — spawns the native `unmute-notch` helper and speaks to it over
// line-delimited JSON on stdio. v2 protocol: full cockpit/overlay data model
// (see native-notch/Sources/unmute-notch/IPC.swift, the Swift mirror).
//
// Mirrors cua/driver-client.ts's spawn discipline: the child is spawned by THIS
// process (Unmute's signed Electron main) so its window carries the app's
// identity. Fire-and-forget send(); helper pushes user intents back as events.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { ProviderId } from '../providers'
import { createInterface, type Interface } from 'node:readline'
import { EventEmitter } from 'node:events'
import { createLogger } from '../log'
import { devEvent } from '../curator-devlog'
import type { PillStateP } from './pill-controller'
import type { Block } from '../blocks'
// Re-exported so the controller can describe a task's chat view without
// reaching past this module — the wire types live here.
export type { Block } from '../blocks'

const log = createLogger('notch-client')

// ── Shared payload types (wire = camelCase JSON) ────────────────────────────

export type NotchStateName = 'dormant' | 'idle' | 'active' | 'attention' | 'task' | 'cockpit'
export type TaskStatusName = 'processing' | 'needs-user' | 'ready' | 'stuck' | 'done' | 'failed'

/**
 * THE POCKET — a small expanded state.
 *
 * There is ONE concept here, not two: a task is in front of you. It comes in
 * two sizes — the full panel, or this card — and the aim follows what you can
 * see either way:
 *
 *   task expanded  -> that task
 *   pocket open    -> the task on the card
 *   neither        -> standard routing, exactly as it has always worked
 *
 * `open` therefore only ever happens because the user OPENED it. The pocket
 * must never open itself: an earlier build bloomed the card whenever the mic
 * went hot, which made every single utterance look — and under this rule, be —
 * aimed at a pocketed task. Removing that is not a refinement of the rule, it
 * is what makes the rule true.
 *
 * Closing is the whole control. Escape shuts the card and the aim goes with it,
 * mid-sentence or not, because that is already what closing means on the
 * expanded panel. Nothing new to learn, and no modifier to remember.
 */
export type PocketMode = 'closed' | 'open'

/**
 * One stop in the pocket. Always a task — there are no synthetic entries.
 *
 * A `seam` card briefly lived here, marking where "waiting on you" ended. It
 * was a mistake: with nothing demanding it took slot 0 and announced the end of
 * a list you had not begun, it got counted as a task so two read as three, and
 * it turned a boundary you should SEE into one you had to press through. The
 * cards carry the boundary now — `demanding` ones render loud, the rest quiet.
 */
/**
 * THE POCKET IS A CONTAINER, NOT A LIST OF TASKS.
 *
 * Inside it are element KINDS. Tasks are one kind, with their own queue and
 * their own ordering. The Agent is a second kind: always present, never in that
 * queue, and holding one of exactly two positions relative to the whole task
 * block — front when it has something for you, back once you have read it.
 * More kinds will follow, and they will be more of these rather than more
 * exceptions inside the task ordering.
 */
export type PocketSlotKind = 'task' | 'agent'

export interface PocketSlotP {
  id: string
  title: string
  /** Absent means 'task' — an older helper binary reads the pocket exactly as
   *  it did before this existed. */
  kind?: PocketSlotKind
  /** The pending ask, or what it produced. The surface clamps it to two lines. */
  ask?: string
  status?: TaskStatusName
  /** Is this one actually waiting on you? Drives the card's weight, and is the
   *  only thing the closed surface is allowed to count. */
  demanding?: boolean
  /** WHICH BACKEND, so the surface can show its mark. Sent on the pocket slot
   *  too — the pocket is the surface you see most and was the one place a task
   *  never said what it runs on. */
  backend?: string
  /** Does it own a terminal? Drives the small terminal glyph beside the mark:
   *  a capability, so a CLI added later gets it without a UI edit. */
  terminal?: boolean
}

export interface PocketP {
  mode: PocketMode
  /** Which key routes to the pocket — 'fn' or 'right-option'. The card names
   *  it rather than saying "your voice", because RAW DICTATION NEVER LANDS
   *  HERE: it goes to the cursor. Saying "voice" claims both. */
  remoteKey?: 'fn' | 'right-option'
  /** How many slots are demanding. THE ONLY NUMBER THE CLOSED SURFACE MAY SHOW.
   *  `slots.length` counted everything you had merely worked in, so a quiet
   *  pocket announced itself as though work were waiting. */
  waiting: number
  /** Index into `slots`. Whatever sits here is the address while open. */
  at: number
  slots: PocketSlotP[]
}

export interface ArtifactP { type: 'url' | 'path'; value: string }
export interface QuestionP { text: string; details?: string; kind?: string; choices?: string[]; irreversible?: boolean; reference?: import('../question-reference').QuestionReference; acknowledgment?: 'pending' | 'accepted' }
export interface ResultP { summary: string; detail?: string; artifacts?: ArtifactP[] }
export interface ErrorP { reason: string; detail?: string }
export interface McpGapP { message: string; fixCommand: string }
export interface DraftAttachmentP { id: string; path: string; mimeType: string; name: string; reservationOrder?: number }
export interface TaskDraftP { text: string; attachments: DraftAttachmentP[]; clientRevision?: number; stagingCount?: number; error?: string; operations?: { id: string; name: string; phase: string; error?: string; order?: number }[] }
export interface ChatChoiceP { id: string; label: string; description?: string }
export interface ChatConfigChangeP { model?: string; effort?: string; permission?: string }
export interface DraftInsertionP { insertionOffset?: number; selectedLength?: number; clientRevision?: number; insertionText?: string; operationId?: string }
export interface ChatConfigP {
  provider: string; providerLabel: string; model: string; modelLabel: string
  providers: ChatChoiceP[]; models: ChatChoiceP[]; efforts: ChatChoiceP[]; effort?: string
  permissions: ChatChoiceP[]; permission?: string; permissionScope?: string
  cwd: string; mutable: boolean; busy: boolean; error?: string
  dictation?: 'idle' | 'recording' | 'transcribing' | 'error'; dictationError?: string
}

/** One turn of a GUI-agent conversation — this backend's answer to the terminal. */
/** One entry of a Codex thread; see codex/rollout.ts CodexTurn for the shapes. */
export interface TurnP {
  role: 'user' | 'assistant' | 'commentary' | 'tool' | 'work'
  text: string
  title?: string
  code?: string
  output?: string
  durationMs?: number
  ok?: boolean
}

export interface TaskDetailP {
  canEditLatestMessage?: boolean
  olderMessages?: number
  id: string
  title: string
  origin?: 'unmute-agent'
  agentRunId?: string
  status: TaskStatusName
  kind: 'oneoff' | 'session'
  alive: boolean
  /** Capabilities from the provider registry, SENT rather than inferred from
   *  the backend's name. Nine Swift checks used to read `backend ==
   *  "codex-desktop"`, each a negation of one backend and each silently wrong
   *  for the next one to arrive. */
  resumable?: boolean
  /** Did Unmute spawn the process? Decides Kill versus Remove. */
  owned?: boolean
  /** The CLI process is currently being restored for this conversation. */
  resuming?: boolean
  /** Visible reason when restoring the CLI process failed. */
  resumeError?: string
  shelved?: boolean
  dir?: string
  age?: string
  elapsed?: string
  warmup?: string
  note?: string
  activity?: string
  history?: import('../codex/app-server-events').HistoryState
  turnOutcome?: import('../blocks').TurnOutcome
  mcpStatuses?: import('../codex/app-server-events').McpStatus[]
  question?: QuestionP
  questionAcknowledgment?: { reference: import('../question-reference').QuestionReference; state: 'pending' | 'accepted' }
  result?: ResultP
  error?: ErrorP
  mcpGap?: McpGapP
  /** Which backend runs this task; drives whether the panel shows a terminal
   *  (Claude, PTY) or the conversation (Codex, no PTY). */
  backend?: ProviderId
  /** Does this task have a live terminal? Resolved from the provider registry
   *  (providers.ts) and SENT, so the Swift side stops deriving it from its own
   *  list of desktop backends — the two lists had already drifted. Optional: an
   *  older helper binary ignores the field and falls back to its own answer. */
  terminal?: boolean
  /** Last message that did not reach the agent (NOT a task failure). */
  deliveryError?: string
  agentCanRetry?: boolean
  /** A message is in flight to the agent. */
  sending?: boolean
  /** Codex's label for the model/effort this thread runs on. */
  modelLabel?: string
  /** Last few turns — rendered INSTEAD of the terminal for external backends.
   *
   *  SUPERSEDED BY `blocks`, and kept for one reason: a task rehydrated from a
   *  meta.json written before the upgrade has this and nothing else. The
   *  surface prefers `blocks` whenever they are present. */
  conversation?: TurnP[]
  /** The chat view proper — see electron/remote/blocks.ts and the spec at
   *  docs/superpowers/specs/2026-08-16-chat-view-blocks.md. Every provider maps
   *  its own source into this one vocabulary; the surface draws a view per kind
   *  and degrades a kind it does not know to a plain row. */
  blocks?: Block[]
  /** Token usage for the panel footer, when the provider reports it. */
  usage?: { used: number; window: number; rateLimitPercent?: number; resetsAt?: number }
  /** Codex project name, for the header. */
  project?: string
  /** One task-scoped unsent draft, shared by every expanded native surface. */
  draft?: TaskDraftP
  followup?: import('../task-followup').FollowupP
  composerMode?: 'queue' | 'full' | 'answer' | 'send' | 'locked'
  chatConfig?: ChatConfigP
  canCompose?: boolean
}

export interface CardP {
  id: string
  title: string
  origin?: 'unmute-agent'
  agentRunId?: string
  activity?: string
  status: TaskStatusName
  kind: 'oneoff' | 'session'
  dir?: string
  age?: string
  qpos?: number
  promoted?: boolean
  agent?: boolean
  /** WHICH backend runs this task. ALWAYS SENT — this was driver-only, so a
   *  Codex CLI card arrived with no backend and the wall's label fell through
   *  to its default, printing "Claude Code CLI" on a Codex task. */
  backend?: ProviderId
  /** Owns a terminal. A capability, so the mark's terminal glyph follows the
   *  registry rather than a list of backend names. */
  terminal?: boolean
  /** Codex project name, when backend is 'codex-desktop'. */
  project?: string
  /** The model that actually RAN this task, recorded at dispatch and persisted
   *  (decision D6). Absent means absent — never a default, never the current
   *  picker value, because a task run under Sonnet must not claim Opus because
   *  the picker moved since. */
  model?: string
  note?: string
  alive: boolean
}

export interface GroupP {
  name: string
  cards: CardP[]
  /** Settled cards folded away by the 48h rule; 0 when nothing is hidden. */
  hidden?: number
  /** True while this group is showing everything it holds. */
  expanded?: boolean
}
export interface QueueItemP { id: string; name: string; status: TaskStatusName }
export interface OneoffP { id: string; name: string; status: TaskStatusName; age?: string }
export interface ProjectP { name: string; path: string }
export interface SuggestionP { id: string; kind: string; name: string }
export interface SkillItemP {
  name: string
  pinned: boolean
  runs: number
  lastUsed?: string
  description?: string
  origin?: 'unmute'
}
/** One offerable CLI session. See claude-cli-sessions.ts. */
export interface ImportableP {
  sessionId: string
  title: string
  project: string
  /** Relative age of the last interaction, pre-rendered ("2h", "3d"). */
  age: string
  /** WHICH CLI this session belongs to ('claude' | 'codex'). The rail groups by
   *  it and marks each group; without it two backends' sessions sat in one list
   *  under a heading that named only Claude. */
  agent?: string
}

export interface ShelfItemP { id: string; name: string }
export interface RouteOfferP { newTaskId: string; altTaskId: string; altName: string }

export interface CockpitPayload {
  projects?: Array<{name: string; path: string}>
  groups: GroupP[]
  /** Cards folded away across the whole wall — the reveal control keys off this
   *  so it never depends on one group happening to render. */
  hiddenTotal?: number
  /** Is the dashboard's Today filter on? A straight 24h filter over the wall —
   *  NOT the per-group "show all" fold, which answers a different question. */
  todayOnly?: boolean
  /** True while "show all" is on for this visit to the cockpit. */
  showingAll?: boolean
  queue: QueueItemP[]
  oneoffs: OneoffP[]
  // projects / suggestions REMOVED. Projects was a directory list with no
  // action attached; Suggestions was the curator's review inbox, and the
  // curator is parked (CURATOR_PARKED in remote/init.ts), so it can never
  // receive anything again. An inbox that cannot fill is worse than no inbox.
  unmuteSkills: SkillItemP[]
  skills: SkillItemP[]
  shelf: ShelfItemP[]
  /** Claude Code CLI sessions on this machine that unmute does NOT have.
   *  The only thing this list is for is importing them; a row that is already
   *  a task never appears. */
  importable?: ImportableP[]
  digest: string | null
  doorbell: boolean
  routeOffer: RouteOfferP | null
  tmuxAvailable: boolean
}

export interface ProposalDetailP {
  id: string
  kind: string
  name: string
  evidence: string
  summary: string
  bullets?: string[]
  body?: string
  diff?: string
}

// ── The scratchpad ──────────────────────────────────────────────────────────
//
// ONE ENTRY, RAW. The surface is sent what the entry IS, not how to draw it:
// a segment's text and its start/end, an insert's kind and content. Glyph,
// preview and duration are decided in Swift, where the layout is.

export interface ScratchpadEntryP {
  id: string
  type: 'segment' | 'insert'
  /** segment: the transcript, '' until it lands. */
  text?: string
  /** insert: url | path | line | block | image. */
  kind?: string
  /** insert: the text, or an absolute file path for an image. */
  content?: string
  startMs?: number
  endMs?: number
  atMs?: number
}

export interface ScratchpadPadP {
  id: string
  /** Where the capture that opened this pad was heading — the DEFAULT
   *  destination, never a commitment. */
  /** Where the capture was headed when it opened. The pad panel picks its
   *  destination buttons from this, so 'agent' has to survive the wire. */
  origin: 'cursor' | 'task' | 'agent'
  entries: ScratchpadEntryP[]
}

/** Where a held pad can go. `openTask` is null unless a task is genuinely
 *  focused — offering a destination that cannot receive is worse than not
 *  offering it. */
export interface ScratchpadDestinationsP {
  cursor: true
  newTask: true
  openTask: { id: string; name: string } | null
}

/** Everything the pad surface draws, read in one go so pad, arm state and
 *  destinations can never be sampled from two different instants. */
export interface ScratchpadPayloadP {
  /** The feature's master switch (settings). Off ⇒ no icon at all. */
  enabled: boolean
  armed: boolean
  /** A delivery is in flight. The pad has ALREADY been taken for it, so
   *  Discard must not be offered — see the delivery seam's restage path. */
  delivering: boolean
  pad: ScratchpadPadP | null
  destinations: ScratchpadDestinationsP
}

export interface UnmuteAgentActivityP {
  state: 'listening' | 'searching' | 'thinking' | 'confirming' | 'complete' | 'failed'
  summary: string
  interactionId?: string
  agentRunId?: string
  provider?: 'claude' | 'codex'
}

// ── Commands (main → helper) ────────────────────────────────────────────────

export type NotchCommand =
  | { type: 'bootstrap'; appearance: 'system' | 'glass' | 'solid'; surfaceFill: number; showInScreenCapture: boolean; terminalAutoExpand: boolean; autoPresent: boolean }
  | { type: 'present' }
  | { type: 'setState'; state: NotchStateName; attention: number; working: number }
  | { type: 'showTask'; task: TaskDetailP }
  | { type: 'messageEditStatus'; id: string; accepted: boolean; error?: string }
  | { type: 'stageDetail'; task: TaskDetailP }
  | { type: 'setCockpit'; data: CockpitPayload }
  | { type: 'termData'; id: string; data: string }             // base64
  | { type: 'proposal'; data: ProposalDetailP }
  | { type: 'convData'; id: string; text: string }
  | { type: 'capturePhase'; phase: string; target?: string }
  | { type: 'pocket'; data: PocketP }
  | { type: 'pill'; state: PillStateP }
  | { type: 'scratchpad'; data: ScratchpadPayloadP }
  | { type: 'agentActivity'; activity: UnmuteAgentActivityP }
  /**
   * The Agent's conclusion. Empty text takes it down.
   *
   * `hold` is the caption kept open: same slabs, same voice, no clock, for an
   * answer that IS the deliverable rather than a pointer to one. Still not the
   * notch — the notch stays independent of anything the Agent says.
   */
  | { type: 'toast'; text: string }
  | { type: 'newChatStatus'; pending: boolean; error?: string }
  | { type: 'newChatPreview'; token: string; preview?: import('../managed-project').ChatPreview; error?: string }
  | { type: 'questionAnswerStatus'; id: string; reference: import('../question-reference').QuestionReference; state: 'pending' | 'accepted' | 'rejected' }
  | { type: 'draftAttachmentError'; id: string; operationId: string; error: string }
  | { type: 'notchGeometry'; hasNotch: boolean; x: number; y: number; w: number; h: number }
  | { type: 'surfaceFill'; fill: number }
  | { type: 'screenCaptureVisibility'; show: boolean }
  /** Should opening a CLI task show its terminal straight away? A preference,
   *  not a rule — a task that can ONLY be answered in the terminal still opens
   *  it regardless, because the alternative is telling someone to answer in a
   *  terminal that is not on screen. */
  | { type: 'terminalAutoExpand'; on: boolean }
  | { type: 'collapse' }
  | { type: 'quit' }

// ── Events (helper → main) ──────────────────────────────────────────────────

export type NotchEvent =
  | { type: 'ready' }
  | { type: 'tap' }
  | { type: 'collapsed' }
  | { type: 'openDashboard' }
  | { type: 'next' }
  | { type: 'prev' }
  | { type: 'editLatestMessage'; id: string; expected: string; text: string }
  | { type: 'loadOlderMessages'; id: string }
  | { type: 'focusTask'; id: string }
  /** Open the POCKET on this card. focusTask lands in the cockpit instead. */
  | { type: 'pocketFocusTask'; id: string }
  | { type: 'closeStage' }
  /** The user left: another app came forward, or they swiped to another Space.
   *  Any expanded surface gets out of the way — a task goes to the pocket, the
   *  wall simply collapses. You went elsewhere because you needed the screen. */
  | { type: 'userLeft'; reason: 'blur' | 'screenshot' | 'space' }
  /** …and came back. Within the grace window this re-opens what it collapsed. */
  | { type: 'userReturned' }
  /** Move the carousel. `to` is an absolute slot index; `delta` steps. */
  | { type: 'pocketMove'; delta?: number; to?: number }
  /** Tap the pocket open (sticky), or let it go back to the notch. */
  | { type: 'pocketOpen' }
  /** Hold background audio quiet from an open card, or give it back. The hold
   *  is released on collapse too — a mute the user can no longer see is one
   *  they cannot undo. */
  | { type: 'backgroundAudio'; muted: boolean }
  | { type: 'pocketRelease' }
  /** Back to the full task. The pocket is a GLANCE state — it exists
   *  because the panel is large, not because the panel is wrong, so the
   *  trip back has to be one tap or it is a one-way door. */
  /** `id` names the slot the CARD was showing — the queue can re-sort between
   *  the draw and the keystroke, so position alone opens the wrong task. */
  | { type: 'pocketExpand'; id?: string }
  | { type: 'chooseOption'; id: string; index: number; reference?: import('../question-reference').QuestionReference }
  | { type: 'answerText'; id: string; text: string; reference?: import('../question-reference').QuestionReference }
  | { type: 'reloadHistory'; id: string }
  | { type: 'setDraftText'; id: string; text: string; clientRevision?: number }
  /** Arm a visual tool for the next message, or clear it with null. */
  | { type: 'setDraftTool'; id: string; tool: string | null }
  | ({ type: 'addDraftImage'; id: string; path: string; mimeType: string; name: string } & DraftInsertionP)
  | ({ type: 'reserveDraftAttachment'; id: string; operationId: string; name: string } & DraftInsertionP)
  | { type: 'failDraftAttachment'; id: string; operationId: string; error: string }
  | { type: 'configureChat'; id: string; change: ChatConfigChangeP }
  | { type: 'toggleDraftDictation'; id: string; insertion?: DraftInsertionP }
  | { type: 'cancelDraftDictation'; id: string }
  | ({ type: 'newChat' } & import('../managed-project').NewChatOptions)
  | ({ type: 'previewChat'; token: string } & import('../managed-project').NewChatOptions)
  | { type: 'removeDraftAttachment'; id: string; attachmentId: string }
  | { type: 'restoreDraftAttachment'; id: string; attachmentId: string }
  | { type: 'undoDraftAttachment'; id: string; attachmentId: string }
  | { type: 'redoDraftAttachment'; id: string; attachmentId: string }
  | { type: 'sendDraft'; id: string; reference?: import('../question-reference').QuestionReference }
  | { type: 'agentSend'; submissionId: string; revision: number }
  | { type: 'agentRetry' }
  /** End this Agent conversation and keep nothing; the next turn starts clean. */
  | { type: 'agentNewConversation' }
  | { type: 'cancelTaskFollowup' | 'restoreTaskFollowup' | 'queueSavedTaskFollowup' | 'recoverUncertainFollowup'; id: string; queueId: string }
  | { type: 'mute'; id: string }
  | { type: 'kill'; id: string }
  | { type: 'resume'; id: string }
  | { type: 'rerun'; id: string }
  | { type: 'remove'; id: string }
  | { type: 'killAll' }
  | { type: 'setKind'; id: string; kind: 'oneoff' | 'session' }
  | { type: 'shelve'; id: string; shelved: boolean }
  | { type: 'rename'; id: string; name: string }
  | { type: 'setNote'; id: string; note: string }
  | { type: 'pinSkill'; name: string; pinned: boolean }
  | { type: 'tapSkill'; name: string }
  | { type: 'openProject'; path: string; name: string }
  | { type: 'clearFinished' }
  | { type: 'showAll'; group?: string; on: boolean }
  | { type: 'today'; on: boolean }
  /** Adopt a CLI session as a task. Creates a card; starts nothing. */
  | { type: 'importSession'; sessionId: string }
  | { type: 'digestDismiss' }
  | { type: 'bellToggle' }
  | { type: 'offerAccept'; newTaskId: string }
  | { type: 'openArtifact'; artifactType: 'url' | 'path'; value: string }
  | { type: 'openInTerminal'; id: string }
  | { type: 'termOpen'; id: string }
  | { type: 'termClose'; id: string }
  | { type: 'termInput'; id: string; data: string }            // base64
  | { type: 'termResize'; id: string; cols: number; rows: number }
  | { type: 'suggestionOpen'; id: string }
  | { type: 'suggestionAccept'; id: string }
  | { type: 'suggestionReject'; id: string; reason: string }
  | { type: 'converseWrite'; id: string; text: string }
  | { type: 'converseStop'; id: string }
  // The scratchpad. ARM IS THE ONLY THING THE ICON SENDS — send and discard are
  // deliberate acts on the pad itself, never a side effect of a mode switch.
  | { type: 'scratchpadArm'; on: boolean }
  | { type: 'scratchpadRemove'; id: string }
  | { type: 'scratchpadDeliver'; dest: 'cursor' | 'newTask' | 'openTask' | 'agent' }
  | { type: 'scratchpadDiscard' }

export interface NotchClientOpts {
  binPath: string
  /** Override for tests: run a fake helper via `node <script>`. */
  binArgs?: string[]
  onExit?: (code: number | null) => void
  /** Complete preference snapshot applied before any replayed visual state. */
  bootstrap?: () => Extract<NotchCommand, { type: 'bootstrap' }>
  /** Unexpected exits restart after this delay. Omit to disable supervision. */
  restartDelayMs?: number
}

/**
 * Emits: 'event' (NotchEvent), plus the raw event `type` as its own channel.
 */
export class NotchClient extends EventEmitter {
  private child!: ChildProcessWithoutNullStreams
  private rl!: Interface
  private dead = false
  private generationReady = false
  private disposed = false
  private generation = 0
  private replay = new Map<NotchCommand['type'], NotchCommand>()
  private static readonly replayOrder: NotchCommand['type'][] = [
    'showTask', 'setCockpit', 'stageDetail', 'pocket', 'scratchpad', 'pill', 'capturePhase', 'setState',
  ]

  constructor(private opts: NotchClientOpts) {
    super()
    this.spawn()
  }

  private spawn(): void {
    const generation = ++this.generation
    this.dead = false
    this.generationReady = false
    this.child = spawn(this.opts.binPath, this.opts.binArgs ?? [], { stdio: ['pipe', 'pipe', 'pipe'] })
    this.rl = createInterface({ input: this.child.stdout })
    this.rl.on('line', (line) => this.onLine(line, generation))
    // MIRRORED ONLY WHEN SOMEONE IS READING IT. The notch already writes every
    // one of these lines to its own notch.log; re-logging them here stored a
    // second copy of the same session — measured at ~78 lines a second, 25MB in
    // under an hour — in the run log, at WARN level, in production, where the
    // vast majority are ordinary UI state ("bar idle", "CMD setState"). The
    // notch's own log is the place to read them; this mirror is for a dev build
    // that wants both streams interleaved.
    this.child.stderr.on('data', (d: Buffer) =>
      devEvent(log, 'notch-stderr', { text: d.toString().slice(0, 400) }))
    this.child.on('exit', (code) => {
      if (generation != this.generation) return
      this.dead = true
      this.opts.onExit?.(code)
      if (!this.disposed && this.opts.restartDelayMs != null) {
        setTimeout(() => { if (!this.disposed && generation == this.generation) this.spawn() }, this.opts.restartDelayMs).unref?.()
      }
    })
    this.child.on('error', (e) => {
      if (generation != this.generation) return
      this.dead = true
      log.warn('notch spawn error', { error: e.message })
      this.opts.onExit?.(null)
      if (!this.disposed && this.opts.restartDelayMs != null) {
        setTimeout(() => { if (!this.disposed && generation == this.generation) this.spawn() }, this.opts.restartDelayMs).unref?.()
      }
    })
    this.child.stdin.on('error', (e) => log.warn('notch stdin error', { error: e.message }))
  }

  get alive(): boolean { return !this.dead }

  private onLine(line: string, generation: number): void {
    if (generation != this.generation) return
    const trimmed = line.trim()
    if (!trimmed) return
    let evt: NotchEvent
    try {
      evt = JSON.parse(trimmed) as NotchEvent
    } catch {
      log.warn('notch: bad event line', { line: trimmed.slice(0, 200) })
      return
    }
    if (!evt || typeof (evt as { type?: unknown }).type !== 'string') return
    if (evt.type === 'ready') {
      const bootstrap = this.opts.bootstrap?.()
      if (bootstrap) this.write(bootstrap)
      // Domain payloads must exist before the visual state that renders them.
      // Map insertion order depends on runtime history, so use a fixed replay
      // order on every helper generation.
      for (const type of NotchClient.replayOrder) {
        const command = this.replay.get(type)
        if (command) this.write(command)
      }
      if (bootstrap) this.write({ type: 'present' })
      this.generationReady = true
    }
    this.emit('event', evt)
    this.emit(evt.type, evt)
  }

  /** Push a command to the helper. No-op once the child is gone. */
  send(cmd: NotchCommand): void {
    if (this.isReplayable(cmd)) this.replay.set(cmd.type, cmd)
    if (this.disposed || this.dead || !this.generationReady) return
    this.write(cmd)
  }

  private write(cmd: NotchCommand): void {
    try {
      this.child.stdin.write(JSON.stringify(cmd) + '\n')
    } catch (e) {
      log.warn('notch send failed', { error: (e as Error).message })
    }
  }

  private isReplayable(cmd: NotchCommand): boolean {
    return cmd.type === 'setState' || cmd.type === 'showTask' || cmd.type === 'setCockpit'
      || cmd.type === 'stageDetail'
      || cmd.type === 'pocket' || cmd.type === 'pill' || cmd.type === 'scratchpad'
      || cmd.type === 'capturePhase'
  }

  /** Ask the helper to quit, then hard-kill after a grace period. */
  dispose(): void {
    this.disposed = true
    if (this.dead) return
    this.write({ type: 'quit' })
    const child = this.child
    setTimeout(() => { if (!this.dead) child.kill('SIGTERM') }, 500).unref?.()
  }
}
