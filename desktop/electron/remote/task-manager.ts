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
  writeStatusFile,
  readStatus,
  statusMtimeMs,
  isStale,
  type StatusPayload,
  type TaskState,
} from './status-file'
import { buildDispatch, buildResumeNudge } from './dispatch-prompt'
import { detectSurface } from './surface'
import { deriveStatus, type HookEvent } from './observer'
import { readTranscript, hadSideEffects, readLatestExchange } from './transcript'
import { browserFor } from './session-policy'
import { detectMcpGap, type McpGap } from './mcp-gap'
import { resolveTranscriptById } from './trace-reducer'
import { projectSlug } from './projects'
import type { Librarian } from './librarian'
import type { AgentExecutor, ExecutorFactory } from './executor'
import { settleRepl } from './repl-settle'
import { type AgentKind, isExternalAgent } from './codex-executor'
import type { CodexDesktopDriver } from './codex/driver'
import type { ClaudeDesktopDriver } from './claude-desktop/driver'
import type { ClaudeDesktopAx, ClaudeSidebarRow } from './claude-desktop/ax'
import { statusForTitle, readState as readAxState, readSidebarRows as readAxSidebar } from './claude-desktop/ax'
import { readCatalog, labelFor, type ClaudeModel } from './claude-desktop/catalog'
import type { ClaudeActuator } from './claude-desktop/actuate'
import type { ClaudeConsent as ClaudeConsentLite } from './claude-desktop/ax'
import { beat, pendingApprovals, expireStaleApprovals, decideApproval, clearApproval, describeApproval, ensureApprovalHook } from './codex/hooks'
import { devEvent } from './curator-devlog'

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
  /** WHICH MODEL that backend ran this task on — recorded ONCE, at creation,
   *  and never derived again (launch decision D6: the model is a historical
   *  fact). Persisted in meta.json beside `agent`, so rehydrate() replays it
   *  verbatim after a restart.
   *
   *  Deliberately NOT re-read from settings when a card is drawn. The picker
   *  moves; a task dispatched yesterday on Sonnet would then claim Opus, and
   *  the card would look exactly as correct as a right one. Same reasoning as
   *  `agent` — which is tagged at birth for exactly this reason — one level
   *  down.
   *
   *  Carries whatever the backend itself calls it: the `--model` value for
   *  Claude Code ('sonnet'), the app's own label for Claude Desktop ('Opus 5')
   *  and for Codex ('5.6 Sol High'). Absent when it could not be determined —
   *  a task created before this field existed, a Codex thread whose app never
   *  reported one, a Claude Desktop conversation whose store names none. An
   *  absent field is the honest answer: no default, no placeholder string, and
   *  no backfill, because there is no way to know what an old task ran on. */
  model?: string
  /** For 'codex-desktop': the Codex thread this task drives (durable id, no
   *  `local:` prefix). This is the whole handle — it addresses the rollout file
   *  for reads and the sidebar row for open/send. */
  codexThreadId?: string
  /** The id Codex's SIDEBAR uses for this thread, when it differs from the
   *  durable one. A not-yet-persisted thread is labelled
   *  `local:client-new-thread:<unrelated-uuid>` and nothing on the row joins the
   *  two, so it is captured at creation — the one moment the correlation is
   *  unambiguous — and used to find the thread's status chip during its first
   *  turn, which is exactly when Computer Use consents fire. */
  codexDomThreadId?: string
  /** For 'claude-code-desktop': the Claude Desktop task this card mirrors.
   *
   *  This is `sessionId` from the app's own store — measured unique across the
   *  whole store, unlike `cliSessionId`, which COLLIDES (one id shared by two
   *  different tasks) and is only ever a lookup handle for the transcript.
   *  Keying a card on cliSessionId renders one task's conversation under
   *  another task's title. */
  claudeDesktopSessionId?: string
  /** Claude Desktop's OWN status word for this task, read from its sidebar and
   *  shown verbatim. Deliberately not mapped onto our states: only 'Idle' has
   *  ever been observed, and inventing meaning for an unseen value is how a
   *  blocked task ends up looking fine. */
  claudeStatusChip?: string
  /** The permission prompt this task is stopped on, as the window is showing
   *  it. Present only while blocked — the card renders the question and the
   *  option labels, and answering sends the label back verbatim so the choice
   *  cannot drift onto a different button between showing and acting. */
  claudeConsent?: { question: string; options: string[] }
  /** Last delivery problem — the message did not reach the agent. Distinct from
   *  `error`, which means the WORK failed; this one never settles the task. */
  deliveryError?: string
  /** True while a message is travelling to the agent. Sending is a round-trip
   *  through another app's window; silence for a second reads as nothing
   *  having happened. */
  sending?: boolean
  /** True while this task is being brought back. Resume is SECONDS long — spawn,
   *  isReady, a 2s trust-accept, the status read, the nudge, a 450ms submit — and
   *  the state used to change only at the very end. Nothing moved in between, so
   *  a working Resume looked exactly like a dead button and users pressed it
   *  again (the race the private `resuming` set guards). Same purpose as
   *  `sending`, for the same reason. */
  resuming?: boolean
  /** Why the last resume did not happen. Distinct from `error` (the WORK failed)
   *  and `deliveryError` (a message did not land): the session could not be
   *  brought back at all. Every resume failure used to be logged and swallowed,
   *  so the button simply did nothing — which is what made the backend crossing
   *  on 2026-07-28 take an hour to identify. Cleared by the next attempt. */
  resumeError?: string
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
  /** The task's conversation, for EVERY backend.
   *
   *  It began as "what a driven backend has instead of a terminal", because a
   *  Codex thread has no PTY to show. That framing made the stage an either/or:
   *  a Claude task showed a terminal and no messages at all, so the one thing a
   *  returning user actually wants — what did I ask, what came back — was
   *  reachable only by reading a scrollback.
   *
   *  A Claude session's turns now come from Claude's OWN record
   *  (transcript.ts), not from scraping the screen, so all three backends fill
   *  the same field and the stage can show the message AND the terminal.
   *
   *  Widened from `{role: 'user'|'assistant'}` to the shape the drivers actually
   *  emit. That narrow type predated the Codex backend and never matched it:
   *  pollCodexDesktop has been assigning CodexTurn[] here, which is one of the
   *  standing typecheck errors. Both drivers already produce this superset
   *  (ClaudeTurn is CodexTurn minus 'work'), so naming it honestly costs
   *  nothing and stops the next backend inheriting the same lie. */
  conversation?: Array<{
    role: 'user' | 'assistant' | 'commentary' | 'tool' | 'work'
    text: string
    /** tool: the step's own label. */
    title?: string
    /** tool: the code/command/input it ran. */
    code?: string
    /** tool: what came back (truncated). */
    output?: string
    /** tool: wall time, when the backend reports one. */
    durationMs?: number
    /** tool: false when the step errored. */
    ok?: boolean
  }>
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
  /** When the session last told us a prompt actually SUBMITTED (UserPromptSubmit
   *  hook). The signal verifyDispatch waits for — a real event now, not a marker
   *  file's mtime, so it works in project-bound sessions too. */
  promptSubmittedAt?: number
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
  /** Backend for `agent: 'claude-code-desktop'` tasks. Read-only today: it
   *  serves cards from Claude Desktop's own files, so it works with the app
   *  closed and can be polled freely. Absent ⇒ those tasks simply do not
   *  update, rather than being polled by another backend's poller. */
  claudeDesktopDriver?: ClaudeDesktopDriver
  /** Live UI reader for Claude desktop. Absent ⇒ cards still work from disk,
   *  they just cannot report a pending permission prompt — which is invisible
   *  on disk by design. Optional so the whole backend degrades rather than
   *  breaks when the accessibility tree is unavailable. */
  claudeDesktopAx?: ClaudeDesktopAx
  /** Focus-stealing actions for Claude desktop. Absent ⇒ prompts are visible
   *  but unanswerable from here, which is still better than not seeing them. */
  claudeActuator?: ClaudeActuator
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
  /** Frozen mid-tool-call Codex turn ⇒ SUSPECTED after this long (then the
   *  sidebar confirms or the suspicion stays silent). */
  codexBlockedMs?: number
  /** Lifetime of one shared sidebar-chip snapshot. */
  codexChipTtlMs?: number
  /** Frozen-but-unconfirmed ⇒ surface it hedged after this long. */
  codexUnconfirmedMs?: number
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
  // Claude Desktop adoption sweep (null until startMaintenance()).
  private claudeAdoptTimer: ReturnType<typeof setInterval> | null = null
  /** threadId → the request we have already surfaced, so we transition once. */
  private surfacedApprovals = new Map<string, number>()
  /** Poll decimation for settled Codex tasks (see pollCodexDesktop). */
  private codexIdleTicks = new Map<string, number>()
  /** taskId → newest rollout timestamp we have already seen, so a poll can tell
   *  "the file grew" from "the file is merely non-empty". */
  private codexLastSeenAt = new Map<string, number>()
  /** threadIds whose pending approval matched no live task — logged once each,
   *  so a genuinely dropped request is visible without spamming every sweep. */
  private unmatchedApprovals = new Set<string>()
  /** taskId → rollout watcher disposer. Best-effort: absent when the transcript
   *  did not exist yet or fs.watch could not start; polling still covers it. */
  private codexWatchers = new Map<string, () => void>()
  /** Same three, for Claude desktop. Kept separate rather than shared: the two
   *  backends key on different ids (Codex thread vs Claude sessionId) and a
   *  single map would silently collide the day the id spaces overlap. */
  private claudeIdleTicks = new Map<string, number>()
  private claudeLastSeenAt = new Map<string, number>()
  private claudeWatchers = new Map<string, () => void>()
  /**
   * Claude Desktop conversations the user has DISMISSED from the wall.
   *
   * Adoption re-adds any conversation not currently in `tasks`, and removing a
   * card takes it out of `tasks` — so without this the next 30s sweep brings it
   * straight back. Observed live: removed at 21:28:49, re-adopted at 21:29:07,
   * removed again at 21:29:43, back at 21:30:07. A card the user cannot get rid
   * of is worse than one that never appeared.
   *
   * Persisted, because the conversation still exists in Claude Desktop: an
   * in-memory set would resurrect everything on the next app start.
   */
  private claudeDismissed = new Set<string>()
  /** ONE accessibility read serves every Claude desktop card on a tick. The
   *  tree is ~470 nodes and the sidebar answers all tasks at once, so per-task
   *  reads would be N walks for one identical answer — the same waste the
   *  Codex chip cache exists to avoid. */
  private claudeAxCache: { at: number; rows: ClaudeSidebarRow[]; consent: ClaudeConsentLite | null; treeAlive: boolean } | null = null
  private claudeAxInflight: Promise<void> | null = null
  /** One sidebar read serves EVERY task on a tick. Ten blocked tasks polling
   *  independently would be ten CDP round-trips for one identical answer. */
  private codexChipCache: { at: number; rows: Array<{ id: string; title?: string; active: boolean; chip: string | null }> } | null = null
  private codexChipInflight: Promise<void> | null = null
  /** Resumes currently in flight (see resume) — a session is not `alive` until
   *  its PTY spawns, so this is what keeps a second call from building a second
   *  session in that window. */
  private resuming = new Set<string>()
  // Per-task chain serializing meta.json read-modify-writes. Two concurrent
  // merges (e.g. setShelved + setNote in one tick) would otherwise race the
  // read and the last write would silently drop the other's field.
  private metaChains = new Map<string, Promise<void>>()
  // Per-task ring buffer of recent PTY output for render-on-demand (PRD §13.4#8).
  private outputBuffers = new Map<string, string>()
  private static readonly OUTPUT_CAP = 200_000 // chars kept per task
  private readonly opts:
    Required<Omit<TaskManagerOpts, 'userKey' | 'now' | 'librarian' | 'reapSession' | 'codexDriver' | 'claudeDesktopDriver' | 'claudeDesktopAx' | 'claudeActuator' | 'permissionMode' | 'codexReasoning'>> &
    Pick<TaskManagerOpts, 'userKey' | 'now' | 'librarian' | 'reapSession' | 'codexDriver' | 'claudeDesktopDriver' | 'claudeDesktopAx' | 'claudeActuator' | 'permissionMode' | 'codexReasoning'>

  constructor(opts: TaskManagerOpts) {
    super()
    this.opts = {
      executorFactory: opts.executorFactory,
      baseDir: opts.baseDir ?? join(homedir(), '.unmute', 'remote'),
      pollMs: opts.pollMs ?? 1000,
      staleMs: opts.staleMs ?? 4 * 60_000,
      // How long a frozen, mid-tool-call Codex turn must sit before we call it
      // blocked-on-the-user. Shorter than staleMs on purpose: a consent dialog
      // should surface fast, while `stuck` stays the slow "something is wrong"
      // backstop. Long enough that an ordinary slow build is not mislabelled.
      // A frozen mid-tool-call turn is only SUSPECTED, and suspicion is silent,
      // so this can be short: it merely decides when to spend one cheap sidebar
      // read. Being wrong costs a DOM query nobody sees. (It was 45s when the
      // dwell was itself the verdict; the sidebar took that job.)
      codexBlockedMs: opts.codexBlockedMs ?? 5_000,
      /** How long one sidebar snapshot serves every task. */
      codexChipTtlMs: opts.codexChipTtlMs ?? 1_500,
      // Fallback window: how long a frozen tool call may go UNCONFIRMED before
      // we surface it anyway, hedged. Long enough that ordinary slow steps
      // finish inside it, short enough that a broken sidebar cannot hide a real
      // block for the rest of the day.
      codexUnconfirmedMs: opts.codexUnconfirmedMs ?? 3 * 60_000,
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
      claudeDesktopDriver: opts.claudeDesktopDriver,
      claudeDesktopAx: opts.claudeDesktopAx,
      claudeActuator: opts.claudeActuator,
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
  async dispatch(intent: string, opts: { surface?: string; mode?: 'managed' | 'raw'; kind?: 'oneoff' | 'session'; cwd?: string; spawnedBy?: string; extraEnv?: Record<string, string>; forkFromSessionId?: string; agent?: AgentKind; project?: string | null; model?: string } = {}): Promise<string> {
    // EXTERNAL BACKEND FORK (codex-desktop). Everything below this point — the
    // status file, the CLAUDE.md contract, the owned PTY, the trust prompt, the
    // dispatch payload — presumes Unmute spawns and owns the process. Codex
    // desktop is an app we drive, so it takes a different path entirely rather
    // than threading conditionals through 200 lines of PTY setup.
    // Claude desktop is a different app again: there is no thread to create via
    // an API, only a window to drive. Routing it here rather than letting
    // isExternalAgent send it to dispatchCodexDesktop, which would try to talk
    // to Codex over CDP about a conversation that does not exist there.
    if (opts.agent === 'claude-code-desktop') {
      const res = await this.createClaudeDesktop(intent)
      if (!res.ok) throw new Error(`CLAUDE_DESKTOP_UNAVAILABLE: ${res.reason ?? 'unknown'}`)
      if (res.id) return res.id
      // Created, but the store had not written it yet. The work HAS started —
      // saying otherwise is what produced a duplicate run on the Codex side —
      // so surface the same typed reason instead of a false failure.
      throw new Error('CLAUDE_DESKTOP_ID_UNRESOLVED')
    }
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

    // TAG THE BACKEND AT BIRTH. Anything reaching here is a PTY task — dispatch
    // branched to the Codex driver above — so the only options are the CLI
    // adapters, and an absent opts.agent means Claude. Recording it is what lets
    // resume() rebuild on the SAME backend later instead of asking the global
    // picker, and what lets the card name its provider without guessing.
    const agent: AgentKind = opts.agent ?? 'claude'
    // ...AND THE MODEL, on the same terms and for the same reason. The caller
    // resolved it from the value it is about to launch the executor with (the
    // `--model` argument), so this is what actually ran — not what the picker
    // says later. Spread conditionally: an unresolvable model must leave the
    // field ABSENT, never present-and-empty (D6, §3).
    const task: Task = {
      id, intent, sessionId, kind, state: 'processing', createdAt: now, updatedAt: now,
      cwd: runCwd, home: dir, statusPath, recipeScratchPath, lastMtimeMs: now, lastHeartbeatMs: now,
      surface, mode, injectedRecipes: [], lastUserInputAt: now,
      spawnedBy: opts.spawnedBy, agent,
      ...(opts.model ? { model: opts.model } : {}),
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

      // NOTHING IS WRITTEN INTO THE SESSION'S WORKING DIRECTORY. This is the
      // load-bearing change of 2026-08-06 (session-policy.ts). We used to drop a
      // CLAUDE.md, a .claude/settings.json, a hook script, marker files, copied
      // skills and a PROFILE.md into the cwd — and because doing that to a
      // user's own repo was unacceptable, project-bound sessions silently got
      // NO hooks at all, which is exactly backwards: the longest-lived sessions
      // were the least instrumented.
      //
      // Hooks now ride on `--settings <our file>` and framing on
      // `--append-system-prompt`, so every session — scratch or project-bound —
      // is instrumented identically and the user's directory is untouched.
      //
      // The memory injections (nursery leads, stale-skill caveats, the skills
      // copy, PROFILE.md) are gone with them. The librarian that authored and
      // validated them has been parked since 2026-08-03, so they were unvetted
      // hints from a system with no maintainer; the overview already called
      // them "noise that pollutes instruction packets". `injectedRecipes` stays
      // on the Task as an empty list so persisted meta.json keeps its shape.
      // Persist a tiny receipt so the task survives an app crash/restart. The
      // intent (what the user asked) lives only in memory + here — status.json
      // holds the result, never the original ask. rehydrate() reads it on launch.
      // Written AFTER injectedRecipes is computed so the persisted value is correct.
      await fs.writeFile(join(dir, 'meta.json'), JSON.stringify({ id, intent, sessionId, kind, agent, createdAt: now, surface, mode, injectedRecipes: task.injectedRecipes, ...(external ? { cwd: runCwd } : {}), ...(opts.spawnedBy ? { spawnedBy: opts.spawnedBy } : {}), ...(task.model ? { model: task.model } : {}) }))
      devEvent(tlog, 'dispatch-memory', { surface, mode, injectedRecipes: task.injectedRecipes })

      // Named, not left to the picker — see the task literal above. `browser`
      // is decided per task now: a session working in the user's repo does not
      // get browser control it will never use (session-policy.ts).
      const ex = this.opts.executorFactory(undefined, agent, { browser: browserFor({ surface, projectBound: external }) })
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

      // The payload is the user's words. Nothing else — no status path, no
      // recipe path, no contract, no "act now". See dispatch-prompt.ts.
      const payload = buildDispatch({ intent })
      const dispatchedAt = Date.now()
      ex.writeStdin(payload)
      tlog.event('task-dispatched', { bytes: payload.length })
      // Show what was asked IMMEDIATELY, before any reply exists. The transcript
      // is the source of truth and replaces this the moment the turn ends — but
      // a card that is blank for the first thirty seconds of every task reads as
      // broken, and the user already knows what they said.
      task.conversation = [{ role: 'user', text: intent }]

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
      // Verify the prompt ACTUALLY submitted, and self-heal if not. A payload
      // can be swallowed if it lands while the REPL is still painting — Claude's
      // TUI mis-reads embedded newlines and tips into reverse-search, so the
      // task sits at 0s forever with an empty prompt.
      //
      // The signal is the UserPromptSubmit hook, which now REACHES US DIRECTLY
      // (session-policy.ts) instead of touching a marker file we then stat. That
      // is why this no longer skips project-bound spawns: they get the same
      // hooks as any other session, so the verifier finally protects the
      // long-lived sessions it used to be disabled for.
      void this.verifyDispatch(id, ex, payload, dispatchedAt)
    } catch (e) {
      tlog.error('dispatch failed before polling', { error: (e as Error).message })
      this.transition(id, 'failed', { error: { reason: 'Could not start the task', detail: (e as Error).message } })
    }
    return id
  }

  /** Verify the dispatched prompt actually SUBMITTED; self-heal if it didn't.
   *  Signal: the UserPromptSubmit hook, pushed straight to us (session-policy.ts)
   *  and recorded as `promptSubmittedAt`. Nothing to stat, no marker file, and —
   *  unlike the old marker-mtime version — it works in EVERY session, including
   *  project-bound ones where this used to be switched off entirely.
   *  We clear the input line with Ctrl-U (NEVER Esc — Esc = "No, exit" on a
   *  dialog and QUITS Claude), then re-inject. Bounded retries; only ever fires
   *  on a genuinely-unsubmitted prompt, so it can't double-dispatch a live one. */
  private async verifyDispatch(
    id: string,
    ex: AgentExecutor,
    payload: string,
    dispatchedAt: number,
  ): Promise<void> {
    const tlog = log.child({ taskId: id })
    for (let attempt = 1; attempt <= this.opts.maxReinjects; attempt++) {
      await new Promise((r) => setTimeout(r, this.opts.verifyAfterMs))
      const task = this.tasks.get(id)
      // Stop if the task is gone, the PTY died, or it already finished.
      if (!task || !ex.alive || task.state === 'done' || task.state === 'failed') return
      // A UserPromptSubmit at/after our dispatch = the prompt submitted → done.
      // (1s slack absorbs clock granularity between processes.)
      if ((task.promptSubmittedAt ?? 0) >= dispatchedAt - 1000) return
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

  // ─── The observer: what a session emits becomes what Unmute knows ─────────
  //
  // Everything the operating contract used to demand in prose now arrives here
  // as a lifecycle hook and is turned into a status by observer.ts. The session
  // is never asked for any of it.

  /** Find the task a hook event belongs to. `session_id` is authoritative —
   *  we pin it with `--session-id`, so we own the mapping. `cwd` is the fallback
   *  for forked sessions, whose id Claude mints itself. */
  private taskForSession(sessionId: string, cwd?: string): Task | undefined {
    // ONLY A CLAUDE CODE CLI TASK CAN BE THE SUBJECT OF A HOOK.
    //
    // Hooks exist because we launch that session with `--settings`. A driven
    // backend — Codex desktop, Claude desktop — is never launched by us at all,
    // so it can never be the origin of one of these events. Without this filter
    // the matching is by identity alone, and both fallbacks are reachable:
    // a Codex task stores the Codex THREAD id in `sessionId`, and a Claude
    // desktop task carries a real project `cwd` — so a CLI session firing hooks
    // from the same repo could select the desktop card instead and we would
    // write a derived status onto a task whose agent we never spoke to.
    //
    // The dispatch side is already guarded by construction (dispatch() forks to
    // the drivers before any of this code runs). This is the same guarantee on
    // the way IN, and it belongs here rather than at each call site.
    const mine = (t: Task) => !isExternalAgent(t.agent)
    for (const t of this.tasks.values()) if (mine(t) && t.sessionId === sessionId) return t
    if (!cwd) return undefined
    // Newest match wins: several tasks can share a project cwd.
    let best: Task | undefined
    for (const t of this.tasks.values()) {
      if (!mine(t) || t.cwd !== cwd || TERMINAL.includes(t.state)) continue
      if (!best || t.createdAt > best.createdAt) best = t
    }
    return best
  }

  /**
   * Apply one lifecycle hook event. Never throws — a hook is telemetry, and a
   * bad one must not disturb the task it describes.
   */
  onHookEvent(event: HookEvent): void {
    const task = this.taskForSession(event.sessionId, event.cwd)
    if (!task) return
    const tlog = log.child({ taskId: task.id })
    const at = this.clock()

    // Liveness first, for EVERY event. A hook firing is proof the session is
    // alive, which also HEALS a false `stuck`: stuck is a verdict about silence,
    // and this is the silence ending. Advances lastHeartbeatMs only — never
    // lastMtimeMs, which is the status read cursor (see poll()).
    task.lastHeartbeatMs = at
    if (task.state === 'stuck') {
      tlog.event('stuck-recovered', { via: 'hook' })
      this.transition(task.id, 'processing')
    }
    if (event.kind === 'prompt-submitted') task.promptSubmittedAt = at
    if (event.kind === 'tool-used') return // liveness only

    void this.applyObservation(task, event).catch((e) =>
      tlog.warn('observation failed', { error: (e as Error).message }))
  }

  /** Derive a status from an event and record it — in memory AND on disk, so
   *  every existing reader (wall, notch, rehydrate, history) is unchanged. */
  private async applyObservation(task: Task, event: HookEvent): Promise<void> {
    const tlog = log.child({ taskId: task.id })
    // `act` vs `info` is the one derivation needing more than the last message:
    // did this session actually change anything? Read from its own transcript,
    // and only when a turn ended (the sole event where category is decided).
    let sideEffects = false
    if (event.kind === 'turn-ended') {
      const path = task.sessionId ? await resolveTranscriptById(task.cwd, task.sessionId) : null
      sideEffects = hadSideEffects(await readTranscript(path))

      // THE REPLY COMES FROM THE EVENT, NOT THE TRANSCRIPT.
      //
      // This read the exchange back out of the JSONL, and it was wrong in a way
      // that only showed up in the field: `Stop` fires AS the turn ends, before
      // Claude Code has flushed the final assistant message to that file. So the
      // read came back with no reply, a length guard skipped the update, and the
      // card kept only the optimistic user turn — a finished task showing your
      // question and nothing else. Meanwhile the status was complete, because it
      // used the payload. Two fields, one event, one of them going to a file that
      // had not been written yet.
      //
      // `event.lastMessage` IS the finished reply, in hand, already stripped of
      // thinking and tool traffic by Claude Code itself. The transcript is still
      // worth reading for the USER turn (it is the real record of what was sent),
      // but it can never be required for the assistant turn.
      const fromFile = await readLatestExchange(path)
      const ask = fromFile.find((t) => t.role === 'user')
        ?? (task.conversation ?? []).find((t) => t.role === 'user')
      const reply = event.lastMessage.trim()
      const turns: NonNullable<Task['conversation']> = []
      if (ask?.text) turns.push({ role: 'user', text: ask.text })
      if (reply) turns.push({ role: 'assistant', text: reply })
      if (turns.length) {
        task.conversation = turns
        tlog.event('conversation-refreshed', { turns: turns.length, replyBytes: reply.length, askFrom: fromFile.length ? 'transcript' : 'dispatch' })
        void this.persistState(task)
      }
    }
    const payload = deriveStatus(event, {
      kind: (task.kind ?? 'oneoff') as 'oneoff' | 'session',
      surface: task.surface,
      sideEffects,
      prior: task.state as TaskState,
      now: new Date().toISOString(),
    })
    if (!payload) return
    tlog.event('observed', { event: event.kind, state: payload.state, category: payload.category ?? null })
    // Write the file first so anything reading from disk agrees with the card,
    // then advance the read cursor so poll() doesn't re-apply what we just did.
    if (await writeStatusFile(task.statusPath, payload)) {
      task.lastMtimeMs = (await statusMtimeMs(task.statusPath)) ?? task.lastMtimeMs
    }
    this.transition(task.id, payload.state, payload)
  }

  /** The OPTIONAL self-report (`unmute_status`). Same path as an observation —
   *  a session that chooses to be precise simply overwrites what we inferred. */
  async setReportedStatus(taskId: string, payload: StatusPayload): Promise<void> {
    const task = this.tasks.get(taskId)
    if (!task) throw new Error('unknown task')
    task.lastHeartbeatMs = this.clock()
    if (await writeStatusFile(task.statusPath, payload)) {
      task.lastMtimeMs = (await statusMtimeMs(task.statusPath)) ?? task.lastMtimeMs
    }
    log.child({ taskId }).event('self-reported', { state: payload.state })
    this.transition(taskId, payload.state, payload)
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
    opts: { kind?: 'oneoff' | 'session'; surface?: string; spawnedBy?: string; project?: string | null; agent?: AgentKind; model?: string },
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
    // WHAT THIS THREAD RUNS ON, as a fact about this dispatch (D6).
    //
    // `opts.model` is what the caller resolved from CODEX'S OWN axes — its
    // reasoning button and its app-server model catalogue — which is the only
    // thing that can answer when the user has made no explicit pick and the
    // thread simply inherits whatever Codex is set to.
    //
    // `modelLabel` is the pick we are about to APPLY to the thread ourselves,
    // and stands in when the manager is driven directly (no resolver wired).
    // Both describe this thread at creation; neither is ever consulted again.
    const model = opts.model ?? modelLabel
    const created = await driver.createTask(intent, {
      project: opts.project ?? null,
      permissionMode: this.opts.permissionMode?.() ?? 'ask',
      // Threads already spoken for. The durable id is recovered by scanning the
      // sessions directory, and a RUNNING thread's file keeps looking new, so
      // without this a second dispatch could be handed the first task's thread
      // — two cards on one Codex conversation (observed 2026-07-30).
      knownThreadIds: new Set(
        [...this.tasks.values()].map((t) => t.codexThreadId).filter((x): x is string => !!x),
      ),
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
      codexDomThreadId: created.domThreadId,
      codexProject: opts.project ?? null,
      ...(modelLabel ? { codexModelLabel: modelLabel } : {}),
      ...(model ? { model } : {}),
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
      agent: 'codex-desktop', codexThreadId: created.threadId,
      codexDomThreadId: created.domThreadId, codexProject: opts.project ?? null,
      state: 'processing', updatedAt: now,
      ...(opts.spawnedBy ? { spawnedBy: opts.spawnedBy } : {}),
      ...(model ? { model } : {}),
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
  /**
   * Bring Claude Desktop's own tasks onto the wall as cards.
   *
   * This is the one structural difference from every other backend. Claude
   * (CLI) and Codex tasks exist because Unmute created them. A Claude Desktop
   * conversation exists because the USER started it in another app, and its
   * whole value is being able to see and answer it from here — so this backend
   * ADOPTS rather than dispatches.
   *
   * The policy is deliberately narrow, because the store is not small (33 tasks
   * on a real machine, most of them long dead) and the wall is a working
   * surface, not an archive:
   *
   *   - archived tasks are skipped: the user already filed them away
   *   - anything last active more than `windowMs` ago is skipped
   *   - at most `cap` are adopted per sweep, newest first
   *
   * Idempotent: a task already on the wall is left exactly as it is, so a sweep
   * can run on a timer without ever disturbing a card the user is looking at.
   * Adoption is also one-way here — a card is never auto-removed when it ages
   * out of the window, because removing something the user can see is a much
   * worse failure than showing one card too many.
   */
  /** Where dismissals live. One file, next to the task dirs. */
  private claudeDismissedPath(): string {
    return join(this.opts.baseDir, this.opts.userKey ?? 'local', 'claude-desktop-dismissed.json')
  }

  private async loadClaudeDismissed(): Promise<void> {
    try {
      const raw = JSON.parse(await fs.readFile(this.claudeDismissedPath(), 'utf8')) as unknown
      if (Array.isArray(raw)) this.claudeDismissed = new Set(raw.filter((x): x is string => typeof x === 'string'))
    } catch {
      // No file yet, or unreadable. An empty set is the correct default: it
      // adopts, which the user can undo. Failing closed would hide their chats.
    }
  }

  private async saveClaudeDismissed(): Promise<void> {
    try {
      await fs.mkdir(join(this.opts.baseDir, this.opts.userKey ?? 'local'), { recursive: true })
      await fs.writeFile(this.claudeDismissedPath(), JSON.stringify([...this.claudeDismissed]))
    } catch (e) {
      log.warn('claude-dismissed-save-failed', { error: (e as Error).message })
    }
  }

  async adoptClaudeDesktop(opts: { windowMs?: number; cap?: number; only?: ReadonlySet<string> } = {}): Promise<string[]> {
    const driver = this.opts.claudeDesktopDriver
    if (!driver) return []
    // SEVEN DAYS, not one. Measured on a real machine the day this shipped:
    // 33 conversations, and ZERO with activity inside 24h — the newest was
    // 32.8h old. A 24h window adopted nothing at all, so the feature rendered
    // an empty wall on a machine with 33 real chats on it. Chats are picked up
    // and put down across days; a day is not the unit people work in.
    const windowMs = opts.windowMs ?? 7 * 24 * 60 * 60_000
    const cap = opts.cap ?? 12
    const now = this.clock()

    if (!this.claudeDismissed.size) await this.loadClaudeDismissed()

    let found: Awaited<ReturnType<ClaudeDesktopDriver['list']>>
    try {
      found = await driver.list()
    } catch {
      return []   // store unreadable this sweep; try again next time
    }

    // Already-adopted session ids, so a re-run is a no-op.
    const known = new Set(
      [...this.tasks.values()].map((t) => t.claudeDesktopSessionId).filter((x): x is string => !!x),
    )

    // THE MODEL COMES FROM CLAUDE DESKTOP'S OWN RECORD OF THIS CONVERSATION.
    //
    // Its session store names a model per task, which is the per-card truth and
    // is already historical — it is what that conversation ran on, whatever the
    // app is set to now. Explicitly NOT the composer's current model: that
    // belongs to whichever conversation the app happens to have OPEN, and
    // attributing it to every adopted card is the same mistake as attributing
    // its permission prompt (see readComposerSettings in claude-desktop/ax.ts).
    //
    // The bundle catalogue turns the stored id ('claude-opus-4-5-20251101')
    // into the app's own label ('Opus 5'). When it cannot — no bundle, a
    // restructured one, an id it does not know — the raw id is recorded rather
    // than a prettified guess, and a store with no model at all records
    // nothing. Read lazily and at most once per sweep: the catalogue is a 37MB
    // archive, and a store full of model-less tasks must not pay for it.
    let catalog: ClaudeModel[] | null = null
    const modelOf = async (modelId: string | null): Promise<string | undefined> => {
      if (!modelId) return undefined
      catalog ??= await readCatalog().catch(() => [])
      return labelFor(catalog, modelId) ?? modelId
    }

    const adopted: string[] = []
    for (const meta of found) {
      if (adopted.length >= cap) break
      // `only` names EXACTLY which conversations to take. Used by creation,
      // where the task has already been identified by diffing the store — an
      // unfiltered sweep would adopt whatever happened to sort first instead,
      // which is the same "take the newest" mistake the diff exists to avoid.
      if (opts.only && !opts.only.has(meta.sessionId)) continue
      // The user threw this card away. Adoption must never overrule that.
      if (this.claudeDismissed.has(meta.sessionId)) continue
      if (meta.archived) continue
      if (known.has(meta.sessionId)) continue
      // A conversation we were told to take is wanted regardless of age.
      if (!opts.only && meta.lastActivityAt > 0 && now - meta.lastActivityAt > windowMs) continue

      const id = randomUUID()
      const dir = join(this.opts.baseDir, this.opts.userKey ?? 'local', id)
      await fs.mkdir(dir, { recursive: true }).catch(() => {})
      const model = await modelOf(meta.model)

      const task: Task = {
        id,
        // The user never typed an intent at Unmute — the app's own title is the
        // closest honest thing, and an untitled task shows its cwd rather than
        // an invented sentence.
        intent: meta.title ?? meta.cwd ?? 'Claude Desktop task',
        ...(meta.title ? { name: meta.title } : {}),
        sessionId: meta.sessionId,
        agent: 'claude-code-desktop',
        ...(model ? { model } : {}),
        claudeDesktopSessionId: meta.sessionId,
        // A conversation the user owns in another app is persistent by nature:
        // never idle-killed, never auto-purged. 'oneoff' would let the reaper
        // delete a card for a chat that is still very much alive.
        kind: 'session',
        // Adopted as `ready`, not `processing`. We have not looked at the
        // transcript yet, and claiming work is in flight would light up the wall
        // with spinners for conversations that finished days ago. The first
        // poll promotes it if the file is actually moving.
        state: 'ready',
        createdAt: meta.createdAt || now,
        updatedAt: now,
        cwd: meta.cwd || dir,
        home: dir,
        statusPath: join(dir, 'status.json'),
        recipeScratchPath: join(dir, 'recipe.json'),
        lastMtimeMs: 0,
        lastHeartbeatMs: meta.lastActivityAt || now,
        mode: 'managed',
      } as Task
      this.tasks.set(id, task)

      await fs.writeFile(join(dir, 'meta.json'), JSON.stringify({
        id, intent: task.intent, sessionId: meta.sessionId, kind: 'session',
        createdAt: task.createdAt, mode: 'managed',
        agent: 'claude-code-desktop', claudeDesktopSessionId: meta.sessionId,
        state: 'ready', updatedAt: now,
        ...(model ? { model } : {}),
      })).catch(() => {})

      this.emit('created', task)
      adopted.push(id)
      this.startPolling(id)
    }

    // Logged EVERY sweep, including the empty ones. The 24h-window bug above
    // was invisible precisely because a zero-adoption sweep said nothing: the
    // wall was empty and the log was silent, so there was no way to tell "no
    // conversations" from "the sweep never ran".
    log.event('claude-desktop-adopted', {
      adopted: adopted.length, scanned: found.length,
      skippedArchived: found.filter((t) => t.archived).length,
      skippedStale: found.filter((t) => !t.archived && t.lastActivityAt > 0 && now - t.lastActivityAt > windowMs).length,
      skippedDismissed: found.filter((t) => this.claudeDismissed.has(t.sessionId)).length,
      windowMs, cap,
    })
    return adopted
  }

  /**
   * Start a new Claude Desktop conversation from Unmute.
   *
   * The app gives us no id at creation, so the new task is identified by
   * DIFFING the store: snapshot the session ids first, create, then look for
   * one that was not there. Taking "the newest" without a before-set is exactly
   * how the Codex backend once bound two cards to a single thread.
   */
  async createClaudeDesktop(intent: string, opts: { tries?: number; waitMs?: number } = {}): Promise<{ ok: boolean; id?: string; reason?: string }> {
    const driver = this.opts.claudeDesktopDriver
    const actuator = this.opts.claudeActuator
    if (!driver || !actuator) return { ok: false, reason: 'no-backend' }
    if (!intent.trim()) return { ok: false, reason: 'empty-intent' }

    const before = new Set((await driver.list()).map((t) => t.sessionId))
    const res = await actuator.createTask(intent)
    if (!res.ok) {
      log.warn('claude-desktop-create-failed', { reason: res.reason ?? 'unknown' })
      return { ok: false, reason: res.reason ?? 'failed' }
    }

    // The store is written asynchronously, so poll rather than read once.
    const tries = opts.tries ?? 10
    const waitMs = opts.waitMs ?? 500
    for (let i = 0; i < tries; i++) {
      const fresh = (await driver.list()).filter((t) => !before.has(t.sessionId))
      if (fresh.length) {
        // Newest by activity among the genuinely NEW ones — the before-set has
        // already excluded every pre-existing conversation.
        const created = fresh.sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0]
        const [id] = await this.adoptClaudeDesktop({ only: new Set([created.sessionId]), cap: 1 })
        log.event('claude-desktop-create-resolved', { sessionId: created.sessionId, attempts: i + 1, adopted: !!id })
        return { ok: true, id }
      }
      await new Promise((r) => setTimeout(r, waitMs))
    }
    // The conversation was almost certainly created — we just cannot name it.
    // Saying so beats claiming failure for work that DID start.
    log.warn('claude-desktop-create-unresolved', {})
    return { ok: true, reason: 'id-unresolved' }
  }

  /**
   * One composer, two meanings — the same rule Codex already follows.
   *
   * If the task is stopped on a permission prompt, what the user typed is an
   * ANSWER to that prompt and must be pressed there. Sending it as a message
   * would leave the dialog still waiting AND drop a stray line into their
   * conversation.
   *
   * Matching is done against the option labels the CARD showed, case- and
   * shortcut-insensitive, because the labels carry their own digits ("Deny 1",
   * "Allow once 3 ⌘ ⏎") and nobody types those. Anything that is not one of the
   * offered options is treated as an ordinary reply — a user answering "no, do
   * it differently" must not be silently mapped onto "Deny".
   */
  private async answerOrSendClaudeDesktop(id: string, text: string): Promise<void> {
    const task = this.tasks.get(id)
    if (!task) return
    const tlog = log.child({ taskId: id })
    const consent = task.claudeConsent

    if (consent?.options.length) {
      const said = text.trim().toLowerCase()
      const match = consent.options.find((label) => {
        const bare = label.toLowerCase().replace(/[0-9⌘⏎]/g, '').replace(/\s+/g, ' ').trim()
        return bare === said || (said.length >= 3 && bare.startsWith(said))
      })
      if (match) {
        tlog.event('claude-desktop-answer-from-composer', { option: match })
        await this.answerClaudeDesktop(id, match)
        return
      }
      tlog.event('claude-desktop-reply-while-blocked', { note: 'not one of the offered options' })
    }
    await this.sendClaudeDesktop(id, text)
  }

  /**
   * Send a message to a Claude desktop conversation.
   *
   * Addressed by the task's TITLE, because that is what the sidebar row carries
   * and the sidebar is the only way to select a conversation. The actuator
   * opens and sends as one intent so nothing can re-target the app in between.
   *
   * Refuses while the task is blocked: typing prose at a permission prompt puts
   * the text somewhere unpredictable and leaves the prompt unanswered.
   */
  async sendClaudeDesktop(id: string, text: string): Promise<{ ok: boolean; reason?: string }> {
    const task = this.tasks.get(id)
    if (!task || task.agent !== 'claude-code-desktop') return { ok: false, reason: 'not-a-claude-desktop-task' }
    const actuator = this.opts.claudeActuator
    if (!actuator) return { ok: false, reason: 'no-actuator' }
    if (task.state === 'needs-user') return { ok: false, reason: 'answer-the-prompt-first' }
    const title = task.name
    if (!title) return { ok: false, reason: 'no-title-to-address' }

    const tlog = log.child({ taskId: id })
    task.sending = true
    this.emit('updated', task)
    try {
      const res = await actuator.sendTo(title, text)
      if (!res.ok) {
        // A delivery failure is NOT a task failure: the conversation is fine,
        // our message simply did not arrive. Same distinction the PTY backends
        // draw with deliveryError.
        task.deliveryError = res.reason ?? 'failed'
        tlog.warn('claude-desktop-send-failed', { reason: res.reason ?? 'unknown' })
        return { ok: false, reason: res.reason ?? 'failed' }
      }
      delete task.deliveryError
      this.claudeAxCache = null          // the UI just changed; do not serve a stale read
      this.transition(id, 'processing')
      tlog.event('claude-desktop-sent', { chars: text.length })
      return { ok: true }
    } finally {
      task.sending = false
      this.emit('updated', task)
    }
  }

  /**
   * Answer the permission prompt a Claude desktop task is stopped on.
   *
   * Takes the option LABEL the user was shown, not an index or a node id, so
   * the choice cannot drift onto a different button between rendering the card
   * and acting on it.
   *
   * This is the one call in this backend that steals focus. It is serialized
   * inside the actuator, so two users of this method cannot fight over which
   * app is frontmost or which conversation is open.
   */
  async answerClaudeDesktop(id: string, optionLabel: string): Promise<{ ok: boolean; reason?: string }> {
    const task = this.tasks.get(id)
    if (!task || task.agent !== 'claude-code-desktop') return { ok: false, reason: 'not-a-claude-desktop-task' }
    const actuator = this.opts.claudeActuator
    if (!actuator) return { ok: false, reason: 'no-actuator' }
    const tlog = log.child({ taskId: id })

    // Re-read rather than trusting the cached prompt: the user may have
    // answered it in the app while the card sat on screen, and typing a digit
    // at a prompt that is gone would land in the composer as text.
    this.claudeAxCache = null
    const ax = await this.claudeAx([])
    if (!ax.treeAlive || !ax.consent) {
      delete task.claudeConsent
      tlog.event('claude-desktop-answer-stale', { treeAlive: ax.treeAlive })
      return { ok: false, reason: 'prompt-gone' }
    }

    const res = await actuator.answerConsent(ax.consent, optionLabel)
    if (res.ok) {
      delete task.claudeConsent
      this.transition(id, 'processing')
    } else {
      tlog.warn('claude-desktop-answer-failed', { reason: res.reason ?? 'unknown' })
    }
    return res.ok ? { ok: true } : { ok: false, reason: res.reason ?? 'failed' }
  }

  /**
   * One accessibility read per tick, shared by every Claude desktop card.
   *
   * Deduped two ways: a short TTL, and an in-flight promise so a burst of
   * cards on the same tick awaits ONE walk rather than starting N. Failure is
   * absorbed into `treeAlive: false`, which callers must read as "we know
   * nothing" — never as "nothing is wrong".
   */
  private async claudeAx(titles: string[], ttlMs = 1500): Promise<{ rows: ClaudeSidebarRow[]; consent: ClaudeConsentLite | null; treeAlive: boolean }> {
    const ax = this.opts.claudeDesktopAx
    if (!ax) return { rows: [], consent: null, treeAlive: false }
    const now = this.clock()
    if (this.claudeAxCache && now - this.claudeAxCache.at < ttlMs) {
      const c = this.claudeAxCache
      return { rows: c.rows, consent: c.consent, treeAlive: c.treeAlive }
    }
    if (this.claudeAxInflight) {
      await this.claudeAxInflight
      const c = this.claudeAxCache
      return c ? { rows: c.rows, consent: c.consent, treeAlive: c.treeAlive } : { rows: [], consent: null, treeAlive: false }
    }
    this.claudeAxInflight = (async () => {
      try {
        const nodes = await ax.nodes()
        const state = readAxState(nodes)
        this.claudeAxCache = {
          at: this.clock(),
          treeAlive: state.treeAlive,
          consent: state.consent,
          rows: state.treeAlive ? readAxSidebar(nodes, titles) : [],
        }
      } catch {
        this.claudeAxCache = { at: this.clock(), rows: [], consent: null, treeAlive: false }
      } finally {
        this.claudeAxInflight = null
      }
    })()
    await this.claudeAxInflight
    const c = this.claudeAxCache
    return c ? { rows: c.rows, consent: c.consent, treeAlive: c.treeAlive } : { rows: [], consent: null, treeAlive: false }
  }

  /**
   * Refresh one Claude desktop card from disk.
   *
   * Shaped like pollCodexDesktop on purpose — same backoff, same watcher-as-
   * shortcut, same "ready is a resting state, not a terminal one" rule, because
   * a Claude Desktop conversation outlives our card in exactly the same way:
   * the user can keep talking to it in the app, and a new turn there has to
   * re-open the card rather than being invisible.
   *
   * WHAT THIS CAN AND CANNOT KNOW. Everything here comes from files, so it can
   * see that work happened and what was said. It CANNOT see that a turn is
   * blocked on a permission prompt — Claude Desktop never writes the pending
   * request to disk, exactly like Codex and its Computer Use consents. So state
   * is derived conservatively from movement:
   *
   *   the transcript grew            -> processing
   *   quiet, and it has spoken       -> ready
   *   quiet, and it never spoke      -> leave alone (it may never have started)
   *
   * `pendingToolCalls` is deliberately NOT treated as blocked here. An unmatched
   * tool call is what a permission prompt looks like on disk, but a slow build
   * looks identical, and guessing produced the stuck/processing strobe on the
   * Codex side. The real signal lives in the accessibility tree, where the
   * prompt actually exists; this poller stays quiet until that lands rather
   * than inventing a state it cannot support.
   */
  private async pollClaudeDesktop(id: string, force = false): Promise<void> {
    const task = this.tasks.get(id)
    if (!task || !task.claudeDesktopSessionId || task.state === 'done' || task.state === 'failed') return
    const driver = this.opts.claudeDesktopDriver
    if (!driver) return
    const tlog = log.child({ taskId: id })

    // Back off hard once settled. Reading is cheap but not free, and a wall of
    // finished cards re-reading their transcripts every second is the same
    // waste that was measured on the Codex side in the field.
    //
    // But NEVER before the first read. Adoption starts a card at `ready` (it has
    // not been looked at yet), so applying the decimation immediately made the
    // first nine polls no-ops — a conversation that was actively moving when we
    // adopted it sat untouched for ~10 ticks before anyone read the file. The
    // Codex poller never hit this because its tasks start `processing`.
    if (!force && task.state === 'ready' && this.claudeLastSeenAt.has(id)) {
      const n = (this.claudeIdleTicks.get(id) ?? 0) + 1
      this.claudeIdleTicks.set(id, n)
      if (n % 10 !== 0) return
    } else {
      this.claudeIdleTicks.delete(id)
    }

    // Latency shortcut, attached lazily once a transcript exists. fs.watch
    // coalesces and can miss events, so the poll above stays the correctness
    // backstop and this never becomes the only path.
    if (!this.claudeWatchers.has(id)) {
      this.claudeWatchers.set(id, () => {})   // claim the slot; no double-attach
      // force: a watcher event is PROOF the file changed, so it must never be
      // dropped by the idle decimation above. Without this the shortcut was
      // useless exactly when it mattered — a chat continued inside Claude
      // Desktop woke us and we skipped the read anyway.
      void driver.watch(task.claudeDesktopSessionId, () => { void this.pollClaudeDesktop(id, true) })
        .then((stop) => {
          if (this.tasks.has(id)) this.claudeWatchers.set(id, stop)
          else stop()
        })
        .catch(() => { this.claudeWatchers.delete(id) })
    }

    const view = await driver.snapshot(task.claudeDesktopSessionId)
    if (!view) {
      // The task is gone from Claude Desktop's store — the user deleted it
      // there. Nothing to poll; leave the card's last known state rather than
      // inventing a failure the user never saw.
      tlog.debug('claude-desktop-poll', { gone: true })
      return
    }

    const { task: meta, snapshot: snap } = view

    // "Advanced" must mean GREW SINCE WE LAST LOOKED, and the first look has no
    // last. Comparing against a default of 0 made every freshly adopted card
    // look like it had just moved, so the whole wall lit up as `processing` —
    // verified against the real store: 8 of 8 adopted conversations, every one
    // of them finished days earlier. Seed the baseline instead, and let the
    // NEXT poll decide. A conversation genuinely in flight is then one tick
    // late, which is invisible; a dead one never lies.
    const seeded = this.claudeLastSeenAt.has(id)
    const advanced = seeded && snap.updatedAt > (this.claudeLastSeenAt.get(id) ?? 0)
    if (!seeded || advanced) this.claudeLastSeenAt.set(id, snap.updatedAt)
    if (snap.updatedAt > task.lastHeartbeatMs) task.lastHeartbeatMs = snap.updatedAt

    // The app's own title beats our generated name once it exists — it is what
    // the user sees in Claude Desktop, so showing something else in Unmute
    // makes the two lists impossible to line up.
    if (meta.title && meta.title !== task.name) task.name = meta.title
    if (snap.lastAgentMessage && snap.lastAgentMessage !== task.threadContext) {
      task.threadContext = snap.lastAgentMessage
    }
    if (snap.turns.length) task.conversation = snap.turns

    // ── LIVE state, the part disk cannot supply ──────────────────────────
    //
    // A permission prompt is never written to disk; it exists only in the
    // window. So a task stopped on one looks, on disk, exactly like a task
    // whose last tool call is slow — which is why the poller refused to guess
    // from pendingToolCalls alone. This is where that guess gets replaced by
    // an actual observation.
    let axStatus: string | null = null
    let blocked = false
    if (this.opts.claudeDesktopAx) {
      const titles = [...this.tasks.values()]
        .map((t) => t.name)
        .filter((t): t is string => !!t)
      const ax = await this.claudeAx(titles)
      if (ax.treeAlive) {
        // The app's own word for this task, shown verbatim. No vocabulary is
        // interpreted here — only 'Idle' has ever been observed, and mapping
        // an unseen value onto a state would be inventing meaning.
        axStatus = meta.title ? statusForTitle(ax.rows, meta.title) : null

        // A visible prompt names no task, and only ONE conversation is
        // addressable on this app — so it can only belong to the focused one.
        // Attributing it to any other card would light up the wrong task.
        if (ax.consent) {
          const focused = await driver.focused()
          blocked = !!focused && focused.sessionId === task.claudeDesktopSessionId
          if (ax.consent && !focused) {
            tlog.debug('claude-desktop-consent-unattributed', { question: ax.consent.question.slice(0, 60) })
          }
        }
      }
    }
    if (axStatus !== null && axStatus !== task.claudeStatusChip) task.claudeStatusChip = axStatus

    tlog.debug('claude-desktop-poll', {
      advanced, turns: snap.turns.length, userMessages: snap.userMessages,
      pendingToolCalls: snap.pendingToolCalls, taskState: task.state,
      axStatus, blocked,
    })

    // Blocked outranks every movement signal: a turn stopped for permission is
    // not 'processing', however recently the file grew before it stopped.
    if (blocked) {
      const c = this.claudeAxCache?.consent
      if (c) task.claudeConsent = { question: c.question, options: c.options.map((o) => o.label) }
      if (task.state !== 'needs-user') {
        tlog.event('claude-desktop-blocked', { question: this.claudeAxCache?.consent?.question?.slice(0, 80) ?? null })
        this.transition(id, 'needs-user')
      }
      return
    }
    // The prompt is gone: whoever answered it (in Unmute or in the app), this
    // card must not stay stuck on a question nobody is being asked any more.
    if (task.state === 'needs-user') {
      delete task.claudeConsent
      tlog.event('claude-desktop-unblocked', {})
      this.transition(id, 'processing')
      return
    }

    if (advanced && task.state === 'ready') {
      tlog.event('claude-desktop-reopened', { note: 'continued inside Claude Desktop' })
      this.transition(id, 'processing')
      return
    }
    if (advanced && task.state !== 'processing') {
      this.transition(id, 'processing')
      return
    }
    // Settled: it has spoken and nothing has moved since the previous poll.
    if (!advanced && task.state === 'processing' && snap.lastAgentMessage) {
      this.transition(id, 'ready')
    }
  }

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

    // Latency shortcut, attached lazily on the first poll that finds a
    // transcript: Codex appending wakes us immediately instead of waiting for
    // the next tick — which for a `ready` task is up to 10s away because of the
    // backoff above, and `ready` is exactly when the user is watching. The poll
    // remains the correctness backstop; fs.watch coalesces and can miss events,
    // so this never becomes the only path.
    if (!this.codexWatchers.has(id) && driver.watch) {
      this.codexWatchers.set(id, () => {})   // claim the slot; no double-attach
      void driver.watch(task.codexThreadId, () => { void this.pollCodexDesktop(id) })
        .then((stop) => {
          if (this.tasks.has(id)) this.codexWatchers.set(id, stop)
          else stop()                        // task died while we were attaching
        })
        .catch(() => { this.codexWatchers.delete(id) })
    }

    const snap = await driver.snapshot(task.codexThreadId)
    // Did the rollout actually GROW since we last looked? This is the difference
    // between "a turn is in flight" and "a turn is in flight and still moving",
    // and the whole stuck/processing oscillation came from conflating them.
    const advanced = snap.updatedAt > (this.codexLastSeenAt.get(id) ?? 0)
    if (advanced) this.codexLastSeenAt.set(id, snap.updatedAt)
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

    // A turn that is in flight AND frozen mid-tool-call is not working and is
    // not stuck — it is WAITING ON THE USER. Codex raises Computer Use consents
    // ("Allow ChatGPT to use WhatsApp?") in its own window, writes nothing to
    // the rollout and fires no PermissionRequest hook, so the only trace is an
    // unclosed call on a file that stopped growing.
    //
    // Without this branch the two rules below fought every poll: `processing`
    // satisfied stuck-recovery, a frozen heartbeat satisfied staleness, and the
    // card flipped between them once a second (observed 2026-07-30, logs show
    // stuck-recovered/task-stuck alternating at 1s).
    // TWO SIGNALS, TWO CONFIDENCES. The disk can only ever SUSPECT: a frozen
    // mid-tool-call turn looks identical whether Codex is waiting on a consent
    // or a slow build is running (measured: thinking writes every ~0.5s, but a
    // 60s tool call and a 61s consent block are indistinguishable on disk).
    //
    // Codex's SIDEBAR settles it, and does so for every thread at once without
    // switching the mounted conversation — verified live against a blocked
    // thread that was NOT on screen. So:
    //
    //   chip + frozen call  => CONFIRMED. Announce it; this is the user's move.
    //   frozen call only    => SUSPECTED. Stay quiet. A slow build must never be
    //                          announced as needing you — being wrong out loud
    //                          is the one error that costs trust for good.
    //
    // Suspicion therefore does NOT transition the task. It stays `processing`
    // and the poll keeps watching; only corroboration promotes it.
    const frozenMidCall =
      snap.state === 'processing' && !advanced && snap.pendingToolCalls > 0 &&
      isStale({ state: 'processing' }, task.lastHeartbeatMs, this.clock(), this.opts.codexBlockedMs)

    if (frozenMidCall && task.state !== 'needs-user') {
      const chip = await this.codexChipFor(task.codexThreadId, driver, task.codexDomThreadId)

      // CONFIRMATION MUST NOT BE A GATE, only an accelerator.
      //
      // First cut made "no chip" mean silence forever, so ONE broken link — an
      // id mismatch, a reworded chip, CDP dropping, a chip we have never seen —
      // silenced the entire needs-you signal. That happened on the very first
      // real test: the card sat at "Working" while Codex was visibly asking,
      // logging codex-quiet once a second.
      //
      // So the sidebar makes it FAST and CONFIDENT, and its absence makes it
      // SLOW and VAGUE — never silent. After codexUnconfirmedMs of a frozen
      // tool call we say so, hedged, because at that point we genuinely do not
      // know whether it is blocked or merely slow, and the card should claim
      // only what it knows.
      const frozenForMs = this.clock() - task.lastHeartbeatMs
      if (!chip && frozenForMs < this.opts.codexUnconfirmedMs) {
        tlog.debug('codex-quiet', {
          pendingTool: snap.pendingToolName, frozenForMs,
          note: 'frozen but unconfirmed — staying processing until the fallback window',
        })
        return
      }
      if (!chip) {
        tlog.event('codex-blocked-unconfirmed', { pendingTool: snap.pendingToolName, frozenForMs })
        this.transition(task.id, 'needs-user', {
          state: 'needs-user',
          question: {
            // Hedged on purpose: we could not confirm, so we describe rather
            // than diagnose. "Quiet", not "stuck", and not "waiting on you".
            text: `Quiet for ${Math.round(frozenForMs / 60_000)}m — check Codex`,
            choices: [],
          },
        } as StatusPayload)
        return
      }
      tlog.event('codex-blocked', { pendingTool: snap.pendingToolName, pendingCalls: snap.pendingToolCalls, chip })

      // The question text lives ONLY in the mounted thread's panel, so reading
      // it costs a thread switch. Take it when it is free (this thread is
      // already on screen) and otherwise show Codex's own chip — the full
      // question is fetched later, when the user actually opens the card.
      let consent: { question: string; choices: string[] } | null = null
      if (chip.active) {
        try {
          const c = await driver.readConsent?.(task.codexThreadId)
          if (c?.options?.length) consent = { question: c.question, choices: c.options }
        } catch { /* best effort — the chip already carries the truth */ }
        if (consent) tlog.event('codex-consent-read', { question: consent.question, choices: consent.choices })
      }

      this.transition(task.id, 'needs-user', {
        state: 'needs-user',
        question: {
          // Codex's OWN word when we could not read the panel — its chip said
          // "Awaiting approval", so say that rather than inventing a label.
          text: consent?.question ?? chip.chip ?? 'Codex is waiting on you',
          // Whatever Codex offers, never a fixed pair: this consent shipped
          // "Always allow" / "Deny" / "Allow this conversation".
          choices: consent?.choices ?? [],
        },
      } as StatusPayload)
      return
    }

    // Only a rollout that GREW is proof of life. A frozen one satisfying
    // `processing` is exactly the blocked case handled above, and recovering on
    // it is what made the flip-flop self-sustaining.
    if (snap.state === 'processing' && advanced && task.state === 'stuck') {
      tlog.event('stuck-recovered', { via: 'codex-rollout' })
      this.transition(id, 'processing')
      return
    }

    if (
      task.state !== 'stuck' &&
      task.state !== 'needs-user' &&
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
    // Route to the poller for THIS backend. isExternalAgent is true for every
    // driver-transport provider, so sending them all to pollCodexDesktop was
    // correct only while Codex was the only one — a Claude desktop task would
    // have fallen into the Codex poller, been dropped by its `!codexThreadId`
    // guard, and then never polled again: a card frozen at its first state with
    // nothing logged. Same shape as the setup-probe bug, one layer down.
    if (task && isExternalAgent(task.agent)) {
      return task.agent === 'claude-code-desktop'
        ? this.pollClaudeDesktop(id)
        : this.pollCodexDesktop(id)
    }
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

    // The hook heartbeat no longer needs polling for: PostToolUse is PUSHED to
    // onHookEvent(), which advances lastHeartbeatMs the moment it happens and
    // heals a false `stuck` on the spot. We used to stat a marker file here on
    // every poll of every task — that is now zero syscalls and strictly fresher.
    //
    // The subtle rule it enforced still holds and lives in onHookEvent(): a hook
    // advances lastHeartbeatMs ONLY, never lastMtimeMs (the status read cursor).

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
    devEvent(tlog, 'librarian-handoff', { taskId: task.id, outcome, fired: true, injectedRecipes: task.injectedRecipes?.length ?? 0 })
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
    // Claude desktop FIRST. isExternalAgent is true for every driver backend,
    // so without this a Claude Desktop reply fell into the Codex path below and
    // was dropped by its `!codexThreadId` guard — the user types, nothing
    // happens, nothing is logged. Same shape as the poll and probe bugs.
    if (target && target.agent === 'claude-code-desktop') {
      tlog.ui('task-row.answer-submitted', { answer: userAnswer })
      void this.answerOrSendClaudeDesktop(id, userAnswer)
      return
    }
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

    // A CHOICE IS ANSWERED BY INDEX, NOT BY ITS LABEL.
    //
    // `AskUserQuestion` renders a NUMBERED PICKER in the TUI, not a text field.
    // Typing the option's text does nothing to the selection, and the Enter that
    // follows takes whatever is HIGHLIGHTED — which is option 1. Verified on a
    // live session: answering "Spaces" recorded "Tabs".
    //
    // That is the worst class of bug this surface can have: the user picks one
    // thing, the agent receives another, and nothing anywhere reports an error.
    // So when the pending question came with choices, map the label back to its
    // 1-based position and send that single keystroke — the picker selects
    // immediately, with no Enter (also verified: "3" selected "Blue").
    const pending = answered?.question
    const idx = pending?.kind === 'choice' && pending.choices
      ? pending.choices.findIndex((c) => c.trim().toLowerCase() === userAnswer.trim().toLowerCase())
      : -1
    if (idx >= 0 && idx < 9) {
      ex.write(String(idx + 1))
      tlog.event('answered-by-index', { index: idx + 1, label: userAnswer })
      const t = this.tasks.get(id)
      if (t && t.state === 'needs-user') {
        t.state = 'processing'
        t.updatedAt = this.clock()
        this.emit('updated', t)
      }
      return
    }
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
      const convo = task.conversation ?? []
      const sameConvo = JSON.stringify(meta.conversation ?? []) === JSON.stringify(convo)
      if (meta.state === task.state && meta.updatedAt === task.updatedAt && sameConvo) return
      // THE CONVERSATION HAS TO SURVIVE A RESTART. It lived only in memory, so
      // every relaunch emptied the chat strip for every existing task and left
      // the short status line standing where the exchange should be — which is
      // exactly what a surface meant to replace reading the terminal cannot do.
      // status.json already persists; this is the other half.
      await fs.writeFile(path, JSON.stringify({
        ...meta, state: task.state, updatedAt: task.updatedAt,
        ...(convo.length ? { conversation: convo } : {}),
      }))
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
    // Remember the dismissal BEFORE the task leaves the map, or the adoption
    // sweep puts this conversation straight back (see claudeDismissed).
    if (task?.claudeDesktopSessionId) {
      this.claudeDismissed.add(task.claudeDesktopSessionId)
      void this.saveClaudeDismissed()
    }
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
      let meta: { intent?: string; sessionId?: string; name?: string; kind?: 'oneoff' | 'session'; cwd?: string; createdAt?: number; state?: string; updatedAt?: number; surface?: string; mode?: 'managed' | 'raw'; injectedRecipes?: Array<{ name: string; tier: 'nursery' | 'skill'; surface: string }>; shelved?: boolean; note?: string; spawnedBy?: string; group?: string; agent?: AgentKind; model?: string; codexThreadId?: string; codexDomThreadId?: string; codexProject?: string | null; claudeDesktopSessionId?: string; conversation?: Task['conversation'] }
      try { meta = JSON.parse(await fs.readFile(join(dir, 'meta.json'), 'utf8')) } catch { continue }
      if (!meta.intent) continue // pre-receipt task or junk dir — skip
      // EXTERNAL BACKEND: a Codex thread lives in Codex, so an Unmute restart
      // does not interrupt it — the work may well have finished while we were
      // gone. Rebuild the record and let the poller read the true state off the
      // rollout, instead of the 'failed / interrupted' verdict a PTY task gets.
      // Same reasoning for Claude desktop, and it MUST be restored or the card
      // is broken twice over:
      //
      //   1. pollClaudeDesktop bails without claudeDesktopSessionId, so the
      //      rehydrated card never updates again — a permanent tombstone that
      //      still takes up space on the wall;
      //   2. adoptClaudeDesktop dedupes on that same field, so with it missing
      //      every launch adopts the whole store AGAIN. Measured after four
      //      installs: 18 cards for 6 conversations, exactly 3 duplicates each,
      //      one set per launch that ran a sweep.
      //
      // The conversation lives in Claude Desktop and outlives our process, so
      // like Codex this is rebuilt rather than marked interrupted.
      if (meta.agent === 'claude-code-desktop' && meta.claudeDesktopSessionId) {
        const now0 = this.clock()
        const ctask: Task = {
          id,
          intent: meta.intent,
          name: meta.name,
          sessionId: meta.claudeDesktopSessionId,
          agent: 'claude-code-desktop',
          // REPLAYED, never re-resolved. A receipt written before this field
          // existed simply has no `model` and the card stays agent-only — the
          // one honest outcome, since nothing on disk can say what it ran on.
          ...(meta.model ? { model: meta.model } : {}),
          claudeDesktopSessionId: meta.claudeDesktopSessionId,
          kind: meta.kind ?? 'session',
          state: (meta.state as UiTaskState | undefined) ?? 'ready',
          createdAt: meta.createdAt ?? now0,
          updatedAt: meta.updatedAt ?? now0,
          cwd: meta.cwd ?? dir,
          home: dir,
          statusPath: join(dir, 'status.json'),
          recipeScratchPath: join(dir, 'recipe.json'),
          lastMtimeMs: 0,
          lastHeartbeatMs: meta.updatedAt ?? now0,
          mode: meta.mode ?? 'managed',
          ...(meta.shelved ? { shelved: true } : {}),
          ...(meta.note ? { note: meta.note } : {}),
          ...(meta.group ? { group: meta.group } : {}),
        } as Task
        this.tasks.set(id, ctask)
        restored++
        this.startPolling(id)
        continue
      }
      if (meta.agent === 'codex-desktop' && meta.codexThreadId) {
        const now0 = this.clock()
        const ctask: Task = {
          id,
          intent: meta.intent,
          name: meta.name,
          sessionId: meta.codexThreadId,
          agent: 'codex-desktop',
          ...(meta.model ? { model: meta.model } : {}),
          codexThreadId: meta.codexThreadId,
          codexDomThreadId: meta.codexDomThreadId,
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
      // A PERSISTENT SESSION CLOSED BY THE QUIT SWITCH DID NOT FAIL.
      //
      // Every session dies when the app quits (killAll on before-quit — the
      // guard against leaving processes behind). For a one-off that lands as
      // 'failed / interrupted', which is honest: its errand was cut short. For a
      // working session it was a lie in red — nothing failed, you closed the
      // laptop. It comes back as `ready` instead: terminal (so it never inflates
      // the running count), ball-with-you, no error to explain away. Opening the
      // card revives it (see `opened`). Sessions are exempt from the ready decay,
      // so this cannot quietly settle to done either.
      const isSession = (meta.kind ?? 'oneoff') === 'session'
      const task: Task = {
        id,
        intent: meta.intent,
        name: meta.name,
        // Pre-sessionId receipts won't carry one; fall back to the task id so the
        // field is always present (older tasks simply aren't session-pinned).
        sessionId: meta.sessionId ?? id,
        ...(meta.model ? { model: meta.model } : {}),
        kind: meta.kind ?? 'oneoff',
        // A non-terminal task whose session died with the app is, to the user,
        // interrupted — surface it as failed (still resumable) rather than a
        // forever-spinning 'processing'. Sessions get `ready` instead (above).
        state: terminal ? status!.state : (isSession ? 'ready' : 'failed'),
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
        error: terminal ? status?.error : (isSession ? undefined : { reason: 'Interrupted by an app restart — resume to continue' }),
        question: status?.question,
        surface: meta.surface,
        mode: meta.mode ?? 'managed',
        injectedRecipes: meta.injectedRecipes ?? [],
        // Restored so the chat strip is not empty after a relaunch — see
        // persistState(). Without it the card falls back to the short status
        // line where the exchange should be.
        ...(Array.isArray(meta.conversation) ? { conversation: meta.conversation as Task['conversation'] } : {}),
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
    // Claude Desktop conversations arrive by ADOPTION, not dispatch — the user
    // starts them in the app, so nothing here ever gets told. Sweeping is the
    // only way they appear. Slow on purpose: a chat the user just opened does
    // not need sub-second discovery, and each sweep reads the whole store.
    if (this.opts.claudeDesktopDriver) {
      void this.adoptClaudeDesktop()
      this.claudeAdoptTimer = setInterval(() => { void this.adoptClaudeDesktop() }, 30_000)
      ;(this.claudeAdoptTimer as { unref?: () => void }).unref?.()
    }
    log.event('maintenance-started', { purgeAgeMs: this.opts.purgeAgeMs, purgeSweepMs: this.opts.purgeSweepMs })
  }

  /** Stop the maintenance sweep (shutdown / tests). */
  stopMaintenance(): void {
    if (this.purgeTimer) { clearInterval(this.purgeTimer); this.purgeTimer = null }
    if (this.approvalTimer) { clearInterval(this.approvalTimer); this.approvalTimer = null }
    if (this.claudeAdoptTimer) { clearInterval(this.claudeAdoptTimer); this.claudeAdoptTimer = null }
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
  /**
   * Codex's own status chip for one thread, from a shared sidebar snapshot.
   *
   * Returns null for "no chip" AND for "could not look" (not armed, sidebar not
   * rendered) — both mean UNCONFIRMED, and an unconfirmed suspicion must stay
   * silent. Never mounts a thread.
   *
   * Cached for a tick and de-duplicated in flight, so N blocked tasks cost ONE
   * CDP call rather than N.
   */
  private async codexChipFor(
    threadId: string,
    driver: { threadChips?: () => Promise<Array<{ id: string; title?: string; active: boolean; chip: string | null }>> },
    domId?: string,
  ): Promise<{ active: boolean; chip: string | null } | null> {
    if (!driver.threadChips) return null
    const now = this.clock()
    if (!this.codexChipCache || now - this.codexChipCache.at > this.opts.codexChipTtlMs) {
      if (!this.codexChipInflight) {
        this.codexChipInflight = (async () => {
          try {
            const rows = await driver.threadChips!()
            // An empty read is "unknown", not "nothing blocked" — do NOT cache
            // it as an answer, or one unarmed moment silences every task.
            if (rows.length) this.codexChipCache = { at: this.clock(), rows }
          } catch { /* unknown; leave the previous answer alone */ }
          finally { this.codexChipInflight = null }
        })()
      }
      await this.codexChipInflight
    }
    const rows = this.codexChipCache?.rows ?? []

    // MATCHING IS NOT JUST "same id", and getting that wrong silenced the whole
    // feature once already (2026-07-30).
    //
    // A thread has TWO names. Unmute stores the durable id recovered from the
    // rollout FILENAME (019fb3b3-…). Codex's sidebar labels a not-yet-persisted
    // thread with a TRANSIENT id instead — `local:client-new-thread:8ea1da75-…`
    // — whose uuid is unrelated. They never match, so the lookup failed on every
    // tick and the card sat at "Working" while Codex was visibly asking.
    //
    // This is not a startup race that resolves itself: the sidebar keeps the
    // transient label until Codex persists the thread, and that window covers
    // the FIRST turn — exactly when a Computer Use consent tends to fire. So the
    // common case, not an edge case.
    const bare = (s: string) => s.split(':').pop() ?? s
    const row = rows.find((r) =>
      r.id === threadId || bare(r.id) === bare(threadId) ||
      // …or the label the sidebar was using when we created it. Captured at
      // creation because nothing on the row links a transient id to the durable
      // one, and TITLES ARE NOT AN OPTION — the user can rename a thread.
      (!!domId && (r.id === domId || bare(r.id) === bare(domId))))
    if (!row?.chip) return null
    return { active: row.active, chip: row.chip }
  }

  private async sweepApprovals(): Promise<void> {
    // Bin what the hook can no longer be waiting on before reading, so a
    // request whose task never came back does not live on disk forever.
    try { await expireStaleApprovals() } catch { /* best effort */ }
    let requests: Awaited<ReturnType<typeof pendingApprovals>> = []
    try { requests = await pendingApprovals() } catch { return }

    const live = new Set<string>()
    for (const req of requests) {
      live.add(req.threadId)
      const task = [...this.tasks.values()].find((t) => t.codexThreadId === req.threadId)
      if (!task) {
        // A thread the user started inside Codex, not through us. Not ours to
        // answer — leave it for Codex's own dialog rather than inventing a card.
        //
        // It is ALSO how a request for one of our own tasks goes missing: the
        // match is against tasks live in memory, so a restart between the hook
        // firing and this sweep drops it. Silence made that indistinguishable
        // from "nothing pending", so it is logged now; pendingApprovals()
        // expires the file rather than leaving it forever.
        if (!this.unmatchedApprovals.has(req.threadId)) {
          this.unmatchedApprovals.add(req.threadId)
          log.event('codex-approval-unmatched', {
            threadId: req.threadId, tool: req.toolName,
            note: 'no live task carries this threadId — left for Codex own dialog',
          })
        }
        continue
      }
      this.unmatchedApprovals.delete(req.threadId)
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
    if (!threadId) return false

    // A COMPUTER USE consent is a different surface from a tool approval: it
    // never reached the hook, so there is no decision-file to write. It is
    // answered by clicking the option in Codex's own panel — and the options
    // are whatever that panel offered ("Allow this conversation" is real), so
    // we match the user's words against the choices we actually read, never
    // against a hardcoded allow/deny pair.
    const choices = task.question?.choices ?? []
    if (task.state === 'needs-user' && choices.length && !this.surfacedApprovals.has(threadId)) {
      const said = userAnswer.trim().toLowerCase()
      const pick = choices.find((c) => c.toLowerCase() === said)
        ?? choices.find((c) => said && c.toLowerCase().startsWith(said))
        ?? choices.find((c) => said && said.startsWith(c.toLowerCase()))
      if (!pick) return false      // not an answer to THIS panel; let it through
      const driver = this.opts.codexDriver
      if (!driver?.answerConsent) return false
      log.child({ taskId: task.id }).event('codex-consent-answered', { threadId, choice: pick })
      void driver.answerConsent(threadId, pick)
      task.lastUserInputAt = this.clock()
      this.transition(task.id, 'processing')
      return true
    }

    if (!this.surfacedApprovals.has(threadId)) return false
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

    // A FOLLOW-UP IS JUST WHAT THE USER SAID.
    //
    // This used to re-send the whole dispatch payload — status path, recipe
    // path, "Act now, follow the contract" — wrapped around every single
    // sentence the user spoke, for the entire life of the session. The reason
    // given was real at the time: without the re-anchor the model would answer
    // conversationally, never write status, and Unmute would mark it stuck.
    //
    // That reason is gone. The Stop hook now tells us the turn ended and hands
    // us the reply, so there is nothing left to re-anchor the model TO. The
    // plumbing was the load-bearing part of a mechanism that no longer exists,
    // and it was the bloat users saw growing on every turn.
    const payload = buildDispatch({ intent: text })
    // The user's new message appears on the card the instant they send it —
    // whether they spoke it or typed it into the stage composer — rather than
    // only after the turn ends. Replaced by the real transcript on turn-ended.
    task.conversation = [{ role: 'user', text }]

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
    // ONE RESUME AT A TIME. `alive` only turns true once the PTY has spawned, so
    // a second call arriving during the (seconds-long) respawn passed the check
    // above and built a SECOND session — orphaning the first, which nothing then
    // held a handle to. Reachable by double-tapping Resume, and more so now that
    // opening a card resumes it while its Resume button is still on screen.
    if (this.resuming.has(id)) { tlog.event('resume-noop-already-resuming', {}); return true }
    this.resuming.add(id)
    // SAY IT STARTED, BEFORE the seconds-long spawn. The private set above is
    // only a re-entry guard; this is the half the user can see, so the card can
    // show progress and disable its own button instead of looking inert.
    task.resuming = true
    task.resumeError = undefined // a fresh attempt clears the last failure
    this.emit('updated', task)
    tlog.event('resume-start', { cwd: task.cwd, resumeBy: byId ? 'session-id' : 'continue' })
    try {
      // NAME THE BACKEND. This task already has one; the global picker describes
      // only what the user wants NEXT. Omitting it meant flipping the picker to
      // Codex made every existing Claude session unresumable — executorFactory
      // read the picker, threw AGENT_SEPARATION_VIOLATION, and Resume did nothing
      // visible (field report 2026-07-28). The `?? 'claude'` is load-bearing: PTY
      // tasks are stored with NO `agent` key, so absent must mean Claude here and
      // must never fall through to the picker.
      const ex = this.opts.executorFactory(!byId, task.agent ?? 'claude') // --continue only when we can't target the exact session by id
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
        const nudge = buildResumeNudge(task.intent)
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
      const error = (e as Error).message
      tlog.error('resume failed', { error })
      this.hardKill(id)
      // ANNOUNCE IT. Logging alone is what made a broken resume indistinguishable
      // from an unclicked button: the renderer discards the returned boolean
      // (`void api().remoteResume?.(id)`), so this event and `resumeError` are
      // the only ways the user ever learns the session did not come back.
      task.resumeError = error
      task.updatedAt = this.clock()
      this.emit('resume-failed', { taskId: id, error })
      this.emit('updated', task)
      return false
    } finally {
      this.resuming.delete(id)
      // Clear the visible flag on EVERY exit — success, failure or throw — or a
      // card would spin forever on the one path that matters most.
      if (task.resuming) { task.resuming = false; this.emit('updated', task) }
    }
  }

  /**
   * The user OPENED this card — revive a persistent session that isn't running.
   *
   * Quitting Unmute kills every session by design (killAll on before-quit), so a
   * working session comes back on the next launch as a row with a dead PTY. The
   * Resume tap that followed bought nothing: OPENING the card is already the
   * intent, and nobody opens a working session to look at a "session ended"
   * panel. So opening one resumes it.
   *
   * Deliberately narrow, because the cost of being wrong is a spawned process:
   *  • PERSISTENT SESSIONS ONLY. A one-off is opened to READ its result — often
   *    long after it finished, sometimes after its dir was purged (nothing left
   *    to resume anyway) — so it keeps the explicit Resume button.
   *  • EXTERNAL BACKENDS ARE SKIPPED. A Codex thread has no PTY and was never
   *    dead; resume() is a no-op for it (see the guard there).
   *  • ALREADY ALIVE is a no-op, and an in-flight respawn is absorbed by
   *    resume()'s own single-flight guard. Both surfaces re-announce the open on
   *    every reconcile tick, so this is called repeatedly for one gesture and
   *    must stay idempotent.
   *
   * Fire-and-forget: the card is already on screen; it flips from the dead panel
   * to the live terminal when the respawn lands.
   */
  opened(id: string): void {
    const task = this.tasks.get(id)
    if (!task || (task.kind ?? 'oneoff') !== 'session') return
    if (isExternalAgent(task.agent)) return
    if (this.executors.get(id)?.alive) return
    if (this.resuming.has(id)) return
    const tlog = log.child({ taskId: id })
    tlog.event('auto-resume-on-open', {})
    void this.resume(id)
      .then((ok) => { if (!ok) tlog.warn('auto-resume on open did not take', {}) })
      .catch((e) => tlog.error('auto-resume on open threw', { error: (e as Error).message }))
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
    // Per-task Codex poll bookkeeping dies with the task, never during polling:
    // clearing codexLastSeenAt on a live task makes every poll look like the
    // rollout advanced, which silently disables the blocked-turn detection.
    this.codexIdleTicks.delete(id)
    this.codexLastSeenAt.delete(id)
    const unwatch = this.codexWatchers.get(id)
    if (unwatch) { unwatch(); this.codexWatchers.delete(id) }
    // Same for Claude desktop, and for the same reason the Codex leak was
    // fixed: an fs.watch handle outliving its task keeps the event loop alive
    // forever. Omitting this hung the test run with no output at all.
    this.claudeIdleTicks.delete(id)
    this.claudeLastSeenAt.delete(id)
    const unwatchClaude = this.claudeWatchers.get(id)
    if (unwatchClaude) { unwatchClaude(); this.claudeWatchers.delete(id) }
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
