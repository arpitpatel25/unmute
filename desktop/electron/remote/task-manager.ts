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
import { buildDispatch, buildResumeNudge } from './dispatch-prompt'
import { installContract, readContractText } from './contract/installer'
import { installHooks, hookActivityMs } from './hooks'
import { installSkillsIntoCwd, installProfileIntoCwd } from './skills'
import { detectSurface } from './surface'
import { readNurseryRecipes, listRecipes, isStaleHigh, selectNurseryWithinBudget, type Confidence } from './recipe-store'
import { detectMcpGap, type McpGap } from './mcp-gap'
import { resolveTranscriptById } from './trace-reducer'
import { projectSlug } from './projects'
import type { Librarian } from './librarian'
import type { AgentExecutor, ExecutorFactory } from './executor'
import { settleRepl } from './repl-settle'
import { type AgentKind, isExternalAgent } from './codex-executor'
import type { CodexDesktopDriver } from './codex/driver'
import { beat, pendingApprovals, decideApproval, clearApproval, describeApproval, ensureApprovalHook } from './codex/hooks'

const log = createLogger('task-manager')

// ── UI-facing task state. Adds 'stuck' (PRD §5.3) on top of the file states. ──
export type UiTaskState = TaskState | 'stuck'

export interface Task {
  id: string
  intent: string
  /** Short display name for the session (2-5 words), generated async just after
   *  dispatch. The UI shows this instead of the full intent; undefined until it
   *  lands (UI falls back to a truncated intent). */
  name?: string
  /** Claude Code session id pinned for this task (minted at dispatch, passed as
   *  `--session-id`). A stable handle to THE session this task drives — used for
   *  resume, reading Claude's session store, and future orchestration. */
  sessionId: string
  /** Species (Orchestrate). 'oneoff' = today's fire-and-forget errand: scratch
   *  cwd, warm-window idle-kill, 24h purge. 'session' = a persistent working
   *  session (often multi-day, often project-bound): NEVER idle-killed, NEVER
   *  auto-purged — it lives until the user explicitly kills/removes it, and
   *  survives app restarts as interrupted-but-resumable (`--continue` restores
   *  full context). Default 'oneoff' (status quo). */
  kind?: 'oneoff' | 'session'
  /** WHICH BACKEND runs this task. Per-task, not a global setting: a user with
   *  both installed can fire one task at Claude Code and the next at Codex, and
   *  the cockpit shows both side by side. Absent ⇒ 'claude' (status quo).
   *
   *  'codex-desktop' is not an executor — Unmute owns no process for it. Its
   *  writes go through the Codex app via CDP and its state is polled from the
   *  rollout files; see codex/driver.ts. */
  agent?: AgentKind
  /** For 'codex-desktop': the Codex thread this task drives (durable id, no
   *  `local:` prefix). This is the whole handle — it addresses the rollout file
   *  for reads and the sidebar row for open/send. */
  codexThreadId?: string
  /** Last delivery problem — the message did not reach the agent. Distinct from
   *  `error`, which means the WORK failed; this one never settles the task. */
  deliveryError?: string
  /** True while a message is travelling to the agent. Sending is a round-trip
   *  through another app's window; silence for a second reads as nothing
   *  having happened. */
  sending?: boolean
  /** Codex's own label for what this thread runs on ("5.6 Terra High"), as it
   *  was when the task was created. */
  codexModelLabel?: string
  /** For 'codex-desktop': the Codex project the thread was created in, so the
   *  card can show it and follow-ups can re-scope. */
  codexProject?: string | null
  /** For external backends: the last few turns of the real conversation.
   *
   *  This is the GUI-agent equivalent of the live terminal. A CLI task shows a
   *  raw PTY because that IS its conversation; a Codex thread has no terminal,
   *  so the conversation itself has to be what the panel carries. Kept to the
   *  last few turns deliberately — enough to re-enter, never a re-implementation
   *  of the other app's chat (ORCHESTRATE-VISION §3, the delete-the-wall test). */
  conversation?: Array<{ role: 'user' | 'assistant'; text: string }>
  /** Workspace group — "what is this work about" ("unmute", "launch video",
   *  "on-call"). Assigned ONCE by the router (user's own words win), mutated
   *  only by user curation. Live groups = distinct values across live tasks;
   *  no registry, no history — the screen is the entire state (spec
   *  2026-07-16-cockpit-grouping). */
  group?: string
  state: UiTaskState
  createdAt: number
  updatedAt: number
  /** Where the agent RUNS. For oneoffs this is the scratch dir (=== home). For
   *  project-bound sessions this is the user's real project directory — which
   *  Unmute must treat as READ-ONLY territory (no meta/status/contract files). */
  cwd: string
  /** The Unmute-OWNED dir for this task (~/.unmute/remote/<u>/<id>): meta.json,
   *  status.json, recipe.json, attachments. Always ours to create/delete; cwd may
   *  equal it (scratch oneoff) or point elsewhere (project session). Deletion
   *  paths MUST use home, never cwd. */
  home: string
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
  /** Follow-up turns the user has sent this task (graduation signal: a one-off
   *  that keeps receiving follow-ups is a working session in denial). */
  followUps?: number
  /** Rolling "where you left off" (from status thread_context) — re-entry warm-up. */
  threadContext?: string
  /** When the USER last put something into this task (dispatch/follow-up/answer/
   *  typed input) — NEVER advanced by status heartbeats. This is the consent
   *  clock: a session is auto-routable only while this is recent ("hot thread");
   *  cold sessions are focus-only. */
  lastUserInputAt?: number
  /** Shelved (Orchestrate): deliberately preserved AND out of the way — hidden
   *  from the wall grid, exempt from auto-purge, findable in the rail's Shelf.
   *  The answer to "I want to keep this but stop seeing it". */
  shelved?: boolean
  /** User's free-form note pinned to the card (ticket link, context, a reminder
   *  to future-you). Pure annotation — never fed to the agent. */
  note?: string
  /** Provenance: the task id that spawned this one via the Unmute MCP (agent-
   *  created). Drives the card's "agent-spawned" chip and the depth-1 rule
   *  (a spawned task may not spawn). Undefined = human-created. */
  spawnedBy?: string
}

export interface TaskManagerOpts {
  /** Creates a fresh executor per task (default: ClaudeCodeExecutor). */
  executorFactory: ExecutorFactory
  /** Backend for `agent: 'codex-desktop'` tasks. Absent ⇒ those dispatches fail
   *  fast with a typed reason instead of silently falling back to Claude, which
   *  would put the task in an app the user never asked for. */
  codexDriver?: CodexDesktopDriver
  /** The user's approval setting, read fresh so a settings change takes effect
   *  on the NEXT task rather than needing a restart. Feeds the Codex composer's
   *  permission level exactly as it feeds --dangerously-skip-permissions. */
  permissionMode?: () => 'auto-approve' | 'ask'
  /** How often to look for Codex approval requests (ms). */
  approvalSweepMs?: number
  /** The user's Codex model/effort/speed choice, read fresh per dispatch. */
  codexReasoning?: () => { model?: string; effort?: string; speed?: string }
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
  /** A ready ONE-OFF the user has ignored for this long decays to done so it
   *  fades instead of haunting the queue (ready-inflation valve). Ready SESSIONS
   *  never decay. Default 1h. */
  readyDecayMs?: number
  /** Best-effort reaper for an ORPHAN tmux session left by a past run (the app
   *  crashed/quit without killing it). Wired from init.ts (which owns the tmux
   *  bin + private socket). Omitted in tests. */
  reapSession?: (taskId: string) => void
  /** clock + sleep injectable for tests. */
  now?: () => number
}

type TaskEvent = 'created' | 'updated' | 'needs-user' | 'stuck' | 'done' | 'failed' | 'removed'

/** Turn-over states: the session is parked, polling stopped, ball not with the
 *  agent. 'ready' = ball explicitly WITH THE USER (a checkpoint awaiting their
 *  direction) — parked like done, but queued as "your move" in the UI. */
const TERMINAL: UiTaskState[] = ['done', 'failed', 'ready']
/** Fully settled — kill() has nothing to mark, the librarian has been handed
 *  off, nothing awaits anyone. NOT 'ready' (killing a ready task must mark it
 *  stopped, or a dead task would sit in the your-move queue forever). */
