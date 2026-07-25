// NotchClient — spawns the native `unmute-notch` helper and speaks to it over
// line-delimited JSON on stdio. v2 protocol: full cockpit/overlay data model
// (see native-notch/Sources/unmute-notch/IPC.swift, the Swift mirror).
//
// Mirrors cua/driver-client.ts's spawn discipline: the child is spawned by THIS
// process (Unmute's signed Electron main) so its window carries the app's
// identity. Fire-and-forget send(); helper pushes user intents back as events.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface, type Interface } from 'node:readline'
import { EventEmitter } from 'node:events'
import { createLogger } from '../log'

const log = createLogger('notch-client')

// ── Shared payload types (wire = camelCase JSON) ────────────────────────────

export type NotchStateName = 'dormant' | 'idle' | 'active' | 'attention' | 'task' | 'cockpit'
export type TaskStatusName = 'processing' | 'needs-user' | 'ready' | 'stuck' | 'done' | 'failed'

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
  backend?: 'claude' | 'codex-desktop'
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
  backend?: 'claude' | 'codex-desktop'
  /** Codex project name, when backend is 'codex-desktop'. */
  project?: string
  note?: string
  alive: boolean
}

export interface GroupP {
  name: string
  cards: CardP[]
  /** Settled cards folded away by the 48h rule; 0 when nothing is hidden. */
  hidden?: number
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
  queue: QueueItemP[]
  oneoffs: OneoffP[]
  projects: ProjectP[]
  suggestions: SuggestionP[]
  unmuteSkills: SkillItemP[]
  skills: SkillItemP[]
  shelf: ShelfItemP[]
  digest: string | null
  stagedCount: number
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
  | { type: 'toast'; text: string }
  | { type: 'notchGeometry'; hasNotch: boolean; x: number; y: number; w: number; h: number }
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
  | { type: 'showAll'; on: boolean }
  | { type: 'digestDismiss' }
  | { type: 'bellToggle' }
  | { type: 'offerAccept'; newTaskId: string }
  | { type: 'clearStaged' }
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
