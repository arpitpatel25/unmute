// Unmute Remote — task manager: the orchestrator (PRD §4.4, §5, §6, §13.6).
//
// Owns the full lifecycle of a Remote task:
//   1. Mint a taskId + scaffold the per-task dir + status file (Unmute owns the
//      path; Claude only fills fields — PRD §6.1).
//   2. Install the operating contract as CLAUDE.md in the session cwd (#3).
//   3. Spawn an executor (interactive claude REPL, subscription auth — PRD §3.2),
//      wait until ready, type the dispatch payload (path + intent only — #3).
//   4. POLL the status file: transitions drive task state; mtime drives the
//      staleness/stuck backstop (PRD §6.3 — TUI-independent).
//   5. On terminal state, emit completion (Unmute OBSERVES — Claude does not
//      notify us; PRD §13.6) and close the session.
//
// Concurrency (PRD §4.4): many tasks, each its own executor + status file,
// tracked in a Map. Zero cross-task contention by construction.
//
// Everything user-observable is logged via log.ui() and every state change via
// log.event() so the session logs alone reconstruct the experience.

import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { createLogger } from './log'
import {
  scaffoldStatusFile,
  readStatus,
  statusMtimeMs,
  isStale,
  type StatusPayload,
  type TaskState,
} from './status-file'
import { buildDispatch } from './dispatch-prompt'
import { installContract } from './contract/installer'
import { installSkillsIntoCwd } from './skills'
import { detectMcpGap, type McpGap } from './mcp-gap'
import type { Librarian } from './librarian'
import type { AgentExecutor, ExecutorFactory } from './executor'

const log = createLogger('task-manager')

// ── UI-facing task state. Adds 'stuck' (PRD §5.3) on top of the file states. ──
export type UiTaskState = TaskState | 'stuck'

export interface Task {
  id: string
  intent: string
  state: UiTaskState
  createdAt: number
  updatedAt: number
  cwd: string
  statusPath: string
  recipeScratchPath: string
  /** mtime (ms) of the last status write we applied — the heartbeat clock for
   *  staleness (PRD §6.3). Updated only when the file genuinely changes. */
  lastMtimeMs: number
  result?: StatusPayload['result']
  error?: StatusPayload['error']
  question?: StatusPayload['question']
  recipeSuggestion?: StatusPayload['recipe_suggestion']
  /** Set on failure when the error looks like a missing-integration gap (PRD §12.3). */
  mcpGap?: McpGap
}

export interface TaskManagerOpts {
  /** Creates a fresh executor per task (default: ClaudeCodeExecutor). */
  executorFactory: ExecutorFactory
  /** signed-in user id, else 'local' (Remote works regardless — PRD). */
  userKey?: string
  /** base dir; default ~/.unmute/remote. */
  baseDir?: string
  /** poll interval for the status file (ms). */
  pollMs?: number
  /** staleness threshold (ms) — generous (PRD §6.3). Default 4 min. */
  staleMs?: number
  /** ms to wait after accepting the folder-trust prompt for the REPL to boot. */
  trustAcceptMs?: number
  /** Recipe librarian (PRD §9). When set, a 'done' task that proposed a recipe
   *  suggestion is submitted for curation. Optional. */
  librarian?: Librarian
  /** clock + sleep injectable for tests. */
  now?: () => number
}

type TaskEvent = 'created' | 'updated' | 'needs-user' | 'stuck' | 'done' | 'failed'

const TERMINAL: UiTaskState[] = ['done', 'failed']

export class TaskManager extends EventEmitter {
  private tasks = new Map<string, Task>()
  private executors = new Map<string, AgentExecutor>()
  private timers = new Map<string, ReturnType<typeof setInterval>>()
  // Per-task ring buffer of recent PTY output for render-on-demand (PRD §13.4#8).
  private outputBuffers = new Map<string, string>()
  private static readonly OUTPUT_CAP = 200_000 // chars kept per task
  private readonly opts:
    Required<Omit<TaskManagerOpts, 'userKey' | 'now' | 'librarian'>> &
    Pick<TaskManagerOpts, 'userKey' | 'now' | 'librarian'>

  constructor(opts: TaskManagerOpts) {
    super()
    this.opts = {
      executorFactory: opts.executorFactory,
      baseDir: opts.baseDir ?? join(homedir(), '.unmute', 'remote'),
      pollMs: opts.pollMs ?? 1000,
      staleMs: opts.staleMs ?? 4 * 60_000,
      trustAcceptMs: opts.trustAcceptMs ?? 2000,
      userKey: opts.userKey ?? 'local',
      librarian: opts.librarian,
      now: opts.now,
    }
  }

  private clock(): number {
    return this.opts.now ? this.opts.now() : Date.now()
  }

  list(): Task[] {
    return [...this.tasks.values()].sort((a, b) => b.createdAt - a.createdAt)
  }

  get(id: string): Task | undefined {
    return this.tasks.get(id)
  }

  /** Recent buffered PTY output for a task (render-on-demand, PRD §13.4#8). */
  getOutput(id: string): string {
    return this.outputBuffers.get(id) ?? ''
  }

