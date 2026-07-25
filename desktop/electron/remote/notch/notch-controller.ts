// NotchController — the brain between the task runtime and the native notch.
//
// v2: full cockpit/overlay parity. It owns the your-move QUEUE (skip=requeue),
// derives the six-rung baseline (dormant/active/attention) vs. the user's
// engaged state (task/cockpit), builds the complete CockpitPayload (groups,
// queue, one-offs, projects, suggestions, skills, shelf, digest, staged,
// doorbell, route offer) and per-task TaskDetail, streams PTY output to the
// helper's terminal, and maps EVERY helper event onto the same internals the
// old IPC handlers call. Pure orchestration over injected deps — unit-testable
// without a TaskManager, window, or child process.
import type { EventEmitter } from 'node:events'
import type {
  NotchCommand, NotchEvent, NotchStateName, TaskStatusName,
  TaskDetailP, CardP, CockpitPayload, SkillItemP, ProposalDetailP,
} from './notch-client'
import { createLogger } from '../log'

const log = createLogger('notch-controller')

// Task shape as serializeTask emits it (the same object remote:list returns).
export interface TaskLite {
  id: string
  intent: string
  name?: string | null
  cwd?: string
  kind?: 'oneoff' | 'session'
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
  getStagedCount(): number
  clearStaged(): void
  getLastSeen(): number
  setLastSeen(ms: number): void
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
 *  the user. (Decided 2026-07-24.) */
const STALE_READY_MS = 6 * 60 * 60 * 1000

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
    on('collapsed', () => { this.engaged = 'none'; this.setFocus(null); this.reconcile() })
    on('openDashboard', () => this.openCockpit())
    on('next', () => this.onNext())
    on('prev', () => this.onPrev())
    on('focusTask', (e) => this.onFocusTask((e as { id: string }).id))
    on('closeStage', () => { this.setFocus(null); this.reconcile() })
    on('chooseOption', (e) => this.onChoose(e as { id: string; index: number }))
    on('mute', (e) => this.onMute((e as { id: string }).id))
    on('answerText', (e) => { const { id, text } = e as { id: string; text: string }; this.deps.answer(id, text); this.advanceAfterAnswer(id) })
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
    on('digestDismiss', () => { this.digestDismissed = true; this.digestText = null; this.reconcile() })
    on('bellToggle', () => { this.deps.setDoorbell(!this.deps.getDoorbell()); this.reconcile() })
    on('offerAccept', (e) => void this.onOfferAccept((e as { newTaskId: string }).newTaskId))
    on('clearStaged', () => { this.deps.clearStaged(); this.reconcile() })
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
    this.rebuildQueue()
    const front = this.front()
    const attention = this.queue.length
    const working = this.deps.listTasks().filter((t) => t.state === 'processing').length

    if (this.engaged === 'cockpit') {
      this.client.send({ type: 'setCockpit', data: this.buildCockpit() })
      if (this.focusedId) {
        const t = this.deps.getTask(this.focusedId)
        if (t) this.client.send({ type: 'stageDetail', task: this.toDetail(t) })
      }
      this.client.send({ type: 'setState', state: 'cockpit', attention, working })
      return
    }

    if (front) {
      this.client.send({ type: 'showTask', task: this.toDetail(front) })
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
    const front = this.front()
    if (front) {
      this.engaged = 'task'
      this.setFocus(front.id) // voice routes to the fronted task
    } else {
      this.openCockpit()
      return
    }
    this.reconcile()
  }

  private openCockpit(): void {
    this.engaged = 'cockpit'
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
    this.reconcile()
  }

  private setFocus(id: string | null): void {
    this.focusedId = id
    this.deps.focus(id) // focus IS the voice address (consent model)
    if (id) this.muted.delete(id) // interacting with a task ends its mute episode
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

  notifyRouteOffer(offer: { newTaskId: string; altTaskId: string; altName: string } | null): void {
    this.routeOffer = offer
    this.reconcile()
  }

  notifyStagedChanged(): void { this.scheduleReconcile() }

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
      note: t.note ?? undefined,
      alive: t.alive ?? false,
    }
  }

  private toDetail(t: TaskLite): TaskDetailP {
    const now = Date.now()
    return {
      id: t.id,
      title: t.name ?? truncate(t.intent),
      status: t.state,
      kind: t.kind ?? 'oneoff',
      alive: t.alive ?? false,
      shelved: t.shelved ?? false,
      dir: this.dirLabel(t),
      age: relativeAge(t.updatedAt, now),
      elapsed: relativeAge(t.createdAt, now),
      warmup: t.threadContext ?? undefined,
      note: t.note ?? undefined,
      activity: t.question?.text ?? t.error?.reason ?? t.step ?? t.result?.summary ?? undefined,
      question: t.question ?? undefined,
      result: t.result ?? undefined,
      error: t.error ?? undefined,
      mcpGap: t.mcpGap ? { message: t.mcpGap.message, fixCommand: t.mcpGap.fixCommand } : undefined,
    }
  }

  buildCockpit(): CockpitPayload {
    const now = Date.now()
    const tasks = this.deps.listTasks()
    const qpos = new Map<string, number>()
    this.queue.forEach((id, i) => qpos.set(id, i + 1))

    // Groups: named groups sorted by most-recently-touched member; ungrouped last.
    const wall = tasks.filter((t) => this.visibleOnWall(t, now))
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)) // newest-left
    const byGroup = new Map<string, TaskLite[]>()
    for (const t of wall) {
      const g = (t.group ?? '').trim()
      if (!byGroup.has(g)) byGroup.set(g, [])
      byGroup.get(g)!.push(t)
    }
    const named = [...byGroup.entries()].filter(([g]) => g !== '')
      .sort((a, b) => Math.max(...b[1].map((t) => t.updatedAt ?? 0)) - Math.max(...a[1].map((t) => t.updatedAt ?? 0)))
    const groups = named.map(([name, ts]) => ({ name, cards: ts.map((t) => this.toCard(t, now, qpos)) }))
    const ungrouped = byGroup.get('') ?? []
    if (ungrouped.length) groups.push({ name: '', cards: ungrouped.map((t) => this.toCard(t, now, qpos)) })

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
      stagedCount: this.deps.getStagedCount(),
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
