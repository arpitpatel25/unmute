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
  /** Correlation id for logging. */
  taskId: string
}

export interface AgentExecutor {
  /** Spawn the interactive agent REPL inside an owned PTY. */
  spawn(opts: SpawnOpts): Promise<void>
  /** Resolves once the REPL has booted and can accept typed input (PRD §5/#5). */
  isReady(): Promise<void>
  /** Type text into the REPL's stdin (used for dispatch + answering needs-user). */
  writeStdin(text: string): void
  /** Subscribe to the raw output stream (for render-on-demand + optional silence hint). */
  onData(cb: (chunk: string) => void): void
  /** Kill the session immediately (PRD §10.4 instant kill switch). */
  kill(): void
  /** True while the PTY process is alive. */
  readonly alive: boolean
}

/** Factory type so callers can be handed a constructor without importing node-pty. */
export type ExecutorFactory = () => AgentExecutor
