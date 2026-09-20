import { claudeEditPrefix } from './claude/edit-prefix'
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

import { basename, dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { resolveAgentMetadata, isDescriptiveTitle, type AgentMetadata } from './agent/metadata'

import { promises as fs, watch as fsWatch, constants as fsConstants } from 'node:fs'
import { EventEmitter } from 'node:events'
import type { FollowupGate, FollowupRecord, NewTurnOutcome, FollowupTurnEnded } from './task-followup'
import { createLogger, remoteLogDir } from './log'
import { diagnosticError } from './diagnostics'
import { writeFileAtomic } from './atomic-file'
import { reconstructTaskMeta } from './meta-reconstruct'
import { tapPty } from './pty-tap'
import { ReconcileScheduler } from './reconcile-scheduler'
import { AppendFileCache } from './append-file-cache'
import { sessionLifecycleDev } from './session-lifecycle-devlog'

type AgentDispatchMetadata = AgentMetadata & { agentRunId: string }
type DesktopHandoffReceipt = { id: string; before: string[]; metadata: AgentDispatchMetadata; acknowledged: boolean; intent: string; startedAt: number }

// Message editing currently requires a provider fork. Keep the implementation
// available for a future safe rollout, but fail closed until fork identity and
// writer ownership can be made invisible to the user in every failure mode.
const MESSAGE_EDIT_ENABLED = false

function sessionOwnership(meta: Record<string, unknown>): 'unmute' | 'external' | 'unknown' {
  if (meta.importedFromCli || meta.sessionOwnership === 'external') return 'external'
  if (meta.sessionOwnership === 'unmute' || meta.claudeSessionSettings || meta.codexSessionSettings) return 'unmute'
  // Legacy launch receipts carried these fields; legacy adoption receipts did not.
  if (Array.isArray(meta.injectedRecipes) && typeof meta.sessionId === 'string' && typeof meta.lastUserInputAt === 'number') return 'unmute'
  return 'unknown'
}

/** THE SHELF IS GONE; ITS TASKS ARE NOT. A legacy `shelved: true` receipt is
 *  read as "out of the pocket" — the one part of shelving that survives. The
 *  other two parts (hidden from the wall, exempt from purge) are dropped on
 *  purpose: the task is an ordinary orchestrator task from here on. */
function pocketRemovedFromMeta(meta: { pocketRemoved?: boolean; shelved?: boolean }): boolean {
  return meta.pocketRemoved === true || meta.shelved === true
}

/**
 * WHAT AUTO-PURGE NEVER TOUCHES. The Shelf used to be the "keep this" gesture;
 * it is gone, and these two signals carry that meaning instead:
 *   - a persistent SESSION is untouched "by updatedAt" for days by design;
 *   - a task the person RENAMED (nameSetByUser, the rename lock) is one they
 *     said they care about.
 * Everything else is a one-off, retired after purgeAgeMs (3 days) untouched.
 * Pocket membership is deliberately not an input.
 */
export function retentionExempt(t: { kind?: string; nameSetByUser?: boolean }): boolean {
  return t.kind === 'session' || t.nameSetByUser === true
}

/** Tap a task's PTY bytes next to the run logs. No-op unless the tap is on. */
function tapPtyForTask(taskId: string, dir: 'in' | 'out', bytes: Buffer, atMs: number): void {
  const logsDir = remoteLogDir()
  if (logsDir) tapPty(logsDir, taskId, dir, bytes, atMs)
}

/** AN EXCEPTION HERE KILLS THE WHOLE APP, so nothing is allowed to escape.
 *
 *  PTY output arrives through node-pty's thread-safe function: native code calls
 *  into JS, and a throw crossing back over that N-API boundary has nowhere to go
 *  — libc++ calls std::terminate and the process aborts. There is a crash report
 *  in the field with exactly that stack (pty.node → Napi::ThreadSafeFunction →
 *  __cxa_throw → abort, SIGABRT), and when the app dies that way it takes every
 *  running task with it and, before the lifecycle fix, stranded the notch on
 *  screen.
 *
 *  Every consumer of a chunk is bookkeeping — buffers, logs, an emit. None of it
 *  is worth the process, so a failure is recorded and the stream continues. */
function guardPtyCallback(taskId: string, body: () => void): void {
  try {
    body()
  } catch (e) {
    try {
      createLogger('task-manager').error('pty-callback threw — contained', {
        taskId, error: e instanceof Error ? e.message : String(e),
      })
    } catch { /* logging must not be the thing that aborts us either */ }
  }
}
import {
  scaffoldStatusFile,
  writeStatusFile,
  readStatus,
  statusMtimeMs,
  isStale,
  normalizeState,
  type StatusPayload,
  type TaskState,
} from './status-file'
import { buildDispatch } from './dispatch-prompt'
import { detectSurface } from './surface'
import type { GroupRegistry } from './group-registry'
import { deriveStatus, isAnswerable, selfContinuationDelaySeconds, type HookEvent, type AskQuestion } from './observer'
import { readTranscript, hadSideEffects, readLatestExchange, parseTurns } from './transcript'
import type { Block } from './blocks'
import { blocksFromClaudeTranscript } from './blocks-claude'
import { ClaudeTaskSession, type ClaudeTaskOptions } from './claude/task-session'
import { ClaudeTaskChannel } from './claude/task-channel'
import { CLAUDE_RUNTIME_RELEASED } from './runtime/claude-service'
import { CLAUDE_HISTORY_STALE_MARKER, readClaudeHistory, retainClaudeHistoryDisplay } from './claude/chat-history'
import { isDeepStrictEqual } from 'node:util'
import type { TaskInput } from './task-input'
import { blocksFromRollout } from './codex/blocks-rollout'
import { applyBlockUpdates } from './codex/blocks-app-server'

/**
 * Has the chat actually changed?
 *
 * NOT NEWS IS NOT AN UPDATE. These readers run on every poll — once a second
 * for a working task — and re-emitting an identical transcript would re-sort
 * the wall and re-send the whole conversation over the notch pipe at that
 * cadence. Comparing the last block's identity catches appends, which is what
 * a growing conversation is; the length check catches everything else.
 */
function blocksChanged(prev: Block[] | undefined, next: Block[]): boolean {
  if (!prev || prev.length !== next.length) return true
  if (next.length === 0) return false
  return JSON.stringify(prev[prev.length - 1]) !== JSON.stringify(next[next.length - 1])
}
import { browserFor } from './session-policy'
import { detectMcpGap, type McpGap } from './mcp-gap'
import { locateTranscript } from './trace-reducer'
import { findTranscriptById } from './transcript-locate'
import { rollupCodexEvents, conversationFromCodexEvents } from './codex/cli-observer'
import { discoverSessionId, findRollout, isRolloutIntegrityError, parseRolloutJsonl, readRolloutEvents } from './codex/cli-session'
import { rolloutOutcome } from './codex/rollout-settled'
import { projectSlug } from './projects'
import type { Librarian } from './librarian'
import type { AgentExecutor, ExecutorFactory } from './executor'
import { settleRepl } from './repl-settle'
import { type AgentKind, isExternalAgent } from './codex-executor'
import type { CodexDesktopDriver } from './codex/driver'
import type { CodexHub, HubPatch, StartThreadOpts } from './codex/hub'
import type { Activity } from './activity'
import { codexPosture } from './codex/posture'
import { managedPolicy } from './permission-ceiling'
import { ManagedProjects, validateProject, type NewChatOptions, type ChatPreview } from './managed-project'
import { sameQuestion, type QuestionReference, type AnswerContext } from './question-reference'
import type { ClaudeDesktopDriver } from './claude-desktop/driver'
import type { ClaudeDesktopAx, ClaudeSidebarRow } from './claude-desktop/ax'
import { statusForTitle, readState as readAxState, readSidebarRows as readAxSidebar } from './claude-desktop/ax'
import { readCatalog, labelFor, type ClaudeModel } from './claude-desktop/catalog'
import type { ClaudeActuator } from './claude-desktop/actuate'
import type { ClaudeConsent as ClaudeConsentLite } from './claude-desktop/ax'
import { beat, pendingApprovals, expireStaleApprovals, decideApproval, clearApproval, describeApproval, ensureApprovalHook } from './codex/hooks'
import { devEvent } from './curator-devlog'
import { pasteTaskImages } from './task-attachment-paste'
import { pasteDesktopTaskImages } from './desktop-task-attachment-paste'
import {
  beginTaskReplyTrace,
  emitTaskReplyStep,
  type TaskReplyTrace,
} from './task-reply-trace'

/**
 * HOW LONG A FINISHED ONE-OFF KEEPS ITS RUNTIME.
 *
 * Was 15 minutes, and reaching it was a FULL erase. Working across several
 * tasks at once, you look away from one for a quarter of an hour and it is
 * gone — card, status and home directory. Reported after losing real work on
 * 2026-08-30. Fifteen minutes measures how long a PROCESS is worth keeping
 * warm; it says nothing about how long the WORK is worth keeping, and the two
 * were the same number.
 *
 * Twelve hours is a working day: come back after lunch, or after a meeting,
 * and the thing you were doing is still there.
 */
export const DEFAULT_WARM_MS = 12 * 60 * 60_000
/** Longest name a deliberate rename keeps (notch rows are sized for it). */
export const MAX_TASK_NAME = 48

const log = createLogger('task-manager')

// ── UI-facing task state. Adds 'stuck' (PRD §5.3) on top of the file states. ──
export type UiTaskState = TaskState | 'stuck'

export interface Task {
  id: string
  intent: string
  /** Structured provenance for consequential work surfaced by Unmute Agent. */
  origin?: 'unmute-agent'
  /** How this conversation relates to earlier provider work. */
  continuationMode?: 'resume' | 'fork' | 'synthesis' | 'fresh'
  /** Exact provider identities used as background or ancestry. */
  continuationSources?: Array<{ sessionId: string; provider: 'claude' | 'codex' }>
  /** Exact references retained alongside bounded synthesis prose. */
  continuationArtifacts?: Array<{ kind: 'file' | 'url' | 'identifier'; value: string; label?: string }>
  /** Agent confidence in the selected continuation, when recorded. */
  continuationConfidence?: number
  /** Words the Unmute Agent carried INTO this card from elsewhere, appended
   *  one per relay. Distinct from `continuation*`, which says where this
   *  conversation came from: a relay leaves that ancestry untouched and records
   *  only what was brought to it, so the two can never overwrite each other. */
  agentRelays?: Array<{
    at: number
    agentRunId?: string
    sources?: Array<{ sessionId: string; provider: 'claude' | 'codex' }>
    artifacts?: Array<{ kind: 'file' | 'url' | 'identifier'; value: string; label?: string }>
  }>
  /** Durable logical Agent run that produced this card. */
  agentRunId?: string
  /** Short display name for the session (2-5 words), generated async just after
   *  dispatch. The UI shows this instead of the full intent; undefined until it
   *  lands (UI falls back to a truncated intent). */
  name?: string
  /** The name was chosen deliberately (the user renamed it, or the Agent did on
   *  their behalf). Automatic namers — router, late label, Claude Desktop's own
   *  title, session metadata fills — never overwrite a locked name. Persisted. */
  nameSetByUser?: boolean
  /** Claude Code session id pinned for this task (minted at dispatch, passed as
   *  `--session-id`). A stable handle to THE session this task drives — used for
   *  resume, reading Claude's session store, and future orchestration. */
  sessionId: string
  /** Species (Orchestrate). 'oneoff' = an errand with a warm-window idle-kill
   *  and 3-day conversation retirement. Its project survives. 'session' = a persistent working
   *  session (often multi-day, often project-bound): NEVER idle-killed, NEVER
   *  auto-purged — it lives until the user explicitly kills/removes it, and
   *  survives app restarts as interrupted-but-resumable (`--continue` restores
   *  full context). Default 'oneoff' (status quo). */
  kind?: 'oneoff' | 'session'
  /** Explicit keep-alive override. Persistent sessions normally age out of the
   * runtime after a week without user input; a pinned one never does. */
  runtimePinned?: boolean
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
  /** What this task is doing RIGHT NOW (activity.ts). Not a state: it lives
   *  inside `processing` and is cleared the moment the work stops. Held on the
   *  task rather than in the status file because it changes several times a
   *  second and nothing should be written to disk at that rate. */
  codexActivity?: Activity
  codexThreadId?: string
  /** Codex CLI: the rollout/session uuid Codex minted for this task. Learned
   *  after spawn (Codex assigns its own), then pinned — it is both where state
   *  is read from and what `codex resume <id>` takes. */
  codexRolloutId?: string
  /** Present only for sessions created and owned through the structured API. */
  codexSessionSettings?: StartThreadOpts
  managedProjectId?: string
  permissionReason?: string
  /** What the provider actually applied when this machine's policy made it
   *  lower than asked. Reported by the provider on every session start, so it
   *  is never persisted — a stale one would outlive a policy change. */
  permissionLimit?: import('./permission-ceiling').PermissionLimit
  history?: import('./codex/app-server-events').HistoryState
  turnOutcome?: import('./blocks').TurnOutcome
  /** Codex reports its final assistant item before the separate turn-completed
   *  event. Retain that turn-local text so completion can persist a result. */
  currentTurnAssistantText?: string
  mcpStatuses?: import('./codex/app-server-events').McpStatus[]
  questionAcknowledgment?: { reference: QuestionReference; state: 'pending' | 'accepted' }
  claudeSessionSettings?: Pick<ClaudeTaskOptions, 'model' | 'effort' | 'permissionMode' | 'addDirs' | 'chrome'>
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
  /** THE CHAT VIEW. Every provider maps its own source into this one
   *  vocabulary — spec 2026-08-16-chat-view-blocks. `conversation` above stays
   *  only for tasks rehydrated from a meta.json written before the upgrade. */
  blocks?: Block[]
  /** Runtime-only, never persisted: whether `blocks` is the durable
   *  conversation or a reattached channel's replay tail. A tail is
   *  indistinguishable from a short chat by its blocks alone. */
  blocksDurable?: boolean
  /** An empty GUI conversation has not submitted a provider turn yet. */
  chatUnstarted?: boolean
  claudeForkFromSessionId?: string
  claudeResumeSessionAt?: string
  importedFromCli?: boolean
  sessionOwnership?: 'unmute' | 'external' | 'unknown'
  /** Token usage for the panel footer, when the provider reports it. */
  usage?: { used: number; window: number; rateLimitPercent?: number; resetsAt?: number }
  /**
   * The agent has POSITIVELY been seen to receive the intent - a rollout turn,
   * a prompt-submitted hook, or a transcript turn.
   *
   * `task-dispatched` only ever meant "we typed it". Whether it ARRIVED was
   * never checked, and on 2026-08-28 the difference mattered: the words were
   * typed, Codex ran `npm install -g @openai/codex` instead, and exited twelve
   * seconds later having never shown them to a model.
   *
   * This flag is what makes retrying safe. Re-sending something the agent
   * already acted on could repeat a side effect; re-sending something it
   * provably never saw cannot.
   */
  deliveryProven?: boolean
  /** How many times the intent has been sent again after a proven non-delivery. */
  redeliveries?: number
  /**
   * The router never classified this task — it is the failsafe's output.
   *
   * The title is the raw transcript and there is no group, because no decision
   * was ever made about it. Surfacing that is the difference between "routing
   * failed" and "grouping is broken", which are indistinguishable on a card and
   * have been confused twice.
   */
  unrouted?: boolean
  /** Workspace group LABEL — "what is this work about" ("unmute", "launch
   *  video", "on-call"). What every surface renders. Derived from `groupId`;
   *  never the identity. */
  group?: string
  /**
   * The group registry entry this task is filed under — the identity.
   *
   * Spec 2026-07-16 §2 made the screen the entire state: live groups were the
   * distinct label strings across live tasks, with no registry and no history.
   * That is what re-minted a stream's name every time it went quiet, and what
   * let one stream become "unmute", "unmute cloud" and "unmute AI".
   *
   * Assign-once still holds (§5): the router files a task at dispatch or at the
   * follow-up that graduates it, and after that only the user moves it. What
   * changed is only the vocabulary underneath — it now persists.
   *
   * Absent on tasks written before the registry; `rehydrate` resolves their
   * label into an entry on first load.
   */
  groupId?: string
  /** Receipt is staged until native continuation establishes its identity. */
  continuationPending?: boolean
  state: UiTaskState
  createdAt: number
  updatedAt: number
  /** Where the agent runs: a durable managed project or an existing selected
   *  folder. Legacy tasks may run inside home; either location is retained. */
  cwd: string
  /** Session receipt location. Legacy homes can contain deliverables, nested
   *  projects, or symlinks to them. Conversation removal must not delete it. */
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
  /** The ask currently open on this task, keyed by the id that will close it.
   *  Held because answering needs the SHAPE — which option is at which index —
   *  and verification needs the labels to compare against what registered. */
  openAsk?: { id: string; questions: AskQuestion[]; answeredWith?: string }
  /** When the session last told us a prompt actually SUBMITTED (UserPromptSubmit
   *  hook). The signal verifyDispatch waits for — a real event now, not a marker
   *  file's mtime, so it works in project-bound sessions too. */
  promptSubmittedAt?: number
  /** Executor self-classification (drives presentation + lifecycle). */
  category?: StatusPayload['category']
  /** This turn's `done` is a scheduled pause (the loop is about to re-prompt
   *  itself), not a real stop — see selfContinuationDelaySeconds(). Sessions
   *  in an autonomous multi-task run flip done→processing every turn boundary
   *  that hooks alone cannot tell apart from actually finishing; this is the
   *  flag that lets the notch stop treating each one as news. Cleared the
   *  moment a new prompt is submitted, never persisted — recomputed fresh
   *  every turn. */
  checkpoint?: boolean
  /** When this checkpoint's own promised wakeup should have arrived by — the
   *  tool call's `delaySeconds` plus grace, added to this.clock() at the
   *  moment the turn ended. Past this with no new prompt means the loop's own
   *  continuation never happened (app quit, crashed, lost); demanding() must
   *  stop trusting `checkpoint` once this passes, or a truly abandoned
   *  session goes silent forever instead of eventually re-flagging like any
   *  other stuck task. */
  checkpointExpiresAt?: number
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
  /** REMOVED FROM THE POCKET, and nothing else. The task keeps running and
   *  stays in the orchestrator exactly as before — wall grid, rail, retention
   *  all ignore this. It only keeps the card out of the notch's pocket until
   *  the task needs the person again, is opened, or is sent input (see
   *  setInPocket). Replaces the old `shelved`, which also hid the task from
   *  the wall and exempted it from purge; meta.json's legacy `shelved: true`
   *  is read as this on rehydrate. */
  pocketRemoved?: boolean
  /** User's free-form note pinned to the card (ticket link, context, a reminder
   *  to future-you). Pure annotation — never fed to the agent. */
  note?: string
  /** Provenance: the task id that spawned this one via the Unmute MCP (agent-
   *  created). Drives the card's "agent-spawned" chip and the depth-1 rule
   *  (a spawned task may not spawn). Undefined = human-created. */
  spawnedBy?: string
}

export interface TaskManagerOpts {
  /** Session-scoped credentials/configuration, rebuilt on resume; never persisted. */
  claudeSessionOptions?: (task: Task) => Promise<Omit<ClaudeTaskOptions, 'onEvent' | 'resume'>>
  /** Extra directories this task's Claude must be able to read — the slash
   *  menu's bridge, resolved per cwd. Failure is never fatal: a chat without
   *  the other provider's skills still runs its own. */
  claudeSkillDirs?: (task: Task) => Promise<string[]>
  claudeTaskFactory?: (options: ClaudeTaskOptions, task: Task) => ClaudeTaskSession
  claudeChoice?: (context?: { cwd: string; home: string; managedProjectId?: string }) => NonNullable<Task['claudeSessionSettings']>
  /** Creates a fresh executor per task (default: ClaudeCodeExecutor). */
  executorFactory: ExecutorFactory
  /** The durable vocabulary of workspace streams (group-registry.ts). Absent ⇒
   *  grouping degrades to bare labels, exactly as it behaved before the
   *  registry existed — metadata, never a gate. */
  groupRegistry?: GroupRegistry
  /** The user's path fence, as the Remote screen holds it. Read per dispatch so
   *  a task started after the setting changed honours the new value. Absent ⇒
   *  unfenced. */
  sandboxRoots?: () => string[]
  /** Has the user consented to full-access Codex CLI tasks? Absent ⇒ no. */
  codexFullAccess?: () => boolean
  /** Resolves a Codex thread id to its rollout file. Default: the ~/.codex
   *  sessions lookup. Injected so orphan recovery can be tested without
   *  depending on a real home directory. */
  rolloutPathFor?: (threadId: string) => Promise<string | null>
  /**
   * Codex CLI's chosen model and effort as WIRE VALUES.
   *
   * SEPARATE FROM `opts.model`, which is the display record ("gpt-5.6-luna
   * high") stamped at dispatch so a card can say what it ran on. Passing that
   * string to `thread/start` sent Codex a model literally named
   * "gpt-5.6-luna high" and every task died with
   *   "The 'gpt-5.6-luna high' model is not supported when using Codex with a
   *    ChatGPT account."
   * One value cannot be both a sentence and an id.
   */
  codexCliChoice?: () => { model?: string; effort?: string }
  /** The Codex CLI App Server hub. Absent ⇒ Codex CLI tasks fall back to the
   *  PTY + rollout path, which is what shipped before the protocol client and
   *  is kept so a Codex too old for `app-server` still runs. */
  codexHub?: CodexHub
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
  /** Slow correctness fallback while a task is actively producing events. */
  activeReconcileMs?: number
  /** Runtime liveness fallback for an attached but idle persistent session. */
  idleRuntimeReconcileMs?: number
  /** Fallback for a settled conversation owned by another desktop app. */
  dormantReconcileMs?: number
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
  /** Auto-purge: a task untouched (by updatedAt) for this long is retired on
   *  the maintenance sweep — session stopped, row hidden, project bytes retained.
   *  Keeps the user from accumulating hundreds of Unmute-spun Claude/tmux sessions.
   *  NEVER touches ~/.claude (Claude cleans its own transcripts on its own clock).
   *  Sessions and renamed tasks are exempt (retentionExempt). Default 3 days —
   *  long enough that yesterday's errand is still there tomorrow. */
  purgeAgeMs?: number
  /** How often the maintenance sweep runs. Default 1h. */
  purgeSweepMs?: number
  /** Runtime-only retention for an unpinned persistent session. Its task card
   * remains after expiry and can be resumed normally. Default seven days. */
  persistentIdleMs?: number
  /** Best-effort reaper for an ORPHAN tmux session left by a past run (the app
   *  crashed/quit without killing it). Wired from init.ts (which owns the tmux
   *  bin + private socket). Omitted in tests. */
  reapSession?: (taskId: string) => void
  /** Runtime liveness registry. A persisted task is only reattached when its
   * id is present here; historical tickets remain visible and resumable. */
  listLiveRuntimeIds?: () => Promise<ReadonlySet<string>>
  /** The true cwd of a Claude session, by id — the recovery half of resume().
   *  Injected so this module stays free of the transcript layout. */
  resolveSessionCwd?: (sessionId: string) => Promise<string | null>
  /** clock + sleep injectable for tests. */
  now?: () => number
}

type TaskEvent = 'created' | 'updated' | 'needs-user' | 'stuck' | 'done' | 'failed' | 'removed'

/** Turn-over states: the session is parked, polling stopped, ball not with the
 *  agent. 'ready' = ball explicitly WITH THE USER (a checkpoint awaiting their
 *  direction) — parked like done, but queued as "your move" in the UI. */
const TERMINAL: UiTaskState[] = ['done', 'failed']
/** Fully settled — kill() has nothing to mark, the librarian has been handed
 *  off, nothing awaits anyone. NOT 'ready' (killing a ready task must mark it
 *  stopped, or a dead task would sit in the your-move queue forever). */
const SETTLED: UiTaskState[] = ['done', 'failed']

/** Slack added on top of a self-continuation tool call's own `delaySeconds`
 *  before its checkpoint expires — scheduling jitter, not a second policy
 *  decision. The loop's own number is the real budget; this just keeps a
 *  wakeup landing one second late from being treated as abandoned. */
const CHECKPOINT_GRACE_MS = 60_000

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

/**
 * How long a message waits for a busy chat session before giving up.
 *
 * Long enough to outlast a real turn that is nearly done, and far longer than
 * the tens of milliseconds a reconnect raises `busy` for. The draft is never
 * lost either way — this only decides whether it lands by itself or waits for
 * you to press send.
 */
const CHAT_BUSY_WAIT_MS = 120_000

export class TaskManager extends EventEmitter {
  private followupGenerations = new WeakMap<ClaudeTaskSession, number>()
  private followupNextGeneration = 0
  followupScope(id: string): { provider: 'claude' | 'codex'; sessionId: string } | undefined {
    const t = this.tasks.get(id)
    if (!t || t.origin === 'unmute-agent' || t.sessionOwnership !== 'unmute' || t.importedFromCli || !t.sessionId) return undefined
    if (t.claudeSessionSettings) return { provider: 'claude', sessionId: t.sessionId }
    if (t.codexSessionSettings) return { provider: 'codex', sessionId: t.codexRolloutId ?? t.sessionId }
    return undefined
  }
  followupGate(id: string): FollowupGate {
    const scope = this.followupScope(id), task = this.tasks.get(id)
    if (!scope || !task || this.shuttingDown) return { kind: 'unavailable', reason: 'This task is not an owned chat.' }
    if (task.chatUnstarted) return { kind: 'idle', sessionId: scope.sessionId, generation: 0, blocked: false }
    if ((task.claudeSessionSettings?.permissionMode === 'bypassPermissions' || task.codexSessionSettings?.sandbox === 'danger-full-access') && !this.chatFullAccessAllowed(id)) return { kind: 'unavailable', reason: 'Session permissions exceed the current policy.' }
    if (scope.provider === 'codex') return this.opts.codexHub?.followupGate(id) ?? { kind: 'unavailable', reason: 'Codex is unavailable.' }
    const r = this.claudeTasks.get(id)
    if (!r || r.driver.followupUnavailable) return { kind: 'unavailable', reason: 'Claude is connecting or its acceptance is uncertain. Reconnect before sending.' }
    const generation = this.followupGenerations.get(r.driver) ?? 0, blocked = !!r.channel.pending || r.driver.followupBlocked
    return r.driver.activeSubmissionId ? { kind: 'active', fence: { sessionId: scope.sessionId, generation, turnId: r.driver.activeSubmissionId }, blocked }
      : { kind: 'idle', sessionId: scope.sessionId, generation, blocked }
  }
  async deliverQueuedDraft(id: string, record: FollowupRecord, expected: { sessionId: string; generation: number }): Promise<NewTurnOutcome> {
    const gate = this.followupGate(id), scope = this.followupScope(id), task = this.tasks.get(id)
    if (!task || !scope || scope.sessionId !== record.sessionId || scope.provider !== record.provider || gate.kind !== 'idle' || gate.blocked
      || gate.sessionId !== expected.sessionId || gate.generation !== expected.generation) return { kind: 'not-sent', reason: 'The conversation changed. Follow-up saved.' }
    const text = record.input.flatMap(p => p.type === 'text' ? [p.text] : []).join('')
    let result: NewTurnOutcome
    if (scope.provider === 'codex') result = await this.opts.codexHub!.sendNewTurn(id, text, record.input, expected)
    else {
      const r = this.claudeTasks.get(id)!, submissionId = record.attemptId ?? randomUUID()
      r.channel.expectSubmission(submissionId, record.input)
      result = await r.driver.sendNewTurn(text, record.input.flatMap(p => p.type === 'image' ? [p.path] : []), submissionId, record.input)
    }
    if (result.kind === 'accepted') { this.noteUserInput(task, 'queued-chat-send'); this.noteFollowUp(task); task.deliveryError = undefined }
    else task.deliveryError = result.reason
    this.emit('updated', task)
    return result
  }
  private tasks = new Map<string, Task>()
  private claudeTasks = new Map<string, { driver: ClaudeTaskSession; channel: ClaudeTaskChannel }>()
  private claudeHistoryWrites = new Map<string, Promise<void>>()
  private claudeStarting = new Map<string, Promise<void>>()
  private chatStopVersion = new Map<string, number>()
  /** Tasks the user explicitly stopped, holding a one-shot claim on the next
   *  terminal state they reach. See transition(). */
  private stoppedByUser = new Set<string>()
  private executors = new Map<string, AgentExecutor>()
  /** One heartbeat for every task. Provider events use trigger() and the
   * heartbeat only repairs missed events / sleep gaps. */
  private readonly scheduler: ReconcileScheduler
  /** Provider transcript bytes are read once, then only the appended suffix. */
  private readonly transcriptFiles = new AppendFileCache()
  // Idle-kill timers for WARM sessions (kept alive after done for follow-ups).
  private warmTimers = new Map<string, ReturnType<typeof setTimeout>>()
  // Background auto-purge sweep (null until startMaintenance()).
  /** Set once shutdown() begins. Every PTY we then kill emits an exit, and
   *  without this each one would look like a delivery failure worth retrying —
   *  so quitting the app would spawn a fresh CLI per live session on the way
   *  out. Shutting down is not a delivery failure. */
  private shuttingDown = false
  private purgeTimer: ReturnType<typeof setInterval> | null = null
  // Codex approval inbox sweep (null until startMaintenance()).
  private approvalTimer: ReturnType<typeof setInterval> | null = null
  // Claude Desktop adoption sweep (null until startMaintenance()).
  private claudeAdoptTimer: ReturnType<typeof setInterval> | null = null
  /** threadId → the request we have already surfaced, so we transition once. */
  private surfacedApprovals = new Map<string, number>()
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
  private claudeLastSeenAt = new Map<string, number>()
  private claudeWatchers = new Map<string, () => void>()
  /** CLI transcript watcher disposers. They are latency shortcuts only; the
   * shared scheduler remains the missed-event and sleep/wake backstop. */
  private transcriptWatchers = new Map<string, { path: string; stop: () => void }>()
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
  private opening = new Set<string>()
  private autoResumeFailedAt = new Map<string, number>()
  private startupRecovery: Promise<void> = Promise.resolve()
  private static readonly AUTO_RESUME_COOLDOWN_MS = 5_000
  // Per-task chain serializing meta.json read-modify-writes. Two concurrent
  // merges (e.g. setInPocket + setNote in one tick) would otherwise race the
  // read and the last write would silently drop the other's field.
  private metaChains = new Map<string, Promise<void>>()
  // Per-task ring buffer of recent PTY output for render-on-demand (PRD §13.4#8).
  private outputBuffers = new Map<string, string>()
  private static readonly OUTPUT_CAP = 200_000 // chars kept per task
  private readonly opts:
    Required<Omit<TaskManagerOpts, 'claudeSessionOptions' | 'claudeSkillDirs' | 'claudeTaskFactory' | 'claudeChoice' | 'userKey' | 'now' | 'librarian' | 'reapSession' | 'listLiveRuntimeIds' | 'codexDriver' | 'claudeDesktopDriver' | 'claudeDesktopAx' | 'claudeActuator' | 'permissionMode' | 'codexReasoning' | 'resolveSessionCwd' | 'codexHub' | 'sandboxRoots' | 'codexFullAccess' | 'codexCliChoice' | 'groupRegistry'>> &
    Pick<TaskManagerOpts, 'claudeSessionOptions' | 'claudeSkillDirs' | 'claudeTaskFactory' | 'claudeChoice' | 'userKey' | 'now' | 'librarian' | 'reapSession' | 'listLiveRuntimeIds' | 'codexDriver' | 'claudeDesktopDriver' | 'claudeDesktopAx' | 'claudeActuator' | 'permissionMode' | 'codexReasoning' | 'resolveSessionCwd' | 'codexHub' | 'sandboxRoots' | 'codexFullAccess' | 'codexCliChoice' | 'groupRegistry'>

  constructor(opts: TaskManagerOpts) {
    super()
    opts.codexHub?.onFollowup?.(e => {
      if (!this.followupScope(e.type === 'ended' ? e.event.taskId : e.taskId)) return
      if (e.type === 'ended') this.emit('followup-turn-ended', e.event)
      else this.emit(e.type === 'disarm' ? 'followup-disarm' : 'followup-ready', { taskId: e.taskId })
    })
    this.opts = {
      executorFactory: opts.executorFactory,
      claudeSessionOptions: opts.claudeSessionOptions,
      claudeSkillDirs: opts.claudeSkillDirs,
      claudeTaskFactory: opts.claudeTaskFactory,
      claudeChoice: opts.claudeChoice,
      codexHub: opts.codexHub,
      sandboxRoots: opts.sandboxRoots,
      codexFullAccess: opts.codexFullAccess,
      codexCliChoice: opts.codexCliChoice,
      rolloutPathFor: opts.rolloutPathFor ?? findRollout,
      groupRegistry: opts.groupRegistry,
      baseDir: opts.baseDir ?? join(homedir(), '.unmute', 'remote'),
      pollMs: opts.pollMs ?? 1000,
      activeReconcileMs: opts.activeReconcileMs ?? (opts.pollMs !== undefined ? opts.pollMs : 30_000),
      idleRuntimeReconcileMs: opts.idleRuntimeReconcileMs ?? (opts.pollMs !== undefined ? opts.pollMs : 60_000),
      dormantReconcileMs: opts.dormantReconcileMs ?? (opts.pollMs !== undefined ? opts.pollMs : 5 * 60_000),
      resolveSessionCwd: opts.resolveSessionCwd,
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
      warmMs: opts.warmMs ?? DEFAULT_WARM_MS,
      navigateWarmMs: opts.navigateWarmMs ?? 8 * 60_000,
      detachGraceMs: opts.detachGraceMs ?? 1500,
      purgeAgeMs: opts.purgeAgeMs ?? 3 * 24 * 60 * 60_000, // 3 days
      purgeSweepMs: opts.purgeSweepMs ?? 60 * 60_000,  // hourly
      persistentIdleMs: opts.persistentIdleMs ?? 7 * 24 * 60 * 60_000,
      approvalSweepMs: opts.approvalSweepMs ?? 1500,
      userKey: opts.userKey ?? 'local',
      librarian: opts.librarian,
      codexDriver: opts.codexDriver,
      claudeDesktopDriver: opts.claudeDesktopDriver,
      claudeDesktopAx: opts.claudeDesktopAx,
      claudeActuator: opts.claudeActuator,
      permissionMode: opts.permissionMode,
      codexReasoning: opts.codexReasoning,
      reapSession: opts.reapSession,
      listLiveRuntimeIds: opts.listLiveRuntimeIds,
      now: opts.now,
    }
    this.scheduler = new ReconcileScheduler({
      tickMs: Math.min(this.opts.pollMs, 1_000),
      onError: (id, error) => this.handlePollError(id, error),
    })
  }

  /** Fence user-driven auto-resume until startup has reconciled durable
   * runtime ownership and provider identities. Returns an idempotent release. */
  beginStartupRecovery(): () => void {
    let release!: () => void
    let released = false
    this.startupRecovery = new Promise<void>(resolve => { release = resolve })
    log.event('startup-recovery-barrier-armed', {})
    sessionLifecycleDev('startup-barrier-armed')
    return () => {
      if (released) return
      released = true
      log.event('startup-recovery-barrier-released', {})
      sessionLifecycleDev('startup-barrier-released')
      release()
    }
  }

  /**
   * The session's process went away.
   *
   * TERMINAL STATES ARE FINAL. A normal task ends with the agent reporting done
   * and the REPL being torn down a moment later, so treating every exit as a
   * failure would turn every success into one at shutdown. Only a task still
   * mid-flight - nothing reported, no result - is failed here.
   *
   * The exit code travels into `detail` because 0 and non-zero mean genuinely
   * different things: 0 is the CLI choosing to quit (a menu selection, an
   * update chooser), non-zero is it falling over. Both look identical on a card
   * that only says "failed".
   */
  /** The session was seen to receive the intent. Public so the proof can also
   *  arrive from the hook/observer side, not only from the poller. */
  noteDeliveryProven(id: string, via: string): void {
    const task = this.tasks.get(id)
    if (!task || task.deliveryProven) return
    task.deliveryProven = true
    log.child({ taskId: id }).event('delivery-proven', { via })
    this.mergeMeta(task, { deliveryProven: true }, 'noteDeliveryProven')
  }

  /**
   * Watch for evidence that the turn actually started.
   *
   * Non-blocking on purpose: dispatch must stay fast, and this is only ever
   * used to decide whether a LATER death is recoverable. Both backends already
   * write the proof for their own reasons - Codex a rollout turn, Claude a
   * transcript turn plus the prompt-submitted hook - so nothing is being asked
   * of the agent that it was not already doing.
   */
  private proveDelivery(id: string): void {
    const task = this.tasks.get(id)
    if (!task) return
    void (async () => {
      // MEASURED, NOT GUESSED. A field dispatch (2026-08-28 08:18) pinned its
      // rollout at t+11s - one second after this window originally closed. A
      // prover that gives up just before the evidence lands is worse than no
      // prover at all: every task reads "unproven", so a later death re-sends
      // work that had in fact started. The window is now generous and the loop
      // also stops the moment the task reaches a terminal state, so a long
      // window costs nothing on the happy path.
      const deadline = Date.now() + Math.max(this.opts.verifyAfterMs, 120_000)
      const rolloutBefore = task.agent === 'codex' ? await this.codexUserTurns(task).catch(() => 0) : null
      const claudeBefore = rolloutBefore === null ? await this.claudeUserTurns(task).catch(() => 0) : null
      const submittedBefore = task.promptSubmittedAt ?? 0
      while (Date.now() < deadline) {
        const live = this.tasks.get(id)
        if (!live || live.deliveryProven || TERMINAL.includes(live.state)) return
        if (rolloutBefore !== null) {
          if ((await this.codexUserTurns(live).catch(() => 0)) > rolloutBefore) {
            return this.noteDeliveryProven(id, 'codex-rollout')
          }
        } else {
          if ((live.promptSubmittedAt ?? 0) > submittedBefore) return this.noteDeliveryProven(id, 'prompt-submitted-hook')
          if (claudeBefore !== null && (await this.claudeUserTurns(live).catch(() => 0)) > claudeBefore) {
            return this.noteDeliveryProven(id, 'claude-transcript')
          }
        }
        // UNREF'D: a prover must never be the reason the process stays alive.
        // It is bookkeeping about a task, not work the user is waiting on.
        await new Promise((r) => { const t = setTimeout(r, 300); (t as { unref?: () => void }).unref?.() })
      }
    })()
  }

  /** How many times an unproven intent may be sent again before we admit defeat.
   *  Small: a CLI that dies three times is broken, not unlucky. */
  private static readonly MAX_REDELIVERIES = 2

  /**
   * Send the user's words again, into a fresh session, keeping the same card.
   *
   * The intent has been on disk since task-created - this has never been a
   * data-loss problem, only a delivery one. All that was missing was something
   * to notice the delivery failed and try again.
   */
  private redeliver(id: string): void {
    const task = this.tasks.get(id)
    if (!task) return
    const tlog = log.child({ taskId: id })
    const attempt = (task.redeliveries ?? 0) + 1
    task.redeliveries = attempt
    tlog.warn('intent never reached the agent - sending it again', { attempt })
    void (async () => {
      try {
        const ex = this.opts.executorFactory(false, task.agent ?? 'claude')
        this.executors.set(id, ex)
        this.outputBuffers.set(id, '')
        ex.onData((chunk) => guardPtyCallback(id, () => {
          const prev = this.outputBuffers.get(id) ?? ''
          this.outputBuffers.set(id, (prev + chunk).slice(-TaskManager.OUTPUT_CAP))
          this.emit('output', id, chunk)
        }))
        ex.onExit?.(({ exitCode }) => this.onSessionExit(id, exitCode))
        await ex.spawn({ cwd: task.cwd, env: process.env, taskId: id, sessionId: task.sessionId })
        await ex.isReady()
        if (this.opts.trustAcceptMs > 0) {
          await settleRepl({
            agent: task.agent ?? 'claude',
            getOutput: () => this.outputBuffers.get(id) ?? '',
            isAlive: () => ex.alive,
            sendEnter: () => ex.write('\r'),
            sendRaw: (input) => ex.write(input),
            onEvent: (event, fields) => tlog.event(event, fields),
          })
        }
        if (!ex.alive) throw new Error('CLI exited again before the intent could be sent')
        ex.writeStdin(buildDispatch({ intent: task.intent }))
        tlog.event('intent-redelivered', { attempt })
        this.proveDelivery(id)
        this.startPolling(id)
      } catch (e) {
        tlog.warn('re-delivery failed', { attempt, error: (e as Error).message })
        this.transition(id, 'failed', {
          state: 'failed',
          error: {
            reason: 'The agent never received the request',
            detail: `The session ended before your words reached it, and ${attempt} attempt(s) to send them again also failed.`,
          },
        })
      }
    })()
  }

  private onSessionExit(id: string, exitCode: number): void {
    const task = this.tasks.get(id)
    if (!task) return
    if (TERMINAL.includes(task.state)) return
    // Quitting kills every live PTY. None of those deaths is a delivery
    // failure, and re-delivering during teardown would start processes as the
    // app is trying to stop.
    if (this.shuttingDown) return
    // NEVER SEEN THE WORDS? THEN SENDING THEM AGAIN IS SAFE.
    //
    // The asymmetry is the whole design: a duplicated side effect is far worse
    // than a task you have to re-say, so retrying requires POSITIVE evidence
    // that nothing landed. With that evidence, the death is recoverable and the
    // user should never even know it happened.
    if (!task.deliveryProven && (task.redeliveries ?? 0) < TaskManager.MAX_REDELIVERIES) {
      log.child({ taskId: id }).warn('session exited before delivery was proven', { exitCode })
      return this.redeliver(id)
    }
    log.child({ taskId: id }).warn('session exited mid-task', { exitCode, state: task.state })
    this.transition(id, 'failed', {
      state: 'failed',
      error: {
        reason: exitCode === 0
          ? 'The agent exited before finishing'
          : 'The agent crashed before finishing',
        detail: `The CLI process ended (exit code ${exitCode}) while the task was still ${task.state}.`,
      },
    })
  }

  private clock(): number {
    return this.opts.now ? this.opts.now() : Date.now()
  }

  list(): Task[] {
    return [...this.tasks.values()].filter(t => !t.continuationPending).sort((a, b) => b.createdAt - a.createdAt)
  }

  override emit(event: string | symbol, ...args: any[]): boolean {
    if ((event === 'created' || event === 'updated') && args[0]?.continuationPending) return false
    return super.emit(event, ...args)
  }

  get(id: string): Task | undefined {
    return this.tasks.get(id)
  }

  /** Repair immediately after app activation or system wake. Provider events
   * remain primary; this closes the known gap where fs.watch coalesces changes
   * while macOS is asleep. */
  reconcileNow(id?: string): void {
    if (id) {
      this.scheduler.trigger(id)
      return
    }
    for (const taskId of this.scheduler.keys()) this.scheduler.trigger(taskId)
  }

  /** Recent buffered PTY output for a task (render-on-demand, PRD §13.4#8). */
  getOutput(id: string): string {
    return this.outputBuffers.get(id) ?? ''
  }

  /** Active = not yet terminal (drives the ambient "N running" count, PRD §13.2). */
  activeCount(): number {
    return [...this.tasks.values()].filter((t) => !TERMINAL.includes(t.state)).length
  }

  /** Is this task's session actually alive right now (PTY / persistent runtime)?
   *  The Agent needs this to tell an open conversation from a card that merely
   *  still exists: a live session takes a follow-up as it is and never needs
   *  resuming. */
  isLive(id: string): boolean {
    if (this.executors.get(id)?.alive === true) return true
    // A CHAT SESSION HAS NO PTY, AND IS NOT DEAD FOR LACKING ONE.
    //
    // `executors` holds terminal-hosted sessions; a graphical chat lives in
    // `claudeTasks`/the codex hub and is connected on demand by deliverDraft.
    // Answering false for those made every chat resume wait out the caller's
    // full 20-second liveness poll and then try to deliver in what was left —
    // which is how a 1,932-character follow-up ended up parked in a composer
    // on 2026-09-08 while the session it was meant for was perfectly reachable.
    const task = this.tasks.get(id)
    return !!(task && (task.claudeSessionSettings || task.codexSessionSettings))
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
  /**
   * WHICH DISPATCH DOES THIS BACKEND USE — a table, not a chain of ifs.
   *
   * Four backends now start work four different ways: a driven app, a driven
   * window, a JSON-RPC thread, an owned PTY. Written as `if (agent === X)
   * … else if (agent === Y) …`, the FALL-THROUGH is the answer for anything
   * unlisted — and the fall-through here builds a Claude PTY. So the failure
   * mode of forgetting a backend is not an error, it is silently running the
   * user's work on the wrong agent, which is exactly what happened on
   * 2026-07-25.
   *
   * A table makes "unlisted" mean `undefined`, and `undefined` takes the PTY
   * path deliberately rather than accidentally. `null` marks a backend that
   * shares the PTY path on purpose.
   */
  private dispatchRoute(agent: AgentKind | undefined):
    ((intent: string, opts: Parameters<TaskManager['dispatch']>[1]) => Promise<string>) | null {
    switch (agent) {
      case 'claude-code-desktop':
        return async (intent, opts) => {
          if (opts?.attachments?.length) throw new Error('ATTACHMENT_DELIVERY_UNAVAILABLE: claude-desktop')
          const res = await this.createClaudeDesktop(intent, { agentMetadata: opts?.agentMetadata })
          if (!res.ok) throw new Error(`CLAUDE_DESKTOP_UNAVAILABLE: ${res.reason ?? 'unknown'}`)
          if (res.id) return res.id
          // Created, but the store had not written it yet. The work HAS started
          // — saying otherwise is what produced a duplicate run on the Codex
          // side — so surface a typed reason rather than a false failure.
          throw new Error('CLAUDE_DESKTOP_ID_UNRESOLVED')
        }
      case 'codex-desktop':
        return (intent, opts) => this.dispatchCodexDesktop(intent, opts ?? {})
      case 'codex':
        return (intent, opts) => this.dispatchCodexCli(intent, opts ?? {})
      case 'claude':
      case undefined:
        return this.opts.claudeSessionOptions ? (intent, opts) => this.dispatchClaudeChat(intent, opts ?? {}) : null
      default: {
        // A backend in the registry with no route. Loud, because the
        // alternative is running it as Claude.
        const exhaustive: never = agent
        log.error('dispatch: no route for backend', { agent: exhaustive })
        return null
      }
    }
  }

  /** Providers whose own report showed this machine forbids full access. */
  private fullAccessForbiddenOnMachine = new Set<'codex' | 'claude'>()
  /** True when THIS MACHINE (not Unmute's consent or fence) forbids full access
   *  for a provider: its managed policy files say so, or the provider already
   *  applied less than full access here. Asking for full access still asks for
   *  the most allowed; this only decides what the controls may claim. */
  machineForbidsFullAccess(provider: string): boolean {
    const policy = managedPolicy()
    if (provider === 'codex') return policy.codexFullAccessForbidden || this.fullAccessForbiddenOnMachine.has('codex')
    if (provider === 'claude') return policy.claudeBypassForbidden || this.fullAccessForbiddenOnMachine.has('claude')
    return false
  }
  private managedProjects?: ManagedProjects
  private projects(): ManagedProjects {
    return this.managedProjects ??= new ManagedProjects(join(this.opts.baseDir, '.managed-projects', this.opts.userKey ?? 'local'))
  }

  newChatPolicy(provider: 'claude' | 'codex', permission?: string) {
    const roots = (this.opts.sandboxRoots?.() ?? []).filter(r => r.trim())
    const fullAllowed = this.providerFullAccessAllowed(provider)
    if (permission && !['maximum', 'full', 'ask', ...(provider === 'claude' ? ['plan'] : ['read'])].includes(permission)) throw new Error('Unsupported session permission')
    if (permission === 'full' && !fullAllowed) throw new Error('Full access exceeds the configured roots or Codex consent cap')
    const maximum = !permission || permission === 'maximum' || permission === 'full'
    const posture = codexPosture({ permissionMode: maximum ? 'auto-approve' : 'prompt', sandboxRoots: roots, fullAccessAllowed: this.opts.codexFullAccess?.() === true })
    const machineCapped = maximum && fullAllowed && this.machineForbidsFullAccess(provider)
    return {
      permission: maximum ? fullAllowed ? 'full' : provider === 'codex' ? 'workspace' : 'ask' : permission!,
      permissionReason: maximum && !fullAllowed ? roots.length ? 'Full access is limited by the configured sandbox roots.' : 'Full filesystem access requires Codex full-access consent; this session can work in its workspace without approval prompts.'
        : machineCapped ? `Your organization does not allow full access for ${provider === 'codex' ? 'Codex' : 'Claude'} on this Mac; the session uses the most it allows.` : undefined,
      claude: { permissionMode: (permission === 'plan' ? 'plan' : maximum && fullAllowed ? 'bypassPermissions' : 'manual') as NonNullable<Task['claudeSessionSettings']>['permissionMode'], addDirs: roots },
      codex: { approvalPolicy: posture.approvalPolicy, sandbox: permission === 'read' ? 'read-only' : posture.sandbox, writableRoots: posture.addDirs },
    }
  }

  async previewChat(options: NewChatOptions): Promise<ChatPreview> {
    if (!['claude', 'codex'].includes(options.provider)) throw new Error('Unsupported conversation provider')
    const allocation = await this.projects().preview(options.provider)
    const policy = this.newChatPolicy(options.provider, options.permission)
    return { ...allocation, permission: policy.permission, permissionReason: policy.permissionReason }
  }

  private async projectFor(options: NewChatOptions): Promise<{ cwd: string; managedProjectId?: string }> {
    if (options.cwd) {
      if (options.allocationId) throw new Error('Choose either an existing folder or the previewed managed project')
      await validateProject(options.cwd)
      return { cwd: options.cwd }
    }
    return this.projects().create(options.provider, options.allocationId)
  }

  /** Allocate a durable project and a separate conversation receipt. */
  async createChat(options: NewChatOptions, continuationPending = false): Promise<string> {
    if (!['claude', 'codex'].includes(options.provider)) throw new Error('Unsupported conversation provider')
    const policy = this.newChatPolicy(options.provider, options.permission)
    const id = randomUUID(), now = this.clock()
    const home = join(this.opts.baseDir, this.opts.userKey!, id)
    const project = await this.projectFor(options), { cwd } = project
    await fs.mkdir(home, { recursive: true, mode: 0o700 })
    const task: Task = {
      ...project, permissionReason: policy.permissionReason, continuationPending,
      id, intent: 'New conversation', sessionId: options.provider === 'claude' ? randomUUID() : '',
      agent: options.provider, home, cwd, kind: 'session', state: 'done', chatUnstarted: true, sessionOwnership: 'unmute',
      createdAt: now, updatedAt: now, lastHeartbeatMs: now, lastMtimeMs: now,
      statusPath: join(home, 'status.json'), recipeScratchPath: join(home, 'recipe.json'),
      mode: 'managed', injectedRecipes: [],
      ...(options.provider === 'claude' ? { claudeSessionSettings: { ...this.opts.claudeChoice?.({ ...project, home }), ...policy.claude } }
        : { codexSessionSettings: { ...this.opts.codexCliChoice?.(), cwd, ...policy.codex } }),
    }
    await writeFileAtomic(join(home, 'meta.json'), JSON.stringify(task))
    this.tasks.set(id, task)
    this.emit('created', task)
    return id
  }

  /** Bind a new Unmute card to an existing provider conversation. The card is
   * new; the provider identity is not. */
  async attachProviderSession(input: {
    harness: 'claude' | 'codex'
    sessionId: string
    cwd: string
    intent?: string
    title?: string
    group?: string
    groupId?: string
  }): Promise<{ taskId: string; sessionId: string }> {
    const taskId = await this.createChat({ provider: input.harness, cwd: input.cwd, permission: 'maximum' }, true)
    const task = this.tasks.get(taskId)!
    this.continuationPresentation(task, input, false)
    try {
    task.sessionId = input.sessionId
    if (input.harness === 'codex') task.codexRolloutId = input.sessionId
    task.chatUnstarted = false
    task.continuationMode = 'resume'
    task.continuationSources = [{ sessionId: input.sessionId, provider: input.harness }]
    await this.persistState(task)
    if (!(await this.resume(taskId))) {
      throw new Error(task.resumeError || task.deliveryError || `Could not resume ${input.harness} session`)
    }
    await this.publishContinuation(task)
    if (input.intent?.trim() && !(await this.deliverDraft(taskId, input.intent.trim(), []))) {
      throw new Error(task.deliveryError || `Could not send the current request to ${input.harness}`)
    }
    return { taskId, sessionId: input.sessionId }
    } catch (error) { await this.abandonUnpublishedContinuation(task); throw error }
  }

  /** Create a provider-native child and persist the exact source/child pair. */
  async forkProviderSession(input: {
    harness: 'claude' | 'codex'
    sessionId: string
    cwd: string
    intent?: string
    title?: string
    group?: string
    groupId?: string
  }): Promise<{ taskId: string; sessionId: string }> {
    const taskId = await this.createChat({ provider: input.harness, cwd: input.cwd, permission: 'maximum' }, true)
    const task = this.tasks.get(taskId)!
    this.continuationPresentation(task, input, true)
    try {
    task.chatUnstarted = false
    task.continuationMode = 'fork'
    task.continuationSources = [{ sessionId: input.sessionId, provider: input.harness }]

    if (input.harness === 'codex') {
      if (!this.opts.codexHub) throw new Error('CODEX_CLI_UNAVAILABLE: no app-server hub')
      const result = await this.opts.codexHub.forkThread(taskId, input.sessionId, task.codexSessionSettings!)
      if (result.forkedFromId !== input.sessionId || result.threadId === input.sessionId) {
        throw new Error('Codex returned inconsistent fork identity')
      }
      task.sessionId = result.threadId
      task.codexRolloutId = result.threadId
      await this.persistState(task)
    } else {
      if (task.sessionId === input.sessionId) task.sessionId = randomUUID()
      task.claudeForkFromSessionId = input.sessionId
      await this.persistState(task)
      await this.connectClaude(task, false)
    }
    await this.publishContinuation(task)
    if (input.harness === 'codex') {
      try { await this.opts.codexHub!.refreshTask(taskId) }
      catch (error) {
        log.warn('fork-history-refresh-failed', { taskId, sessionId: task.sessionId, ...diagnosticError(error) })
        task.history = { phase: task.blocks?.length ? 'partial' : 'failed', canRetry: true,
          reason: 'The fork was created, but its history could not be loaded. Retry loading this conversation.' }
        this.emit('updated', task)
      }
    }
    if (input.intent?.trim() && !(await this.deliverDraft(taskId, input.intent.trim(), []))) {
      throw new Error(task.deliveryError || `Could not send the current request to ${input.harness}`)
    }
    return { taskId, sessionId: task.sessionId }
    } catch (error) { await this.abandonUnpublishedContinuation(task); throw error }
  }

  private continuationPresentation(task: Task, input: { sessionId: string; cwd: string; title?: string; group?: string; groupId?: string; intent?: string }, _fork: boolean): void {
    const source = this.list().find(t => t.sessionId === input.sessionId || t.codexRolloutId === input.sessionId)
    const inherited = isDescriptiveTitle(source?.name, source?.cwd)
    const title = inherited ? source.name : input.title?.trim() || source?.intent || input.intent?.trim()
    task.name = title?.slice(0, 160)
    // A name the user chose travels with the conversation it names.
    if (inherited && source.nameSetByUser) task.nameSetByUser = true
    task.intent = input.intent?.trim() || task.name || task.intent
    if (input.groupId) { task.group = input.group; task.groupId = input.groupId }
    else if (source?.group) { task.group = this.opts.groupRegistry?.get(source.groupId)?.label || source.group; task.groupId = source.groupId }
    else if (input.group?.trim()) this.setGroup(task.id, input.group.trim())
  }

  private async publishContinuation(task: Task): Promise<void> {
    task.continuationPending = false
    try { await this.persistState(task) } catch (error) { task.continuationPending = true; throw error }
    this.emit('created', task)
  }

  private async abandonUnpublishedContinuation(task: Task): Promise<void> {
    if (!task.continuationPending) return // a delivered child must never be deleted on follow-up failure
    await this.retireRecord(task.id)
    this.tasks.delete(task.id)
    // Preserve receipt/provider history for diagnosis; never kill a source session.
  }

  private async connectClaude(task: Task, resume: boolean, hydrateHistory = true): Promise<void> {
    await validateProject(task.cwd)
    resume = resume && !task.chatUnstarted
    if (task.claudeSessionSettings?.permissionMode === 'bypassPermissions' && !this.chatFullAccessAllowed(task.id)) throw new Error('Recorded full access exceeds the configured sandbox roots. Select Ask for approval before resuming.')
    // A LIVE SESSION IS NOT NECESSARILY A USABLE ONE.
    //
    // acceptanceUncertain latches when a write reached the CLI and the send
    // threw after it, and it never clears — deliberately, because replaying an
    // ambiguous turn could duplicate it. followupGate then answers "Claude is
    // connecting or its acceptance is uncertain. Reconnect before sending",
    // which is correct advice that nothing could act on: this line returned
    // early for any ALIVE driver, so the reconnect it asked for never happened
    // and the card stayed unusable for the life of the process. On 2026-09-08
    // that silently refused eight deliveries and disabled a composer, and cost
    // three wrong diagnoses before the error surfaced in the UI.
    //
    // A fresh session is exactly the remedy the message names, so take it.
    const existing = this.claudeTasks.get(task.id)
    if (existing?.driver.alive && !existing.driver.acceptanceUnresolved) return
    if (existing?.driver.acceptanceUnresolved) {
      log.child({ taskId: task.id }).event('chat-reconnect-after-uncertain-acceptance', {})
      this.claudeTasks.delete(task.id)
      existing.driver.close()
    }
    const pending = this.claudeStarting.get(task.id)
    if (pending) return pending
    const starting = (async () => {
      if (!this.opts.claudeSessionOptions) throw new Error('Claude structured transport is unavailable')
      const historyPath = join(task.home, 'chat-frames.json')
      await this.claudeHistoryWrites.get(task.id)
      let restoredFrames: Array<Record<string, any>> | undefined
      const channel = new ClaudeTaskChannel(p => {
        if (this.shuttingDown || this.claudeTasks.get(task.id)?.channel !== channel) return
        task.lastHeartbeatMs = this.clock()
        this.applyHubPatch({ taskId: task.id, ...p })
      }, frames => {
        if (this.claudeTasks.get(task.id)?.channel !== channel) return
        const data = JSON.stringify(frames)
        const writes = (this.claudeHistoryWrites.get(task.id) ?? Promise.resolve()).then(() => writeFileAtomic(historyPath, data)).catch(error => {
          task.deliveryError = `Could not save chat history: ${(error as Error).message}`
          this.emit('updated', task)
        })
        this.claudeHistoryWrites.set(task.id, writes)
      })
      // Startup reattachment receives only a bounded daemon tail. Never let
      // that projection replace the complete durable frame file; opening the
      // card merges history and re-enables persistence. Until then the file
      // falls behind whatever the session keeps doing, so mark it stale:
      // otherwise a later read trusts it and never consults provider history.
      if (resume && !hydrateHistory) {
        channel.suspendPersistence()
        await writeFileAtomic(join(task.home, CLAUDE_HISTORY_STALE_MARKER), '')
      }
      if ((resume && hydrateHistory) || task.claudeForkFromSessionId) {
        const recovered = await readClaudeHistory({ ...task, sessionId: !resume && task.claudeForkFromSessionId ? task.claudeForkFromSessionId : task.sessionId, chatUnstarted: false })
        restoredFrames = recovered.frames
        if (!resume && task.claudeResumeSessionAt) {
          const cutoff = restoredFrames.findIndex(frame => frame.uuid === task.claudeResumeSessionAt)
          if (cutoff < 0) throw new Error('The edit checkpoint is missing from Claude history.')
          restoredFrames = restoredFrames.slice(0, cutoff + 1)
        }
        task.history = recovered.history
        if (recovered.history.phase !== 'ready') {
          const retained = task.blocks?.length ? task.blocks : (task.conversation ?? []).map(m => ({ kind: 'message', role: m.role, text: m.text }))
          if (retained.length) {
            const projection = blocksFromClaudeTranscript(ClaudeTaskChannel.displayTranscript(restoredFrames))
            // Only a matching whole projection establishes that a pending
            // raw call owns a retained row. Never guess from a similar label.
            const pendingTools = isDeepStrictEqual(projection.blocks, retained) ? projection.pendingTools : undefined
            restoredFrames = retainClaudeHistoryDisplay(restoredFrames, retained as Block[], pendingTools)
          }
        }
      }
      const options = await this.opts.claudeSessionOptions(task)
      if (task.claudeSessionSettings?.chrome === undefined) {
        task.claudeSessionSettings = { ...task.claudeSessionSettings, chrome: options.chrome ?? false }
        this.mergeMeta(task, { claudeSessionSettings: task.claudeSessionSettings }, 'record-browser-choice')
        await this.metaChains.get(task.id)
      }
      // ADD-DIRS ARE UNIONED, NOT CHOSEN. The session settings carry the
      // sandbox roots and the spread below would otherwise drop whatever the
      // options carried; the slash-command bridge is a third source, and all
      // three have to survive or a session silently loses a capability.
      let skillDirs: string[] = []
      try { skillDirs = await this.opts.claudeSkillDirs?.(task) ?? [] }
      catch (error) { log.child({ taskId: task.id }).warn('skill bridge unavailable', { error: (error as Error).message }) }
      const driver = (this.opts.claudeTaskFactory ?? ((o: ClaudeTaskOptions, _task: Task) => new ClaudeTaskSession(o)))({
        ...options, ...task.claudeSessionSettings, sessionId: task.sessionId, cwd: task.cwd, resume,
        addDirs: [...new Set([...(options.addDirs ?? []), ...(task.claudeSessionSettings?.addDirs ?? []), ...skillDirs])],
        ...(!resume && task.claudeForkFromSessionId ? { forkFromSessionId: task.claudeForkFromSessionId, resumeSessionAt: task.claudeResumeSessionAt } : {}),
        onEvent: e => {
          const live = this.claudeTasks.get(task.id)
          if (!live || live.channel !== channel) return
          channel.event(e)
          if (!this.followupScope(task.id)) return
          if (e.type === 'error' || e.type === 'closed') this.emit('followup-disarm', { taskId: task.id })
          else if (e.type === 'result' && e.submissionId) {
            const generation = this.followupGenerations.get(live.driver) ?? 0
            const stopVersion = this.chatStopVersion.get(task.id) ?? 0
            void Promise.resolve(live.driver.submissionFinished).then(() => {
              if (this.claudeTasks.get(task.id) !== live || live.driver.followupUnavailable || (this.chatStopVersion.get(task.id) ?? 0) !== stopVersion) return
              this.emit('followup-turn-ended', { taskId: task.id, fence: { sessionId: task.sessionId, generation, turnId: e.submissionId! },
                outcome: !e.message.is_error && e.message.subtype === 'success' ? 'completed' : 'failed' } satisfies FollowupTurnEnded)
            })
          } else this.emit('followup-ready', { taskId: task.id })
        },
      }, task)
      this.followupGenerations.set(driver, ++this.followupNextGeneration)
      this.emit('followup-disarm', { taskId: task.id })
      this.claudeTasks.set(task.id, { driver, channel })
      if (restoredFrames) channel.restore(restoredFrames)
      await driver.start()
      // Reattached mid-turn: the replay tail rarely holds the turn-start, so
      // the channel would otherwise sit idle (no Stop) while Claude streams.
      if (driver.busy && this.claudeTasks.get(task.id)?.channel === channel) channel.resumeTurn()
    })().finally(() => this.claudeStarting.delete(task.id))
    this.claudeStarting.set(task.id, starting)
    return starting
  }

  private async dispatchClaudeChat(intent: string, opts: NonNullable<Parameters<TaskManager['dispatch']>[1]>): Promise<string> {
    const id = randomUUID(), sessionId = randomUUID(), now = this.clock()
    const home = join(this.opts.baseDir, this.opts.userKey!, id)
    const project = await this.projectFor({ provider: 'claude', cwd: opts.cwd }), { cwd } = project
    const policy = this.newChatPolicy('claude')
    await fs.mkdir(home, { recursive: true, mode: 0o700 })
    const task: Task = {
      ...project, permissionReason: policy.permissionReason,
      ...this.agentPresentation(opts.agentMetadata),
      id, sessionId, intent, home, cwd, agent: 'claude', sessionOwnership: 'unmute',
      claudeSessionSettings: { ...this.opts.claudeChoice?.({ ...project, home }), ...policy.claude },
      ...(opts.forkFromSessionId ? { claudeForkFromSessionId: opts.forkFromSessionId } : {}),
      kind: opts.kind ?? 'oneoff', runtimePinned: opts.kind === 'session',
      state: 'processing', createdAt: now, updatedAt: now, lastHeartbeatMs: now, lastMtimeMs: now,
      statusPath: join(home, 'status.json'), recipeScratchPath: join(home, 'recipe.json'),
      surface: opts.surface ?? detectSurface(intent), mode: opts.mode ?? 'managed', injectedRecipes: [],
      lastUserInputAt: now, spawnedBy: opts.spawnedBy, model: opts.model,
      codexActivity: { kind: 'lifecycle', label: 'Starting' }, ...(opts.unrouted ? { unrouted: true } : {}),
    }
    this.tasks.set(id, task)
    this.emit('created', task)
    try {
      await scaffoldStatusFile(task.statusPath)
      await writeFileAtomic(join(home, 'meta.json'), JSON.stringify(task))
      if (opts.forkFromSessionId) {
        const source = [...this.tasks.values()].find(t => t.sessionId === opts.forkFromSessionId)
        if (source) await fs.copyFile(join(source.home, 'chat-frames.json'), join(home, 'chat-frames.json')).catch(error => {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        })
      }
      await this.connectClaude(task, false)
      if (this.chatStopVersion.has(id)) throw new Error('Stopped before submission')
      const runtime = this.claudeTasks.get(id)!, submissionId = randomUUID()
      runtime.channel.expectSubmission(submissionId, [{ type: 'text', text: intent }, ...(opts.attachments ?? []).map(path => ({ type: 'image' as const, path }))])
      await runtime.driver.send(intent, [...(opts.attachments ?? [])], submissionId)
    } catch (error) {
      this.transition(id, 'failed', { state: 'failed', error: { reason: (error as Error).message } })
      if (opts.attachments?.length) throw error
    }
    return id
  }

  private agentPresentation(input?: AgentDispatchMetadata, sessionOwnership: 'unmute' | 'external' = 'unmute', cwd?: string): Partial<Task> {
    if (!input) return {}
    const metadata = resolveAgentMetadata({ ...input, cwd }, this.opts.groupRegistry)
    if (!input.agentRunId?.trim()) throw new Error('Agent run identity is required')
    return { name: metadata.title, group: metadata.group, groupId: metadata.groupId, origin: 'unmute-agent', agentRunId: input.agentRunId, sessionOwnership }
  }

  async dispatch(intent: string, opts: { surface?: string; mode?: 'managed' | 'raw'; kind?: 'oneoff' | 'session'; cwd?: string; spawnedBy?: string; extraEnv?: Record<string, string>; forkFromSessionId?: string; agent?: AgentKind; project?: string | null; model?: string; attachments?: readonly string[]; unrouted?: boolean; agentMetadata?: AgentDispatchMetadata } = {}): Promise<string> {
    this.agentPresentation(opts.agentMetadata, 'unmute', opts.cwd)
    // Provider-native routes own dispatch acknowledgement. Codex must not fall
    // through to Claude's PTY submit-and-verify path, which can resend prompts.
    const route = this.dispatchRoute(opts.agent)
    if (route) return route(intent, opts)
    // EXTERNAL BACKEND FORK (codex-desktop). Everything below this point — the
    // status file, the CLAUDE.md contract, the owned PTY, the trust prompt, the
    // dispatch payload — presumes Unmute spawns and owns the process. Codex
    // desktop is an app we drive, so it takes a different path entirely rather
    // than threading conditionals through 200 lines of PTY setup.
    // Claude desktop is a different app again: there is no thread to create via
    // an API, only a window to drive. Routing it here rather than letting
    // isExternalAgent send it to dispatchCodexDesktop, which would try to talk
    // to Codex over CDP about a conversation that does not exist there.
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
      const st = await fs.stat(opts.cwd).catch(() => null)
      if (!st?.isDirectory()) throw new Error(`The selected project folder is unavailable: ${opts.cwd}`)
      runCwd = opts.cwd
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
      id, intent, sessionId, kind, runtimePinned: kind === 'session', state: 'processing', createdAt: now, updatedAt: now,
      ...this.agentPresentation(opts.agentMetadata),
      // Nothing classified this one — see Task.unrouted.
      ...(opts.unrouted ? { unrouted: true } : {}),
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
      await writeFileAtomic(join(dir, 'meta.json'), JSON.stringify({ id, intent, sessionId, kind, runtimePinned: task.runtimePinned, agent, createdAt: now, lastUserInputAt: now, surface, mode, injectedRecipes: task.injectedRecipes, ...this.agentPresentation(opts.agentMetadata), ...(external ? { cwd: runCwd } : {}), ...(opts.spawnedBy ? { spawnedBy: opts.spawnedBy } : {}), ...(task.model ? { model: task.model } : {}) }))
      devEvent(tlog, 'dispatch-memory', { surface, mode, injectedRecipes: task.injectedRecipes })

      // Named, not left to the picker — see the task literal above. `browser`
      // is decided per task now: a session working in the user's repo does not
      // get browser control it will never use (session-policy.ts).
      const ex = this.opts.executorFactory(undefined, agent, { browser: browserFor({ surface, projectBound: external }) })
      this.executors.set(id, ex)
      // Buffer raw PTY output (capped) for render-on-demand (§4.3/§13.4#8) and
      // emit it live so a watching terminal view updates in real time.
      this.outputBuffers.set(id, '')
      ex.onData((chunk) => guardPtyCallback(id, () => {
        tlog.debug('pty-data', { chunk })
        // Untruncated copy for diagnosis. The line above is capped at 2000 chars
        // by the logger, which is exactly why three theories about why a session
        // dies could not be settled. Off unless UNMUTE_PTY_TAP=1.
        tapPtyForTask(id, 'out', Buffer.from(chunk), this.clock())
        this.notePtyLiveness(id)
        const cur = (this.outputBuffers.get(id) ?? '') + chunk
        this.outputBuffers.set(id, cur.length > TaskManager.OUTPUT_CAP ? cur.slice(-TaskManager.OUTPUT_CAP) : cur)
        this.emit('output', { taskId: id, chunk })
      }))

      await ex.spawn({
        cwd: runCwd, env: process.env, taskId: id,
        // A fork cannot pin a session id — Claude mints the fork's own.
        sessionId: opts.forkFromSessionId ? undefined : sessionId,
        extraEnv: opts.extraEnv,
        forkFromSessionId: opts.forkFromSessionId,
      })
      // A DEAD SESSION IS NOT A WORKING ONE. Watch the process itself rather
      // than waiting for a poller to notice: the status file only ever tells us
      // what the agent WROTE, so a CLI that quits before writing anything is
      // invisible to it forever. That is exactly what happened on 2026-08-28 —
      // Codex exited 0 half a second after dispatch and the card read
      // "Working 9m" over a terminal that had been gone the whole time.
      ex.onExit?.(({ exitCode }) => this.onSessionExit(id, exitCode))
      await ex.isReady()
      if (!ex.alive) throw new Error(`${agent} CLI exited before task dispatch`)

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
        const settled = await settleRepl({
          agent,
          getOutput: () => this.outputBuffers.get(id) ?? '',
          isAlive: () => ex.alive,
          sendEnter: () => ex.write('\r'),
          sendRaw: (input) => ex.write(input),
          onEvent: (event, fields) => tlog.event(event, fields),
        })
        // NEVER TYPE INTO A MENU. If a startup dialog we RECOGNISE is still
        // holding the screen, the payload would be keystrokes inside it — which
        // is precisely how a dispatch became "2. No, quit" and the session
        // exited 0 while the card read "Working" for nine minutes (2026-08-28).
        //
        // Deliberately narrow: only a POSITIVELY IDENTIFIED dialog refuses. An
        // un-confirmed screen still dispatches exactly as before, because that
        // permissiveness is load-bearing for startup shapes nobody has
        // enumerated, and turning "unconfirmed" into a hard failure would break
        // working tasks to fix a rare one.
        if (!settled.settled && settled.dialog) {
          throw new Error(`${agent} CLI stopped at its ${settled.dialog} dialog and never reached its prompt`)
        }
        tlog.event('repl-settle-outcome', { settled: settled.settled, reason: settled.reason, dialog: settled.dialog ?? null })
      }
      if (!ex.alive) throw new Error(`${agent} CLI exited before task dispatch`)

      if (opts.attachments?.length) {
        task.conversation = [{ role: 'user', text: intent }]
        if (!(await this.deliverDraft(id, intent, opts.attachments))) {
          throw new Error('ATTACHMENT_DELIVERY_FAILED: cli')
        }
        tlog.event('task-dispatched-with-attachments', { count: opts.attachments.length })
        return id
      }

      // The payload is the user's words. Nothing else — no status path, no
      // recipe path, no contract, no "act now". See dispatch-prompt.ts.
      const payload = buildDispatch({ intent })
      const dispatchedAt = Date.now()
      ex.writeStdin(payload)
      tlog.event('task-dispatched', { bytes: payload.length })
      // "Dispatched" means TYPED. Start watching for evidence it was actually
      // received - see proveDelivery.
      this.proveDelivery(id)
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
      if (opts.agent === 'claude' || opts.agent === undefined) {
        void this.verifyDispatch(id, ex, payload, dispatchedAt)
      }
    } catch (e) {
      tlog.error('dispatch failed before polling', { error: (e as Error).message })
      this.transition(id, 'failed', { error: { reason: 'Could not start the task', detail: (e as Error).message } })
      if ((e as Error).message.startsWith('ATTACHMENT_DELIVERY_')) throw e
    }
    return id
  }

  /**
   * Materialize only a controller-classified consequential Agent result. The
   * activity stream never calls this, so searches and other transient turns do
   * not enter the task map. Repeated turns on one run update the same card.
   */
  /**
   * Mark a task as having been created BY THE AGENT rather than by the user.
   *
   * Law IV: every object records how it came to exist. Without it, "what have
   * we been working on?" cannot separate the user's own work from the Agent's
   * side-effects, and a hand-off is indistinguishable from something they
   * asked for directly.
   */
  mergeAgentOrigin(taskId: string, agentRunId: string): void {
    const task = this.tasks.get(taskId)
    if (!task) return
    task.origin = 'unmute-agent'
    task.agentRunId = agentRunId
    this.mergeMeta(task, { origin: 'unmute-agent', agentRunId }, 'agent-handoff-origin')
    this.emit('updated', task)
  }

  /**
   * Record that the Agent carried words in from other sessions.
   *
   * APPENDS. `mergeContinuationProvenance` REPLACES, because it describes the
   * one act that created a conversation; a card can receive any number of
   * relays over its life and each one is its own fact. Bounded so a long-lived
   * session cannot grow its meta file without limit.
   */
  async noteAgentRelay(taskId: string, input: {
    agentRunId?: string
    sources?: Array<{ sessionId: string; provider: 'claude' | 'codex' }>
    artifacts?: Array<{ kind: 'file' | 'url' | 'identifier'; value: string; label?: string }>
  }): Promise<void> {
    const task = this.tasks.get(taskId)
    if (!task) return
    task.agentRelays = [...(task.agentRelays ?? []), {
      at: Date.now(),
      ...(input.agentRunId ? { agentRunId: input.agentRunId } : {}),
      ...(input.sources?.length ? { sources: input.sources.map(source => ({ ...source })) } : {}),
      ...(input.artifacts?.length ? { artifacts: input.artifacts.map(artifact => ({ ...artifact })) } : {}),
    }].slice(-32)
    this.mergeMeta(task, { agentRelays: task.agentRelays }, 'agent-relay')
    await this.metaChains.get(taskId)
    this.emit('updated', task)
  }

  async mergeContinuationProvenance(taskId: string, input: {
    mode: 'resume' | 'fork' | 'synthesis' | 'fresh'
    sources?: Array<{ sessionId: string; provider: 'claude' | 'codex' }>
    artifacts?: Array<{ kind: 'file' | 'url' | 'identifier'; value: string; label?: string }>
    confidence?: number
  }): Promise<void> {
    const task = this.tasks.get(taskId)
    if (!task) return
    task.continuationMode = input.mode
    task.continuationSources = input.sources?.map(source => ({ ...source }))
    task.continuationArtifacts = input.artifacts?.map(artifact => ({ ...artifact }))
    task.continuationConfidence = input.confidence
    this.mergeMeta(task, {
      continuationPending: task.continuationPending,
      continuationMode: task.continuationMode,
      continuationSources: task.continuationSources,
      continuationArtifacts: task.continuationArtifacts,
      continuationConfidence: task.continuationConfidence,
    }, 'continuation-provenance')
    await this.metaChains.get(taskId)
    this.emit('updated', task)
  }

  async presentAgentResult(input: {
    agentRunId: string
    intent: string
    text: string
    provider?: Extract<AgentKind, 'claude' | 'codex'>
  }): Promise<string> {
    const now = this.clock()
    const summary = input.text.trim().replace(/\s+/gu, ' ').slice(0, 240) || 'Completed'
    const existing = [...this.tasks.values()].find(
      (task) => task.origin === 'unmute-agent' && task.agentRunId === input.agentRunId,
    )
    if (existing) {
      existing.intent = input.intent
      existing.state = 'done'
      existing.updatedAt = now
      existing.result = { summary, detail: input.text }
      if (input.provider) existing.agent = input.provider
      this.mergeMeta(existing, {
        intent: input.intent,
        state: 'done',
        updatedAt: now,
        result: existing.result,
        origin: 'unmute-agent',
        agentRunId: input.agentRunId,
        ...(input.provider ? { agent: input.provider } : {}),
      }, 'present-agent-result')
      this.emit('updated', existing)
      return existing.id
    }

    const id = randomUUID()
    const dir = join(this.opts.baseDir, this.opts.userKey!, id)
    const agent = input.provider ?? 'claude'
    const task: Task = {
      id,
      intent: input.intent,
      sessionId: input.agentRunId,
      origin: 'unmute-agent',
      agentRunId: input.agentRunId,
      agent,
      kind: 'oneoff',
      state: 'done',
      createdAt: now,
      updatedAt: now,
      cwd: dir,
      home: dir,
      statusPath: join(dir, 'status.json'),
      recipeScratchPath: join(dir, 'recipe.json'),
      lastMtimeMs: 0,
      lastHeartbeatMs: now,
      mode: 'managed',
      result: { summary, detail: input.text },
    }
    await fs.mkdir(dir, { recursive: true })
    await writeFileAtomic(join(dir, 'meta.json'), JSON.stringify({
      id,
      intent: input.intent,
      sessionId: input.agentRunId,
      origin: 'unmute-agent',
      agentRunId: input.agentRunId,
      agent,
      kind: 'oneoff',
      state: 'done',
      createdAt: now,
      updatedAt: now,
      mode: 'managed',
      result: task.result,
    }))
    this.tasks.set(id, task)
    this.emit('created', task)
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
    const mine = (t: Task) => t.agent === 'claude' || t.agent === undefined
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
    if (task.claudeSessionSettings) return // structured stream owns state; hooks are telemetry only
    const tlog = log.child({ taskId: task.id })
    const at = this.clock()

    // Liveness first, for EVERY event. A hook firing is proof the session is
    // alive, which also HEALS a false `stuck`: stuck is a verdict about silence,
    // and this is the silence ending. Advances lastHeartbeatMs only — never
    // lastMtimeMs, which is the status read cursor (see poll()).
    task.lastHeartbeatMs = at
    // Hooks are the primary Claude CLI state signal. Reconcile immediately so
    // the status file and transcript reach every UI projection in the same
    // turn; the scheduler heartbeat is only a repair path.
    this.scheduler.trigger(task.id)
    if (task.state === 'stuck') {
      tlog.event('stuck-recovered', { via: 'hook' })
      this.transition(task.id, 'processing')
    }
    if (event.kind === 'prompt-submitted') task.promptSubmittedAt = at
    if (event.kind === 'tool-used') {
      // CAUGHT LIVE, not reconstructed later. This used to be derived on
      // turn-ended by re-reading the transcript file — which raced Claude
      // Code's own flush of that exact line: `Stop` can fire before the tool
      // call it just made is durable on disk, so the read would come back
      // without it and wrongly conclude "not a checkpoint" (field-observed:
      // a real ScheduleWakeup call, made seconds before Stop, missed by the
      // read that followed). PostToolUse fires synchronously as the call
      // actually happens — no race to lose. ANY other tool call clears it:
      // real work resumed past the scheduling declaration, so it was never a
      // true pause point. Cheap and synchronous on purpose — no transcript
      // read, no persistState, matching "liveness only" for everything else
      // about this event. See selfContinuationDelaySeconds's own doc comment.
      const delaySeconds = selfContinuationDelaySeconds(event.tool, event.toolInput)
      task.checkpoint = delaySeconds !== null
      task.checkpointExpiresAt = delaySeconds !== null
        ? this.clock() + delaySeconds * 1000 + CHECKPOINT_GRACE_MS
        : undefined
      return // liveness (+ the above) only
    }
    // A Notification says nothing a keyed event has not already said better —
    // it is liveness and nothing more (observer.ts explains why).
    if (event.kind === 'waiting') return

    // THE ASK INTERVAL. Opening records the shape; closing verifies what
    // actually registered and clears it. Because both are keyed by askId, a
    // second ask cannot overwrite the first and a stale one cannot linger.
    if (event.kind === 'ask-opened') {
      task.openAsk = { id: event.askId, questions: event.questions }
      tlog.event('ask-opened', {
        askId: event.askId, questions: event.questions.length,
        answerable: isAnswerable(event.questions),
      })
    }
    if (event.kind === 'ask-closed') {
      const open = task.openAsk
      // NEVER LET AN UNVERIFIED ANSWER LOOK SUCCESSFUL. `tool_response.answers`
      // is what the picker actually recorded; if we sent a keystroke and it
      // registered something else, that is the one failure mode of this design
      // that corrupts rather than degrades — so it is logged loudly rather than
      // hidden. (The class it guards: typing "Spaces" recorded "Tabs".)
      if (open?.answeredWith) {
        const got = event.answers[open.questions[0]?.question ?? ''] ?? ''
        if (got && got !== open.answeredWith) {
          tlog.error('ANSWER MISMATCH — the picker registered something else', {
            sent: open.answeredWith, registered: got, askId: event.askId,
          })
        } else {
          tlog.event('answer-verified', { answer: got || open.answeredWith })
        }
      }
      if (task.openAsk?.id === event.askId || !task.openAsk) task.openAsk = undefined
    }

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
    if (event.kind === 'prompt-submitted') {
      // A new turn starting means whatever checkpoint the LAST turn ended on
      // is over — this is a fresh turn, and it deserves its own, unbiased
      // judgment when it too ends. The new prompt IS the proof the
      // continuation happened, so there is nothing left to time out.
      task.checkpoint = false
      task.checkpointExpiresAt = undefined
    }
    // `tool-used` (including the checkpoint capture) is handled earlier, in
    // onHookEvent, before this function is even called — see its own comment.
    if (event.kind === 'turn-ended') {
      const path = task.sessionId ? await findTranscriptById(task.cwd, task.sessionId) : null
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
      // THE CHAT VIEW, read from the same transcript. Independent of the two
      // turns above on purpose: those exist to survive the flush race described
      // in the comment, whereas blocks are the full record and are allowed to
      // lag a beat behind the final message rather than be reconstructed from it.
      if (path) await this.refreshClaudeBlocks(task, path, tlog)
    }
    const payload = deriveStatus(event, {
      kind: (task.kind ?? 'oneoff') as 'oneoff' | 'session',
      surface: task.surface,
      sideEffects,
      prior: task.state as TaskState,
      // A better-informed ask must not be clobbered by a poorer one arriving
      // later — see ObserverContext.pendingQuestion.
      pendingQuestion: task.state === 'needs-user' && !!task.question,
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
    opts: { kind?: 'oneoff' | 'session'; surface?: string; spawnedBy?: string; project?: string | null; agent?: AgentKind; model?: string; attachments?: readonly string[]; agentMetadata?: AgentDispatchMetadata },
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
      attachments: opts.attachments,
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
      ...this.agentPresentation(opts.agentMetadata, 'external'),
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

    await writeFileAtomic(join(dir, 'meta.json'), JSON.stringify({
      id, intent, sessionId: created.threadId, kind, createdAt: now, surface, mode: 'managed',
      ...this.agentPresentation(opts.agentMetadata, 'external'),
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
   * CODEX CLI ON THE APP SERVER.
   *
   * The same Task record as every other backend; a completely different way of
   * learning what happens to it. There is no status file to poll and no rollout
   * to parse — the thread pushes state, activity and replies over JSON-RPC, and
   * `applyHubPatch` folds them in.
   *
   * The app-server is the sole writer. No mirror TUI or PTY is spawned.
   *
   * PERMISSIONS TRAVEL WITH THE THREAD (posture.ts), so the user's path fence
   * is honoured per task rather than being a global posture we set once and
   * hope suits everything.
   */
  private async dispatchCodexCli(
    intent: string,
    opts: { kind?: 'oneoff' | 'session'; surface?: string; spawnedBy?: string; cwd?: string; project?: string | null; model?: string; effort?: string; attachments?: readonly string[]; agentMetadata?: AgentDispatchMetadata },
  ): Promise<string> {
    const hub = this.opts.codexHub
    if (!hub) throw new Error('CODEX_CLI_UNAVAILABLE: no app-server hub')
    const id = randomUUID()
    const tlog = log.child({ taskId: id })
    const dir = join(this.opts.baseDir, this.opts.userKey!, id)
    const now = this.clock()
    const surface = opts.surface ?? detectSurface(intent)
    const kind = opts.kind ?? 'oneoff'
    await fs.mkdir(dir, { recursive: true }).catch(() => {})

    const project = await this.projectFor({ provider: 'codex', cwd: opts.cwd })
    const runCwd = project.cwd, policy = this.newChatPolicy('codex')
    // WIRE VALUES, never the display record. `opts.model` is the sentence a
    // card shows; this is the id Codex is asked to run.
    const wire = this.opts.codexCliChoice?.() ?? {}
    const sessionSettings: StartThreadOpts = {
      cwd: runCwd, model: wire.model, effort: wire.effort,
      ...policy.codex,
    }

    const task: Task = {
      ...project, permissionReason: policy.permissionReason,
      id,
      intent,
      sessionId: '',               // Filled only after thread/start acknowledges.
      ...this.agentPresentation(opts.agentMetadata),
      agent: 'codex',
      sessionOwnership: 'unmute',
      codexSessionSettings: sessionSettings,
      kind,
      state: 'processing',
      codexActivity: { kind: 'lifecycle', label: 'Starting' },
      createdAt: now,
      updatedAt: now,
      cwd: runCwd,
      home: dir,
      statusPath: join(dir, 'status.json'),
      recipeScratchPath: join(dir, 'recipe.json'),
      lastMtimeMs: 0,
      lastHeartbeatMs: now,
      surface,
      mode: 'managed',
      // The record: already the display string, stamped by the dispatch wrapper.
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.spawnedBy ? { spawnedBy: opts.spawnedBy } : {}),
    } as Task
    this.tasks.set(id, task)
    this.emit('created', task)
    try {
    const { threadId } = await hub.startThread(id, sessionSettings)
    task.sessionId = threadId
    task.codexRolloutId = threadId
    await writeFileAtomic(join(dir, 'meta.json'), JSON.stringify({
      id, intent, sessionId: threadId, kind, createdAt: now, surface, mode: 'managed',
      ...this.agentPresentation(opts.agentMetadata),
      agent: 'codex', sessionOwnership: 'unmute', codexRolloutId: threadId, state: 'processing', updatedAt: now,
      ...project, permissionReason: policy.permissionReason, codexSessionSettings: sessionSettings,
      ...(opts.spawnedBy ? { spawnedBy: opts.spawnedBy } : {}),
      ...(task.model ? { model: task.model } : {}),
    }))
    this.emit('updated', task)

    // The prompt goes directly over the structured protocol.
    // THE ASK IS PART OF THE CONVERSATION. Without this the transcript opens on
    // an answer to a question it never shows — `intent` lives on the task and
    // the card's title, but the chat view reads `conversation`.
    task.conversation = [{ role: 'user', text: intent }]
    // EFFORT RIDES ON THE TURN, not the thread — `thread/start` has no effort
    // parameter, `turn/start` does. Omitted here, the Effort axis would move a
    // setting that never reached Codex: a picker that appears to work.
    const sent = await hub.send(id, intent, { effort: wire.effort, attachments: opts.attachments })
    if (!sent) {
      tlog.warn('codex-cli turn/start refused', {})
      this.transition(id, 'failed', { state: 'failed', error: { reason: 'Codex would not start the turn' } })
      if (opts.attachments?.length) throw new Error('ATTACHMENT_DELIVERY_FAILED: codex-cli')
    }
    tlog.event('codex-cli-dispatched', {
      threadId, cwd: runCwd, model: wire.model ?? null, effort: wire.effort ?? null,
      approvalPolicy: policy.codex.approvalPolicy, sandbox: policy.codex.sandbox, fullAccess: policy.codex.sandbox === 'danger-full-access',
    })
    return id
    } catch (error) {
      this.transition(id, 'failed', { state: 'failed', error: { reason: (error as Error).message } })
      if (opts.attachments?.length) throw error
      return id
    }
  }

  /**
   * Fold one hub patch into a task.
   *
   * The App Server's answer to poll(). Patches are partial by design — an event
   * that says only "it started running npm test" must not restate the state, so
   * `undefined` means unchanged and `null` (on activity) means cleared.
   */
  applyHubPatch(p: HubPatch): void {
    const task = this.tasks.get(p.taskId)
    if (!task) return
    if (task.codexRolloutId && p.threadId && task.codexRolloutId !== p.threadId) {
      sessionLifecycleDev('stale-thread-patch-ignored', { taskId: task.id, sessionId: task.codexRolloutId, receivedSessionId: p.threadId })
      return
    }
    const learnedRolloutId = !!p.threadId && !task.codexRolloutId
    if (learnedRolloutId) task.codexRolloutId = p.threadId
    if (p.name && !task.name) task.name = p.name
    if (p.state === 'processing' && 'turnOutcome' in p && p.turnOutcome === null) {
      task.currentTurnAssistantText = undefined
    }
    if (p.assistantText) {
      task.currentTurnAssistantText = p.assistantText
      task.conversation = [...(task.conversation ?? []), { role: 'assistant', text: p.assistantText }]
    }
    // Full blocks hydrate reconnect/history. Live events update only changed
    // indices so a long transcript is not serialized for every streamed token.
    if (p.blocks) task.blocks = p.blocks
    // Travels WITH the blocks it describes: a producer that replaces the
    // array also replaces what is known about how complete it is.
    if (p.blocks && p.blocksDurable !== undefined) task.blocksDurable = p.blocksDurable
    else if (p.blockUpdates?.length) task.blocks = applyBlockUpdates(task.blocks, p.blockUpdates)
    if (p.usage) task.usage = p.usage
    if (p.history) task.history = p.history
    if ('turnOutcome' in p) task.turnOutcome = p.turnOutcome ?? undefined
    if (p.mcpStatus) task.mcpStatuses = [...(task.mcpStatuses ?? []).filter(s => s.name !== p.mcpStatus!.name), p.mcpStatus]
    if ('permissionLimit' in p) {
      task.permissionLimit = p.permissionLimit ?? undefined
      // Learned from the provider itself, so it covers policies no file on
      // this Mac shows (a ChatGPT or claude.ai workspace policy).
      if (p.permissionLimit && p.permissionLimit.asked === 'Full access' && !p.permissionLimit.effective.startsWith('Full access')) this.fullAccessForbiddenOnMachine.add(p.permissionLimit.provider)
      if (p.permissionLimit) log.child({ taskId: task.id }).event('permission-limited', { ...p.permissionLimit })
    }
    if ('activity' in p) task.codexActivity = p.activity ?? undefined
    if (p.clearQuestion) task.question = undefined
    if (p.errorReason !== undefined) {
      task.error = p.errorReason ? { reason: p.errorReason } : undefined
      if (p.state === 'needs-user' || !p.errorReason) task.deliveryError = p.errorReason || undefined
    }

    // A STATE CHANGE IS THE ONLY THING THAT TRANSITIONS. Everything above is
    // detail about a task that is already where it is; routing it through
    // transition() would rewrite updatedAt on every keystroke of streamed output
    // and shove the task to the top of the wall forever.
    if (p.state) {
      const completedText = p.assistantText ?? task.currentTurnAssistantText
      const status: StatusPayload = {
        schema_version: 1,
        state: p.state,
        updated_at: new Date(this.clock()).toISOString(),
        ...(p.question ? { question: p.question } : {}),
        ...(p.errorReason ? { error: { reason: p.errorReason } } : {}),
        ...(p.state === 'done' && completedText
          ? { result: { summary: completedText.split('\n')[0].slice(0, 140), detail: completedText } }
          : {}),
      }
      // NOTHING CHANGED IS NOT NEWS — the guard pollCodexCli has, missing here.
      //
      // Several events carry a state without changing one: `turn/started` says
      // processing on a task already processing, and `thread/status/changed:
      // active` says it again. Transitioning anyway rewrites updatedAt, which
      // re-sorts the wall, re-enters the attention path and re-opens the
      // surface — observed as a Codex task that "keeps expanding every few
      // seconds as if something interrupted it".
      //
      // Text still counts as news even at the same state: a streamed reply
      // arriving while the task stays `processing` must reach the card.
      const sameState = task.state === p.state
      const sameText = !p.assistantText
      const sameQuestion = !p.question
      if (sameState && sameText && sameQuestion) {
        task.lastHeartbeatMs = this.clock()   // still alive, just not newsworthy
        // NEW BLOCKS ARE NEWS TO THE PANEL, THOUGH — a command finishing or a
        // diff landing changes nothing about the task's STATE, and everything
        // about what an open chat view should be showing. Emit without
        // transitioning, so the card updates and the wall does not re-sort.
        if (p.blocks || p.errorReason !== undefined || 'activity' in p || 'turnOutcome' in p || p.history || p.mcpStatus || 'permissionLimit' in p) this.emit('updated', task)
        if (learnedRolloutId) void this.persistState(task)
        return
      }
      this.transition(p.taskId, p.state, status, this.clock())
      // AND WRITE IT DOWN, or a restart calls this task failed.
      //
      // rehydrate() decides a restarted task's state from status.json: a
      // non-terminal file means "its session died with the app", which for a
      // one-off is reported as failed/interrupted. That is right for Claude,
      // whose agent WRITES that file through the hooks Unmute installs.
      //
      // Nothing writes it for a Codex CLI task. State arrives over the protocol
      // and lands in memory, so the file kept the 'processing' the scaffold put
      // there at spawn — and every finished Codex task came back red after any
      // restart. Observed in the field, twice, on tasks that had completed
      // perfectly forty minutes earlier.
      //
      // Unmute is the writer for this backend, which breaks no rule: the
      // observe-never-modify contract is about the user's SESSION, and this
      // file is ours — Codex neither writes nor reads it.
      void writeStatusFile(task.statusPath, status).catch(() => {})
      return
    }
    // Streaming blocks update the open view, not the task's ordering timestamp.
    if (p.assistantText) task.updatedAt = this.clock()
    this.emit('updated', task)
    if (learnedRolloutId || p.assistantText) void this.persistState(task)
  }

  /** Reconcile a task receipt with the provider identity durably committed by
   * the runtime. This runs before a restored task is published, so no consumer
   * can resume or render the superseded parent thread. */
  private async reconcileCodexIdentity(task: Task, throwOnFailure = false): Promise<boolean> {
    if (!task.codexSessionSettings || !this.opts.codexHub?.recoverIdentity) return false
    try {
      const identity = await this.opts.codexHub.recoverIdentity(task.id, task.sessionId)
      if (!identity) return false
      if (identity.taskId !== task.id || !identity.threadId
        || identity.forkedFromId && identity.forkedFromId !== task.sessionId && identity.threadId !== task.sessionId) {
        throw new Error('Canonical Codex identity contradicts the task receipt')
      }
      const changed = task.sessionId !== identity.threadId || task.codexRolloutId !== identity.threadId
      task.sessionId = identity.threadId
      task.codexRolloutId = identity.threadId
      if (changed) log.event('codex-identity-reconciled', {
        taskId: task.id, sourceSessionId: identity.forkedFromId ?? null, sessionId: identity.threadId,
      })
      if (changed) sessionLifecycleDev('task-identity-reconciled', {
        taskId: task.id, sourceSessionId: identity.forkedFromId ?? null, sessionId: identity.threadId,
      })
      return changed
    } catch (error) {
      task.resumeError = 'This conversation identity could not be verified. Unmute will not attach another writer.'
      log.error('codex-identity-reconciliation-failed', { taskId: task.id, ...diagnosticError(error) })
      if (throwOnFailure) throw new Error(task.resumeError, { cause: error })
      return false
    }
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

  private claudeAgentCreations = 0
  private desktopReceiptWrites: Promise<void> = Promise.resolve()
  private desktopReceiptPath(): string {
    return join(this.opts.baseDir, `pending-agent-desktop-${this.opts.userKey ?? 'local'}.json`)
  }
  private async desktopReceipts(): Promise<DesktopHandoffReceipt[]> {
    await this.desktopReceiptWrites
    try { return JSON.parse(await fs.readFile(this.desktopReceiptPath(), 'utf8')) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
  }
  private updateDesktopReceipts(update: (receipts: DesktopHandoffReceipt[]) => DesktopHandoffReceipt[]): Promise<void> {
    const pending = this.desktopReceiptWrites.then(async () => {
      let receipts: DesktopHandoffReceipt[] = []
      try { receipts = JSON.parse(await fs.readFile(this.desktopReceiptPath(), 'utf8')) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      await fs.mkdir(this.opts.baseDir, { recursive: true })
      await writeFileAtomic(this.desktopReceiptPath(), JSON.stringify(update(receipts)))
    })
    this.desktopReceiptWrites = pending.catch(() => {})
    return pending
  }

  async adoptClaudeDesktop(opts: { windowMs?: number; cap?: number; only?: ReadonlySet<string>; agentMetadata?: AgentDispatchMetadata } = {}): Promise<string[]> {
    if (this.claudeAgentCreations && !opts.agentMetadata) return []
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
    const receipts = await this.desktopReceipts()
    const firstUserText = new Map<string, string | undefined>()
    for (const meta of found) {
      if (!receipts.some(receipt => !receipt.before.includes(meta.sessionId))) continue
      const view = await driver.snapshot?.(meta.sessionId).catch(() => null)
      firstUserText.set(meta.sessionId, view?.snapshot.turns.find(turn => turn.role === 'user')?.text)
    }
    const receiptCandidates = new Map(receipts.map(receipt => [receipt.id, found.filter(meta => {
      if (receipt.before.includes(meta.sessionId)) return false
      const until = (receipt.startedAt || 0) + 120_000
      if (meta.createdAt > 0 && (meta.createdAt < receipt.startedAt || meta.createdAt > until)) return false
      const first = firstUserText.get(meta.sessionId)
      if (first !== undefined) return first === receipt.intent
      // Quarantine only the creation's bounded time window while its transcript
      // is unreadable. An unresolved receipt never owns every future chat.
      return meta.createdAt > 0 ? meta.createdAt >= receipt.startedAt && meta.createdAt <= until : now <= until
    })] as const))

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
      if (this.claudeAgentCreations && !opts.agentMetadata) break
      const pending = receipts.filter(receipt => receiptCandidates.get(receipt.id)?.some(candidate => candidate.sessionId === meta.sessionId))
      // A store diff can identify one new conversation. It cannot distinguish
      // multiple new conversations, so keep their receipt and publish none.
      if (pending.length > 1 || pending.some(receipt => !receipt.acknowledged || receiptCandidates.get(receipt.id)?.length !== 1
        || firstUserText.get(meta.sessionId) !== receipt.intent && opts.agentMetadata?.agentRunId !== receipt.metadata.agentRunId)) continue
      const receipt = pending[0]
      if (opts.agentMetadata && !receipt) continue
      const agentMetadata = receipt?.metadata ?? opts.agentMetadata
      if (adopted.length >= cap) break
      // `only` names EXACTLY which conversations to take. Used by creation,
      // where the task has already been identified by diffing the store — an
      // unfiltered sweep would adopt whatever happened to sort first instead,
      // which is the same "take the newest" mistake the diff exists to avoid.
      if (opts.only && !opts.only.has(meta.sessionId)) continue
      // The user threw this card away. Adoption must never overrule that.
      if (this.claudeDismissed.has(meta.sessionId)) continue
      if (meta.archived) continue
      if (known.has(meta.sessionId)) {
        if (receipt && this.list().some(task => task.claudeDesktopSessionId === meta.sessionId && task.agentRunId === receipt.metadata.agentRunId)) {
          await this.updateDesktopReceipts(items => items.filter(item => item.id !== receipt.id))
        }
        continue
      }
      // A conversation we were told to take is wanted regardless of age.
      if (!opts.only && !receipt && meta.lastActivityAt > 0 && now - meta.lastActivityAt > windowMs) continue

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
        ...this.agentPresentation(agentMetadata, 'external'),
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
        state: 'done',
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

      await writeFileAtomic(join(dir, 'meta.json'), JSON.stringify({
        id, intent: task.intent, sessionId: meta.sessionId, kind: 'session',
        ...this.agentPresentation(agentMetadata, 'external'),
        createdAt: task.createdAt, mode: 'managed',
        agent: 'claude-code-desktop', claudeDesktopSessionId: meta.sessionId,
        state: 'done', updatedAt: now,
        ...(model ? { model } : {}),
      })).catch(error => { if (agentMetadata) throw error })

      if (receipt) await this.updateDesktopReceipts(items => items.filter(item => item.id !== receipt.id))

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
  async createClaudeDesktop(intent: string, opts: { tries?: number; waitMs?: number; agentMetadata?: AgentDispatchMetadata } = {}): Promise<{ ok: boolean; id?: string; reason?: string }> {
    this.agentPresentation(opts.agentMetadata)
    const driver = this.opts.claudeDesktopDriver
    const actuator = this.opts.claudeActuator
    if (!driver || !actuator) return { ok: false, reason: 'no-backend' }
    if (!intent.trim()) return { ok: false, reason: 'empty-intent' }

    const before = new Set((await driver.list()).map((t) => t.sessionId))
    if (opts.agentMetadata) this.claudeAgentCreations++
    try {
    const receipt = opts.agentMetadata ? { id: randomUUID(), before: [...before], metadata: opts.agentMetadata, acknowledged: false, intent, startedAt: this.clock() } : undefined
    if (receipt) await this.updateDesktopReceipts(items => {
      if (items.some(item => this.clock() - (item.startedAt || 0) < 120_000)) {
        throw new Error('A prior Desktop handoff is unresolved; wait for reconciliation before creating another')
      }
      return [...items, receipt]
    })
    const res = await actuator.createTask(intent)
    if (!res.ok) {
      if (receipt) await this.updateDesktopReceipts(items => items.filter(item => item.id !== receipt.id))
      log.warn('claude-desktop-create-failed', { reason: res.reason ?? 'unknown' })
      return { ok: false, reason: res.reason ?? 'failed' }
    }
    if (receipt) await this.updateDesktopReceipts(items => items.map(item => item.id === receipt.id ? { ...item, acknowledged: true } : item))

    // The store is written asynchronously, so poll rather than read once.
    const tries = opts.tries ?? 10
    const waitMs = opts.waitMs ?? 500
    for (let i = 0; i < tries; i++) {
      const fresh = (await driver.list()).filter((t) => !before.has(t.sessionId))
      if (fresh.length && (!opts.agentMetadata || fresh.length === 1)) {
        // Newest by activity among the genuinely NEW ones — the before-set has
        // already excluded every pre-existing conversation.
        const created = fresh.sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0]
        const [id] = await this.adoptClaudeDesktop({ only: new Set([created.sessionId]), cap: 1, agentMetadata: opts.agentMetadata })
        log.event('claude-desktop-create-resolved', { sessionId: created.sessionId, attempts: i + 1, adopted: !!id })
        return { ok: true, id }
      }
      await new Promise((r) => setTimeout(r, waitMs))
    }
    // The conversation was almost certainly created — we just cannot name it.
    // Saying so beats claiming failure for work that DID start.
    log.warn('claude-desktop-create-unresolved', {})
    return { ok: true, reason: 'id-unresolved' }
    } finally {
      if (opts.agentMetadata) this.claudeAgentCreations--
    }
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
  private async claudeDesktopAddress(task: Task): Promise<string | undefined> {
    if (task.origin !== 'unmute-agent') return task.name
    if (!task.claudeDesktopSessionId) return undefined
    const native = await this.opts.claudeDesktopDriver?.find(task.claudeDesktopSessionId)
    return native?.title || undefined
  }

  async sendClaudeDesktop(id: string, text: string): Promise<{ ok: boolean; reason?: string }> {
    const task = this.tasks.get(id)
    if (!task || task.agent !== 'claude-code-desktop') return { ok: false, reason: 'not-a-claude-desktop-task' }
    const actuator = this.opts.claudeActuator
    if (!actuator) return { ok: false, reason: 'no-actuator' }
    if (task.state === 'needs-user') return { ok: false, reason: 'answer-the-prompt-first' }
    const title = await this.claudeDesktopAddress(task)
    if (!title) return { ok: false, reason: 'no-title-to-address' }

    this.noteFollowUp(task) // graduation (§5) — counts the attempt, same as followUp()
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
    this.noteFollowUp(task) // graduation (§5) — answering a prompt is real engagement
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
  private async pollClaudeDesktop(id: string): Promise<void> {
    const task = this.tasks.get(id)
    // A DONE THREAD IS NOT A CLOSED THREAD.

    // `ready` used to mean "finished this turn, still continuable" and was
    // deliberately non-terminal here, so the poller kept watching in case the
    // user carried on inside the external app. With `ready` folded into `done`,
    // stopping on `done` would have silently ended that watch — a turn you
    // continued in Claude Desktop or Codex would never have come back to us.
    // So the guard is on `failed` and on ERRANDS: a one-off that finished is
    // genuinely over, a thread that finished is merely resting.
    if (!task || !task.claudeDesktopSessionId || task.state === 'failed') return
    if (task.state === 'done' && (task.kind ?? 'oneoff') !== 'session') return
    const driver = this.opts.claudeDesktopDriver
    if (!driver) return
    const tlog = log.child({ taskId: id })

    // Latency shortcut, attached lazily once a transcript exists. fs.watch
    // coalesces and can miss events, so the poll above stays the correctness
    // backstop and this never becomes the only path.
    if (!this.claudeWatchers.has(id)) {
      this.claudeWatchers.set(id, () => {})   // claim the slot; no double-attach
      void driver.watch(task.claudeDesktopSessionId, () => { this.scheduler.trigger(id) })
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
    if (meta.title && meta.title !== task.name && task.origin !== 'unmute-agent' && !task.nameSetByUser) task.name = meta.title
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
      if (meta.title && !titles.includes(meta.title)) titles.push(meta.title)
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

    if (advanced && task.state === 'done') {
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
      this.transition(id, 'done')
    }
  }

  /**
   * Poll a Codex CLI task by reading its rollout.
   *
   * Two phases, because the session id is DISCOVERED rather than assigned:
   * Codex mints its own, so a freshly spawned task has no id until Codex has
   * written one. Until then each poll looks for the rollout that appeared in
   * our cwd at-or-after our spawn; once found it is pinned and never looked up
   * again.
   */
  private async pollCodexCli(id: string): Promise<void> {
    const task = this.tasks.get(id)
    if (!task) return
    // THE PROTOCOL WINS. When the hub owns this thread, state arrives pushed and
    // this reader would be a second, slower opinion derived from Codex's
    // internal storage — the one that already went stale once when the rollout
    // format changed. Two writers for one task's state is how a card flickers
    // between "done" and "working".
    //
    // This path stays for the tasks the hub does NOT own: sessions rehydrated
    // after a restart, imports the user started in their own terminal, and a
    // Codex too old for `app-server`.
    if (this.opts.codexHub?.threadIdFor(id)) return
    const tlog = log.child({ taskId: id })

    if (!task.codexRolloutId) {
      const found = await discoverSessionId(task.cwd, task.createdAt)
      if (!found) return                       // Codex has not written one yet
      task.codexRolloutId = found
      // The rollout id IS the session id for resume — `codex resume <uuid>`.
      if (!task.sessionId || task.sessionId === id) task.sessionId = found
      tlog.event('codex-cli-session-pinned', { sessionId: found })
      void this.persistState(task).catch(() => {})
      // A ROLLOUT EXISTS, SO CODEX TOOK THE TURN. The prover polls for this
      // independently, but the poller is the component that actually discovers
      // it - saying so here removes the race between the two entirely, rather
      // than relying on the prover's window being long enough.
      this.noteDeliveryProven(task.id, 'codex-rollout-discovered')
    }

    const path = await findRollout(task.codexRolloutId)
    if (!path) return                          // archived mid-read, or gone
    this.ensureTranscriptWatcher(id, path)
    const read = await this.transcriptFiles.read(path)
    if (read.missing || !read.changed) return
    const events = parseRolloutJsonl(read.text)
    const { status, lastActivityAt } = rollupCodexEvents(events, {
      now: new Date(this.clock()).toISOString(),
      kind: (task.kind ?? 'oneoff') === 'session' ? 'session' : 'oneoff',
    })
    if (lastActivityAt) task.lastHeartbeatMs = lastActivityAt
    // The chat view is fed from here, not from a hook Codex never fires. This
    // is also what makes a rehydrated session readable: the rollout outlives
    // the app, so a task resumed after a restart shows its history immediately.
    // Same file, richer reading — see refreshCodexBlocks.
    await this.refreshCodexBlocks(task, path, read.text)
    const turns = conversationFromCodexEvents(events)
    if (turns.length) {
      const changed = turns.length !== (task.conversation?.length ?? 0)
        || turns[turns.length - 1].text !== task.conversation?.[task.conversation.length - 1]?.text
      if (changed) {
        task.conversation = turns
        // Diagnosable on purpose: this path emitted nothing, so the only way to
        // tell whether a card's chat view was being fed was to read meta.json
        // off disk. That blind spot is part of why the empty view went unseen.
        tlog.event('codex-cli-conversation-refreshed', {
          turns: turns.length, rolloutId: task.codexRolloutId,
        })
        this.emit('updated', task)
        void this.persistState(task).catch(() => {})
      }
    }
    if (!status) return
    // Unchanged state with no new text is not news — transitioning on every
    // poll would rewrite updatedAt once a second and shove the task to the top
    // of the wall forever.
    const sameState = task.state === status.state
    const sameText = (task.result?.detail ?? '') === (status.result?.detail ?? '')
    if (sameState && sameText) return
    this.transition(id, status.state, status, lastActivityAt ?? undefined)
  }

  /**
   * Load a task's chat view on demand, whatever its state.
   *
   * THE POLLERS ARE NOT ENOUGH FOR AN OLD THREAD. A finished one-off is not
   * polled at all — `pollCodexDesktop` returns immediately for it — and a
   * finished session polls at a tenth of the rate. Both are correct as watching
   * policy and both are wrong as a way to fill a panel someone just opened.
   *
   * The source file outlives the card, and outlived the version of Unmute that
   * could not read it, so a conversation from weeks ago fills in completely the
   * first time it is looked at. Safe to call repeatedly: blocksChanged() makes a
   * re-read with nothing new a no-op.
   */
  private historyLoads = new Map<string, Promise<void>>()
  async loadBlocksFor(id: string, retry = false): Promise<void> {
    const task = this.tasks.get(id)
    if (!task) return
    if (this.historyLoads.has(id)) return this.historyLoads.get(id)
    if (!retry && task.history && task.history.phase !== 'empty' && task.history.phase !== 'loading') return
    if (task.chatUnstarted) {
      if (task.history?.phase !== 'empty') { task.history = { phase: 'empty' }; this.emit('updated', task) }
      return
    }
    const load = Promise.resolve().then(async () => {
      task.history = { phase: 'loading' }; this.emit('updated', task)
      sessionLifecycleDev('history-load-started', { taskId: id, provider: task.agent ?? null, sessionId: task.sessionId })
      try { await this.loadTaskHistory(task, retry) }
      catch (error) { task.history = { phase: task.blocks?.length || task.conversation?.length ? 'partial' : 'failed', reason: (error as Error).message, canRetry: true } }
      if (task.history?.phase === 'loading') task.history = task.blocks?.length ? { phase: 'ready' } : { phase: 'missing', reason: 'No readable history was found for this session.', canRetry: true }
      sessionLifecycleDev('history-load-finished', { taskId: id, provider: task.agent ?? null, sessionId: task.sessionId, phase: task.history.phase, blocks: task.blocks?.length ?? 0 })
      this.emit('updated', task)
    }).finally(() => this.historyLoads.delete(id))
    this.historyLoads.set(id, load)
    return load
  }

  private async loadTaskHistory(task: Task, retry: boolean): Promise<void> {
    const id = task.id
    if (task.claudeSessionSettings) {
      await this.claudeHistoryWrites.get(id)
      const recovered = await readClaudeHistory(task)
      task.history = recovered.history
      if (recovered.frames.some(f => f.type === 'user' || f.type === 'assistant')) {
        const live = this.claudeTasks.get(id)?.channel
        if (live) {
          live.mergeHistory(recovered.frames)
          // The merged, complete frames are now being saved. Only then may the
          // marker go; a partial read keeps it so the next open recovers again.
          if (recovered.history.phase === 'ready') {
            const failedBefore = task.deliveryError
            await this.claudeHistoryWrites.get(id)
            // The writer reports a failed save only through deliveryError.
            const saveFailed = task.deliveryError !== failedBefore && task.deliveryError?.startsWith('Could not save chat history')
            if (!saveFailed) await fs.rm(join(task.home, CLAUDE_HISTORY_STALE_MARKER), { force: true })
          }
        } else {
          const parsed = blocksFromClaudeTranscript(ClaudeTaskChannel.displayTranscript(recovered.frames))
          // Block-only legacy/local display has no UUIDs to reconcile safely.
          // Keep it intact until complete history can replace it; partial raw
          // recovery remains available for the next exact-session retry.
          if (recovered.history.phase === 'ready' || !task.blocks?.length && !task.conversation?.length) task.blocks = parsed.blocks
          // Only a COMPLETE read earns the mark. A partial one still leaves
          // earlier messages on disk, so the card must keep offering to fetch.
          if (recovered.history.phase === 'ready') task.blocksDurable = true
          if (parsed.usage) task.usage = parsed.usage
        }
      }
      if (task.history.phase === 'missing' && (task.blocks?.length || task.conversation?.length)) task.history = { ...task.history, phase: 'partial' }
      return
    }
    if (task.codexSessionSettings) {
      // History is a read operation. Resuming here used to acquire app-server
      // writer ownership first, so an existing writer turned a fully readable
      // rollout into “Conversation history is unavailable.”
      await this.refreshCodexBlocks(task, undefined, undefined, true)
      // The rollout IS the durable record; a Codex card has no replay tail.
      task.blocksDurable = true
      return
    }
    if (task.agent === 'codex' || isExternalAgent(task.agent)) {
      await this.refreshCodexBlocks(task)
      return
    }
    // BY SESSION ID, WHEREVER IT NOW LIVES.
    //
    // findTranscriptById checks the folder derived from cwd first and then
    // SEARCHES for the id, because the folder is derived from the session's
    // CURRENT directory and moves with it — a session that enters a git
    // worktree takes its transcript along. The id never moves. See
    // transcript-locate.ts for the field record.
    //
    // THE DIRECTORY FALLBACK IS FOR SCRATCH TASKS ONLY. "Newest .jsonl in the
    // folder" is unique exactly when the folder belongs to one task — which is
    // true of a scratch home (named after the task id) and false of every
    // project-bound task, where several tasks and the user's own terminal
    // sessions share one repo. Applied to a project cwd it silently binds a
    // card to whichever session touched that repo last: on 2026-08-30 it put
    // 5.4 MB of a different, live conversation onto task 87083840's card and
    // followed it as it grew. An empty panel is correct; someone else's
    // transcript is not.
    const byId = task.sessionId ? await findTranscriptById(task.cwd, task.sessionId) : null
    const path = byId
      ?? (task.cwd === task.home ? await locateTranscript(task.cwd) : null)
    if (path) {
      this.ensureTranscriptWatcher(id, path)
      await this.refreshClaudeBlocks(task, path, log.child({ taskId: id }))
    }
  }

  /** Refresh a Claude Code task's chat blocks from its transcript. */
  private async refreshClaudeBlocks(task: Task, path: string, tlog: ReturnType<typeof log.child>): Promise<void> {
    const read = await this.transcriptFiles.read(path)
    if (read.missing || !read.changed) return
    const { blocks, usage } = blocksFromClaudeTranscript(read.text)
    if (!blocks.length) return
    if (!blocksChanged(task.blocks, blocks)) return
    task.blocks = blocks
    if (usage) task.usage = usage
    tlog.event('blocks-refreshed', {
      blocks: blocks.length, agent: task.agent,
      bytesRead: read.bytesRead, recovered: read.recovered,
    })
    this.emit('updated', task)
    void this.persistState(task).catch(() => {})
  }

  /**
   * Refresh a Codex task's chat blocks from its rollout file.
   *
   * SERVES BOTH CODEX LANES. Desktop has nothing else; CLI uses it for the
   * tasks the hub does not own — a session rehydrated after a restart, an
   * import the user started in their own terminal, or a Codex too old for
   * app-server. When the hub DOES own the thread its pushed blocks are richer
   * (streaming deltas, live plan) and win, so this never overwrites them.
   */
  private async refreshCodexBlocks(task: Task, knownPath?: string, knownText?: string, forceFullRead = false): Promise<void> {
    const rolloutId = task.codexRolloutId ?? task.codexThreadId ?? task.sessionId
    if (!rolloutId) return
    const path = knownPath ?? await findRollout(rolloutId)
    if (!path) return
    this.ensureTranscriptWatcher(task.id, path)
    let text = knownText
    if (text === undefined) {
      if (forceFullRead) text = await fs.readFile(path, 'utf8')
      else {
        const read = await this.transcriptFiles.read(path)
        if (read.missing || !read.changed) return
        text = read.text
      }
    }
    const { blocks, usage } = blocksFromRollout(text)
    if (!blocks.length) return
    if (!blocksChanged(task.blocks, blocks)) return
    task.blocks = blocks
    if (usage) task.usage = usage
    this.emit('updated', task)
    void this.persistState(task).catch(() => {})
  }

  /** How many user turns Codex has recorded for this task on disk.
   *
   * Zero when there is no rollout yet, which is the honest answer: nothing has
   * been proven. A count rather than a boolean so a reply can be told apart
   * from whatever was already in the thread. */
  private async codexUserTurns(task: Task): Promise<number> {
    const rolloutId = task.codexRolloutId ?? task.sessionId
    if (!rolloutId) return 0
    const path = await findRollout(rolloutId)
    if (!path) return 0
    const events = await readRolloutEvents(path)
    return conversationFromCodexEvents(events).filter((turn) => turn.role === 'user').length
  }

  /** How many user turns Claude Code has recorded for this task's transcript on
   *  disk — the SAME durable-authority pattern as codexUserTurns above, for the
   *  PTY-hosted `claude` CLI's own JSONL.
   *
   *  WHY THIS EXISTS: deliverDraft's landed() used to trust ONLY the
   *  UserPromptSubmit hook for a Claude session — a live, in-process signal
   *  that has to be scheduled and fired promptly to be seen inside
   *  verifyAfterMs. Observed in the field: a task whose tool calls were
   *  hanging (an MCP server not responding) delayed that hook past the
   *  verification window even though the CLI had already accepted the prompt
   *  and started working on it. deliverDraft then reported the reply as
   *  FAILED and kept it in the draft (draftRetained: true, by design — see
   *  that function's own comment) so nothing typed would be silently lost.
   *  The next capture appended its own text onto that already-delivered,
   *  merely-unconfirmed draft and resent the whole growing blob — visible in
   *  a real session as the same sentence retyped into the terminal, longer,
   *  several times in a row.
   *
   *  Claude Code appends the user's turn to its transcript the moment it
   *  accepts the prompt — before any tool call that follows runs — so this
   *  count is not subject to the same stall that can delay the hook. */
  private async claudeUserTurns(task: Task): Promise<number> {
    if (!task.sessionId) return 0
    // Same rule as loadBlocksFor: search by id, and only fall back to "newest
    // in the folder" when that folder is this task's own scratch home. Counting
    // ANOTHER session's user turns would mis-decide whether this one is stuck.
    const path = (await findTranscriptById(task.cwd, task.sessionId))
      ?? (task.cwd === task.home ? await locateTranscript(task.cwd) : null)
    if (!path) return 0
    try {
      const raw = await fs.readFile(path, 'utf8')
      return parseTurns(raw).filter((turn) => turn.role === 'user').length
    } catch {
      return 0
    }
  }

  private async pollCodexDesktop(id: string): Promise<void> {
    const task = this.tasks.get(id)
    // NOTE: `ready` is deliberately NOT terminal for this backend — the Codex
    // thread outlives our card and the user can continue it inside Codex, so we
    // keep watching. Only done/failed stop the watch.
    // Same rule as the Claude poller: see A DONE THREAD IS NOT A CLOSED THREAD.
    if (!task || !task.codexThreadId || task.state === 'failed') return
    if (task.state === 'done' && (task.kind ?? 'oneoff') !== 'session') return
    const driver = this.opts.codexDriver
    if (!driver) return
    const tlog = log.child({ taskId: id })

    // A `ready` Codex task is watched only in case the user CONTINUES it inside
    // Codex — a rare, human-paced event. Polling that at the live cadence meant
    // reading the rollout off disk once a second, forever, for every finished
    // task on the wall (seen in the field on dev.34). Back off hard; a task that
    // is actually working still polls at full rate.
    // Latency shortcut, attached lazily on the first poll that finds a
    // transcript: Codex appending wakes us immediately instead of waiting for
    // the next tick — which for a `ready` task is up to 10s away because of the
    // backoff above, and `ready` is exactly when the user is watching. The poll
    // remains the correctness backstop; fs.watch coalesces and can miss events,
    // so this never becomes the only path.
    if (!this.codexWatchers.has(id) && driver.watch) {
      this.codexWatchers.set(id, () => {})   // claim the slot; no double-attach
      void driver.watch(task.codexThreadId, () => { this.scheduler.trigger(id) })
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
    // THE CHAT VIEW, from the same file the snapshot came from. Read separately
    // rather than derived from `snap.turns`, because that projection has already
    // thrown away exit codes, diffs, MCP identity and search results — the whole
    // point of blocks is to keep what it dropped.
    await this.refreshCodexBlocks(task)

    if (snap.state === 'failed') { this.transition(id, 'failed', { state: 'failed', error: { reason: 'Codex reported an error' } } as StatusPayload); return }

    tlog.debug('codex-poll', {
      state: snap.state, turnsStarted: snap.turnsStarted, everCompleted: snap.everCompleted,
      hasHeadline: !!snap.lastAgentMessage, taskState: task.state,
    })

    // A Codex thread OUTLIVES our card: the user can keep talking to it inside
    // Codex, and a new turn there must re-open the task here rather than being
    // invisible. So `ready` is a resting state, not a terminal one — if the
    // rollout shows another turn started, come back to processing.
    if (snap.state === 'processing' && task.state === 'done') {
      tlog.event('codex-reopened', { turnsStarted: snap.turnsStarted, note: 'continued inside Codex' })
      this.transition(id, 'processing')
      return
    }

    if (snap.state === 'ready' && snap.everCompleted) {
      // A completed Codex turn is `ready`, never `done`: the step is over but the
      // ball is with the user and the thread is always continuable
      // (ORCHESTRATE-VISION §3, three kinds of done). The existing ready decay
      // valve then settles an ignored one-off to done on its own.
      if (task.state !== 'done') {
        // snap.updatedAt is the newest event in the rollout — i.e. when the turn
        // actually finished. Passing it is what stops a relaunch replaying
        // yesterday's completion as if it were new.
        this.transition(id, 'done', {
          state: 'done',
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
    this.noteUserInput(task, 'codex-desktop-follow-up')
    this.noteFollowUp(task)
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

  private startPolling(id: string): void {
    const tlog = log.child({ taskId: id })
    // Idempotent registration replaces the job under the same key. Unlike the
    // former Map<task,setInterval>, this never creates a second native timer.
    this.scheduler.register(id, () => this.poll(id), () => this.reconcileMsFor(id))
    tlog.event('polling-started', {
      mode: 'event-first', reconcileMs: this.reconcileMsFor(id), staleMs: this.opts.staleMs,
    })
  }

  private reconcileMsFor(id: string): number {
    const task = this.tasks.get(id)
    if (!task) return this.opts.dormantReconcileMs
    // Session discovery is the one phase that has neither a provider event nor
    // a watchable file. Keep the former 1s cadence only for this short window;
    // once the durable id exists the provider watcher becomes primary.
    if (task.agent === 'codex' && !task.codexRolloutId && !this.opts.codexHub?.threadIdFor(id)) {
      return this.opts.pollMs
    }
    if (isExternalAgent(task.agent) && TERMINAL.includes(task.state)) return this.opts.dormantReconcileMs
    if (task.kind === 'session' && task.state !== 'processing') return this.opts.idleRuntimeReconcileMs
    return this.opts.activeReconcileMs
  }

  private handlePollError(id: string, error: unknown): void {
    const tlog = log.child({ taskId: id })
    if (isRolloutIntegrityError(error)) {
      // Corruption is deterministic, not transient. Keep the tmux runtime
      // attached and visible, but stop the rollout reader that would throw
      // forever and overload Electron's main process.
      this.stopPolling(id)
      tlog.error('polling stopped: rollout integrity failure', { error: (error as Error).message })
      return
    }
    tlog.error('poll error', { error: error instanceof Error ? error.message : String(error) })
  }

  private async poll(id: string): Promise<void> {
    const task = this.tasks.get(id)
    if (task?.claudeSessionSettings || task?.codexSessionSettings) return
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
    // CODEX CLI READS A ROLLOUT, NOT A STATUS FILE.
    //
    // Everything below this line polls status.json — the file Claude writes
    // because Unmute installs hooks telling it to. Codex is given no hooks and
    // writes no status.json, so it would have fallen through here, found
    // nothing, and sat at its first state forever.
    //
    // It needs none: Codex already records every turn to a rollout for its own
    // reasons, and those records are a richer signal than the hooks we ask
    // Claude for (cli-observer.ts). Reading a file it already writes is also
    // what keeps the observe-never-modify rule true for this backend without
    // any work at all.
    if (task && task.agent === 'codex') return this.pollCodexCli(id)
    if (!task || TERMINAL.includes(task.state)) return
    const tlog = log.child({ taskId: id })

    // CLAUDE'S CHAT VIEW HAS TO KEEP UP WITH THE TERMINAL.
    //
    // Blocks used to refresh only when a turn ENDED, so a working Claude task
    // showed the prompt and nothing else while its terminal filled with tool
    // calls — the one moment the panel is most worth looking at. Claude Code
    // appends each entry to the transcript as it happens, so the data was
    // always there; nothing was reading it.
    //
    // Only while the turn is live: a settled task is refreshed on open, and
    // re-reading a finished transcript once a second is pure cost.
    if (task.state === 'processing') {
      void this.loadBlocksFor(id).catch(() => {})
    }

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
      // NO NUDGE. We used to write one Enter here, on the theory that a task is
      // sometimes a single keystroke short of continuing. That theory was built
      // on a verdict we now know was usually wrong: with the terminal silent AND
      // no hooks (see notePtyLiveness), `stuck` is rare and real — and typing
      // into a session because we are unsure what it is doing is exactly the
      // move that can turn "slow" into "answered the wrong prompt". Surface it
      // to the user and let them decide (check / kill / retry).
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
    const task = this.tasks.get(id)
    if (!task) return
    const tlog = log.child({ taskId: id })
    const prev = task.state
    // A TASK THE USER STOPPED DID NOT FAIL.
    //
    // status.json is written by Claude Code itself, through the hooks Unmute
    // installs, and a session cut off mid-turn writes a FAILURE carrying its
    // own account of the transcript as the reason — "[…_diagnostic]
    // result_type=user last_content_type=n/a stop_reason=null". That is a true
    // description of an interrupted transcript and a useless thing to read, in
    // red, under "Errored", on a card you have just pressed Stop on.
    //
    // Unmute is the one that knows why the session ended, because Unmute ended
    // it. `kill` already settles a stop this way when nothing was running
    // (turnOutcome 'cancelled', no reason); this is the same verdict for the
    // case where a turn WAS running and the backend got its word in first.
    //
    // A ONE-SHOT CLAIM ON THE NEXT TERMINAL STATE, never a time window. And it
    // is dropped the moment the task runs again, so a genuine failure after a
    // resume is still a failure.
    if (!TERMINAL.includes(next)) this.stoppedByUser.delete(id)
    else if (this.stoppedByUser.delete(id)) {
      tlog.event('task-stopped-by-user', { reported: next, reason: payload?.error?.reason ?? null })
      task.turnOutcome = 'cancelled'
      task.error = undefined
      payload = { ...payload, error: undefined }
      if (next === 'failed') next = 'done'
    }
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
    // A CAPTION MUST NOT OUTLIVE ITS PICTURE.
    //
    // `step` is "what I am doing right now", written while the task runs, and
    // nothing ever cleared it. So a task that finished at 10:43 kept announcing
    // what it was doing at 10:42 — for hours. On screen that reads as a task
    // stuck in working, beside a badge that correctly says done, because the
    // badge is `state` and the sentence under it is `step`. Two fields, one
    // updated, one not.
    //
    // Reaching a terminal state means there is no longer a current step. Clear
    // it and the card falls through to `result.summary`, which is what the task
    // actually produced.
    if (TERMINAL.includes(next)) task.step = undefined
    if (payload?.result) task.result = payload.result
    if (payload?.error) task.error = payload.error
    if (payload?.question) task.question = payload.question
    if (payload?.recipe_suggestion) task.recipeSuggestion = payload.recipe_suggestion
    if (payload?.thread_context) task.threadContext = String(payload.thread_context).slice(0, 600)

    if (prev !== next) {
      // `reason` exists because a card once flipped done→processing→done nine
      // times in twenty-three seconds and the log could not say what asked for
      // any of it. A transition without a reason is a transition nobody can
      // debug.
      tlog.event('state-transition', { from: prev, to: next, step: payload?.step, reason: (payload as { reason?: string } | undefined)?.reason ?? null })
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
        //
        // KIND OUTRANKS CATEGORY. This checked category alone, so a persistent
        // SESSION whose subject happened to be video was torn down as though
        // the user had walked away from a clip. Field record 2026-08-29, task
        // 254ba44a: 51 minutes of work that produced an artifact and a file on
        // disk, ended with `/exit` and a tmux kill-session 1500ms later —
        // while the same task had logged `parked-warm {persistent: true}`
        // earlier in its life from the other mechanism.
        //
        // Two rules disagreeing about one task, and the one that knows nothing
        // about lifetime was winning. `kind: session` means hours can pass
        // between done and the next spoken follow-up; the subject cannot end
        // that. `category` still decides teardown for everything the user
        // genuinely walks away from, which is what it was written for.
        const fireAndForget = task.category === 'consume' || task.category === 'watch'
        if (fireAndForget && task.kind !== 'session') {
          this.detachAndKill(id)
        } else {
          this.parkWarm(id)
        }
        // Keep the on-disk record current, so a relaunch restores the history
        // instead of re-deriving it. Best-effort: a task whose meta cannot be
        // written still works for this run, it just forgets across a restart.
        // (Inherited from the `ready` case when the two merged — a finish is a
        // finish, and it is exactly the transition worth persisting.)
        if (task.claudeSessionSettings || task.agent === 'codex' || isExternalAgent(task.agent)) void this.persistState(task)
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
   *
   * Returns FALSE only when the answer was REFUSED and the task is still blocked
   * on the very same question — an open picker Unmute will not drive. The caller
   * must not advance the crank on false, or the user is carried away from the
   * question they still have to go answer. A dead session is not this case: the
   * answer went nowhere, but the task is over, so the crank may move on.
   */
  answer(id: string, userAnswer: string, revived = false): boolean {
    const tlog = log.child({ taskId: id })
    // Codex desktop: answering IS the next turn — there is no separate blocked
    // channel to write into, and no PTY liveness to check (the thread always
    // exists in the app). followUpCodexDesktop already does the send, the
    // consent clock, and the optimistic transition.
    const target = this.tasks.get(id)
    if (target && !target.claudeSessionSettings && !target.codexSessionSettings && !isExternalAgent(target.agent) && this.opts.claudeSessionOptions) {
      target.deliveryError = target.importedFromCli ? 'Externally owned sessions are read-only here. Start a new conversation.' : 'Resume this legacy conversation in graphical chat before sending.'
      this.emit('updated', target)
      return false
    }
    if (target?.claudeSessionSettings || target?.codexSessionSettings) {
      target.deliveryError = 'Use the conversation composer or the current question controls. This legacy input path cannot acknowledge a structured answer.'
      this.emit('updated', target)
      return false
    }
    // Claude desktop FIRST. isExternalAgent is true for every driver backend,
    // so without this a Claude Desktop reply fell into the Codex path below and
    // was dropped by its `!codexThreadId` guard — the user types, nothing
    // happens, nothing is logged. Same shape as the poll and probe bugs.
    if (target && target.agent === 'claude-code-desktop') {
      tlog.ui('task-row.answer-submitted', { answer: userAnswer })
      void this.answerOrSendClaudeDesktop(id, userAnswer)
      return true
    }
    // CODEX CLI ON THE APP SERVER. The reply goes over the protocol, not typed
    // into a PTY — and if a turn is blocked on an approval, `hub.send` answers
    // THAT rather than starting a new one (see hub.send). Routed before the
    // executor checks below, which are all about a process we own; here the
    // thread is the session and the terminal is only a view of it.
    if (target && target.agent === 'codex' && this.opts.codexHub?.threadIdFor(id)) {
      tlog.ui('task-row.answer-submitted', { answer: userAnswer })
      target.conversation = [...(target.conversation ?? []), { role: 'user', text: userAnswer }]
      this.noteUserInput(target, 'codex-cli-answer')
      this.noteFollowUp(target) // graduation (§5)
      void this.opts.codexHub.send(id, userAnswer, { effort: target.codexSessionSettings?.effort ?? this.opts.codexCliChoice?.().effort }).then((ok) => {
        if (!ok) tlog.warn('codex-cli reply not delivered', {})
      })
      return true
    }
    if (target && isExternalAgent(target.agent)) {
      tlog.ui('task-row.answer-submitted', { answer: userAnswer })
      // An outstanding APPROVAL is answered through the hook, not the composer:
      // typing "Approve" into the chat would leave the permission dialog still
      // waiting and add a stray message to the user's thread.
      if (this.answerCodexApproval(target, userAnswer)) return true
      this.followUpCodexDesktop(id, userAnswer)
      return true
    }
    const ex = this.executors.get(id)
    if (!ex || !ex.alive) {
      // A COLD SESSION IS REVIVED BY YOUR MESSAGE, NOT BY YOUR CURIOSITY.
      //
      // This dropped the message and returned TRUE — reporting success for
      // something that went nowhere, so the crank advanced past a task whose
      // reply had vanished. The reason nobody noticed is that opening a task
      // auto-resumed it (`opened()`), so by the time you typed there was
      // usually a live session. That auto-resume is what rewrote a five-day-old
      // task's `updatedAt` to now and threw it into Today, at the top of the
      // wall, saying "Working" — the cost of reading being paid as if it were
      // working.
      //
      // The revive belongs here instead. Sending IS the interaction, and it is
      // the moment there is something real to record. Queued and delivered when
      // the session is ready, so we swap a silent drop for an actual delivery
      // rather than for a different silent drop.
      // `revived` stops this recursing: one attempt, then the honest warning.
      if (!revived && target && (target.kind ?? 'oneoff') === 'session' && !this.resuming.has(id)) {
        tlog.event('revive-on-send', { queued: userAnswer.length })
        void this.resume(id)
          .then((ok) => {
            if (!ok) { tlog.warn('revive-on-send did not take — message not delivered', {}); return }
            // Re-enter with the session up. `revived` guarantees this is the
            // last attempt, so a resume that lies about succeeding warns rather
            // than spinning.
            this.answer(id, userAnswer, true)
          })
          .catch((e) => tlog.error('revive-on-send threw', { error: (e as Error).message }))
        return true
      }
      tlog.warn('answer dropped — no live session', {})
      return true
    }
    const answered = this.tasks.get(id)
    if (answered) {
      this.noteUserInput(answered, 'terminal-answer') // consent clock
      // Graduation (§5) — covers BOTH sub-branches below (the numbered-
      // picker index answer and the freeform writeStdin fallback), since
      // both are the same "user answered this task" moment.
      this.noteFollowUp(answered)
    }
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
    // We drive the picker ONLY for the shape we proved on a live session: one
    // question, single-select. Anything else is a tab bar (pick, auto-advance,
    // toggle, Tab to an unnumbered Submit, Enter) — a sequence we have watched
    // but never driven through a PTY, and half-driving it leaves the model
    // waiting on a picker nobody is holding. Those go to the terminal.
    const ask = answered?.openAsk
    const idx = ask && isAnswerable(ask.questions)
      ? ask.questions[0].options.findIndex((o) => o.label.trim().toLowerCase() === userAnswer.trim().toLowerCase())
      : -1
    if (idx >= 0 && idx < 9) {
      if (answered?.openAsk) answered.openAsk.answeredWith = ask!.questions[0].options[idx].label
      ex.write(String(idx + 1))
      tlog.event('answered-by-index', { index: idx + 1, label: userAnswer })
      const t = this.tasks.get(id)
      if (t && t.state === 'needs-user') {
        t.state = 'processing'
        t.updatedAt = this.clock()
        this.emit('updated', t)
      }
      return true
    }

    // AN OPEN PICKER IS NOT A PROMPT — SO WE SEND NOTHING.
    //
    // If an ask is open and the branch above did not drive it, the session is
    // rendering a picker right now. `writeStdin` below assumes a text input: it
    // types the answer and follows with Enter. At a picker that is not an
    // answer, it is prose landing on a widget that ignores most of it and an
    // Enter that commits WHATEVER IS HIGHLIGHTED — option 1. That is the exact
    // corruption the index branch above exists to prevent, arriving through the
    // fallback path instead.
    //
    // So: refuse, say why, and hand the ask to the terminal. Two ways in here —
    // a shape we never drive (a tab bar, checkboxes, a plan), or an answerable
    // one where what the user said matches no option. Both mean the same thing
    // to the picker, so both get the same treatment.
    //
    // CLAUDE CODE CLI ONLY, by construction: `openAsk` is written from hook
    // events, and only a CLI session has hooks. Codex, Codex desktop and Claude
    // desktop returned far above; a CLI task with no open picker still falls
    // through to `writeStdin` exactly as before.
    if (ask) {
      const shaped = isAnswerable(ask.questions)
      tlog.event('answer-refused-picker-open', {
        askId: ask.id, questions: ask.questions.length, answerable: shaped, said: userAnswer,
      })
      if (answered) {
        answered.deliveryError = shaped
          ? `"${userAnswer}" isn't one of the options — pick one in the terminal.`
          : 'This one has to be answered in the terminal.'
        // Promote the card to the refusal shape. An answerable ask that just
        // failed to match is, from here on, exactly as undrivable as the rest —
        // and the surface opens the terminal off this kind, so saying it here is
        // what actually gets the user to the picker.
        if (answered.question) answered.question = { ...answered.question, kind: 'terminal_only' }
        answered.updatedAt = this.clock()
        this.emit('updated', answered)
      }
      return false
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
    return true
  }

  /** Write a REPAIRED cwd through to meta.json.
   *
   *  Not persistState: that merges only state, updatedAt and the conversation,
   *  and early-returns when none of the three has moved — so a heal routed
   *  through it would hold for this run and come back broken on the next. */
  private async persistCwd(task: Task): Promise<void> {
    const path = join(task.home, 'meta.json')
    const meta = JSON.parse(await fs.readFile(path, 'utf8')) as Record<string, unknown>
    await writeFileAtomic(path, JSON.stringify({ ...meta, cwd: task.cwd }, null, 2))
  }

  /** Merge the observed provider identity, state, timestamp and conversation
   *  into the task's meta.json. */
  private async persistState(task: Task): Promise<void> {
    // Share the per-task queue with configuration and draft lifecycle updates;
    // concurrent read/merge/write operations must not restore stale settings.
    this.mergeMeta(task, {
      state: task.state, updatedAt: task.updatedAt,
      intent: task.intent,
      name: task.name,
      nameSetByUser: task.nameSetByUser === true,
      group: task.group,
      groupId: task.groupId,
      chatUnstarted: task.chatUnstarted === true,
      continuationPending: task.continuationPending === true,
      sessionOwnership: task.sessionOwnership,
      ...(task.sessionId ? { sessionId: task.sessionId } : {}),
      ...(task.codexRolloutId ? { codexRolloutId: task.codexRolloutId } : {}),
      continuationMode: task.continuationMode,
      continuationSources: task.continuationSources,
      continuationArtifacts: task.continuationArtifacts,
      continuationConfidence: task.continuationConfidence,
      claudeForkFromSessionId: task.claudeForkFromSessionId,
      claudeResumeSessionAt: task.claudeResumeSessionAt,
      conversation: task.conversation ?? [],
      turnOutcome: task.turnOutcome,
    }, 'state')
    await this.metaChains.get(task.id)
  }

  /** Instant kill (PRD §10.4). Closes the session; marks failed if not terminal. */
  /** Explicit user stop (PRD §10.4). Hard-kills the session immediately. */
  kill(id: string): void {
    if (this.followupScope(id)) this.emit('followup-disarm', { taskId: id })
    const tlog = log.child({ taskId: id })
    tlog.ui('task-row.killed', {})
    this.stoppedByUser.add(id)
    const task = this.tasks.get(id)
    if (task?.claudeSessionSettings) {
      this.chatStopVersion.set(id, (this.chatStopVersion.get(id) ?? 0) + 1)
      const runtime = this.claudeTasks.get(id)
      const noSession = () => this.transition(id, 'failed', { state: 'failed', error: { reason: 'Stopped before the session connected' } })
      if (!runtime) { noSession(); return }
      runtime.channel.requestStop()
      task.codexActivity = { kind: 'lifecycle', label: 'Cancelling' }
      this.emit('updated', task)
      // ALWAYS ASK THE RUNTIME. `driver.busy` is this process's projection of
      // the daemon and reads false across a reconnect (or before the replay
      // lands) while the daemon's turn keeps running — which is exactly when
      // the user is pressing Stop. The daemon's interrupt is a no-op on an
      // idle session, so asking costs nothing.
      void runtime.driver.interrupt().then(() => {
        if (this.claudeTasks.get(id) !== runtime || runtime.driver.busy) return // the result event settles it
        // Nothing was running (or it already ended): settle, never leave the
        // card saying "Cancelling" over an idle session.
        if (task.state === 'processing' || task.state === 'needs-user') {
          this.applyHubPatch({ taskId: id, state: 'done', activity: null, turnOutcome: 'cancelled', clearQuestion: true, errorReason: '' })
        } else if (task.codexActivity?.label === 'Cancelling') { task.codexActivity = undefined; this.emit('updated', task) }
      }, error => {
        task.codexActivity = undefined
        // The daemon holds no session at all: nothing is running to stop.
        if ((error as Error).message === CLAUDE_RUNTIME_RELEASED) { noSession(); return }
        task.deliveryError = `Could not stop Claude: ${(error as Error).message}`
        this.emit('updated', task)
      })
      return
    }
    // A stopped task must stop asking. Leaving the request on disk would keep
    // re-blocking a card the user just killed, and would hold the Codex hook
    // waiting for an answer that is never coming.
    if (task?.codexThreadId) { this.surfacedApprovals.delete(task.codexThreadId); void clearApproval(task.codexThreadId) }
    if (task?.codexSessionSettings) {
      const hub = this.opts.codexHub
      void (async () => {
        if (!hub) return false
        if (await hub.interrupt(id)) return true
        // NO TURN ID IS NOT "NOTHING RUNNING" — the projection may simply be
        // stale. Re-read the runtime's view once and try again before erroring.
        try { await hub.refreshTask(id) } catch { /* keep the stale view */ }
        if (hub.turnActive(id)) return hub.interrupt(id)
        // Genuinely no turn: there is nothing to stop, so settle the card
        // instead of reporting a failure to stop it.
        if (task.state === 'processing' || task.state === 'needs-user') {
          this.applyHubPatch({ taskId: id, state: 'done', activity: null, turnOutcome: 'cancelled', clearQuestion: true, errorReason: '' })
        } else if (task.codexActivity) { task.codexActivity = undefined; this.emit('updated', task) }
        return true
      })().catch(() => false).then((ok) => {
        if (!ok) {
          task.deliveryError = 'Could not stop Codex. Reconnect and try again.'
          task.codexActivity = undefined
          this.emit('updated', task)
        }
      })
      return
    }
    if (task && !SETTLED.includes(task.state)) {
      // STOPPING IS NOT FAILING.
      //
      // This settled an explicit stop as `failed` with "Stopped by you" as the
      // reason — the card's red Errored state, carrying a sentence explaining
      // that the user did the thing the user had just done. Red is for what
      // they did not ask for.
      //
      // `done` + `turnOutcome: 'cancelled'` is not a new vocabulary: it is what
      // the Claude and Codex branches above already settle a stop as when there
      // was no turn running. This is the same verdict for the plain case, and
      // going through transition() rather than assigning state here is what
      // makes the record, the notification and the librarian handoff match it.
      this.transition(id, 'done', { reason: 'stopped-by-you' } as Partial<StatusPayload>)
    }
    this.hardKill(id) // explicit stop ⇒ no warm window
  }

  /**
   * Remove a conversation: terminate its session and retire its visible record.
   * Project and legacy receipt trees stay in place; their contents are not
   * disposable merely because they were produced inside a task home.
   */
  async remove(id: string): Promise<void> {
    if (this.followupScope(id)) this.emit('followup-disarm', { taskId: id })
    const tlog = log.child({ taskId: id })
    tlog.ui('task-row.removed', {})
    const task = this.tasks.get(id)
    // Owned app-server threads have no PTY for hardKill() to close. Stop the
    // live turn before dropping its routing entry; otherwise removal hides a
    // task that Codex is still executing in the background.
    if (task?.codexSessionSettings && this.opts.codexHub?.threadIdFor(id)) {
      if (!(await this.opts.codexHub.stopAndRelease(id))) {
        task.deliveryError = 'Could not stop Codex, so the conversation was not removed.'
        this.emit('updated', task)
        throw new Error(task.deliveryError)
      }
    }
    // A durable external tombstone precedes removal. Legacy homes may contain
    // user projects (including files named like receipts); preserve all bytes.
    if (task) await this.retireRecord(id)
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
    // Retained homes cannot resurface through receipt reconstruction. Cleanup
    // never guesses which bytes in a legacy project are disposable metadata.
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
      if (await this.recordRetired(id)) continue
      const dir = join(root, id)
      let meta: { intent?: string; sessionId?: string; name?: string; nameSetByUser?: boolean; kind?: 'oneoff' | 'session'; runtimePinned?: boolean; lastUserInputAt?: number; cwd?: string; createdAt?: number; state?: string; updatedAt?: number; surface?: string; mode?: 'managed' | 'raw'; injectedRecipes?: Array<{ name: string; tier: 'nursery' | 'skill'; surface: string }>; pocketRemoved?: boolean; shelved?: boolean; note?: string; spawnedBy?: string; followUps?: number; group?: string; agent?: AgentKind; model?: string; codexThreadId?: string; codexRolloutId?: string; codexDomThreadId?: string; codexProject?: string | null; claudeDesktopSessionId?: string; conversation?: Task['conversation']; origin?: 'unmute-agent'; agentRunId?: string; result?: StatusPayload['result']; continuationMode?: Task['continuationMode']; continuationSources?: Task['continuationSources']; continuationArtifacts?: Task['continuationArtifacts']; continuationConfidence?: number; agentRelays?: Task['agentRelays'] }
      try { meta = JSON.parse(await fs.readFile(join(dir, 'meta.json'), 'utf8')) } catch { meta = {} }
      if ((meta as Task).continuationPending) continue
      if (!meta.intent) {
        // meta.json is missing, empty, or unparseable — see atomic-file.ts for
        // the write-side bug that can cause this. Before giving up, try to
        // rebuild it from the durable sources it only ever mirrored (the
        // agent's own transcript, or at minimum status.json) — see
        // meta-reconstruct.ts. A genuine pre-receipt/junk dir still has
        // nothing to recover from and is skipped exactly as before.
        const recovered = await reconstructTaskMeta(dir)
        if (!recovered) continue
        meta = {
          ...meta,
          intent: recovered.intent,
          ...(recovered.agent ? { agent: recovered.agent } : {}),
          ...(recovered.sessionId ? { sessionId: recovered.sessionId } : {}),
          ...(recovered.state ? { state: recovered.state } : {}),
        }
        // Self-heal: persist the recovered record so future launches don't
        // have to redo this scan. Best-effort — the task still shows even if
        // this write fails.
        void writeFileAtomic(join(dir, 'meta.json'), JSON.stringify(meta))
          .catch((e) => log.child({ taskId: id }).warn('rehydrate: could not persist recovered meta.json', { error: (e as Error).message }))
      }
      // MIGRATE THE SHELF ONCE. The receipt is rewritten with the new field
      // and without the old one, so this runs a single time per task and no
      // writer ever has to know `shelved` existed.
      if (meta.intent && meta.shelved !== undefined) {
        meta = { ...meta, ...(pocketRemovedFromMeta(meta) ? { pocketRemoved: true } : {}), shelved: undefined }
        await writeFileAtomic(join(dir, 'meta.json'), JSON.stringify(meta))
          .catch((e) => log.child({ taskId: id }).warn('rehydrate: could not migrate shelved', { error: (e as Error).message }))
      }
      if (!meta.intent) continue // unreachable after the reconstruction above, but keeps `meta.intent` narrowed to `string` below
      if (meta.origin === 'unmute-agent' && meta.agentRunId && !(meta as Task).sessionOwnership) {
        const now0 = this.clock()
        const task: Task = {
          id,
          intent: meta.intent,
          name: meta.name,
          ...(meta.nameSetByUser ? { nameSetByUser: true } : {}),
          sessionId: meta.agentRunId,
          origin: 'unmute-agent',
          agentRunId: meta.agentRunId,
          agent: meta.agent === 'codex' ? 'codex' : 'claude',
          kind: 'oneoff',
          state: 'done',
          createdAt: meta.createdAt ?? now0,
          updatedAt: meta.updatedAt ?? meta.createdAt ?? now0,
          cwd: dir,
          home: dir,
          statusPath: join(dir, 'status.json'),
          recipeScratchPath: join(dir, 'recipe.json'),
          lastMtimeMs: 0,
          lastHeartbeatMs: meta.updatedAt ?? now0,
          mode: 'managed',
          result: meta.result,
          pocketRemoved: pocketRemovedFromMeta(meta) || undefined,
          note: meta.note || undefined,
          continuationMode: meta.continuationMode,
          continuationSources: meta.continuationSources,
          continuationArtifacts: meta.continuationArtifacts,
          continuationConfidence: meta.continuationConfidence,
          agentRelays: meta.agentRelays,
          ...this.groupFromMeta(meta),
        }
        this.tasks.set(id, task)
        this.emit('created', task)
        restored++
        continue
      }
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
          ...(meta.nameSetByUser ? { nameSetByUser: true } : {}),
          sessionId: meta.claudeDesktopSessionId,
          ...(meta.origin ? { origin: meta.origin, agentRunId: meta.agentRunId, sessionOwnership: sessionOwnership(meta as Record<string, unknown>) } : {}),
          agent: 'claude-code-desktop',
          // REPLAYED, never re-resolved. A receipt written before this field
          // existed simply has no `model` and the card stays agent-only — the
          // one honest outcome, since nothing on disk can say what it ran on.
          ...(meta.model ? { model: meta.model } : {}),
          claudeDesktopSessionId: meta.claudeDesktopSessionId,
          kind: meta.kind ?? 'session',
          followUps: meta.followUps,
          state: (normalizeState(meta.state) as UiTaskState | undefined) ?? 'done',
          createdAt: meta.createdAt ?? now0,
          updatedAt: meta.updatedAt ?? now0,
          cwd: meta.cwd ?? dir,
          home: dir,
          statusPath: join(dir, 'status.json'),
          recipeScratchPath: join(dir, 'recipe.json'),
          lastMtimeMs: 0,
          lastHeartbeatMs: meta.updatedAt ?? now0,
          mode: meta.mode ?? 'managed',
          ...(pocketRemovedFromMeta(meta) ? { pocketRemoved: true } : {}),
          ...(meta.note ? { note: meta.note } : {}),
          ...this.groupFromMeta(meta),
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
          ...(meta.nameSetByUser ? { nameSetByUser: true } : {}),
          sessionId: meta.codexThreadId,
          ...(meta.origin ? { origin: meta.origin, agentRunId: meta.agentRunId, sessionOwnership: sessionOwnership(meta as Record<string, unknown>) } : {}),
          agent: 'codex-desktop',
          ...(meta.model ? { model: meta.model } : {}),
          codexThreadId: meta.codexThreadId,
          codexDomThreadId: meta.codexDomThreadId,
          codexProject: meta.codexProject ?? null,
          kind: meta.kind ?? 'oneoff',
          followUps: meta.followUps,
          // RESTORE what we last observed. Defaulting to 'processing' meant the
          // first poll always "discovered" completion afresh and re-stamped it,
          // so a finished thread announced itself on every single launch.
          state: (normalizeState(meta.state) as UiTaskState | undefined) ?? 'processing',
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
          pocketRemoved: pocketRemovedFromMeta(meta) || undefined,
          note: meta.note || undefined,
          spawnedBy: meta.spawnedBy || undefined,
          ...this.groupFromMeta(meta),
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
      const terminal = status?.state === 'done' || status?.state === 'failed'
      // A LIVE TERMINAL RUNTIME CLOSED BY THE QUIT SWITCH DID NOT FAIL.
      //
      // Startup first restores cards conservatively, then reattachPersistent()
      // reconnects any tmux runtime that actually survived the app. A missing
      // one-off remains interrupted/resumable; a missing durable session is a
      // quiet `done` ticket.
      const isSession = (meta.kind ?? 'oneoff') === 'session'
      // State authority follows the execution mode, not merely the provider.
      // Persistent Codex CLI sessions own their lifecycle in the rollout/meta
      // receipt because status.json is only their launch scaffold. Codex
      // one-offs use status.json to repair completed historical receipts.
      const persistedState = normalizeState(meta.state) as UiTaskState | undefined
      const structured = Boolean((meta as Task).claudeSessionSettings || (meta as Task).codexSessionSettings)
      // A new Codex chat has no provider id. If an id is present, the provider
      // already created or resumed the conversation and an old `unstarted`
      // flag is only a torn continuation receipt.
      const repairedStartedCodex = meta.agent === 'codex' && Boolean(meta.sessionId) && (meta as Task).chatUnstarted === true
      // Legacy CLI status files can remain at the launch scaffold forever.
      // Only an explicit completion of the latest native turn repairs that
      // receipt; an earlier answer followed by a new/aborted turn is not proof.
      let nativeCompleted = false
      if (!structured && meta.agent === 'codex' && !isSession && !terminal) {
        const rollout = await findRollout(meta.codexRolloutId ?? meta.sessionId ?? id)
        if (rollout) {
          const events = await readRolloutEvents(rollout).catch(() => [])
          for (const event of events) {
            if (event.type !== 'event_msg') continue
            const type = event.payload?.type
            if (type === 'task_complete') nativeCompleted = true
            else if (type === 'task_started' || type === 'user_message' || type === 'turn_aborted' || type === 'turn_failed') nativeCompleted = false
          }
        }
      }
      const recoveredState = nativeCompleted ? 'done' : structured
        ? (terminal ? status!.state : persistedState ?? (isSession ? 'done' : 'processing'))
        : meta.agent === 'codex' && isSession
        ? persistedState ?? (terminal ? status!.state : 'done')
        : terminal
          ? status!.state
          : isSession
            ? 'done'
            : 'failed'
      const task: Task = {
        id,
        intent: meta.intent,
        name: meta.name,
        ...(meta.nameSetByUser ? { nameSetByUser: true } : {}),
        // Pre-sessionId receipts won't carry one; fall back to the task id so the
        // field is always present (older tasks simply aren't session-pinned).
        sessionId: meta.sessionId ?? id,
        ...(meta.origin ? { origin: meta.origin, agentRunId: meta.agentRunId } : {}),
        // THE RECEIPT IS THE PROVIDER TRUTH. Dropping this field made a Codex
        // CLI task indistinguishable from a legacy untagged Claude task after
        // relaunch: every inactive surface drew Claude, and resume constructed
        // Claude. Only genuinely old receipts take the compatibility default.
        agent: meta.agent ?? 'claude',
        ...(meta.codexRolloutId ? { codexRolloutId: meta.codexRolloutId } : {}),
        ...((meta as { codexSessionSettings?: StartThreadOpts }).codexSessionSettings
          ? { codexSessionSettings: (meta as { codexSessionSettings: StartThreadOpts }).codexSessionSettings } : {}),
        claudeForkFromSessionId: (meta as Task).claudeForkFromSessionId,
        claudeResumeSessionAt: (meta as Task).claudeResumeSessionAt,
        ...((meta as Task).claudeSessionSettings ? { claudeSessionSettings: (meta as Task).claudeSessionSettings } : {}),
        ...((meta as Task).managedProjectId ? { managedProjectId: (meta as Task).managedProjectId } : {}),
        ...((meta as Task).permissionReason ? { permissionReason: (meta as Task).permissionReason } : {}),
        ...(meta.model ? { model: meta.model } : {}),
        ...((meta as Task).chatUnstarted && !repairedStartedCodex ? { chatUnstarted: true } : {}),
        ...((meta as Task).importedFromCli ? { importedFromCli: true } : {}),
        sessionOwnership: sessionOwnership(meta as Record<string, unknown>),
        kind: meta.kind ?? 'oneoff',
        followUps: meta.followUps,
        // A non-terminal task whose session died with the app is, to the user,
        // interrupted — surface it as failed (still resumable) rather than a
        // forever-spinning 'processing'. Sessions get `ready` instead (above).
        state: recoveredState,
        turnOutcome: (meta as Task).turnOutcome,
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
        error: structured
          ? (recoveredState === 'failed' ? status?.error : undefined)
          : nativeCompleted ? undefined : terminal ? status?.error : (isSession ? undefined : { reason: 'Interrupted by an app restart — resume to continue' }),
        question: structured ? undefined : status?.question,
        surface: meta.surface,
        mode: meta.mode ?? 'managed',
        injectedRecipes: meta.injectedRecipes ?? [],
        runtimePinned: meta.runtimePinned ?? isSession,
        lastUserInputAt: meta.lastUserInputAt ?? meta.updatedAt ?? meta.createdAt ?? now,
        // Restored so the chat strip is not empty after a relaunch — see
        // persistState(). Without it the card falls back to the short status
        // line where the exchange should be.
        ...(Array.isArray(meta.conversation) ? { conversation: meta.conversation as Task['conversation'] } : {}),
        pocketRemoved: pocketRemovedFromMeta(meta) || undefined,
        note: meta.note || undefined,
        spawnedBy: meta.spawnedBy || undefined,
        continuationMode: meta.continuationMode,
        continuationSources: meta.continuationSources,
        continuationArtifacts: meta.continuationArtifacts,
        continuationConfidence: meta.continuationConfidence,
        agentRelays: meta.agentRelays,
        ...this.groupFromMeta(meta),
      }
      // A receipt is enough to restore the wall. Reading every Claude frame
      // file here made startup proportional to all historical chats and kept
      // their parsed copies alive even when no one opened those cards.
      // loadBlocksFor() owns history hydration when a card becomes visible.
      const identityRepaired = await this.reconcileCodexIdentity(task)
      if (await fs.lstat(join(task.home, 'attachments')).catch(() => null)) {
        try { await this.prepareAttachmentStorage(task) }
        catch (error) { task.deliveryError = `Could not secure attachment storage: ${(error as Error).message}` }
      }
      this.tasks.set(id, task)
      this.emit('created', task)
      if (persistedState !== recoveredState || repairedStartedCodex || identityRepaired) await this.persistState(task)
      restored++
    }
    if (restored) log.event('rehydrated', { restored })
  }

  /** Attach UI clients to live tmux runtimes left alive by the previous
   * app process. This never launches a provider command or submits input. */
  async reattachPersistent(): Promise<void> {
    // Fail closed: if tmux cannot tell us which runtimes exist, preserve every
    // ticket but attach none. Probing every historical task is exactly the
    // restart fan-out that previously overloaded Electron's main process.
    let liveRuntimeIds: ReadonlySet<string>
    try {
      liveRuntimeIds = await this.opts.listLiveRuntimeIds?.() ?? new Set<string>()
    } catch (error) {
      log.warn('persistent runtime discovery failed', { error: (error as Error).message })
      return
    }
    const candidates = [...this.tasks.values()].filter((task) =>
      task.agent !== 'codex-desktop'
      && task.agent !== 'claude-code-desktop'
      && liveRuntimeIds.has(task.id)
      && !this.executors.get(task.id)?.alive,
    )
    log.event('persistent-runtime-discovered', {
      live: liveRuntimeIds.size,
      matched: candidates.length,
    })
    await Promise.all(candidates.map(async (task) => {
      const lastUse = task.lastUserInputAt ?? task.updatedAt ?? task.createdAt
      const expiredSession = task.kind === 'session'
        && !task.runtimePinned
        && this.clock() - lastUse >= this.opts.persistentIdleMs
      if (expiredSession) {
        try { this.opts.reapSession?.(task.id) } catch { /* best-effort */ }
        if (!TERMINAL.includes(task.state)) task.state = 'done'
        task.error = undefined
        await this.persistState(task)
        this.emit('updated', task)
        return
      }
      const tlog = log.child({ taskId: task.id })
      try {
        const ex = this.opts.executorFactory(false, task.agent ?? 'claude')
        this.executors.set(task.id, ex)
        this.outputBuffers.set(task.id, this.outputBuffers.get(task.id) ?? '')
        ex.onData((chunk) => {
          this.notePtyLiveness(task.id)
          const cur = (this.outputBuffers.get(task.id) ?? '') + chunk
          this.outputBuffers.set(task.id, cur.length > TaskManager.OUTPUT_CAP ? cur.slice(-TaskManager.OUTPUT_CAP) : cur)
          this.emit('output', { taskId: task.id, chunk })
        })
        await ex.spawn({ cwd: task.cwd, env: process.env, taskId: task.id, attachExisting: true })
        await new Promise((resolve) => setTimeout(resolve, 25))
        if (!ex.alive) throw new Error('persistent tmux session is not running')
        const status = await readStatus(task.statusPath)
        const restoredState = normalizeState(status?.state) as UiTaskState | undefined
        // A live one-off may have been restored conservatively as interrupted
        // before runtime discovery. Its status scaffold is safe to trust here
        // because tmux has proved that exact runtime still exists. Persistent
        // Codex sessions continue to use rollout/meta authority so a stale
        // scaffold cannot resurrect an idle thread as fake Working work.
        if ((task.agent !== 'codex' || task.kind === 'oneoff') && restoredState && !TERMINAL.includes(restoredState)) {
          task.state = restoredState
        }
        const oneoffWarmMs = task.kind === 'oneoff' ? this.warmMsFor(task.id) : null
        const oneoffWarmRemaining = oneoffWarmMs === null
          ? null
          : oneoffWarmMs - (this.clock() - task.updatedAt)
        // Rehydration pessimistically labels an unproven one-off interrupted.
        // Never use that temporary state to reap it: a live runtime plus a
        // processing status means the turn is genuinely still running. Only a
        // provider-terminal status is eligible for the existing warm expiry.
        const completedOneoffExpired = task.kind === 'oneoff'
          && restoredState !== undefined
          && TERMINAL.includes(restoredState)
          && oneoffWarmRemaining !== null
          && oneoffWarmRemaining <= 0
        if (completedOneoffExpired) {
          // Same rule as the live timer (armWarmTimer), which no longer erases
          // either: the RUNTIME expired while the app was closed, so do not
          // reattach it — but the card, its status and its home directory stay.
          // This is that expiry discovered lazily on relaunch rather than by a
          // timer, and it must reach the same end state or a task survives the
          // window only to be deleted by the next launch.
          tlog.event('warm-idle-timeout', { warmMs: oneoffWarmMs, state: restoredState, recovered: true, kept: true })
          this.hardKill(task.id)
          void this.persistState(task).catch(() => {})
          this.emit('updated', task)
          return
        }
        if (!TERMINAL.includes(task.state)) this.startPolling(task.id)
        else if (task.kind === 'oneoff' && oneoffWarmRemaining !== null) this.armWarmTimer(task.id, oneoffWarmRemaining)
        task.error = undefined
        task.resumeError = undefined
        await this.persistState(task)
        this.emit('updated', task)
        tlog.event('persistent-runtime-reattached', {})
      } catch (e) {
        this.hardKill(task.id)
        if (!TERMINAL.includes(task.state)) task.state = 'done'
        task.error = undefined
        task.resumeError = undefined
        await this.persistState(task)
        this.emit('updated', task)
        tlog.event('persistent-runtime-missing', { error: (e as Error).message })
      }
    }))
  }

  /**
   * Start the background maintenance sweep: hard-erase any task untouched (by
   * updatedAt) for >= purgeAgeMs (default 3 days). This is what keeps a user from
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
      this.noteUserInput(task, 'codex-consent-answer')
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
    this.noteUserInput(task, 'codex-approval-answer')
    this.transition(task.id, 'processing')
    return true
  }

  /**
   * Retire every one-off task untouched for >= purgeAgeMs (ANY state — this also
   * reaps a still-alive session left behind by an abandoned needs-user/stuck
   * task, which otherwise never gets its warm-timeout). Preserves project data
   * through remove(); never touches provider transcript stores.
   */
  async purgeStale(): Promise<void> {
    // THE READY-DECAY VALVE LIVED HERE, and it is gone with the state it
    // served. It settled an ignored `ready` one-off to `done` after an hour so
    // it would stop haunting the queue — but `done` also meant "fades off the
    // notch in fifteen minutes", so the valve did not quiet a task, it DELETED
    // it from everywhere the user could reach without opening the dashboard.
    // Quieting is now the notch's job and it steps down a tier instead of off a
    // cliff (DEMAND_WINDOW_MS in notch-controller). Nothing here rewrites state
    // behind the user's back any more.
    const now = this.clock()
    const runtimeCutoff = now - this.opts.persistentIdleMs
    // The task is durable; the live process is a cache. Stop an unpinned
    // persistent runtime after a week without user input, keeping its card and
    // provider transcript available for an ordinary Resume.
    for (const task of this.tasks.values()) {
      if (task.kind !== 'session' || task.runtimePinned || !this.executors.get(task.id)?.alive) continue
      const lastUse = task.lastUserInputAt ?? task.updatedAt ?? task.createdAt
      if (lastUse >= runtimeCutoff) continue
      this.hardKill(task.id)
      task.state = 'done'
      task.error = undefined
      await this.persistState(task)
      this.emit('updated', task)
      log.child({ taskId: task.id }).event('persistent-runtime-expired', { idleMs: now - lastUse })
    }
    const cutoff = now - this.opts.purgeAgeMs
    // A FINISHED one-off doesn't need the full purgeAgeMs backstop — it has its
    // own much shorter rule (warmMs), the same one armWarmTimer already enforces
    // live. Without this, a one-off that finished between maintenance sweeps (or
    // was reloaded by rehydrate from a previous run) sat as a real record for up
    // to a day, for the pocket/cockpit/dashboard to each independently decide how
    // long to keep showing something that was already over. purgeAgeMs remains
    // the backstop for everything ELSE a one-off can be — still working, or left
    // ambiguously interrupted — where guessing "abandoned" from age alone would
    // be wrong.
    // A FINISHED ONE-OFF IS AGED BY purgeAgeMs, LIKE EVERYTHING ELSE.
    //
    // It used to be aged by warmMs, on the reasoning that a finished one-off
    // "has its own much shorter rule". That rule was about how long to keep a
    // PROCESS warm, and using it here made it decide how long to keep the WORK
    // — so a task went from finished to permanently deleted in one window.
    // armWarmTimer no longer erases either; it stops the runtime and leaves the
    // record, and this is the same change on the sweep's side. purgeAgeMs is
    // what retires the record. Project bytes survive that retirement too.
    const oneoffCutoff = cutoff
    // 1. IN-MEMORY tasks that have aged out — remove() kills the live session too.
    //    One rule, retentionExempt(): sessions and tasks the person renamed are
    //    kept; every other one-off goes after purgeAgeMs untouched. Being out
    //    of the pocket has no say here — it is not a "keep" gesture, and it is
    //    not a "discard" one either. Explicit Delete retires a record; it does
    //    not delete the workspace.
    const stale = [...this.tasks.values()].filter((t) => {
      if (retentionExempt(t)) return false
      return t.updatedAt < (TERMINAL.includes(t.state) ? oneoffCutoff : cutoff)
    })
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

  private retirementPath(id: string): string {
    return join(this.opts.baseDir, '.retired-conversations', this.opts.userKey ?? 'local', encodeURIComponent(id) + '.json')
  }
  private async recordRetired(id: string): Promise<boolean> {
    try { await fs.lstat(this.retirementPath(id)); return true }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
  }
  private async retireRecord(id: string): Promise<void> {
    const path = this.retirementPath(id)
    await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFileAtomic(path, JSON.stringify({ id, retiredAt: this.clock() }))
  }

  private async purgeOrphanDirs(cutoff: number): Promise<void> {
    const root = join(this.opts.baseDir, this.opts.userKey ?? 'local')
    let ids: string[]
    try { ids = await fs.readdir(root) } catch { return } // root not created yet
    let removed = 0
    for (const id of ids) {
      if (this.tasks.has(id)) continue // active in memory — handled in pass 1
      if (await this.recordRetired(id)) continue
      const dir = join(root, id)
      let mtimeMs: number
      try {
        const st = await fs.stat(dir)
        if (!st.isDirectory()) continue
        mtimeMs = st.mtimeMs // dir mtime advances on every status (atomic rename) ≈ last activity
      } catch { continue }
      if (mtimeMs >= cutoff) continue // recent orphan (e.g. a just-crashed run) — keep
      // Persistent-session and renamed receipts are NEVER orphan-purged (the
      // same retentionExempt() rule as pass 1): if one isn't in memory (e.g. this sweep ran before rehydrate),
      // deleting it would erase a multi-day session behind the user's back.
      try {
        const meta = JSON.parse(await fs.readFile(join(dir, 'meta.json'), 'utf8')) as { kind?: string; origin?: string; nameSetByUser?: boolean }
        if (retentionExempt(meta) || meta.origin === 'unmute-agent') continue
      } catch { /* unidentified data is retained too */ }
      await this.retireRecord(id)
      try { this.opts.reapSession?.(id) } catch { /* best-effort orphan runtime cleanup */ }
      // No recursive deletion: even incomplete receipts can accompany projects.
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
    // Invalidate queued delivery before any state change or transport teardown.
    for (const id of this.tasks.keys()) if (this.followupScope(id)) this.emit('followup-disarm', { taskId: id })
    // Union of PTY-backed and external-backend tasks. Keying on `executors`
    // alone leaked the poll interval of every codex-desktop task (no executor
    // ⇒ never visited ⇒ setInterval outlived the manager).
    const ids = [...new Set([...this.tasks.keys(), ...this.executors.keys(), ...this.scheduler.keys()])]
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
    this.opts.codexHub?.stop()
    log.event('kill-all', { count: ids.length })
  }

  /** App shutdown is not the UI's destructive Kill All. Every live terminal
   * runtime detaches and continues; `kind` only controls its later retention. */
  shutdown(): void {
    for (const id of this.tasks.keys()) if (this.followupScope(id)) this.emit('followup-disarm', { taskId: id })
    this.shuttingDown = true
    const structured = new Set<string>(this.claudeTasks.keys())
    for (const [id, runtime] of this.claudeTasks) {
      this.chatStopVersion.set(id, (this.chatStopVersion.get(id) ?? 0) + 1)
      const detachable = runtime.driver as ClaudeTaskSession & { detach?: () => void }
      if (detachable.detach) detachable.detach()
      else runtime.driver.close()
    }
    this.claudeTasks.clear()
    this.stopMaintenance()
    const ids = [...new Set([...this.tasks.keys(), ...this.executors.keys(), ...this.scheduler.keys()])]
    let detached = 0
    let killed = 0
    for (const id of ids) {
      const task = this.tasks.get(id)
      const ex = this.executors.get(id)
      const threadIdFor = this.opts.codexHub?.threadIdFor
      const persistentStructured = structured.has(id)
        || !!(task?.codexSessionSettings && typeof threadIdFor === 'function' && threadIdFor.call(this.opts.codexHub, id))
      const detachable = task
        && task.agent !== 'codex-desktop'
        && task.agent !== 'claude-code-desktop'
        && ex?.alive
        && ex.detach
      if (task && (task.kind === 'session' || detachable || persistentStructured)) {
        this.stopPolling(id)
        const wt = this.warmTimers.get(id)
        if (wt) { clearTimeout(wt); this.warmTimers.delete(id) }
        this.typedBuffers.delete(id)
        if (ex?.alive) {
          if (ex.detach) { ex.detach(); detached++ }
          else { ex.kill(); killed++ }
        }
        this.executors.delete(id)
        this.mergeMeta(task, {
          state: task.state,
          updatedAt: task.updatedAt,
          lastUserInputAt: task.lastUserInputAt,
          runtimePinned: task.runtimePinned,
        }, 'shutdown')
        continue
      }
      if (task && !SETTLED.includes(task.state)) {
        task.state = 'failed'
        task.error = { reason: 'Interrupted by an app restart — resume to continue' }
        task.updatedAt = this.clock()
        this.emit('updated', task)
        this.emit('failed', task)
      }
      this.hardKill(id)
      killed++
    }
    log.event('shutdown', { detached, killed })
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
      .then((raw) => writeFileAtomic(metaPath, JSON.stringify({ ...JSON.parse(raw), ...patch })))
      .catch((e) => log.child({ taskId: task.id }).warn(`${op}: meta persist failed`, { error: (e as Error).message }))
    this.metaChains.set(task.id, next)
    void next.finally(() => { if (this.metaChains.get(task.id) === next) this.metaChains.delete(task.id) })
  }

  /** Record durable user activity for the persistent-runtime idle policy. */
  private noteUserInput(task: Task, op: string): void {
    task.lastUserInputAt = this.clock()
    this.mergeMeta(task, { lastUserInputAt: task.lastUserInputAt }, op)
    // SPEAKING TO A TASK PUTS IT BACK IN FRONT OF YOU. A card removed from the
    // pocket that you just sent something to is, by definition, at hand again.
    if (task.pocketRemoved) this.setInPocket(task.id, true)
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
  /**
   * The one-line label for this task, set separately from what was delivered.
   *
   * dispatch() used to receive the router's rewritten line and store it as
   * both the payload AND the label. Now the payload is the person's verbatim
   * utterance, so the label is set here instead — the list stays readable
   * without the session being handed a paraphrase.
   */
  setIntent(id: string, intent: string): void {
    const task = this.tasks.get(id)
    const next = (intent || '').trim()
    if (!task || !next || task.intent === next) return
    task.intent = next
    task.updatedAt = this.clock()
    this.emit('updated', task)
    this.mergeMeta(task, { intent: next }, 'setIntent')
  }

  /** Rename a task.
   *
   *  CONTRACT: `setName(id, name)` with no options is a DELIBERATE rename — the
   *  user, or the Agent acting for the user. It clamps to MAX_TASK_NAME, locks
   *  the name (`nameSetByUser`, persisted) and mirrors it to a live Codex
   *  thread. Automatic namers pass `{ auto: true }`: no lock, and a no-op when
   *  the name is already locked. */
  setName(id: string, name: string, opts: { auto?: boolean } = {}): void {
    const task = this.tasks.get(id)
    if (!task) return
    const auto = opts.auto === true
    if (auto && task.nameSetByUser) return
    const trimmed = (name || '').trim()
    const n = auto ? trimmed : trimmed.slice(0, MAX_TASK_NAME).trim()
    if (!n) return
    const lockChanged = !auto && !task.nameSetByUser
    if (task.name === n && !lockChanged) return
    const renamed = task.name !== n
    task.name = n
    if (!auto) task.nameSetByUser = true
    task.updatedAt = this.clock()
    this.emit('updated', task)
    // Durability (best-effort): fold the name into the receipt.
    this.mergeMeta(task, auto ? { name: n } : { name: n, nameSetByUser: true }, 'setName')
    // Codex keeps its own thread title; keep the two lists in step. Claude has
    // no title API. Fire-and-forget: the card has already been renamed.
    if (!auto && renamed && task.agent === 'codex' && this.opts.codexHub?.threadIdFor(id)) {
      void this.opts.codexHub.rename(id, n).catch((e) =>
        log.child({ taskId: id }).warn('setName: codex thread rename failed', { error: (e as Error).message }))
    }
  }

  /** Records the configuration last successfully selected for this task.
   *
   * This deliberately does not change `agent`: a task's provider is its thread
   * identity. The model receipt is both the UI truth for an addressed capture
   * and the value restored after a relaunch. Provider adapters perform their
   * actual native write before calling this method. */
  setModel(id: string, model: string): boolean {
    const task = this.tasks.get(id)
    const value = model.trim()
    if (!task || !value) return false
    task.model = value
    if (task.agent === 'codex-desktop') task.codexModelLabel = value
    task.updatedAt = this.clock()
    this.mergeMeta(task, { model: value, ...(task.codexModelLabel ? { codexModelLabel: task.codexModelLabel } : {}) }, 'set-model')
    this.emit('updated', task)
    return true
  }

  /** Apply choices to this owned conversation only. A provider/cwd is identity,
   * never a mutable setting. Persist only after the provider accepts setup. */
  async configureChat(id: string, change: { model?: string; effort?: string; permission?: string }): Promise<void> {
    const task = this.tasks.get(id)
    if (!task) throw new Error('This conversation no longer exists')
    if (task.importedFromCli || task.sessionOwnership === 'external') throw new Error('This session is externally owned; its settings are managed in the original application')
    if (task.state === 'processing' || task.state === 'needs-user') throw new Error('Finish or stop the current turn before changing session settings')
    if (this.followupScope(id)) this.emit('followup-disarm', { taskId: id })
    const full = change.permission === 'full' || change.permission === undefined && (task.claudeSessionSettings?.permissionMode === 'bypassPermissions' || task.codexSessionSettings?.sandbox === 'danger-full-access')
    if (full && !this.chatFullAccessAllowed(id)) throw new Error('Full access is unavailable under the configured sandbox roots or full-access consent cap. Update the applicable settings before selecting it for this conversation.')
    if (task.claudeSessionSettings) {
      const previous = task.claudeSessionSettings
      const modes = { full: 'bypassPermissions', ask: 'manual', plan: 'plan' } as const
      if (change.permission && !(change.permission in modes)) throw new Error('Unsupported Claude permission mode')
      const next = { ...previous,
        ...(change.model !== undefined ? { model: change.model || undefined } : {}),
        ...(change.effort !== undefined ? { effort: change.effort || undefined } : {}),
        ...(change.permission ? { permissionMode: modes[change.permission as keyof typeof modes] } : {}),
      }
      this.claudeTasks.get(id)?.driver.close()
      this.claudeTasks.delete(id)
      task.claudeSessionSettings = next
      try { if (!task.chatUnstarted) await this.connectClaude(task, true) }
      catch (error) { task.claudeSessionSettings = previous; throw error }
      this.mergeMeta(task, { claudeSessionSettings: next }, 'chat-config')
    } else if (task.codexSessionSettings && this.opts.codexHub) {
      const modes = { full: { approvalPolicy: 'never', sandbox: 'danger-full-access' }, workspace: { approvalPolicy: 'never', sandbox: 'workspace-write' }, ask: { approvalPolicy: 'on-request', sandbox: 'workspace-write' }, read: { approvalPolicy: 'on-request', sandbox: 'read-only' } }
      if (change.permission && !(change.permission in modes)) throw new Error('Unsupported Codex permission mode')
      const next = { ...task.codexSessionSettings,
        ...(change.model !== undefined ? { model: change.model || undefined } : {}),
        ...(change.effort !== undefined ? { effort: change.effort || undefined } : {}),
        ...(change.permission ? modes[change.permission as keyof typeof modes] : {}),
      }
      if (!task.chatUnstarted) await this.opts.codexHub.resumeThread(id, task.sessionId, next, true)
      task.codexSessionSettings = next
      this.mergeMeta(task, { codexSessionSettings: next }, 'chat-config')
    } else throw new Error('Settings for this externally owned session are managed in its original application')
    if (change.model !== undefined) task.model = change.model || undefined
    if (change.permission) { task.permissionReason = undefined; this.mergeMeta(task, { permissionReason: undefined }, 'chat-policy-reason') }
    task.deliveryError = undefined
    this.mergeMeta(task, { model: task.model }, 'chat-config-label')
    this.emit('updated', task)
  }

  /** The settings UI and session updates share the same enforced cap. */
  chatFullAccessAllowed(id: string): boolean {
    const task = this.tasks.get(id)
    if (!task || task.importedFromCli || task.sessionOwnership === 'external') return false
    // permissionMode supplies a default, not a prohibition on an explicit
    // per-session choice. The configured fence and Codex consent remain caps.
    return this.providerFullAccessAllowed(task.agent)
  }
  private providerFullAccessAllowed(provider: Task['agent']): boolean {
    return !(this.opts.sandboxRoots?.() ?? []).some(root => root.trim()) && (provider !== 'codex' || this.opts.codexFullAccess?.() === true)
  }

  /** Change a task's species. Promotion (oneoff → session) CANCELS any armed
   *  warm-kill timer — the whole point is that the session now outlives idle
   *  windows. Demotion re-arms lifecycle on the next park. Persists to meta so
   *  the species survives restarts; emits 'updated' for the UIs. */
  /**
   * ADOPT A CLAUDE CODE CLI SESSION THE USER ALREADY HAS.
   *
   * A card for a thread that exists in someone's terminal. It does NOT start
   * anything: no PTY, no `--resume`, no process. The session stays exactly
   * where it is until the user sends it something, and then the ordinary
   * revive-on-send path brings it back by id (see `answer`).
   *
   * That restraint is the whole design. Importing twenty sessions must not
   * spawn twenty REPLs — and importing is reading, not interacting, which is
   * the rule the rest of this surface now runs on.
   *
   * `state: 'done'` because that is the truth: the thread is not working, its
   * turn ended some time ago in another window. It is a THREAD, so a finished
   * one is a checkpoint and the notch will offer it — which is right, since you
   * imported it precisely to pick it back up.
   */
  async adoptCliSession(input: {
    sessionId: string
    title: string
    cwd: string
    lastActivityAt: number
    group?: string
    /** Which CLI wrote it. Absent ⇒ Claude, matching the persisted default. */
    agent?: 'claude' | 'codex'
  }): Promise<string | null> {
    for (const t of this.tasks.values()) {
      if (t.sessionId !== input.sessionId) continue
      const durable = JSON.parse(await fs.readFile(join(t.home, 'meta.json'), 'utf8').catch(() => '{}')) as Record<string, unknown>
      const ownership = sessionOwnership(durable)
      t.sessionOwnership = ownership === 'unmute' ? 'unmute' : 'external'
      if (t.sessionOwnership === 'external') t.importedFromCli = true
      this.mergeMeta(t, { sessionOwnership: t.sessionOwnership, ...(t.importedFromCli ? { importedFromCli: true } : {}) }, 'cli-rediscovery-provenance')
      await this.metaChains.get(t.id)
      // ALREADY OURS — but possibly with a BROKEN PATH.
      //
      // Imports made before the cwd fix stored a reconstructed path, which is
      // wrong for any project with a dash in its name. `resume()` bails on a
      // directory it cannot access, so those cards have a button that does
      // nothing — and dedupe meant re-importing handed back the same broken
      // task, so the only repair was to notice, delete the card, and import
      // again. Nobody should have to know that. If the stored path is gone and
      // we now have a real one, fix it in place.
      if (t.cwd !== input.cwd) {
        let stale = false
        try { await fs.access(t.cwd) } catch { stale = true }
        if (stale) {
          const was = t.cwd
          t.cwd = input.cwd
          if (input.group && !t.group) t.group = input.group
          // WRITTEN DIRECTLY, not via persistState: that merges only state,
          // updatedAt and the conversation, and early-returns when none of the
          // three has moved — so a repair routed through it would hold until
          // the next relaunch and then come back broken.
          void (async () => {
            const path = join(t.home, 'meta.json')
            try {
              const meta = JSON.parse(await fs.readFile(path, 'utf8')) as Record<string, unknown>
              await writeFileAtomic(path, JSON.stringify({ ...meta, cwd: t.cwd, group: t.group }, null, 2))
            } catch (e) {
              log.child({ taskId: t.id }).warn('cwd repair not persisted', { error: (e as Error).message })
            }
          })()
          log.child({ taskId: t.id }).event('cli-session-cwd-repaired', { from: was, to: input.cwd })
          this.emit('updated', t)
        }
      }
      return t.id
    }
    const id = randomUUID()
    const dir = join(this.opts.baseDir, this.opts.userKey ?? 'local', id)
    const tlog = log.child({ taskId: id })
    try {
      await fs.mkdir(dir, { recursive: true })
    } catch (e) {
      tlog.error('adopt-cli-session mkdir failed', { error: (e as Error).message })
      return null
    }
    const now = this.clock()
    const task = {
      id,
      intent: input.title,
      name: input.title,
      sessionId: input.sessionId,
      agent: input.agent ?? 'claude',
      importedFromCli: true,
      sessionOwnership: 'external',
      // Codex resumes by the id it minted, which IS the rollout id.
      ...(input.agent === 'codex' ? { codexRolloutId: input.sessionId } : {}),
      // A thread the user owns elsewhere is persistent by nature: never
      // idle-killed, never auto-purged.
      kind: 'session' as const,
      state: 'done' as const,
      // Filed through the registry at adoption, not left as a bare label for
      // the next rehydrate to resolve: the wall groups it correctly the moment
      // it appears, and the cwd basename folds onto an existing stream instead
      // of sitting beside it under a second spelling.
      ...this.groupFromMeta({ group: input.group }),
      // The REAL last interaction, not now. Stamping `now` would shove every
      // import to the top of the wall and into Today, which is the same
      // "reading rewrote its history" fault the open path just had.
      createdAt: input.lastActivityAt,
      updatedAt: input.lastActivityAt,
      cwd: input.cwd,
      home: dir,
      statusPath: join(dir, 'status.json'),
      recipeScratchPath: join(dir, 'recipe.json'),
      lastMtimeMs: 0,
      lastHeartbeatMs: input.lastActivityAt,
      mode: 'managed' as const,
    } as Task
    this.tasks.set(id, task)
    await writeFileAtomic(join(dir, 'meta.json'), JSON.stringify({
      id, intent: task.intent, name: task.name, sessionId: input.sessionId,
      kind: 'session', agent: input.agent ?? 'claude', state: 'done',
      ...(input.group ? { group: input.group } : {}),
      createdAt: task.createdAt, updatedAt: task.updatedAt,
      cwd: input.cwd, mode: 'managed', importedFromCli: true, sessionOwnership: 'external',
    }, null, 2)).catch((e) => tlog.warn('adopt-cli-session meta write failed', { error: (e as Error).message }))

    tlog.event('cli-session-adopted', { sessionId: input.sessionId, cwd: input.cwd, group: input.group ?? null })
    this.emit('created', task)
    return id
  }

  setKind(id: string, kind: 'oneoff' | 'session', options: { pinned?: boolean } = {}): void {
    const task = this.tasks.get(id)
    if (!task) return
    const runtimePinned = kind === 'session' ? (options.pinned ?? false) : false
    if (task.kind === kind && task.runtimePinned === runtimePinned) return
    task.kind = kind
    task.runtimePinned = runtimePinned
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
    log.child({ taskId: id }).event('kind-changed', { kind, runtimePinned })
    this.mergeMeta(task, { kind, runtimePinned }, 'setKind')
  }

  /** Graduation (§5): a one-off that keeps receiving follow-ups is a working
   *  session in denial — the 2nd follow-up promotes it to a persistent
   *  `session`, permanently exempt from the warm-idle purge. EVERY real
   *  "the user is continuing to work this task" surface must call this —
   *  a call site that skips it is invisible: the task just goes quiet 15
   *  minutes after its last activity and is erased, with nothing left in
   *  Finished, no warning. (2026-08-26: deliverDraft/sendInput/
   *  sendClaudeDesktop/answerClaudeDesktop/both branches of answer()'s
   *  CLI path were all missing this — only followUp() and
   *  followUpCodexDesktop() had it, which is why a task followed up on
   *  exclusively through Right-Option/the composer never graduated no
   *  matter how many times it was replied to.) */
  private noteFollowUp(task: Task): void {
    task.followUps = (task.followUps ?? 0) + 1
    // WRITTEN DOWN, NOT JUST COUNTED. This lived only on the in-memory Task,
    // so every relaunch rebuilt tasks from meta.json without it and the count
    // restarted at zero. The graduated KIND was already durable, so a task that
    // made it stayed a session forever while a task partway there silently lost
    // its progress — which is why nobody noticed. On 2026-08-30 two tasks the
    // user replied to for hours were still `oneoff` when the warm timer reaped
    // them: the app had been relaunched three times inside each of their lives.
    this.mergeMeta(task, { followUps: task.followUps }, 'noteFollowUp')
    if (task.kind !== 'session' && task.followUps >= 2) {
      log.child({ taskId: task.id }).event('graduated-to-session', { followUps: task.followUps })
      this.setKind(task.id, 'session')
    }
  }

  /**
   * IN THE POCKET, OR NOT — and that is ALL this changes. "Remove from pocket"
   * takes the card out of the notch; the task keeps running, stays on the
   * orchestrator's wall and rail, and ages exactly as it would have (so
   * `updatedAt` is deliberately NOT touched: removing a card is not activity,
   * and it must not buy the task more retention either).
   *
   * Coming back is never a gesture of its own. It happens when the task needs
   * the person again (the notch controller clears it on that transition), when
   * anyone opens it, or when the person sends it something (noteUserInput).
   * Persists to meta.json; emits 'updated' so every surface re-reads it.
   */
  setInPocket(id: string, inPocket: boolean): void {
    const task = this.tasks.get(id)
    if (!task || !task.pocketRemoved === inPocket) return
    task.pocketRemoved = inPocket ? undefined : true
    this.emit('updated', task)
    log.child({ taskId: id }).event(inPocket ? 'returned-to-pocket' : 'removed-from-pocket', {})
    this.mergeMeta(task, { pocketRemoved: !inPocket }, 'setInPocket')
  }

  /**
   * END THE SESSION, KEEP THE CONVERSATION. The Agent's "end that task":
   * whatever turn is running is interrupted, the process is released, and the
   * record stays exactly where it was — resumable, the same way the warm-idle
   * expiry leaves it (see "THE RUNTIME EXPIRES, THE RECORD DOES NOT"). This is
   * deliberately not remove(): a process is a cache, a conversation is not.
   * Returns false when there is no such task.
   */
  async endSession(id: string): Promise<boolean> {
    const task = this.tasks.get(id)
    if (!task) return false
    if (this.followupScope(id)) this.emit('followup-disarm', { taskId: id })
    const tlog = log.child({ taskId: id })
    tlog.ui('task-row.ended', {})
    if (task.codexThreadId) { this.surfacedApprovals.delete(task.codexThreadId); void clearApproval(task.codexThreadId) }
    // Owned app-server threads have no PTY for hardKill() to close; the same
    // guard remove() uses, so a turn is never left running invisibly.
    if (task.codexSessionSettings && this.opts.codexHub?.threadIdFor(id)) {
      if (!(await this.opts.codexHub.stopAndRelease(id))) {
        task.deliveryError = 'Could not stop Codex, so the session was not ended.'
        this.emit('updated', task)
        throw new Error(task.deliveryError)
      }
    }
    const claude = this.claudeTasks.get(id)
    if (claude) {
      this.chatStopVersion.set(id, (this.chatStopVersion.get(id) ?? 0) + 1)
      claude.channel.requestStop()
      if (claude.driver.busy) await claude.driver.interrupt().catch(() => {})
    }
    const working = task.state === 'processing' || task.state === 'stuck'
    this.hardKill(id)
    if (working) {
      task.state = 'failed'
      task.error = { reason: 'Ended by you' }
    } else if (!TERMINAL.includes(task.state)) task.state = 'done'
    task.codexActivity = undefined
    task.updatedAt = this.clock()
    await this.persistState(task).catch(() => {})
    this.emit('updated', task)
    tlog.event('task-session-ended', { wasWorking: working, kept: true })
    return true
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
  /**
   * File a task under a stream.
   *
   * The task stores the registry ENTRY ID; `group` is the entry's label, kept
   * alongside because every outward surface — the notch payload, the renderer,
   * the router snapshot — renders a name and has no way to resolve an id.
   *
   * Going through the registry is what stops "unmute" and "Unmute" from being
   * two streams: the label is folded to a key and joins whatever entry already
   * holds it. Without a registry (older callers, tests) it degrades to the
   * previous label-only behaviour rather than refusing to group.
   */
  setGroup(id: string, group: string | null): void {
    const task = this.tasks.get(id)
    if (!task) return
    const registry = this.opts.groupRegistry
    const entry = group ? registry?.resolve(group) : undefined
    const g = entry ? entry.label : (group || '').trim().slice(0, 32)
    const gid = entry?.id
    if ((task.group ?? '') === g && (task.groupId ?? '') === (gid ?? '')) return
    task.group = g || undefined
    task.groupId = g ? gid : undefined
    task.updatedAt = this.clock()
    this.emit('updated', task)
    log.child({ taskId: id }).event('group-changed', { group: g || null, groupId: task.groupId ?? null })
    this.mergeMeta(task, { group: g, groupId: task.groupId ?? '' }, 'setGroup')
  }

  /**
   * Rename a stream. Returns how many tasks now show the new name.
   *
   * This USED to walk every task and rewrite the string, which worked only
   * because groups were live-only — nothing outlived the rename. With a
   * persisted registry that would orphan every task not currently loaded, and
   * the next time one was rehydrated its stale label would mint a second
   * stream. So the rename is now a one-field write on the ENTRY, and the loop
   * below only refreshes the labels already in memory.
   *
   * A name that collides with another stream is REFUSED (0), not merged: two
   * streams the user kept apart are not ours to join.
   */
  renameGroup(from: string, to: string): number {
    const f = (from || '').trim()
    const t = (to || '').trim().slice(0, 32)
    if (!f || !t) return 0
    const registry = this.opts.groupRegistry
    if (registry) {
      const entry = registry.find(f)
      if (!entry) return 0
      const out = registry.rename(entry.id, t)
      if (!out.ok) {
        log.warn('group rename refused', { from: f, to: t, reason: out.reason, clashesWith: out.entry?.label ?? null })
        return 0
      }
      let relabelled = 0
      for (const task of this.tasks.values()) {
        if (task.groupId !== entry.id) continue
        task.group = out.entry!.label
        task.updatedAt = this.clock()
        this.emit('updated', task)
        this.mergeMeta(task, { group: task.group, groupId: entry.id }, 'renameGroup')
        relabelled++
      }
      log.event('group-renamed', { from: f, to: out.entry!.label, relabelled })
      return relabelled
    }
    if (f === t) return 0
    let moved = 0
    for (const task of this.tasks.values()) {
      if (task.group === f) { this.setGroup(task.id, t); moved++ }
    }
    if (moved) log.event('group-renamed', { from: f, to: t, moved })
    return moved
  }

  /**
   * Rehydrate a task's stream from its meta.json — and MIGRATE it if needed.
   *
   * Every task written before the registry carries a bare label and no id. The
   * first load resolves that label into an entry, which is also the first
   * deduplication the user ever sees: "unmute" and "Unmute" collapse here, with
   * no model involved and nothing to configure.
   *
   * Prefers the stored id when there is one, so a stream renamed while this
   * task was unloaded comes back under its CURRENT name rather than the name it
   * had when the task was last written.
   */
  private groupFromMeta(meta: { group?: string; groupId?: string }): { group?: string; groupId?: string } {
    const registry = this.opts.groupRegistry
    const label = (meta.group || '').trim()
    if (!registry) return label ? { group: label } : {}
    const byId = meta.groupId ? registry.get(meta.groupId) : undefined
    const entry = byId ?? (label ? registry.resolve(label) : undefined)
    if (!entry) return label ? { group: label } : {}
    return { group: entry.label, groupId: entry.id }
  }

  /** Registry ids currently held by a task — what `prune` must never drop. */
  liveGroupIds(): Set<string> {
    const ids = new Set<string>()
    for (const t of this.tasks.values()) if (t.groupId) ids.add(t.groupId)
    return ids
  }

  /**
   * A follow-up that carries what the person attached.
   *
   * followUp() writes text into a live REPL and has NO channel for an image,
   * so a screenshot spoken at an existing task was dropped in silence — while
   * the same screenshot spoken at a NEW task arrived, because dispatch()
   * delegates to deliverDraft() whenever attachments are present. The user
   * cannot see which branch the router took, so the same gesture worked or
   * failed at random. This is that same delegation, for continue and resume.
   *
   * noteUserInput is ours to call: deliverDraft advances graduation
   * (noteFollowUp) but NOT the consent clock on this path, and without it the
   * thread reads cold to the next utterance's consent guard.
   */
  async followUpWith(id: string, text: string, attachments: readonly string[] = []): Promise<boolean> {
    if (!attachments.length) return this.followUp(id, text)
    const task = this.tasks.get(id)
    if (!task) return false
    this.noteUserInput(task, 'follow-up')
    return this.deliverDraft(id, text, attachments)
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
    this.noteUserInput(task, 'follow-up') // user spoke to this thread — consent clock
    // Graduation (§5): the 2nd follow-up proves this is a THREAD, not an errand —
    // promote to a persistent session (one follow-up is a common quick correction).
    this.noteFollowUp(task)
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

  /** Only the latest text-only prompt in an idle owned session can be edited. */
  canEditLatestMessage(id: string): boolean {
    if (!MESSAGE_EDIT_ENABLED) return false
    const task = this.tasks.get(id)
    if (!task || task.sessionOwnership !== 'unmute' || task.sending || task.state === 'processing' || task.state === 'needs-user'
      || !(task.claudeSessionSettings || task.codexSessionSettings)) return false
    const blocks = task.blocks ?? []
    let index = -1
    blocks.forEach((b, i) => { if (b.kind === 'message' && b.role === 'user') index = i })
    return index >= 0 && !blocks.slice(index).some(b => b.kind === 'attachment')
  }

  /** Edit on a provider-native branch, retaining the original session as recovery history. */
  async editLatestMessage(id: string, expected: string, replacement: string): Promise<boolean> {
    if (!this.canEditLatestMessage(id) || !replacement.trim()) return false
    const task = this.tasks.get(id)!
    const latest = [...(task.blocks ?? [])].reverse().find(b => b.kind === 'message' && b.role === 'user')
    if (latest?.kind !== 'message' || latest.text !== expected) throw new Error('The latest message changed. Reopen it before editing.')
    if (/^\/(clear|compact|model|permissions|resume|quit)\s*$/i.test(replacement.trim())) {
      throw new Error('Terminal-only commands cannot replace a message. Your original conversation is unchanged.')
    }
    task.sending = true
    const source = task.sessionId
    const before = { sessionId: task.sessionId, blocks: task.blocks, conversation: task.conversation, chatUnstarted: task.chatUnstarted,
      claudeForkFromSessionId: task.claudeForkFromSessionId, claudeResumeSessionAt: task.claudeResumeSessionAt, codexRolloutId: task.codexRolloutId }
    let prepared = false
    let originalClaudeFrames: Array<Record<string, any>> | undefined
    try {
      await writeFileAtomic(join(task.home, `chat-edit-${randomUUID()}.json`), JSON.stringify({ ...before, replacement }))
      if (task.codexSessionSettings && this.opts.codexHub) {
        const gate = this.opts.codexHub.followupGate(id)
        if (gate.kind !== 'idle' || gate.blocked) throw new Error('Wait for Codex to finish before editing.')
        const fork = await this.opts.codexHub.forkThread(id, source, task.codexSessionSettings, randomUUID())
        task.sessionId = fork.threadId; task.codexRolloutId = fork.threadId
        await this.opts.codexHub.rollbackLatestTurn(id, task.codexSessionSettings)
      } else if (task.claudeSessionSettings) {
        const live = this.claudeTasks.get(id)
        if (live?.driver.busy || live?.driver.followupUnavailable || live?.channel.pending) throw new Error('Wait for Claude to finish before editing.')
        await this.claudeHistoryWrites.get(id)
        const history = await readClaudeHistory(task)
        if (history.history.phase !== 'ready') throw new Error('Load the complete source history before editing.')
        originalClaudeFrames = history.frames
        const prefix = claudeEditPrefix(history.frames, expected)
        this.claudeTasks.delete(id); live?.driver.close()
        task.sessionId = randomUUID()
        task.claudeForkFromSessionId = prefix.resumeAt ? source : undefined
        task.claudeResumeSessionAt = prefix.resumeAt
        task.chatUnstarted = true
        task.blocks = blocksFromClaudeTranscript(ClaudeTaskChannel.displayTranscript(prefix.frames)).blocks
        task.conversation = []
        await writeFileAtomic(join(task.home, 'chat-frames.json'), JSON.stringify(prefix.frames))
        await this.connectClaude(task, false)
      } else throw new Error('This provider cannot edit messages.')
      prepared = true
      await this.persistState(task)
      const accepted = await this.deliverDraft(id, replacement, [])
      if (!accepted) throw new Error(task.deliveryError || 'The edited message was not accepted. Your replacement is saved as a draft.')
      return true
    } catch (error) {
      if (!prepared) {
        const failed = this.claudeTasks.get(id); this.claudeTasks.delete(id); failed?.driver.close()
        Object.assign(task, before)
        if (originalClaudeFrames) await writeFileAtomic(join(task.home, 'chat-frames.json'), JSON.stringify(originalClaudeFrames))
        if (task.codexSessionSettings && this.opts.codexHub) await this.opts.codexHub.resumeThread(id, source, task.codexSessionSettings, true).catch(() => {})
        await this.persistState(task)
      }
      task.deliveryError = (error as Error).message
      throw error
    } finally { task.sending = false; this.emit('updated', task) }
  }

  async answerQuestion(id: string, text: string, reference: QuestionReference): Promise<boolean> {
    const task = this.tasks.get(id)
    if (!task || task.sessionOwnership === 'external' || task.importedFromCli || !sameQuestion(task.question?.reference, reference)
      || sameQuestion(task.questionAcknowledgment?.reference, reference)) return false
    task.questionAcknowledgment = { reference: { ...reference }, state: 'pending' }
    task.question = { ...task.question!, acknowledgment: 'pending' }
    this.emit('updated', task)
    let accepted = false
    try {
      if (task.claudeSessionSettings) {
        const runtime = this.claudeTasks.get(id)
        if (runtime) accepted = await runtime.channel.answer(text, runtime.driver, reference)
      } else if (task.codexSessionSettings) accepted = this.opts.codexHub?.answer(id, text, reference) ?? false
      return accepted
    } catch (error) { task.deliveryError = (error as Error).message; return false }
    finally {
      if (sameQuestion(task.questionAcknowledgment?.reference, reference)) {
        task.questionAcknowledgment = accepted ? { reference: { ...reference }, state: 'accepted' } : undefined
      }
      if (sameQuestion(task.question?.reference, reference)) task.question = { ...task.question!, acknowledgment: accepted ? 'accepted' : undefined }
      if (!accepted) task.deliveryError ||= 'This answer was not accepted. The request may have expired; review the current question and retry.'
      else task.deliveryError = undefined
      this.emit('updated', task)
    }
  }

  async deliverDraft(id: string, text: string, attachments: readonly string[], inputTrace?: TaskReplyTrace, ordered?: TaskInput[], context: AnswerContext = null): Promise<boolean> {
    const task = this.tasks.get(id)
    if (!task) {
      if (inputTrace) emitTaskReplyStep(log, inputTrace, 'delivery-preflight', 'failed', { reason: 'task-no-longer-exists' })
      return false
    }
    if (context) {
      if (attachments.length) return false
      return this.answerQuestion(id, text, context)
    }
    const canMigrateLegacy = task.agent === 'codex' ? Boolean(this.opts.codexHub) : Boolean(this.opts.claudeSessionOptions)
    if (!task.claudeSessionSettings && !task.codexSessionSettings && !isExternalAgent(task.agent) && canMigrateLegacy) {
      task.deliveryError = task.importedFromCli ? 'Externally owned sessions are read-only here. Start a new conversation.' : 'Resume this legacy conversation in graphical chat before sending. Your draft is saved.'
      this.emit('updated', task)
      return false
    }
    if ((task.claudeSessionSettings || task.codexSessionSettings) && /^\/(clear|compact|model|permissions|resume|quit)\s*$/i.test(text)) {
      task.deliveryError = 'Use the conversation controls for settings or New conversation for a fresh context. Terminal-only commands are not sent as agent instructions.'
      this.emit('updated', task)
      return false
    }
    if (task.claudeSessionSettings) {
      log.child({ taskId: id }).event('chat-delivery-attempt', {
        state: task.state, chatUnstarted: task.chatUnstarted ?? false, chars: text.length,
      })
      const stopVersion = this.chatStopVersion.get(id) ?? 0
      try {
        await this.connectClaude(task, true)
        if ((this.chatStopVersion.get(id) ?? 0) !== stopVersion) throw new Error('Stopped before submission')
        const runtime = this.claudeTasks.get(id)!
        if (runtime.channel.pending) {
          throw new Error('A request is waiting. Review the current question before sending an answer; this new-turn draft is saved.')
        }
        // A BUSY CHAT SESSION WAITS; IT DOES NOT REFUSE.
        //
        // The PTY path has always queued a mid-turn follow-up — "the write
        // below will QUEUE until the REPL is idle" — while this one threw, so
        // the same spoken sentence was held for you or thrown away depending on
        // a transport you cannot see. And `busy` is not only "the model is
        // thinking": reconnecting and reconciling a card raise it too, in
        // bursts of tens of milliseconds. On 2026-09-08 one card flipped state
        // eighteen times in twenty-three seconds while nothing at all was
        // running, and eight delivery attempts each landed on a blip; the last
        // refusal came twelve milliseconds before it settled.
        //
        // So wait it out. A real turn finishing is what this is for, and a blip
        // becomes invisible rather than fatal.
        if (runtime.driver.busy) {
          const deadline = this.clock() + CHAT_BUSY_WAIT_MS
          while (runtime.driver.busy && this.clock() < deadline) {
            if ((this.chatStopVersion.get(id) ?? 0) !== stopVersion) throw new Error('Stopped before submission')
            await new Promise<void>(resolve => setTimeout(resolve, 200))
          }
          if (runtime.driver.busy) {
            throw new Error('Claude is still working. Your draft is saved; send it after this turn finishes or stop the turn.')
          }
          log.child({ taskId: id }).event('chat-send-waited-for-idle', { waitedMs: CHAT_BUSY_WAIT_MS - (deadline - this.clock()) })
        }
        const submissionId = randomUUID()
        runtime.channel.expectSubmission(submissionId, ordered ?? [{ type: 'text', text }, ...attachments.map(path => ({ type: 'image' as const, path }))])
        await runtime.driver.send(text, [...attachments], submissionId, ordered)
        if (task.chatUnstarted) {
          task.chatUnstarted = false
          task.intent = text.trim().slice(0, 180) || 'Attachment conversation'
          this.mergeMeta(task, { chatUnstarted: false, intent: task.intent }, 'first-chat-send')
        }
        task.deliveryError = undefined
        this.noteUserInput(task, 'claude-chat-send')
        this.noteFollowUp(task)
        this.emit('updated', task)
        return true
      } catch (error) {
        task.deliveryError = (error as Error).message
        // SAY IT WHERE IT CAN BE READ AFTERWARDS.
        //
        // deliveryError lives on the in-memory task and is never written to
        // meta.json, so a refusal here left no trace anywhere: the caller's
        // own catch sees nothing (this returns false rather than throwing),
        // the reply trace is not reached, and the file on disk is unchanged.
        // On 2026-09-08 a message failed eight times against this branch and
        // three separate investigations could not name the reason.
        log.child({ taskId: id }).warn('chat delivery refused', {
          reason: (error as Error).message,
          chars: text.length,
          attachments: attachments.length,
          taskState: task.state,
          chatUnstarted: task.chatUnstarted ?? false,
        })
        this.emit('updated', task)
        return false
      }
    }
    // Graduation (§5) — once here, regardless of which backend branch below
    // ends up handling delivery. This was the actual bug behind a task
    // silently vanishing 15 minutes after going quiet no matter how many
    // times it was replied to via Right-Option/the composer: this is that
    // path, and it never counted toward graduation before.
    this.noteFollowUp(task)
    const tlog = log.child({ taskId: id })
    const trace = inputTrace ?? beginTaskReplyTrace(tlog, {
      taskId: id, source: 'internal', textChars: text.length, attachments: attachments.length,
    })
    const attachmentDetails = await Promise.all(attachments.map(async (path, index) => ({
      index,
      path,
      name: basename(path),
      bytes: await fs.stat(path).then((entry) => entry.size).catch(() => null),
    })))
    const common = {
      agent: task.agent ?? 'claude',
      model: task.model ?? null,
      taskState: task.state,
      taskKind: task.kind ?? 'oneoff',
      sessionId: task.sessionId,
      codexThreadId: task.codexThreadId ?? null,
      claudeDesktopSessionId: task.claudeDesktopSessionId ?? null,
      permissionMode: this.opts.permissionMode?.() ?? 'ask',
      codexModel: this.opts.codexCliChoice?.().model ?? null,
      codexEffort: this.opts.codexCliChoice?.().effort ?? null,
      codexFullAccess: this.opts.codexFullAccess?.() ?? false,
      textChars: text.length,
      attachments: attachmentDetails,
      hasOpenAsk: !!task.openAsk,
      hasExecutor: !!this.executors.get(id)?.alive,
    }
    const selected = (transport: string, fields: Record<string, unknown> = {}) => {
      emitTaskReplyStep(tlog, trace, 'provider-selected', 'succeeded', { ...common, transport, ...fields })
    }
    const outcome = (ok: boolean, reason: string, fields: Record<string, unknown> = {}): boolean => {
      emitTaskReplyStep(tlog, trace, 'transport-result', ok ? 'succeeded' : 'failed', { reason, ...fields })
      return ok
    }
    // An attachment is content, not an answer to a permission/question picker.
    // Refuse the whole draft so neither the text nor image can accidentally
    // activate the highlighted choice; the visible draft remains retryable.
    if (attachments.length && (task.state === 'needs-user' || task.openAsk)) {
      selected('blocked-state-refusal')
      task.deliveryError = 'Answer the pending question before sending attachments'
      this.emit('updated', task)
      return outcome(false, 'pending-question-does-not-accept-attachments', { draftRetained: true })
    }
    if (task.agent === 'codex-desktop') {
      selected('codex-desktop-cdp', { driverAvailable: !!this.opts.codexDriver, threadAddressable: !!task.codexThreadId })
      const driver = this.opts.codexDriver
      if (!driver || !task.codexThreadId) return outcome(false, 'codex-desktop-driver-or-thread-unavailable', { draftRetained: true })
      emitTaskReplyStep(tlog, trace, 'provider-call', 'started', { operation: 'sendWithAttachments' })
      const result = await driver.sendWithAttachments(task.codexThreadId, text, attachments, (stage, fields) => {
        const ok = fields.ok
        emitTaskReplyStep(tlog, trace, `codex-desktop-${stage}`, ok === false || stage.includes('timeout') ? 'failed' : 'succeeded', fields)
      })
      if (!result.ok) {
        task.deliveryError = `Could not send to Codex (${result.reason})`
        this.emit('updated', task)
        return outcome(false, result.reason ?? 'codex-desktop-send-failed', { draftRetained: true })
      }
      return outcome(true, 'codex-rollout-confirmed')
    }
    if (task.agent === 'claude-code-desktop') {
      if (attachments.length) {
        selected('claude-desktop-native-composer', { actuatorAvailable: !!this.opts.claudeActuator, conversationAddressable: !!task.name })
        const actuator = this.opts.claudeActuator
        const title = await this.claudeDesktopAddress(task)
        if (!actuator || !title) return outcome(false, 'claude-actuator-or-conversation-unavailable', { draftRetained: true })
        emitTaskReplyStep(tlog, trace, 'provider-call', 'started', { operation: 'sendWithAttachmentsTo' })
        const result = await actuator.sendWithAttachmentsTo(
          title,
          text,
          () => pasteDesktopTaskImages(text, attachments, (stage, fields) => {
            emitTaskReplyStep(tlog, trace, `pasteboard-${stage}`, stage.includes('failed') ? 'failed' : 'succeeded', fields)
          }),
        )
        if (!result.ok) {
          task.deliveryError = `Could not send attachments to Claude (${result.reason ?? 'failed'})`
          this.emit('updated', task)
          return outcome(false, result.reason ?? 'claude-desktop-send-failed', { draftRetained: true })
        }
        delete task.deliveryError
        this.transition(id, 'processing')
        return outcome(true, 'claude-desktop-submit-key-posted')
      }
      selected('claude-desktop-native-composer', { actuatorAvailable: !!this.opts.claudeActuator, conversationAddressable: !!task.name })
      emitTaskReplyStep(tlog, trace, 'provider-call', 'started', { operation: 'sendClaudeDesktop' })
      const result = await this.sendClaudeDesktop(id, text)
      return outcome(result.ok, result.ok ? 'claude-desktop-send-completed' : (result.reason ?? 'claude-desktop-send-failed'), { draftRetained: !result.ok })
    }

    // Codex app-server has a first-class localImage input. This is the native
    // structured transport and does not involve the PTY view at all.
    if (task.codexSessionSettings && !(await this.resume(id))) {
      task.deliveryError = 'Could not reconnect to this Codex conversation'
      this.emit('updated', task)
      return outcome(false, 'codex-resume-failed', { draftRetained: true })
    }
    if (task.agent === 'codex' && this.opts.codexHub?.threadIdFor(id)) {
      selected('codex-app-server', { hubThreadId: this.opts.codexHub.threadIdFor(id) })
      emitTaskReplyStep(tlog, trace, 'provider-call', 'started', { operation: 'turn/start', localImages: attachments.length })
      const ok = await this.opts.codexHub.send(id, text, {
        newTurnOnly: true,
        effort: task.codexSessionSettings?.effort ?? this.opts.codexCliChoice?.().effort,
        ordered,
        attachments,
      })
      if (!ok) {
        task.deliveryError = this.opts.codexHub.validationErrorFor?.(id) ?? task.deliveryError ?? 'Codex did not accept this message. Your draft is saved.'
        this.emit('updated', task)
      } else {
        task.deliveryError = undefined
        this.emit('updated', task)
      }
      if (ok && task.chatUnstarted) {
        task.chatUnstarted = false
        task.intent = text.trim().slice(0, 180) || 'Attachment conversation'
        this.mergeMeta(task, { chatUnstarted: false, intent: task.intent }, 'first-chat-send')
      }
      return outcome(ok, ok ? 'codex-app-server-accepted-turn' : 'codex-app-server-refused-turn', { draftRetained: !ok })
    }

    // A PTY-HOSTED CODEX SESSION USES THE COMPOSER, NOT THE APP SERVER.
    //
    // Images here used to be refused outright, 2ms in, without the terminal
    // ever being touched: the app-server route above needs a hub thread, and a
    // session Unmute did not start through the hub — an import, a session the
    // user opened themselves, anything after a restart — never has one. The
    // draft was kept and the user saw nothing arrive.
    //
    // Adopting such a session into the hub is the wrong repair. Its terminal is
    // already writing that thread, and a second writer on one thread is the
    // failure codex/cdp.ts documents: the turn lands in storage while the
    // running UI never shows it. The one writer stays the terminal, so the
    // images go where the text goes — through the verified composer, exactly as
    // Claude Code CLI delivers them. `pasteImage` below still gates it, so a
    // session that genuinely cannot take an image still refuses, by capability
    // rather than by provider name.
    const ex = this.executors.get(id)
    selected('verified-cli-composer', {
      executorAlive: !!ex?.alive,
      canWriteDraftText: !!ex?.writeDraftText,
      canSubmitDraft: !!ex?.submitDraft,
      canPasteImage: !!ex?.pasteImage,
      canClearDraft: !!ex?.clearDraft,
    })
    if (!ex?.alive || !ex.writeDraftText || !ex.submitDraft || (attachments.length > 0 && !ex.pasteImage)) {
      task.deliveryError = attachments.length
        ? 'This CLI session cannot accept image attachments'
        : 'This CLI session cannot verify task draft submission'
      this.emit('updated', task)
      return outcome(false, 'cli-composer-capability-missing', { draftRetained: true })
    }
    emitTaskReplyStep(tlog, trace, 'executor-ready', 'started')
    await ex.isReady()
    if (!ex.alive) {
      task.deliveryError = 'The CLI session closed before delivery'
      this.emit('updated', task)
      return outcome(false, 'cli-session-closed-before-delivery', { draftRetained: true })
    }
    emitTaskReplyStep(tlog, trace, 'executor-ready', 'succeeded')
    // A REPLY IS A REASON TO LIVE. followUp() and sendInput() both disarm the
    // idle-kill when the user speaks to a parked session; this path — the Right
    // Option capture and the stage composer — did not, and that omission killed
    // task b8388aec mid-turn on 2026-08-20 three minutes after the user replied
    // to it. armWarmTimer's own re-check is the backstop; this is the fix.
    const wt = this.warmTimers.get(id)
    if (wt) { clearTimeout(wt); this.warmTimers.delete(id) }
    ex.writeDraftText(text)
    emitTaskReplyStep(tlog, trace, 'text-composed', 'succeeded', { chars: text.length })
    if (attachments.length) {
      emitTaskReplyStep(tlog, trace, 'attachment-paste', 'started', { count: attachments.length })
      const accepted = await pasteTaskImages(text, attachments, () => ex.pasteImage!(), (stage, fields) => {
        emitTaskReplyStep(tlog, trace, `pasteboard-${stage}`, stage.includes('failed') ? 'failed' : 'succeeded', fields)
      })
      if (!accepted) {
        ex.clearDraft?.()
        task.deliveryError = 'The CLI did not accept every image attachment'
        this.emit('updated', task)
        emitTaskReplyStep(tlog, trace, 'attachment-paste', 'failed', { count: attachments.length, composerCleared: !!ex.clearDraft })
        return outcome(false, 'cli-image-paste-not-accepted', { draftRetained: true })
      }
      emitTaskReplyStep(tlog, trace, 'attachment-paste', 'succeeded', { count: attachments.length })
    }
    // PROVE SUBMISSION WITH A SIGNAL THIS AGENT ACTUALLY EMITS.
    //
    // The proof used to be a `UserPromptSubmit` hook event for every CLI. That
    // hook is Claude Code's; ~/.codex/hooks.json carries PermissionRequest and
    // nothing else, so a Codex reply could never be confirmed — it was typed,
    // Codex answered it, and Unmute still timed out, kept the draft, and fired
    // a SECOND Enter because the first looked unconfirmed. That duplicate is
    // visible in real sessions as the same message asked twice.
    //
    // Codex records each user turn in its rollout without being asked, which is
    // the same durable authority the desktop lane already trusts.
    //
    // THE HOOK ALONE HAS THE SAME GAP FOR CLAUDE, JUST HARDER TO HIT: it is a
    // live, in-process signal, so a task whose own tool call is hanging (an MCP
    // server not answering, say) can delay the hook past verifyAfterMs even
    // though the CLI already accepted the prompt and is working on it.
    // deliverDraft then reports the reply FAILED and keeps it in the draft —
    // deliberately, so nothing typed is lost on a REAL failure — and the next
    // capture appends onto that already-delivered text and resends the whole
    // growing blob. Visible in a real session as the same sentence retyped
    // into the terminal, longer, several times in a row.
    //
    // claudeUserTurns reads the same kind of durable, on-disk authority Codex
    // already gets: Claude Code appends the user's turn to its transcript the
    // moment it accepts the prompt, before any tool call that follows runs, so
    // it is not subject to the stall that can delay the hook. Checked ALONGSIDE
    // the hook, not instead of it — the hook is usually the faster signal, this
    // is the fallback that keeps a stalled task from losing the race.
    const submittedBefore = task.promptSubmittedAt ?? 0
    const rolloutTurnsBefore = task.agent === 'codex' ? await this.codexUserTurns(task) : null
    const claudeTurnsBefore = rolloutTurnsBefore === null ? await this.claudeUserTurns(task) : null
    let provenBy: 'codex-rollout' | 'prompt-submitted-hook' | 'claude-transcript' | null = null
    const landed = async (): Promise<boolean> => {
      if (rolloutTurnsBefore !== null) {
        if ((await this.codexUserTurns(task)) > rolloutTurnsBefore) { provenBy = 'codex-rollout'; return true }
        return false
      }
      if ((task.promptSubmittedAt ?? 0) > submittedBefore) { provenBy = 'prompt-submitted-hook'; return true }
      if (claudeTurnsBefore !== null && (await this.claudeUserTurns(task)) > claudeTurnsBefore) {
        provenBy = 'claude-transcript'
        return true
      }
      return false
    }
    ex.submitDraft()
    emitTaskReplyStep(tlog, trace, 'submit-key', 'succeeded', { attempt: 1, submittedBefore, rolloutTurnsBefore, claudeTurnsBefore })
    // A single Enter is occasionally ignored by both TUIs, so confirm once
    // before repeating it — a retry against a transport that cannot confirm is
    // how one dictated message became two turns.
    await new Promise((resolve) => setTimeout(resolve, this.opts.submitConfirmMs))
    if (ex.alive && !(await landed())) {
      ex.submitDraft()
      emitTaskReplyStep(tlog, trace, 'submit-key', 'succeeded', { attempt: 2, reason: 'first-enter-unconfirmed' })
    }
    const deadline = Date.now() + this.opts.verifyAfterMs
    while (ex.alive && Date.now() < deadline && !(await landed())) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    if (!(await landed())) {
      task.deliveryError = 'The CLI did not confirm that the attachment reply was submitted'
      this.emit('updated', task)
      emitTaskReplyStep(tlog, trace, 'submission-proof', 'timed-out', { verifyAfterMs: this.opts.verifyAfterMs, draftRetained: true })
      return outcome(false, rolloutTurnsBefore === null ? 'prompt-submitted-hook-timeout' : 'codex-rollout-turn-timeout', { draftRetained: true })
    }
    emitTaskReplyStep(tlog, trace, 'submission-proof', 'succeeded', {
      promptSubmittedAt: task.promptSubmittedAt,
      provenBy,
    })
    delete task.deliveryError
    this.noteUserInput(task, 'draft-submitted')
    task.state = 'processing'
    task.updatedAt = this.clock()
    task.conversation = [{ role: 'user', text }]
    this.emit('updated', task)
    this.startPolling(id)
    // Name the proof that actually ran. A Codex success reported as
    // "hook-confirmed" sends the next reader looking for a hook Codex has not
    // got, which is the trail this whole lane already cost once.
    return outcome(true, provenBy ? `${provenBy}-confirmed` : 'submission-confirmed')
  }

  /**
   * Resume a finished/reaped task: respawn its session with `--continue` in the
   * SAME cwd. Claude resume is cwd-scoped and each task owns one session, so this
   * continues THAT task with full prior context — no session-id tracking needed.
   * The transcript survives because we keep the task dir after kill. The session
   * comes back alive + warm (re-attachable terminal, ready for a follow-up).
   * Returns false if the task is unknown, already alive, or its dir was removed.
   */
  async resume(id: string, opts: { touchActivity?: boolean; hydrateHistory?: boolean } = {}): Promise<boolean> {
    const tlog = log.child({ taskId: id })
    const task = this.tasks.get(id)
    if (!task) { tlog.warn('resume: no such task'); return false }
    if (task.importedFromCli || task.sessionOwnership === 'external') {
      task.resumeError = 'This session is owned outside Unmute and is read-only here. Start a new conversation to avoid simultaneous writers.'
      this.emit('updated', task)
      return false
    }
    let legacyMigration: { ownership: Task['sessionOwnership'] } | undefined
    const canMigrateLegacy = task.agent === 'codex' ? Boolean(this.opts.codexHub) : Boolean(this.opts.claudeSessionOptions)
    if (!task.claudeSessionSettings && !task.codexSessionSettings && !isExternalAgent(task.agent) && canMigrateLegacy) {
      try {
        if (task.importedFromCli) throw new Error('This session is owned outside Unmute and is read-only here. Start a new conversation to avoid simultaneous writers.')
        const live = await this.opts.listLiveRuntimeIds?.()
        if (this.executors.get(id)?.alive || live?.has(id)) throw new Error('Stop the existing legacy runtime before resuming this conversation in graphical chat.')
        if (!(await fs.stat(task.cwd).catch(() => null))?.isDirectory()) throw new Error(`Project folder is unavailable: ${task.cwd}`)
        legacyMigration = { ownership: task.sessionOwnership }
        if (task.agent === 'codex') {
          const posture = codexPosture({ permissionMode: this.opts.permissionMode?.() === 'auto-approve' ? 'auto-approve' : 'prompt', sandboxRoots: this.opts.sandboxRoots?.() ?? [], fullAccessAllowed: this.opts.codexFullAccess?.() === true })
          task.codexSessionSettings = { ...this.opts.codexCliChoice?.(), cwd: task.cwd, approvalPolicy: posture.approvalPolicy, sandbox: posture.sandbox, writableRoots: posture.addDirs }
        } else {
          const transcript = await findTranscriptById(task.cwd, task.sessionId)
          if (transcript) {
            const frames = (await fs.readFile(transcript, 'utf8')).split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } })
            await writeFileAtomic(join(task.home, 'chat-frames.json'), JSON.stringify(frames))
          }
          task.claudeSessionSettings = this.opts.claudeChoice?.(task) ?? { permissionMode: 'manual' }
        }
      } catch (error) { task.resumeError = (error as Error).message; this.emit('updated', task); return false }
    }
    if (task.claudeSessionSettings) {
      try {
        await this.connectClaude(task, true, opts.hydrateHistory !== false)
        if (legacyMigration) {
          task.sessionOwnership = 'unmute'; task.chatUnstarted = false
          this.mergeMeta(task, {
            sessionOwnership: 'unmute', chatUnstarted: false,
            claudeSessionSettings: task.claudeSessionSettings,
          }, 'structured-migration')
          await this.metaChains.get(id)
        }
        task.deliveryError = undefined; task.resumeError = undefined
        return true
      }
      catch (error) {
        if (legacyMigration) {
          delete task.claudeSessionSettings
          task.sessionOwnership = legacyMigration.ownership
        }
        task.deliveryError = `Could not resume Claude: ${(error as Error).message}`
        this.emit('updated', task)
        return false
      }
    }
    if (task.codexSessionSettings) {
      if (!this.opts.codexHub) return false
      try {
        await validateProject(task.cwd)
        if (await this.reconcileCodexIdentity(task, true)) await this.persistState(task)
        if (task.codexSessionSettings.sandbox === 'danger-full-access' && !this.chatFullAccessAllowed(id)) throw new Error('Recorded full access exceeds the configured sandbox roots or consent cap. Select Ask for approval before resuming.')
        if (!task.sessionId && task.chatUnstarted) {
          const { threadId } = await this.opts.codexHub.startThread(id, task.codexSessionSettings)
          task.sessionId = threadId
          task.codexRolloutId = threadId
          await this.persistState(task)
        } else {
          if (!task.sessionId) throw new Error('Session creation was not acknowledged. Start a new conversation.')
          await this.opts.codexHub.resumeThread(id, task.sessionId, task.codexSessionSettings)
        }
        if (legacyMigration) {
          task.sessionOwnership = 'unmute'; task.chatUnstarted = false
          this.mergeMeta(task, {
            sessionOwnership: 'unmute', chatUnstarted: false,
            codexSessionSettings: task.codexSessionSettings,
          }, 'structured-migration')
          await this.metaChains.get(id)
        }
        task.deliveryError = undefined; task.resumeError = undefined
        return true
      } catch (error) {
        if (legacyMigration) {
          delete task.codexSessionSettings
          task.sessionOwnership = legacyMigration.ownership
        }
        task.deliveryError = `Could not resume Codex: ${(error as Error).message}`
        this.emit('updated', task)
        return false
      }
    }

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

    // A WRONG PATH HEALS HERE, ONCE, FOR EVERY CALLER.
    //
    // This used to bail outright, and silently: `return false` into a log
    // nobody reads while the card showed nothing at all. In the field that read
    // as a dead button — pressed twice, ten seconds apart, because nothing
    // acknowledged the first press.
    //
    // A task's cwd can be wrong (imported before the scanner read the real one
    // out of the transcript) or merely stale (the repo moved, the folder was
    // renamed). Both are recoverable: the session id is in hand, and the
    // transcript records where it ran. Repairing it HERE rather than at the
    // import path is the whole point — resume is the single door that the
    // button, voice, the router and revive-on-send all pass through, so fixing
    // it once fixes it everywhere, and old records heal as they are touched
    // instead of needing a migration or a delete-and-re-import.
    let reachable = true
    try { await fs.access(task.cwd) } catch { reachable = false }
    if (!reachable) {
      const found = task.sessionId ? await this.opts.resolveSessionCwd?.(task.sessionId) ?? null : null
      if (!found) {
        tlog.warn('resume: task dir gone and no transcript to recover it from', { cwd: task.cwd })
        return false
      }
      tlog.event('resume-cwd-healed', { from: task.cwd, to: found })
      task.cwd = found
      await this.persistCwd(task).catch(() => {})
      this.emit('updated', task)
    }

    // Resume by the task's PINNED session id when that exact conversation exists
    // on disk: `--resume <id>` attaches to THIS task's session even when several
    // sessions share a cwd (bare `--continue` grabs merely the most-recent one —
    // the wrong conversation for a shared repo dir). Fall back to `--continue`
    // when the id can't be confirmed (a fork whose id-adoption never landed, or a
    // pre-sessionId receipt whose sessionId defaulted to the taskId) so resume
    // still works. NEVER passes --fork-session — that would branch, not resume.
    // WHICH TRANSCRIPT PROVES THE SESSION EXISTS depends on the backend.
    // Claude's lives in ~/.claude keyed by cwd; Codex's is a rollout in
    // ~/.codex found by id alone. Asking Claude's resolver about a Codex
    // session finds nothing, so resume would fall back to `--continue` — which
    // for Codex is not even a flag, and would have opened a fresh conversation
    // with the history dropped.
    const byId = !task.sessionId ? null
      : task.agent === 'codex'
        ? await findRollout(task.codexRolloutId ?? task.sessionId)
        : await findTranscriptById(task.cwd, task.sessionId)
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
        // Untruncated copy for diagnosis. The line above is capped at 2000 chars
        // by the logger, which is exactly why three theories about why a session
        // dies could not be settled. Off unless UNMUTE_PTY_TAP=1.
        tapPtyForTask(id, 'out', Buffer.from(chunk), this.clock())
        this.notePtyLiveness(id)
        const cur = (this.outputBuffers.get(id) ?? '') + chunk
        this.outputBuffers.set(id, cur.length > TaskManager.OUTPUT_CAP ? cur.slice(-TaskManager.OUTPUT_CAP) : cur)
        this.emit('output', { taskId: id, chunk })
      })
      await ex.spawn({
        cwd: task.cwd, env: process.env, taskId: id,
        resumeSessionId: byId
          ? (task.agent === 'codex' ? (task.codexRolloutId ?? task.sessionId) : task.sessionId)
          : undefined,
      })
      await ex.isReady()
      ex.writeStdin('') // accept folder-trust; session reopens with full prior context
      await new Promise((r) => setTimeout(r, this.opts.trustAcceptMs))

      // RESUMING IS NOT PROMPTING. It brings the session back and stops there.
      //
      // This used to type a "you were interrupted, pick up where you left off"
      // nudge into any task whose status was not `done`, and submit it. So
      // pressing Resume did not restore a conversation — it took a turn in it,
      // on your behalf, with words you never wrote. On an IMPORTED session it
      // was worse: those carry no status file at all, so `status?.state` is
      // undefined, `undefined !== 'done'` is true, and every single import got
      // prompted the moment it came back.
      //
      // The rule, and it holds for every backend: resume makes a session
      // reachable again — terminal on screen, ready for your words — and sends
      // nothing. What to say next is yours. A task that really was cut off
      // mid-work is still cut off mid-work; the user can see that in the
      // terminal and decide, which is the whole reason we show it to them.
      //
      // The nudge builder stays in dispatch-prompt for now; nothing calls it.
      if (opts.touchActivity !== false) task.updatedAt = this.clock()
      // The "interrupted" reason is stale the moment the session is back — the
      // card should not keep explaining a failure that no longer applies.
      task.error = undefined
      this.parkWarm(id)
      this.emit('updated', task)
      tlog.event('resume-silent', {})
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
      if (opts.touchActivity !== false) task.updatedAt = this.clock()
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
   * The user OPENED this card — revive its resumable provider runtime when it
   * is not running.
   *
   * Startup normally reconnects to the detached runtime before the user gets
   * here. This remains the fallback for a machine restart or a runtime that was
   * deliberately aged out: OPENING the card is already the intent to resume,
   * so it should not stop at a redundant "session ended" panel.
   *
   * A card is the conversation, not a process-management screen. Selecting it
   * is therefore the one resume gesture for both sessions and errands; neither
   * should make the user press a second button before the composer works.
   * External backends are skipped: a Codex thread has no PTY and was never
   *    dead; resume() is a no-op for it (see the guard there).
   *  • ALREADY ALIVE is a no-op, and an in-flight respawn is absorbed by the
   *    open/resume single-flight guards. Both surfaces re-announce the open on
   *    every reconcile tick, so this is called repeatedly for one gesture and
   *    must stay idempotent.
   *
   * Fire-and-forget: the card is already on screen; it flips from the dead panel
   * to the live terminal when the respawn lands.
   */
  opened(id: string): void {
    const task = this.tasks.get(id)
    if (!task) return
    // History and provider lifetime are separate. An already-live runtime
    // still needs its card hydrated, while an inactive card remains
    // metadata-only until this explicit user gesture.
    void this.loadBlocksFor(id).catch(() => {})
    if (task.chatUnstarted) return
    if (isExternalAgent(task.agent)) return
    if (this.executors.get(id)?.alive) return
    if (this.resuming.has(id) || this.opening.has(id)) return
    const failedAt = this.autoResumeFailedAt.get(id)
    if (failedAt !== undefined && this.clock() - failedAt < TaskManager.AUTO_RESUME_COOLDOWN_MS) return
    this.opening.add(id)
    const tlog = log.child({ taskId: id })

    void (async () => {
      try {
        sessionLifecycleDev('task-open-waiting-for-startup', { taskId: id, sessionId: task.sessionId, provider: task.agent ?? null })
        await this.startupRecovery
        sessionLifecycleDev('task-open-startup-ready', { taskId: id, sessionId: task.sessionId, provider: task.agent ?? null })
        // ASK TMUX, NOT JUST OURSELVES.
        //
        // The guard above — "do I have a live executor?" — is an IN-PROCESS
        // question, and for the first seconds after launch the honest answer is
        // always no: reattachPersistent() has not run yet. So opening a card in
        // that window resumed a session whose runtime was alive the whole time.
        //
        // Measured 2026-08-29: card opened at 05:02:17, the discovery sweep ran
        // at 05:02:22. Five seconds. Every other task got tmux-attach-existing
        // and came straight up; the one touched inside the gap got a fresh
        // `claude --resume` instead.
        const live = await this.opts.listLiveRuntimeIds?.().catch(() => undefined)
        if (live?.has(id)) {
          // The runtime is there. Run the sweep NOW rather than waiting out its
          // schedule — it owns the attach path, and duplicating that here is
          // how the two would drift.
          tlog.event('open-found-live-runtime', { via: 'tmux' })
          await this.reattachPersistent()
          return
        }

        tlog.event('auto-resume-on-open', {})
        const ok = await this.resume(id, { touchActivity: false })
        if (!ok) {
          this.autoResumeFailedAt.set(id, this.clock())
          sessionLifecycleDev('auto-resume-cooled-down', { taskId: id, sessionId: task.sessionId, provider: task.agent ?? null })
          tlog.warn('auto-resume on open did not take', {})
          // Nothing is attached and nothing will attach, so no worker is ever
          // going to deliver this turn's completion. Ask the thread's own
          // rollout instead of leaving the card spinning on "Working".
          await this.settleFromRollout(id)
        } else this.autoResumeFailedAt.delete(id)
      } catch (e) {
        this.autoResumeFailedAt.set(id, this.clock())
        sessionLifecycleDev('auto-resume-cooled-down', { taskId: id, sessionId: task.sessionId, provider: task.agent ?? null, phase: 'exception' })
        tlog.error('auto-resume on open threw', { error: (e as Error).message })
      } finally {
        this.opening.delete(id)
      }
    })()
  }

  /** Settle a task the event stream abandoned, using the thread's own rollout.
   *
   *  A Codex task leaves `processing` when a live worker delivers
   *  `task_complete`. If nothing is attached when the turn ends, that event is
   *  dropped and the card spins on "Working" forever — with no Stop button,
   *  because there is no live turn to stop. The rollout is append-only and is
   *  the thread's own record, so it can still answer.
   *
   *  Returns false for anything it cannot PROVE finished. Wrongly marking a
   *  running task done is far worse than leaving a finished one spinning a
   *  little longer, so an unknown outcome must leave the card exactly as it is. */
  async settleFromRollout(id: string): Promise<boolean> {
    const task = this.tasks.get(id)
    const legacyDisconnect = task?.state === 'failed'
      && /session disconnected|interrupted by an app restart|connection lost/i.test(task.error?.reason ?? '')
    if (!task || task.state !== 'processing' && !legacyDisconnect) return false
    const rolloutId = task.codexRolloutId ?? task.codexThreadId ?? task.sessionId
    if (!rolloutId) return false
    const tlog = log.child({ taskId: id })
    const path = await this.opts.rolloutPathFor(rolloutId)
    if (!path) {
      tlog.event('settle-from-rollout-unreadable', { rolloutId })
      return false
    }
    const outcome = await rolloutOutcome(path)
    if (!outcome?.settled) {
      tlog.event('settle-from-rollout-inconclusive', { rolloutId, settled: outcome?.settled ?? null })
      return false
    }
    tlog.event('settled-from-rollout', { rolloutId, at: outcome.at })
    task.error = undefined
    task.resumeError = undefined
    task.deliveryError = undefined
    this.transition(id, 'done', {
      state: 'done',
      result: { summary: outcome.lastAgentMessage ?? 'Codex finished this turn.' },
    } as StatusPayload, outcome.at ? (Date.parse(outcome.at) || undefined) : undefined)
    return true
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

  /** Persist an attachment in the task's owned storage. Delivery is owned by the
   * task draft, so adding an image cannot mutate or submit a live terminal. */
  async attachFile(id: string, data: Uint8Array, ext: string): Promise<string | null> {
    const tlog = log.child({ taskId: id })
    const task = this.tasks.get(id)
    if (!task) {
      tlog.warn('attachFile: no task owns this draft', {})
      return null
    }
    const safeExt = (ext || 'png').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'png'
    const dir = await this.prepareAttachmentStorage(task)
    const file = join(dir, `attachment-${randomUUID()}.${safeExt}`)
    await fs.writeFile(file, data, { mode: 0o600, flag: 'wx' })
    tlog.event('file-attached', { file, bytes: data.byteLength })
    return file
  }

  private async prepareAttachmentStorage(task: Task): Promise<string> {
    const expected = join(this.opts.baseDir, this.opts.userKey ?? 'local', task.id)
    if (resolve(task.home) !== resolve(expected)) throw new Error('Attachment storage is not an owned task directory')
    const root = await fs.realpath(join(this.opts.baseDir, this.opts.userKey ?? 'local'))
    if (await fs.realpath(task.home) !== join(root, task.id)) throw new Error('Attachment storage cannot follow a redirected task directory')
    const protectDirectory = async (path: string) => {
      const handle = await fs.open(path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW)
      try { await handle.chmod(0o700) } finally { await handle.close() }
    }
    await protectDirectory(task.home)
    const dir = join(task.home, 'attachments')
    await fs.mkdir(dir, { mode: 0o700, recursive: true })
    await protectDirectory(dir)
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      const handle = await fs.open(join(dir, entry.name), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
      try { const info = await handle.stat(); if (info.isFile() && info.nlink === 1) await handle.chmod(0o600) }
      finally { await handle.close() }
    }
    return dir
  }

  /** Forward RAW keystrokes from the live terminal into the session's PTY
   *  (PRD §4.3 typeable terminal). No carriage return is appended — xterm sends
   *  the exact bytes (including Enter as \r) the user typed. No-op if dead. */
  sendInput(id: string, data: string): void {
    const ex = this.executors.get(id)
    if (!ex?.alive) return
    const t = this.tasks.get(id)
    if (t) {
      t.lastUserInputAt = this.clock() // typing into the terminal = consent
      // Persist at the submission boundary, not on every keystroke — same
      // boundary graduation (§5) counts against, for the same reason: a
      // task typed at directly in the terminal is exactly as much "still
      // being worked" as one replied to any other way.
      if (data.includes('\r')) {
        this.mergeMeta(t, { lastUserInputAt: t.lastUserInputAt }, 'typed-input')
        this.noteFollowUp(t)
        if (t.pocketRemoved) this.setInPocket(t.id, true)
      }
    }
    // A user typing into a parked-warm session means they want to keep working;
    // cancel the idle-kill so their hands-on session isn't reaped under them.
    const wt = this.warmTimers.get(id)
    if (wt) { clearTimeout(wt); this.warmTimers.delete(id) }
    this.trackTypedTurn(id, data)
    // The other half of the tap. This path carries BOTH real keystrokes and the
    // emulator's own protocol replies (DA, colour, size) with nothing to tell
    // them apart — which is the ambiguity that has to be resolved before any of
    // the terminal failures can be fixed. Off unless UNMUTE_PTY_TAP=1.
    tapPtyForTask(id, 'in', Buffer.from(data), this.clock())
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

  /**
   * Is a turn in flight RIGHT NOW, by the runtime's own account? Drives the
   * Stop affordance. `state` is the wrong source for that: a reattach that
   * lost the turn-start, or a mid-turn transport error, leaves the task
   * reading idle/failed while the provider keeps streaming.
   */
  turnActive(id: string): boolean {
    const task = this.tasks.get(id)
    if (task?.claudeSessionSettings) {
      const driver = this.claudeTasks.get(id)?.driver
      return !!driver && (driver.busy || !!driver.activeSubmissionId)
    }
    if (task?.codexSessionSettings) return this.opts.codexHub?.turnActive(id) === true
    return false
  }

  /** Is the task's PTY still alive (running or parked-warm)? */
  isAlive(id: string): boolean {
    if (this.tasks.get(id)?.claudeSessionSettings) return this.claudeTasks.get(id)?.driver.alive === true
    if (this.tasks.get(id)?.codexSessionSettings) return !!this.opts.codexHub?.threadIdFor(id) && this.opts.codexHub.running
    return this.executors.get(id)?.alive === true
  }

  private stopPolling(id: string): void {
    this.scheduler.unregister(id)
    this.claudeWatchers.get(id)?.()
    this.claudeWatchers.delete(id)
    this.codexWatchers.get(id)?.()
    this.codexWatchers.delete(id)
    const watched = this.transcriptWatchers.get(id)
    if (watched) {
      watched.stop()
      this.transcriptWatchers.delete(id)
      this.transcriptFiles.forget(watched.path)
    }
  }

  /** Attach one append watcher to a CLI transcript. Replacing the path is
   * expected during rollout rotation; the cache recovers from the new inode. */
  private ensureTranscriptWatcher(id: string, path: string): void {
    const current = this.transcriptWatchers.get(id)
    if (current?.path === path) return
    if (current) current.stop()
    try {
      let debounce: ReturnType<typeof setTimeout> | null = null
      const watcher = fsWatch(path, () => {
        if (debounce) clearTimeout(debounce)
        debounce = setTimeout(() => this.scheduler.trigger(id), 120)
      })
      const stop = () => {
        if (debounce) clearTimeout(debounce)
        watcher.close()
      }
      this.transcriptWatchers.set(id, { path, stop })
    } catch {
      // Best effort. The shared scheduler will retry discovery/reconciliation.
    }
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
    if (parked?.claudeSessionSettings || parked?.codexSessionSettings) {
      this.stopPolling(id)
      if (parked.kind !== 'session' && this.warmMsFor(id) > 0) this.armWarmTimer(id, this.warmMsFor(id))
      return
    }
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
    this.armWarmTimer(id, warmMs)
    tlog.event('parked-warm', { warmMs })
  }

  /** Arm (or re-arm) the single idle-kill timer for a warm session. */
  private armWarmTimer(id: string, warmMs: number): void {
    const tlog = log.child({ taskId: id })
    // NO ORPHANS. This used to `set()` over the previous entry without clearing
    // it, so every re-park left a live timer that nothing could reach: the map
    // holds one per task, and the cancel paths (followUp / sendInput / setKind)
    // can only cancel the one it holds. Field record (2026-08-20): task
    // 245d0a0b parked twice and fired `warm-idle-timeout` twice — the second
    // shot came from a timer that had already been "cancelled".
    const prev = this.warmTimers.get(id)
    if (prev) clearTimeout(prev)
    const t = setTimeout(() => {
      // THE LAST CHECK BEFORE THE KILL.
      //
      // The warm window belongs to a task that has FINISHED — it is there so a
      // follow-up doesn't pay for a cold start. It was never meant to reap a
      // session that is working, and every cancel path is one more place that
      // can forget to disarm it. One did: the Right-Option capture route
      // (deliverDraft) delivered a message, the task went back to `processing`,
      // and the timer armed before that message killed it mid-turn — reported to
      // the user as "The session ended before the task finished", which was true
      // and told them nothing about who ended it. It was us.
      //
      // So the decision is re-made at the moment it matters, from the task's
      // actual state rather than from a promise made warmMs ago. If it is not
      // settled, it is working: re-park and look again later. Correctness here
      // does not depend on every present or future write path remembering to
      // cancel — only on this one check.
      const cur = this.tasks.get(id)
      const stillAlive = this.executors.get(id)?.alive
      if (cur && stillAlive && !TERMINAL.includes(cur.state)) {
        // Re-arm ONLY. Going back through parkWarm would call stopPolling() on a
        // task that is mid-turn, blinding the card that is watching it.
        tlog.event('warm-idle-repark', { state: cur.state, warmMs })
        this.armWarmTimer(id, warmMs)
        return
      }
      // A one-off nobody followed up on within the warm window is not just a
      // process to kill — it's over, everywhere. hardKill() used to be the
      // whole story here: the PTY died but the task's row and its on-disk
      // record survived, leaving the pocket, the cockpit, and the dashboard
      // to each independently decide (with three DIFFERENT timers) how long
      // to keep showing a thing that was already dead. remove() does the
      // full erase (PRD §10.4) — same hardKill() underneath, plus the row
      // and its home dir are actually gone, so every surface agrees at once
      // and a relaunch can't resurrect it. Sessions never reach this timer
      // at all (parkWarm never arms it for kind === 'session').
      // THE RUNTIME EXPIRES, THE RECORD DOES NOT.
      //
      // This used to call remove(): hardKill, drop the row, and fs.rm the
      // task's home. The reasoning was that hardKill alone left the pocket,
      // the cockpit and the dashboard each deciding how long to keep showing
      // something already dead — three timers, three answers. That problem is
      // real, and erasing the task is not the only way to solve it: a task
      // left in a TERMINAL state is exactly what those surfaces already agree
      // about for a finished session, and they have agreed about it all along.
      //
      // A process is a cache and can be respawned by Resume. A conversation
      // and its card cannot be un-deleted, and on 2026-08-30 this cost the
      // user hours of work — so the two are no longer settled by one event.
      // purgeAgeMs remains the backstop that actually deletes.
      tlog.event('warm-idle-timeout', { warmMs, state: cur?.state ?? null, kept: true })
      this.hardKill(id)
      const settled = this.tasks.get(id)
      if (settled) {
        if (!TERMINAL.includes(settled.state)) settled.state = 'done'
        void this.persistState(settled).catch(() => {})
        this.emit('updated', settled)
      }
    }, warmMs)
    t.unref?.() // don't block process exit on the warm window
    this.warmTimers.set(id, t)
  }

  /**
   * THE TERMINAL IS THE LIVENESS SIGNAL.
   *
   * `stuck` used to be inferred purely from a gap in hook events and status
   * writes, so a turn that merely THINKS — or runs one long tool — for more than
   * staleMs read as hung. Field record (2026-08-19/20, task 628700b8): nine
   * `task-stuck` verdicts in one night, every one followed by `stuck-recovered
   * {via: hook}`. It was working the whole time, and we were reading its spinner
   * as we called it dead.
   *
   * Bytes arriving from the PTY are proof the process is alive and painting.
   * They cost nothing (the stream is already flowing into outputBuffers), they
   * work for every CLI agent rather than only the one that ships our hooks, and
   * they are strictly fresher than any hook. This advances lastHeartbeatMs ONLY
   * — never lastMtimeMs, which is the status read cursor (see poll()).
   */
  private notePtyLiveness(id: string): void {
    const task = this.tasks.get(id)
    if (!task) return
    task.lastHeartbeatMs = this.clock()
    if (task.state === 'stuck') {
      log.child({ taskId: id }).event('stuck-recovered', { via: 'pty' })
      this.transition(id, 'processing')
    }
  }

  /** Hard close: stop polling, cancel warm timer, kill the PTY (PRD §4.5). */
  private hardKill(id: string): void {
    this.claudeTasks.get(id)?.driver.close()
    this.claudeTasks.delete(id)
    this.stopPolling(id)
    const wt = this.warmTimers.get(id)
    if (wt) { clearTimeout(wt); this.warmTimers.delete(id) }
    this.typedBuffers.delete(id)
    // Per-task Codex poll bookkeeping dies with the task, never during polling:
    // clearing codexLastSeenAt on a live task makes every poll look like the
    // rollout advanced, which silently disables the blocked-turn detection.
    this.codexLastSeenAt.delete(id)
    const unwatch = this.codexWatchers.get(id)
    if (unwatch) { unwatch(); this.codexWatchers.delete(id) }
    // Same for Claude desktop, and for the same reason the Codex leak was
    // fixed: an fs.watch handle outliving its task keeps the event loop alive
    // forever. Omitting this hung the test run with no output at all.
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
