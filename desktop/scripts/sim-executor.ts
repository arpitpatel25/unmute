// curator-sim — a NON-PTY AgentExecutor for running the real Skill Curator
// pipeline standalone (bare Node, no Electron ABI).
//
// The production executor (pty-session.ts) spawns `claude` in an interactive
// REPL inside a node-pty compiled for Electron's ABI — which throws
// posix_spawnp under bare Node. But makeRunSweep only ever drives the executor
// through the tiny AgentExecutor seam (spawn / isReady / writeStdin / write /
// onData / kill / alive), so we can satisfy that exact seam WITHOUT a pty by
// running `claude` HEADLESS (`-p`, prompt via stdin) as an ordinary child
// process. Same prompts, same model, same parsing/ledger/judge → the same
// result Unmute produces, just a different transport.
//
// How runOneShot (curator.ts) uses the seam, and how we map each call:
//   spawn(opts)        → remember cwd/env/taskId; do NOT launch claude yet.
//   isReady()          → resolve immediately (no REPL to boot).
//   writeStdin('')     → the folder-trust write (empty) — ignored.
//   writeStdin(prompt) → the FIRST non-empty write is the real prompt: launch
//                        `claude -p --dangerously-skip-permissions --model M`
//                        with the prompt fed via stdin. Idempotent — the sweep
//                        may re-inject the same prompt at 15s if the out-file
//                        hasn't appeared; we ignore the re-inject (a headless
//                        run legitimately takes longer than that).
//   write('\r' / …)    → no-op (no REPL to submit into).
//   onData(cb)         → forward child stdout+stderr so the sweep's rate-limit
//                        sentinel (RATE_LIMIT_RE) still trips on a usage cap.
//   kill()             → kill the child process.
//   alive              → true while the child is running.

import { spawn, type ChildProcess } from 'node:child_process'
import type { AgentExecutor, SpawnOpts } from '../electron/remote/executor.ts'

/** The claude binary. Overridable via env for unusual installs; defaults to
 *  the one on PATH (resolves the same `claude` the user runs interactively). */
const CLAUDE_BIN = process.env.UNMUTE_SIM_CLAUDE_BIN || 'claude'

/** Model for the headless one-shots. Production's curator sweep runs on the
 *  librarian executor (MODELS.librarian === 'opus'), so we default to opus for
 *  result-parity. Overridable via env for a cheaper/faster smoke. */
const MODEL = process.env.UNMUTE_SIM_MODEL || 'opus'

/** HOME to hand the child so `claude` finds the user's real login/auth even when
 *  the PARENT process has HOME redirected to a scratch fake-home (which the
 *  harness does so the dev-log's hardcoded curatorPaths() lands in scratch, not
 *  the real store). Defaults to the real home captured before any redirect. */
const REAL_HOME = process.env.UNMUTE_SIM_REAL_HOME || process.env.HOME || ''

/** Billing-pool guard, mirrored from pty-session.ts: any of these flip claude
 *  off the subscription onto API rates — strip them from the child's env. */
const STRIP_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_API_KEY']

export class SimExecutor implements AgentExecutor {
  private child: ChildProcess | null = null
  private exited = false
  private launched = false
  private dataCbs: Array<(chunk: string) => void> = []
  private cwd = process.cwd()
  private env: NodeJS.ProcessEnv = process.env
  private taskId = ''

  get alive(): boolean {
    return this.child !== null && !this.exited
  }

  // No REPL to boot — just record the launch context. claude is launched lazily
  // on the first real prompt (writeStdin), because that's when we have it.
  async spawn(opts: SpawnOpts): Promise<void> {
    this.cwd = opts.cwd
    this.env = { ...opts.env, ...(opts.extraEnv ?? {}) }
    this.taskId = opts.taskId
  }

  // Nothing to wait for — a headless child is spawned per-prompt, not booted.
  async isReady(): Promise<void> {
    return
  }

  writeStdin(text: string): void {
    // The initial empty-string write is the folder-trust accept in the pty REPL;
    // there is no REPL here, so ignore it.
    if (text.trim() === '') return
    // The FIRST non-empty write is the real prompt → launch claude once. A later
    // identical write is the sweep's 15s re-inject; a headless run just needs
    // more time, so ignore it rather than double-spawn.
    if (this.launched) return
    this.launched = true
    this.launchHeadless(text)
  }

  // RAW passthrough in the pty (submit key, control codes). No REPL → no-op.
  write(_data: string): void {
    /* no-op: nothing to submit into */
  }

  // No TUI to reflow.
  resize(_cols: number, _rows: number): void {
    /* no-op */
  }

  onData(cb: (chunk: string) => void): void {
    this.dataCbs.push(cb)
  }

  kill(): void {
    if (this.child && !this.exited) {
      try { this.child.kill('SIGKILL') } catch { /* best-effort */ }
    }
  }

  private emit(chunk: string): void {
    for (const cb of this.dataCbs) {
      try { cb(chunk) } catch { /* a sentinel callback must never break the child */ }
    }
  }

  private launchHeadless(prompt: string): void {
    // Strip the billing-pool env vars, then force the REAL home so claude finds
    // the user's login even though the parent's HOME points at the scratch
    // fake-home. Everything else (PATH, etc.) is inherited.
    const env: NodeJS.ProcessEnv = { ...this.env }
    for (const k of STRIP_ENV) delete env[k]
    if (REAL_HOME) env.HOME = REAL_HOME

    // Headless: `-p` (print / non-interactive), skip-permissions so Read/Write
    // tools run without prompting, and the same --model the sweep uses. The
    // prompt is large + multi-line, so it goes via STDIN, never argv.
    const args = ['-p', '--dangerously-skip-permissions', '--model', MODEL]
    const child = spawn(CLAUDE_BIN, args, { cwd: this.cwd, env })
    this.child = child

    child.stdout?.on('data', (d: Buffer) => this.emit(d.toString('utf8')))
    child.stderr?.on('data', (d: Buffer) => this.emit(d.toString('utf8')))
    child.on('exit', () => { this.exited = true })
    child.on('error', (err) => { this.exited = true; this.emit(`[sim-executor] spawn error: ${(err as Error).message}\n`) })

    // Feed the prompt on stdin and close it so claude runs to completion.
    try {
      child.stdin?.write(prompt)
      child.stdin?.end()
    } catch { /* if stdin is already gone the child will just have no prompt */ }
  }
}
