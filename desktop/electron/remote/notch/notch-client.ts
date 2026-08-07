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

const log = createLogger('notch-client')

// ── Shared payload types (wire = camelCase JSON) ────────────────────────────

export type NotchStateName = 'dormant' | 'idle' | 'active' | 'attention' | 'task' | 'cockpit'
export type TaskStatusName = 'processing' | 'needs-user' | 'ready' | 'stuck' | 'done' | 'failed'

/**
 * THE POCKET — the state between expanded and gone.
 *
 * Leaving a task used to mean closing it, and closing carries a meaning ("I am
 * done with this") the user rarely intends: they changed window BECAUSE they
 * had to go look at something in order to answer. So the expanded panel now
 * collapses into the notch instead — the task stays alive, queued and unmuted,
 * and the voice stays pointed at it.
 *
 *   closed    — it lives in the notch as a count. The footprint IS the notch,
 *               so it covers nothing. Voice falls back to the router.
 *   transient — the card is up because you are SPEAKING. It shows where the
 *               words will land; it does not decide it.
 *   sticky    — the card is up because you TAPPED it open. Now the forefront
 *               IS the address.
 *
 * The last two must stay distinct. If merely speaking counted as opening the
 * pocket, every utterance would silently aim at a pocketed task — precisely
 * what a closed pocket exists to prevent.
 */
export type PocketMode = 'closed' | 'transient' | 'sticky'

/** One stop in the carousel: something your next words could land on. */
export interface PocketSlotP {
  /** Task id; null for the two synthetic stops. */
  id: string | null
  /** `auto` = let the router decide (it has not heard you yet, so nothing
   *  truthful can be shown); `new` = force a new task. */
  kind: 'auto' | 'task' | 'new'
  title: string
  /** The pending ask. The surface clamps it to two lines. */
  ask?: string
  status?: TaskStatusName
}

export interface PocketP {
  mode: PocketMode
  /** Index into `slots`. Whatever sits here is the address. */
  at: number
  slots: PocketSlotP[]
}

export interface ArtifactP { type: 'url' | 'path'; value: string }
export interface QuestionP { text: string; kind?: string; choices?: string[]; irreversible?: boolean }
export interface ResultP { summary: string; detail?: string; artifacts?: ArtifactP[] }
export interface ErrorP { reason: string; detail?: string }
export interface McpGapP { message: string; fixCommand: string }

/** One turn of a GUI-agent conversation — this backend's answer to the terminal. */
/** One entry of a Codex thread; see codex/rollout.ts CodexTurn for the shapes. */
export interface TurnP {
  role: 'user' | 'assistant' | 'commentary' | 'tool'
  text: string
  title?: string
  code?: string
  output?: string
  durationMs?: number
  ok?: boolean
}

export interface TaskDetailP {
  id: string
  title: string
  status: TaskStatusName
  kind: 'oneoff' | 'session'
  alive: boolean
  shelved?: boolean
  dir?: string
  age?: string
  elapsed?: string
  warmup?: string
  note?: string
  activity?: string
  question?: QuestionP
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
  /** A message is in flight to the agent. */
  sending?: boolean
  /** Codex's label for the model/effort this thread runs on. */
  modelLabel?: string
  /** Last few turns — rendered INSTEAD of the terminal for external backends. */
  conversation?: TurnP[]
  /** Codex project name, for the header. */
  project?: string
}