  /** Active = not yet terminal (drives the ambient "N running" count, PRD §13.2). */
  activeCount(): number {
    return [...this.tasks.values()].filter((t) => !TERMINAL.includes(t.state)).length
  }

  /**
   * Dispatch a new task. Returns the taskId immediately; execution + polling
   * proceed asynchronously (PRD §4.4 — dispatch and forget).
   */
  async dispatch(intent: string): Promise<string> {
    const id = randomUUID()
    const dir = join(this.opts.baseDir, this.opts.userKey!, id)
    const statusPath = join(dir, 'status.json')
    const recipeScratchPath = join(dir, 'recipe.json')
    const now = this.clock()
    const tlog = log.child({ taskId: id })

    const task: Task = {
      id, intent, state: 'processing', createdAt: now, updatedAt: now,
      cwd: dir, statusPath, recipeScratchPath, lastMtimeMs: now,
    }
    this.tasks.set(id, task)
    tlog.event('task-created', { intent, cwd: dir })
    tlog.ui('task-row.added', { intent, state: 'processing' }) // PRD §13.4 #1: row shows cleaned intent

    this.emit('created', task)

    try {
      await scaffoldStatusFile(statusPath) // Unmute owns creation (PRD §6.1)
      // Seed the heartbeat clock from the scaffold's real mtime so staleness is
      // measured from "task start", not the logical createdAt.
      task.lastMtimeMs = (await statusMtimeMs(statusPath)) ?? now
      await installContract(dir) // CLAUDE.md auto-load (#3)
      await installSkillsIntoCwd(dir, this.opts.baseDir) // recipes auto-discovery (PRD §8.3)

      const ex = this.opts.executorFactory()
      this.executors.set(id, ex)
      // Buffer raw PTY output (capped) for render-on-demand (§4.3/§13.4#8) and
      // emit it live so a watching terminal view updates in real time.
      this.outputBuffers.set(id, '')
      ex.onData((chunk) => {
        tlog.debug('pty-data', { chunk })
        const cur = (this.outputBuffers.get(id) ?? '') + chunk
        this.outputBuffers.set(id, cur.length > TaskManager.OUTPUT_CAP ? cur.slice(-TaskManager.OUTPUT_CAP) : cur)
        this.emit('output', { taskId: id, chunk })
      })

      await ex.spawn({ cwd: dir, env: process.env, taskId: id })
      await ex.isReady()

      // Accept Claude Code's folder-trust prompt. It appears on the first run in
      // a fresh dir EVEN with --dangerously-skip-permissions (validated by the
      // Task-0 probe). Enter accepts the highlighted "Yes, I trust this folder";
      // a no-op empty submit if no prompt is shown. Then let the REPL boot.
      ex.writeStdin('')
      await new Promise((r) => setTimeout(r, this.opts.trustAcceptMs))
      tlog.event('folder-trust-accepted', {})

      const payload = buildDispatch({ intent, statusPath, recipeScratchPath })
      ex.writeStdin(payload)
      tlog.event('task-dispatched', {})

      this.startPolling(id)
    } catch (e) {
      tlog.error('dispatch failed before polling', { error: (e as Error).message })
      this.transition(id, 'failed', { error: { reason: 'Could not start the task', detail: (e as Error).message } })
    }
    return id
  }

  /** Poll the status file + run the staleness backstop until terminal. */
  private startPolling(id: string): void {
    const tlog = log.child({ taskId: id })
    const timer = setInterval(() => {
      void this.poll(id).catch((e) => tlog.error('poll error', { error: (e as Error).message }))
    }, this.opts.pollMs)
    this.timers.set(id, timer)
    tlog.event('polling-started', { pollMs: this.opts.pollMs, staleMs: this.opts.staleMs })
  }

  private async poll(id: string): Promise<void> {
    const task = this.tasks.get(id)
    if (!task || TERMINAL.includes(task.state)) return
    const tlog = log.child({ taskId: id })

    const mtime = await statusMtimeMs(task.statusPath)

    // A genuinely NEW write (mtime advanced past the last one we applied) is the
    // only thing we treat as a fresh heartbeat (PRD §6.1 primary signal). A
    // valid-but-unchanged file is NOT an update — otherwise a task that wrote
    // 'processing' once and then went silent would look healthy forever.
    if (mtime !== null && mtime > task.lastMtimeMs) {
      const status = await readStatus(task.statusPath)
      if (status) {
        task.lastMtimeMs = mtime
        this.transition(id, status.state, status)
        return
      }
      // Parsed-as-null on a changed file ⇒ caught mid-write (PRD #2). Do NOT
      // advance lastMtimeMs; retry next poll once the rename completes.
      tlog.debug('fresh write but parse-miss — will retry', {})
      return
    }

    // No fresh heartbeat this poll — staleness backstop (PRD §6.3, mtime-keyed).
    if (
      task.state !== 'stuck' &&
      isStale({ state: task.state as TaskState }, task.lastMtimeMs, this.clock(), this.opts.staleMs)
    ) {
      tlog.event('task-stuck', { lastMtimeMs: task.lastMtimeMs, staleMs: this.opts.staleMs })
      tlog.ui('task-row.stuck', { intent: task.intent }) // PRD §13.4 #2 + §6.3: offer check/kill/retry
      task.state = 'stuck'
      task.updatedAt = this.clock()
      this.emit('stuck', task)
      this.emit('updated', task)
    }
  }

