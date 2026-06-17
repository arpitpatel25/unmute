// Unmute Remote — CLI-agent executor over an owned PTY (PRD §3.2, §4, §11).
//
// Generic core (CliAgentExecutor) drives ANY interactive CLI coding agent in a
// node-pty we own. The agent-specific bits — which binary, which env vars to
// strip for the right billing pool — are config. ClaudeCodeExecutor is the
// default adapter; CodexExecutor (codex-executor.ts) is a second, proving the
// seam is a config change, not a rewrite (PRD §11.3).
//
// HARD BILLING RULE for Claude (PRD §3.2): interactive REPL only (never -p /
// SDK), and STRIP ANTHROPIC_API_KEY (any API key overrides the subscription and
// bills API rates). The generic `stripEnvVars` makes this configurable per agent.
//
// Owning the PTY (node-pty, the lib VS Code's terminal uses) gives us: no
// dependency on any terminal app, no window (no focus to steal), bidirectional
// stdin/stdout, clean multi-session.

import { createLogger } from './log'
import type { AgentExecutor, SpawnOpts } from './executor'

const log = createLogger('pty-session')

// node-pty is a native module present only inside the built engine. Lazy-require
// so this module imports (and unit-tests) without node-pty installed.
interface IPtyProcess {
  onData(cb: (data: string) => void): void
  onExit(cb: (e: { exitCode: number }) => void): void
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
}
interface NodePty {
  spawn(file: string, args: string[], opts: Record<string, unknown>): IPtyProcess
}
function loadNodePty(): NodePty {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('node-pty') as NodePty
}

// Readiness heuristic timings (tune via Task-0 findings; PRD §15.4).
const READY_QUIET_MS = 700 // a quiet gap this long after first output ⇒ ready
const READY_MAX_MS = 8000 // hard cap so we never wait forever

export interface CliAgentConfig {
  /** The agent binary, e.g. 'claude' or 'codex'. */
  bin: string
  /** Extra launch args. NEVER include a headless flag (-p / --print). */
  extraArgs: string[]
  /** Env vars to delete before spawn — the billing-pool guard (PRD §3.2). */
  stripEnvVars: string[]
  /** Override the node-pty loader (tests inject a fake). */
  ptyLoader?: () => NodePty
  /** Component label for logs. */
  label: string
}

/** Generic interactive-CLI-agent executor in an owned PTY. */
export class CliAgentExecutor implements AgentExecutor {
  private pty: IPtyProcess | null = null
  private dataCbs: Array<(chunk: string) => void> = []
  private lastDataAt = 0
  private sawData = false
  private exited = false
  private taskId = ''

  constructor(protected readonly cfg: CliAgentConfig) {}

  get alive(): boolean {
    return this.pty !== null && !this.exited
  }

  async spawn(spawnOpts: SpawnOpts): Promise<void> {
    this.taskId = spawnOpts.taskId
    const slog = log.child({ taskId: this.taskId, agent: this.cfg.label })

    // ── Billing guard: strip the configured env vars (PRD §3.2) ──
    const env: NodeJS.ProcessEnv = { ...spawnOpts.env }
    let stripped = 0
    for (const k of this.cfg.stripEnvVars) {
      if (k in env) { delete env[k]; stripped++ }
    }
    slog.event('env-sanitized-for-subscription-billing', { strippedCount: stripped, vars: this.cfg.stripEnvVars })

    // ── Interactive REPL only — NO -p / SDK (PRD §3.2) ──
    slog.event('pty-spawn', { bin: this.cfg.bin, args: this.cfg.extraArgs, cwd: spawnOpts.cwd })
    const pty = (this.cfg.ptyLoader ?? loadNodePty)().spawn(this.cfg.bin, this.cfg.extraArgs, {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      cwd: spawnOpts.cwd,
      env,
    })
    this.pty = pty
    this.lastDataAt = Date.now()

    pty.onData((data) => {
      this.sawData = true
      this.lastDataAt = Date.now()
      for (const cb of this.dataCbs) {
        try { cb(data) } catch (e) { slog.error('onData callback threw', { error: (e as Error).message }) }
      }
    })
    pty.onExit(({ exitCode }) => {
      this.exited = true
      // PRD §4.5: the bare REPL does NOT exit on task completion — so an exit
      // here means we killed it, it crashed, or the user closed it.
      slog.event('pty-exit', { exitCode })
    })
  }

