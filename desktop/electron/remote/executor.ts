// Unmute Remote — the swappable CLI-agent executor interface (PRD §11).
//
// Portability seam: everything above this interface is agent-agnostic, so
// swapping Claude Code for another CLI coding agent (e.g. Codex, PRD §11.2) is
// an adapter change, not a rewrite. The default impl is ClaudeCodeExecutor
// (pty-session.ts).
//
// The interface is deliberately tiny: spawn a session, know when it's ready,
// write to its stdin, observe its raw output stream, and kill it.

export interface SpawnOpts {
  /** Working directory for the session (per-task dir; also where CLAUDE.md lives). */
  cwd: string
  /** Base environment. The executor MUST strip ANTHROPIC_API_KEY (PRD §3.2). */
  env: NodeJS.ProcessEnv
  /** Extra env vars layered on top (after sanitization) — e.g. the per-task
   *  UNMUTE_MCP_TOKEN that gives the session its Unmute-intercom identity. */
  extraEnv?: Record<string, string>
  /** Spawn as a FORK of this Claude session (--resume <id> --fork-session)
   *  instead of a fresh --session-id. The new session inherits that
   *  conversation's context; Claude mints the fork's own new session id. */
  forkFromSessionId?: string
  /** Correlation id for logging. */
  taskId: string
  /** Claude Code session id to PIN for this spawn (passed as `--session-id`).
   *  We mint it so the session is addressable by a stable handle (resume, read
   *  Claude's session store, future orchestration). Omitted on resume — there the
   *  session is CONTINUED by id (resumeSessionId) or, lacking one, via `--continue`. */
  sessionId?: string
  /** RESUME (continue, NOT fork) this exact Claude session by id: `--resume <id>`
   *  with NO `--fork-session`. Used by TaskManager.resume() so a resume in a cwd
   *  shared by several sessions attaches to THIS task's conversation, not merely
   *  the most-recent one that bare `--continue` would grab. Mutually exclusive
   *  with forkFromSessionId and sessionId. */
  resumeSessionId?: string
  /** Attach only to the already-running Unmute tmux session for taskId.
   *  No provider command is built or launched and no input is submitted. */
  attachExisting?: boolean
}

export interface AgentExecutor {
  /** Spawn the interactive agent REPL inside an owned PTY. */
  spawn(opts: SpawnOpts): Promise<void>
  /** Resolves once the REPL has booted and can accept typed input (PRD §5/#5). */
  isReady(): Promise<void>
  /** Type text into the REPL's stdin (used for dispatch + answering needs-user).
   *  Appends a carriage return — i.e. types the line AND submits it. */
  writeStdin(text: string): void
  /** Start an interactive composer draft without submitting it. Optional for
   * executors that are not backed by a TUI. */
  writeDraftText?(text: string): void
  /** Ask the TUI to ingest the image currently on the macOS pasteboard. */
  pasteImage?(): Promise<boolean>
  /** Submit a draft previously built with writeDraftText/pasteImage. */
  submitDraft?(): void
  /** Clear a partially composed TUI draft (Ctrl-U) after attachment failure. */
  clearDraft?(): void
  /** Write RAW bytes to the PTY with NO carriage return appended. Used by the
   *  live terminal so a user can type interactively (keystrokes, control codes,
   *  arrow keys) straight through to the REPL (PRD §4.3 typeable terminal). */
  write(data: string): void
  /** Resize the PTY viewport so the TUI reflows to the on-screen terminal. */
  resize(cols: number, rows: number): void
  /** Subscribe to the raw output stream (for render-on-demand + optional silence hint). */
  onData(cb: (chunk: string) => void): void
  /** Kill the session immediately (PRD §10.4 instant kill switch). */
  kill(): void
  /** Close only Unmute's PTY/tmux client, leaving the owned tmux session and
   * provider process running. Optional for executors without a detachable
   * runtime; callers must fall back to kill() there. */
  detach?(): void
  /**
   * Called when the underlying process exits, for any reason.
   *
   * Optional because a driver-transport backend has no process of its own. But
   * for a PTY backend this is the ONLY prompt signal that the session is gone:
   * `alive` has to be asked, and nothing was asking. A Codex CLI that quit half
   * a second after dispatch left its card reading "Working" for nine minutes
   * (2026-08-28), because the death was never observed — only pollable.
   */
  onExit?(cb: (e: { exitCode: number }) => void): void
  /** True while the PTY process is alive. */
  readonly alive: boolean
}

/** Factory type so callers can be handed a constructor without importing node-pty.
 *  `resume` (optional) asks for an executor that CONTINUES the cwd's existing
 *  session (e.g. `claude --continue`) rather than starting fresh — used by
 *  TaskManager.resume(). Factories that don't support resume ignore the flag.
 *
 *  `agent` (optional) names the backend to build FOR AN EXISTING TASK. Omit it
 *  only for brand-new work, where the user's current selection is the answer.
 *  Passing it is what stops a resumed task from being rebuilt on whatever the
 *  picker happens to say now — see codex/separation.test.ts. */
/** Per-spawn knobs the factory cannot derive from global settings. Optional so
 *  every existing caller keeps working. */
export interface ExecutorFactoryOpts {
  /** Connect Claude-in-Chrome for THIS session. Browser control used to be on
   *  unconditionally, which meant a session refactoring TypeScript still carried
   *  a browser tool surface it would never touch. It now follows the task's
   *  surface, so a coding task launches like an ordinary `claude`. */
  browser?: boolean
  /** CODEX CLI ONLY: attach the spawned TUI to an existing App Server thread
   *  rather than starting a conversation of its own.
   *
   *  `codex resume <threadId> --remote <url>`. Without the thread id the TUI
   *  would open a SECOND conversation against the same server, and the terminal
   *  would show a session unrelated to the card wrapped around it. */
  codexRemote?: { url: string; threadId: string }
}

export type ExecutorFactory = (
  resume?: boolean,
  agent?: import('./codex-executor').AgentKind,
  opts?: ExecutorFactoryOpts,
) => AgentExecutor
