import { messageWindow } from './message-window'
import type { RoutineEditorFields } from '../agent/routines/editor'
// NotchController — the brain between the task runtime and the native notch.
//
// v2: full cockpit/overlay parity. It owns the your-move QUEUE (skip=requeue),
// derives the six-rung baseline (dormant/active/attention) vs. the user's
// engaged state (task/cockpit), builds the complete CockpitPayload (groups,
// queue, one-offs, projects, suggestions, skills, digest, doorbell,
// route offer) and per-task TaskDetail, streams PTY output to the helper's
// terminal, and maps EVERY helper event onto the same internals the old IPC
// handlers call. Pure orchestration over injected deps — unit-testable without
// a TaskManager, window, or child process.
import type { EventEmitter } from 'node:events'
import { sameQuestion, type QuestionReference, type AnswerContext } from '../question-reference'
import { describeActivity, type Activity } from '../activity'
import type {
  NotchCommand, NotchEvent, NotchStateName, TaskStatusName,
  TaskDetailP, CardP, CockpitPayload, SkillItemP, ProposalDetailP,
  ScratchpadPayloadP, PocketP, PocketSlotP, PocketMode, TurnP, Block,
  ChatConfigP, ChatConfigChangeP, DraftInsertionP, CommandItemP,
} from './notch-client'
import type { TaskDraft } from '../task-draft'
import { providerOf, type ProviderId } from '../providers'
import { ALWAYS_PRESENT, type PresenceLike } from '../presence'
import { createLogger } from '../log'
import { devEvent } from '../curator-devlog'
import { nextFocusedComposer, type ComposerFocusEvent } from './composerFocus'
import { conciseLine } from '../agent/conversation'
import { randomUUID } from 'node:crypto'
import type { AgentConversationView } from '../agent/lifecycle'
import { agentModel, agentModelLabel } from '../agent/modelPolicy'
import type { RoutineRun, RoutinesView } from '../agent/routines/types'
import { mergeRoutineBlocks, routineEntries, routinesPayload } from './routine-blocks'
import { emitOnboardingReceipt } from '../../onboarding/receipts'

const log = createLogger('notch-controller')
const ROUTINE_TERMINAL: ReadonlySet<RoutineRun['status']> = new Set(['done', 'failed', 'cancelled', 'skipped'])
const firstLine = (text: string | undefined): string => (text ?? '').split('\n').find(l => l.trim())?.trim() ?? ''

// Task shape as serializeTask emits it (the same object remote:list returns).
export interface TaskLite {
  /** What the task is doing right now (activity.ts). Present only while it is
   *  actually doing it — cleared the moment the work stops, so it can never be
   *  the stale sentence on a finished card. */
  codexActivity?: Activity
  id: string
  intent: string
  origin?: 'unmute-agent' | null
  agentRunId?: string | null
  name?: string | null
  cwd?: string
  kind?: 'oneoff' | 'session'
  // ProviderId, not a hand-written copy of it. This was spelled out literally
  // and so silently excluded the fourth backend the moment one was added —
  // the exact drift providers.ts was created to end.
  agent?: ProviderId
  codexProject?: string | null
  conversation?: TurnP[] | null
  /** The chat view — see TaskDetailP.blocks. */
  blocks?: Block[] | null
  /** True only once `blocks` came from the durable frame file rather than a
   *  reattached channel's replay tail. A tail is a fragment that looks whole:
   *  the window's own count is taken over what is loaded, so a one-turn tail
   *  reports zero older and hides the control that would fetch the rest. */
  blocksDurable?: boolean
  usage?: { used: number; window: number; rateLimitPercent?: number; resetsAt?: number } | null
  /** Last message that did not reach the agent (NOT a task failure). */
  deliveryError?: string
  /** A message is in flight to the agent. */
  sending?: boolean
  /** The CLI session is being brought back after its process went away. */
  resuming?: boolean
  /** Why the most recent relaunch attempt failed, when it did. */
  resumeError?: string | null
  /** Codex's label for this thread's model/effort, e.g. "5.6 Terra High".
   *  NOT persisted: set at creation and gone after a restart. Prefer `model`. */
  codexModelLabel?: string
  /** The model that actually ran this task — recorded at dispatch and written
   *  to meta.json (Pack F, decision D6), so it survives a restart. */
  model?: string
  threadContext?: string | null
  /** Out of the pocket (TaskManager.setInPocket). Pocket-only: the wall, the
   *  rail and retention all ignore it. */
  pocketRemoved?: boolean
  note?: string | null
  spawnedBy?: string | null
  group?: string | null
  state: TaskStatusName
  /** This `done` is a scheduled pause in an autonomous multi-task run, not a
   *  real stop — see Task.checkpoint. Suppresses the demanding/auto-expand
   *  treatment a session's `done` would otherwise get, but only until... */
  checkpoint?: boolean
  /** ...this passes. Past it with no new prompt, the loop's own promised
   *  wakeup never arrived — demanding() stops trusting `checkpoint` so a
   *  truly abandoned session still eventually re-demands, same as any other
   *  stuck task. See Task.checkpointExpiresAt. */
  checkpointExpiresAt?: number
  step?: string | null
  lastUserInputAt?: number
  createdAt?: number
  updatedAt?: number
  result?: { summary: string; detail?: string; artifacts?: Array<{ type: 'url' | 'path'; value: string }> } | null
  error?: { reason: string; detail?: string } | null
  question?: import('./notch-client').QuestionP | null
  questionAcknowledgment?: { reference: QuestionReference; state: 'pending' | 'accepted' }
  history?: import('../codex/app-server-events').HistoryState
  chatUnstarted?: boolean
  turnOutcome?: import('../blocks').TurnOutcome
  mcpStatuses?: import('../codex/app-server-events').McpStatus[]
  mcpGap?: { integration?: string; fixCommand: string; message: string } | null
  alive?: boolean
  /** The runtime reports a turn in flight (TaskManager.turnActive). */
  turnActive?: boolean
  chatWritable?: boolean
  chatResumable?: boolean
  chatOwned?: boolean
}

/**
 * WHETHER TO OFFER STOP: whenever work is visibly happening on a task that is
 * ours to stop. Deliberately NOT gated on `alive` or on `state` alone — both
 * lag the runtime (a reattach that lost the turn-start, a disconnect that
 * latched failed) and that is how cards streamed output with no Stop at all.
 * The runtime's own busy flag is the strongest witness; state is a fallback.
 */
export function canStopTask(t: TaskLite): boolean {
  // The Agent's own chat is not a task and never reaches this rule — its Stop
  // is answered in sendAgentDetail, from the busy flag, because none of the
  // task signals below exist for it. Cards the Agent OPENED are ordinary tasks.
  if (t.id === 'unmute-agent') return false
  if (providerOf(t.agent).transport !== 'structured' || t.chatOwned === false) return false
  return t.turnActive === true || t.state === 'processing' || t.state === 'needs-user'
}

export interface ProposalLite {
  id: string
  kind: 'create' | 'narrow' | 'split' | 'merge' | 'retire'
  draft: { name: string; description?: string; body?: string }
  evidence?: {
    occurrences?: number
    sessions?: Array<unknown>
    struggle?: { errors?: number; recoveries?: number; wallClockMin?: number }
  }
  rationale?: string
  changeSummary?: string[]
  diff?: string
}

/** Everything the controller needs from the app — each maps 1:1 onto the SAME
 *  internals the legacy IPC handlers call (see init.ts wiring). */
export interface NotchControllerDeps {
  // task runtime
  listTasks(): TaskLite[]
  getTask(id: string): TaskLite | undefined
  /** False when the answer was REFUSED — an open picker Unmute will not drive.
   *  The task is still blocked, so the crank must not move off it. */
  answer(id: string, text: string): boolean
  answerAsync?(id: string, text: string, reference?: QuestionReference): Promise<boolean>
  canEditLatestMessage?(id: string): boolean
  editLatestMessage?(id: string, expected: string, text: string): Promise<boolean>
  getDraft?(id: string): TaskDraft
  setDraftText?(id: string, text: string, clientRevision?: number): void
  /** Arm a visual tool for the next message on this task, or clear it. */
  setDraftTool?(id: string, tool: string | null): void
  addDraftImage?(id: string, path: string, mimeType: string, name: string, insertion?: DraftInsertionP): Promise<void> | void
  reserveDraftAttachment?(id: string, operationId: string, name: string, insertion: DraftInsertionP): void
  failDraftAttachment?(id: string, operationId: string, error: string): void
  getChatConfig?(id: string): ChatConfigP | undefined
  /** The slash-command list for a task. Synchronous by contract: the payload
   *  must never wait on a CLI handshake, so a cold list arrives on a later
   *  refresh instead of stalling the card. */
  getCommands?(id: string): CommandItemP[] | undefined
  configureChat?(id: string, change: ChatConfigChangeP): Promise<void> | void
  toggleDraftDictation?(id: string, insertion?: DraftInsertionP): void
  cancelDraftDictation?(id: string): void
  createChat?(options: import('../managed-project').NewChatOptions): Promise<string>
  previewChat?(options: import('../managed-project').NewChatOptions): Promise<import('../managed-project').ChatPreview>
  removeDraftAttachment?(id: string, attachmentId: string): Promise<void> | void
  restoreDraftAttachment?(id: string, attachmentId: string): Promise<void> | void
  undoDraftAttachment?(id: string, attachmentId: string): Promise<void> | void
  redoDraftAttachment?(id: string, attachmentId: string): Promise<void> | void
  sendDraft?(id: string, context?: AnswerContext): Promise<import('../task-followup').SubmitDraftOutcome | boolean> | import('../task-followup').SubmitDraftOutcome | boolean
  getFollowup?(id: string): import('../task-followup').FollowupP | undefined
  getComposerMode?(id: string): 'queue' | 'full' | 'answer' | 'send' | 'locked' | undefined
  draftSubmitting?(id: string): boolean
  cancelTaskFollowup?(id: string, queueId: string): Promise<boolean> | boolean
  restoreTaskFollowup?(id: string, queueId: string, confirmUncertain?: boolean): Promise<boolean> | boolean
  queueSavedTaskFollowup?(id: string, queueId: string): Promise<boolean> | boolean
  kill(id: string): void
  /** Hold background audio quiet, and give it back. Optional: a build without
   *  the media adapter simply never supplies these, and the control is inert
   *  rather than broken — the same shape every other optional dep here takes. */
  holdBackgroundAudio?(): void
  releaseBackgroundAudio?(): void
  remove(id: string): Promise<void> | void
  killAll(): void
  resume(id: string): Promise<boolean> | boolean
  rerun(intent: string): void
  setKind(id: string, kind: 'oneoff' | 'session'): void
  setName(id: string, name: string): void
  /** Put a task back in the pocket, or take it out. Nothing else changes. */
  setInPocket(id: string, inPocket: boolean): void
  setNote(id: string, note: string): void
  focus(id: string | null): void
  /** Run an Agent turn from typed text — the chat's composer. Optional: a host
   *  that does not wire it leaves the Agent voice-only. */
  agentSend?(text: string, submission: { submissionId: string; revision: number }): Promise<void>
  agentDraftChanged?(text: string, revision: number): Promise<void>
  agentRetry?(): Promise<void>
  /** Stop the Agent turn that is running. Optional: a host that does not wire
   *  it leaves the chat with no way out of a long answer but waiting. */
  agentStop?(): Promise<void>
  agentSwitchProvider?(provider: 'claude' | 'codex'): Promise<void>
  /** Every model a provider offers the Agent, and the one chosen. */
  agentModelsFor?(provider: 'claude' | 'codex'): { models: Array<{ id: string; label: string }>; selected: string }
  agentSetModel?(provider: 'claude' | 'codex', model: string): Promise<void>
  /** Which Agent providers have their CLI installed. Only these are offered. */
  agentInstalledProviders?(): Promise<Array<'claude' | 'codex'>>
  /** End the Agent conversation and keep nothing. */
  agentNewConversation?(): Promise<void>
  /** Routine controls from the Agent's routines and run sheets. */
  routineAction?(action: { type: 'runNow'; id: string } | { type: 'setEnabled'; id: string; enabled: boolean } | { type: 'update'; id: string; fields: RoutineEditorFields } | { type: 'create'; fields: RoutineEditorFields } | { type: 'duplicate' | 'remove'; id: string } | { type: 'cancel'; runId: string } | { type: 'openTranscript'; runId: string } | { type: 'proposal'; runId: string; proposalId: string; decision: 'approve' | 'dismiss' } | { type: 'markRead' | 'refreshContext' }): Promise<void>
  /** One run with its full result text, for the run sheet and the chat. */
  routineRunDetail?(runId: string): Promise<{ run: RoutineRun; result: string | null; hasTranscript: boolean } | null>
  /** THE VOICE IS POINTED AT THE AGENT (its card is in front, or its chat is
   *  open). Separate from `focus`, which names a task and must never be handed
   *  an id the task runtime cannot resolve. Optional: a host that does not wire
   *  it simply keeps the Agent on its own key. */
  addressAgent?(on: boolean): void
  /** A capture is recording (any lane: dictation, Remote, Agent). While it is,
   *  nothing automatic may move the surface or the voice — the destination is
   *  read at submit, so a mid-utterance switch sends the words elsewhere. Must
   *  be a cheap read: it is consulted while the mic is hot. */
  isCapturing?(): boolean
  /** The user opened this card (tap / cockpit stage). Revives a persistent
   *  session whose PTY the quit switch closed — see TaskManager.opened. Optional
   *  so a host that doesn't wire it simply keeps the manual Resume button. */
  opened?(id: string): void
  /** Which key the user has bound to Remote — whichever of fn / right-option
   *  dictation did NOT take. The pocket names it instead of saying "voice". */
  remoteKey?(): 'fn' | 'right-option'
  /** CLI sessions on this machine that are not tasks yet. Refreshed with the
   *  rails, not on every reconcile — it touches the filesystem. */
  listImportable?(): Promise<Array<{ sessionId: string; title: string; project: string; lastActivityAt: number }>>
  /** Adopt one. Creates a card and starts nothing. */
  importSession?(sessionId: string): Promise<boolean>
  // terminal
  getOutput(id: string): string
  sendInput(id: string, data: string): void
  resizeTerm(id: string, cols: number, rows: number): void
  openInTerminal(id: string): void
  tmuxAvailable(): boolean
  // rails
  listSkills(): Promise<SkillItemP[]>
  listProjects(): Promise<Array<{ name: string; path: string }>>
  pinSkill(name: string, on: boolean): Promise<void> | void
  tapSkill(taskId: string, name: string): boolean | Promise<boolean>
  openProject(path: string, name: string): void
  // curator
  listProposals(): Promise<ProposalLite[]>
  getProposal(id: string): Promise<ProposalLite | null>
  acceptProposal(id: string): Promise<{ ok: boolean; error?: string }>
  rejectProposal(id: string, reason: string): Promise<void> | void
  converseStart(id: string, onData: (chunk: string) => void): Promise<boolean>
  converseWrite(id: string, text: string): void
  converseStop(id: string): void
  // chrome
  openArtifact(type: 'url' | 'path', value: string): void
  acceptRouteOffer(newTaskId: string): Promise<boolean> | boolean
  getDoorbell(): boolean
  setDoorbell(on: boolean): void
  getLastSeen(): number
  setLastSeen(ms: number): void
  /** Persist a size chosen on the native expanded surface. */
  setSurfaceFill?(fill: number): void
  // scratchpad — each maps 1:1 onto the SAME internals the scratchpad:* IPC
  // handlers call. Optional so a host that does not wire the pad simply never
  // sees these events, exactly like `opened`.
  //
  // THERE IS NO SEND HERE. Arming is a mode switch and nothing else; the pad's
  // own footer owns deliver and discard. A toggle reads as reversible, so
  // toggle-off-to-send would turn "never mind" into a dispatched task.
  scratchpadArm?(on: boolean): void
  scratchpadRemove?(id: string): void
  scratchpadDeliver?(dest: 'cursor' | 'newTask' | 'openTask'): void
  /** Read a task's chat view from the agent's own source, whatever its state —
   *  see the call in sendDetail. */
  loadBlocks?(taskId: string, retry?: boolean): Promise<void>
  scratchpadDiscard?(): void
}

export interface NotchClientLike {
  send(cmd: NotchCommand): void
  on(event: string, cb: (e: NotchEvent) => void): unknown
}

/**
 * your-move classification, on STATE ALONE; null ⇒ never your move.
 *
 * `ready` is gone from here because it is gone from the state model — a finish
 * is a finish, and whether it wants you depends on what the task IS, which a
 * state cannot tell you. That question now needs the task, so it lives on the
 * controller (`demanding()`), where the presence clock and `kind` are in reach.
 * This stays for the two places that only ever had a state to look at.
 */
export function classify(state: TaskStatusName): 'needs-user' | 'stuck' | 'errored' | null {
  switch (state) {
    case 'needs-user': return 'needs-user'
    case 'stuck': return 'stuck'
    case 'failed': return 'errored'
    default: return null
  }
}

function truncate(s: string, n = 48): string {
  return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + '…'
}

/**
 * The ONE LINE beside the title: what is going on, not what is being asked.
 *
 * `activity` used to be `question.text` outright. That is fine while the text is
 * one short question, and it is what the field was written for — but the same
 * string is also the question card's BODY, and the surface draws the headline
 * with no line limit. So the day the card started carrying the whole ask, the
 * ask printed twice: once as a twelve-line "headline" above the user's own
 * message, once in the card below it. One field cannot be a headline and a
 * document at the same time.
 *
 * The split: when the question is `terminal_only` the CARD owns the ask, so the
 * headline falls back to `step` — a short state line ("2 questions waiting").
 * Every other kind keeps the question, because those cards are one line plus
 * chips and the headline is the natural place for it.
 */
export function headlineFor(t: TaskLite): string | undefined {
  const q = t.question
  if (q && q.kind === 'terminal_only') return t.step ?? 'waiting for you in the terminal'
  // WHAT IT IS DOING BEATS THE WORD "WORKING", but only while it IS doing it.
  //
  // Ordered above `step` and below the result for the same reason the comment
  // below gives: a live activity is the best sentence for a running task, and
  // the worst one for a finished task. `codexActivity` is cleared the instant
  // the work stops (applyHubPatch), so this cannot outlive its truth — and it
  // is checked against the state anyway, because one stale field should not be
  // able to make a done card claim it is still running a command.
  if (t.state === 'processing' && t.codexActivity) {
    const said = describeActivity(t.codexActivity)
    if (said) return said
  }
  // RESULT BEFORE STEP. `step` used to win, so a finished task described what it
  // had been doing rather than what it produced — "working on…" printed beside a
  // badge reading done. TaskManager now clears `step` on a terminal transition
  // too, but the ordering matters independently: once there is a result, the
  // result IS the headline, and a leftover step is never the better sentence.
  return q?.text ?? t.error?.reason ?? t.result?.summary ?? t.step ?? undefined
}

