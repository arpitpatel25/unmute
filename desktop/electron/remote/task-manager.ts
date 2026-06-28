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
import { promises as fs } from 'node:fs'
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
import { installHooks, hookActivityMs } from './hooks'
import { installSkillsIntoCwd, installProfileIntoCwd } from './skills'
import { detectSurface } from './surface'
import { readNurseryRecipes, listRecipes, isStaleHigh, selectNurseryWithinBudget, type Confidence } from './recipe-store'
import { detectMcpGap, type McpGap } from './mcp-gap'
import type { Librarian } from './librarian'
import type { AgentExecutor, ExecutorFactory } from './executor'
import { settleRepl } from './repl-settle'

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
  /** mtime (ms) of the last status write we APPLIED — purely the read cursor for
   *  "is there a newer status write to process?" (status path only). MUST NOT be
   *  advanced by hook activity, or a status write older than a later hook event
   *  (e.g. the Stop hook firing after the model wrote 'done') becomes invisible
   *  and the terminal state is never read. */
  lastMtimeMs: number
  /** Liveness clock for the staleness/stuck backstop (PRD §6.3): the latest of a
   *  status write OR a deterministic hook event (hooks.ts). Decoupled from
   *  lastMtimeMs so hook heartbeats keep a task alive WITHOUT hiding status reads. */
  lastHeartbeatMs: number
  /** Executor self-classification (drives presentation + lifecycle). */
  category?: StatusPayload['category']
  /** Latest short progress label the executor wrote ("Editing X · 12/18 tests").
   *  Surfaced on running tasks in the overlay; purely informational. */
  step?: string
  result?: StatusPayload['result']
  error?: StatusPayload['error']
  question?: StatusPayload['question']
  recipeSuggestion?: StatusPayload['recipe_suggestion']
  /** Set on failure when the error looks like a missing-integration gap (PRD §12.3). */
  mcpGap?: McpGap
  /** The detected (or router-emitted) surface this task operates on — scopes
   *  memory injection (recipes/skills) + the librarian handoff. */
  surface?: string
  /** managed = Unmute injects its memory (recipes/profile/skills) + arms the
   *  librarian handoff; raw = no Unmute memory injection, no handoff. Default
   *  'managed' (status quo). */
  mode?: 'managed' | 'raw'
  /** What memory Unmute injected at dispatch (graduated skills matched + nursery
   *  leads). Recorded so the librarian can grade the trace against it. */
  injectedRecipes?: Array<{ name: string; tier: 'nursery' | 'skill'; surface: string }>
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
  /** ms to wait after typing the dispatch payload before sending an explicit
   *  confirm Enter. Claude's input occasionally lands one Enter short of
   *  submitting a multi-line payload (proven: a manual Enter unsticks it), so we
   *  always send a second Enter once the input has settled. Default 450. */
  submitConfirmMs?: number
  /** ms after dispatch to verify the prompt actually submitted (via the
   *  UserPromptSubmit hook touching .unmute-activity). If no submit is seen by
   *  then, the payload was swallowed (e.g. REPL tipped into reverse-search while
   *  painting) — we Esc-clear and re-inject. Default 7000. */
  verifyAfterMs?: number
  /** Max times to re-inject a dispatch that never submitted. Default 2. */
  maxReinjects?: number
  /** Keep a session WARM this long after it reaches done/failed, so a follow-up
   *  ("now reply to #2") can continue it with full context (minimal continuation).
   *  After this idle window with no follow-up, the session is hard-killed.
   *  Default 15 min; 0 = kill immediately on done (pure one-shot). The window
   *  resets on every follow-up, so an actively-continued thread stays alive. */
  warmMs?: number
  /** Warm window for \`navigate\` specifically. Navigate releases its browser tab
   *  glow-free (PRD §4b) but stays alive this long so the user can correct it
   *  ("no, the other one") as one continuous flow — shorter than warmMs since
   *  it's a quick correction window, not a long work thread. Default 8 min. */
  navigateWarmMs?: number
  /** ms to wait after asking a fire-and-forget (consume/watch/navigate) session
   *  to QUIT cleanly — so claude-in-chrome disconnects from the tab and the extension
   *  "glow" clears — before hard-killing as a backstop. Default 1500. */
  detachGraceMs?: number
  /** Recipe librarian (PRD §9). When set, a 'done' task that proposed a recipe
   *  suggestion is submitted for curation. Optional. */
  librarian?: Librarian
  /** Auto-purge: a task untouched (by updatedAt) for this long is hard-erased on
   *  the maintenance sweep — session killed, OUR scratch dir deleted, row removed.
   *  Keeps the user from accumulating hundreds of Unmute-spun Claude/tmux sessions.
   *  NEVER touches ~/.claude (Claude cleans its own transcripts on its own clock).
   *  Default 24h ("gone by end of day"). */
  purgeAgeMs?: number
  /** How often the maintenance sweep runs. Default 1h. */
  purgeSweepMs?: number
  /** Best-effort reaper for an ORPHAN tmux session left by a past run (the app
   *  crashed/quit without killing it). Wired from init.ts (which owns the tmux
   *  bin + private socket). Omitted in tests. */
  reapSession?: (taskId: string) => void
  /** clock + sleep injectable for tests. */
  now?: () => number
}

type TaskEvent = 'created' | 'updated' | 'needs-user' | 'stuck' | 'done' | 'failed' | 'removed'

const TERMINAL: UiTaskState[] = ['done', 'failed']

