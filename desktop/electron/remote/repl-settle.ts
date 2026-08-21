// Unmute Remote — drive a freshly-spawned Claude Code REPL to its idle input
// prompt using ONLY Enter, gated on OBSERVED output. Shared by the doer
// (task-manager) AND the librarian so both dispatch reliably.
//
// Why: a packaged (Finder-launched) app, and a fresh task dir, both make Claude
// show a "trust this folder?" dialog at startup; if a prompt is injected before
// the REPL is actually idle, it gets swallowed and the session sits at an empty
// prompt forever. The OLD fix was a blind fixed-timer Enter, which races. This
// watches the output: send Enter whenever it goes quiet, until the REPL reaches
// its ready input prompt (the "bypass permissions" footer) or bounds hit — THEN
// the caller dispatches. NEVER Esc — the trust dialog reads Esc as "No, exit"
// and QUITS Claude (validated by the Task-0 probe).

// Strip ANSI escapes + whitespace so TUI text (cursor-positioned, not spaced)
// matches as contiguous tokens.
const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[()][A-B0-2]|\x1b[=>]/g
export function stripTui(s: string): string {
  return s.replace(ANSI_RE, '').replace(/\s+/g, '').toLowerCase()
}
// Idle input-prompt footer shown in --dangerously-skip-permissions mode → the
// "REPL is ready, dispatch now" signal. Trust-dialog markers are for logging.
export const REPL_READY_RE = /bypasspermissions/
export const TRUST_DIALOG_RE = /trustthisfolder|no,exit|esctocancel/
export const CODEX_UPDATE_RE = /updateavailable!.*updatenow.*skip.*skipuntilnextversion.*pressentertocontinue/

export interface SettleReplOpts {
  /** Provider whose startup screens are being settled. */
  agent?: string
  /** The full accumulated raw output of the session so far. */
  getOutput: () => string
  /** Is the PTY still alive? */
  isAlive: () => boolean
  /** Send a single Enter (raw `\r`, NEVER Esc). */
  sendEnter: () => void
  /** Send provider-specific raw input without an appended Enter. */
  sendRaw?: (input: string) => void
  /** Optional structured logging hook. */
  onEvent?: (event: string, fields: Record<string, unknown>) => void
  quietMs?: number
  pollMs?: number
  maxEnters?: number
  maxWaitMs?: number
}

/** Resolve once the REPL is at its idle input prompt (or bounds hit). */
export async function settleRepl(o: SettleReplOpts): Promise<void> {
  const QUIET_MS = o.quietMs ?? 700
  const POLL_MS = o.pollMs ?? 150
  const MAX_ENTERS = o.maxEnters ?? 6
  const MAX_WAIT_MS = o.maxWaitMs ?? 14_000
  const emit = o.onEvent ?? (() => {})

  const t0 = Date.now()
  let enters = 0
  let codexUpdateHandled = false
  let lastLen = -1
  let lastChange = Date.now()
  while (Date.now() - t0 < MAX_WAIT_MS && o.isAlive()) {
    await new Promise((r) => setTimeout(r, POLL_MS))
    const raw = o.getOutput()
    if (raw.length !== lastLen) { lastLen = raw.length; lastChange = Date.now(); continue }
    if (Date.now() - lastChange < QUIET_MS) continue // not quiet yet
    // No output at all after going quiet → nothing to settle (claude always
    // paints a TUI, so this is a no-output executor, e.g. tests). Proceed.
    if (raw.length === 0) { emit('repl-settled', { enters, reason: 'no-output' }); return }
    const out = stripTui(raw.slice(-4000))
    if (REPL_READY_RE.test(out)) { emit('repl-settled', { enters }); return }
    // Codex occasionally pauses startup on its self-update chooser. Accepting
    // the default would mutate the user's global installation and then exit,
    // so choose the non-mutating "Skip" row explicitly (Down + Enter).
    if (o.agent === 'codex' && CODEX_UPDATE_RE.test(out) && o.sendRaw) {
      if (!codexUpdateHandled) {
        o.sendRaw('\x1b[B\r')
        codexUpdateHandled = true
        emit('codex-update-skipped', {})
      }
      lastChange = Date.now()
      continue
    }
    if (enters < MAX_ENTERS) {
      o.sendEnter() // Enter = accept trust / no-op on empty prompt; NEVER Esc
      enters += 1
      lastChange = Date.now() // give it a beat to react before the next Enter
      emit('settle-enter', { attempt: enters, dialog: TRUST_DIALOG_RE.test(out) })
      continue
    }
    emit('repl-not-settled', { enters }) // bounds hit — dispatch anyway
    return
  }
}