export function relativeAge(ts: number | undefined, now = Date.now()): string {
  if (!ts) return ''
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

/** Leave and come straight back and you did not mean to leave — a ⌘-Tab to
 *  check the link the task just gave you should not cost you the panel. */
const RETURN_GRACE_MS = 4000
/**
 * HOW LONG AN OPEN POCKET STAYS UP WITH NOTHING TOUCHING IT.
 *
 * Not to be confused with POCKET_IDLE_MS below, which is about MEMBERSHIP — how
 * long an untouched task keeps its place in the pocket at all. This one is
 * about the CARD: whether it is currently on your screen.
 *
 * The pocket used to be sticky: opened once, open until closed by hand. That is
 * right for the card itself — it is small, it is at the top edge, and it costs
 * nothing to leave there — but it is wrong for what an open pocket MEANS. An
 * open pocket is the voice's address (see applyVoiceTarget): every word you say
 * goes to the card instead of the router. That address going stale is the whole
 * reason this clock exists. It is not tidying, it is aim.
 *
 * Twenty seconds, and it is short on purpose. The clock only ever runs on DEAD
 * time: opening arms it, every gesture on the surface re-arms it (see the `on`
 * wrapper), a live microphone suspends it outright, and a task that newly needs
 * you re-arms it. So the question it answers is not "how long does a glance
 * take" — nothing in the glance spends it — but "how long a silence means you
 * have gone", and the honest answer to that is short. Past a couple of minutes
 * it stops being different from sticky and the stale aim survives the context
 * switch it was meant to lose.
 *
 * WHAT IT COSTS, stated plainly: a pause of more than twenty seconds between
 * opening the card and doing anything about it drops the aim, and the words you
 * then speak go to the router. Speaking itself is safe — the capture suspends
 * the clock — so this is only the gap BEFORE you start, and the way back is one
 * chord. That trade was made deliberately: a card that overstays is the failure
 * that is silent, and a card that leaves early is the failure you can see.
 *
 * Spent on the WALL clock, not `Presence.awakeMs()`, and that is deliberate —
 * it is the one window here that is not about giving you a chance to see
 * something. Time away makes an aim MORE stale, not less: come back from lunch,
 * speak, and the words must go to the router, not to the card you opened before
 * you left. Demand windows are the opposite and correctly use presence.
 *
 * ONLY EVER THE POCKET. Nothing else on this surface is on a clock of its own:
 * the expanded task and the cockpit are surfaces the user opened and stay until
 * they close them. `stirPocket` no-ops when the pocket is shut, and the timer is
 * armed in one place — `setPocketMode('open')` — so there is no state it can
 * reach into.
 *
 * NOTHING IS LOST WHEN IT FIRES. A task that needs you is still saying so on
 * the bar, the pocket still holds it, and one chord (right ⌘ then right ⌥) or a
 * click on the notch brings the card straight back.
 */
export const POCKET_OPEN_IDLE_MS = 20_000
const FADE_DONE_MS = 15 * 60 * 1000       // done fades from the wall after 15m
const FADE_ERR_MS = 60 * 60 * 1000        // errored/stuck after 60m
const AWAY_MS = 30 * 60 * 1000            // digest threshold
const PROMOTED_BADGE_MS = 8 * 1000        // "↑ now a session" narration window
/**
 * HOW LONG SOMETHING KEEPS SHOUTING — measured in YOUR time, not the day's.
 *
 * One number where there used to be three that disagreed (a 70m crank cutoff, a
 * 3h error cutoff, and TaskManager's 1h ready-decay, which between them meant a
 * checkpoint could leave the crank while the wall still called it ready).
 *
 * Two hours covers a lunch and does not survive a working day. Critically it is
 * spent against `Presence.awakeMs()`, so being away costs nothing: the window
 * exists to give you a CHANCE TO SEE the thing, and time at lunch is not a
 * chance. Burn it on wall-clock and four hours out means five finished threads
 * age out unseen and you come back to a clean badge — the exact failure the
 * whole tier system exists to prevent.
 *
 * Nothing expires OFF the notch on this timer. It only steps down from
 * "demanding" to "reachable" — see crankSlots().
 */
const DEMAND_WINDOW_MS = 2 * 60 * 60 * 1000

/** The reach list: today's work, whatever state it is in. Bounded on purpose.
 *
 *  The crank earns its keep by being short enough to EXHAUST — that is the
 *  whole reason the seam means anything. An unbounded reach list is just the
 *  dashboard operated one card at a time, which is strictly worse than the
 *  dashboard. Past these bounds is a dashboard question. */
/** How many tasks the pocket keeps beyond the ones demanding you.
 *
 *  COUNT, not time, is the real bound. The pocket is what is at hand — your
 *  desk, not your week — and a carousel you cannot exhaust is a dashboard you
 *  operate one card at a time. Age is only a backstop so a quiet day does not
 *  leave yesterday lying around. */
/** The dashboard's Today window. */
const TODAY_MS = 24 * 60 * 60 * 1000

/* The pocket is not capped. It was 8, which silently dropped the ninth thing
 * you were working on off your own desk — and the cost of that is exactly the
 * cost this product exists to remove: work you have to remember you had. What
 * makes a long pocket usable is ORDER, not a ceiling; `byAddressed` puts what
 * you touched last at the front, and POCKET_IDLE_MS still ages out anything
 * untouched for half a day. */
const POCKET_IDLE_MS = 12 * 60 * 60 * 1000

/**
 * HOW MANY TASKS A RESUME OR FORK MAY LAND BESIDE.
 *
 * Not a cap on the pocket as a whole — see above for why that was removed. It
 * is enforced only at the one moment something is PUT into the pocket on your
 * behalf rather than by your own hand: a session the Agent (or anything else)
 * reopened or forked. Past this, the card you touched longest ago that is not
 * waiting on you leaves the pocket to make room. Leaves, not deleted: it keeps
 * running, stays in the orchestrator, and comes back by itself when it needs you.
 */
export const POCKET_LANDING_CAP = 8

/** How long a SETTLED card stays on the wall before folding into "show all".
 *  48h, not 24: a one-day cutoff hides Friday's work on Monday morning, which
 *  is exactly when you want it. */
const STALE_CARD_MS = 48 * 60 * 60 * 1000

/**
 * States that are never folded away, at any age — work that is genuinely
 * waiting on you or still running.
 *
 * `ready` is deliberately NOT here, though classify() counts it as attention.
 * A `ready` task from two weeks ago is a finished step, not something waiting;
 * the crank has its own decay for it, and exempting it here meant a group of
 * stale `ready` cards never folded at all while its neighbours vanished
 * entirely — the wall showed 15-day-old work and hid last week's.
 */
const UNFOLDABLE = new Set<TaskStatusName>(['needs-user', 'stuck', 'failed', 'processing'])

type Engaged = 'none' | 'task' | 'cockpit'

export class NotchController {
  private queue: string[] = []
  private historyLimit = 10
  private historyTask: string | null = null
  private engaged: Engaged = 'none'
  /** AUTO-EXPAND: open the task surface when something starts needing you,
   *  instead of only tinting the bar amber and waiting to be tapped.
   *  Default ON — a surface that goes quiet-amber and waits is easy to walk
   *  past, and the whole point of the notch is that you should not have to
   *  remember to look. Off restores tap-to-open. */
  private autoExpand = true
  private focusedId: string | null = null
  /** One-off "clear finished" sweep cutoff. */
  private clearedAt = 0
  private digestDismissed = false
  private digestText: string | null = null
  /** Terminals the helper currently has open (stream targets). */
  private openTerms = new Set<string>()
  /** The task whose composer currently holds first responder, or null. Set from
   *  the notch's composerFocus event; read by the capture path so a dictated
   *  image can be handed to that composer rather than posted at it as a ⌘V. */
  private focusedComposerId: string | null = null

  /** The composer Unmute's own dictation should deliver images into. */
  focusedComposerTaskId(): string | null { return this.focusedComposerId }

  /** Single writer for the focused-composer flag. Every path that could end a
   *  composer's claim on the caret folds through here, so the policy lives in
   *  one tested table (composerFocus.ts) rather than in scattered assignments —
   *  which is how the clear went missing in the first place. */
  private applyComposerFocus(e: ComposerFocusEvent): void {
    const next = nextFocusedComposer(this.focusedComposerId, e)
    if (next === this.focusedComposerId) return
    this.focusedComposerId = next
  }
  /** oneoff→session graduation narration (id → badge deadline). */
  private promotedUntil = new Map<string, number>()
  private kindSeen = new Map<string, string>()
  private routeOffer: { newTaskId: string; altTaskId: string; altName: string } | null = null
  /** Attention acknowledgment: id → the state the user dismissed. The task
   *  remains unresolved and reachable; only this unchanged attention episode
   *  is quiet. Interaction or a real state change clears it. */
  private attentionAcknowledged = new Map<string, TaskStatusName>()
  // Rails cache (skills/projects/proposals) — refreshed on cockpit open + 5min.
  private skills: SkillItemP[] = []
  private projects: Array<{ name: string; path: string }> = []
  private creatingChat = false
  private proposals: ProposalLite[] = []
  /** The import rail. Cached like the other rails: it hits the filesystem, and
   *  reconcile runs on every task event. */
  private importable: Array<{ sessionId: string; title: string; project: string; lastActivityAt: number; agent?: string }> = []
  private railsTimer: ReturnType<typeof setInterval> | null = null
  /** (surface, task) → last payload sent, so an unchanged detail is not resent. */
  private lastDetailJson = new Map<string, { id: string; json: string }>()
  /**
   * Which groups are expanded, by name (''  = the ungrouped bucket).
   *
   * Was a single boolean, so a button rendered INSIDE a group header expanded
   * every group on the wall — and once on, every `hidden` count went to zero,
   * the per-group buttons vanished, and there was no way to collapse one again.
   * A control in a group header must act on that group.
   */
  private expandedGroups = new Set<string>()
  /** The wall's card order, held while the dashboard is open. See heldWallOrder. */
  private wallOrder: string[] | null = null
  /** Dashboard "Today" filter. Off by default — the wall's default answer to
   *  "what is going on" is still everything it would otherwise show. */
  private todayOnly = false
  private reconcileTimer: ReturnType<typeof setTimeout> | null = null
  private demandTimer: ReturnType<typeof setInterval> | null = null
  /** Running only while the pocket is open and nothing has touched it. */
  private pocketIdleTimer: ReturnType<typeof setTimeout> | null = null
  /** id → the last `demanding()` answer we rendered, so the tick can notice a
   *  window closing without re-rendering the world every minute. */
  private demandSeen = new Map<string, boolean>()

  // ── The crank / the pocket ────────────────────────────────────────────────
  //
  // These used to be two lists. The pocket held "things you set aside" and the
  // queue held "things demanding you", each with its own membership rule — and
  // the pocket's rule (demanding only) was really the AUTO-FILL rule wearing
  // the costume of a capacity limit. A task earns a place here by YOU AIMING AT
  // IT, not by its state; what its state decides is only whether it arrives
  // there on its own. So there is one sequence now, `crankSlots()`, and the
  // pocket is a window onto it.
  private pocketMode: PocketMode = 'closed'
  /** Index into `pocketSlots()`. Whatever sits here is the voice's address. */
  private pocketIndex = 0
  /**
   * THE POCKET IS ANCHORED ON A CARD, NOT A POSITION.
   *
   * The slots re-sort under the index — the Agent jumps to the front when it
   * answers, a new or re-addressed task sorts first — and a bare index then
   * points at a different card than the one the person was looking at (and
   * speaking to). `anchorPocket()` re-finds this id before every read, so only
   * an explicit move (the setter below) or the card going away moves the pocket.
   */
  private pocketAnchor: string | null = null
  private get pocketAt(): number { return this.pocketIndex }
  /** An EXPLICIT move. The anchor re-forms on whatever sits at the new index. */
  private set pocketAt(i: number) { this.pocketIndex = i; this.pocketAnchor = null }
  /** WHEN YOU LAST TALKED TO IT — your clock, not the agent's.
   *
   *  This is what orders the pocket. `updatedAt` cannot: it is stamped by a
   *  message sent OR RECEIVED, so a task chattering away in the background
   *  climbed to card 1 ahead of the one you were mid-sentence with, and the
   *  order looked random because the thing reordering it was invisible. Here
   *  only YOUR moves are recorded — you answered it, sent to it, chose from it,
   *  typed at it, spoke to it, or opened it — so nothing an agent does on its
   *  own can move a card.
   *
   *  IN MEMORY ONLY. A task with no stamp falls back to `createdAt`, which is
   *  itself the first time you addressed it (dispatch), and which never moves.
   *  So after a restart the pocket is newest-dispatch-first and still stable —
   *  it can be wrong about the order, never restless in it. */
  private addressedStamp = new Map<string, number>()

  // ── The Agent, which is an ELEMENT of the pocket and not a task in it ──────
  //
  // The pocket holds kinds of thing. Tasks are one kind and keep their queue
  // and their ordering exactly as they were. The Agent is a second kind: always
  // present (even with no tasks at all), never sorted against them, and holding
  // one of exactly two positions relative to the whole task block.
  //
  //     it has something for you   ->  in front of everything
  //     you have read it           ->  behind everything
  //
  // Two positions, not a rank. Which is why none of the queue's machinery —
  // demanding(), the frozen order, the user's clock — needs an exception for
  // it: the Agent never enters any of them.
  /** The concise line its card shows, and the full chat behind that card. */
  private agentLine: { text: string; at: number; failed: boolean } | null = null
  /** The whole conversation, as chat blocks, for the expanded card. */
  private agentBlocks: Block[] = []
  /** Messages in the Agent's current provider session; 0 when there is no earlier one to hide. */
  private agentSessionMessages = 0
  /** The conversation's own blocks; `agentBlocks` is these with routine runs
   *  merged in by time (rebuildAgentBlocks). */
  private agentBaseBlocks: Block[] = []
  /** When the last real Agent answer landed — kept apart from `agentLine`,
   *  which a speaking routine can also set. */
  private agentAnswerAt?: number
  private agentRoutineLine: { text: string; at: number; failed: boolean } | null = null
  private agentChatStartedAt = 0
  private routinesView: RoutinesView | null = null
  /** Full result text per run id, read once from the run's result file. */
  private routineResults = new Map<string, string>()
  private routineResultFetches = new Set<string>()
  /** The open run sheet: which run, and what was last fetched for it. */
  private routineDetailRunId: string | null = null
  private routineRunDetail: { run: RoutineRun; result: string | null; hasTranscript: boolean } | null = null
  private routineDetailFetching = false
  private routineDetailStale = false
  /** Run id → endedAt already accounted for. Null until the first view seeds it. */
  private seenRoutineEnds: Map<string, number> | null = null
  /** True while it is thinking, so the card can say so. */
  private agentBusy = false
  /** UNREAD IS THE WHOLE RULE. Set when it answers, cleared the moment the user
   *  has actually seen the answer — which is opening the card, not passing it. */
  private agentUnread = false
  /** The chat is the expanded surface right now. */
  private agentOpen = false
  /** What is typed into the chat's composer and not yet sent. */
  private agentDraft = ''
  private agentDraftRevision = 0
  private agentProvider?: 'claude' | 'codex'
  private agentSelectedProvider: 'claude' | 'codex' = 'claude'
  private agentPendingProvider?: 'claude' | 'codex'
  /** Unknown until the first probe answers; nothing is offered before then. */
  private agentInstalled: Array<'claude' | 'codex'> = []
  private agentInstalledProbe?: Promise<void>
  private agentModel?: string
  private agentError?: string
  private agentCanRetry = false
  private agentEnqueue: { revision: number; submissionId: string } | null = null
  /** The pocket's order, nailed down for the duration of a visit. Null when
   *  the pocket is closed, so the next open re-sorts to what you last worked in. */
  private frozenOrder: string[] | null = null
  private frozenInputTimes = new Map<string, number>()
  /** Set while an expanded task came FROM an open pocket, so closing it goes
   *  back there rather than dumping you onto the bare notch. */
  private cameFromPocket = false
  /** The card a resume or fork last put in the pocket, while the pocket could
   *  not be aimed at it (shut, or something expanded). The next visit to the
   *  pocket lands on it instead of card 1. See landInPocket. */
  private landing: string | null = null
  /** id → presence-clock ms at which it began demanding. See demandSince(). */
  private demandStamp = new Map<string, number>()
  /** When a task entered `processing`, to tell a real turn from a blip. */
  private processingSince = new Map<string, number>()
  /** A task whose auto-expand was held back because a capture was recording.
   *  Applied (if it still needs you, and nothing else is open) once it ends. */
  private deferredExpand: string | null = null
  /** Polls the (cheap) capture flag only while something is being held back. */
  private captureWait: ReturnType<typeof setInterval> | null = null
  /** A leave (blur/space/screenshot) held back for the same reason. */
  private deferredLeave: 'blur' | 'screenshot' | 'space' | null = null
  /** id → the state we last stamped for, so a change restarts the window. */
  private stateSeen = new Map<string, TaskStatusName>()
  /** Set when leaving collapsed an expanded task; a return inside this window
   *  re-opens it, because you did not mean to leave. */
  private returnGraceUntil = 0
  /** What the last leave collapsed, so a quick return restores THAT rather
   *  than guessing. Null once used or expired. */
  private returnTo: { kind: 'task'; id: string } | { kind: 'cockpit' } | null = null
  private lastPocketJson = ''
  private lastWaiting = 0

  constructor(
    private client: NotchClientLike,
    events: EventEmitter,
    private deps: NotchControllerDeps,
    /** Are you here, and how much of YOUR time has passed. Defaults to
     *  always-present so tests and any headless path need no power monitor. */
    private presence: PresenceLike = ALWAYS_PRESENT,
  ) {
    // Returning is a refresh point, never permission to take the screen.
    // Presence still protects demand windows while the user is away, but the
    // presentation policy is independent: a backlog may light the compact
    // attention surface and waits for an explicit tap before expanding.
    presence.on('wake', () => this.onWake())

    // THE PREDICATE NEEDS A CLOCK TO TICK AGAINST.
    //
    // `demanding()` depends on elapsed presence time, but reconcile only ran on
    // task and helper events — so a task stopped shouting whenever something
    // UNRELATED happened to trigger a render, which from the outside looks like
    // the surface being slow and stale. The old decay timers did this job by
    // accident; deleting them without replacing the tick was the mistake.
    // A minute is far finer than a two-hour window needs and costs nothing.
    this.demandTimer = setInterval(() => {
      if (this.deps.listTasks().some((t) => this.demandingChanged(t))) this.scheduleReconcile()
    }, 60_000)
    this.demandTimer.unref?.()
    // Task runtime → queue + payload refresh (debounced).
    const onT = (t: TaskLite) => this.onTransition(t)
    events.on('created', onT)
    events.on('needs-user', onT)
    events.on('failed', onT)
    events.on('stuck', onT)
    events.on('updated', onT)
    // `done` USED TO DEQUEUE UNCONDITIONALLY, and that single line is most of
    // what this change is about: finishing removed a task from the surface, so
    // a thread handing the ball back to you looked identical to an errand
    // ending. It goes through the same transition as everything else now, and
    // `demanding()` decides — thread finishes, it waits for you; errand
    // finishes, it quietly joins today.
    events.on('done', onT)
    events.on('removed', (t: { id: string }) => {
      this.answerStates.delete(t.id)
      this.dequeue(t.id)
      this.demandStamp.delete(t.id)
      this.processingSince.delete(t.id)
      this.stateSeen.delete(t.id); this.demandSeen.delete(t.id)
      this.scheduleReconcile()
    })
    // Live PTY output → any open helper terminal.
    events.on('output', (d: { taskId: string; chunk: string }) => {
      if (this.openTerms.has(d.taskId)) {
        this.client.send({ type: 'termData', id: d.taskId, data: Buffer.from(d.chunk, 'utf8').toString('base64') })
      }
    })

    // Helper events → runtime. Every handler calls the SAME internals the old
    // IPC handlers call (via deps).
    const on = (type: string, fn: (e: NotchEvent) => void) => this.client.on(type, (e) => {
      // EVERY GESTURE ON THIS SURFACE COUNTS AS TOUCHING AN OPEN POCKET.
      //
      // Deliberately here rather than on a hand-picked list of pocket events.
      // The card is reachable while the bar, the pill and the composer are all
      // live, and someone working any of them has plainly not wandered off —
      // a list would have to be kept in step with every new control forever,
      // and the first one forgotten is a card that vanishes mid-use.
      //
      // `userLeft` is the single exclusion: going to another application is the
      // opposite of acting here, so it must not buy the pocket more time.
      if (type !== 'userLeft') this.stirPocket()
      fn(e)
    })
    on('agentSend', e => {
      const event = e as { submissionId: string; revision: number }
      this.sendAgentDraft(event.submissionId, event.revision)
    })
    on('agentRetry', () => { void this.deps.agentRetry?.().catch(error => this.agentUnavailable((error as Error).message)) })
    on('agentStop', () => { void this.deps.agentStop?.().catch(error => this.agentUnavailable((error as Error).message)) })
    on('agentSwitchProvider', e => {
      const provider = (e as { provider?: unknown }).provider
      if (provider !== 'claude' && provider !== 'codex') return
      if (!this.agentInstalled.includes(provider)) return
      void this.deps.agentSwitchProvider?.(provider).catch(error => this.agentUnavailable((error as Error).message))
    })
    on('agentSetModel', e => {
      const { provider, model } = e as { provider?: unknown; model?: unknown }
      if (provider !== 'claude' && provider !== 'codex') return
      if (typeof model !== 'string' || !model || !this.agentInstalled.includes(provider)) return
      void this.deps.agentSetModel?.(provider, model).catch(error => this.agentUnavailable((error as Error).message))
    })
    on('agentNewConversation', () => { void this.deps.agentNewConversation?.().catch(error => this.agentUnavailable((error as Error).message)) })
    const routineAction = (action: Parameters<NonNullable<NotchControllerDeps['routineAction']>>[0]) => {
      this.agentError = undefined
      if (this.agentOpen) this.sendAgentDetail()
      if (!this.deps.routineAction) { this.agentUnavailable('Routines are unavailable'); return }
      return this.deps.routineAction(action).catch(error => this.agentUnavailable((error as Error).message))
    }
    on('routineRunNow', e => { void routineAction({ type: 'runNow', id: (e as { id: string }).id }) })
    on('routineSetEnabled', e => {
      const { id, enabled } = e as { id: string; enabled: boolean }
      void routineAction({ type: 'setEnabled', id, enabled })
    })
    on('routineUpdate', e => {
      const { id, fields } = e as { id: string; fields: RoutineEditorFields }
      void routineAction({ type: 'update', id, fields })
    })
    on('routineCreate', e => { void routineAction({ type: 'create', fields: (e as { fields: RoutineEditorFields }).fields }) })
    on('routineDuplicate', e => { void routineAction({ type: 'duplicate', id: (e as { id: string }).id }) })
    on('routineRemove', e => { void routineAction({ type: 'remove', id: (e as { id: string }).id }) })
    on('routineRefreshContext', () => { void routineAction({ type: 'refreshContext' }) })
    on('routineCancel', e => {
      const runId = (e as { runId: string }).runId
      // Only a cancel that landed changes the run worth re-reading.
      void this.deps.routineAction?.({ type: 'cancel', runId }).then(
        () => { if (this.routineDetailRunId === runId) this.fetchRoutineDetail(runId) },
        error => this.agentUnavailable((error as Error).message))
    })
    on('routineOpenTranscript', e => { void routineAction({ type: 'openTranscript', runId: (e as { runId: string }).runId }) })
    on('routineProposal', e => {
      const { runId, proposalId, decision } = e as { runId: string; proposalId: string; decision: 'approve' | 'dismiss' }
      void routineAction({ type: 'proposal', runId, proposalId, decision })
    })
    on('routineOpenRun', e => {
      const runId = (e as { runId: string }).runId
      this.routineDetailRunId = runId
      this.routineRunDetail = null
      this.fetchRoutineDetail(runId)
    })
    on('routineCloseRun', () => {
      this.routineDetailRunId = null
      this.routineRunDetail = null
      if (this.agentOpen) this.sendAgentDetail()
    })
    on('surfaceFillChanged', e => {
      const fill = (e as { fill: number }).fill
      if (Number.isFinite(fill)) this.deps.setSurfaceFill?.(fill)
    })
    on('pocketFocusTask', (e) => {
      const id = (e as { id: string }).id
      emitOnboardingReceipt({ type: 'task-link-opened', taskId: id })
      this.onPocketFocusTask(id)
    })
    on('tap', () => this.onTap())
    on('collapsed', () => {
      // THE HOLD DIES WITH THE CARD. Whether or not they pressed it again, a
      // mute placed on a surface that is no longer on screen is one they can
      // no longer undo — so closing settles it, exactly as quitting does.
      this.deps.releaseBackgroundAudio?.()
      this.seenThenClose({ collapse: true })
    })
    on('openDashboard', () => this.openCockpit())
    on('next', () => this.onNext())
    on('prev', () => this.onPrev())
    on('editLatestMessage', (e) => {
      const { id, expected, text } = e as { id: string; expected: string; text: string }
      if (typeof expected !== 'string' || typeof text !== 'string') return
      if (!this.deps.canEditLatestMessage?.(id)) { this.client.send({ type: 'messageEditStatus', id, accepted: false, error: 'The conversation changed. Wait for it to finish and reopen the latest message.' }); return }
      void this.deps.editLatestMessage?.(id, expected, text).then(ok => {
        if (ok) { this.addressed(id); this.client.send({ type: 'messageEditStatus', id, accepted: true }) }
        else this.client.send({ type: 'messageEditStatus', id, accepted: false, error: 'This message cannot be edited right now.' })
        this.scheduleReconcile()
      }).catch(error => { this.client.send({ type: 'messageEditStatus', id, accepted: false, error: (error as Error).message }); this.scheduleReconcile() })
    })
    on('loadOlderMessages', (e) => {
      const { id } = e as { id: string }
      if (id !== this.historyTask || (id !== this.focusedId && !(id === NotchController.AGENT_SLOT && this.agentOpen))) return
      this.historyLimit += 10
      const task = this.deps.getTask(id)
      // A REATTACHED TAIL IS `ready` AND INCOMPLETE. Gating on the phase alone
      // widened the page over a one-turn array and fetched nothing, so the card
      // could never get past the last reply it happened to be holding.
      if (task && (task.history?.phase !== 'ready' || !task.blocksDurable)) {
        // Enlarging a failed/partial cache cannot fetch its missing messages.
        // Read history independently of acquiring a provider writer.
        void this.deps.loadBlocks?.(id, true).catch(() => {}).finally(() => this.scheduleReconcile())
      }
      this.reconcile()
    })
    on('focusTask', (e) => { this.onFocusTask((e as { id: string }).id) })
    on('closeStage', () => { this.seenThenClose() })
    on('userLeft', (e) => this.onUserLeft((e as { reason: 'blur' | 'screenshot' | 'space' }).reason))
    on('userReturned', () => this.onUserReturned())
    on('pocketMove', (e) => this.onPocketMove(e as { delta?: number; to?: number }))
    on('pocketOpen', () => { this.pocketAt = this.freshVisitAt(); this.setPocketMode('open'); this.reconcile() })
    // THE HANDLING IS THE STIR. `on` re-arms the idle clock for every event
    // from the surface, and a pointer resting on the card has nothing else to
    // say — so this registration exists purely to let hover through that door.
    on('pocketHover', () => {})
    on('pocketRelease', () => {
      // CLOSING THE POCKET RELEASES ITS ORDER — the next open re-sorts to
      // whatever has actually moved since. Expanding a card out of the pocket
      // does NOT come through here and deliberately keeps the order, so Escape
      // puts you back exactly where you were standing.
      this.frozenOrder = null
      // AND IT RELEASES THE VOICE TOO. Focus is not a highlight — it is a
      // deterministic short-circuit: `orchestrateFocusId` sends the next
      // utterance straight to that task and never consults the router. Leaving
      // it set behind a CLOSED pocket meant speaking a brand-new request into
      // whichever card you happened to be looking at when you shut it, with
      // nothing on screen to explain where the words went.
      //
      // Every other way out of the pocket already cleared it (see leavePocket).
      // This one could not: it clears the aim through setPocketMode ->
      // applyVoiceTarget, which EARLY-RETURNS while `engaged === 'task'`. Reach
      // the pocket by expanding a task and that guard holds, so the close left
      // the aim exactly where it was — which is why it happened only sometimes
      // and why the existing test (which opens the pocket directly) passed.
      //
      // Closing the pocket also ends the engagement. Leaving it set does not
      // just strand the aim: `engaged !== 'none'` is the guard on auto-expand,
      // so the next task that needed you would have opened nothing either.
      this.engaged = 'none'
      this.setFocus(null)
      this.setPocketMode('closed')
      this.reconcile()
    })
    on('pocketExpand', (e) => {
      this.onPocketExpand((e as { id?: string }).id)
    })
    on('importSession', (e) => void this.onImportSession((e as { sessionId: string }).sessionId))
    on('chooseOption', (e) => this.onChoose(e as { id: string; index: number }))
    on('reloadHistory', (e) => { const id = (e as { id: string }).id; if (this.deps.getTask(id)) void this.deps.loadBlocks?.(id, true).catch(() => {}) })
    on('mute', (e) => this.onMute((e as { id: string }).id))
    on('answerText', (e) => {
      const { id, text, reference } = e as { id: string; text: string; reference?: QuestionReference }
      // Advancing the crank is only right when this WAS the blocking question.
      // The Codex composer is always available, so a plain reply must not fling
      // the user onto whatever unrelated task happens to be queued next.
      //
      // Queue membership is NOT the test: a `ready` task sits in the crank too
      // (it is "your move"), so keying on it advanced away from a Codex chat the
      // user was mid-conversation with. Only `needs-user` is a question.
      const wasBlocking = this.deps.getTask(id)?.state === 'needs-user'
      // A REFUSED ANSWER IS NOT AN ANSWER. When a picker we cannot drive is
      // open, `answer` sends nothing and the task stays blocked — cranking to
      // the next task there would carry the user away from the very question
      // they still have to go answer, and away from the card explaining why.
      this.submitAnswer(id, text, wasBlocking, reference)
    })
    on('setDraftText', (e) => {
      const draft = e as { id: string; text: string }
      // THE AGENT'S DRAFT IS THE CONTROLLER'S, not the task runtime's. Handing
      // a draft store keyed by task id something that is not a task is how a
      // surface ends up writing into a record nothing owns.
      if (draft.id === NotchController.AGENT_SLOT) {
        const revision = (e as { clientRevision?: number }).clientRevision ?? this.agentDraftRevision + 1
        if (revision < this.agentDraftRevision) return
        this.agentDraft = draft.text; this.agentDraftRevision = revision
        void this.deps.agentDraftChanged?.(draft.text, revision).catch(error => this.agentUnavailable((error as Error).message))
        this.scheduleReconcile()
        return
      }
      const { id, text, clientRevision } = e as { id: string; text: string; clientRevision?: number }
      devEvent(log, 'task-reply-ui-event', { taskId: id, event: 'setDraftText', textChars: text.length })
      this.deps.setDraftText?.(id, text, clientRevision)
      this.scheduleReconcile()
    })
    on('setDraftTool', (e) => {
      const { id, tool } = e as { id: string; tool: string | null }
      // THE AGENT SLOT HAS NO DRAFT STORE. Same rule as setDraftText above: the
      // Agent is not a task, and its composer is the controller's own. Rather
      // than write into a record nothing owns, the tool is simply not offered
      // there — the picker is absent, so this branch is a guard against a
      // stale surface, not a path anyone takes.
      if (id === NotchController.AGENT_SLOT) return
      devEvent(log, 'task-reply-ui-event', { taskId: id, event: 'setDraftTool', tool })
      this.deps.setDraftTool?.(id, tool)
      this.scheduleReconcile()
    })
    on('reserveDraftAttachment', (e) => {
      const { id, operationId, name, ...insertion } = e as { id: string; operationId: string; name: string } & DraftInsertionP
      this.deps.reserveDraftAttachment?.(id, operationId, name, { ...insertion, operationId })
      this.scheduleReconcile()
    })
    on('failDraftAttachment', (e) => {
      const { id, operationId, error } = e as { id: string; operationId: string; error: string }
      this.deps.failDraftAttachment?.(id, operationId, error)
      this.scheduleReconcile()
    })
    on('addDraftImage', (e) => {
      const { id, path, mimeType, name, ...insertion } = e as { id: string; path: string; mimeType: string; name: string } & DraftInsertionP
      devEvent(log, 'task-reply-ui-event', { taskId: id, event: 'addDraftImage', path, mimeType, name })
      void Promise.resolve(this.deps.addDraftImage?.(id, path, mimeType, name, insertion))
        .catch(error => {
          const message = error instanceof Error ? error.message : String(error)
          if (insertion.operationId) this.client.send({ type: 'draftAttachmentError', id, operationId: insertion.operationId, error: message })
          this.toast(`Could not attach file: ${message}`)
        })
        .finally(() => this.scheduleReconcile())
      this.scheduleReconcile()
    })
    on('configureChat', (e) => {
      const { id, change } = e as { id: string; change: ChatConfigChangeP }
      void Promise.resolve(this.deps.configureChat?.(id, change))
        .catch(error => this.toast(`Could not update chat settings: ${error instanceof Error ? error.message : String(error)}`))
        .finally(() => this.scheduleReconcile())
    })
    on('toggleDraftDictation', (e) => {
      const { id, insertion } = e as { id: string; insertion?: DraftInsertionP }
      this.deps.toggleDraftDictation?.(id, insertion)
      this.scheduleReconcile()
    })
    on('cancelDraftDictation', (e) => {
      this.deps.cancelDraftDictation?.((e as {id: string}).id)
      this.scheduleReconcile()
    })
    on('previewChat', (e) => {
      const { token, ...options } = e as Extract<NotchEvent, { type: 'previewChat' }>
      if (typeof token !== 'string') return
      void Promise.resolve().then(() => {
        if (!this.deps.previewChat) throw new Error('Project preview is unavailable')
        return this.deps.previewChat(options)
      }).then(preview => this.client.send({ type: 'newChatPreview', token, preview }))
        .catch(error => this.client.send({ type: 'newChatPreview', token, error: (error as Error).message }))
    })
    on('newChat', (e) => {
      if (this.creatingChat) return
      const {provider, cwd, allocationId, permission} = e as Extract<NotchEvent, {type: 'newChat'}>
      this.creatingChat = true
      this.client.send({type: 'newChatStatus', pending: true})
      void (async () => {
        try {
          if (!this.deps.createChat) throw new Error('New conversations are unavailable in this build.')
          if (!cwd && !allocationId) throw new Error('Preview the managed project location before creating the conversation.')
          const id = await this.deps.createChat({provider, cwd, allocationId, permission})
          this.onFocusTask(id)
          this.client.send({type: 'newChatStatus', pending: false})
        } catch (error) {
          this.client.send({type: 'newChatStatus', pending: false, error: error instanceof Error ? error.message : String(error)})
        } finally { this.creatingChat = false; this.scheduleReconcile() }
      })()
    })
    on('restoreDraftAttachment', (e) => {
      const { id, attachmentId } = e as { id: string; attachmentId: string }
      void Promise.resolve(this.deps.restoreDraftAttachment?.(id, attachmentId))
        .catch(error => this.toast(`Could not restore attachment: ${error instanceof Error ? error.message : String(error)}`))
        .finally(() => this.scheduleReconcile())
    })
    on('undoDraftAttachment', (e) => {
      const { id, attachmentId } = e as { id: string; attachmentId: string }
      void Promise.resolve(this.deps.undoDraftAttachment?.(id, attachmentId))
        .catch(error => this.toast(`Could not undo attachment: ${error instanceof Error ? error.message : String(error)}`))
        .finally(() => this.scheduleReconcile())
    })
    on('redoDraftAttachment', (e) => {
      const { id, attachmentId } = e as { id: string; attachmentId: string }
      void Promise.resolve(this.deps.redoDraftAttachment?.(id, attachmentId))
        .catch(error => this.toast(`Could not redo attachment: ${error instanceof Error ? error.message : String(error)}`))
        .finally(() => this.scheduleReconcile())
    })
    // WHICH TEXT BOX IS UNMUTE'S OWN, RIGHT NOW.
    //
    // Dictation delivers captured images by posting a synthetic ⌘V, and that
    // keystroke did not reach the notch: the text landed and the image did not.
    // Knowing the focused composer lets the capture path hand images straight
    // over instead of aiming a keystroke at a window that may not receive it.
    on('composerFocus', (e) => {
      const { id, focused } = e as unknown as { id: string; focused: boolean }
      this.applyComposerFocus(focused ? { kind: 'focus', taskId: id } : { kind: 'blur', taskId: id })
      devEvent(log, 'task-reply-ui-event', { taskId: id, event: 'composerFocus', focused })
    })
    // The blur AppKit will not send. resignFirstResponder fires only when focus
    // moves inside the same window, so clicking away to another app left the
    // flag set forever — and every dictated image after that went to a draft
    // nobody was looking at instead of the caret the user was typing at.
    on('windowUnfocused', () => {
      this.applyComposerFocus({ kind: 'window-unfocused' })
      devEvent(log, 'task-reply-ui-event', { event: 'windowUnfocused' })
    })
    on('removeDraftAttachment', (e) => {
      const { id, attachmentId } = e as { id: string; attachmentId: string }
      devEvent(log, 'task-reply-ui-event', { taskId: id, event: 'removeDraftAttachment', attachmentId })
      void Promise.resolve(this.deps.removeDraftAttachment?.(id, attachmentId)).then(() => this.scheduleReconcile())
    })
    on('sendDraft', (e) => {
      const { id, reference } = e as { id: string; reference?: QuestionReference }
      if (id === NotchController.AGENT_SLOT) {
        this.sendAgentDraft()
        return
      }
      if (reference && !this.acceptsReference(id, reference)) { this.rejectReference(id, reference); return }
      if (reference) this.answerStatus(id, reference, 'pending')
      devEvent(log, 'task-reply-ui-event', { taskId: id, event: 'sendDraft' })
      void Promise.resolve(this.deps.sendDraft?.(id, reference ?? null)).then((result) => {
        const accepted = result === true || !!result && typeof result === 'object' && result.kind === 'accepted'
        if (reference) this.answerStatus(id, reference, accepted ? 'accepted' : 'rejected')
        devEvent(log, 'task-reply-ui-event-result', { taskId: id, event: 'sendDraft', accepted, outcome: typeof result === 'object' ? result.kind : undefined })
        if (accepted) this.addressed(id)
        this.scheduleReconcile()
      }).catch(error => { if (reference) this.answerStatus(id, reference, 'rejected'); this.toast(`Could not send: ${(error as Error).message}`) })
    })
    for (const event of ['cancelTaskFollowup', 'restoreTaskFollowup', 'queueSavedTaskFollowup', 'recoverUncertainFollowup'] as const) on(event, e => {
      const { id, queueId } = e as { id: string; queueId: string }
      if (id === NotchController.AGENT_SLOT || !this.deps.getTask(id) || typeof queueId !== 'string') return
      const result = event === 'cancelTaskFollowup' ? this.deps.cancelTaskFollowup?.(id, queueId)
        : event === 'queueSavedTaskFollowup' ? this.deps.queueSavedTaskFollowup?.(id, queueId)
          : this.deps.restoreTaskFollowup?.(id, queueId, event === 'recoverUncertainFollowup')
      void Promise.resolve(result).then(ok => { if (!ok) this.toast('Follow-up unchanged. Keep or send your current draft before restoring; delivery may already have started.'); this.scheduleReconcile() })
    })
    on('kill', (e) => this.deps.kill((e as { id: string }).id))
    on('backgroundAudio', (e) => {
      if ((e as { muted: boolean }).muted) this.deps.holdBackgroundAudio?.()
      else this.deps.releaseBackgroundAudio?.()
    })
    // A RESUME THAT FAILS MUST SAY SO.
    //
    // This was fire-and-forget: the boolean went nowhere, and a resume that
    // could not proceed left the card exactly as it was. From the outside that
    // is a dead button — observed in the field as two presses ten seconds
    // apart, because nothing acknowledged the first. Whatever happens now, the
    // surface hears about it.
    on('resume', (e) => {
      const id = (e as { id: string }).id
      void Promise.resolve(this.deps.resume(id)).then((ok) => {
        if (ok) return
        log.event('resume-refused', { taskId: id })
        this.client.send({ type: 'toast', text: "Couldn't reach that session's folder — it may have moved or been deleted." })
      }).catch((err) => {
        log.warn('resume threw', { taskId: id, error: (err as Error).message })
        this.client.send({ type: 'toast', text: 'Could not resume that session.' })
      })
    })
    on('rerun', (e) => { const t = this.deps.getTask((e as { id: string }).id); if (t) this.deps.rerun(t.intent) })
    on('remove', (e) => void this.deps.remove((e as { id: string }).id))
    on('killAll', () => this.deps.killAll())
    on('setKind', (e) => { const { id, kind } = e as { id: string; kind: 'oneoff' | 'session' }; this.deps.setKind(id, kind); this.scheduleReconcile() })
    on('removeFromPocket', (e) => this.removeFromPocket((e as { id: string }).id))
    on('rename', (e) => { const { id, name } = e as { id: string; name: string }; this.deps.setName(id, name); this.scheduleReconcile() })
    on('setNote', (e) => { const { id, note } = e as { id: string; note: string }; this.deps.setNote(id, note); this.scheduleReconcile() })
    on('pinSkill', (e) => { const { name, pinned } = e as { name: string; pinned: boolean }; void this.onPinSkill(name, pinned) })
    on('tapSkill', (e) => { void this.onTapSkill((e as { name: string }).name) })
    on('openProject', (e) => { const { path, name } = e as { path: string; name: string }; this.deps.openProject(path, name) })
    on('clearFinished', () => { this.clearedAt = Date.now(); this.reconcile() })
    // Temporary, and deliberately not persisted: "show all" lasts as long as
    // this look at the cockpit, then the wall goes back to being about now.
    on('today', (e) => {
      this.todayOnly = (e as { on: boolean }).on
      // A FILTER WITH AN ESCAPE HATCH IS A FOLD. Turning Today OFF is the way
      // to see everything; leaving per-group "show all" live inside it would
      // let a group quietly put back exactly what the filter took out.
      if (this.todayOnly) this.expandedGroups.clear()
      this.wallOrder = null       // the filter changes what is here; re-sort it
      log.event('today-filter', { on: this.todayOnly })
      this.reconcile()
    })
    on('showAll', (e) => {
      const { group, on } = e as { group?: string; on?: boolean }
      // No group named ⇒ the wall-level control: everything, or nothing.
      if (group === undefined) {
        if (on) for (const g of this.allGroupNames()) this.expandedGroups.add(g)
        else this.expandedGroups.clear()
      } else if (on) this.expandedGroups.add(group)
      else this.expandedGroups.delete(group)
      this.reconcile()
    })
    on('digestDismiss', () => { this.digestDismissed = true; this.digestText = null; this.reconcile() })
    on('bellToggle', () => { this.deps.setDoorbell(!this.deps.getDoorbell()); this.reconcile() })
    on('offerAccept', (e) => void this.onOfferAccept((e as { newTaskId: string }).newTaskId))
    on('openArtifact', (e) => { const { artifactType, value } = e as { artifactType: 'url' | 'path'; value: string }; this.deps.openArtifact(artifactType, value) })
    on('openInTerminal', (e) => this.deps.openInTerminal((e as { id: string }).id))
    on('termOpen', (e) => this.onTermOpen((e as { id: string }).id))
    on('termClose', (e) => this.openTerms.delete((e as { id: string }).id))
    on('termInput', (e) => {
      const { id, data } = e as { id: string; data: string }
      const decoded = Buffer.from(data, 'base64').toString('utf8')
      const task = this.deps.getTask(id)
      devEvent(log, 'task-reply-terminal-input', {
        taskId: id,
        agent: task?.agent ?? null,
        model: task?.model ?? null,
        taskState: task?.state ?? null,
        bytes: Buffer.byteLength(decoded),
        chars: decoded.length,
        containsEnter: decoded.includes('\r') || decoded.includes('\n'),
        containsCtrlV: decoded.includes('\u0016'),
        transport: 'direct-pty-input',
      })
      this.deps.sendInput(id, decoded)
    })
    on('termResize', (e) => { const { id, cols, rows } = e as { id: string; cols: number; rows: number }; this.deps.resizeTerm(id, cols, rows) })
    on('suggestionOpen', (e) => void this.onSuggestionOpen((e as { id: string }).id))
    on('suggestionAccept', (e) => void this.onSuggestionAccept((e as { id: string }).id))
    on('suggestionReject', (e) => { const { id, reason } = e as { id: string; reason: string }; void this.onSuggestionReject(id, reason) })
    on('converseWrite', (e) => { const { id, text } = e as { id: string; text: string }; void this.onConverseWrite(id, text) })
    on('converseStop', (e) => { this.deps.converseStop((e as { id: string }).id); this.conversing.delete((e as { id: string }).id) })
    // The scratchpad. NO STATE LIVES HERE — every one of these is a straight
    // relay onto the same internals the scratchpad:* IPC handlers call, and the
    // resulting `scratchpad` push comes back through notifyScratchpad from the
    // one place that announces a pad change.
    on('scratchpadArm', (e) => this.deps.scratchpadArm?.((e as { on?: boolean }).on === true))
    on('scratchpadRemove', (e) => {
      const id = (e as { id?: string }).id
      if (id) this.deps.scratchpadRemove?.(id)
    })
    on('scratchpadDeliver', (e) => {
      const dest = (e as { dest?: string }).dest
      // An unrecognised destination is DROPPED, not defaulted. Defaulting would
      // let a malformed line send held work somewhere the user never chose.
      if (dest === 'cursor' || dest === 'newTask' || dest === 'openTask') this.deps.scratchpadDeliver?.(dest)
    })
    on('scratchpadDiscard', () => this.deps.scratchpadDiscard?.())

    // Seed the queue from whatever already exists (post-rehydrate).
    for (const t of this.deps.listTasks()) this.trackKind(t)
    this.rebuildQueue()
  }

  dispose(): void {
    if (this.railsTimer) clearInterval(this.railsTimer)
    if (this.reconcileTimer) clearTimeout(this.reconcileTimer)
    if (this.demandTimer) clearInterval(this.demandTimer)
    if (this.captureWait) clearInterval(this.captureWait)
    this.disarmPocketIdle()
  }

  // ── queue ──────────────────────────────────────────────────────────────────

  /**
   * DOES THIS WANT YOU RIGHT NOW? The one predicate the surface is built on.
   *
   * Computed, never stored — that is the point of it. A stored answer is a
   * decision frozen at the moment we know least, and it cannot be revisited
   * when the clock moves or you walk back in. This one is asked again on every
   * render and is free to change its mind.
   *
   *   blocked (needs-user / stuck)  always. A live question has exactly one
   *                                 exit — you answer it — so it never ages.
   *   failed                        for a window. You have seen it; it is not
   *                                 getting worse for being older.
   *   finished + THREAD             for a window. The agent's turn ending on a
   *                                 thread is the ball landing back in your
   *                                 court, and that is worth as much of your
   *                                 attention as a block.
   *   finished + ERRAND             never. The video is playing. Nothing is owed.
   *
   * That last pair is the whole fix. It used to be decided by whether the
   * agent's closing line ended in a question mark; it is now decided by what
   * the task IS, which is known at creation and never re-guessed.
   */
  /** A capture is recording. A plain boolean read — safe while the mic is hot. */
  private capturing(): boolean { return this.deps.isCapturing?.() === true }

  /** Something was held back for the capture; apply it once the capture ends.
   *  `notifyCapturePhase` checks immediately; the poll covers lanes (plain
   *  dictation) that never announce a phase. */
  private deferUntilCaptureEnds(): void {
    if (this.captureWait) return
    this.captureWait = setInterval(() => this.afterCapture(), 400)
    this.captureWait.unref?.()
  }

  private afterCapture(): void {
    if (!this.captureWait || this.capturing()) return
    clearInterval(this.captureWait)
    this.captureWait = null
    // SPEAKING TO THE CARD IS THE LOUDEST INTERACTION THERE IS, so an open
    // pocket gets its whole window back from the moment the utterance settles —
    // not from whenever the clock happened to be suspended.
    this.stirPocket()
    const leave = this.deferredLeave
    this.deferredLeave = null
    if (leave) { this.deferredExpand = null; this.onUserLeft(leave); return }
    const id = this.deferredExpand
    this.deferredExpand = null
    const t = id ? this.deps.getTask(id) : undefined
    if (t && this.autoExpand && this.engaged === 'none' && this.pocketMode !== 'open'
      && this.queue.includes(t.id) && this.demanding(t)) this.autoExpandTo(t, true)
    this.reconcile()
  }

  /** A card out of the pocket does not demand — until it newly needs you, at
   *  which point onTransition puts it back (returnsOnDemand) and this is true
   *  again with nothing special-cased. */
  private demanding(t: TaskLite): boolean {
    if (t.pocketRemoved) return false
    return this.wouldDemand(t)
  }

  /**
   * SHOULD A PENDING TRANSITION BRING A REMOVED CARD BACK? The same notion of
   * "needs you" the attention queue uses (wouldDemand), narrowed to what
   * actually asks something of the person: a question or approval (needs-user,
   * stuck) or a failure. A turn that simply FINISHED does not count, even on a
   * thread — quiet progress is exactly what removing the card asked not to see.
   * A failure you caused (Stop, Kill all) is not news either.
   */
  private returnsOnDemand(t: TaskLite): boolean {
    if (t.state !== 'needs-user' && t.state !== 'stuck' && t.state !== 'failed') return false
    if (t.state === 'failed' && /^Stopped/.test(t.error?.reason ?? '')) return false
    return this.wouldDemand(t)
  }

  /** demanding() without the pocket flag. */
  private wouldDemand(t: TaskLite): boolean {
    if (this.attentionAcknowledged.get(t.id) === t.state) return false
    if (t.state === 'needs-user' || t.state === 'stuck') return true
    const fresh = this.presence.awakeMs() - this.demandSince(t) < DEMAND_WINDOW_MS
    if (t.state === 'failed') return fresh
    // A CHECKPOINT IS NOT A STOP. An autonomous multi-task session flips
    // done->processing on every turn boundary its own loop drives — hooks
    // alone cannot tell that turn-boundary "done" apart from a genuine
    // finish. Without this, a busy session pops the notch open on every one
    // of those boundaries: "it just keeps popping up again and again" from a
    // session that never actually stopped. See Task.checkpoint.
    //
    // BUT NOT PAST ITS OWN PROMISE. The loop said when it expects to be back
    // (checkpointExpiresAt, its `delaySeconds` plus grace) — if that time
    // passes with no new prompt, the continuation never happened (app quit,
    // crashed, lost), and this is now exactly as stuck as any other abandoned
    // session-done. Trusting `checkpoint` forever would make a genuinely
    // dead loop invisible instead of eventually re-flagging like everything
    // else does.
    if (t.state === 'done' && (t.kind ?? 'oneoff') === 'session') {
      const checkpointActive = t.checkpoint && (t.checkpointExpiresAt === undefined || Date.now() < t.checkpointExpiresAt)
      return fresh && !checkpointActive
    }
    return false
  }

  /**
   * When this task started demanding, on the PRESENCE clock.
   *
   * Seeded on first sight from wall-clock age so a restart does not resurrect
   * a morning's worth of finished threads as a wall of fresh demands — but
   * clamped at the window, so the seed can only ever age a task OUT, never
   * grant it more time than it had.
   */
  private demandSince(t: TaskLite): number {
    const known = this.demandStamp.get(t.id)
    if (known !== undefined) return known
    const wallAge = Math.max(0, Date.now() - (t.updatedAt ?? Date.now()))
    const seeded = this.presence.awakeMs() - Math.min(wallAge, DEMAND_WINDOW_MS)
    this.demandStamp.set(t.id, seeded)
    return seeded
  }

  /**
   * When YOU last touched this — spoke to it, opened it, answered it, or
   * started it. The single ordering key for the whole surface.
   *
   * NOT `updatedAt`. Agent activity is not evidence of your interest: the
   * entire reason you fire a task is so it can work while you don't think about
   * it, so ordering by it puts whatever is churning tool calls in front of the
   * thing you were actually in. Seeded from `createdAt`, which is a real touch
   * — you asked for it.
   */
  /**
   * When this task last actually moved.
   *
   * `updatedAt` — and it is now safe to use, which it was not before. The
   * objection was that agent churn is not evidence of your interest, so a task
   * grinding through tool calls would shoulder its way to the front. But the
   * only things that move this clock now are a real status change: you sent it
   * something, or the agent answered. Opening a task no longer touches it, and
   * neither does walking past it in the carousel. So the parallel engagement
   * map this used to keep is gone — one clock, and it is the task's own.
   */
  private engagedAt(t: TaskLite): number {
    return t.updatedAt ?? t.createdAt ?? 0
  }

  /* `engage()` and its map lived here. Both are gone: `updatedAt` already
   * records the only thing that counts as interaction — a message sent, or a
   * response received — so keeping a second notion of recency beside it only
   * created ways for the two to disagree. Opening a task writes neither. */

  /** YOU touched this task. The one write to the user's clock. */
  private addressed(id: string): void {
    this.addressedStamp.set(id, Date.now())
    this.frozenOrder = null
    const current = this.pocketSlots().findIndex(slot => slot.id === (this.focusedId ?? id))
    if (current >= 0) this.pocketAt = current
    this.scheduleReconcile()
  }

  /** Falls back to `createdAt` — dispatching a task IS addressing it, and that
   *  number never moves afterwards. `updatedAt` is deliberately NOT a fallback:
   *  it is the agent's clock, and letting it in through the back door would
   *  restore exactly the reshuffling this replaced. */
  private addressedAt(t: TaskLite): number {
    return Math.max(this.addressedStamp.get(t.id) ?? 0, t.lastUserInputAt ?? t.createdAt ?? 0)
  }

  /** THE POCKET'S ORDER. Most recently talked-to first, in both halves. */
  private byAddressed = (a: TaskLite, b: TaskLite): number => this.addressedAt(b) - this.addressedAt(a)

  /** Has this task's answer to `demanding()` moved since we last drew it? */
  private demandingChanged(t: TaskLite): boolean {
    return this.demandSeen.get(t.id) !== this.demanding(t)
  }

  private rebuildQueue(): void {
    const tasks = this.deps.listTasks()
    for (const t of tasks) this.demandSeen.set(t.id, this.demanding(t))
    // ADDRESSABLE, NOT JUST DEMANDING. The queue is what the badge counts and
    // what the crank walks, and the pocket filtered it again downstream — so a
    // task that was demanding but unreachable made the two disagree: the
    // surface said three were waiting while the crank had a list of one and
    // `→` could not move. One filter, applied once, at the source.
    this.queue = tasks.filter((t) => this.demanding(t) && this.addressable(t))
      .sort(this.byAddressed).map((t) => t.id)
    // The stamps outlive nothing. A task that is gone from the runtime is gone
    // from the user's clock too, so a recycled id cannot inherit a stranger's
    // position in the order.
    if (this.addressedStamp.size > tasks.length) {
      const live = new Set(tasks.map((t) => t.id))
      for (const id of this.addressedStamp.keys()) if (!live.has(id)) this.addressedStamp.delete(id)
    }
  }

  /**
   * WHAT THE POCKET HOLDS: everything waiting on you, then everything you have
   * recently worked in. One list, two halves, no divider.
   *
   * There WAS a divider — a seam card reading "Nothing else is waiting". It is
   * gone. With nothing demanding it landed in slot 0 and announced the end of a
   * list you had not started; it got counted as a task, so two tasks read as
   * three; and it made the boundary something you had to press through rather
   * than see. The boundary is carried by the cards themselves instead: the ones
   * waiting on you render loud, the rest render quiet, and the badge counts only
   * the loud ones.
   *
   * Bounded by COUNT first, age second. Time alone does not bound the size, and
   * size is what decides whether a carousel is usable — twelve hours of a busy
   * day is twenty items, which is just the dashboard with worse ergonomics.
   */
  /**
   * CAN THE VOICE REACH THIS? Not "is it running right now".
   *
   * Two wrong answers preceded this one, and the second was mine.
   *
   * It first tested `alive`, which is `executors.get(id)?.alive` — the PTY map.
   * A Codex or Claude Desktop task is driven through its own app and has no PTY
   * by design, so it was permanently excluded: the bar counted it, the wall
   * listed it, and the pocket could not hold it.
   *
   * Exempting driver transports fixed that case and left the real one. Quitting
   * the app kills every local session, so after a relaunch EVERY Claude Code
   * task is `alive: false` — and the pocket came back holding nothing but the
   * Codex thread, with the crank stuck on a list of one while the surface
   * reported three waiting.
   *
   * The liveness test is obsolete anyway. Sending to a cold session revives it
   * and delivers (TaskManager.answer), so sleeping is not unreachable — it is
   * one message from awake. What the pocket must exclude is what can never be
   * reached again: a task that is gone, or one you removed from the pocket.
   * Nothing else.
   */
  private addressable(t: TaskLite): boolean {
    if (t.pocketRemoved) return false
    if (providerOf(t.agent).transport === 'driver') return true
    // A session sleeps; it does not die. A finished ONE-OFF with no process is
    // genuinely over — there is no thread to continue and nothing to say to it.
    //
    // Widening this to "anything the Resume button can wake" was tried on
    // 2026-09-08 and backed out: it also keeps dead PTY errands, which the
    // distinction above deliberately drops, and TaskLite carries no signal for
    // "graphical chat" to narrow it with. The case it was meant to fix — a card
    // the Agent reopened and delivered into — is handled where it belongs, by
    // the resume promoting that task to a session (sessions/service.ts).
    if ((t.kind ?? 'oneoff') === 'session') return true
    // CODEX IS NEVER "GENUINELY OVER" EITHER, one-off or not: every thread
    // mints a rollout on disk, so a dead process still has resume() to bring
    // it straight back (findRollout(codexRolloutId)) — the same "asleep, not
    // dead" guarantee a session gets. This only came up because one-off Codex
    // tasks now run in a real (tmux-detachable) PTY, so they can be `alive:
    // false` after a quit exactly like a session can — dropping one from the
    // pocket contradicts the "Resume" button sitting right there.
    if (t.agent === 'codex') return true
    return t.alive !== false
  }

  private pocketList(): TaskLite[] {
    const now = Date.now()
    const demanding = this.queue
      .map((id) => this.deps.getTask(id))
      .filter((t): t is TaskLite => !!t && this.addressable(t))

    const already = new Set(demanding.map((t) => t.id))
    const rest = this.deps.listTasks()
      // TWO CLOCKS, TWO QUESTIONS, AND THEY ARE NOT THE SAME QUESTION.
      //
      // IS IT STILL AT HAND? — the task's own clock. A long run you dispatched
      // this morning and have not touched since is still live work, and judging
      // that by when YOU last spoke would drop it off your desk while it was
      // still going.
      //
      // WHICH ONE FIRST? — your clock. See `addressedStamp`.
      .filter((t) => !already.has(t.id) && this.addressable(t)
        && now - Math.max(this.engagedAt(t), this.addressedStamp.get(t.id) ?? 0) < POCKET_IDLE_MS)
      .sort(this.byAddressed)

    // RECENCY IS ABSOLUTE. Demand changes how loudly a card is drawn and
    // whether it contributes to the badge; it must not put an older failure or
    // question ahead of the task the person just spoke to. The user-message
    // clock is the one answer to "what should be first?".
    return [...demanding, ...rest].sort(this.byAddressed)
  }

  /**
   * The ordered ids the pocket is currently showing.
   *
   * HELD FOR THE WHOLE VISIT. The previous version froze only the demanding
   * half and rebuilt the rest on every single call — including twice inside one
   * keypress — so the list reshuffled between choosing a slot and rendering it.
   * An index into a list that rebuilds itself is not an address.
   *
   * Newcomers append and the dead drop, because the pocket must stay truthful;
   * only the ORDER is nailed down, and only until you close it.
   */
  /** Which task ids are in the pocket right now — the only place that knows.
   *  Exposed so the Agent can tell the person a session is IN FRONT OF THEM
   *  rather than merely warm; those are different claims and it kept making
   *  the wrong one. Read-only: asking never reorders the pocket. */
  pocketTaskIds(): ReadonlySet<string> {
    return new Set(this.pocketList().map((t) => t.id))
  }

  /** "Remove from pocket": the card's menu item and the Agent's
   *  task_remove_from_pocket are this one call. The task keeps running and
   *  stays on the orchestrator; only the pocket lets go of it. */
  removeFromPocket(id: string): void {
    this.deps.setInPocket(id, false)
    if (this.focusedId === id) this.setFocus(null)
    this.scheduleReconcile()
  }

  private pocketOrder(): string[] {
    const live = this.pocketList()
    const liveIds = live.map((t) => t.id)
    // An accepted voice/provider input can arrive outside this controller.
    // Its persisted clock releases a browsing hold just like a composer send.
    if (this.frozenOrder && live.some(t => this.frozenInputTimes.has(t.id) && this.frozenInputTimes.get(t.id) !== this.addressedAt(t))) {
      // The card on screen stays on screen: the pocket is anchored on its id
      // (anchorPocket), so the re-sort moves the index, not the card.
      this.frozenOrder = null
    }
    if (!this.frozenOrder) return liveIds
    const alive = new Set(liveIds)
    const held = this.frozenOrder.filter((id) => alive.has(id))
    const known = new Set(held)
    for (const id of liveIds) if (!known.has(id)) held.push(id)
    this.frozenOrder = held
    return held
  }

  /** The id the Agent element answers to. Not a task id, and deliberately not
   *  shaped like one: nothing may look it up in the task runtime. */
  static readonly AGENT_SLOT = 'unmute-agent'

  /**
   * The Agent's card.
   *
   * `demanding` is TRUE ONLY WHILE UNREAD, and that is the same fact that puts
   * it at the front — one flag, so the card's weight and its position can never
   * disagree. It is filtered out of the badge separately (see reconcile): the
   * Agent is always present, so counting it would add a permanent +1 to a
   * number whose whole meaning is "things waiting on you".
   */
  private agentSlot(): PocketSlotP {
    const ask = this.agentBusy
      ? 'Thinking…'
      : this.agentLine?.text || 'Ask me anything'
    return {
      id: NotchController.AGENT_SLOT,
      kind: 'agent',
      title: 'Unmute',
      ask,
      status: this.agentBusy ? 'processing' : this.agentLine?.failed ? 'failed' : 'ready',
      demanding: this.agentUnread,
      // No backend mark: the card wears the Unmute mark, because the Agent is
      // Unmute rather than a thing Unmute started. Which model happens to be
      // behind it is not what the user is addressing.
      terminal: false,
    }
  }

  /**
   * WHAT THE POCKET ACTUALLY SHOWS: the task queue, plus the Agent, in one of
   * two arrangements.
   *
   * Every reader indexes THIS — the payload, `front()`, the carousel, the voice
   * target — so the index the user is on and the thing it addresses cannot
   * drift apart. The task half is `crankSlots()` verbatim; nothing about the
   * queue's ordering is touched here.
   */
  private pocketSlots(): PocketSlotP[] {
    const tasks = this.crankSlots()
    const agent = this.agentSlot()
    return this.agentUnread ? [agent, ...tasks] : [...tasks, agent]
  }

  /**
   * WHERE THE POCKET IS, after whatever re-sorted it. Every reader of the index
   * goes through here: the card being shown keeps being shown (and addressed)
   * until the person moves or it disappears — then the index stays put and
   * lands on whatever took its place.
   */
  private anchorPocket(slots: PocketSlotP[] = this.pocketSlots()): number {
    if (this.pocketAnchor) {
      const at = slots.findIndex((sl) => sl.id === this.pocketAnchor)
      if (at >= 0) this.pocketIndex = at
    }
    const n = slots.length
    this.pocketIndex = n <= 0 ? 0 : Math.max(0, Math.min(this.pocketIndex, n - 1))
    this.pocketAnchor = slots[this.pocketIndex]?.id ?? null
    return this.pocketIndex
  }

  /**
   * THE POCKET AS THE USER SEES IT, recorded when it changes.
   *
   * A report is always "it showed me the wrong thing", and answering that means
   * knowing what it showed and which slot the voice was aimed at — neither of
   * which any existing line carried. Written from `sendPocket`, which is
   * already the one place that knows the payload actually changed, so this
   * cannot log a view that was never drawn.
   */
  private logPocketView(slots: PocketSlotP[]): void {
    const at = Math.min(this.pocketAt, Math.max(0, slots.length - 1))
    const current = slots[at]
    log.ui('pocket', {
      mode: this.pocketMode,
      at,
      aimed: current ? `${current.kind ?? 'task'}:${current.title}` : null,
      slots: slots.map((sl, i) => `${i === at ? '>' : ' '}${sl.kind ?? 'task'}:${sl.title}${sl.demanding ? '!' : ''}`).join(' | '),
      agentAt: slots.findIndex((sl) => sl.kind === 'agent'),
      waiting: slots.filter((sl) => sl.demanding && sl.kind !== 'agent').length,
    })
  }

  private crankSlots(): PocketSlotP[] {
    const byId = new Map(this.pocketList().map((t) => [t.id, t]))
    return this.pocketOrder()
      .map((id) => byId.get(id))
      .filter((t): t is TaskLite => !!t)
      .map((t) => ({
        id: t.id,
        // SAID, NOT INFERRED. The pocket holds kinds of thing, and a slot that
        // does not say which kind it is leaves every reader to guess from the
        // fields it happens to carry — which is the drift `terminal` and
        // `backend` were made explicit to end.
        kind: 'task' as const,
        title: t.name ?? truncate(t.intent),
        // Same ranking as headlineFor: what it PRODUCED beats what it was doing.
        // The pocket used to go question → step and stop, so a finished task
        // could only ever show the stale step it had while running.
        ask: t.question?.text ?? t.result?.summary ?? t.step ?? undefined,
        status: t.state,
        demanding: this.demanding(t),
        backend: t.agent ?? 'claude',
        terminal: providerOf(t.agent).hasTerminal,
      }))
  }

  private onTransition(t: TaskLite): void {
    if (!t || !t.id) return
    this.trackKind(t)
    // A state CHANGE ends the acknowledgment episode — new state, new signal.
    const acknowledgedIn = this.attentionAcknowledged.get(t.id)
    if (acknowledgedIn !== undefined && acknowledgedIn !== t.state) this.attentionAcknowledged.delete(t.id)
    // A CHANGE RESTARTS THE DEMAND WINDOW. Answering a blocked task and letting
    // it finish again is a NEW checkpoint, and it deserves the full window; it
    // must not inherit the clock of the state it just left. Stamped before the
    // predicate runs, since the predicate reads it.
    //
    // ONLY FOR A TASK WE HAVE ALREADY SEEN. A first sighting is not a
    // transition — it is a restore, and on launch every task on disk arrives
    // this way. Stamping those fresh would greet you with a wall of demands
    // built out of yesterday's work every time the app started. Unseen tasks
    // fall through to demandSince(), which seeds from their real age.
    const seen = this.stateSeen.has(t.id)
    if (this.stateSeen.get(t.id) !== t.state) {
      this.stateSeen.set(t.id, t.state)
      if (seen) this.demandStamp.set(t.id, this.presence.awakeMs())
      else this.demandSince(t)     // seed from wall-clock age, once
      // A REMOVED CARD COMES BACK WHEN IT NEEDS YOU — on the transition, and
      // only on one we watched happen (`seen`): a restore is not news, so a
      // card you removed while it was waiting stays removed across a relaunch.
      // The flag is cleared at the source so every surface agrees; from here
      // it is an ordinary new demand, under every guard below — it joins the
      // pocket's list, and never replaces an open task or moves mid-capture.
      if (seen && t.pocketRemoved && this.returnsOnDemand(t)) {
        log.event('pocket-return-on-demand', { taskId: t.id, state: t.state })
        this.deps.setInPocket(t.id, true)
        t = { ...t, pocketRemoved: false }
      }
    }
    const eligible = this.demanding(t)
    const queued = this.queue.includes(t.id)
    if (eligible && !queued) {
      this.queue.push(t.id)
      // SOMETHING NEW WANTS YOU, AND THE POCKET IS WHERE IT LANDED.
      //
      // With the pocket open the auto-expand below is deliberately suppressed
      // (the guard on `pocketMode`), so this card joins the rail instead —
      // which is the pocket changing under the user because a task needs them,
      // not because they did anything. That is still the surface earning its
      // place on screen, so it gets a full window to be answered in.
      this.stirPocket()
      // AUTO-EXPAND, guarded on `engaged === 'none'`.
      //
      // The guard is the whole design. Without it a task arriving while you are
      // reading ANOTHER task, or working in the cockpit, would yank the surface
      // out from under you — which is worse than never expanding at all.
      //
      // It also gives the user's ✕ the behaviour they expect: closing sets
      // engaged back to 'none', so the surface stays shut for the task they
      // dismissed, and the NEXT thing that needs them opens it again.
      // An open pocket is an explicit voice address. New attention can join its
      // rail, but must not replace the card (or the address) under the user.
      //
      // NOR WHILE THE PERSON IS SPEAKING. The voice's destination is read at
      // submit, so opening a task mid-utterance would send the words there.
      // Held back instead, and applied when the capture ends if it still needs
      // them and nothing else has been opened meanwhile.
      if (this.autoExpand && this.engaged === 'none' && this.pocketMode !== 'open') {
        if (this.capturing()) {
          this.deferredExpand = t.id
          log.event('auto-expand-deferred', { taskId: t.id, why: 'capture in progress' })
          this.deferUntilCaptureEnds()
        } else this.autoExpandTo(t)
      }
    }
    else if (!eligible && queued) this.queue = this.queue.filter((id) => id !== t.id)
    this.scheduleReconcile()
  }

  private autoExpandTo(t: TaskLite, deferred = false): void {
    // WHY THE SURFACE OPENED, on the record.
    //
    // Four clauses can make a task demanding, and from the outside they are
    // indistinguishable — the panel simply appears. A Codex task reported as
    // "popping up again and again while the model is still working" cost an
    // afternoon of reasoning that ruled out three suspects and found none,
    // because nothing said which clause fired. One line ends that.
    log.event('auto-expanded', {
      taskId: t.id, state: t.state, kind: t.kind ?? 'oneoff',
      agent: t.agent ?? 'claude',
      ...(deferred ? { deferred } : {}),
      why: t.state === 'needs-user' ? 'needs-user'
        : t.state === 'stuck' ? 'stuck'
        : t.state === 'failed' ? 'failed-fresh'
        : 'done-session-fresh',
    })
    this.engaged = 'task'
    this.setFocus(t.id)
  }

  private trackKind(t: TaskLite): void {
    const prev = this.kindSeen.get(t.id)
    const kind = t.kind ?? 'oneoff'
    if (prev === 'oneoff' && kind === 'session') this.promotedUntil.set(t.id, Date.now() + PROMOTED_BADGE_MS)
    this.kindSeen.set(t.id, kind)
  }

  private dequeue(id: string): void {
    this.queue = this.queue.filter((x) => x !== id)
    if (this.deferredExpand === id) this.deferredExpand = null
    // ONLY THE OPEN TASK GOING AWAY TOUCHES THE SURFACE. This dropped the
    // engagement whenever the queue emptied, so removing an unrelated task
    // collapsed whatever you had open (a tapped working task, the Agent chat).
    if (this.focusedId !== id) return
    this.setFocus(null)
    if (this.queue.length === 0 && this.engaged === 'task') this.engaged = 'none'
  }

  private front(slots?: PocketSlotP[]): TaskLite | undefined {
    // WHILE YOU ARE WALKING, THE FRONT IS WHERE YOU ARE. Without this the
    // surface kept showing queue[0] while the crank index moved underneath it,
    // so `→` changed the pocket and nothing else. Reads the SAME slots the
    // payload was built from when reconcile hands them over.
    if (this.frozenOrder) {
      const all = slots ?? this.pocketSlots()
      const id = all[this.anchorPocket(all)]?.id
      const t = id ? this.deps.getTask(id) : undefined
      if (t) return t
    }
    while (this.queue.length > 0) {
      const t = this.deps.getTask(this.queue[0])
      if (t && this.demanding(t)) return t
      this.queue.shift()
    }
    return undefined
  }

  // ── reconcile: push state + payloads ───────────────────────────────────────

  private scheduleReconcile(): void {
    if (this.reconcileTimer) return
    this.reconcileTimer = setTimeout(() => { this.reconcileTimer = null; this.reconcile() }, 80)
  }

  private reconcile(): void {
    // Mirror the surface's own teardown rule: it discards the staged task on
    // leaving cockpit, so our record of having sent it must go at the same time.
    if (this.engaged !== 'cockpit') this.lastDetailJson.delete('stageDetail')
    this.rebuildQueue()
    // THE ONE DERIVATION. Everything below reads this array — the payload the
    // surface draws, the number on the bar, and which task is fronted. They are
    // the same list by construction, so they cannot disagree; `attention` used
    // to be `queue.length` and matched `waiting` only because two independent
    // filters happened to agree, which is how "3 waiting" shipped beside a
    // crank of one.
    const slots = this.pocketSlots()
    // The pocket rides along on every pass: tasks in it can finish or be killed
    // by anything, and a carousel offering a dead address would aim the voice
    // at nothing. sendPocket is a no-op when the payload has not changed.
    this.sendPocket(slots)
    const front = this.front(slots)
    // THE BADGE COUNTS TASKS, NOT ELEMENTS. The Agent is always in the pocket,
    // so counting it would put a permanent +1 on a number that means "things
    // waiting on you" — and the one moment it IS waiting on you, it is already
    // saying so in front of everything else, which is louder than a digit.
    const attention = slots.filter((sl) => sl.demanding && sl.kind !== 'agent').length
    this.lastWaiting = attention
    const working = this.deps.listTasks().filter((t) => t.state === 'processing').length

    if (this.engaged === 'cockpit') {
      this.client.send({ type: 'setCockpit', data: this.buildCockpit() })
      if (this.focusedId) {
        const t = this.deps.getTask(this.focusedId)
        if (t) this.sendDetail('stageDetail', t)
      }
      this.client.send({ type: 'setState', state: 'cockpit', attention, working })
      return
    }

    // THE AGENT CHAT IS A SURFACE, AND RECONCILE HAS TO KNOW THAT.
    //
    // The comment below called this exactly right for tasks and the Agent was
    // added underneath it without being told: openAgent sets `engaged = 'task'`
    // but deliberately leaves `focusedId` null, because the Agent is not a task
    // and handing the task runtime an id it cannot resolve is its own bug. So
    // `opened` was undefined, `shown` fell through to whatever task was at the
    // front of the queue, and the next tick either REPLACED the chat with that
    // task or — with nothing demanding — collapsed the surface outright.
    //
    // Measured in the field: the chat lived 0.8 seconds. Reconcile runs on
    // every task event, so it was never the user closing it.
    //
    // The three conditions are the whole state: the chat is open, the surface
    // is expanded, and no task owns it. Anything that focuses a task or opens
    // the cockpit therefore wins here without needing a flag of its own — a
    // stale `agentOpen` can never hijack a surface it does not own.
    if (this.agentOpen && this.engaged === 'task' && !this.focusedId) {
      this.sendAgentDetail()
      this.client.send({ type: 'setState', state: 'task', attention, working })
      return
    }

    // The task surface can hold a task that is NOT in the attention queue — the
    // user tapped a merely-working one. Without this the surface would open and
    // then immediately collapse back to `active` on the next reconcile.
    const opened = this.engaged === 'task' && this.focusedId ? this.deps.getTask(this.focusedId) : undefined
    // THE OPEN TASK WINS OVER THE QUEUE. This was `front ?? opened`, so any
    // task that began demanding — a fresh one, a failure, one the Agent created
    // or sent to (both stamp the user's clock and sort first) — replaced the
    // task you had open on the very next reconcile, and took the voice with it.
    // Only the open task going away (dequeue clears the focus) lets the surface
    // move on to the front of the queue.
    //
    // …and not even that while the person is speaking: handing the voice to a
    // task they never chose, mid-utterance, is the same steal. Collapse to the
    // compact bar instead (the voice goes back to the router, which is what the
    // cleared focus already says) and leave the choice to them.
    if (this.engaged === 'task' && !opened && this.capturing()) {
      this.engaged = 'none'
      if (this.focusedId) this.setFocus(null)
    }
    const shown = opened ?? front
    if (shown) {
      // AN EXPANDED TASK IS ITS OWN VOICE ADDRESS. When the open task is
      // removed, the expanded surface advances to the next card. dequeue()
      // clears the old focus first; without repairing it here the UI
      // visibly showed one conversation while Right Option remained
      // unaddressed, so its model picker changed the defaults for a future task
      // instead of the conversation on screen.
      if (this.engaged === 'task' && this.focusedId !== shown.id) this.setFocus(shown.id)
      this.sendDetail('showTask', shown)
      // The task surface needs rail context too (tmux gate etc.).
      if (this.engaged === 'task') this.client.send({ type: 'setCockpit', data: this.buildCockpit() })
      this.client.send({ type: 'setState', state: this.engaged === 'task' ? 'task' : 'attention', attention, working })
      return
    }

    this.engaged = 'none'
    // Compact active has two pieces of copy: "Working" and the task title.
    // They must come from the same snapshot. `showTask` used to be sent only
    // for attention/expanded surfaces, leaving the native helper free to reuse
    // whichever task had last been opened even after it finished.
    const activeTask = this.soleWorking()
    if (activeTask) this.sendDetail('showTask', activeTask)
    // AN OPEN POCKET IS NOT AN EMPTY SURFACE, and this line used to say it was.
    //
    // "Nothing is processing" is a fact about TASKS. Whether anything is on
    // screen is a different fact, and the pocket is the case where they come
    // apart: the chord (and a tap) opens it precisely when nothing is running,
    // then reconcile ran and commanded `dormant` on top of it. On a notched Mac
    // dormant is the CUTOUT — dormantFrame() is the hole itself — so the card
    // was posted behind the camera housing, where there is no screen to draw
    // on. Press the chord, nothing appears. Field log 19 Sep 03:16:13:
    // `CMD pocket mode=open at=0 slots=5`, then `CMD setState dormant`, then
    // `state -> dormant window=x=666 y=950 w=183 h=32`.
    //
    // `idle` is the quiet bar rung the pocket already rides on — the same rung
    // the surface itself falls back to on a display with no cutout to hide in.
    const quiet = this.pocketMode === 'open' ? 'idle' : 'dormant'
    const state = working > 0 ? 'active' : quiet
    // The native receiver unconditionally drops model.task on dormant. Its
    // copy is gone, so our dedupe record must go with it; otherwise an
    // unchanged task returning later gets only setState and opens empty.
    // Gated on what we actually SEND: `idle` tears nothing down, so dropping
    // the record there would only cost a redundant resend.
    if (state === 'dormant') this.lastDetailJson.delete('showTask')
    this.client.send({ type: 'setState', state, attention: 0, working })
  }

  // ── gestures ───────────────────────────────────────────────────────────────

  private onTap(): void {
    // Tapping opens WHAT THE NOTCH IS SHOWING. When something needs you that is
    // the fronted task; when nothing does but one task is working, the notch is
    // showing THAT task, so a tap must open it too.
    //
    // Reported from the field 2026-07-25: "when you tap it, it just directly
    // opens the cockpit". The cause was this method only considering the
    // attention queue — a merely-working task is never in it, so every tap on a
    // running task fell through to the whole wall. The cockpit stays the
    // answer only when the notch is showing no single task.
    const target = this.front() ?? this.soleWorking()
    if (!target) { this.openCockpit(); return }
    this.engaged = 'task'
    // No auto-resume. Opening is reading; a cold session comes back when you
    // actually send it something (TaskManager.answer).
    this.setFocus(target.id) // voice routes to the fronted task
    this.reconcile()
  }

  /**
   * The one task the notch is showing while it says "working".
   *
   * Deliberately only when there is EXACTLY one: with several running, the
   * notch is showing a count rather than a task, and the wall is the honest
   * destination.
   */
  private soleWorking(): TaskLite | undefined {
    const working = this.deps.listTasks().filter((t) => t.state === 'processing')
    return working.length === 1 ? working[0] : undefined
  }

  // ── The pocket ────────────────────────────────────────────────────────────

  /**
   * The carousel: the tasks you set aside, and nothing else.
   *
   * Earlier versions carried two synthetic entries — a forced "+ New task" and
   * an "Unmute will choose" — and both were category errors. "Let the router
   * decide" is not a member of a list of tasks; it is what happens when no list
   * is on screen. Putting it in the ring made it look like a task, gave it a
   * name to argue about, and needed a rule about where it sat.
   */

  /**
   * YOU ROUTE TO WHAT YOU CAN SEE.
   *
   * One rule, no timers, no hidden state — which is exactly why an earlier
   * "the task stays yours for N minutes" idea was dropped: it made the address
   * depend on elapsed time the user cannot see and will not remember.
   *
   *   expanded task            → that task
   *   pocket open (sticky)     → whatever is at the forefront
   *   pocket closed / speaking → the router decides, and the card says so
   *
   * `focus` is already the voice's address (init.ts short-circuits on it), so
   * this is expressed by moving focus rather than by inventing a second
   * channel. `forceNewTask` is the one thing focus cannot say: null focus means
   * "let the router choose", which is not the same as "I want a new task".
   */
  private applyVoiceTarget(): void {
    if (this.engaged === 'task' && this.focusedId) return
    // OPEN IS AIMED, CLOSED IS THE ROUTER. The pocket only ever opens because
    // the user opened it, so "is it open" is a decision they made, not a state
    // that happened to them.
    //
    // THE AGENT IS AIMED AT THE SAME WAY ANYTHING ELSE IS. Its card being the
    // one in front means your voice goes to it — the rule is "you address what
    // you can see", and the Agent is now something you can see. It is said
    // through a separate channel rather than through focus because focus means
    // a TASK, and handing the task runtime an id it cannot resolve is how a
    // surface ends up addressing nothing at all.
    const all = this.pocketMode === 'open' ? this.pocketSlots() : []
    const slot = this.pocketMode === 'open' ? all[this.anchorPocket(all)] : undefined
    this.deps.addressAgent?.(this.agentAddressed())
    this.setFocus(slot && slot.kind !== 'agent' ? slot.id : null)
  }

  /**
   * ONE DERIVATION, MANY READERS.
   *
   * `slots` is passed in from reconcile rather than recomputed, because it is
   * also what the badge counts and what `front()` reads. Every bug in this file
   * this week had the same shape: the same question answered in two places that
   * then drifted. "Is it addressable" was answered three times and one copy was
   * wrong. "Is it demanding" was applied by the queue and again by the pocket,
   * so the bar could say three while the crank had one. "Does this count as
   * interaction" was stamped at four call sites, two of them wrong.
   *
   * So the rule for this surface is now: derive once per pass, hand the result
   * around, and never re-answer downstream. If you find yourself recomputing
   * one of these, that is the bug — not the thing you were about to fix.
   */
  private sendPocket(slots: PocketSlotP[] = this.pocketSlots()): void {
    this.anchorPocket(slots)   // follows the card, and keeps the index inside the ring
    const waiting = slots.filter((sl) => sl.demanding && sl.kind !== 'agent').length
    const data: PocketP = {
      mode: this.pocketMode, at: this.pocketAt, waiting, slots,
      remoteKey: this.deps.remoteKey?.() ?? 'right-option',
    }
    const json = JSON.stringify(data)
    if (json === this.lastPocketJson) return
    this.lastPocketJson = json
    this.logPocketView(slots)
    this.client.send({ type: 'pocket', data })
  }

  // ── The idle clock ────────────────────────────────────────────────────────
  //
  // THE POCKET LETS GO WHEN YOU HAVE STOPPED USING IT. It used to be sticky:
  // opened once, up until closed by hand. Harmless for the card — it is small
  // and lives at the top edge — and wrong for what an open pocket MEANS, which
  // is where your voice lands. See POCKET_OPEN_IDLE_MS.
  //
  // "Using it" is read as widely as it can honestly be read:
  //
  //   opening it      arms a fresh window, by whichever route (setPocketMode).
  //   acting on it    every event the surface sends re-arms it — the carousel,
  //                   the ‹ ›, the swipe, the buttons, a hover over the card,
  //                   a keystroke in a composer. See the `on` wrapper.
  //   speaking to it  a live capture SUSPENDS the clock instead of racing it,
  //                   and the window starts over when the capture ends.
  //   being needed    a task that newly demands you — or an Agent answer — while
  //                   the pocket is open re-arms it: the card changed under your
  //                   eye because something wants you, so your window to react
  //                   starts then, not whenever you last touched the surface.
  //                   This is the case the user has to be given for free; they
  //                   did nothing to earn it and did nothing to lose it either.

  /** Something touched the pocket. No-op when it is closed, which is why
   *  callers never have to ask. */
  private stirPocket(): void {
    if (this.pocketMode !== 'open') return
    this.armPocketIdle()
  }

  private armPocketIdle(): void {
    this.disarmPocketIdle()
    this.pocketIdleTimer = setTimeout(() => this.pocketWentIdle(), POCKET_OPEN_IDLE_MS)
    this.pocketIdleTimer.unref?.()
  }

  private disarmPocketIdle(): void {
    if (!this.pocketIdleTimer) return
    clearTimeout(this.pocketIdleTimer)
    this.pocketIdleTimer = null
  }

  /** The window ran out. Closes exactly as Escape does — including releasing
   *  the aim — because a card that went away while the voice still pointed at
   *  it would be strictly worse than one that never went away at all. */
  private pocketWentIdle(): void {
    this.pocketIdleTimer = null
    if (this.pocketMode !== 'open') return
    // NOT MID-SENTENCE. The destination is read at submit, so closing here
    // would hand the words to the router instead of the card the person was
    // looking at when they started speaking. Held, and `afterCapture` gives it
    // a full window again once the utterance is settled.
    if (this.capturing()) {
      log.event('pocket-idle-held', { why: 'capture in progress' })
      this.deferUntilCaptureEnds()
      return
    }
    log.event('pocket-idle-close', { after: POCKET_OPEN_IDLE_MS, at: this.pocketAt })
    this.frozenOrder = null
    this.engaged = 'none'
    this.setFocus(null)
    this.setPocketMode('closed')
    this.reconcile()
  }

  private setPocketMode(mode: PocketMode): void {
    if (this.pocketMode === mode) return
    this.pocketMode = mode
    // THE IDLE CLOCK RUNS ONLY WHILE THE CARD IS UP, and every route in arms a
    // fresh one. Put here rather than on the handlers so that opening the
    // pocket is the thing that starts it, whoever asked — the chord, a click, a
    // session link, coming back from an expanded card, or a path written later.
    if (mode === 'open') this.armPocketIdle()
    else this.disarmPocketIdle()
    // DELIBERATELY DOES NOT RESET THE INDEX. It used to land on 0 on every
    // open, which is right for a FRESH open (the `pocketOpen` handler resets
    // there) and wrong for coming back from an expanded card: you left from
    // slot 3, and returning put you on slot 1 every single time.
    this.applyVoiceTarget()
    this.sendPocket()
  }

  /**
   * The user left — switched app, or started a screen capture.
   *
   * An expanded panel covering 70% of the display is right while you are
   * reading it and wrong the instant you go to look at something else, and
   * changing window IS the signal that you have. Closing was the only escape
   * before, and closing says "done with this", which is rarely what was meant.
   */
  private onUserLeft(reason: 'blur' | 'screenshot' | 'space'): void {
    // GETTING OUT OF THE WAY APPLIES TO THE CHAT TOO. It is a full-screen
    // surface like any other, and a chat left open over the app you switched to
    // is the exact complaint this behaviour exists to answer.
    this.leaveAgent()
    // ANY BIG SURFACE GETS OUT OF THE WAY, not just one holding a task.
    //
    // This keyed on `focusedId`, which exempted the one surface most likely to
    // be covering the screen: the WALL. Tap an empty notch, get the whole
    // orchestrator, swipe to another Space to look something up — and it was
    // still there, because a focusless cockpit has no task to pocket. But
    // pocketing and collapsing are different jobs. Pocketing needs a task;
    // getting out of the way does not.
    if (this.engaged === 'none') return
    // NOT WHILE A CAPTURE IS RECORDING. Collapsing clears the voice's address,
    // and the destination is read at submit — so glancing at another window
    // mid-sentence would send the words to the router instead of this task.
    // Held, not dropped: it applies when the capture ends unless they came back.
    if (this.capturing()) {
      this.deferredLeave = reason
      log.event('user-left-held', { reason, why: 'capture in progress' })
      this.deferUntilCaptureEnds()
      return
    }
    const id = this.focusedId
    const t = id ? this.deps.getTask(id) : undefined
    // Remember what to put back, so a return inside the window restores the
    // surface you were actually on rather than guessing at a task.
    this.returnTo = id ? { kind: 'task', id } : { kind: 'cockpit' }
    this.returnGraceUntil = Date.now() + RETURN_GRACE_MS
    this.engaged = 'none'
    this.historyTask = null
    this.historyLimit = 10
    this.setFocus(null)
    this.setPocketMode('closed')
    log.event('user-left', { reason, taskId: id, state: t?.state ?? null, was: this.returnTo.kind })
    this.sendPocket()
    this.reconcile()
  }

  /** Came straight back → you did not mean to leave. Re-open what collapsed. */
  private onUserReturned(): void {
    this.deferredLeave = null
    const back = this.returnTo
    if (!back || Date.now() > this.returnGraceUntil) return
    this.returnGraceUntil = 0
    this.returnTo = null
    if (back.kind === 'cockpit') {
      this.engaged = 'cockpit'
      log.event('cockpit-reopened-on-return', {})
    } else {
      const t = this.deps.getTask(back.id)
      if (!t) return
      this.engaged = 'task'
      this.setFocus(back.id)
      log.event('pocket-reopened-on-return', { taskId: back.id })
    }
    this.setPocketMode('closed')
    this.reconcile()
  }

  /**
   * Back to the full task — the trip the pocket was missing.
   *
   * The pocket exists because the expanded panel takes the whole screen, NOT
   * because the expanded panel is wrong. Reading the whole ask, watching the
   * terminal, answering a picker: all of that still needs the panel, and the
   * card deliberately shows two lines. Without a way back, setting something
   * aside was a one-way door whose only return was the dashboard — the exact
   * trip this feature was built to save.
   *
   * It LEAVES the pocket on the way out: it is not set aside any more, it is
   * open in front of you. Leaving or closing puts it straight back.
   */
  /**
   * @param wanted the id of the slot the CARD was showing when the person
   *   acted. Absent only from a surface older than this change.
   */
  private onPocketExpand(wanted?: string): void {
    const slots = this.pocketSlots()
    // BY IDENTITY, FALLING BACK TO POSITION.
    //
    // This read `slots[this.pocketAt]` alone — a POSITION into a list it
    // recomputes right here, at expand time. The pocket is ordered by
    // engagement, so the list re-sorts underneath the index between the card
    // being drawn and the key being pressed: the card said "Job listing
    // platform", Return arrived, and position 0 was a different task by then.
    // Reported as "the task that is open is job listing, but when I press enter
    // I see this task", and the give-away was the pocket landing on 2/4
    // afterwards — the index had not moved, the LIST had.
    //
    // The index is still the fallback, for a surface that predates the id and
    // for a slot that has genuinely gone away while the key was in flight.
    const slot = (wanted ? slots.find((s) => s.id === wanted) : undefined) ?? slots[this.anchorPocket(slots)]
    if (!slot) return
    // THE POCKET IS WHERE YOU OPENED IT FROM. Left behind, the index went on
    // pointing at whatever the list had re-sorted into that position, and the
    // held-order `front()` read THAT — replacing the card you opened.
    this.pocketAt = slots.indexOf(slot)
    if (wanted && slot.id !== wanted) {
      log.event('pocket-expand-drifted', { wanted, opened: slot.id, at: this.pocketAt })
    }
    // THE AGENT EXPANDS INTO ITS CHAT, not into a task panel — there is no task
    // behind it to open, and everything below this line is about one.
    if (slot.kind === 'agent') { this.openAgent(); return }
    const id = slot.id
    // COMING BACK MEANS COMING BACK HERE. Expanding used to close the pocket
    // outright, so Escape dropped you onto the bare notch and you had to reopen
    // and re-find your place. The pocket is where you were; it is where you
    // return. Index deliberately kept, not reset.
    this.leaveAgent()
    this.cameFromPocket = this.pocketMode === 'open'
    const opened = this.deps.getTask(id)
    if (opened) this.attentionAcknowledged.set(id, opened.state)
    this.engaged = 'task'
    this.setFocus(id)
    log.event('pocket-expanded', { taskId: id })
    // Present the destination first. Sending `pocket: closed` before `task`
    // gave the native process a real intermediate target — the 22pt bar — so
    // the card visibly vanished and reopened instead of morphing in place.
    this.reconcile()
    this.setPocketMode('closed')
  }

  /**
   * OPENING THE CARD IS READING IT.
   *
   * That is the whole of the front/back rule: unread puts the Agent in front,
   * and the only thing that clears unread is actually looking at the answer.
   * Passing the card on the carousel does not — glancing at one line is not
   * reading the reply, and demoting it for a glance is how you lose an answer
   * you asked for.
   */
  openAgent(): void {
    this.cameFromPocket = this.pocketMode === 'open'
    const wasUnread = this.agentUnread
    this.agentUnread = false
    if (this.routinesView?.runs.some(r => r.unread)) {
      void this.deps.routineAction?.({ type: 'markRead' }).catch(error => log.warn('routine markRead failed', { error: (error as Error).message }))
    }
    this.engaged = 'task'
    // NOT setFocus: focus means a TASK, and handing the task runtime an id it
    // cannot resolve is how a surface ends up addressing nothing. The Agent is
    // addressed as itself — see applyVoiceTarget.
    this.setFocus(null)
    this.agentOpen = true
    log.ui('agent-chat', {
      shown: true, turns: this.agentBlocks.length,
      kinds: this.agentBlocks.map((b) => b.kind).join(','),
      wasUnread, why: 'you opened the card, which is what counts as reading it',
    })
    this.sendAgentDetail()
    this.client.send({ type: 'setState', state: 'task', attention: this.lastWaiting, working: 0 })
    this.setPocketMode('closed')
    this.applyVoiceTarget()
  }

  /** The Agent's chat, in the same payload every other backend renders into. */
  private sendAgentDetail(): void {
    if (this.historyTask !== NotchController.AGENT_SLOT) { this.historyTask = NotchController.AGENT_SLOT; this.historyLimit = this.agentSessionMessages || 10 }
    this.probeAgentProviders()
    const selected = this.agentSelectedProvider
    const pendingMessage = this.agentPendingProvider
      ? this.agentBusy
        ? `Switching to ${providerLabel(this.agentPendingProvider)} when the current response finishes.`
        : `${providerLabel(this.agentPendingProvider)} selected. The next message starts a new conversation.`
      : undefined
    const detail: TaskDetailP = {
      id: NotchController.AGENT_SLOT,
      title: 'Unmute (Sessions manager)',
      origin: 'unmute-agent',
      backend: this.agentProvider,
      modelLabel: this.agentModel ? `${this.agentModel} · medium` : 'Model not reported · medium',
      deliveryError: this.agentError,
      agentCanRetry: this.agentCanRetry,
      canCompose: true,
      // STOPPABLE WHILE IT IS WORKING, though it is not owned: there is no
      // process of ours to kill, but the provider takes an interrupt and the
      // chat is left with a turn that was stopped. `owned: false` below is why
      // the surface needs this told to it rather than inferred.
      canStop: this.agentBusy,
      status: this.agentBusy ? 'processing' : this.agentLine?.failed ? 'failed' : 'ready',
      kind: 'session',
      alive: true,
      // No terminal and nothing to kill: this is not a process the user started.
      terminal: false,
      owned: false,
      resumable: false,
      ...messageWindow(this.agentBlocks, this.historyLimit),
      draft: { text: this.agentDraft, attachments: [], clientRevision: this.agentDraftRevision },
      chatConfig: {
        provider: selected,
        providerLabel: providerLabel(selected),
        model: agentModel(selected),
        modelLabel: agentModelLabel(selected),
        // A provider whose CLI is not installed would only fail on the next
        // message, so it is not offered at all.
        // EVERY CHOICE, per installed provider: its models under it. Choosing a
        // model of the current provider keeps the conversation; one of another
        // provider is also a provider switch.
        providers: this.agentInstalled.map(id => {
          const choice = this.deps.agentModelsFor?.(id)
          return { id, label: providerLabel(id), description: agentModelLabel(id),
            ...(choice?.models.length ? { models: choice.models.map(m => ({ id: m.id, label: m.label })), selected: choice.selected } : {}) }
        }),
        models: [], efforts: [], permissions: [], cwd: '', mutable: true, busy: this.agentBusy,
        ...(pendingMessage ? { error: pendingMessage } : {}),
      },
      ...(this.agentBusy ? { activity: pendingMessage ?? 'Thinking' } : {}),
      ...(this.routinesView !== null ? { routines: routinesPayload(this.routinesView, this.routineRunDetail ?? undefined) } : {}),
    }
    this.client.send({ type: 'showTask', task: detail })
  }

  /** Re-sends the Agent's chat once the installed set is known or changes.
   *  The probe itself is cached upstream, so asking on every send is cheap. */
  private probeAgentProviders(): void {
    if (this.agentInstalledProbe || !this.deps.agentInstalledProviders) return
    this.agentInstalledProbe = this.deps.agentInstalledProviders().then(installed => {
      const next = (['claude', 'codex'] as const).filter(id => installed.includes(id))
      if (next.join() === this.agentInstalled.join()) return
      this.agentInstalled = next
      if (this.historyTask === NotchController.AGENT_SLOT) this.sendAgentDetail()
    }).catch(() => {}).finally(() => { this.agentInstalledProbe = undefined })
  }

  private onPocketMove(e: { delta?: number; to?: number }): void {
    // Walking HOLDS THE ORDER (see pocketOrder). Released when the pocket
    // closes, so the next visit re-sorts to what you last worked in. Browsing
    // itself never re-ranks anything.
    this.holdOrder()
    const slots = this.pocketSlots()
    const n = slots.length
    if (n <= 1) return
    const from = this.anchorPocket(slots)   // step from the card on screen
    this.pocketAt = typeof e.to === 'number'
      ? Math.max(0, Math.min(n - 1, e.to))
      : (from + (e.delta ?? 1) + n * 2) % n
    this.applyVoiceTarget()
    this.sendPocket()
  }

  /**
   * IDLE → ACTIVE. You touched the machine after a stretch of not touching it.
   *
   * Everything that happened while you were gone is still demanding — the
   * window that would have aged it out was frozen along with you (see Presence)
   * — so refresh the real backlog rather than whatever survived a wall clock.
   * The surface stays compact: returning is not consent to interrupt.
   *
   * Silent when nothing wants you: coming back to a clean desk should look like
   * a clean desk, not like a surface with an opinion.
   */
  private onWake(): void {
    this.rebuildQueue()
    if (!this.queue.length) return
    if (this.engaged !== 'none') return   // you left something open; that wins
    // An open pocket is something open too: re-sorting it or rewinding it to
    // card 1 would move the card (and the voice) out from under you.
    if (this.pocketMode === 'open') return
    this.frozenOrder = null               // fresh visit, fresh order
    this.pocketAt = 0
    log.event('woke-into-backlog', { waiting: this.queue.length })
    this.reconcile()
  }

  /**
   * Adopt a CLI session the user already had running elsewhere.
   *
   * Drops it from the rail immediately rather than waiting for the next scan —
   * the row's only purpose was to import it, and a row that has done its job
   * and is still sitting there invites a second import.
   */
  private async onImportSession(sessionId: string): Promise<void> {
    const ok = await this.deps.importSession?.(sessionId)
    if (ok) this.importable = this.importable.filter((s) => s.sessionId !== sessionId)
    log.event('import-session', { sessionId, ok: !!ok })
    await this.refreshRails(true)
    this.reconcile()
  }

  private openCockpit(): void {
    this.leaveAgent()
    this.engaged = 'cockpit'
    // "OPEN DASHBOARD" MEANS THE DASHBOARD, NOT THE TASK YOU CAME FROM.
    //
    // The cockpit renders the focused task's STAGE whenever `focusedId` is set
    // (reconcile sends stageDetail; NotchView draws the stage instead of the
    // wall). Coming here from an auto-expanded task left that focus in place,
    // so the one button whose label promises "all your tasks" delivered the
    // single task you had just chosen to leave — and getting to the actual wall
    // meant closing the stage first. Arriving at the dashboard clears focus.
    this.setFocus(null)
    this.wallOrder = null         // a fresh visit re-sorts to what has moved
    this.expandedGroups.clear()   // each visit starts on the live view
    this.computeDigest()
    this.deps.setLastSeen(Date.now())
    void this.refreshRails(true)
    this.reconcile()
  }

  /**
   * WALK THE CRANK. Demanding first, then the seam, then today.
   *
   * This used to ROTATE the queue (skip = requeue to the back), which meant the
   * list you were reading rearranged itself as you read it and there was no
   * such thing as "the end" — you could crank forever and never learn that
   * nothing was left. Now it is an index into a held sequence, so `→` past the
   * last demanding task lands on the seam and says so, and everything past the
   * seam is today's work rather than the same three tasks again.
   */
  /**
   * WHERE `next` GOES DEPENDS ON WHAT IS ON SCREEN.
   *
   * With the pocket open it is the carousel — the same movement the ‹ › on the
   * card make. It used to run the crank regardless, which promoted the surface
   * from the small card to the full task panel: you pressed next expecting the
   * second card and got the whole terminal. A control must not change what kind
   * of thing it is doing based on nothing the user did.
   */
  private onNext(): void {
    if (this.pocketMode === 'open') { this.onPocketMove({ delta: 1 }); return }
    this.crankStep(1)
  }
  private onPrev(): void {
    if (this.pocketMode === 'open') { this.onPocketMove({ delta: -1 }); return }
    this.crankStep(-1)
  }

  private crankStep(delta: number): void {
    this.holdOrder()
    // Move in the SAME index space the native carousel renders. The Agent can
    // occupy slot zero while unread; indexing the task-only order made the UI
    // show task B while voice focus silently moved to task C.
    const slots = this.pocketSlots()
    const n = slots.length
    if (!n) return
    this.anchorPocket(slots)
    // WHERE THE CRANK IS STANDING. The Agent holds no `focusedId` — it is
    // addressed as itself, not as a task — so its own chat is found by kind.
    // Without this, cranking out of the Agent restarted from wherever the
    // index happened to be rather than from the card on screen.
    const current = this.agentOpen
      ? slots.findIndex(slot => slot.kind === 'agent')
      : slots.findIndex(slot => slot.id === this.focusedId)
    if (current >= 0) this.pocketAt = current
    for (let walked = 0; walked < n; walked++) {
      this.pocketAt = (this.pocketAt + delta + n * 2) % n
      const slot = slots[this.pocketAt]
      // THE AGENT IS A CARD LIKE THE OTHERS. Stepping across it made the one
      // card you talk to most the only one the arrows could not reach, and
      // the pocket carousel — the same index space — stops on it happily.
      // Landing on it opens its chat, which is also what reading it means.
      if (slot?.kind === 'agent') { this.openAgent(); return }
      if (slot?.id) {
        const opened = this.deps.getTask(slot.id)
        if (opened) this.attentionAcknowledged.set(slot.id, opened.state)
      }
      // Cranking OUT of the Agent hands the surface to a task: the chat must
      // let go, or `agentOpen` would outlive the card it describes.
      this.leaveAgent()
      this.setFocus(slot?.id ?? null)
      this.reconcile()
      return
    }
  }

  /** Nail the pocket's order down for this visit. Idempotent. */
  private holdOrder(): void {
    if (!this.frozenOrder) {
      const tasks = this.pocketList()
      this.frozenOrder = tasks.map(t => t.id)
      this.frozenInputTimes = new Map(tasks.map(t => [t.id, this.addressedAt(t)]))
    }
  }

  /** Opening a task makes its provider reachable without counting as work. */
  /**
   * A SESSION LINK LANDS IN THE POCKET, NOT THE COCKPIT.
   *
   * `onFocusTask` sets `engaged = 'cockpit'`, which is right for its own
   * caller — a card clicked on the wall, where you are already in the cockpit
   * and clicking should not move you out of it. Reusing it for the Agent's
   * `unmute://task/<id>` link put people in the dashboard instead, which is a
   * different surface with different chrome and not where the pocket's
   * conversation lives.
   *
   * `addressed()` first, so a card that had scrolled out of the pocket is back
   * in it before its slot is looked up. Voice follows the pocket rather than
   * being set here: applyVoiceTarget reads the slot under `pocketAt` whenever
   * the pocket is open, which is the same path the pocket chord uses.
   *
   * If it is not pocketable at all — a one-off whose process is gone, say —
   * the cockpit is a correct place to land, so that is the fallback rather
   * than an error.
   */
  private onPocketFocusTask(id: string): void {
    this.leaveAgent()
    // REMOVING IS NEVER PERMANENT. "Remove from pocket" takes a card out; the
    // act of opening it is what puts it back, whoever does it — the person
    // tapping a link, or the Agent reopening the session. Without this the
    // flag would outlive its reason and the card could only be reached from
    // the orchestrator.
    this.deps.setInPocket(id, true)
    // Opening it is touching it. Without the stamp a session last spoken to
    // more than POCKET_IDLE_MS ago is not in the list at all — which is how a
    // link to a freshly resumed card fell through to the orchestrator.
    if (this.deps.getTask(id)) this.addressed(id)
    if (this.landing === id) this.landing = null
    const at = this.pocketSlots().findIndex((slot) => slot.kind !== 'agent' && slot.id === id)
    if (at < 0) { this.onFocusTask(id); return }
    this.engaged = 'none'
    this.pocketAt = at
    log.event('pocket-focus-task', { taskId: id, at, slots: this.pocketSlots().length })
    // A LINK OPENS THE CONVERSATION, not just its card. Landing on the pocket
    // row left one more tap between the person and the task they asked for.
    // The pocket is marked open WITHOUT being drawn first, so the expand
    // morphs straight into the task and Escape still returns to this card.
    this.pocketMode = 'open'
    this.onPocketExpand(id)
  }

  /**
   * A RESUMED OR FORKED SESSION LANDS IN THE POCKET, at the front, with the
   * voice aimed at it — whether or not anything was said to it.
   *
   * Before this, only a resume that CARRIED a message reached the pocket: the
   * message stamped the task's input clock, and nothing else did. A bare resume
   * of yesterday's session left it outside POCKET_IDLE_MS, so the card was
   * nowhere to be found and its link opened the orchestrator instead.
   *
   * It never opens the pocket. Something reopened on your behalf is news, not
   * a demand, so the bar says so quietly (`pocketLanded`) and the aim waits:
   *
   *   pocket open, nothing expanded  ->  the carousel moves to it now
   *   anything else                  ->  the next visit lands on it (`landing`)
   *
   * Sends the session nothing. Delivery is the caller's business and a resume
   * with no message must stay silent — this only moves cards.
   */
  landInPocket(id: string): void {
    const task = this.deps.getTask(id)
    if (!task) return
    this.deps.setInPocket(id, true)
    this.addressed(id)
    this.makeRoomFor(id)
    this.frozenOrder = null
    const slots = this.pocketSlots()
    const at = slots.findIndex((slot) => slot.kind !== 'agent' && slot.id === id)
    const aimNow = at >= 0 && this.pocketMode === 'open' && this.engaged === 'none'
    log.event('pocket-landed', { taskId: id, at, aimed: aimNow ? 'now' : 'next-visit', slots: slots.length })
    if (aimNow) {
      this.landing = null
      this.pocketAt = at
      this.stirPocket()
      this.applyVoiceTarget()
    } else {
      this.landing = id
      this.client.send({ type: 'pocketLanded', title: task.name ?? truncate(task.intent) })
    }
    this.reconcile()
  }

  /** Where a fresh visit to the pocket starts: on the landed card if one is
   *  pending, else card 1. */
  private freshVisitAt(): number {
    const landed = this.takeLanding(this.pocketSlots())
    return landed >= 0 ? landed : 0
  }

  /** The landed card's slot, consumed. Honoured only while it is still the task
   *  you touched last — touch another and that one is what you meant. */
  private takeLanding(slots: PocketSlotP[]): number {
    const id = this.landing
    this.landing = null
    if (!id) return -1
    const landed = this.deps.getTask(id)
    if (!landed) return -1
    const newer = this.pocketList().some((t) => t.id !== id && this.addressedAt(t) > this.addressedAt(landed))
    if (newer) return -1
    return slots.findIndex((slot) => slot.kind !== 'agent' && slot.id === id)
  }

  /** Over POCKET_LANDING_CAP, the least recently addressed card that is not
   *  waiting on you leaves the pocket. Never the one landing; never deleted. */
  private makeRoomFor(id: string): void {
    const inPocket = this.pocketList()
    let excess = inPocket.length - POCKET_LANDING_CAP
    if (excess <= 0) return
    const evictable = inPocket
      // WAITING ON YOU means BLOCKED on you — a question or an approval. A card
      // that merely finished is `demanding` for a while too, but nothing stops
      // for it, and protecting those would make the cap unreachable on a busy
      // day. The card on screen stays too.
      .filter((t) => t.id !== id && t.id !== this.focusedId && t.state !== 'needs-user' && !t.question)
      .sort((a, b) => this.addressedAt(a) - this.addressedAt(b))
    for (const t of evictable) {
      if (excess-- <= 0) break
      log.event('pocket-evicted', { taskId: t.id, for: id, cap: POCKET_LANDING_CAP })
      this.deps.setInPocket(t.id, false)
    }
  }

  private onFocusTask(id: string): void {
    this.leaveAgent()
    this.deps.setInPocket(id, true) // opening it from the wall is opening it
    this.engaged = 'cockpit'
    const opened = this.deps.getTask(id)
    if (opened) this.attentionAcknowledged.set(id, opened.state)
    this.setFocus(id)
    this.reconcile()
  }

  /**
   * THE POCKET CHORD — right Command held, right Option tapped.
   *
   * One gesture, and it goes one rung deeper each time it is pressed:
   *
   *     nothing open   ->  the pocket, on the card you last talked to
   *     pocket open    ->  that card, expanded
   *     already there  ->  nothing. Going deeper again would mean guessing.
   *
   * WHY THE SAME KEYS TWICE rather than a second binding: your hand never
   * leaves the chord, and neither rung needs the surface to hold keyboard
   * focus — which the arrow keys do. So the whole open → choose → expand path
   * works identically whether or not you have clicked away since.
   *
   * The ONE WAY OUT is Escape, exactly as it is everywhere else on this
   * surface. This gesture deliberately does not toggle: a key that opens on
   * press and closes on the next press cannot also mean "go deeper", and going
   * deeper is the thing worth having.
   */
  pocketChord(): void {
    if (this.engaged === 'task' || this.engaged === 'cockpit') {
      log.event('pocket-chord', { did: 'nothing', reason: 'already-expanded' })
      return
    }
    if (this.pocketMode === 'open') {
      // Rung two: into the card you are on. onPocketExpand does the rest,
      // including remembering you came from the pocket so Escape returns here.
      log.event('pocket-chord', { did: 'expand', at: this.pocketAt })
      this.onPocketExpand()
      return
    }
    // Rung one. A FRESH VISIT, so it re-sorts and lands on card 1 — the same
    // thing tapping the pocket open does, and the reason the order is worth
    // getting right.
    this.frozenOrder = null
    this.pocketAt = this.freshVisitAt()
    log.event('pocket-chord', { did: 'open', slots: this.pocketSlots().length })
    this.setPocketMode('open')
    this.reconcile()
  }

  // ── The Agent element's feed ──────────────────────────────────────────────
  //
  // Four calls, from the one place that runs an Agent turn. The controller owns
  // what the pocket does with them; init.ts owns nothing about presentation,
  // which is why the caption path could be deleted rather than rerouted.

  /** The user said something to the Agent. */
  agentAsked(text: string): void {
    this.agentBusy = true
    this.agentBaseBlocks = [...this.agentBaseBlocks,
      { kind: 'message', role: 'user', text: text.trim(), at: Date.now() }]
    this.mergeAgentBlocks()
    // WHAT THE CARD IS ABOUT TO SAY, and that it is now busy — so a card stuck
    // on "Thinking…" can be traced to the turn that never came back rather
    // than to the surface.
    log.ui('agent-card', { says: 'Thinking…', busy: true, turns: this.agentBlocks.length })
    if (this.agentOpen) this.sendAgentDetail()
    this.reconcile()
  }

  /** It answered. `failed` marks a turn that did not land. */
  agentAnswered(raw: string, failed = false): void {
    const at = Date.now()
    const text = raw.trim()
    this.agentBusy = false
    this.agentLine = { text: conciseLine(text), at, failed }
    this.agentAnswerAt = at
    this.agentBaseBlocks = [...this.agentBaseBlocks, failed
      ? { kind: 'error', message: text }
      : { kind: 'message', role: 'assistant', text, at }]
    this.mergeAgentBlocks()
    // UNREAD ONLY IF THEY ARE NOT ALREADY LOOKING AT IT. Coming to the front of
    // the pocket is how the Agent gets your attention; it does not need to when
    // it already has it, and marking it unread under an open chat would put a
    // card in front of the very thing it is a card for.
    if (!this.agentOpen) this.agentUnread = true
    if (this.agentOpen) this.sendAgentDetail()
    // AN ANSWER IS THE AGENT'S CARD ASKING FOR YOU, and the pocket is where it
    // arrives — the same claim a newly demanding task makes in onTransition, so
    // it earns the same fresh window to be read in. The Agent is not a task and
    // never passes through that path, which is the only reason this is here.
    this.stirPocket()
    log.event('agent-answered', { chars: text.length, failed, unread: this.agentUnread })
    // WHAT THE USER NOW SEES, AND WHERE. The card carries only the first line,
    // so the line itself is recorded — a report of "it said something odd" is
    // otherwise unanswerable once the chat has moved on.
    log.ui('agent-card', {
      says: this.agentLine?.text,
      cardChars: this.agentLine?.text.length ?? 0,
      fullChars: text.length,
      clipped: (this.agentLine?.text.length ?? 0) < text.length,
      failed,
      position: this.agentUnread ? 'front' : 'back',
      why: failed ? 'the turn failed'
        : this.agentOpen ? 'answered while you were reading it — stays where it is'
          : 'unread, so it comes to the front',
      turns: this.agentBlocks.length,
    })
    this.reconcile()
  }

  /**
   * The conversation was purged — the same decision that makes the provider
   * start a fresh session (continuity.ts). The card stays; it goes back to
   * saying what it says when there is nothing to say.
   */
  agentPurged(): void {
    const had = this.agentBlocks.length
    this.agentBaseBlocks = []
    this.agentLine = null
    this.agentRoutineLine = null
    this.agentAnswerAt = undefined
    this.mergeAgentBlocks()
    this.agentUnread = false
    this.agentBusy = false
    if (this.agentOpen) this.sendAgentDetail()
    log.ui('agent-card', {
      says: 'Ask me anything', position: 'back', turns: 0, dropped: had,
      why: 'the conversation was purged — the model is starting fresh too',
    })
    this.reconcile()
  }

  /** Is the Agent the thing the voice is currently addressing? */
  agentAddressed(): boolean {
    if (this.agentOpen) return true
    if (this.pocketMode !== 'open') return false
    const slots = this.pocketSlots()
    return slots[this.anchorPocket(slots)]?.kind === 'agent'
  }

  /**
   * THE CHAT IS NO LONGER THE SURFACE.
   *
   * Called from every transition that puts something else in front, rather
   * than trusted to reconcile's guard alone. The guard makes a stale flag
   * HARMLESS; this makes it not stale — and the difference shows the moment
   * you close the task you switched to, because a leftover `agentOpen` would
   * bring the chat back instead of the notch.
   */
  private leaveAgent(): void {
    if (!this.agentOpen) return
    this.agentOpen = false
    this.historyTask = null
    this.historyLimit = 10
    log.ui('agent-chat', { shown: false, why: 'another surface took the front' })
  }

  restoreAgentConversation({ record, snapshot, selectedProvider }: AgentConversationView): void {
    const previousAnswer = this.agentAnswerAt
    this.agentProvider = record.provider ?? undefined
    this.agentSelectedProvider = selectedProvider ?? record.pendingProvider ?? record.provider ?? 'claude'
    this.agentPendingProvider = record.pendingProvider
    this.agentModel = record.model
    this.agentBusy = !snapshot.settlementPending && (record.phase === 'sending' || !!record.prepared && record.phase !== 'recovery-required')
    this.agentError = snapshot.error
    this.agentCanRetry = !!snapshot.settlementPending || (!!snapshot.error || snapshot.retryRequired === true) && record.phase !== 'recovery-required' && snapshot.queued.length > 0
    if (snapshot.draft.revision >= this.agentDraftRevision) {
      this.agentDraft = snapshot.draft.text; this.agentDraftRevision = snapshot.draft.revision
    }
    const toBlocks = (turn: AgentConversationView['snapshot']['chat']['turns'][number]): Block[] => [
      ...(turn.notice ? [{ kind: 'notice' as const, text: turn.notice }] : []),
      turn.failed
        ? { kind: 'error' as const, message: turn.text }
        : { kind: 'message' as const, role: turn.role === 'user' ? 'user' as const : 'assistant' as const, text: turn.text, at: turn.at },
      // What you captured with it, under your message — the same tiles a task
      // draws for what you attached, in the same place.
      ...(turn.attachments ?? []).map(a => ({
        kind: 'attachment' as const, path: a.path, name: a.name, mimeType: a.mimeType,
        ...(a.bytes !== undefined ? { bytes: a.bytes } : {}), role: 'user' as const,
      })),
    ]
    // WHAT YOU SEE STOPS WHERE THE MODEL'S MEMORY STOPS. A fresh provider
    // session — a switch, a rotation — keeps every earlier message on screen,
    // but the model only has its own session plus a short handoff. 130 messages
    // read as one conversation while it remembered a dozen (2026-09-16). The
    // current session begins at its first accepted submission; `accepted` is
    // emptied on every fresh start, so this holds for chats saved before the
    // divider existed too.
    const turns = snapshot.chat.turns
    const sessionStart = record.runId ? record.accepted[0]?.acceptedAt : undefined
    const split = sessionStart === undefined ? 0 : turns.findIndex(turn => turn.at >= sessionStart)
    const earlier = split === -1 ? turns : turns.slice(0, split)
    const current = split === -1 ? [] : turns.slice(split)
    const freshNotice = !!snapshot.notice && /^(Switched to|Started a fresh conversation)/.test(snapshot.notice)
    this.agentBaseBlocks = [
      ...earlier.flatMap(toBlocks),
      ...(earlier.length && sessionStart !== undefined ? [{ kind: 'sessionBoundary' as const, text: sessionDivider(sessionStart, snapshot.notice) }] : []),
      ...current.flatMap(toBlocks),
    ]
    // Opens on the current session alone; earlier ones sit behind "Load earlier".
    this.agentSessionMessages = earlier.length ? Math.max(1, current.filter(turn => !turn.failed).length) : 0
    if (this.historyTask === NotchController.AGENT_SLOT && this.agentSessionMessages) {
      this.historyLimit = Math.max(this.historyLimit, this.agentSessionMessages)
    }
    if (snapshot.notice && !freshNotice) this.agentBaseBlocks.unshift({ kind: 'message', role: 'assistant', text: snapshot.notice })
    if (snapshot.error) this.agentBaseBlocks.push({ kind: 'error', message: snapshot.error })
    this.agentChatStartedAt = snapshot.chat.startedAt ?? 0
    // A spoken routine line belongs to the conversation it was spoken into.
    if (this.agentRoutineLine && this.agentRoutineLine.at < this.agentChatStartedAt) this.agentRoutineLine = null
    const answer = [...snapshot.chat.turns].reverse().find(t => t.role === 'agent')
    this.agentAnswerAt = answer?.at
    const answerLine = answer ? { text: conciseLine(answer.text), at: answer.at, failed: !!answer.failed } : null
    // A spoken routine result newer than the last answer keeps the card's line.
    this.agentLine = this.agentRoutineLine && this.agentRoutineLine.at > (answerLine?.at ?? -Infinity) ? this.agentRoutineLine : answerLine
    if (answer && answer.at !== previousAnswer && !this.agentOpen) this.agentUnread = true
    this.rebuildAgentBlocks()
    this.reconcile()
  }

  /**
   * ROUTINE RUNS, MERGED INTO THE AGENT'S CHAT (spec §5).
   *
   * The first view only seeds what has already ended: a relaunch must not
   * re-announce every old result, so unread comes from the run records alone.
   * After that, a run that newly ends with a posted result is news — unread
   * when the chat is closed, and the card's line when the routine speaks.
   */
  restoreRoutines(view: RoutinesView): void {
    this.routinesView = view
    const ended = view.runs.filter(r => r.posted && r.endedAt !== undefined && ROUTINE_TERMINAL.has(r.status))
    if (this.seenRoutineEnds === null) {
      this.seenRoutineEnds = new Map(ended.map(r => [r.id, r.endedAt!]))
      if (view.runs.some(r => r.unread) && !this.agentOpen) this.agentUnread = true
    } else {
      let readWhileOpen = false
      for (const run of ended) {
        if (this.seenRoutineEnds.get(run.id) === run.endedAt) continue
        this.seenRoutineEnds.set(run.id, run.endedAt!)
        if (this.agentOpen) readWhileOpen = true
        else this.agentUnread = true
        // Text only: a failed routine shows in its own result block, never by
        // making the whole Agent look failed.
        if (run.speak) {
          this.agentRoutineLine = { text: conciseLine(`${run.name}: ${firstLine(run.resultPreview)}`), at: run.endedAt!, failed: false }
          this.agentLine = this.agentRoutineLine
        }
      }
      // Landed under an open chat: already read, so a relaunch must not re-front it.
      if (readWhileOpen) {
        void this.deps.routineAction?.({ type: 'markRead' }).catch(error => log.warn('routine markRead failed', { error: (error as Error).message }))
      }
    }
    // Full results only for what the chat will actually show.
    for (const entry of routineEntries(view.runs, { since: this.agentChatStartedAt })) {
      const block = entry.block
      if (block.kind === 'routineResult' && block.status === 'done' && !this.routineResults.has(block.what)) this.fetchRoutineResult(block.what)
    }
    if (this.routineDetailRunId !== null && this.routineRunDetail) {
      const was = this.routineRunDetail.run
      const now = view.runs.find(r => r.id === was.id)
      if (now && (now.status !== was.status || now.endedAt !== was.endedAt || now.activity.length !== was.activity.length)) {
        this.fetchRoutineDetail(was.id)
      }
    }
    this.rebuildAgentBlocks()
    this.reconcile()
  }

  private mergeAgentBlocks(): void {
    this.agentBlocks = this.routinesView
      ? mergeRoutineBlocks(this.agentBaseBlocks,
        routineEntries(this.routinesView.runs, { since: this.agentChatStartedAt, results: this.routineResults }),
        { busy: this.agentBusy })
      : [...this.agentBaseBlocks]
  }

  private rebuildAgentBlocks(): void {
    this.mergeAgentBlocks()
    if (this.agentOpen) this.sendAgentDetail()
  }

  /** At most once per run id; a missing result keeps the preview. */
  private fetchRoutineResult(runId: string): void {
    const fetch = this.deps.routineRunDetail
    if (!fetch || this.routineResultFetches.has(runId)) return
    this.routineResultFetches.add(runId)
    void fetch(runId).then(detail => {
      if (detail?.result == null) return
      this.routineResults.set(runId, detail.result)
      this.rebuildAgentBlocks()
    }).catch(error => log.warn('routine result fetch failed', { runId, error: (error as Error).message }))
  }

  /** The open run sheet's run, one fetch in flight at a time. */
  private fetchRoutineDetail(runId: string): void {
    const fetch = this.deps.routineRunDetail
    if (!fetch) return
    // A request made mid-flight (another run opened, a cancel landed) is not
    // dropped: it is fetched again once the current one settles.
    if (this.routineDetailFetching) { this.routineDetailStale = true; return }
    this.routineDetailFetching = true
    void fetch(runId).then(detail => {
      if (this.routineDetailRunId !== runId) return
      this.routineRunDetail = detail
      if (this.agentOpen) this.sendAgentDetail()
    }).catch(error => this.agentUnavailable((error as Error).message)).finally(() => {
      this.routineDetailFetching = false
      if (!this.routineDetailStale) return
      this.routineDetailStale = false
      if (this.routineDetailRunId !== null) this.fetchRoutineDetail(this.routineDetailRunId)
    })
  }

  agentUnavailable(message: string): void {
    this.agentError = message
    if (this.agentOpen) this.sendAgentDetail()
  }

  private sendAgentDraft(submissionId?: string, revision = this.agentDraftRevision): void {
    const text = this.agentDraft.trim()
    if (!text || !this.deps.agentSend || revision !== this.agentDraftRevision) return
    if (this.agentEnqueue?.revision === revision) return
    const submission = { revision, submissionId: submissionId ?? randomUUID() }
    this.agentEnqueue = submission
    void this.deps.agentSend(text, submission).then(() => {
      if (this.agentDraftRevision === revision && this.agentDraft.trim() === text) this.agentDraft = ''
    }).catch(error => this.agentUnavailable((error as Error).message)).finally(() => {
      if (this.agentEnqueue === submission) this.agentEnqueue = null
      this.scheduleReconcile()
    })
  }

  /** Live-settable from Settings → Appearance & notch. */
  setAutoExpand(on: boolean): void {
    this.autoExpand = on
    log.info('auto-expand', { on })
  }

  /** Re-publish the currently visible detail after main-owned draft state
   * changes outside a native UI event (for example, Right Option capture). */
  refresh(): void { this.reconcile() }
  /** Re-send the open Agent chat — its model choices changed. */
  refreshAgent(): void { if (this.agentOpen) this.sendAgentDetail() }
  openTask(id: string): void { this.onFocusTask(id) }

  private setFocus(id: string | null): void {
    this.focusedId = id
    // The surface moved. Anything but a re-render of the SAME task means that
    // composer is no longer where the user is typing, so it stops being the
    // place captured images go. leave() routes through here with null, so
    // pocketing and collapsing are covered by this one line too.
    this.applyComposerFocus({ kind: 'surface-changed', taskId: id })
    // A task taking focus is the voice leaving the Agent. Not every route here
    // passes through applyVoiceTarget, and at submit a raised Agent flag
    // outranks the focused task — so a stale one sent your words to the Agent.
    if (id) this.deps.addressAgent?.(false)
    this.deps.focus(id) // focus IS the voice address (consent model)
    // Every route onto the expanded task surface — dashboard selection,
    // pocket expansion, Prev/Next, and programmatic open — has already set the
    // engagement rung before it gets here. Make the task reachable as part of
    // opening it; browsing the compact pocket remains process-free.
    if (id && (this.engaged === 'cockpit' || this.engaged === 'task')) this.deps.opened?.(id)
    if (id) {
      // ACKNOWLEDGMENT IS NOT CLEARED HERE, and that was the bug behind "I
      // closed them and the bar still says three". Closing a finished thread
      // acknowledges it, then the return to the pocket called applyVoiceTarget
      // → setFocus → and this line reactivated the very task you had just
      // dismissed, so it went straight back to demanding. Aiming the carousel
      // at something is not asking to hear about it again. Acknowledgment ends
      // when you explicitly open or message the task, or its state changes.
      // DELIBERATELY DOES NOT COUNT AS ENGAGEMENT. Every route into a task
      // passes through here, including the carousel, so recording it made
      // browsing re-rank the list you were browsing — and the slot under your
      // index changed between choosing it and drawing it. Engagement is stamped
      // recorded by the task's own `updatedAt` instead, which only a real
      // status change moves.
    }
  }

  /**
   * Closing a task the user actually LOOKED AT means they've seen it.
   *
   * Opening used to CLEAR the mute and nothing ever set it, so the one gesture
   * that most obviously means "I've seen this" was the only one that didn't
   * quiet the notch — a finished one-off held the surface indefinitely.
   *
   * Closing acknowledges the attention EPISODE, not the underlying task. A
   * blocked task remains blocked and reachable in the pocket/dashboard, but an
   * unchanged poll cannot repeatedly demand the screen after the user has
   * dismissed it. A real state change clears the acknowledgment in
   * onTransition(), so a new question or failure can demand attention again.
   *
   * Both explicit mute and dismissal write the same acknowledgment primitive,
   * so "comes back the moment its state changes" has one implementation.
   * Quieting is never removal: the task drops out of the demanding group and
   * lands in reach, one press away.
   */
  private seenThenClose(opts: { collapse?: boolean } = {}): void {
    this.historyLimit = 10
    this.historyTask = null
    // THE CHAT CLOSES LIKE ANYTHING ELSE. Without this the controller goes on
    // believing the Agent is the expanded surface — so the voice stays pointed
    // at it after you have left, and a later answer never marks itself unread
    // because it thinks you are looking at it.
    if (this.agentOpen) {
      this.agentOpen = false
      // Coming back from the Agent lands in the pocket, exactly as coming back
      // from a task does — you were in the pocket when you opened it.
      if (this.cameFromPocket) {
        this.cameFromPocket = false
        this.engaged = 'none'
        // COME BACK TO THE CARD, NOT TO THE POSITION. Reading the Agent is
        // exactly what moves it from the front of the pocket to the back, so
        // the index you left on now points at some other card entirely. Follow
        // the thing you were looking at.
        // Unless the Agent just reopened a session for you: then the card it
        // brought back is the one you came back for.
        const slots = this.pocketSlots()
        const landed = this.takeLanding(slots)
        const back = landed >= 0 ? landed : slots.findIndex((sl) => sl.kind === 'agent')
        if (back >= 0) this.pocketAt = back
        this.setPocketMode('open')
        this.applyVoiceTarget()
        this.reconcile()
        return
      }
      this.engaged = 'none'
      this.applyVoiceTarget()
      this.reconcile()
      return
    }
    const id = this.focusedId
    const t = id ? this.deps.getTask(id) : undefined
    if (t && this.demanding(t)) {
      this.attentionAcknowledged.set(t.id, t.state)
      this.queue = this.queue.filter((x) => x !== t.id)
      log.event('seen-on-close', { taskId: t.id, state: t.state })
    }
    if (opts.collapse) this.engaged = 'none'
    // BACK TO WHERE YOU CAME FROM. If this task was expanded out of an open
    // pocket, closing it returns you to that pocket — same order, same place in
    // it. Anything else collapses as before. Without this, Escape from a card
    // you opened out of the pocket dumped you on the bare notch and you had to
    // reopen and re-find your place, which is the opposite of what the pocket
    // is for.
    if (this.cameFromPocket) {
      this.cameFromPocket = false
      this.engaged = 'none'
      this.frozenOrder = null
      const restored = this.pocketSlots().findIndex(slot => slot.id === id)
      if (restored >= 0) this.pocketAt = restored
      this.setPocketMode('open')
      this.applyVoiceTarget()
      this.reconcile()
      return
    }
    // Leaving RELEASES THE ORDER, so the next visit sorts by what you last
    // worked in rather than preserving a walk you already finished.
    this.frozenOrder = null
    this.setFocus(null)
    this.setPocketMode('closed')
    this.reconcile()
  }

  /** "Don't show this again": out of the attention strip + crank until the user
   *  interacts with it or its state changes. Still a cockpit card. */
  private onMute(id: string): void {
    const t = this.deps.getTask(id)
    if (!t) return
    this.attentionAcknowledged.set(id, t.state)
    this.queue = this.queue.filter((x) => x !== id)
    if (this.focusedId === id) {
      this.focusedId = null; this.deps.focus(null)
      // Only muting the OPEN task can end the engagement; muting another one
      // must not collapse what you are looking at.
      if (this.queue.length === 0 && this.engaged === 'task') this.engaged = 'none'
    }
    this.client.send({ type: 'toast', text: 'muted — back when it changes or you open it' })
    this.reconcile()
  }

  private onChoose({ id, index, reference }: { id: string; index: number; reference?: QuestionReference }): void {
    const t = this.deps.getTask(id)
    if (!this.acceptsReference(id, reference)) { if (reference) this.rejectReference(id, reference); return }
    if (!Number.isInteger(index) || index < 0 || index >= (t?.question?.choices?.length ?? 0)) { if (reference) this.rejectReference(id, reference); return }
    const label = t?.question?.choices?.[index]
    if (label == null) return
    this.submitAnswer(id, label, true, reference)
  }

  private answerStates = new Map<string, { reference: QuestionReference; state: 'pending' | 'accepted' }>()
  private rejectReference(id: string, reference: QuestionReference): void {
    const state = this.answerStates.get(id) ?? this.deps.getTask(id)?.questionAcknowledgment
    this.client.send({ type: 'questionAnswerStatus', id, reference, state: sameQuestion(state?.reference, reference) ? state!.state : 'rejected' })
  }
  private acceptsReference(id: string, reference?: QuestionReference): boolean {
    const t = this.deps.getTask(id), current = t?.question?.reference
    if (!current && !reference) return !!t // legacy paths retain their existing refusal behavior
    const acknowledgment = this.answerStates.get(id)
    return sameQuestion(current, reference) && !sameQuestion(acknowledgment?.reference, reference)
      && !sameQuestion(t?.questionAcknowledgment?.reference, reference)
      && !t?.question?.acknowledgment
  }
  private answerStatus(id: string, reference: QuestionReference, state: 'pending' | 'accepted' | 'rejected'): void {
    if (state === 'rejected') {
      if (sameQuestion(this.answerStates.get(id)?.reference, reference) && this.answerStates.get(id)?.state !== 'accepted') this.answerStates.delete(id)
    } else if (state === 'pending' || !this.answerStates.has(id) || sameQuestion(this.answerStates.get(id)?.reference, reference)) this.answerStates.set(id, { reference, state })
    this.client.send({ type: 'questionAnswerStatus', id, reference, state })
    this.scheduleReconcile()
  }
  private answeringIds = new Set<string>()
  private submitAnswer(id: string, text: string, advance: boolean, reference?: QuestionReference): void {
    if (!this.acceptsReference(id, reference)) { if (reference) this.rejectReference(id, reference); return }
    if (!this.deps.answerAsync) {
      if (reference) { this.answerStatus(id, reference, 'rejected'); this.toast('Structured answers are unavailable in this build.'); return }
      if (this.deps.answer(id, text)) { this.addressed(id); if (reference) this.answerStatus(id, reference, 'accepted'); if (advance) this.advanceAfterAnswer(id) }
      else this.scheduleReconcile()
      return
    }
    if (this.answeringIds.has(id)) { if (reference) this.rejectReference(id, reference); return }
    this.answeringIds.add(id)
    if (reference) this.answerStatus(id, reference, 'pending')
    void this.deps.answerAsync(id, text, reference).then(accepted => {
      if (reference) this.answerStatus(id, reference, accepted ? 'accepted' : 'rejected')
      if (accepted) this.addressed(id)
      if (accepted && advance && this.deps.getTask(id)?.state !== 'needs-user') this.advanceAfterAnswer(id)
    }).catch(error => { if (reference) this.answerStatus(id, reference, 'rejected'); this.toast(`Could not send answer: ${(error as Error).message}`) })
      .finally(() => { this.answeringIds.delete(id); this.scheduleReconcile() })
  }

  /** Throughput loop: answering advances to the next queued your-move task. */
  private advanceAfterAnswer(id: string): void {
    // NOT MID-UTTERANCE. The answer can land seconds after it was sent (the
    // async path), by which time the person may be speaking to this task —
    // advancing now would send the rest of the sentence to the next one
    // (and moving the pocket index would move the card under them).
    if (this.capturing()) { this.scheduleReconcile(); return }
    // HOLD THE ORDER ACROSS THE ANSWER. Answering IS engagement, and engagement
    // drives the sort — so without the hold the task you just replied to would
    // sort straight back to the front and "advance" would land you on it again.
    this.holdOrder()
    // ADVANCE MEANS PAST THIS ONE. Dropping it from the held order is what
    // makes the next thing the next thing — leave it in and `front()` reads
    // position 0 and hands you straight back the task you just answered.
    // pocketOrder() re-appends it at the END if it is still demanding, which is
    // precisely the old skip-to-the-back behaviour.
    if (this.frozenOrder) this.frozenOrder = this.frozenOrder.filter((x) => x !== id)
    this.pocketAt = 0
    this.queue = this.queue.filter((x) => x !== id)
    const next = this.front()
    if (next && (this.engaged === 'task' || this.focusedId === id)) this.setFocus(next.id)
    else if (this.focusedId === id) this.setFocus(null)
    this.scheduleReconcile()
  }

  private async onPinSkill(name: string, pinned: boolean): Promise<void> {
    await this.deps.pinSkill(name, pinned)
    await this.refreshRails(true)
    this.reconcile()
  }

  /** Tap-to-invoke: types `/name ` unsubmitted into the FOCUSED, ALIVE task. */
  private async onTapSkill(name: string): Promise<void> {
    const id = this.focusedId
    const t = id ? this.deps.getTask(id) : undefined
    if (!id || !t) {
      this.client.send({ type: 'toast', text: 'Open a task first to add /' + name + ' to its draft' })
      return
    }
    const accepted = await Promise.resolve(this.deps.tapSkill(id, name)).catch(() => false)
    this.client.send({ type: 'toast', text: accepted
      ? `Added /${name} to draft`
      : `Can't add /${name}: open an Unmute-managed chat first` })
    this.scheduleReconcile()
  }

  private async onOfferAccept(newTaskId: string): Promise<void> {
    await this.deps.acceptRouteOffer(newTaskId)
    this.routeOffer = null
    this.reconcile()
  }

  private onTermOpen(id: string): void {
    this.openTerms.add(id)
    // ALWAYS send, even when there's nothing buffered yet: this is the one
    // definitive "replay is done" signal SwiftTerm's replay gate has to key
    // off, so a brand-new task with an empty history still gets told it's
    // safe to go live — see TerminalReplayGate.swift.
    const replay = this.deps.getOutput(id)
    this.client.send({ type: 'termData', id, data: Buffer.from(replay, 'utf8').toString('base64') })
  }

  // ── curator popup ──────────────────────────────────────────────────────────

  private conversing = new Set<string>()

  private async onSuggestionOpen(id: string): Promise<void> {
    const p = await this.deps.getProposal(id)
    if (!p) { this.client.send({ type: 'toast', text: 'proposal no longer pending' }); return }
    this.client.send({ type: 'proposal', data: this.toProposalDetail(p) })
  }

  private async onSuggestionAccept(id: string): Promise<void> {
    const res = await this.deps.acceptProposal(id)
    this.client.send({ type: 'toast', text: res.ok ? 'skill saved' : `couldn't accept — ${res.error ?? 'unknown error'}` })
    this.deps.converseStop(id)
    this.conversing.delete(id)
    await this.refreshRails(true)
    this.reconcile()
  }

  private async onSuggestionReject(id: string, reason: string): Promise<void> {
    await this.deps.rejectProposal(id, reason)
    this.deps.converseStop(id)
    this.conversing.delete(id)
    await this.refreshRails(true)
    this.reconcile()
  }

  /** First write lazily spawns the review conversation (a real CC session). */
  private async onConverseWrite(id: string, text: string): Promise<void> {
    if (!this.conversing.has(id)) {
      const ok = await this.deps.converseStart(id, (chunk) =>
        this.client.send({ type: 'convData', id, text: chunk }))
      if (!ok) { this.client.send({ type: 'toast', text: 'could not start the review session' }); return }
      this.conversing.add(id)
    }
    this.deps.converseWrite(id, text + '\r')
    this.addressed(id)
  }

  // ── external notifications (init forwards these) ───────────────────────────

  /**
   * The capture surface's "listening → transcribing → routing" line, and what
   * it says the words are aimed at.
   *
   * NO TARGET MEANS NO TARGET. This used to fall back to the focused task when
   * `taskId` was null, which read as helpful and was a lie in the one case
   * that matters: an Agent capture is ALWAYS null here — pressing its own key
   * is a statement about who you are talking to — so with a task in the pocket
   * the notch announced that task as the destination while the utterance went,
   * correctly, to the Agent. A dictation had the same problem for the same
   * reason. The caller knows what this capture is addressed at; when it says
   * nothing, that is the answer.
   */
  notifyCapturePhase(phase: string, taskId: string | null): void {
    // TALKING TO THE CARD IS USING THE CARD. While the pocket is open the voice
    // is aimed at it, so any capture at all — start, transcribe, land — is this
    // person working the pocket, and the idle clock has to hear about it. It
    // cannot come through the `on` wrapper: a capture is not a surface gesture,
    // it arrives from the host. Without this, speaking for ten seconds inside
    // an open window still left the card closing fifteen seconds later.
    this.stirPocket()
    // LANDED. `idle` with a task on it is the router reporting where the
    // utterance actually went, and speaking to a task is the plainest form of
    // talking to it there is — but it never passes through a handler here, so
    // without this the one thing the pocket is FOR would not move the order.
    // Recency advances on accepted user input, not on a capture ending.
    const t = taskId ? this.deps.getTask(taskId) : undefined
    const target = t ? (t.name ?? truncate(t.intent)) : undefined
    this.client.send({ type: 'capturePhase', phase, target })
    // Past `listening` the destination is settled — apply anything held back.
    if (phase !== 'listening') this.afterCapture()
  }

  /** Is an expanded surface (a task, the Agent chat, the dashboard) open? Hosts
   *  ask before raising another app over it on a task's behalf. */
  holdsSurface(): boolean {
    return this.engaged !== 'none'
  }

  /** The pad changed. Pushed verbatim — the payload is built by the one
   *  function that announces a pad change, so the surface can never see the pad
   *  and the arm state from two different instants. */
  notifyScratchpad(payload: ScratchpadPayloadP): void {
    this.client.send({ type: 'scratchpad', data: payload })
  }

  notifyRouteOffer(offer: { newTaskId: string; altTaskId: string; altName: string } | null): void {
    this.routeOffer = offer
    this.reconcile()
  }

  private titleOf(id: string): string | undefined {
    const t = this.deps.getTask(id)
    return t ? (t.name ?? truncate(t.intent)) : undefined
  }

  // ── payload builders ───────────────────────────────────────────────────────

  private async refreshRails(force = false): Promise<void> {
    try {
      const [skills, projects, proposals, importable] = await Promise.all([
        this.deps.listSkills(), this.deps.listProjects(), this.deps.listProposals(),
        this.deps.listImportable?.() ?? Promise.resolve([]),
      ])
      this.skills = skills; this.projects = projects; this.proposals = proposals
      this.importable = importable
    } catch (e) {
      log.warn('rails refresh failed', { error: (e as Error).message })
    }
    if (!this.railsTimer) {
      this.railsTimer = setInterval(() => { if (this.engaged === 'cockpit') void this.refreshRails() }, 5 * 60 * 1000)
      this.railsTimer.unref?.()
    }
    if (force) this.reconcile()
  }

  private computeDigest(): void {
    if (this.digestDismissed) return
    const last = this.deps.getLastSeen()
    if (!last || Date.now() - last < AWAY_MS) { this.digestText = null; return }
    const tasks = this.deps.listTasks()
    const needs = tasks.filter((t) => classify(t.state) !== null && !t.pocketRemoved).length
    const finished = tasks.filter((t) => t.state === 'done' && (t.updatedAt ?? 0) > last).length
    this.digestText = (needs || finished)
      ? `while you were away: ${needs} need${needs === 1 ? 's' : ''} you · ${finished} errand${finished === 1 ? '' : 's'} finished`
      : null
  }

  /** THE NOTCH'S OWN FADE RULE — deliberately NOT the wall's.
   *
   *  This used to be called visibleOnWall and claimed to mirror the renderer.
   *  It no longer does: Pack C replaced the renderer's rule with a 24-hour
   *  window, and this one kept the old behaviour — sessions never fade, done
   *  one-offs fade after 15m, errored/stuck after 60m. Being out of the pocket
   *  does not hide a task here: the wall is the orchestrator, and it holds
   *  everything.
   *
   *  Keeping them separate is CORRECT. The notch answers "what is going on
   *  right now" and must not drop a live session because a filter in another
   *  window says so. The wall answers "what should I be looking at", and there
   *  a 46-day-old card is noise. Two questions, two rules.
   *
   *  What was wrong was the shared NAME, which invited someone editing one to
   *  assume they had edited both. Renamed so the next person has to choose. */
  private notchVisible(t: TaskLite, now: number): boolean {
    if (t.kind === 'session') return true
    if ((t.updatedAt ?? 0) <= this.clearedAt && (t.state === 'done' || t.state === 'failed' || t.state === 'ready')) return false
    if (t.state === 'done') return now - (t.updatedAt ?? 0) < FADE_DONE_MS
    if (t.state === 'failed' || t.state === 'stuck') return now - (t.updatedAt ?? 0) < FADE_ERR_MS
    return true
  }

  private dirLabel(t: TaskLite): string | undefined {
    const cwd = t.cwd ?? ''
    if (!cwd) return undefined
    if (cwd.includes('/.unmute/')) return undefined // scratch one-off dirs aren't projects
    const home = process.env.HOME ?? ''
    return home && cwd.startsWith(home) ? '~' + cwd.slice(home.length) : cwd
  }

  private toCard(t: TaskLite, now: number, qpos: Map<string, number>): CardP {
    return {
      id: t.id,
      title: t.name ?? truncate(t.intent),
      origin: t.origin ?? undefined,
      agentRunId: t.agentRunId ?? undefined,
      activity: headlineFor(t),
      status: t.state,
      kind: t.kind ?? 'oneoff',
      dir: this.dirLabel(t),
      age: relativeAge(t.createdAt, now),
      qpos: qpos.get(t.id),
      promoted: (this.promotedUntil.get(t.id) ?? 0) > now || undefined,
      agent: t.spawnedBy ? true : undefined,
      // Driven by the registry, not by naming one backend. Written as
      // `=== 'codex-desktop'` these silently excluded the next driver backend:
      // a Claude Desktop card arrived with no backend, so the Swift side read
      // it as a PTY task and gave it a terminal's frame with nothing in it.
      // ALWAYS SENT, for every backend. This used to be driver-only, so a
      // Codex CLI card arrived with no backend at all and the wall's label
      // fell through to its default — "Claude Code CLI" printed on a Codex
      // task. Absent must mean "we do not know", never "it is the default one".
      backend: t.agent ?? 'claude',
      /** Does it own a terminal? A capability, so the mark's terminal glyph
       *  follows the registry rather than a list of backend names. */
      terminal: providerOf(t.agent).hasTerminal,
      project: t.agent === 'codex-desktop' ? (t.codexProject ?? undefined) : undefined,
      // Absent stays absent (D6) — the card renders the agent alone.
      model: t.model || undefined,
      note: t.note ?? undefined,
      // A CODEX THREAD IS NEVER DEAD. `alive` means "has a live PTY", and every
      // consumer reads it as "can you still talk to this?" — for which the
      // answer here is always yes: the thread lives in Codex until the user
      // deletes it there. Reporting false is what put a finished Codex chat
      // behind "resume — continue with full context" / "re-run fresh", offering
      // to revive something that had never stopped.
      alive: providerOf(t.agent).transport === 'driver' ? true : (t.alive ?? false),
    }
  }

  private toDetail(t: TaskLite): TaskDetailP {
    const now = Date.now()
    // Once: this runs on every reconcile, and the window is also what decides
    // whether the remainder below is a known count or an unknown one.
    const windowed = messageWindow(t.blocks ?? [], this.historyLimit)
    // ANY driver backend, not just Codex. This one line is why Claude Desktop
    // cards rendered with an empty body: `external` was false, so the branch
    // below — the branch that sends the CONVERSATION — never ran, and the card
    // had literally nothing to draw.
    const external = providerOf(t.agent).transport === 'driver'
    return {
      id: t.id,
      canEditLatestMessage: this.deps.canEditLatestMessage?.(t.id) ?? false,
      title: t.name ?? truncate(t.intent),
      origin: t.origin ?? undefined,
      agentRunId: t.agentRunId ?? undefined,
      // WHETHER THERE IS A LIVE TERMINAL, decided here and sent, rather than
      // re-derived on the Swift side from its own list of desktop backends.
      // Those two lists had already drifted — the Swift one named a
      // 'claude-code-desktop' that does not exist in AgentKind — and this is
      // what picks the expanded surface's share of the screen (80% for a
      // terminal, 60% for a conversation). One registry, one answer.
      terminal: providerOf(t.agent).hasTerminal,
      // CAPABILITIES, NOT A NAME. Nine places in Swift still asked
      // `backend == "codex-desktop"` to decide whether to offer Resume, whether
      // the destructive button says Kill or Remove, whether there is a process
      // at all. Every one of them is a negation of one backend, and every one
      // silently mis-answers for the next backend to arrive — which is exactly
      // how the Codex CLI model picker shipped empty. The registry already
      // knows; it just was not being told to the view.
      resumable: providerOf(t.agent).canResume && t.chatResumable !== false,
      resuming: t.resuming ?? false,
      ...(t.resumeError ? { resumeError: t.resumeError } : {}),
      /** True when Unmute spawned the process — so killing it is ours to do.
       *  A driver-backed task has nothing of ours to kill; the card offers
       *  Remove instead, which forgets it without touching the user's app. */
      owned: providerOf(t.agent).transport === 'structured' && t.chatOwned !== false,
      canStop: canStopTask(t),
      canCompose: providerOf(t.agent).transport === 'structured' && t.chatWritable !== false,
      // THE CONVERSATION IS SENT FOR EVERY BACKEND NOW.
      //
      // It used to be gated on `external`, because it was conceived as "what a
      // driven backend has INSTEAD of a terminal". That made the stage an
      // either/or, and a Claude task lost: it showed a raw PTY and no messages,
      // so the one thing a returning user wants — what did I ask, what came
      // back — was only reachable by reading scrollback.
      //
      // A Claude session's turns come from Claude's own transcript
      // (transcript.ts), so all three backends now speak the same shape and the
      // stage can show the message AND the terminal. `terminal` above still
      // says whether there is a PTY to draw underneath it.
      conversation: (t.conversation ?? []).slice(-this.historyLimit),
      // THE CHAT VIEW. Read from the agent's own source, so an OLD thread shows
      // its full history the moment it is opened — the source file outlives the
      // card, and outlived the version of Unmute that could not read it.
      ...windowed,
      ...(!t.blocks?.length ? { olderMessages: Math.max(0, (t.conversation?.length ?? 0) - this.historyLimit) }
        // UNKNOWN IS NOT NONE, AND ONLY ZERO IS AMBIGUOUS.
        //
        // messageWindow counts what is LOADED. When that count is positive it
        // is a true lower bound and worth keeping — the reader gets a number,
        // and pressing the control fetches whatever lies beyond it anyway.
        // When it is zero the two cases collapse: a conversation with nothing
        // older looks exactly like a one-turn replay tail with a hundred turns
        // still on disk. Only the durable mark separates them, and without it
        // the honest answer is "more, count unknown" — which is -1 downstream.
        : t.blocksDurable || windowed.olderMessages > 0 ? {} : { olderMessages: -1 }),
      ...(t.usage ? { usage: t.usage } : {}),
      // ALWAYS SENT — the same fix toCard needed, in the payload one surface
      // over. Driver-only meant a Codex CLI task's expansion arrived with no
      // backend at all, so the mark fell back to Claude: the pocket showed
      // Codex and opening the very same task showed Claude.
      backend: t.agent ?? 'claude',
      ...(external && t.codexProject ? { project: t.codexProject } : {}),
      status: t.state,
      kind: t.kind ?? 'oneoff',
      alive: external ? true : (t.alive ?? false),
      dir: this.dirLabel(t),
      age: relativeAge(t.updatedAt, now),
      elapsed: relativeAge(t.createdAt, now),
      warmup: t.threadContext ?? undefined,
      note: t.note ?? undefined,
      // A delivery problem belongs next to the composer, where the retry is —
      // and unlike `error` it must never be read as "the work failed".
      deliveryError: t.deliveryError ?? undefined,
      sending: (t.sending || this.deps.draftSubmitting?.(t.id)) ?? undefined,
      // What this thread runs on. Shown in the composer because "which model is
      // this" is part of writing the next message.
      //
      // codexModelLabel first — it is Codex's own phrasing ("5.6 Terra High"),
      // which is what a Codex user recognises. But it is set at creation and
      // never persisted, so it is gone after a restart and the composer used to
      // go blank. `model` is the persisted fact (Pack F, D6) and carries it
      // through. Neither is ever invented: absent stays absent.
      modelLabel: t.codexModelLabel || t.model || undefined,
      activity: headlineFor(t),
      question: t.question ?? undefined,
      history: t.history ?? { phase: t.blocks?.length ? 'ready' : t.chatUnstarted ? 'empty' : 'loading' },
      turnOutcome: t.turnOutcome,
      mcpStatuses: t.mcpStatuses,
      questionAcknowledgment: t.questionAcknowledgment ?? this.answerStates.get(t.id),
      result: t.result ?? undefined,
      error: t.error ?? undefined,
      mcpGap: t.mcpGap ? { message: t.mcpGap.message, fixCommand: t.mcpGap.fixCommand } : undefined,
      draft: this.deps.getDraft?.(t.id),
      followup: this.deps.getFollowup?.(t.id),
      composerMode: this.deps.getComposerMode?.(t.id),
      chatConfig: this.deps.getChatConfig?.(t.id),
      commands: this.deps.getCommands?.(t.id),
    }
  }

  /**
   * Push a task detail, skipping the send when nothing changed.
   *
   * A full Codex transcript serialises to ~32KB, and reconcile fires on every
   * poll — so the wire carried the same thirty kilobytes over and over for a
   * thread that had not moved. Sending history is right; re-sending it is not.
   */
  private sendDetail(kind: 'stageDetail' | 'showTask', task: TaskLite): void {
    // FILL AN OLD THREAD ON OPEN. The pollers watch what is LIVE — a finished
    // one-off is not polled at all and a finished session polls at a tenth of
    // the rate — so a conversation from weeks ago would otherwise open empty
    // and populate later, or never. The source file is still on disk; this asks
    // for it. Fire-and-forget: it emits `updated` when it finds anything, which
    // re-sends this detail with the blocks attached.
    if (this.historyTask !== task.id) void this.deps.loadBlocks?.(task.id)
    if (this.historyTask !== task.id) { this.historyTask = task.id; this.historyLimit = 10 }
    const detail = this.toDetail(task)
    const json = JSON.stringify(detail)
    // Dedupe only against what this surface is CURRENTLY showing. Keying by
    // task id instead would suppress re-showing a task the crank had rotated
    // away from and back to — the surface would keep displaying its neighbour.
    // The cache is only valid while the SURFACE still holds that payload. It
    // clears its own copy on teardown (AppController drops stageTask whenever
    // the state leaves cockpit), so forgetting to invalidate here left the
    // controller certain it had already sent something the surface no longer
    // had — and it drew a spinner until an unrelated change happened to alter
    // the payload. Measured at 25s in the field.
    const shown = this.lastDetailJson.get(kind)
    if (shown && shown.id === task.id && shown.json === json) return
    this.lastDetailJson.set(kind, { id: task.id, json })
    // WHAT ACTUALLY WENT OVER THE WIRE. Blocks were built, persisted and then
    // dropped by a hand-copied field list one layer above this — every log said
    // they existed and the panel still rendered the old transcript. The only
    // way to tell was to read the payload, so now the payload says.
    devEvent(log, 'detail-sent', {
      kind, taskId: task.id,
      blocks: detail.blocks?.length ?? 0,
      usage: !!detail.usage,
      conversation: detail.conversation?.length ?? 0,
    })
    this.client.send({ type: kind, task: detail } as never)
  }

  /** Say something transient on the surface (delivery failures, guards). */
  toast(text: string): void {
    this.client.send({ type: 'toast', text })
  }

  /**
   * Step the surface all the way down — used when we hand the user off to
   * another app.
   *
   * "Open in Codex" called dismissOverlay(), which is the RETIRED overlay
   * window, a different surface entirely. The notch was never told anything, so
   * it stayed pinned above the Codex window the user had just been sent to.
   */
  collapse(): void {
    this.engaged = 'none'
    this.setFocus(null)
    // `collapse` clears BOTH task and stageTask on the surface.
    this.lastDetailJson.clear()
    this.client.send({ type: 'collapse' })
  }

  /** Every group name currently on the wall, including '' for ungrouped. */
  private allGroupNames(): string[] {
    const now = Date.now()
    return [...new Set(this.deps.listTasks()
      .filter((t) => this.notchVisible(t, now))
      .map((t) => (t.group ?? '').trim()))]
  }

  /**
   * HOLD THE WALL STILL WHILE YOU ARE READING IT.
   *
   * The wall sorts by `updatedAt`, every running task polls once a second, and
   * every status write bumps that clock. With three tasks running their order
   * genuinely flipped several times a second — and because cards are keyed by
   * id, SwiftUI MOVES them rather than redrawing, so they visibly slide around.
   * Reported from the field as cards bouncing, and it is exactly that.
   *
   * Same answer as the pocket: contents stay live, ORDER is nailed down while
   * the surface is open, and it re-sorts next time you come to it. Newcomers
   * append so nothing is unreachable; the dead drop.
   */
  private heldWallOrder(sorted: TaskLite[]): TaskLite[] {
    if (this.engaged !== 'cockpit') { this.wallOrder = null; return sorted }
    const byId = new Map(sorted.map((t) => [t.id, t]))
    if (!this.wallOrder) { this.wallOrder = sorted.map((t) => t.id); return sorted }
    const held = this.wallOrder.filter((id) => byId.has(id))
    const known = new Set(held)
    for (const t of sorted) if (!known.has(t.id)) held.push(t.id)
    this.wallOrder = held
    return held.map((id) => byId.get(id)!)
  }

  buildCockpit(): CockpitPayload {
    const now = Date.now()
    const tasks = this.deps.listTasks()
    const qpos = new Map<string, number>()
    this.queue.forEach((id, i) => qpos.set(id, i + 1))

    // Groups: named groups sorted by most-recently-touched member; ungrouped last.
    // BY LAST ACTIVITY, the same key the groups are ranked on. Sorting cards by
    // createdAt while ranking groups by updatedAt is why the wall read as
    // arbitrary: a task touched five minutes ago but created three weeks ago
    // promoted its whole group to the top and then sat at the BOTTOM of it, so
    // the group said "something here is fresh" and the cards never showed which.
    // TODAY: hide anything that has not moved in 24 hours.
    //
    // A straight filter, not a fold — grouping, ordering and every card are
    // untouched; the old ones simply are not there. That is the difference from
    // "show all", which unfolds ONE group's stale tail and is a different
    // control answering a different question.
    //
    // ANYTHING WAITING ON YOU IGNORES IT. A filter that can hide a blocked task
    // is a way to lose work, not a way to focus — the same reason UNFOLDABLE
    // exists for the fold.
    const wall = this.heldWallOrder(tasks.filter((t) => this.notchVisible(t, now))
      .filter((t) => !this.todayOnly || this.demanding(t) || now - (t.updatedAt ?? 0) < TODAY_MS)
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)))
    const byGroup = new Map<string, TaskLite[]>()
    for (const t of wall) {
      const g = (t.group ?? '').trim()
      if (!byGroup.has(g)) byGroup.set(g, [])
      byGroup.get(g)!.push(t)
    }
    // THE UNGROUPED BUCKET RANKS LIKE ANY OTHER. It used to be appended last
    // whatever it held, and it renders without a heading, so the newest task on
    // the wall sat at the bottom under someone else's group title — which made
    // a correctly-sorted wall look scrambled.
    //
    // Insertion order IS the ranking, and no longer needs its own sort: `wall`
    // arrives newest-first, so a group first appears exactly at its newest
    // member — which is what ranking by `Math.max(updatedAt)` computed. Deriving
    // it instead of recomputing it means the group order inherits the hold
    // below for free, rather than churning while the cards inside stay put.
    const ranked = [...byGroup.entries()]

    /**
     * Collapse the stale tail of a group behind "show all".
     *
     * Sessions never fade from the NOTCH at all (notchVisible returns true for
     * them unconditionally), so a wall accumulates every session ever created —
     * DONE cards from three weeks ago sitting beside this morning's work.
     *
     * TWO RULES, both load-bearing. Staleness is measured by LAST ACTIVITY, so
     * a three-week-old session you spoke to this morning stays put. And nothing
     * unsettled is ever hidden, at any age: hiding a blocked task behind a
     * disclosure means work silently waiting on you that you cannot see, which
     * is the exact failure the cockpit exists to prevent.
     */
    const collapse = (name: string, ts: TaskLite[]): { cards: CardP[]; hidden: number; expanded: boolean } => {
      const expanded = this.expandedGroups.has(name)
      if (expanded) return { cards: ts.map((t) => this.toCard(t, now, qpos)), hidden: 0, expanded }
      const kept = ts.filter((t) => UNFOLDABLE.has(t.state) || now - (t.updatedAt ?? 0) < STALE_CARD_MS)
      return { cards: kept.map((t) => this.toCard(t, now, qpos)), hidden: ts.length - kept.length, expanded }
    }

    // An EMPTY GROUP is not a group. Under Today a whole group can lose every
    // card, and a bare heading over nothing reads as something failing to load.
    const groups = ranked.map(([name, ts]) => ({ name, ...collapse(name, ts) }))
      .filter((g) => g.cards.length > 0 || g.hidden > 0)
    // A WALL-LEVEL total, so the way back never depends on one particular group
    // rendering its header. Without this, folding every card in every group
    // left the reveal control nowhere on screen and the tasks unreachable.
    const hiddenTotal = groups.reduce((n, g) => n + (g.hidden ?? 0), 0)

    // Queue rail.
    const queue = this.queue
      .map((id) => this.deps.getTask(id))
      .filter((t): t is TaskLite => !!t)
      .map((t) => ({ id: t.id, name: t.name ?? truncate(t.intent, 40), status: t.state }))

    // One-offs rail (live + finished, clear-finished honored).
    const oneoffs = tasks
      .filter((t) => (t.kind ?? 'oneoff') === 'oneoff')
      .filter((t) => (t.updatedAt ?? 0) > this.clearedAt || classify(t.state) !== null || t.state === 'processing')
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
      .slice(0, 8)
      .map((t) => ({ id: t.id, name: t.name ?? truncate(t.intent, 36), status: t.state, age: relativeAge(t.updatedAt, now) }))

    if (!this.digestDismissed) this.computeDigest()

    return {
      groups,
      hiddenTotal,
      todayOnly: this.todayOnly,
      showingAll: groups.length > 0 && groups.every((x) => x.expanded),
      queue,
      oneoffs,
      unmuteSkills: this.skills.filter((s) => s.origin === 'unmute'),
      skills: this.skills.filter((s) => s.origin !== 'unmute'),
      importable: this.importable.map((s) => ({
        sessionId: s.sessionId,
        title: s.title,
        project: s.project,
        age: relativeAge(s.lastActivityAt, now),
        // Carried through at last. The engine has always known which CLI a
        // session belongs to; the rail dropped it here and then listed two
        // backends under a heading naming one.
        agent: s.agent ?? 'claude',
      })),
      digest: this.digestText,
      doorbell: this.deps.getDoorbell(),
      routeOffer: this.routeOffer,
      tmuxAvailable: this.deps.tmuxAvailable(),
      projects: this.projects,
    }
  }

  private toProposalDetail(p: ProposalLite): ProposalDetailP {
    const ev = p.evidence
    const seen = ev?.occurrences ?? 0
    const sessions = ev?.sessions?.length ?? 0
    const minutes = Math.round(ev?.struggle?.wallClockMin ?? 0)
    return {
      id: p.id,
      kind: p.kind === 'create' ? 'new' : p.kind,
      name: p.draft?.name ?? p.id,
      evidence: `seen ${seen}× · ${sessions} session${sessions === 1 ? '' : 's'} · ~${minutes} min of work`,
      summary: (p.changeSummary && p.changeSummary.length ? undefined : p.rationale) ?? p.rationale ?? '',
      bullets: p.changeSummary,
      body: p.draft?.body,
      diff: p.diff,
    }
  }

  // Test hooks.
  /** What the surface was last told is waiting. Reads the rendered payload, not
   *  a parallel recount — see sendPocket. */
  get attentionCount(): number { return this.lastWaiting }
  get engagedState(): Engaged { return this.engaged }
}

function providerLabel(provider: 'claude' | 'codex'): string {
  return provider === 'claude' ? 'Claude' : 'Codex'
}

/** The line drawn where a fresh Agent session began. Says what the model still
 *  has, because that — not the scrollback — is what the next answer comes from. */
export function sessionDivider(startedAt: number, notice?: string): string {
  const d = new Date(startedAt)
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  const today = new Date()
  const when = d.toDateString() === today.toDateString()
    ? `at ${time}`
    : `on ${d.getDate()} ${d.toLocaleString('en-US', { month: 'short' })} at ${time}`
  const why = notice?.startsWith('Switched to ') ? ` after you switched to ${notice.slice('Switched to '.length).split(' ')[0]}`
    : notice?.startsWith('Started a fresh conversation') ? ' after a break' : ''
  return `New conversation started ${when}${why}. The Agent remembers from here, plus the last 6 exchanges above this line.`
}