  /** Resolve once the TUI is ready: seen output AND quiet for READY_QUIET_MS. */
  async isReady(): Promise<void> {
    const slog = log.child({ taskId: this.taskId, agent: this.cfg.label })
    const start = Date.now()
    return new Promise<void>((resolve) => {
      const check = () => {
        if (this.exited) { slog.warn('isReady: pty exited before ready'); return resolve() }
        const now = Date.now()
        const quietFor = now - this.lastDataAt
        if (this.sawData && quietFor >= READY_QUIET_MS) {
          slog.event('repl-ready', { afterMs: now - start, quietFor })
          return resolve()
        }
        if (now - start >= READY_MAX_MS) {
          slog.warn('isReady: hard timeout — proceeding anyway', { afterMs: now - start, sawData: this.sawData })
          return resolve()
        }
        setTimeout(check, 100)
      }
      check()
    })
  }

  writeStdin(text: string): void {
    const slog = log.child({ taskId: this.taskId, agent: this.cfg.label })
    if (!this.pty || this.exited) { slog.warn('writeStdin on dead pty — dropped', { bytes: text.length }); return }
    this.pty.write(text)
    this.pty.write('\r') // REPL submits on carriage return
    slog.event('stdin-written', { bytes: text.length, preview: text.slice(0, 120) })
  }

  write(data: string): void {
    // RAW passthrough for the interactive terminal — NO appended carriage return.
    // Keep this quiet (debug, not event): a user typing fires this per keystroke.
    if (!this.pty || this.exited) return
    this.pty.write(data)
  }

  resize(cols: number, rows: number): void {
    if (!this.pty || this.exited) return
    const c = Math.max(1, Math.floor(cols))
    const r = Math.max(1, Math.floor(rows))
    try { this.pty.resize(c, r) } catch { /* pty may have just exited */ }
  }

  onData(cb: (chunk: string) => void): void {
    this.dataCbs.push(cb)
  }

  kill(): void {
    const slog = log.child({ taskId: this.taskId, agent: this.cfg.label })
    if (this.pty && !this.exited) {
      slog.event('pty-kill', {})
      try { this.pty.kill() } catch (e) { slog.error('kill threw', { error: (e as Error).message }) }
    }
  }
}

// ─── Claude Code adapter (default) ─────────────────────────────────

export interface ClaudeCodeExecutorOpts {
  claudeBin?: string
  extraArgs?: string[]
  /** PRD §10.6 sandbox: allowlisted roots the session may reach (--add-dir).
   *  Empty ⇒ no sandbox (default posture). */
  addDirs?: string[]
  /** Model for the executor session. DECIDED: 'opus' for task sessions
   *  (the router uses a lighter model). Passed as `--model <model>`.
   *  Set to '' / undefined to inherit the user's Claude Code default. */
  model?: string
  /** Connect Claude-in-Chrome browser control for this session (`--chrome`).
   *  DECIDED: always on for Remote (browser tasks need it; non-browser tasks
   *  ignore it). Requires the extension installed + connected. */
  chrome?: boolean
  ptyLoader?: () => NodePty
}

export class ClaudeCodeExecutor extends CliAgentExecutor {
  constructor(opts: ClaudeCodeExecutorOpts = {}) {
    const dirArgs = (opts.addDirs ?? []).flatMap((d) => ['--add-dir', d])
    const modelArgs = opts.model ? ['--model', opts.model] : []
    const chromeArgs = opts.chrome ? ['--chrome'] : []
    super({
      bin: opts.claudeBin || 'claude',
      // Order: model + chrome first (stable), then caller extras (e.g.
      // --dangerously-skip-permissions), then sandbox --add-dir roots.
      extraArgs: [...modelArgs, ...chromeArgs, ...(opts.extraArgs || []), ...dirArgs],
      // PRD §3.2: any of these flip billing off the subscription — strip all.
      stripEnvVars: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_API_KEY'],
      ptyLoader: opts.ptyLoader,
      label: 'claude',
    })
  }
}