export interface CardP {
  id: string
  title: string
  activity?: string
  status: TaskStatusName
  kind: 'oneoff' | 'session'
  dir?: string
  age?: string
  qpos?: number
  promoted?: boolean
  agent?: boolean
  /** WHICH backend runs this task — 'claude' (owned PTY) or 'codex-desktop'
   *  (the Codex app). Rendered as a small tag so a mixed wall is unambiguous. */
  backend?: ProviderId
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
export interface ShelfItemP { id: string; name: string }
export interface RouteOfferP { newTaskId: string; altTaskId: string; altName: string }

export interface CockpitPayload {
  groups: GroupP[]
  /** Cards folded away across the whole wall — the reveal control keys off this
   *  so it never depends on one group happening to render. */
  hiddenTotal?: number
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
  origin: 'cursor' | 'task'
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

// ── Commands (main → helper) ────────────────────────────────────────────────

export type NotchCommand =
  | { type: 'setState'; state: NotchStateName; attention: number; working: number }
  | { type: 'showTask'; task: TaskDetailP }
  | { type: 'stageDetail'; task: TaskDetailP }
  | { type: 'setCockpit'; data: CockpitPayload }
  | { type: 'termData'; id: string; data: string }             // base64
  | { type: 'proposal'; data: ProposalDetailP }
  | { type: 'convData'; id: string; text: string }
  | { type: 'capturePhase'; phase: string; target?: string }
  | { type: 'pocket'; data: PocketP }
  | { type: 'scratchpad'; data: ScratchpadPayloadP }
  | { type: 'toast'; text: string }
  | { type: 'notchGeometry'; hasNotch: boolean; x: number; y: number; w: number; h: number }
  | { type: 'surfaceFill'; fill: number }
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
  | { type: 'focusTask'; id: string }
  | { type: 'closeStage' }
  /** The user left Unmute (app deactivated, or a screen capture began). An
   *  expanded task goes to the pocket rather than being dismissed. */
  | { type: 'userLeft'; reason: 'blur' | 'screenshot' }
  /** …and came back. Within the grace window this re-opens what it collapsed. */
  | { type: 'userReturned' }
  /** Move the carousel. `to` is an absolute slot index; `delta` steps. */
  | { type: 'pocketMove'; delta?: number; to?: number }
  /** Tap the pocket open (sticky), or let it go back to the notch. */
  | { type: 'pocketOpen' }
  | { type: 'pocketRelease' }
  /** Back to the full task. The pocket is a GLANCE state — it exists
   *  because the panel is large, not because the panel is wrong, so the
   *  trip back has to be one tap or it is a one-way door. */
  | { type: 'pocketExpand' }
  | { type: 'chooseOption'; id: string; index: number }
  | { type: 'answerText'; id: string; text: string }
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
  | { type: 'scratchpadDeliver'; dest: 'cursor' | 'newTask' | 'openTask' }
  | { type: 'scratchpadDiscard' }

export interface NotchClientOpts {
  binPath: string
  /** Override for tests: run a fake helper via `node <script>`. */
  binArgs?: string[]
  onExit?: (code: number | null) => void
}

/**
 * Emits: 'event' (NotchEvent), plus the raw event `type` as its own channel.
 */
export class NotchClient extends EventEmitter {
  private child: ChildProcessWithoutNullStreams
  private rl: Interface
  private dead = false

  constructor(private opts: NotchClientOpts) {
    super()
    this.child = spawn(opts.binPath, opts.binArgs ?? [], { stdio: ['pipe', 'pipe', 'pipe'] })
    this.rl = createInterface({ input: this.child.stdout })
    this.rl.on('line', (line) => this.onLine(line))
    this.child.stderr.on('data', (d: Buffer) =>
      log.warn('notch stderr', { text: d.toString().slice(0, 400) }))
    this.child.on('exit', (code) => {
      this.dead = true
      this.opts.onExit?.(code)
    })
    this.child.on('error', (e) => {
      this.dead = true
      log.warn('notch spawn error', { error: e.message })
      this.opts.onExit?.(null)
    })
    this.child.stdin.on('error', (e) => log.warn('notch stdin error', { error: e.message }))
  }

  get alive(): boolean { return !this.dead }

  private onLine(line: string): void {
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
    this.emit('event', evt)
    this.emit(evt.type, evt)
  }

  /** Push a command to the helper. No-op once the child is gone. */
  send(cmd: NotchCommand): void {
    if (this.dead) return
    try {
      this.child.stdin.write(JSON.stringify(cmd) + '\n')
    } catch (e) {
      log.warn('notch send failed', { error: (e as Error).message })
    }
  }

  /** Ask the helper to quit, then hard-kill after a grace period. */
  dispose(): void {
    if (this.dead) return
    this.send({ type: 'quit' })
    const child = this.child
    setTimeout(() => { if (!this.dead) child.kill('SIGTERM') }, 500).unref?.()
  }
}