const SETTLED: UiTaskState[] = ['done', 'failed']

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
  /** Per-task ready→done decay timers (see armReadyDecay). */
  private readyDecayTimers = new Map<string, ReturnType<typeof setTimeout>>()
  // Idle-kill timers for WARM sessions (kept alive after done for follow-ups).
  private warmTimers = new Map<string, ReturnType<typeof setTimeout>>()
  // Background auto-purge sweep (null until startMaintenance()).
  private purgeTimer: ReturnType<typeof setInterval> | null = null
  // Codex approval inbox sweep (null until startMaintenance()).
  private approvalTimer: ReturnType<typeof setInterval> | null = null
  /** threadId → the request we have already surfaced, so we transition once. */
  private surfacedApprovals = new Map<string, number>()
  /** Poll decimation for settled Codex tasks (see pollCodexDesktop). */
  private codexIdleTicks = new Map<string, number>()
  // Per-task chain serializing meta.json read-modify-writes. Two concurrent
  // merges (e.g. setShelved + setNote in one tick) would otherwise race the
  // read and the last write would silently drop the other's field.
  private metaChains = new Map<string, Promise<void>>()
  // Per-task ring buffer of recent PTY output for render-on-demand (PRD §13.4#8).
  private outputBuffers = new Map<string, string>()
  private static readonly OUTPUT_CAP = 200_000 // chars kept per task
  private readonly opts:
    Required<Omit<TaskManagerOpts, 'userKey' | 'now' | 'librarian' | 'reapSession' | 'codexDriver' | 'permissionMode' | 'codexReasoning'>> &
    Pick<TaskManagerOpts, 'userKey' | 'now' | 'librarian' | 'reapSession' | 'codexDriver' | 'permissionMode' | 'codexReasoning'>

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
      approvalSweepMs: opts.approvalSweepMs ?? 1500,
      readyDecayMs: opts.readyDecayMs ?? 60 * 60_000,  // 1h ready-inflation valve
      userKey: opts.userKey ?? 'local',
      librarian: opts.librarian,
      codexDriver: opts.codexDriver,
      permissionMode: opts.permissionMode,
      codexReasoning: opts.codexReasoning,
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

  /** Any task mid-turn ('processing')? Feeds the curator's idle-preference gate
   *  (a background sweep defers while a task is actively working). */
  hasProcessingTask(): boolean {
    for (const t of this.tasks.values()) if (t.state === 'processing') return true
    return false
  }

  /**
   * Dispatch a new task. Returns the taskId immediately; execution + polling
   * proceed asynchronously (PRD §4.4 — dispatch and forget).
   */
  async dispatch(intent: string, opts: { surface?: string; mode?: 'managed' | 'raw'; kind?: 'oneoff' | 'session'; cwd?: string; spawnedBy?: string; extraEnv?: Record<string, string>; forkFromSessionId?: string; agent?: AgentKind; project?: string | null } = {}): Promise<string> {
    // EXTERNAL BACKEND FORK (codex-desktop). Everything below this point — the
    // status file, the CLAUDE.md contract, the owned PTY, the trust prompt, the
    // dispatch payload — presumes Unmute spawns and owns the process. Codex
    // desktop is an app we drive, so it takes a different path entirely rather
    // than threading conditionals through 200 lines of PTY setup.
    if (isExternalAgent(opts.agent)) return this.dispatchCodexDesktop(intent, opts)
    const id = randomUUID()
    // Mint the Claude session id up front so we own a stable handle to the
    // session this task will spawn (passed as --session-id below).
    const sessionId = randomUUID()
    const dir = join(this.opts.baseDir, this.opts.userKey!, id)
    const statusPath = join(dir, 'status.json')
    const recipeScratchPath = join(dir, 'recipe.json')
    const now = this.clock()
    const tlog = log.child({ taskId: id })
    const surface = opts.surface ?? detectSurface(intent)
    const mode = opts.mode ?? 'managed'
    const kind = opts.kind ?? 'oneoff'

    // Project-bound spawn (Orchestrate): when a real directory is supplied, the
    // agent RUNS there — its git, its CLAUDE.md, its tooling all just work. The
    // user's directory is READ-ONLY territory for Unmute: every Unmute file
    // (meta/status/recipe/contract/hooks/skills) stays in `home` (our scratch
    // dir), and the contract travels INLINE in the dispatch payload instead of
    // being written as a CLAUDE.md. Validated + fail-safe: an unusable dir falls
    // back to the scratch spawn rather than failing the dispatch.
    let runCwd = dir
    if (opts.cwd) {
      try {
        const st = await fs.stat(opts.cwd)
        if (st.isDirectory()) runCwd = opts.cwd
        else tlog.warn('dispatch: cwd is not a directory — falling back to scratch', { cwd: opts.cwd })
      } catch {
        tlog.warn('dispatch: cwd does not exist — falling back to scratch', { cwd: opts.cwd })
      }
    }
    const external = runCwd !== dir

    const task: Task = {
      id, intent, sessionId, kind, state: 'processing', createdAt: now, updatedAt: now,
      cwd: runCwd, home: dir, statusPath, recipeScratchPath, lastMtimeMs: now, lastHeartbeatMs: now,
      surface, mode, injectedRecipes: [], lastUserInputAt: now,
      spawnedBy: opts.spawnedBy,
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
      // Contract + hooks are CWD-COUPLED (CLAUDE.md auto-load; .claude/settings.json
      // hooks) — installed only for the scratch spawn, where the cwd is ours. For a
      // project-bound session, writing either into the user's repo would pollute it
      // (and .claude/settings.json could CLOBBER the project's own); the contract
      // travels inline in the payload instead, and lifecycle falls back to the
      // status-file path (the documented pre-hooks behaviour — fail-open).
      if (!external) {
        await installContract(dir) // CLAUDE.md auto-load (#3)
        // Deterministic lifecycle hooks: heartbeat on real progress + enforce a
        // status write before the turn ends. Best-effort — a failure here must not
        // block dispatch (without hooks the task runs on the status-file path, i.e.
        // today's behaviour). See hooks.ts.
        await installHooks(dir).catch((e) => tlog.warn('installHooks failed — running without hooks', { error: (e as Error).message }))
      }

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
      await fs.writeFile(join(dir, 'meta.json'), JSON.stringify({ id, intent, sessionId, kind, createdAt: now, surface, mode, injectedRecipes: task.injectedRecipes, ...(external ? { cwd: runCwd } : {}), ...(opts.spawnedBy ? { spawnedBy: opts.spawnedBy } : {}) }))
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

      await ex.spawn({
        cwd: runCwd, env: process.env, taskId: id,
        // A fork cannot pin a session id — Claude mints the fork's own.
        sessionId: opts.forkFromSessionId ? undefined : sessionId,
        extraEnv: opts.extraEnv,
        forkFromSessionId: opts.forkFromSessionId,
      })
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

      // Project-bound spawn: the contract can't auto-load from a CLAUDE.md we
      // never wrote, so it rides inline in the payload (same obligations).
      const contractText = external ? await readContractText() : undefined
      const payload = mode === 'managed'
        ? buildDispatch({ intent, statusPath, recipeScratchPath, nurseryRecipes: nurseryForDispatch, staleNotes, contractText })
        : buildDispatch({ intent, statusPath, recipeScratchPath, contractText })
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
      // SKIPPED for project-bound spawns: no hooks there means no submit signal —
      // the verifier would read "never submitted" forever and re-inject a payload
      // that DID land, double-dispatching the session. Fail-open instead.
      if (!external) void this.verifyDispatch(id, ex, payload, dir, dispatchedAt)
      else tlog.event('dispatch-verify-skipped', { reason: 'external-cwd-no-hooks', cwd: runCwd })
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
  // ─── Codex desktop backend ────────────────────────────────────────
  //
  // A Codex task is a Task record whose work lives in someone else's app. We
  // own the record, the name, the group, the queue position — the same things
  // we own for a Claude task — but not the process. So: no status file, no
  // contract, no PTY, and `home` exists only to hold meta.json for rehydrate.

  private async dispatchCodexDesktop(
    intent: string,
    opts: { kind?: 'oneoff' | 'session'; surface?: string; spawnedBy?: string; project?: string | null; agent?: AgentKind },
  ): Promise<string> {
    const driver = this.opts.codexDriver
    if (!driver) throw new Error('CODEX_UNAVAILABLE: not-configured')
    const id = randomUUID()
    const tlog = log.child({ taskId: id })
    const dir = join(this.opts.baseDir, this.opts.userKey!, id)
    const now = this.clock()
    const surface = opts.surface ?? detectSurface(intent)
    const kind = opts.kind ?? 'oneoff'

    tlog.event('codex-dispatch-begin', { project: opts.project ?? null, kind, intentLen: intent.length })

    // REPAIR THE APPROVAL CHANNEL BEFORE DISPATCHING, not only on connect.
    //
    // Two stat calls when it is healthy, which is always. When it is not, a
    // Codex task that stops for permission is invisible to unmute — it sits at
    // "Working" while Codex shows its own dialog somewhere the user is not
    // looking, and there is no way to answer from the notch. Field-observed:
    // config.toml still trusted a hooks.json that had ceased to exist.
    //
    // Never fatal. A task at the user's existing approval level beats no task.
    await ensureApprovalHook({ runtime: process.execPath })
      .then((r) => { if (!('reason' in r) || r.reason !== 'present') log.event('codex-hook-repaired', { ...r }) })
      .catch((e) => log.warn('codex-hook-repair-failed', { error: (e as Error).message }))
    const reasoning = this.opts.codexReasoning?.() ?? {}
    const modelLabel = [reasoning.model, reasoning.effort].filter(Boolean).join(' ') || undefined
    const created = await driver.createTask(intent, {
      project: opts.project ?? null,
      permissionMode: this.opts.permissionMode?.() ?? 'ask',
      ...reasoning,
    })

    // ONE-WAY DOOR. Whatever happens from here the task stays a Codex task. It
    // may end up FAILED, but it is never handed to another agent — the user
    // chose this backend, and silently running their work somewhere else (which
    // is what happened on 2026-07-25) is worse than failing honestly.
    //
    // `id-unresolved` is called out separately because the work DID start in
    // Codex; only our handle on it is missing. Treating that as "nothing
    // happened" is what produced a duplicate run.
    if (!created.ok || !created.threadId) {
      const startedAnyway = created.reason === 'id-unresolved'
      tlog.warn('codex-dispatch-failed', { reason: created.reason, startedInCodexAnyway: startedAnyway })
      throw new Error(`CODEX_UNAVAILABLE: ${created.reason ?? 'unknown'}`)
    }
    tlog.event('codex-dispatch-created', { threadId: created.threadId })

    await fs.mkdir(dir, { recursive: true }).catch(() => {})
    const task: Task = {
      id,
      intent,
      sessionId: created.threadId,   // the Codex thread IS this task's session handle
      agent: 'codex-desktop',
      codexThreadId: created.threadId,
      codexProject: opts.project ?? null,
      ...(modelLabel ? { codexModelLabel: modelLabel } : {}),
      kind,
      state: 'processing',
      createdAt: now,
      updatedAt: now,
      cwd: dir,
      home: dir,
      // Unused by this backend; kept non-null so every consumer that reads a
      // path (purge, attachments, rehydrate) keeps working unchanged.
      statusPath: join(dir, 'status.json'),
      recipeScratchPath: join(dir, 'recipe.json'),
      lastMtimeMs: 0,
      lastHeartbeatMs: now,
      surface,
      mode: 'managed',
      ...(opts.spawnedBy ? { spawnedBy: opts.spawnedBy } : {}),
    } as Task
    this.tasks.set(id, task)

    await fs.writeFile(join(dir, 'meta.json'), JSON.stringify({
      id, intent, sessionId: created.threadId, kind, createdAt: now, surface, mode: 'managed',
      agent: 'codex-desktop', codexThreadId: created.threadId, codexProject: opts.project ?? null,
      state: 'processing', updatedAt: now,
      ...(opts.spawnedBy ? { spawnedBy: opts.spawnedBy } : {}),
    })).catch(() => {})

    this.emit('created', task)
    tlog.event('codex-task-dispatched', { threadId: created.threadId, project: opts.project ?? null })
    this.startPolling(id)
    return id
  }

  /**
   * The Codex analogue of poll(): derive state from the rollout file instead of
   * a status file the agent writes. Same cadence, same transitions, same stuck
   * backstop — only the source differs.
   */
  private async pollCodexDesktop(id: string): Promise<void> {
    const task = this.tasks.get(id)
    // NOTE: `ready` is deliberately NOT terminal for this backend — the Codex
    // thread outlives our card and the user can continue it inside Codex, so we
    // keep watching. Only done/failed stop the watch.
    if (!task || !task.codexThreadId || task.state === 'done' || task.state === 'failed') return
    const driver = this.opts.codexDriver
    if (!driver) return
    const tlog = log.child({ taskId: id })

    // A `ready` Codex task is watched only in case the user CONTINUES it inside
    // Codex — a rare, human-paced event. Polling that at the live cadence meant
    // reading the rollout off disk once a second, forever, for every finished
    // task on the wall (seen in the field on dev.34). Back off hard; a task that
    // is actually working still polls at full rate.
    if (task.state === 'ready') {
      const n = (this.codexIdleTicks.get(id) ?? 0) + 1
      this.codexIdleTicks.set(id, n)
      if (n % 10 !== 0) return
    } else {
      this.codexIdleTicks.delete(id)
    }

    const snap = await driver.snapshot(task.codexThreadId)
    if (snap.updatedAt > task.lastHeartbeatMs) task.lastHeartbeatMs = snap.updatedAt

    // Rolling "where you left off" comes free: the last agent message is exactly
    // the re-entry warm-up the cards already render for Claude sessions.
    if (snap.lastAgentMessage && snap.lastAgentMessage !== task.threadContext) {
      task.threadContext = snap.lastAgentMessage
    }
    // The conversation IS this backend's terminal — keep it current every poll.
    if (snap.turns.length) task.conversation = snap.turns

    if (snap.state === 'failed') { this.transition(id, 'failed', { state: 'failed', error: { reason: 'Codex reported an error' } } as StatusPayload); return }

    tlog.debug('codex-poll', {
      state: snap.state, turnsStarted: snap.turnsStarted, everCompleted: snap.everCompleted,
      hasHeadline: !!snap.lastAgentMessage, taskState: task.state,
    })

    // A Codex thread OUTLIVES our card: the user can keep talking to it inside
    // Codex, and a new turn there must re-open the task here rather than being
    // invisible. So `ready` is a resting state, not a terminal one — if the
    // rollout shows another turn started, come back to processing.
    if (snap.state === 'processing' && task.state === 'ready') {
      tlog.event('codex-reopened', { turnsStarted: snap.turnsStarted, note: 'continued inside Codex' })
      this.transition(id, 'processing')
      return
    }

    if (snap.state === 'ready' && snap.everCompleted) {
      // A completed Codex turn is `ready`, never `done`: the step is over but the
      // ball is with the user and the thread is always continuable
      // (ORCHESTRATE-VISION §3, three kinds of done). The existing ready decay
      // valve then settles an ignored one-off to done on its own.
      if (task.state !== 'ready') {
        // snap.updatedAt is the newest event in the rollout — i.e. when the turn
        // actually finished. Passing it is what stops a relaunch replaying
        // yesterday's completion as if it were new.
        this.transition(id, 'ready', {
          state: 'ready',
          result: { summary: snap.lastAgentMessage ?? 'Codex finished this turn.' },
        } as StatusPayload, snap.updatedAt || undefined)
      }
      return
    }

    if (snap.state === 'processing' && task.state === 'stuck') {
      tlog.event('stuck-recovered', { via: 'codex-rollout' })
      this.transition(id, 'processing')
      return
    }

    if (
      task.state !== 'stuck' &&
      isStale({ state: task.state as TaskState }, task.lastHeartbeatMs, this.clock(), this.opts.staleMs)
    ) {
      tlog.event('task-stuck', { lastHeartbeatMs: task.lastHeartbeatMs, via: 'codex' })
      this.transition(id, 'stuck')
    }
  }

  /** Follow-up / unblock for a Codex desktop task: type into its thread. */
  private followUpCodexDesktop(id: string, text: string): boolean {
    const task = this.tasks.get(id)
    const driver = this.opts.codexDriver
    if (!task?.codexThreadId || !driver) return false
    const tlog = log.child({ taskId: id })
    task.lastUserInputAt = this.clock()
    task.followUps = (task.followUps ?? 0) + 1
    if (task.kind !== 'session' && task.followUps >= 2) {
      tlog.event('graduated-to-session', { followUps: task.followUps })
      this.setKind(id, 'session')
    }
    tlog.ui('task-row.follow-up', { text })
    // Optimistic: the command was accepted. The poller will correct the state
    // from the rollout either way, so a failed send self-heals rather than
    // leaving the card lying about progress.
    this.transition(id, 'processing')
    const before = task.state
    task.sending = true
    this.emit('updated', task)
    void driver.send(task.codexThreadId, text).then((r) => {
      const inFlight = this.tasks.get(id)
      if (inFlight) inFlight.sending = false
      if (!r.ok) {
        tlog.warn('codex-followup-failed', { reason: r.reason })
        // A FAILED DELIVERY IS NOT A FAILED TASK.
        //
        // This used to mark the task `failed`, which was wrong in every way
        // that matters: the Codex thread is untouched and still perfectly
        // healthy — only OUR attempt to type into it missed. The card then
        // claimed the user's work had failed, sat in the attention queue
        // forever (nothing ages out an errored task), and could never
        // self-correct because polling stops on `failed`. One missed click and
        // a finished piece of work nagged indefinitely.
        //
        // So: put the task back where it was, and report the delivery problem
        // as what it is — a message that did not get through.
        this.transition(id, before)
        const live = this.tasks.get(id)
        if (live) {
          live.deliveryError = r.reason === 'not-armed'
            ? 'Codex is not connected to Unmute'
            : r.reason === 'thread-not-found'
              ? 'Could not find that chat in Codex'
              : `Could not send to Codex (${r.reason})`
          live.updatedAt = this.clock()
          this.emit('updated', live)
        }
      } else {
        tlog.event('codex-followup-sent', {})
        const live = this.tasks.get(id)
        if (live?.deliveryError) { delete live.deliveryError; this.emit('updated', live) }
      }
    }).catch((e) => tlog.error('codex-followup-error', { error: (e as Error).message }))
    this.startPolling(id)
    return true
  }

  /**
   * Arm the ready-decay for ONE task instead of waiting for the hourly sweep.
   *
   * purgeStale() still runs the sweep (it also reaps disk orphans), but relying
   * on it alone meant a ready one-off could sit up to an hour PAST its decay
   * window before settling — it looked stuck when it was only waiting on a
   * coarse timer. Sessions never decay: a thread's open loop is real until the
   * user closes it.
   */
  private armReadyDecay(id: string): void {
    const prev = this.readyDecayTimers.get(id)
    if (prev) clearTimeout(prev)
    const t = this.tasks.get(id)
    if (!t || (t.kind ?? 'oneoff') === 'session') return
    const timer = setTimeout(() => {
      this.readyDecayTimers.delete(id)
      const task = this.tasks.get(id)
      if (!task || task.state !== 'ready') return
      task.state = 'done'
      task.updatedAt = this.clock()
      this.emit('updated', task)
      log.child({ taskId: id }).event('ready-decayed-to-done', { via: 'timer' })
    }, this.opts.readyDecayMs)
    if (typeof timer.unref === 'function') timer.unref()
    this.readyDecayTimers.set(id, timer)
  }

  private startPolling(id: string): void {
    const tlog = log.child({ taskId: id })
    // Idempotent: a follow-up into a still-processing task calls this while a
    // poll interval already runs — overwriting the map entry without clearing
    // the old interval leaked it forever (found by the queued-follow-up test:
    // the orphaned timer kept the process alive).
    const prev = this.timers.get(id)
    if (prev) clearInterval(prev)
    const timer = setInterval(() => {
      void this.poll(id).catch((e) => tlog.error('poll error', { error: (e as Error).message }))
    }, this.opts.pollMs)
    this.timers.set(id, timer)
    tlog.event('polling-started', { pollMs: this.opts.pollMs, staleMs: this.opts.staleMs })
  }

  private async poll(id: string): Promise<void> {
    const task = this.tasks.get(id)
    // External backends have no status file — their state comes from elsewhere,
    // and (unlike a PTY task) a `ready` one is still worth watching because the
    // user can continue the thread in the other app. pollCodexDesktop owns its
    // own stop condition.
    if (task && isExternalAgent(task.agent)) return this.pollCodexDesktop(id)
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
      // SELF-HEALING STUCK (the API-retry lesson): stuck is a verdict about
      // SILENCE, and this hook event is proof the silence ended — real tool
      // execution resumed (e.g. the API retries worked out). The label must
      // heal itself; a card that says STUCK over a visibly-working terminal
      // is a lie the user has to clean up by hand. Status writes already
      // healed via transition(); this closes the other half.
      if (task.state === 'stuck') {
        tlog.event('stuck-recovered', { via: 'hook-activity' })
        this.transition(id, 'processing')
      }
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
  private transition(id: string, next: UiTaskState, payload?: Partial<StatusPayload>, at?: number): void {
    // Entering `ready` starts its decay clock immediately (see armReadyDecay);
    // leaving it cancels. Previously only the hourly sweep noticed.
    if (next === 'ready') queueMicrotask(() => this.armReadyDecay(id))
    const task = this.tasks.get(id)
    if (!task) return
    const tlog = log.child({ taskId: id })
    const prev = task.state
    task.state = next
    // WHEN IT HAPPENED, not when we noticed. Stamping the clock made every
    // relaunch look like a fresh completion: rehydrate re-derived `ready` from
    // the rollout, transition() stamped now, and the staleness guard — which
    // compares against updatedAt — saw a zero-second-old finish and announced a
    // task that had completed the previous day. `at` comes from the source of
    // truth (the rollout's own completion time) wherever we have one.
    task.updatedAt = at ?? this.clock()
    if (payload?.category) task.category = payload.category
    if (payload?.step) task.step = payload.step
    if (payload?.result) task.result = payload.result
    if (payload?.error) task.error = payload.error
    if (payload?.question) task.question = payload.question
    if (payload?.recipe_suggestion) task.recipeSuggestion = payload.recipe_suggestion
    if (payload?.thread_context) task.threadContext = String(payload.thread_context).slice(0, 600)

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
      case 'ready':
        // Ball-with-user checkpoint: a step finished, the session sits warm
        // awaiting the user's direction. Queued as "your move" (lowest pull
        // priority) in the UI; NO doorbell (calm by design), NO librarian yet
        // (the thread isn't over — curation happens at the final done).
        tlog.ui('task-row.ready', { summary: task.result?.summary })
        this.emit('updated', task)

    // Keep the on-disk record current, so a relaunch restores the history
    // instead of re-deriving it. Best-effort: a task whose meta cannot be
    // written still works for this run, it just forgets across a restart.
    if (isExternalAgent(task.agent)) void this.persistState(task)
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
    // Codex desktop: answering IS the next turn — there is no separate blocked
    // channel to write into, and no PTY liveness to check (the thread always
    // exists in the app). followUpCodexDesktop already does the send, the
    // consent clock, and the optimistic transition.
    const target = this.tasks.get(id)
    if (target && isExternalAgent(target.agent)) {
      tlog.ui('task-row.answer-submitted', { answer: userAnswer })
      // An outstanding APPROVAL is answered through the hook, not the composer:
      // typing "Approve" into the chat would leave the permission dialog still
      // waiting and add a stray message to the user's thread.
      if (this.answerCodexApproval(target, userAnswer)) return
      this.followUpCodexDesktop(id, userAnswer)
      return
    }
    const ex = this.executors.get(id)
    if (!ex || !ex.alive) {
      tlog.warn('answer dropped — no live session', {})
      return
    }
    const answered = this.tasks.get(id)
    if (answered) answered.lastUserInputAt = this.clock() // consent clock
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

  /** Merge the observed state + its timestamp into the task's meta.json. */
  private async persistState(task: Task): Promise<void> {
    const path = join(task.home, 'meta.json')
    try {
      const raw = await fs.readFile(path, 'utf8')
      const meta = JSON.parse(raw) as Record<string, unknown>
      if (meta.state === task.state && meta.updatedAt === task.updatedAt) return
      await fs.writeFile(path, JSON.stringify({ ...meta, state: task.state, updatedAt: task.updatedAt }))
    } catch { /* absent or unreadable — nothing to keep in sync */ }
  }

  /** Instant kill (PRD §10.4). Closes the session; marks failed if not terminal. */
  /** Explicit user stop (PRD §10.4). Hard-kills the session immediately. */
  kill(id: string): void {
    const tlog = log.child({ taskId: id })
    tlog.ui('task-row.killed', {})
    const task = this.tasks.get(id)
    // A stopped task must stop asking. Leaving the request on disk would keep
    // re-blocking a card the user just killed, and would hold the Codex hook
    // waiting for an answer that is never coming.
    if (task?.codexThreadId) { this.surfacedApprovals.delete(task.codexThreadId); void clearApproval(task.codexThreadId) }
    if (task && !SETTLED.includes(task.state)) {
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
    if (task?.codexThreadId) { this.surfacedApprovals.delete(task.codexThreadId); void clearApproval(task.codexThreadId) }
    this.hardKill(id) // terminate session (PTY + tmux kill-session)
    this.tasks.delete(id)
    this.outputBuffers.delete(id)
    if (task) {
      // Delete HOME (our scratch/receipt dir), NEVER cwd: for a project-bound
      // session cwd is the user's real project directory — rm'ing it would
      // destroy their repo. home === cwd for scratch oneoffs (same behavior).
      try { await fs.rm(task.home, { recursive: true, force: true }) } catch (e) {
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
      let meta: { intent?: string; sessionId?: string; name?: string; kind?: 'oneoff' | 'session'; cwd?: string; createdAt?: number; state?: string; updatedAt?: number; surface?: string; mode?: 'managed' | 'raw'; injectedRecipes?: Array<{ name: string; tier: 'nursery' | 'skill'; surface: string }>; shelved?: boolean; note?: string; spawnedBy?: string; group?: string; agent?: AgentKind; codexThreadId?: string; codexProject?: string | null }
      try { meta = JSON.parse(await fs.readFile(join(dir, 'meta.json'), 'utf8')) } catch { continue }
      if (!meta.intent) continue // pre-receipt task or junk dir — skip
      // EXTERNAL BACKEND: a Codex thread lives in Codex, so an Unmute restart
      // does not interrupt it — the work may well have finished while we were
      // gone. Rebuild the record and let the poller read the true state off the
      // rollout, instead of the 'failed / interrupted' verdict a PTY task gets.
      if (meta.agent === 'codex-desktop' && meta.codexThreadId) {
        const now0 = this.clock()
        const ctask: Task = {
          id,
          intent: meta.intent,
          name: meta.name,
          sessionId: meta.codexThreadId,
          agent: 'codex-desktop',
          codexThreadId: meta.codexThreadId,
          codexProject: meta.codexProject ?? null,
          kind: meta.kind ?? 'oneoff',
          // RESTORE what we last observed. Defaulting to 'processing' meant the
          // first poll always "discovered" completion afresh and re-stamped it,
          // so a finished thread announced itself on every single launch.
          state: (meta.state as UiTaskState | undefined) ?? 'processing',
          createdAt: meta.createdAt ?? now0,
          updatedAt: meta.updatedAt ?? meta.createdAt ?? now0,
          cwd: dir,
          home: dir,
          statusPath: join(dir, 'status.json'),
          recipeScratchPath: join(dir, 'recipe.json'),
          lastMtimeMs: 0,
          lastHeartbeatMs: now0,
          surface: meta.surface,
          mode: meta.mode ?? 'managed',
          injectedRecipes: [],
          shelved: meta.shelved || undefined,
          note: meta.note || undefined,
          spawnedBy: meta.spawnedBy || undefined,
          group: meta.group || undefined,
        } as Task
        this.tasks.set(id, ctask)
        this.emit('created', ctask)
        this.startPolling(id)
        restored++
        continue
      }
      const statusPath = join(dir, 'status.json')
      const status = await readStatus(statusPath)
      const now = this.clock()
      const terminal = status?.state === 'done' || status?.state === 'failed' || status?.state === 'ready'
      const task: Task = {
        id,
        intent: meta.intent,
        name: meta.name,
        // Pre-sessionId receipts won't carry one; fall back to the task id so the
        // field is always present (older tasks simply aren't session-pinned).
        sessionId: meta.sessionId ?? id,
        kind: meta.kind ?? 'oneoff',
        // A non-terminal task whose session died with the app is, to the user,
        // interrupted — surface it as failed (still resumable) rather than a
        // forever-spinning 'processing'.
        state: terminal ? status!.state : 'failed',
        createdAt: meta.createdAt ?? now,
        updatedAt: (await statusMtimeMs(statusPath)) ?? meta.createdAt ?? now,
        // Project-bound sessions ran in the user's real dir (meta.cwd); resume
        // must respawn THERE (`--continue` is cwd-scoped). home is always ours.
        cwd: meta.cwd ?? dir,
        home: dir,
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
        shelved: meta.shelved || undefined,
        note: meta.note || undefined,
        spawnedBy: meta.spawnedBy || undefined,
        group: meta.group || undefined,
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
    // The Codex approval channel only works while we are heartbeating: the hook
    // refuses to wait on a dead unmute, by design (see codex/hooks.ts).
    void beat()
    void this.sweepApprovals()
    // The sweep is cheap (one readdir of a near-empty dir) and wants to be
    // responsive; the heartbeat only has to stay inside the handler's 90s
    // freshness window, so it does not need the same cadence.
    let ticks = 0
    this.approvalTimer = setInterval(() => {
      if (ticks++ % 20 === 0) void beat()
      void this.sweepApprovals()
    }, this.opts.approvalSweepMs)
    ;(this.approvalTimer as { unref?: () => void }).unref?.()
    log.event('maintenance-started', { purgeAgeMs: this.opts.purgeAgeMs, purgeSweepMs: this.opts.purgeSweepMs })
  }

  /** Stop the maintenance sweep (shutdown / tests). */
  stopMaintenance(): void {
    if (this.purgeTimer) { clearInterval(this.purgeTimer); this.purgeTimer = null }
    if (this.approvalTimer) { clearInterval(this.approvalTimer); this.approvalTimer = null }
  }

  /**
   * Surface Codex approval requests as blocked tasks — ALL of them, not just
   * the thread Codex happens to be showing.
   *
   * This is what makes the crank work for this backend. A Codex task that stops
   * for permission is otherwise completely invisible here: nothing is written to
   * the rollout, and the sidebar exposes no status (both checked). The hook
   * (codex/hooks.ts) pushes each request into a directory; this reads it and
   * turns it into the same `needs-user` state a blocked Claude task reaches, so
   * the queue, the notch and next/answer all work unchanged.
   */
  private async sweepApprovals(): Promise<void> {
    let requests: Awaited<ReturnType<typeof pendingApprovals>> = []
    try { requests = await pendingApprovals() } catch { return }

    const live = new Set<string>()
    for (const req of requests) {
      live.add(req.threadId)
      const task = [...this.tasks.values()].find((t) => t.codexThreadId === req.threadId)
      if (!task) {
        // A thread the user started inside Codex, not through us. Not ours to
        // answer — leave it for Codex's own dialog rather than inventing a card.
        continue
      }
      if (this.surfacedApprovals.get(req.threadId) === req.at) continue
      this.surfacedApprovals.set(req.threadId, req.at)
      const tlog = log.child({ taskId: task.id })
      tlog.event('codex-approval-received', { threadId: req.threadId, tool: req.toolName, turnId: req.turnId })
      this.transition(task.id, 'needs-user', {
        state: 'needs-user',
        question: {
          text: `Codex wants to run: ${describeApproval(req)}`,
          choices: ['Approve', 'Deny'],
        },
      } as StatusPayload)
    }

    // A request that vanished was answered elsewhere (Codex's own dialog, or a
    // hook timeout the user resolved in-app). Let the poller take the task back.
    for (const threadId of [...this.surfacedApprovals.keys()]) {
      if (live.has(threadId)) continue
      this.surfacedApprovals.delete(threadId)
      const task = [...this.tasks.values()].find((t) => t.codexThreadId === threadId)
      if (task && task.state === 'needs-user') {
        log.child({ taskId: task.id }).event('codex-approval-resolved-elsewhere', { threadId })
        this.transition(task.id, 'processing')
      }
    }
  }

  /**
   * Answer a Codex approval from unmute. True when this WAS an approval (so the
   * caller must not also send the text as a chat message — doing both would put
   * a stray "Approve" into the user's thread).
   */
  private answerCodexApproval(task: Task, userAnswer: string): boolean {
    const threadId = task.codexThreadId
    if (!threadId || !this.surfacedApprovals.has(threadId)) return false
    const yes = /^\s*(approve|allow|yes|y|ok|okay|sure|go ahead|do it|1)\b/i.test(userAnswer)
    const no = /^\s*(deny|reject|no|n|stop|don'?t|cancel|2)\b/i.test(userAnswer)
    if (!yes && !no) return false   // a real message; let it through as a follow-up
    this.surfacedApprovals.delete(threadId)
    log.child({ taskId: task.id }).event('codex-approval-answered', { threadId, behavior: yes ? 'allow' : 'deny' })
    void decideApproval(threadId, yes ? 'allow' : 'deny')
    task.lastUserInputAt = this.clock()
    this.transition(task.id, 'processing')
    return true
  }

  /**
   * Hard-erase every task untouched for >= purgeAgeMs (ANY state — this also
   * reaps a still-alive session left behind by an abandoned needs-user/stuck
   * task, which otherwise never gets its warm-timeout). Scoped to OUR scratch dir
   * via remove(); NEVER touches ~/.claude. Public so it can be unit-tested.
   */
  async purgeStale(): Promise<void> {
    // Decay valve (ready-inflation defense): a ready ONE-OFF the user has
    // ignored for an hour was not actually awaiting their move — settle it to
    // done so it fades instead of haunting the queue all day. Ready SESSIONS
    // never decay: a thread's open loop is real until the user closes it.
    const readyCutoff = this.clock() - this.opts.readyDecayMs
    for (const t of this.tasks.values()) {
      if (t.state === 'ready' && (t.kind ?? 'oneoff') !== 'session' && t.updatedAt < readyCutoff) {
        t.state = 'done'
        t.updatedAt = this.clock()
        this.emit('updated', t)
        log.child({ taskId: t.id }).event('ready-decayed-to-done', {})
      }
    }
    const cutoff = this.clock() - this.opts.purgeAgeMs
    // 1. IN-MEMORY tasks that have aged out — remove() kills the live session too.
    //    PERSISTENT SESSIONS ARE EXEMPT: a multi-day working session is untouched
    //    "by updatedAt" for days by design — auto-purging it would delete the
    //    user's living workspace. Sessions die only by explicit kill/remove.
    //    SHELVED tasks are exempt too — shelving IS the "keep this" gesture.
    const stale = [...this.tasks.values()].filter((t) => t.updatedAt < cutoff && t.kind !== 'session' && !t.shelved)
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
      // Persistent-session receipts are NEVER orphan-purged (same exemption as
      // pass 1): if one isn't in memory (e.g. this sweep ran before rehydrate),
      // deleting it would erase a multi-day session behind the user's back.
      try {
        const meta = JSON.parse(await fs.readFile(join(dir, 'meta.json'), 'utf8')) as { kind?: string }
        if (meta.kind === 'session') continue
      } catch { /* junk/pre-receipt dir — purgeable as before */ }
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
    // Union of PTY-backed and external-backend tasks. Keying on `executors`
    // alone leaked the poll interval of every codex-desktop task (no executor
    // ⇒ never visited ⇒ setInterval outlived the manager).
    const ids = [...new Set([...this.executors.keys(), ...this.timers.keys()])]
    for (const id of ids) {
      const task = this.tasks.get(id)
      if (task && !SETTLED.includes(task.state)) {
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
  /** Fold a patch into the task's meta.json (best-effort durability). Serialized
   *  per task so concurrent merges can't clobber each other's fields. */
  private mergeMeta(task: Task, patch: Record<string, unknown>, op: string): void {
    const metaPath = join(task.home, 'meta.json')
    const prev = this.metaChains.get(task.id) ?? Promise.resolve()
    const next = prev
      .then(() => fs.readFile(metaPath, 'utf8'))
      .then((raw) => fs.writeFile(metaPath, JSON.stringify({ ...JSON.parse(raw), ...patch })))
      .catch((e) => log.child({ taskId: task.id }).warn(`${op}: meta persist failed`, { error: (e as Error).message }))
    this.metaChains.set(task.id, next)
    void next.finally(() => { if (this.metaChains.get(task.id) === next) this.metaChains.delete(task.id) })
  }

  /** For a FORKED spawn: discover the fork's real session id (Claude mints it;
   *  we can't pin it). The newest .jsonl in the cwd's project slug that isn't
   *  the fork SOURCE is the child. Best-effort; keeps the placeholder if not
   *  found (recall pointers then point at the parent's transcript — degraded,
   *  not broken). */
  async adoptForkSessionId(id: string, forkFrom: string): Promise<void> {
    const task = this.tasks.get(id)
    if (!task) return
    try {
      const { homedir } = await import('node:os')
      // A fork's id is minted by Claude (we can't pin it), so discovery here is
      // inherently "newest .jsonl in the slug that isn't the fork SOURCE" — unlike
      // the curator, which now keys on the pinned id (see transcriptPathFor). Use
      // the SAME verified slug transform as init.ts's exact-path lookup so the dir
      // resolves for cwds with underscores/spaces (the old /[/.]/g missed those).
      const slug = projectSlug(task.cwd)
      const dir = join(homedir(), '.claude', 'projects', slug)
      const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.jsonl') && !f.startsWith(forkFrom))
      const withM = await Promise.all(files.map(async (f) => {
        try { return { f, m: (await fs.stat(join(dir, f))).mtimeMs } } catch { return { f, m: -1 } }
      }))
      withM.sort((a, b) => b.m - a.m)
      const newest = withM[0]
      if (newest && newest.m > 0) {
        const sid = newest.f.replace(/\.jsonl$/, '')
        if (sid !== task.sessionId) {
          task.sessionId = sid
          this.mergeMeta(task, { sessionId: sid }, 'adoptForkSessionId')
          log.child({ taskId: id }).event('fork-session-id-adopted', { sessionId: sid })
        }
      }
    } catch { /* best-effort */ }
  }

  /** Set the session's short display name (generated async after dispatch). Emits
   *  'updated' so the UI swaps the truncated-intent fallback for the real name,
   *  and persists it into meta.json so the name survives an app restart. */
  setName(id: string, name: string): void {
    const task = this.tasks.get(id)
    const n = (name || '').trim()
    if (!task || !n || task.name === n) return
    task.name = n
    task.updatedAt = this.clock()
    this.emit('updated', task)
    // Durability (best-effort): fold the name into the receipt.
    this.mergeMeta(task, { name: n }, 'setName')
  }

  /** Change a task's species. Promotion (oneoff → session) CANCELS any armed
   *  warm-kill timer — the whole point is that the session now outlives idle
   *  windows. Demotion re-arms lifecycle on the next park. Persists to meta so
   *  the species survives restarts; emits 'updated' for the UIs. */
  setKind(id: string, kind: 'oneoff' | 'session'): void {
    const task = this.tasks.get(id)
    if (!task || task.kind === kind) return
    task.kind = kind
    task.updatedAt = this.clock()
    if (kind === 'session') {
      const wt = this.warmTimers.get(id)
      if (wt) { clearTimeout(wt); this.warmTimers.delete(id) }
    } else if (this.executors.get(id)?.alive && TERMINAL.includes(task.state)) {
      // Demoted while parked-without-timer → re-enter the normal oneoff park
      // (arms the warm window) so it can't linger forever as an unpinned oneoff.
      this.parkWarm(id)
    }
    this.emit('updated', task)
    log.child({ taskId: id }).event('kind-changed', { kind })
    this.mergeMeta(task, { kind }, 'setKind')
  }

  /** Shelve/unshelve (Orchestrate): preserved-but-out-of-the-way. Persists to
   *  meta.json so the shelf survives restarts; emits 'updated' for the wall. */
  setShelved(id: string, on: boolean): void {
    const task = this.tasks.get(id)
    if (!task || !!task.shelved === on) return
    task.shelved = on
    task.updatedAt = this.clock()
    this.emit('updated', task)
    log.child({ taskId: id }).event(on ? 'shelved' : 'unshelved', {})
    this.mergeMeta(task, { shelved: on }, 'setShelved')
  }

  /** Set/clear the user's card note (annotation only — the agent never sees it).
   *  Persists to meta.json; empty string clears. */
  setNote(id: string, note: string): void {
    const task = this.tasks.get(id)
    if (!task) return
    const n = (note || '').trim().slice(0, 500)
    if ((task.note ?? '') === n) return
    task.note = n || undefined
    task.updatedAt = this.clock()
    this.emit('updated', task)
    this.mergeMeta(task, { note: n }, 'setNote')
  }

  /** Assign/clear a task's workspace group. Groups are minted lazily by the
   *  router or by user curation — this just records the word. Empty clears.
   *  Persists to meta.json; emits 'updated' for the wall. */
  setGroup(id: string, group: string | null): void {
    const task = this.tasks.get(id)
    if (!task) return
    const g = (group || '').trim().slice(0, 32)
    if ((task.group ?? '') === g) return
    task.group = g || undefined
    task.updatedAt = this.clock()
    this.emit('updated', task)
    log.child({ taskId: id }).event('group-changed', { group: g || null })
    this.mergeMeta(task, { group: g }, 'setGroup')
  }

  /** Rename a live group: every task currently carrying `from` moves to `to`.
   *  Returns how many tasks moved (0 = the group didn't exist). */
  renameGroup(from: string, to: string): number {
    const f = (from || '').trim()
    const t = (to || '').trim().slice(0, 32)
    if (!f || !t || f === t) return 0
    let moved = 0
    for (const task of this.tasks.values()) {
      if (task.group === f) { this.setGroup(task.id, t); moved++ }
    }
    if (moved) log.event('group-renamed', { from: f, to: t, moved })
    return moved
  }

  followUp(id: string, text: string): boolean {
    const tlog = log.child({ taskId: id })
    const ex = this.executors.get(id)
    const task = this.tasks.get(id)
    // Codex desktop: "warm" has no meaning — the thread always exists in the app,
    // so a follow-up is simply a send. This is also the UNBLOCK path: answering a
    // Codex task that is `ready` is just its next turn.
    if (task && isExternalAgent(task.agent)) return this.followUpCodexDesktop(id, text)
    if (!ex?.alive || !task) {
      tlog.warn('followUp: session no longer warm — caller should dispatch new', {})
      return false
    }
    // Mid-turn? Then the write below will QUEUE until the REPL is idle. Making
    // that visible (step label + event) is what teaches the user they can speak
    // at a busy session without fear — the thought is held, never lost, and
    // never derails the running turn.
    const wasBusy = task.state === 'processing'
    task.lastUserInputAt = this.clock() // user spoke to this thread — consent clock
    // Graduation (§5): the 2nd follow-up proves this is a THREAD, not an errand —
    // promote to a persistent session (one follow-up is a common quick correction).
    task.followUps = (task.followUps ?? 0) + 1
    if (task.kind !== 'session' && task.followUps >= 2) {
      tlog.event('graduated-to-session', { followUps: task.followUps })
      this.setKind(id, 'session')
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
    if (wasBusy) {
      task.step = 'follow-up queued — delivering when the session is idle'
      this.emit('follow-up-queued', task)
      tlog.event('follow-up-queued', {})
    }
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
      if (wasBusy) {
        // Delivered — retire the queued label (the session's own status writes
        // own `step` from here).
        task.step = undefined
        this.emit('follow-up-delivered', task)
        this.emit('updated', task)
      }
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

    // A CODEX TASK IS NOT A PTY, AND RESUMING IT MUST NOT SPAWN ONE.
    //
    // Everything below builds a Claude Code session. Without this guard a
    // resume targeting a Codex task ran `claude --continue` inside that task's
    // directory — where no Claude conversation has ever existed — and the
    // process exited 0 within seconds. Observed in the field: a Codex thread
    // was created, the user switched the picker to Claude, the router chose to
    // resume that thread, and the resume silently ran the wrong backend.
    //
    // The create path has always had this guard
    // (`if (isExternalAgent(opts.agent)) return this.dispatchCodexDesktop(...)`);
    // resume never got one. A Codex thread lives in the Codex app and is never
    // dead in the sense a PTY is, so "resuming" it means nothing more than the
    // thread still being there — which the poller re-establishes on its own.
    if (task.agent === 'codex-desktop' || task.codexThreadId) {
      tlog.event('resume-codex-noop', { threadId: task.codexThreadId ?? null })
      return !!task.codexThreadId
    }

    if (this.executors.get(id)?.alive) { tlog.event('resume-noop-already-alive', {}); return true }
    try { await fs.access(task.cwd) } catch { tlog.warn('resume: task dir gone — cannot resume', {}); return false }

    // Resume by the task's PINNED session id when that exact conversation exists
    // on disk: `--resume <id>` attaches to THIS task's session even when several
    // sessions share a cwd (bare `--continue` grabs merely the most-recent one —
    // the wrong conversation for a shared repo dir). Fall back to `--continue`
    // when the id can't be confirmed (a fork whose id-adoption never landed, or a
    // pre-sessionId receipt whose sessionId defaulted to the taskId) so resume
    // still works. NEVER passes --fork-session — that would branch, not resume.
    const byId = task.sessionId ? await resolveTranscriptById(task.cwd, task.sessionId) : null
    tlog.event('resume-start', { cwd: task.cwd, resumeBy: byId ? 'session-id' : 'continue' })
    try {
      const ex = this.opts.executorFactory(!byId) // --continue only when we can't target the exact session by id
      this.executors.set(id, ex)
      this.outputBuffers.set(id, this.outputBuffers.get(id) ?? '')
      ex.onData((chunk) => {
        tlog.debug('pty-data', { chunk })
        const cur = (this.outputBuffers.get(id) ?? '') + chunk
        this.outputBuffers.set(id, cur.length > TaskManager.OUTPUT_CAP ? cur.slice(-TaskManager.OUTPUT_CAP) : cur)
        this.emit('output', { taskId: id, chunk })
      })
      await ex.spawn({ cwd: task.cwd, env: process.env, taskId: id, resumeSessionId: byId ? task.sessionId : undefined })
      await ex.isReady()
      ex.writeStdin('') // accept folder-trust; session reopens with full prior context
      await new Promise((r) => setTimeout(r, this.opts.trustAcceptMs))

      // Two scenarios, distinguished by whether the task ever completed:
      //  1. UNFINISHED (interrupted/killed mid-work, status never reached 'done')
      //     → the session is back but idle; NUDGE it to continue so it actually
      //       resumes the work, flip to processing, and re-start polling.
      //  2. FINISHED ('done') → leave it warm and silent for the user's next
      //     prompt — exactly the prior behavior (no regression to this path).
      const status = await readStatus(task.statusPath)
      // 'ready' = ball with the USER — resume warm+silent awaiting their words,
      // never nudge it to "continue" (there is nothing to continue without them).
      const unfinished = status?.state !== 'done' && status?.state !== 'ready'
      if (unfinished) {
        const nudge = buildResumeNudge(task.intent, task.statusPath)
        ex.writeStdin(nudge)
        // Same submit-reliability fix as dispatch: a follow Enter guarantees the
        // multi-line prompt submits; a spare Enter on an empty prompt is a no-op.
        await new Promise((r) => setTimeout(r, this.opts.submitConfirmMs))
        if (ex.alive) ex.write('\r')
        task.error = undefined // clear the "interrupted" reason; it's running again
        this.transition(id, 'processing', {})
        this.startPolling(id)
        tlog.event('resume-continued', { unfinished: true })
        return true
      }
      // Finished task: warm + silent, awaiting the user's next prompt (unchanged).
      task.updatedAt = this.clock()
      this.parkWarm(id)
      this.emit('updated', task)
      tlog.event('resume-ready', { unfinished: false })
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

  /** Recently FINISHED one-off tasks whose sessions are gone (dead PTY), newest
   *  first. The router's short-term memory AND resume-routing pool: a follow-up
   *  within the window can RESURRECT a 'done' task (`--continue` restores its
   *  full context — the thread literally continues on the same card); anything
   *  else is context for a self-contained NEW intent. Tightly capped — nobody
   *  follows up on an errand from an hour ago expecting the same conversation,
   *  and a stale resume is worse than a fresh task. Persistent sessions are
   *  EXCLUDED (they die only via restarts; rehydration owns that path, and the
   *  consent policy owns their routing). */
  recentlyFinished(maxAgeMs = 15 * 60_000, limit = 5): Task[] {
    const cutoff = this.clock() - maxAgeMs
    return [...this.tasks.values()]
      .filter((t) =>
        TERMINAL.includes(t.state) &&
        (t.kind ?? 'oneoff') !== 'session' &&
        this.executors.get(t.id)?.alive !== true &&
        t.updatedAt >= cutoff)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit)
  }

  /** Attach an image (or any file) to a session — the voice-era equivalent of
   *  dragging a screenshot into the terminal. Saves the bytes under the task's
   *  OWN dir (home/attachments — never the user's project), then TYPES the path
   *  into the session's input box WITHOUT submitting: the user can keep speaking
   *  and their next utterance submits together with the image as one message
   *  (exactly the drag-a-file-into-a-terminal contract). Claude Code reads the
   *  image from the path. Returns the saved path, or null if the session is gone.
   */
  async attachFile(id: string, data: Uint8Array, ext: string): Promise<string | null> {
    const tlog = log.child({ taskId: id })
    const task = this.tasks.get(id)
    const ex = this.executors.get(id)
    if (!task || !ex?.alive) {
      tlog.warn('attachFile: no live session to attach to', {})
      return null
    }
    const safeExt = (ext || 'png').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'png'
    const dir = join(task.home, 'attachments')
    await fs.mkdir(dir, { recursive: true })
    const file = join(dir, `attachment-${this.clock()}.${safeExt}`)
    await fs.writeFile(file, data)
    // Space-padded so the path never fuses with text already in the input box;
    // NO carriage return — submission belongs to the user's next utterance/keys.
    this.sendInput(id, ` ${file} `)
    tlog.event('file-attached', { file, bytes: data.byteLength })
    return file
  }

  /** Forward RAW keystrokes from the live terminal into the session's PTY
   *  (PRD §4.3 typeable terminal). No carriage return is appended — xterm sends
   *  the exact bytes (including Enter as \r) the user typed. No-op if dead. */
  sendInput(id: string, data: string): void {
    const ex = this.executors.get(id)
    if (!ex?.alive) return
    const t = this.tasks.get(id)
    if (t) t.lastUserInputAt = this.clock() // typing into the terminal = consent
    // A user typing into a parked-warm session means they want to keep working;
    // cancel the idle-kill so their hands-on session isn't reaped under them.
    const wt = this.warmTimers.get(id)
    if (wt) { clearTimeout(wt); this.warmTimers.delete(id) }
    this.trackTypedTurn(id, data)
    ex.write(data)
  }

  /** Tap-to-invoke plumbing (D14): write RAW text into a task's live PTY with NO
   *  carriage return — mirrors attachFile's unsubmitted-path contract. The caller
   *  (tap-to-invoke) sends `/${name} ` WITH a trailing space so the space dismisses
   *  the slash autocomplete popup and the user's later Enter submits directly. We
   *  MUST use write() (raw, no CR), never writeStdin() (which appends a CR and
   *  would submit prematurely). Returns false if the task is unknown or its
   *  session is gone/dead. */
  typeUnsubmitted(taskId: string, text: string): boolean {
    const ex = this.executors.get(taskId)
    if (!this.tasks.has(taskId) || !ex?.alive) {
      log.child({ taskId }).warn('typeUnsubmitted: no live session', {})
      return false
    }
    ex.write(text)
    log.child({ taskId }).event('type-unsubmitted', { chars: text.length })
    return true
  }

  /** Typed-turn detection: a MANUAL prompt submitted into a finished session's
   *  terminal is a real new turn — the card must leave 'done' and the status
   *  polling must wake back up (it stopped at parkWarm, so even the agent's own
   *  status writes were going unread — the stale-DONE bug). Deliberately fussy
   *  about what counts as a prompt: escape sequences (arrows etc.) are stripped,
   *  control chars don't count, bare Enters don't count, and `/commands`
   *  (TUI actions like /clear) don't count — only ≥3 printable chars submitted
   *  with Enter re-arm the lifecycle. Non-terminal tasks are untouched (their
   *  polling is already live). */
  private typedBuffers = new Map<string, string>()
  private trackTypedTurn(id: string, data: string): void {
    const task = this.tasks.get(id)
    if (!task) return
    let buf = this.typedBuffers.get(id) ?? ''
    for (const chunk of data.split(/(\r)/)) {
      if (chunk === '\r') {
        const line = buf.replace(/\x1b\[[0-9;?]*[A-Za-z~]/g, '').replace(/[^\x20-\x7E]/g, '').trim()
        buf = ''
        if (line.length >= 3 && !line.startsWith('/') && TERMINAL.includes(task.state)) {
          const tlog = log.child({ taskId: id })
          tlog.event('typed-turn-detected', { chars: line.length })
          task.error = undefined // a fresh manual turn clears the stale failure reason
          this.transition(id, 'processing', {})
          this.startPolling(id) // safe: terminal tasks have no live poller
        }
      } else {
        for (const ch of chunk) {
          if (ch === '\x7f' || ch === '\b') buf = buf.slice(0, -1) // backspace erases for real
          else buf += ch
        }
        buf = buf.slice(-2000) // bounded — we only need "was it non-trivial"
      }
    }
    this.typedBuffers.set(id, buf)
  }

  /** Resize a session's PTY to match the on-screen terminal (SIGWINCH → the TUI
   *  repaints itself at the new width; xterm reflows its own buffer). */
  resize(id: string, cols: number, rows: number): void {
    this.executors.get(id)?.resize(cols, rows)
  }

  /** Is the task's PTY still alive (running or parked-warm)? */
  isAlive(id: string): boolean {
    return this.executors.get(id)?.alive === true
  }

  private stopPolling(id: string): void {
    const timer = this.timers.get(id)
    if (timer) { clearInterval(timer); this.timers.delete(id) }
    const decay = this.readyDecayTimers.get(id)
    if (decay) { clearTimeout(decay); this.readyDecayTimers.delete(id) }
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
    // EXTERNAL BACKEND: there is no PTY to keep warm and no idle-kill to arm —
    // the thread lives in the other app. Crucially we must NOT stop polling: the
    // user can continue that thread inside Codex and the task has to re-open
    // here rather than going quiet forever.
    const parked = this.tasks.get(id)
    if (parked && isExternalAgent(parked.agent)) {
      log.child({ taskId: id }).event('parked-external', { backend: parked.agent, note: 'still watching the thread' })
      return
    }
    this.stopPolling(id)
    const ex = this.executors.get(id)
    const tlog = log.child({ taskId: id })
    // Persistent sessions park warm with NO idle timer: a working session must
    // never be reaped under the user between interactions — hours can pass
    // between "done" and the next spoken follow-up. Lives until explicit kill.
    if (this.tasks.get(id)?.kind === 'session') {
      if (!ex?.alive) { this.hardKill(id); return }
      tlog.event('parked-warm', { warmMs: null, persistent: true })
      return
    }
    const warmMs = this.warmMsFor(id)
    if (!ex?.alive || warmMs <= 0) { this.hardKill(id); return }
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
    this.typedBuffers.delete(id)
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