/** Strip the TUI's ANSI/OSC/control noise from a raw PTY buffer and keep a
 *  readable tail — enough for the librarian to see what the doer actually did
 *  (tools called, key outputs) without shipping the whole megabyte. */
function cleanTranscriptTail(raw: string, maxChars = 4000): string {
  const clean = raw
    .replace(/\u001b\][^\u0007]*\u0007/g, '')          // OSC (title) sequences
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')         // CSI (color/cursor) sequences
    .replace(/[\u0000-\u0008\u000b-\u001f]/g, ' ')     // stray control chars
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return clean.length > maxChars ? clean.slice(-maxChars) : clean
}

export class TaskManager extends EventEmitter {
  private tasks = new Map<string, Task>()
  private executors = new Map<string, AgentExecutor>()
  private timers = new Map<string, ReturnType<typeof setInterval>>()
  // Idle-kill timers for WARM sessions (kept alive after done for follow-ups).
  private warmTimers = new Map<string, ReturnType<typeof setTimeout>>()
  // Background auto-purge sweep (null until startMaintenance()).
  private purgeTimer: ReturnType<typeof setInterval> | null = null
  // Per-task ring buffer of recent PTY output for render-on-demand (PRD §13.4#8).
  private outputBuffers = new Map<string, string>()
  private static readonly OUTPUT_CAP = 200_000 // chars kept per task
  private readonly opts:
    Required<Omit<TaskManagerOpts, 'userKey' | 'now' | 'librarian' | 'reapSession'>> &
    Pick<TaskManagerOpts, 'userKey' | 'now' | 'librarian' | 'reapSession'>

