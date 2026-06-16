// Unmute Remote — ClaudeCodeExecutor: the interactive `claude` REPL in an
// owned PTY (PRD §3.2, §4.1, §4.5).
//
// HARD BILLING RULES (PRD §3.2 — the single most important constraint):
//   1. Spawn the interactive `claude` REPL. NEVER `claude -p`, NEVER the SDK.
//   2. STRIP ANTHROPIC_API_KEY from the environment — any API key overrides
//      the subscription and bills API rates. The session must auth via the
//      user's own Claude Code subscription login.
//
// We own the PTY (node-pty, the lib VS Code's terminal uses, PRD §4.1) so:
//   * no dependency on any installed terminal app,
//   * no window ⇒ no focus to steal,
//   * direct bidirectional stdin/stdout.
//
// Readiness detection (PRD §5/#5): the TUI takes a moment to boot. We wait for
// a quiet window after first output before declaring ready, with a hard
// fallback timeout. The exact ready signature is refined by the Task-0 probe;
// the quiet-window heuristic is robust regardless of the TUI's exact banner.

import { createLogger } from './log'
import type { AgentExecutor, SpawnOpts } from './executor'

const log = createLogger('pty-session')

// node-pty is a native module; it's only present inside the built engine, not
// in the source-overlay's dev env. Lazy-require so this module can be imported
// (and the surrounding logic unit-tested) without node-pty installed.
interface IPtyProcess {
  onData(cb: (data: string) => void): void
  onExit(cb: (e: { exitCode: number }) => void): void
  write(data: string): void
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

export interface ClaudeCodeExecutorOpts {
  /** Path to the `claude` binary. Default resolves from PATH. */
  claudeBin?: string
  /** Extra args appended to the interactive launch (NEVER include -p). */
  extraArgs?: string[]
  /** Override node-pty loader (tests inject a fake). */
  ptyLoader?: () => NodePty
}

export class ClaudeCodeExecutor implements AgentExecutor {
  private pty: IPtyProcess | null = null
  private dataCbs: Array<(chunk: string) => void> = []
  private lastDataAt = 0
  private sawData = false
  private exited = false
  private taskId = ''
  private readonly opts: ClaudeCodeExecutorOpts

  constructor(opts: ClaudeCodeExecutorOpts = {}) {
    this.opts = opts
  }

  get alive(): boolean {
    return this.pty !== null && !this.exited
  }

  async spawn(spawnOpts: SpawnOpts): Promise<void> {
    this.taskId = spawnOpts.taskId
    const slog = log.child({ taskId: this.taskId })

    // ── BILLING RULE 2: strip ANTHROPIC_API_KEY (and any alias) ──
    const env: NodeJS.ProcessEnv = { ...spawnOpts.env }
    let strippedKey = false
    for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_API_KEY']) {
      if (k in env) {
        delete env[k]
        strippedKey = true
      }
    }
    slog.event('env-sanitized-for-subscription-billing', { strippedApiKey: strippedKey })

    const bin = this.opts.claudeBin || 'claude'
    // ── BILLING RULE 1: interactive REPL only — NO -p, NO SDK. ──
    const args = [...(this.opts.extraArgs || [])]
    slog.event('pty-spawn', { bin, args, cwd: spawnOpts.cwd })

    const pty = (this.opts.ptyLoader ?? loadNodePty)().spawn(bin, args, {
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
      // here means we killed it, it crashed, or the user closed it. Log loudly.
      slog.event('pty-exit', { exitCode })
    })
  }

  /**
   * Resolve once the TUI is ready for input. Heuristic: wait until we've seen
   * output AND it has been quiet for READY_QUIET_MS — i.e. the TUI finished its
   * initial paint and is sitting at the prompt. Hard cap at READY_MAX_MS.
   */
  async isReady(): Promise<void> {
    const slog = log.child({ taskId: this.taskId })
    const start = Date.now()
    return new Promise<void>((resolve) => {
      const check = () => {
        if (this.exited) {
          slog.warn('isReady: pty exited before ready')
          return resolve()
        }
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
    const slog = log.child({ taskId: this.taskId })
    if (!this.pty || this.exited) {
      slog.warn('writeStdin on dead pty — dropped', { bytes: text.length })
      return
    }
    // The REPL submits on a carriage return. Send the text then CR.
    this.pty.write(text)
    this.pty.write('\r')
    slog.event('stdin-written', { bytes: text.length, preview: text.slice(0, 120) })
  }

  onData(cb: (chunk: string) => void): void {
    this.dataCbs.push(cb)
  }

  kill(): void {
    const slog = log.child({ taskId: this.taskId })
    if (this.pty && !this.exited) {
      slog.event('pty-kill', {})
      try { this.pty.kill() } catch (e) { slog.error('kill threw', { error: (e as Error).message }) }
    }
  }
}