  /** Apply a status payload to a task + emit the right events.
   *  Payload is Partial: callers (kill/dispatch-failure) supply only the fields
   *  they know; poll() supplies a full status read. */
  private transition(id: string, next: UiTaskState, payload?: Partial<StatusPayload>): void {
    const task = this.tasks.get(id)
    if (!task) return
    const tlog = log.child({ taskId: id })
    const prev = task.state
    task.state = next
    task.updatedAt = this.clock()
    if (payload?.result) task.result = payload.result
    if (payload?.error) task.error = payload.error
    if (payload?.question) task.question = payload.question
    if (payload?.recipe_suggestion) task.recipeSuggestion = payload.recipe_suggestion

    if (prev !== next) {
      tlog.event('state-transition', { from: prev, to: next, step: payload?.step })
    }

    switch (next) {
      case 'needs-user':
        // PRD §7 + §13.4 #5: amber row with the question; user answers, we pipe back.
        tlog.ui('task-row.needs-user', { question: task.question?.text, kind: task.question?.kind, irreversible: task.question?.irreversible })
        this.emit('needs-user', task)
        break
      case 'done':
        // PRD §13.4 #3: result lands ON the row. PRD §13.6: WE observe + notify.
        tlog.ui('task-row.done', { summary: task.result?.summary, artifacts: task.result?.artifacts })
        this.emit('done', task)
        // PRD §9: if the doer proposed a recipe, hand it to the (serialized)
        // librarian. Fire-and-forget — the user already has their result.
        if (this.opts.librarian && task.recipeSuggestion?.present) {
          tlog.event('recipe-suggestion-handoff', { scratch: task.recipeScratchPath })
          void this.opts.librarian.submit({
            taskId: task.id,
            intent: task.intent,
            scratchPath: task.recipeSuggestion.scratch_path ?? task.recipeScratchPath,
            cwd: task.cwd,
          }).catch((e) => tlog.error('librarian submit failed', { error: (e as Error).message }))
        }
        this.finish(id)
        break
      case 'failed': {
        // PRD §13.4 #4: surface WHY.
        tlog.ui('task-row.failed', { reason: task.error?.reason ?? '(no reason reported)' })
        if (!task.error) tlog.warn('failed with no error.reason — Claude under-reported')
        // PRD §12.3: detect a missing-integration gap → hand the user the fix.
        const gap = detectMcpGap([task.error?.reason, task.error?.detail].filter(Boolean).join(' '))
        if (gap) {
          task.mcpGap = gap
          tlog.ui('task-row.mcp-gap', { integration: gap.integration, fixCommand: gap.fixCommand })
        }
        this.emit('failed', task)
        this.finish(id)
        break
      }
      default:
        if (payload?.step) tlog.ui('task-row.step', { step: payload.step })
    }
    this.emit('updated', task)
  }

  /**
   * Answer a needs-user question by piping the answer into the session's stdin
   * (PRD §7.2). NEVER auto-answered — this is only ever called with a real user
   * answer (PRD §7.3, §1.4).
   */
  answer(id: string, userAnswer: string): void {
    const tlog = log.child({ taskId: id })
    const ex = this.executors.get(id)
    if (!ex || !ex.alive) {
      tlog.warn('answer dropped — no live session', {})
      return
    }
    tlog.ui('task-row.answer-submitted', { answer: userAnswer }) // user spoke/typed an answer
    ex.writeStdin(userAnswer)
    // Optimistically return to processing; the heartbeat will confirm.
    const task = this.tasks.get(id)
    if (task && task.state === 'needs-user') {
      task.state = 'processing'
      task.updatedAt = this.clock()
      this.emit('updated', task)
    }
  }

  /** Instant kill (PRD §10.4). Closes the session; marks failed if not terminal. */
  kill(id: string): void {
    const tlog = log.child({ taskId: id })
    tlog.ui('task-row.killed', {})
    const ex = this.executors.get(id)
    ex?.kill()
    const task = this.tasks.get(id)
    if (task && !TERMINAL.includes(task.state)) {
      this.transition(id, 'failed', { state: 'failed', error: { reason: 'Stopped by you' } })
    } else {
      this.finish(id)
    }
  }

  /** Stop polling + close the session. PRD §5.4 / §10.2: don't destroy evidence —
   *  the status file (with result/error) stays on disk for the history/log. */
  private finish(id: string): void {
    const timer = this.timers.get(id)
    if (timer) {
      clearInterval(timer)
      this.timers.delete(id)
    }
    const ex = this.executors.get(id)
    if (ex?.alive) {
      // PRD §4.5: the REPL won't exit on its own — close it explicitly.
      ex.kill()
    }
    this.executors.delete(id)
    log.child({ taskId: id }).event('task-finished', { state: this.tasks.get(id)?.state })
  }
}
