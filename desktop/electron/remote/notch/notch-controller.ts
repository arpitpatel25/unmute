// NotchController — the brain between the task runtime and the native notch.
//
// v2: full cockpit/overlay parity. It owns the your-move QUEUE (skip=requeue),
// derives the six-rung baseline (dormant/active/attention) vs. the user's
// engaged state (task/cockpit), builds the complete CockpitPayload (groups,
// queue, one-offs, projects, suggestions, skills, shelf, digest, doorbell,
// route offer) and per-task TaskDetail, streams PTY output to the helper's
// terminal, and maps EVERY helper event onto the same internals the old IPC
// handlers call. Pure orchestration over injected deps — unit-testable without
// a TaskManager, window, or child process.
import type { EventEmitter } from 'node:events'
import type {
  NotchCommand, NotchEvent, NotchStateName, TaskStatusName,
  TaskDetailP, CardP, CockpitPayload, SkillItemP, ProposalDetailP,
  ScratchpadPayloadP,
} from './notch-client'
import { providerOf, type ProviderId } from '../providers'
import { createLogger } from '../log'

const log = createLogger('notch-controller')

// Task shape as serializeTask emits it (the same object remote:list returns).
export interface TaskLite {
  id: string
  intent: string
  name?: string | null
  cwd?: string
  kind?: 'oneoff' | 'session'
  // ProviderId, not a hand-written copy of it. This was spelled out literally
  // and so silently excluded the fourth backend the moment one was added —
  // the exact drift providers.ts was created to end.
  agent?: ProviderId
  codexProject?: string | null
  conversation?: TurnP[] | null
  /** Last message that did not reach the agent (NOT a task failure). */
  deliveryError?: string
  /** A message is in flight to the agent. */
  sending?: boolean
  /** Codex's label for this thread's model/effort, e.g. "5.6 Terra High". */
  codexModelLabel?: string
  threadContext?: string | null
  shelved?: boolean
  note?: string | null
  spawnedBy?: string | null
  group?: string | null
  state: TaskStatusName
  step?: string | null
  createdAt?: number
  updatedAt?: number
  result?: { summary: string; detail?: string; artifacts?: Array<{ type: 'url' | 'path'; value: string }> } | null
  error?: { reason: string; detail?: string } | null
  question?: { text: string; kind?: string; choices?: string[]; irreversible?: boolean } | null
  mcpGap?: { integration?: string; fixCommand: string; message: string } | null
  alive?: boolean
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
  answer(id: string, text: string): void
  kill(id: string): void
  remove(id: string): Promise<void> | void
  killAll(): void
  resume(id: string): Promise<boolean> | boolean
  rerun(intent: string): void
  setKind(id: string, kind: 'oneoff' | 'session'): void
  setName(id: string, name: string): void
  setShelved(id: string, on: boolean): void
  setNote(id: string, note: string): void
  focus(id: string | null): void
  /** The user opened this card (tap / cockpit stage). Revives a persistent
   *  session whose PTY the quit switch closed — see TaskManager.opened. Optional
   *  so a host that doesn't wire it simply keeps the manual Resume button. */
  opened?(id: string): void
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
  tapSkill(taskId: string, name: string): void
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
  scratchpadDiscard?(): void
}

export interface NotchClientLike {
  send(cmd: NotchCommand): void
  on(event: string, cb: (e: NotchEvent) => void): unknown
}

/** your-move classification; null ⇒ not the attention queue's business. */
export function classify(state: TaskStatusName): 'needs-user' | 'stuck' | 'errored' | 'ready' | null {
  switch (state) {
    case 'needs-user': return 'needs-user'
    case 'stuck': return 'stuck'
    case 'failed': return 'errored'
    case 'ready': return 'ready'
    default: return null
  }
}

/** Queue rank (the wall's crank order): stuck/errored → needs-user → ready. */
function rank(state: TaskStatusName): number {
  switch (state) {
    case 'stuck': case 'failed': return 0
    case 'needs-user': return 1
    case 'ready': return 2
    default: return 99
  }
}

function truncate(s: string, n = 48): string {
  return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + '…'
}

