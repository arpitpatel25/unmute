// desktop/engine-overrides/electron/notetaker/headlessAgent.ts
//
// One-shot, non-interactive invocation of the user's own local Claude Code
// or Codex CLI — for the transcript cleanup + auto-summarization pipeline
// (2026-08-25 spec). Deliberately NOT the existing Task/PTY system
// (task-manager.ts, pty-session.ts): every existing path to these CLIs in
// this app spawns an interactive, tmux-wrapped, notch-integrated session
// meant to run indefinitely and be watched — pty-session.ts's own comment
// says "NEVER include a headless flag (-p / --print)". Forcing a one-shot
// "clean this transcript" call through that machinery would fight a system
// built for the opposite job. This is new and much simpler: spawn, feed
// stdin, capture stdout, exit — the same shape electron/remote/init.ts's
// own `execFile('claude', ['mcp', 'list'], ...)` already uses for other
// one-shot CLI calls, just longer-running and with a prompt on stdin
// instead of fixed argv.
//
// Plain child_process — no paywall/billing/licensing involvement, since
// this pipeline spends the USER'S OWN CLI usage, never Unmute's managed
// billing. That's exactly why this lives OSS-side (same tree as
// notetakerInit.ts) with no cross-tree hook: there is nothing
// closed-source about running a local binary. Provider AVAILABILITY
// (installed/signed-in) is the one piece that genuinely needs the
// closed-source tree's existing detection — that's the separate
// getAgentAvailability hook, not this file.

import { spawn } from 'node:child_process'
import { createNotetakerLogger } from './notetakerLog'

const log = createNotetakerLogger('headless-agent')

export type HeadlessProvider = 'claude' | 'codex'

export type HeadlessResult =
  | { ok: true; output: string }
  | { ok: false; error: string }

/** How long a single cleanup/summary call may run before being killed.
 *  Generous — a full-meeting transcript through a CLI's own startup
 *  overhead can take real time — but bounded, so a hung call can never
 *  hang the pipeline forever. */
export const DEFAULT_TIMEOUT_MS = 300_000

/**
 * Spawns `command` with `args`, writes `input` to its stdin, collects
 * stdout, and resolves once the process exits or the timeout elapses.
 * Never throws — every failure path (spawn error, non-zero exit, timeout)
 * resolves `{ ok: false, error }` instead. Factored out from
 * runHeadlessAgent so it can be exercised directly against a real,
 * trivially-controllable child process (Node itself) in tests, rather than
 * mocking child_process's internals.
 */
export function spawnAndCollect(
  command: string,
  args: string[],
  input: string,
  timeoutMs: number,
): Promise<HeadlessResult> {
  return new Promise((resolve) => {
    let settled = false
    const settle = (result: HeadlessResult) => {
      if (settled) return
      settled = true
      resolve(result)
    }

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (err) {
      settle({ ok: false, error: `spawn threw: ${err instanceof Error ? err.message : String(err)}` })
      return
    }

    const timer = setTimeout(() => {
      settle({ ok: false, error: `timed out after ${timeoutMs}ms` })
      try { child.kill() } catch { /* already gone */ }
    }, timeoutMs)
    // Never keep the process alive on this alone — a hung child that's
    // about to be killed by this same timer is not a reason to block exit.
    timer.unref?.()

    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString('utf8') })
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString('utf8') })

    child.on('error', (err) => {
      clearTimeout(timer)
      settle({ ok: false, error: `process error: ${err.message}` })
    })

    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) settle({ ok: true, output: stdout.trim() })
      else settle({ ok: false, error: stderr.trim() || `exited with code ${code}` })
    })

    try {
      child.stdin?.write(input)
      child.stdin?.end()
    } catch (err) {
      clearTimeout(timer)
      settle({ ok: false, error: `stdin write failed: ${err instanceof Error ? err.message : String(err)}` })
    }
  })
}

/**
 * The argv each provider's headless mode needs.
 *
 * CODEX REFUSES TO RUN OUTSIDE A TRUSTED GIT DIRECTORY. Without
 * `--skip-git-repo-check` it exits in about 70ms with "Not inside a trusted
 * directory", and every caller here runs somewhere that is deliberately not a
 * repo: the notetaker's cleanup and note-generation jobs, and the session
 * summariser, which works out of the Agent's own runtime directory precisely
 * so its transcripts never land in the user's projects.
 *
 * Measured before the fix: 1,352 sessions failing on every sweep, zero
 * summaries written, and — because a failed call deliberately does not advance
 * its cursor — all of them retried on the next sweep, forever. Roughly two
 * minutes of work every two minutes, indefinitely.
 *
 * The Agent's OWN turn path never had this bug: codex-headless.ts builds its
 * own argv and passes the flag. Two launchers, one of them missing it, and only
 * a machine whose provider was set to Codex would ever show it.
 *
 * Exported so the argv is testable without spawning anything.
 */
export function headlessArgvFor(provider: HeadlessProvider): [string, string[]] {
  return provider === 'claude'
    ? ['claude', ['-p']]
    : ['codex', ['exec', '--skip-git-repo-check']]
}

/**
 * Runs `input` through the given provider's headless CLI mode and returns
 * its stdout. `-p`/`--print` for Claude Code (prompt on stdin, matching how
 * the CLI's own headless mode is invoked elsewhere in the ecosystem);
 * `exec` for Codex, same shape.
 */
export async function runHeadlessAgent(
  provider: HeadlessProvider,
  input: string,
  opts: { timeoutMs?: number } = {},
): Promise<HeadlessResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const [command, args] = headlessArgvFor(provider)
  const startedAt = Date.now()
  const result = await spawnAndCollect(command, args, input, timeoutMs)
  const durationMs = Date.now() - startedAt
  if (result.ok) {
    log.debug('headless agent call succeeded', { provider, durationMs, outputLength: result.output.length })
  } else {
    log.error('headless agent call failed', { provider, durationMs, error: result.error })
  }
  return result
}
