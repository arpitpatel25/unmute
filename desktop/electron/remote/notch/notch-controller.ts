// NotchController — the brain between the task runtime and the native notch.
//
// It owns the "your-move" QUEUE (needs-user / stuck / errored / ready — never a
// plain `done`, which is cockpit-only), derives the notch's state + fronted
// task, and translates the helper's taps/gestures back into task actions. It is
// pure orchestration over injected deps so it unit-tests without a real
// TaskManager, window, or child process.
import type { EventEmitter } from 'node:events'
import type { NotchCommand, NotchEvent, PanelTaskPayload, PanelTaskState } from './notch-client'
import { createLogger } from '../log'

const log = createLogger('notch-controller')

// Task state as the runtime reports it (type-only; no runtime import so tests
// stay light). Mirrors task-manager's UiTaskState.
export type TaskUiState = 'processing' | 'needs-user' | 'ready' | 'done' | 'failed' | 'stuck'

/** The subset of a Task the notch needs. Wiring maps a real Task → this. */
export interface TaskLite {
  id: string
  name?: string
  intent: string
  state: TaskUiState
  /** A needs-user prompt or a where-you-left-off line. */
  question?: string
  /** Tappable choices for a needs-user task, if the agent offered any. */
  options?: string[]
  result?: string
  error?: string
}

/** Sink for user intents coming back from the notch. */
export interface NotchControllerDeps {
  /** Front task's answer (an option label, or undefined = "user will speak/type"). */
  answer(taskId: string, text?: string): void
  /** Bring the fronted task into focus so voice routes to it (consent model). */
  focus(taskId: string): void
  /** Open the full Electron cockpit window. */
  showCockpit(): void
  /** Current our-move count (drives the idle glow). */
  countWorking(): number
  /** Resolve a live task by id (null once removed/gone). */
  getTask(id: string): TaskLite | undefined
}

/** Minimal client surface the controller drives (real NotchClient satisfies it). */
export interface NotchClientLike {
  send(cmd: NotchCommand): void
  on(event: string, cb: (e: NotchEvent) => void): unknown
}

/** your-move classification; null ⇒ not the notch's business. */
export function classify(state: TaskUiState): PanelTaskState | null {
  switch (state) {
    case 'needs-user': return 'needs-user'
    case 'stuck':      return 'stuck'
    case 'failed':     return 'errored'
    case 'ready':      return 'ready'
    default:           return null // processing, done
  }
}

function truncate(s: string, n = 48): string {
  return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + '…'
}

export class NotchController {
  /** Ordered your-move queue (front = queue[0]). Skip rotates front → back. */
  private queue: string[] = []
  /** Has the user tapped into the full panel (vs. just peeking)? */
  private panelOpen = false

  constructor(
    private client: NotchClientLike,
    events: EventEmitter,
    private deps: NotchControllerDeps,
  ) {
    // Task runtime → queue.
    events.on('needs-user', (t: TaskLite) => this.onTransition(t))
    events.on('ready',      (t: TaskLite) => this.onTransition(t))
    events.on('failed',     (t: TaskLite) => this.onTransition(t))
    events.on('stuck',      (t: TaskLite) => this.onTransition(t))
    events.on('updated',    (t: TaskLite) => this.onTransition(t))
    events.on('done',       (t: TaskLite) => this.dequeue(t.id))
    events.on('removed',    (t: { id: string }) => this.dequeue(t.id))

    // Notch → task runtime.
    this.client.on('tap',           () => this.onTap())
    this.client.on('next',          () => this.onNext())
    this.client.on('chooseOption',  (e) => this.onChoose((e as { index: number }).index))
    this.client.on('openDashboard', () => this.deps.showCockpit())
    this.client.on('collapsed',     () => this.onCollapsed())
  }

  // --- queue maintenance -----------------------------------------------------

  private onTransition(task: TaskLite): void {
    if (!task || !task.id) return
    const yourMove = classify(task.state) !== null
    const queued = this.queue.includes(task.id)
    if (yourMove && !queued) this.queue.push(task.id)
    else if (!yourMove && queued) this.queue = this.queue.filter((id) => id !== task.id)
    this.reconcile()
  }

  private dequeue(id: string): void {
    if (!this.queue.includes(id)) return
    this.queue = this.queue.filter((x) => x !== id)
    if (this.queue.length === 0) this.panelOpen = false
    this.reconcile()
  }

  /** Drop ids whose task has vanished; return the live front task or undefined. */
  private front(): TaskLite | undefined {
    while (this.queue.length > 0) {
      const task = this.deps.getTask(this.queue[0])
      if (task && classify(task.state) !== null) return task
      this.queue.shift() // stale/no-longer-your-move: drop and look further
    }
    return undefined
  }

  // --- notch state derivation ------------------------------------------------

  /** Recompute the notch's state + fronted task and push it to the helper. */
  private reconcile(): void {
    const front = this.front()
    const attention = this.queue.length
    const working = this.deps.countWorking()

    if (!front) {
      this.panelOpen = false
      this.client.send({ type: 'setState', state: 'idle', attention: 0, working })
      return
    }

    this.client.send({ type: 'showTask', task: this.toPayload(front) })
    this.client.send({
      type: 'setState',
      state: this.panelOpen ? 'panel' : 'peek',
      attention,
      working,
    })
  }

  private toPayload(task: TaskLite): PanelTaskPayload {
    const state = classify(task.state) ?? 'ready'
    const summary = task.question ?? task.result ?? task.error ?? undefined
    return {
      id: task.id,
      title: task.name ?? truncate(task.intent),
      state,
      summary,
      options: task.options && task.options.length ? task.options : undefined,
      // Terminal defaults open where it's almost always the point (Stage 6
      // makes this sticky per user preference).
      terminalHint: state === 'stuck' || state === 'errored' ? 'open' : 'collapsed',
    }
  }

  // --- notch → runtime -------------------------------------------------------

  private onTap(): void {
    const front = this.front()
    if (!front) return
    this.panelOpen = true
    this.deps.focus(front.id) // voice now routes to the fronted task
    this.reconcile()
  }

  private onNext(): void {
    // Skip = requeue to the back so the others surface; it comes back around.
    if (this.queue.length > 1) {
      const first = this.queue.shift()!
      this.queue.push(first)
    }
    this.reconcile()
  }

  private onChoose(index: number): void {
    const front = this.front()
    if (!front) return
    const label = front.options?.[index]
    this.deps.answer(front.id, label)
    // The runtime will transition the task off your-move (→ processing), which
    // fires 'updated' → dequeue → advance. Nothing else to do here.
  }

  private onCollapsed(): void {
    this.panelOpen = false
    this.reconcile() // → peek if items remain, else idle
  }

  /** For wiring/telemetry: current queue depth. */
  get attentionCount(): number { return this.queue.length }
}