export function relativeAge(ts: number | undefined, now = Date.now()): string {
  if (!ts) return ''
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

const FADE_DONE_MS = 15 * 60 * 1000       // done fades from the wall after 15m
const FADE_ERR_MS = 60 * 60 * 1000        // errored/stuck after 60m
const AWAY_MS = 30 * 60 * 1000            // digest threshold
const PROMOTED_BADGE_MS = 8 * 1000        // "↑ now a session" narration window
/** Attention is for CHANGES; the cockpit is for STATE. A `ready` task older
 *  than this leaves the notch/crank entirely (still a cockpit card) — so a
 *  session parked ready for days can't hold the surface amber forever.
 *  Blocked states (needs-user/stuck/errored) never age out: they're stuck ON
 *  the user. (Decided 2026-07-24.)
 *
 *  Was 6h, which OUTLIVED TaskManager's readyDecayMs (1h) by five hours: the
 *  decay valve had already settled a ready one-off to done while the notch kept
 *  offering it in the crank. Now just past the decay window (+10m for the
 *  hourly sweep), so the two agree. */
const STALE_READY_MS = 70 * 60 * 1000

/** How long an errored task keeps the surface. Longer than `ready` — a failure
 *  deserves more of your attention than a finished step — but still finite. */
const STALE_ERROR_MS = 3 * 60 * 60 * 1000

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
  private engaged: Engaged = 'none'
  private focusedId: string | null = null
  /** One-off "clear finished" sweep cutoff. */
  private clearedAt = 0
  private digestDismissed = false
  private digestText: string | null = null
  /** Terminals the helper currently has open (stream targets). */
  private openTerms = new Set<string>()
  /** oneoff→session graduation narration (id → badge deadline). */
  private promotedUntil = new Map<string, number>()
  private kindSeen = new Map<string, string>()
  private routeOffer: { newTaskId: string; altTaskId: string; altName: string } | null = null
  /** Episode-mute: id → the state it was muted IN. Cleared when the user
   *  interacts with the task again or its state changes (a fresh transition
   *  re-enters the regular flow). Muted tasks stay cockpit cards; they just
   *  never front the attention strip or the crank. */
  private muted = new Map<string, TaskStatusName>()
  // Rails cache (skills/projects/proposals) — refreshed on cockpit open + 5min.
  private skills: SkillItemP[] = []
  private projects: Array<{ name: string; path: string }> = []
  private proposals: ProposalLite[] = []
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
  private reconcileTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private client: NotchClientLike,
    events: EventEmitter,
    private deps: NotchControllerDeps,
  ) {
    // Task runtime → queue + payload refresh (debounced).
    const onT = (t: TaskLite) => this.onTransition(t)
    events.on('created', onT)
    events.on('needs-user', onT)
    events.on('ready', onT)
    events.on('failed', onT)
    events.on('stuck', onT)
    events.on('updated', onT)
    events.on('done', (t: TaskLite) => { this.dequeue(t.id); this.scheduleReconcile() })
    events.on('removed', (t: { id: string }) => { this.dequeue(t.id); this.scheduleReconcile() })
    // Live PTY output → any open helper terminal.
    events.on('output', (d: { taskId: string; chunk: string }) => {
      if (this.openTerms.has(d.taskId)) {
        this.client.send({ type: 'termData', id: d.taskId, data: Buffer.from(d.chunk, 'utf8').toString('base64') })
      }
    })

    // Helper events → runtime. Every handler calls the SAME internals the old
    // IPC handlers call (via deps).
    const on = (type: string, fn: (e: NotchEvent) => void) => this.client.on(type, fn)
    on('tap', () => this.onTap())
    on('collapsed', () => { this.seenThenClose({ collapse: true }) })
    on('openDashboard', () => this.openCockpit())
    on('next', () => this.onNext())
    on('prev', () => this.onPrev())
    on('focusTask', (e) => this.onFocusTask((e as { id: string }).id))
    on('closeStage', () => { this.seenThenClose() })
    on('chooseOption', (e) => this.onChoose(e as { id: string; index: number }))
    on('mute', (e) => this.onMute((e as { id: string }).id))
    on('answerText', (e) => {
      const { id, text } = e as { id: string; text: string }
      // Advancing the crank is only right when this WAS the blocking question.
      // The Codex composer is always available, so a plain reply must not fling
      // the user onto whatever unrelated task happens to be queued next.
      //
      // Queue membership is NOT the test: a `ready` task sits in the crank too
      // (it is "your move"), so keying on it advanced away from a Codex chat the
      // user was mid-conversation with. Only `needs-user` is a question.
      const wasBlocking = this.deps.getTask(id)?.state === 'needs-user'
      this.deps.answer(id, text)
      if (wasBlocking) this.advanceAfterAnswer(id)
      else this.scheduleReconcile()
    })
    on('kill', (e) => this.deps.kill((e as { id: string }).id))
    on('resume', (e) => void this.deps.resume((e as { id: string }).id))
    on('rerun', (e) => { const t = this.deps.getTask((e as { id: string }).id); if (t) this.deps.rerun(t.intent) })
    on('remove', (e) => void this.deps.remove((e as { id: string }).id))
    on('killAll', () => this.deps.killAll())
    on('setKind', (e) => { const { id, kind } = e as { id: string; kind: 'oneoff' | 'session' }; this.deps.setKind(id, kind); this.scheduleReconcile() })
    on('shelve', (e) => { const { id, shelved } = e as { id: string; shelved: boolean }; this.deps.setShelved(id, shelved); if (shelved && this.focusedId === id) this.setFocus(null); this.scheduleReconcile() })
    on('rename', (e) => { const { id, name } = e as { id: string; name: string }; this.deps.setName(id, name); this.scheduleReconcile() })
    on('setNote', (e) => { const { id, note } = e as { id: string; note: string }; this.deps.setNote(id, note); this.scheduleReconcile() })
    on('pinSkill', (e) => { const { name, pinned } = e as { name: string; pinned: boolean }; void this.onPinSkill(name, pinned) })
    on('tapSkill', (e) => this.onTapSkill((e as { name: string }).name))
    on('openProject', (e) => { const { path, name } = e as { path: string; name: string }; this.deps.openProject(path, name) })
    on('clearFinished', () => { this.clearedAt = Date.now(); this.reconcile() })
    // Temporary, and deliberately not persisted: "show all" lasts as long as
    // this look at the cockpit, then the wall goes back to being about now.
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
    on('termInput', (e) => { const { id, data } = e as { id: string; data: string }; this.deps.sendInput(id, Buffer.from(data, 'base64').toString('utf8')) })
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
  }

  // ── queue ──────────────────────────────────────────────────────────────────

  /** In the crank/attention flow? your-move AND not shelved AND not a stale
   *  ready AND not episode-muted. Stale/muted stay cockpit-only. */
  private crankEligible(t: TaskLite, now = Date.now()): boolean {
    if (classify(t.state) === null || t.shelved) return false
    if (t.state === 'ready' && now - (t.updatedAt ?? 0) > STALE_READY_MS) return false
    // An errored task nagged FOREVER: only `ready` had a cut-off, and nothing
    // else ever removed one from the queue. A failure you have already seen is
    // not more urgent for being older — it stays a card on the wall, it just
    // stops being in your face. (Field report: a task that errored once kept
    // occupying the notch for hours.)
    if (t.state === 'failed' && now - (t.updatedAt ?? 0) > STALE_ERROR_MS) return false
    if (this.muted.get(t.id) === t.state) return false
    return true
  }

  private rebuildQueue(): void {
    const now = Date.now()
    const yours = this.deps.listTasks()
      .filter((t) => this.crankEligible(t, now))
      .sort((a, b) => rank(a.state) - rank(b.state) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    const known = new Set(this.queue)
    // Keep existing order (skip=requeue must stick); append newcomers by rank.
    this.queue = this.queue.filter((id) => yours.some((t) => t.id === id))
    for (const t of yours) if (!known.has(t.id)) this.queue.push(t.id)
  }

  private onTransition(t: TaskLite): void {
    if (!t || !t.id) return
    this.trackKind(t)
    // A state CHANGE ends a mute episode — the task re-enters the regular flow.
    const mutedIn = this.muted.get(t.id)
    if (mutedIn !== undefined && mutedIn !== t.state) this.muted.delete(t.id)
    const eligible = this.crankEligible(t)
    const queued = this.queue.includes(t.id)
    if (eligible && !queued) this.queue.push(t.id)
    else if (!eligible && queued) this.queue = this.queue.filter((id) => id !== t.id)
    this.scheduleReconcile()
  }

  private trackKind(t: TaskLite): void {
    const prev = this.kindSeen.get(t.id)
    const kind = t.kind ?? 'oneoff'
    if (prev === 'oneoff' && kind === 'session') this.promotedUntil.set(t.id, Date.now() + PROMOTED_BADGE_MS)
    this.kindSeen.set(t.id, kind)
  }

  private dequeue(id: string): void {
    this.queue = this.queue.filter((x) => x !== id)
    if (this.focusedId === id) this.setFocus(null)
    if (this.queue.length === 0 && this.engaged === 'task') this.engaged = 'none'
  }

  private front(): TaskLite | undefined {
    while (this.queue.length > 0) {
      const t = this.deps.getTask(this.queue[0])
      if (t && this.crankEligible(t)) return t
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
    const front = this.front()
    const attention = this.queue.length
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

    // The task surface can hold a task that is NOT in the attention queue — the
    // user tapped a merely-working one. Without this the surface would open and
    // then immediately collapse back to `active` on the next reconcile.
    const opened = this.engaged === 'task' && this.focusedId ? this.deps.getTask(this.focusedId) : undefined
    const shown = front ?? opened
    if (shown) {
      this.sendDetail('showTask', shown)
      // The task surface needs rail context too (tmux gate etc.).
      if (this.engaged === 'task') this.client.send({ type: 'setCockpit', data: this.buildCockpit() })
      this.client.send({ type: 'setState', state: this.engaged === 'task' ? 'task' : 'attention', attention, working })
      return
    }

    this.engaged = 'none'
    this.client.send({ type: 'setState', state: working > 0 ? 'active' : 'dormant', attention: 0, working })
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
    this.setFocus(target.id) // voice routes to the fronted task
    this.deps.opened?.(target.id) // a closed working session comes back by itself
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

  private openCockpit(): void {
    this.engaged = 'cockpit'
    this.expandedGroups.clear()   // each visit starts on the live view
    this.computeDigest()
    this.deps.setLastSeen(Date.now())
    void this.refreshRails(true)
    this.reconcile()
  }

  private onNext(): void {
    if (this.queue.length > 1) {
      const first = this.queue.shift()!
      this.queue.push(first) // skip = requeue to the back
    }
    const front = this.front()
    if (front) this.setFocus(front.id)
    this.reconcile()
  }

  /** Crank backward: the queue rotates the other way (last → front). */
  private onPrev(): void {
    if (this.queue.length > 1) {
      const last = this.queue.pop()!
      this.queue.unshift(last)
    }
    const front = this.front()
    if (front) this.setFocus(front.id)
    this.reconcile()
  }

  private onFocusTask(id: string): void {
    this.engaged = 'cockpit'
    this.setFocus(id)
    this.deps.opened?.(id) // opening the stage IS the intent to work in it
    this.reconcile()
  }

  private setFocus(id: string | null): void {
    this.focusedId = id
    this.deps.focus(id) // focus IS the voice address (consent model)
    if (id) this.muted.delete(id) // interacting with a task ends its mute episode
  }

  /**
   * Closing a task the user actually LOOKED AT means they've seen it.
   *
   * Opening used to CLEAR the mute and nothing ever set it, so the one gesture
   * that most obviously means "I've seen this" was the only one that didn't
   * quiet the notch — a finished one-off held the surface until STALE_READY_MS.
   *
   * Only `ready` is quieted. Blocked states (needs-user/stuck/errored) are stuck
   * ON the user: looking at an approval prompt is not answering it, so they keep
   * demanding until acted on or explicitly muted. Muting is still the deliberate
   * "I don't care about this one" gesture and works on ANY state.
   *
   * This reuses the episode-mute, so "comes back the moment its state changes"
   * is inherited rather than reimplemented.
   */
  private seenThenClose(opts: { collapse?: boolean } = {}): void {
    const id = this.focusedId
    const t = id ? this.deps.getTask(id) : undefined
    if (t && t.state === 'ready') {
      this.muted.set(t.id, t.state)
      this.queue = this.queue.filter((x) => x !== t.id)
      log.event('seen-on-close', { taskId: t.id, state: t.state })
    }
    if (opts.collapse) this.engaged = 'none'
    this.setFocus(null)
    this.reconcile()
  }

  /** "Don't show this again": out of the attention strip + crank until the user
   *  interacts with it or its state changes. Still a cockpit card. */
  private onMute(id: string): void {
    const t = this.deps.getTask(id)
    if (!t) return
    this.muted.set(id, t.state)
    this.queue = this.queue.filter((x) => x !== id)
    if (this.focusedId === id) { this.focusedId = null; this.deps.focus(null) }
    if (this.queue.length === 0 && this.engaged === 'task') this.engaged = 'none'
    this.client.send({ type: 'toast', text: 'muted — back when it changes or you open it' })
    this.reconcile()
  }

  private onChoose({ id, index }: { id: string; index: number }): void {
    const t = this.deps.getTask(id)
    const label = t?.question?.choices?.[index]
    if (label == null) return
    this.deps.answer(id, label)
    this.advanceAfterAnswer(id)
  }

  /** Throughput loop: answering advances to the next queued your-move task. */
  private advanceAfterAnswer(id: string): void {
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
  private onTapSkill(name: string): void {
    const id = this.focusedId
    const t = id ? this.deps.getTask(id) : undefined
    if (!id || !t?.alive) {
      this.client.send({ type: 'toast', text: 'focus a live task first — then tap a skill to type /' + name })
      return
    }
    this.deps.tapSkill(id, name)
    this.client.send({ type: 'toast', text: `typed /${name} — press Enter in the terminal to run` })
  }

  private async onOfferAccept(newTaskId: string): Promise<void> {
    await this.deps.acceptRouteOffer(newTaskId)
    this.routeOffer = null
    this.reconcile()
  }

  private onTermOpen(id: string): void {
    this.openTerms.add(id)
    const replay = this.deps.getOutput(id)
    if (replay) this.client.send({ type: 'termData', id, data: Buffer.from(replay, 'utf8').toString('base64') })
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
  }

  // ── external notifications (init forwards these) ───────────────────────────

  notifyCapturePhase(phase: string, taskId: string | null): void {
    const t = taskId ? this.deps.getTask(taskId) : undefined
    const target = t ? (t.name ?? truncate(t.intent)) : (this.focusedId ? this.titleOf(this.focusedId) : undefined)
    this.client.send({ type: 'capturePhase', phase, target })
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
      const [skills, projects, proposals] = await Promise.all([
        this.deps.listSkills(), this.deps.listProjects(), this.deps.listProposals(),
      ])
      this.skills = skills; this.projects = projects; this.proposals = proposals
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
    const needs = tasks.filter((t) => classify(t.state) !== null && !t.shelved).length
    const finished = tasks.filter((t) => t.state === 'done' && (t.updatedAt ?? 0) > last).length
    this.digestText = (needs || finished)
      ? `while you were away: ${needs} need${needs === 1 ? 's' : ''} you · ${finished} errand${finished === 1 ? '' : 's'} finished`
      : null
  }

  /** Present-tense fade (the wall's visibleOnWall): sessions never fade; done
   *  one-offs fade after 15m; errored/stuck after 60m; shelved → Shelf only. */
  private visibleOnWall(t: TaskLite, now: number): boolean {
    if (t.shelved) return false
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
      activity: t.question?.text ?? t.error?.reason ?? t.step ?? t.result?.summary ?? undefined,
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
      backend: providerOf(t.agent).transport === 'driver' ? t.agent : undefined,
      project: t.agent === 'codex-desktop' ? (t.codexProject ?? undefined) : undefined,
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
    // ANY driver backend, not just Codex. This one line is why Claude Desktop
    // cards rendered with an empty body: `external` was false, so the branch
    // below — the branch that sends the CONVERSATION — never ran, and the card
    // had literally nothing to draw.
    const external = providerOf(t.agent).transport === 'driver'
    return {
      id: t.id,
      title: t.name ?? truncate(t.intent),
      // WHETHER THERE IS A LIVE TERMINAL, decided here and sent, rather than
      // re-derived on the Swift side from its own list of desktop backends.
      // Those two lists had already drifted — the Swift one named a
      // 'claude-code-desktop' that does not exist in AgentKind — and this is
      // what picks the expanded surface's share of the screen (80% for a
      // terminal, 60% for a conversation). One registry, one answer.
      terminal: providerOf(t.agent).hasTerminal,
      // An external backend has no PTY, so the panel renders the CONVERSATION
      // where a Claude task renders its terminal. Both are "the real thing,
      // shown raw" — neither is a re-implementation of the other app's UI.
      ...(external ? {
        backend: t.agent,
        // The whole thread. The old windows here (6, then 40) were both
        // downstream of a 6-item cut at the parse layer, so neither ever had
        // anything to trim — widening this alone did nothing, which is exactly
        // the mistake that let the truncation survive a round of "fixes".
        conversation: t.conversation ?? [],
        ...(t.codexProject ? { project: t.codexProject } : {}),
      } : {}),
      status: t.state,
      kind: t.kind ?? 'oneoff',
      alive: external ? true : (t.alive ?? false),   // see toCard: never dead
      shelved: t.shelved ?? false,
      dir: this.dirLabel(t),
      age: relativeAge(t.updatedAt, now),
      elapsed: relativeAge(t.createdAt, now),
      warmup: t.threadContext ?? undefined,
      note: t.note ?? undefined,
      // A delivery problem belongs next to the composer, where the retry is —
      // and unlike `error` it must never be read as "the work failed".
      deliveryError: t.deliveryError ?? undefined,
      sending: t.sending ?? undefined,
      // What this thread runs on, in Codex's own words. Shown in the composer
      // because "which model is this" is part of writing the next message.
      modelLabel: t.codexModelLabel ?? undefined,
      activity: t.question?.text ?? t.error?.reason ?? t.step ?? t.result?.summary ?? undefined,
      question: t.question ?? undefined,
      result: t.result ?? undefined,
      error: t.error ?? undefined,
      mcpGap: t.mcpGap ? { message: t.mcpGap.message, fixCommand: t.mcpGap.fixCommand } : undefined,
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
      .filter((t) => this.visibleOnWall(t, now))
      .map((t) => (t.group ?? '').trim()))]
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
    const wall = tasks.filter((t) => this.visibleOnWall(t, now))
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
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
    const ranked = [...byGroup.entries()]
      .sort((a, b) => Math.max(...b[1].map((t) => t.updatedAt ?? 0)) - Math.max(...a[1].map((t) => t.updatedAt ?? 0)))

    /**
     * Collapse the stale tail of a group behind "show all".
     *
     * Sessions never faded from the wall at all (visibleOnWall returns true for
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

    const groups = ranked.map(([name, ts]) => ({ name, ...collapse(name, ts) }))
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
      .filter((t) => (t.kind ?? 'oneoff') === 'oneoff' && !t.shelved)
      .filter((t) => (t.updatedAt ?? 0) > this.clearedAt || classify(t.state) !== null || t.state === 'processing')
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
      .slice(0, 8)
      .map((t) => ({ id: t.id, name: t.name ?? truncate(t.intent, 36), status: t.state, age: relativeAge(t.updatedAt, now) }))

    const shelf = tasks.filter((t) => t.shelved)
      .map((t) => ({ id: t.id, name: t.name ?? truncate(t.intent, 40) }))

    if (!this.digestDismissed) this.computeDigest()

    return {
      groups,
      hiddenTotal,
      showingAll: groups.length > 0 && groups.every((x) => x.expanded),
      queue,
      oneoffs,
      projects: this.projects,
      suggestions: this.proposals.map((p) => ({
        id: p.id,
        kind: p.kind === 'create' ? 'new' : p.kind,
        name: p.draft?.name ?? p.id,
      })),
      unmuteSkills: this.skills.filter((s) => s.origin === 'unmute'),
      skills: this.skills.filter((s) => s.origin !== 'unmute'),
      shelf,
      digest: this.digestText,
      doorbell: this.deps.getDoorbell(),
      routeOffer: this.routeOffer,
      tmuxAvailable: this.deps.tmuxAvailable(),
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
  get attentionCount(): number { return this.queue.length }
  get engagedState(): Engaged { return this.engaged }
}