  constructor(opts: TaskManagerOpts) {
    super()
    this.opts = {
      executorFactory: opts.executorFactory,
      baseDir: opts.baseDir ?? join(homedir(), '.unmute', 'remote'),
      pollMs: opts.pollMs ?? 1000,
      staleMs: opts.staleMs ?? 4 * 60_000,
      trustAcceptMs: opts.trustAcceptMs ?? 2000,
      submitConfirmMs: opts.submitConfirmMs ?? 450,
      verifyAfterMs: opts.verifyAfterMs ?? 7000,
      maxReinjects: opts.maxReinjects ?? 2,
      warmMs: opts.warmMs ?? 15 * 60_000,
      navigateWarmMs: opts.navigateWarmMs ?? 8 * 60_000,
      detachGraceMs: opts.detachGraceMs ?? 1500,
      purgeAgeMs: opts.purgeAgeMs ?? 24 * 60 * 60_000, // 24h — "gone by end of day"
      purgeSweepMs: opts.purgeSweepMs ?? 60 * 60_000,  // hourly
      userKey: opts.userKey ?? 'local',
      librarian: opts.librarian,
      reapSession: opts.reapSession,
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
  async dispatch(intent: string, opts: { surface?: string; mode?: 'managed' | 'raw' } = {}): Promise<string> {
    const id = randomUUID()
    const dir = join(this.opts.baseDir, this.opts.userKey!, id)
    const statusPath = join(dir, 'status.json')
    const recipeScratchPath = join(dir, 'recipe.json')
    const now = this.clock()
    const tlog = log.child({ taskId: id })
    const surface = opts.surface ?? detectSurface(intent)
    const mode = opts.mode ?? 'managed'

    const task: Task = {
      id, intent, state: 'processing', createdAt: now, updatedAt: now,
      cwd: dir, statusPath, recipeScratchPath, lastMtimeMs: now, lastHeartbeatMs: now,
      surface, mode, injectedRecipes: [],
    }
    this.tasks.set(id, task)
    tlog.event('task-created', { intent, cwd: dir })
    tlog.ui('task-row.added', { intent, state: 'processing' }) // PRD §13.4 #1: row shows cleaned intent

    this.emit('created', task)

    try {
      await scaffoldStatusFile(statusPath) // Unmute owns creation (PRD §6.1)
      // Seed the heartbeat clock from the scaffold's real mtime so staleness is
      // measured from "task start", not the logical createdAt.
      task.lastMtimeMs = task.lastHeartbeatMs = (await statusMtimeMs(statusPath)) ?? now
      await installContract(dir) // CLAUDE.md auto-load (#3)
      // Deterministic lifecycle hooks: heartbeat on real progress + enforce a
      // status write before the turn ends. Best-effort — a failure here must not
      // block dispatch (without hooks the task runs on the status-file path, i.e.
      // today's behaviour). See hooks.ts.
      await installHooks(dir).catch((e) => tlog.warn('installHooks failed — running without hooks', { error: (e as Error).message }))

      // ── Memory injection (managed mode only). Raw mode SKIPS all three Unmute
      //    memory injections (skills copy, profile, nursery leads) — protocol +
      //    orchestration (scaffold/meta/contract/hooks above) still run. (§4.2) ──
      let nurseryForDispatch: Array<{ name: string; confidence: Confidence; body: string }> = []
      let staleNotes: string[] = []
      if (mode === 'managed') {
        await installSkillsIntoCwd(dir, { surface, baseDir: this.opts.baseDir }) // graduated skills auto-discovery, surface-scoped (PRD §8.3)
        await installProfileIntoCwd(dir, this.opts.baseDir) // user facts/prefs the doer Reads on demand
        const nurseryAll = await readNurseryRecipes(surface, this.opts.baseDir).catch((e) => {
          // TEMP(memory-debug): remove after calibration
          tlog.warn('nursery read failed — no leads injected', { MEMORY_DEBUG: true, error: (e as Error).message }); return []
        })
        // Flood-backstop: in healthy operation this keeps everything (executor
        // judges relevance); it only trims when a surface is bloated — and a trim
        // is a CLEANUP signal (logged), never a silent drop of a relevant recipe.
        const { kept: nursery, trimmed } = selectNurseryWithinBudget(nurseryAll)
        if (trimmed > 0) {
          tlog.warn('nursery injection trimmed to budget — surface may be bloated, consider cleanup', {
            MEMORY_DEBUG: true, surface, total: nurseryAll.length, kept: nursery.length, trimmed,
          })
        }
        nurseryForDispatch = nursery.map((r) => ({ name: r.frontmatter.name, confidence: r.frontmatter.confidence, body: r.body }))
        const graduated = await listRecipes({ tier: 'skill', surface, baseDir: this.opts.baseDir }).catch((e) => {
          // TEMP(memory-debug): remove after calibration
          tlog.warn('graduated read failed', { MEMORY_DEBUG: true, error: (e as Error).message }); return []
        })
        staleNotes = graduated
          .filter((r) => isStaleHigh(r, this.clock()))
          .map((r) => `${r.frontmatter.name} is high-confidence but unverified for a while — confirm before relying.`)
        task.injectedRecipes = [
          ...nursery.map((r) => ({ name: r.frontmatter.name, tier: 'nursery' as const, surface })),
          ...graduated.map((r) => ({ name: r.frontmatter.name, tier: 'skill' as const, surface })),
        ]
      }
      // Persist a tiny receipt so the task survives an app crash/restart. The
      // intent (what the user asked) lives only in memory + here — status.json
      // holds the result, never the original ask. rehydrate() reads it on launch.
      // Written AFTER injectedRecipes is computed so the persisted value is correct.
      await fs.writeFile(join(dir, 'meta.json'), JSON.stringify({ id, intent, createdAt: now, surface, mode, injectedRecipes: task.injectedRecipes }))
      // TEMP(memory-debug): remove after calibration
      tlog.event('dispatch-memory', { MEMORY_DEBUG: true, surface, mode, injectedRecipes: task.injectedRecipes, staleNotes: staleNotes.length })

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

      // Drive past Claude Code's folder-trust prompt (and any boot prompts) using
      // ONLY Enter, gated on OBSERVED output — never a timer, never Esc. The trust
      // dialog appears on the first run in a fresh dir EVEN with
      // --dangerously-skip-permissions (validated by the Task-0 probe); its footer
      // is literally "Enter to confirm · Esc to cancel", so Esc = "No, exit" and
      // QUITS Claude. Enter accepts the pre-selected "Yes, I trust this folder" and
      // is a harmless no-op on an empty prompt. We send Enter whenever output goes
      // quiet, and stop only once the REPL reaches its idle input prompt (the
      // "bypass permissions" footer) or we hit the bounds — THEN we dispatch, so
      // the prompt can never land mid-dialog or mid-paint (the old race that left
      // the prompt unsubmitted and got the session Esc-killed by recovery).
      // Gated on trustAcceptMs>0 so tests (which pass 0 with a no-output fake
      // executor) dispatch instantly; production keeps the default (>0).
      if (this.opts.trustAcceptMs > 0) {
        await settleRepl({
          getOutput: () => this.outputBuffers.get(id) ?? '',
          isAlive: () => ex.alive,
          sendEnter: () => ex.write('\r'),
          onEvent: (event, fields) => tlog.event(event, fields),
        })
      }
      tlog.event('folder-trust-accepted', {})

      const payload = mode === 'managed'
        ? buildDispatch({ intent, statusPath, recipeScratchPath, nurseryRecipes: nurseryForDispatch, staleNotes })
        : buildDispatch({ intent, statusPath, recipeScratchPath })
      const dispatchedAt = Date.now()
      ex.writeStdin(payload)
      tlog.event('task-dispatched', {})

      // Reliability fix: the multi-line payload occasionally lands one Enter
      // short of submitting in Claude's input box (proven on-device — a manual
      // Enter unstuck a hung task). After the input settles, send an explicit
      // confirm Enter so dispatch always submits. A spare Enter on an already-
      // submitted prompt is a harmless no-op (empty input).
      await new Promise((r) => setTimeout(r, this.opts.submitConfirmMs))
      if (ex.alive) {
        ex.write('\r')
        tlog.event('submit-confirm-enter', { afterMs: this.opts.submitConfirmMs })
      }

      this.startPolling(id)
      // Verify the prompt ACTUALLY submitted, and self-heal if not. The
      // multi-line payload can get swallowed if it lands while the REPL is still
      // painting — Claude's TUI mis-reads the embedded newlines and tips into
      // reverse-search ("(search up)"), so the task sits at 0s forever with an
      // empty prompt. We detect this via the UserPromptSubmit hook (it touches
      // .unmute-activity ONLY on a real submit); if no such activity appears, we
      // clear the input line with Ctrl-U (NEVER Esc — Esc = "No, exit" on a
      // dialog and QUITS Claude) and re-inject. Background, fire-and-forget —
      // adds ZERO latency to the happy path.
      void this.verifyDispatch(id, ex, payload, dir, dispatchedAt)
    } catch (e) {
      tlog.error('dispatch failed before polling', { error: (e as Error).message })
      this.transition(id, 'failed', { error: { reason: 'Could not start the task', detail: (e as Error).message } })
    }
    return id
  }

  /** Verify the dispatched prompt actually SUBMITTED; self-heal if it didn't.
   *  Signal: the UserPromptSubmit hook touches .unmute-activity ONLY on a real
   *  submit, so hookActivityMs() returning null/old after dispatch means the
   *  payload was swallowed (e.g. the REPL tipped into reverse-search while still
   *  painting — the task then sits at 0s forever). We clear the input line with
   *  Ctrl-U (NEVER Esc — Esc = "No, exit" on a dialog and QUITS Claude), then
   *  re-inject. Bounded retries; only ever fires on a genuinely-unsubmitted
   *  prompt, so it can't double-dispatch a live one. */
  private async verifyDispatch(
    id: string,
    ex: AgentExecutor,
    payload: string,
    dir: string,
    dispatchedAt: number,
  ): Promise<void> {
    const tlog = log.child({ taskId: id })
    for (let attempt = 1; attempt <= this.opts.maxReinjects; attempt++) {
      await new Promise((r) => setTimeout(r, this.opts.verifyAfterMs))
      const task = this.tasks.get(id)
      // Stop if the task is gone, the PTY died, or it already finished.
      if (!task || !ex.alive || task.state === 'done' || task.state === 'failed') return
      const activity = await hookActivityMs(dir)
      // A UserPromptSubmit at/after our dispatch = the prompt submitted → done.
      // (1s slack absorbs clock/mtime granularity.)
      if (activity !== null && activity >= dispatchedAt - 1000) return
      // Never submitted → clear any stuck partial input, re-inject.
      tlog.warn('dispatch not confirmed (no submit) — clearing input and re-injecting', { attempt })
      ex.write('\x15') // Ctrl-U — clear the input line; safe (NEVER Esc, which quits Claude)
      await new Promise((r) => setTimeout(r, 200))
      if (!ex.alive) return
      ex.writeStdin(payload)
      await new Promise((r) => setTimeout(r, this.opts.submitConfirmMs))
      if (ex.alive) ex.write('\r')
      tlog.event('dispatch-reinjected', { attempt })
    }
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
        task.lastMtimeMs = mtime          // advance the status read cursor
        task.lastHeartbeatMs = mtime      // a status write is also a heartbeat
        this.transition(id, status.state, status)
        return
      }
      // Parsed-as-null on a changed file ⇒ caught mid-write (PRD #2). Do NOT
      // advance lastMtimeMs; retry next poll once the rename completes.
      tlog.debug('fresh write but parse-miss — will retry', {})
      return
    }

    // DETERMINISTIC hook heartbeat (hooks.ts): real progress (PostToolUse) and
    // turn boundaries advance LIVENESS even when the model didn't write `step`.
    // CRITICAL: this advances lastHeartbeatMs ONLY — never lastMtimeMs. The Stop
    // hook fires AFTER the model writes its final 'done' status, so the hook mtime
    // is LATER than that status write; if we let it touch lastMtimeMs (the read
    // cursor) the 'done' write would be < cursor and never read → the task would
    // sit and then false-stuck (observed). It keys off real tool execution, not
    // TUI redraw noise, so a genuinely hung task (no hook events) still goes stale.
    // If hooks never fired, hookMs is null ⇒ staleness falls back to status mtime.
    const hookMs = await hookActivityMs(task.cwd)
    if (hookMs !== null && hookMs > task.lastHeartbeatMs) {
      task.lastHeartbeatMs = hookMs
      return
    }

    // No fresh heartbeat this poll — staleness backstop (PRD §6.3). Keyed on
    // lastHeartbeatMs (status writes OR hook activity), NOT the status read cursor.
    if (
      task.state !== 'stuck' &&
      isStale({ state: task.state as TaskState }, task.lastHeartbeatMs, this.clock(), this.opts.staleMs)
    ) {
      tlog.event('task-stuck', { lastHeartbeatMs: task.lastHeartbeatMs, staleMs: this.opts.staleMs })
      // Cheap recovery before surfacing stuck: a task is sometimes just one Enter
      // short of submitting/continuing (the same input quirk we confirm-Enter for
      // at dispatch). Send ONE Enter — a no-op if it's genuinely busy. If it
      // recovers, the next heartbeat transitions it back out of stuck.
      const stuckEx = this.executors.get(id)
      if (stuckEx?.alive) {
        stuckEx.write('\r')
        tlog.event('stuck-nudge-enter', {})
      }
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
    if (payload?.category) task.category = payload.category
    if (payload?.step) task.step = payload.step
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
        // Phase timing: how long the doer (executor) held this task end-to-end.
        tlog.event('phase-timing', { taskId: task.id, phase: 'executor', ms: this.clock() - task.createdAt })
        // PRD §9: ALWAYS hand the finished task to the (serialized) librarian —
        // it, not the doer, decides whether anything durable was learned
        // (profile fact / reusable skill) or it's a no-op. ASYNC + fire-and-
        // forget: the user already has their result; the librarian NEVER blocks
        // 'done'. It curates from what the task actually DID (summary/detail +
        // transcript), so the doer no longer needs to flag anything.
        this.handToLibrarian(task, 'done')
        // Lifecycle by category (DECIDED): consume/watch are fire-and-forget —
        // DETACH now (quit the session cleanly so the Claude-in-Chrome "glow"
        // clears) and don't hold a session; the user just walks away from the
        // media. navigate, info, and act all PARK WARM for a follow-up — the
        // executor already released the tab glow-free (PRD §4b), so a warm
        // navigate session holds NO glow, it just stays alive briefly (shorter
        // window, see navigateWarmMs) so a correction ("no, the other one")
        // continues the same session with full context instead of respawning.
        if (task.category === 'consume' || task.category === 'watch') {
          this.detachAndKill(id)
        } else {
          this.parkWarm(id)
        }
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
        // PRD §9 (delta F): a task that FAILED while carrying an injected recipe
        // is exactly a contradiction signal — hand it off so the librarian can
        // demote. handToLibrarian gates on managed + non-empty injectedRecipes.
        this.handToLibrarian(task, 'failed')
        this.parkWarm(id) // a failed task can still be continued/retried while warm
        break
      }
      default:
        if (payload?.step) tlog.ui('task-row.step', { step: payload.step })
    }
    this.emit('updated', task)
  }

  /** Hand a terminal task to the (serialized) librarian for curation (PRD §9).
   *  Fire-and-forget — the user already has their result; this NEVER blocks the
   *  UI. Gated: only MANAGED tasks (raw tasks injected no memory, so there is
   *  nothing to grade), only when a librarian is wired. On 'failed' it fires ONLY
   *  if the task carried injected memory (a wrong injected recipe is a
   *  contradiction signal — delta F); a recipe-less failure is just noise. The
   *  librarian grades the trace against `injectedRecipes` + outcome. */
  private handToLibrarian(task: Task, outcome: 'done' | 'failed'): void {
    if (task.mode !== 'managed' || !this.opts.librarian) return
    if (outcome === 'failed' && !task.injectedRecipes?.length) return
    const tlog = log.child({ taskId: task.id })
    // TEMP(memory-debug): remove after calibration
    tlog.event('librarian-handoff', { taskId: task.id, outcome, MEMORY_DEBUG: true, fired: true, injectedRecipes: task.injectedRecipes?.length ?? 0 })
    void this.opts.librarian.submit({
      taskId: task.id,
      intent: task.intent,
      scratchPath: task.recipeScratchPath,
      cwd: task.cwd,
      summary: task.result?.summary,
      detail: task.result?.detail,
      category: task.category,
      transcript: cleanTranscriptTail(this.outputBuffers.get(task.id) ?? ''),
      injectedRecipes: task.injectedRecipes ?? [],
      outcome,
    }).catch((e) => tlog.error('librarian submit failed', { error: (e as Error).message }))
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
    // Same submit-confirm as dispatch/followUp — the input occasionally lands one
    // Enter short of submitting, which would leave the blocked task waiting forever.
    void (async () => {
      await new Promise((r) => setTimeout(r, this.opts.submitConfirmMs))
      if (ex.alive) { ex.write('\r'); tlog.event('submit-confirm-enter', { afterMs: this.opts.submitConfirmMs, via: 'answer' }) }
    })()
    // Optimistically return to processing; the heartbeat will confirm.
    const task = this.tasks.get(id)
    if (task && task.state === 'needs-user') {
      task.state = 'processing'
      task.updatedAt = this.clock()
      this.emit('updated', task)
    }
  }

  /** Instant kill (PRD §10.4). Closes the session; marks failed if not terminal. */
  /** Explicit user stop (PRD §10.4). Hard-kills the session immediately. */
  kill(id: string): void {
    const tlog = log.child({ taskId: id })
    tlog.ui('task-row.killed', {})
    const task = this.tasks.get(id)
    if (task && !TERMINAL.includes(task.state)) {
      task.state = 'failed'
      task.error = { reason: 'Stopped by you' }
      task.updatedAt = this.clock()
      this.emit('updated', task)
      this.emit('failed', task)
    }
    this.hardKill(id) // explicit stop ⇒ no warm window
  }

  /**
   * Kill/Delete (PRD §10.4 hard erase). Terminates the session, removes the task
   * from the list ENTIRELY, and deletes its scratch dir. This is the destructive
   * "nuke it" the user confirms — distinct from kill()/Stop which keeps the row.
   * The scratch dir holds only status/recipe + the session cwd, never the user's
   * real deliverables (those land wherever Claude put them).
   */
  async remove(id: string): Promise<void> {
    const tlog = log.child({ taskId: id })
    tlog.ui('task-row.removed', {})
    const task = this.tasks.get(id)
    this.hardKill(id) // terminate session (PTY + tmux kill-session)
    this.tasks.delete(id)
    this.outputBuffers.delete(id)
    if (task) {
      try { await fs.rm(task.cwd, { recursive: true, force: true }) } catch (e) {
        tlog.warn('remove: scratch dir delete failed', { error: (e as Error).message })
      }
    }
    this.emit('removed', { id } as unknown as Task)
    tlog.event('task-removed', {})
  }

  /**
   * Rebuild the in-memory task list from disk on launch so the user's tasks
   * SURVIVE an app crash/restart — from the user's view they were lost (the UI
   * was empty), even though the durable meta.json (intent) + status.json
   * (state/result) were on disk the whole time. Adds rows the user can view and
   * resume(); it does NOT re-attach a still-live session (resume respawns on
   * demand). A task that was mid-run when the app died is surfaced as 'failed'
   * (interrupted) — honest, and still resumable. Run BEFORE startMaintenance so
   * the sweep can then purge anything too old. Idempotent (skips tasks already
   * in memory / dirs without a receipt).
   */
  async rehydrate(): Promise<void> {
    const root = join(this.opts.baseDir, this.opts.userKey ?? 'local')
    let ids: string[]
    try { ids = await fs.readdir(root) } catch { return } // nothing on disk yet
    let restored = 0
    for (const id of ids) {
      if (this.tasks.has(id)) continue
      const dir = join(root, id)
      let meta: { intent?: string; createdAt?: number; surface?: string; mode?: 'managed' | 'raw'; injectedRecipes?: Array<{ name: string; tier: 'nursery' | 'skill'; surface: string }> }
      try { meta = JSON.parse(await fs.readFile(join(dir, 'meta.json'), 'utf8')) } catch { continue }
      if (!meta.intent) continue // pre-receipt task or junk dir — skip
      const statusPath = join(dir, 'status.json')
      const status = await readStatus(statusPath)
      const now = this.clock()
      const terminal = status?.state === 'done' || status?.state === 'failed'
      const task: Task = {
        id,
        intent: meta.intent,
        // A non-terminal task whose session died with the app is, to the user,
        // interrupted — surface it as failed (still resumable) rather than a
        // forever-spinning 'processing'.
        state: terminal ? status!.state : 'failed',
        createdAt: meta.createdAt ?? now,
        updatedAt: (await statusMtimeMs(statusPath)) ?? meta.createdAt ?? now,
        cwd: dir,
        statusPath,
        recipeScratchPath: join(dir, 'recipe.json'),
        lastMtimeMs: now,
        lastHeartbeatMs: now,
        category: status?.category,
        result: status?.result,
        error: terminal ? status?.error : { reason: 'Interrupted by an app restart — resume to continue' },
        question: status?.question,
        surface: meta.surface,
        mode: meta.mode ?? 'managed',
        injectedRecipes: meta.injectedRecipes ?? [],
      }
      this.tasks.set(id, task)
      this.emit('created', task)
      restored++
    }
    if (restored) log.event('rehydrated', { restored })
  }

  /**
   * Start the background maintenance sweep: hard-erase any task untouched (by
   * updatedAt) for >= purgeAgeMs (default 24h). This is what keeps a user from
   * ending up with hundreds of Unmute-spun Claude/tmux sessions + scratch dirs.
   * Runs once now, then every purgeSweepMs. Idempotent (a second call is a no-op).
   * Call once at app start (init.ts). Reuses remove() — the SAME proven path as
   * the manual ✕ — so there is no new deletion logic to get wrong.
   */
  startMaintenance(): void {
    if (this.purgeTimer) return
    void this.purgeStale()
    this.purgeTimer = setInterval(() => { void this.purgeStale() }, this.opts.purgeSweepMs)
    // Don't keep the process alive just for the sweep.
    ;(this.purgeTimer as { unref?: () => void }).unref?.()
    log.event('maintenance-started', { purgeAgeMs: this.opts.purgeAgeMs, purgeSweepMs: this.opts.purgeSweepMs })
  }

  /** Stop the maintenance sweep (shutdown / tests). */
  stopMaintenance(): void {
    if (this.purgeTimer) { clearInterval(this.purgeTimer); this.purgeTimer = null }
  }

  /**
   * Hard-erase every task untouched for >= purgeAgeMs (ANY state — this also
   * reaps a still-alive session left behind by an abandoned needs-user/stuck
   * task, which otherwise never gets its warm-timeout). Scoped to OUR scratch dir
   * via remove(); NEVER touches ~/.claude. Public so it can be unit-tested.
   */
  async purgeStale(): Promise<void> {
    const cutoff = this.clock() - this.opts.purgeAgeMs
    // 1. IN-MEMORY tasks that have aged out — remove() kills the live session too.
    const stale = [...this.tasks.values()].filter((t) => t.updatedAt < cutoff)
    if (stale.length) {
      log.event('purge-sweep', { count: stale.length })
      for (const t of stale) await this.remove(t.id)
    }
    // 2. ON-DISK ORPHAN dirs from PAST runs. Tasks are in-memory only (no disk
    //    rehydrate), so yesterday's dirs are never in `this.tasks` and the sweep
    //    above can't see them — they'd accumulate forever. Scan our own root and
    //    erase any dir older than the cutoff that isn't an active in-memory task,
    //    reaping any orphan tmux session it left behind. Scoped to OUR baseDir;
    //    NEVER touches ~/.claude.
    await this.purgeOrphanDirs(cutoff)
  }

  private async purgeOrphanDirs(cutoff: number): Promise<void> {
    const root = join(this.opts.baseDir, this.opts.userKey ?? 'local')
    let ids: string[]
    try { ids = await fs.readdir(root) } catch { return } // root not created yet
    let removed = 0
    for (const id of ids) {
      if (this.tasks.has(id)) continue // active in memory — handled in pass 1
      const dir = join(root, id)
      let mtimeMs: number
      try {
        const st = await fs.stat(dir)
        if (!st.isDirectory()) continue
        mtimeMs = st.mtimeMs // dir mtime advances on every status (atomic rename) ≈ last activity
      } catch { continue }
      if (mtimeMs >= cutoff) continue // recent orphan (e.g. a just-crashed run) — keep
      try { this.opts.reapSession?.(id) } catch { /* best-effort */ }
      try { await fs.rm(dir, { recursive: true, force: true }) } catch { /* ignore */ }
      removed++
    }
    if (removed) log.event('purge-orphan-dirs', { removed })
  }

  /**
   * Master kill switch: terminate EVERY task's session at once (the UI "kill all"
   * control + app-quit). Marks any still-running task as stopped; does NOT erase
   * history. Guarantees no Claude/tmux session is left orphaned.
   */
  killAll(): void {
    const ids = [...this.executors.keys()]
    for (const id of ids) {
      const task = this.tasks.get(id)
      if (task && !TERMINAL.includes(task.state)) {
        task.state = 'failed'
        task.error = { reason: 'Stopped (kill all)' }
        task.updatedAt = this.clock()
        this.emit('updated', task)
        this.emit('failed', task)
      }
      this.hardKill(id)
    }
    log.event('kill-all', { count: ids.length })
  }

  /**
   * Continue a WARM (done/failed but still-alive) session with a follow-up
   * instruction (minimal continuation — the read-then-act case). Pipes the text
   * into the kept-alive PTY and resumes. Returns false if the session is gone
   * (caller should dispatch a fresh task instead).
   */
  followUp(id: string, text: string): boolean {
    const tlog = log.child({ taskId: id })
    const ex = this.executors.get(id)
    const task = this.tasks.get(id)
    if (!ex?.alive || !task) {
      tlog.warn('followUp: session no longer warm — caller should dispatch new', {})
      return false
    }
    // Cancel the idle-kill so the session can't be reaped while we wait below
    // for it to go idle.
    const wt = this.warmTimers.get(id)
    if (wt) { clearTimeout(wt); this.warmTimers.delete(id) }
    tlog.ui('task-row.follow-up', { text })
    // Show the task as working immediately — the command was accepted — even
    // though the actual write is deferred until the REPL is idle (below).
    task.state = 'processing'
    task.updatedAt = this.clock()
    this.emit('updated', task)

    // A follow-up is a FRESH dispatch into the SAME session — the only thing
    // shared is the terminal (for context). Send the full dispatch payload, not
    // raw text, so the model is re-anchored to the contract (status-file path +
    // "act now, update status"). Without this it answers conversationally and
    // never writes status → Unmute never learns it finished → marks it stuck.
    const payload = buildDispatch({ intent: text, statusPath: task.statusPath, recipeScratchPath: task.recipeScratchPath })

    void (async () => {
      // CRITICAL: wait until the REPL is genuinely idle at the prompt before
      // writing. A task writes status='done' MID-TURN (it can keep generating
      // for minutes afterwards), so 'done' does NOT mean the session is ready
      // for input. Writing the payload during active generation gets it
      // SWALLOWED — the instruction never registers as a turn and is silently
      // lost (observed live: a "move" follow-up vanished exactly this way).
      // isReady() resolves on a 700ms quiet gap and has its own hard-timeout
      // fallback, so this can't hang. Every other write path (dispatch / resume
      // / router / librarian) already gates on isReady(); this just makes
      // followUp consistent with them.
      await ex.isReady()
      if (!ex.alive) { tlog.warn('followUp: session died before it went idle — instruction NOT delivered', {}); return }
      ex.writeStdin(payload)
      // Start the heartbeat/stuck clock only NOW — when the instruction actually
      // lands — so a long idle-wait above can't trip the stale-stuck detector.
      task.lastMtimeMs = task.lastHeartbeatMs = this.clock() // reset so the old 'done' file isn't read as stale
      this.startPolling(id)
      tlog.event('task-followup', {})

      // Same submit-confirm as dispatch: the multi-line payload occasionally
      // lands one Enter short of submitting in Claude's input box.
      await new Promise((r) => setTimeout(r, this.opts.submitConfirmMs))
      if (ex.alive) { ex.write('\r'); tlog.event('submit-confirm-enter', { afterMs: this.opts.submitConfirmMs, via: 'followUp' }) }
    })()
    return true
  }

  /**
   * Resume a finished/reaped task: respawn its session with `--continue` in the
   * SAME cwd. Claude resume is cwd-scoped and each task owns one session, so this
   * continues THAT task with full prior context — no session-id tracking needed.
   * The transcript survives because we keep the task dir after kill. The session
   * comes back alive + warm (re-attachable terminal, ready for a follow-up).
   * Returns false if the task is unknown, already alive, or its dir was removed.
   */
  async resume(id: string): Promise<boolean> {
    const tlog = log.child({ taskId: id })
    const task = this.tasks.get(id)
    if (!task) { tlog.warn('resume: no such task'); return false }
    if (this.executors.get(id)?.alive) { tlog.event('resume-noop-already-alive', {}); return true }
    try { await fs.access(task.cwd) } catch { tlog.warn('resume: task dir gone — cannot resume', {}); return false }

    tlog.event('resume-start', { cwd: task.cwd })
    try {
      const ex = this.opts.executorFactory(true) // --continue (resume the cwd's session)
      this.executors.set(id, ex)
      this.outputBuffers.set(id, this.outputBuffers.get(id) ?? '')
      ex.onData((chunk) => {
        tlog.debug('pty-data', { chunk })
        const cur = (this.outputBuffers.get(id) ?? '') + chunk
        this.outputBuffers.set(id, cur.length > TaskManager.OUTPUT_CAP ? cur.slice(-TaskManager.OUTPUT_CAP) : cur)
        this.emit('output', { taskId: id, chunk })
      })
      await ex.spawn({ cwd: task.cwd, env: process.env, taskId: id })
      await ex.isReady()
      ex.writeStdin('') // accept folder-trust; session reopens with full prior context
      await new Promise((r) => setTimeout(r, this.opts.trustAcceptMs))
      // Alive + idle at the prompt: treat it like a warm session — re-arm the
      // idle window; followUp()/terminal can use it. No polling (status is
      // terminal; a follow-up will drive fresh updates).
      task.updatedAt = this.clock()
      this.parkWarm(id)
      this.emit('updated', task)
      tlog.event('resume-ready', {})
      return true
    } catch (e) {
      tlog.error('resume failed', { error: (e as Error).message })
      this.hardKill(id)
      return false
    }
  }

  /** Tasks currently BLOCKED on a needs-user question, newest first. The router
   *  uses this for voice answering: a paused task that explicitly asked you a
   *  question is the strongest target for your next utterance (PRD §7). */
  tasksAwaitingUser(): Task[] {
    return [...this.tasks.values()]
      .filter((t) => t.state === 'needs-user')
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** Tasks a follow-up could land on (for the router's snapshot): anything still
   *  blocked on you (needs-user) or with a live session (processing / parked-warm).
   *  Newest first. If empty, Unmute skips the router and dispatches a new task. */
  routableTasks(): Task[] {
    return [...this.tasks.values()]
      .filter((t) => t.state === 'needs-user' || this.executors.get(t.id)?.alive === true)
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** Warm, continuable sessions (terminal state but PTY still alive), newest first.
   *  Used by the router to decide whether a follow-up can land somewhere. */
  continuableTasks(): Task[] {
    return [...this.tasks.values()]
      .filter((t) => TERMINAL.includes(t.state) && this.executors.get(t.id)?.alive === true)
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** Forward RAW keystrokes from the live terminal into the session's PTY
   *  (PRD §4.3 typeable terminal). No carriage return is appended — xterm sends
   *  the exact bytes (including Enter as \r) the user typed. No-op if dead. */
  sendInput(id: string, data: string): void {
    const ex = this.executors.get(id)
    if (!ex?.alive) return
    // A user typing into a parked-warm session means they want to keep working;
    // cancel the idle-kill so their hands-on session isn't reaped under them.
    const wt = this.warmTimers.get(id)
    if (wt) { clearTimeout(wt); this.warmTimers.delete(id) }
    ex.write(data)
  }

  /** Resize a session's PTY to match the on-screen terminal (TUI reflow). */
  resize(id: string, cols: number, rows: number): void {
    this.executors.get(id)?.resize(cols, rows)
  }

  /** Is the task's PTY still alive (running or parked-warm)? The live terminal
   *  uses this to decide: repaint a live session clean vs. replay history. */
  isAlive(id: string): boolean {
    return this.executors.get(id)?.alive === true
  }

  private stopPolling(id: string): void {
    const timer = this.timers.get(id)
    if (timer) { clearInterval(timer); this.timers.delete(id) }
  }

  /** Warm window for a task, by category. navigate gets a shorter window
   *  (navigateWarmMs) — it's a quick "correct what I just opened" flow, not a
   *  long work thread like info/act (warmMs). */
  private warmMsFor(id: string): number {
    return this.tasks.get(id)?.category === 'navigate' ? this.opts.navigateWarmMs : this.opts.warmMs
  }

  /** Natural completion: stop polling but keep the session WARM for a follow-up
   *  window (minimal continuation). After the (per-category) warm window idle
   *  with no follow-up, hard-kill. Status file (result/error) stays on disk for
   *  history regardless (§10.2). */
  private parkWarm(id: string): void {
    this.stopPolling(id)
    const ex = this.executors.get(id)
    const warmMs = this.warmMsFor(id)
    if (!ex?.alive || warmMs <= 0) { this.hardKill(id); return }
    const tlog = log.child({ taskId: id })
    const t = setTimeout(() => {
      tlog.event('warm-idle-timeout', { warmMs })
      this.hardKill(id)
    }, warmMs)
    t.unref?.() // don't block process exit on the warm window
    this.warmTimers.set(id, t)
    tlog.event('parked-warm', { warmMs })
  }

  /** Hard close: stop polling, cancel warm timer, kill the PTY (PRD §4.5). */
  private hardKill(id: string): void {
    this.stopPolling(id)
    const wt = this.warmTimers.get(id)
    if (wt) { clearTimeout(wt); this.warmTimers.delete(id) }
    const ex = this.executors.get(id)
    if (ex?.alive) ex.kill() // the REPL won't exit on its own
    this.executors.delete(id)
    log.child({ taskId: id }).event('task-finished', { state: this.tasks.get(id)?.state })
  }

  /** Fire-and-forget cleanup for consume/watch/navigate: ask the REPL to QUIT cleanly
   *  first, so claude-in-chrome disconnects from the tab it was driving and the
   *  extension "glow" clears (an abrupt SIGHUP never disconnects, so the glow
   *  lingers). The tab keeps playing/displaying; control is re-acquired by a
   *  fresh task if the user wants to act on it later. Hard-kill is the backstop
   *  in case the clean quit doesn't take. */
  private detachAndKill(id: string): void {
    const tlog = log.child({ taskId: id })
    this.stopPolling(id)
    const ex = this.executors.get(id)
    if (!ex?.alive) { this.hardKill(id); return }
    try {
      ex.writeStdin('/exit') // clean quit ⇒ extension disconnect ⇒ glow clears
      tlog.event('graceful-detach', { graceMs: this.opts.detachGraceMs })
    } catch (e) {
      tlog.warn('graceful-detach write failed — hard-killing', { error: (e as Error).message })
      this.hardKill(id)
      return
    }
    // Backstop: ensure the session is actually gone even if /exit didn't take.
    const t = setTimeout(() => this.hardKill(id), this.opts.detachGraceMs)
    t.unref?.()
  }
}
