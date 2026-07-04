// Unmute Remote — tmux session wrapping (so "Open in terminal" attaches the
// SAME live session, not a new Claude Code).
//
// Why tmux: our owned PTY can't be handed to iTerm/Terminal — a PTY belongs to
// one process. tmux solves exactly this: the single `claude` process lives in a
// tmux session; our embedded xterm and an external terminal are just two CLIENTS
// attached to that one session. Same process, same context, live in both.
//
// Isolation that matters (PRD §3.2 billing guard): we run on a DEDICATED tmux
// socket (-L). tmux normally shares one server (and its env) across all the
// user's sessions — if the user already had a tmux server holding ANTHROPIC_API_
// KEY, our command would inherit it and bill API rates. A private socket starts
// our OWN server with our env-stripped environment. Keep this.
//
// This module is PURE arg-construction + a path resolver (testable). The actual
// spawn/exec lives in pty-session.ts / init.ts.

/** Private tmux socket so we never touch the user's own tmux server (env-isolation). */
export const TMUX_SOCKET = 'unmute-remote'

/** Deterministic session name for a task — both the executor and the
 *  open-in-terminal handler derive it the same way. (UUIDs have no '.'/':' so
 *  they're valid tmux session names.) */
export function sessionNameFor(taskId: string): string {
  return `unmute-${taskId}`
}

/** Minimal tmux config: no status bar, mouse scroll, fixed size, survive detach. */
export const TMUX_CONF = [
  'set -g status off',
  'set -g mouse on',
  // NOTE: do NOT add `set -g window-size manual` — it crashes the tmux 3.6b
  // server on window spawn ("server exited unexpectedly"), killing every task.
  // We pass an explicit `-x/-y` on new-session for the headless size anyway;
  // letting the window size to the attaching client is fine (and better for
  // pop-out, where the TUI reflows to the real terminal).
  'set -g history-limit 50000',
  'set -g destroy-unattached off', // keep the session alive between attaches
  'set -g escape-time 10',
  '',
].join('\n')

/** POSIX single-quote a token so a path/arg with spaces survives `sh -c`. */
export function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_\-./:=@%+,]+$/.test(s)) return s
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** Build the full shell command string tmux will run (bin + args, quoted). */
export function buildCommand(bin: string, args: string[]): string {
  return [bin, ...args].map(shellQuote).join(' ')
}

export interface TmuxNewSessionOpts {
  session: string
  command: string
  confPath: string
  cols?: number
  rows?: number
}

/** Args for `tmux … new-session` that runs `command` in a fixed-size session. */
export function tmuxNewSessionArgs(o: TmuxNewSessionOpts): string[] {
  return [
    '-L', TMUX_SOCKET,
    '-f', o.confPath,
    'new-session',
    '-A',                 // attach if it already exists, else create (idempotent)
    '-s', o.session,
    '-x', String(o.cols ?? 120),
    '-y', String(o.rows ?? 40),
    o.command,            // single arg ⇒ tmux runs it via sh -c
  ]
}

/** Args to attach an external terminal to the same session. */
export function tmuxAttachArgs(session: string): string[] {
  return ['-L', TMUX_SOCKET, 'attach-session', '-t', session]
}

/** Args to kill the session (terminates claude — detaching a client does NOT). */
export function tmuxKillSessionArgs(session: string): string[] {
  return ['-L', TMUX_SOCKET, 'kill-session', '-t', session]
}

/** Dump the session's CURRENT screen (+ recent history), colors included. tmux
 *  is the continuous observer — it has watched every byte since spawn — so this
 *  is the canonical picture of the terminal RIGHT NOW, no reconstruction, no
 *  repaint games. -e keeps escape sequences (colors), -p prints to stdout,
 *  -S -1000 includes up to 1000 lines of scrollback above the visible screen. */
export function tmuxCapturePaneArgs(session: string): string[] {
  return ['-L', TMUX_SOCKET, 'capture-pane', '-t', session, '-ep', '-S', '-1000']
}

/** Resolve the tmux binary across common install locations (Homebrew, MacPorts,
 *  system). Returns null if not installed — caller falls back to a direct spawn. */
export function resolveTmuxBin(
  exists: (p: string) => boolean,
  candidates: string[] = [
    '/opt/homebrew/bin/tmux',
    '/usr/local/bin/tmux',
    '/opt/local/bin/tmux',
    '/usr/bin/tmux',
  ],
): string | null {
  for (const p of candidates) {
    if (exists(p)) return p
  }
  return null
}
