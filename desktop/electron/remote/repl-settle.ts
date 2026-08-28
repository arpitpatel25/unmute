// Unmute Remote — drive a freshly-spawned agent REPL to its idle input prompt,
// gated on WHAT IS ON SCREEN. Shared by the doer (task-manager) and the
// librarian so both dispatch reliably.
//
// Why: a packaged (Finder-launched) app, and a fresh task dir, both make the
// CLIs show startup dialogs — "trust this folder?", and for Codex a self-update
// chooser. If a prompt is injected before the REPL is actually at its input box,
// it does not merely get swallowed: it is typed INTO A MENU, and the keystrokes
// become selections. NEVER Esc — the trust dialog reads Esc as "No, exit".
//
// WHAT WENT WRONG (field, 2026-08-28 06:48), because every line below is a
// consequence of it:
//
//   * REPL_READY_RE was /bypasspermissions/ — a CLAUDE footer. Codex never
//     prints it, so for Codex this function could never conclude "ready". It
//     burned its whole 14s budget on every single dispatch.
//   * The only trigger for acting was SILENCE (700ms of unchanged output). The
//     Codex trust dialog repaints (mouse-tracking sequences), so the output
//     never held still, the gate never tripped, and no Enter was ever sent.
//   * Running out of budget returned nothing at all — no event, no signal.
//   * So the caller logged `folder-trust-accepted` (nothing had been accepted)
//     and typed a 315-byte task into the open trust menu. Codex exited 0, and
//     the card read "Working" over a dead terminal for nine minutes.
//
// The three rules that follow: know each agent's OWN ready marker; recognise a
// dialog by its CONTENT rather than by silence; and always report the outcome so
// the caller can refuse to type into a menu.

// Strip ANSI escapes + whitespace so TUI text (cursor-positioned, not spaced)
// matches as contiguous tokens.
const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[()][A-B0-2]|\x1b[=>]/g
export function stripTui(s: string): string {
  return s.replace(ANSI_RE, '').replace(/\s+/g, '').toLowerCase()
}

/** Claude's idle input-prompt footer in --dangerously-skip-permissions mode. */
export const REPL_READY_RE = /bypasspermissions/
/** Codex's idle input prompt. Either marker alone is enough — the composer
 *  placeholder and the shortcuts hint are drawn together at the input box. */
export const CODEX_READY_RE = /askcodextodoanything|\?forshortcuts/
export const TRUST_DIALOG_RE = /trustthisfolder|no,exit|esctocancel/
export const CODEX_TRUST_RE = /doyoutrustthecontentsofthisdirectory/
export const CODEX_UPDATE_RE = /updateavailable!.*updatenow.*skip.*skipuntilnextversion/
/** Claude Code's "Quick safety check" for an unseen directory. */
export const CLAUDE_TRUST_RE = /yes,itrustthisfolder/

/** Is this agent at its own input box? */
function readyFor(agent: string | undefined, out: string): boolean {
  return agent === 'codex' ? CODEX_READY_RE.test(out) : REPL_READY_RE.test(out)
}

/**
 * A startup dialog we recognise, and the keys that answer it.
 *
 * TARGETED, NEVER BLIND. The safety property is not which key is sent — it is
 * that keys are sent ONLY when this exact dialog has been positively matched on
 * screen, once, rather than fired at whatever happens to be drawn. Each entry's
 * sequence is chosen for the dialog it names, and the destructive default is
 * stepped off rather than confirmed.
 */
const DIALOGS: Array<{ id: string; agent?: string; match: RegExp; keys: string[] }> = [
  // Skip the self-update: Down, then Enter. Its default row is "1. Update now",
  // which runs an npm install and QUITS — so the cursor has to be moved off it
  // before anything is confirmed. This exact sequence is field-proven; a row
  // NUMBER would read better here but has never been shown to select anything
  // in this chooser, and guessing wrong lands on the destructive default.
  { id: 'codex-update', agent: 'codex', match: CODEX_UPDATE_RE, keys: ['\x1b[B\r'] },
  // Trust the directory: its default row IS the one we want ("1. Yes, continue"),
  // so Enter is correct here. What makes this safe is not the keystroke but the
  // targeting — it is sent only once, and only when this dialog is positively
  // on screen, rather than fired at whatever happens to be drawn.
  { id: 'codex-trust', agent: 'codex', match: CODEX_TRUST_RE, keys: ['\r'] },
  // Claude's trust dialog, and every part of this was measured rather than
  // reasoned about (28 Aug), because two plausible guesses were both wrong:
  //
  //   Down, then \r          -> the process EXITED (code 1)
  //   Down, then \n          -> survived, never confirmed
  //   Down, then \x1b[13u    -> reached the prompt
  //
  // Claude runs the kitty keyboard protocol (it emits \x1b[>5u at startup), so a
  // carriage return is not Enter. And it lists "No, exit" FIRST, so the bare
  // Enter the old quiet-path sent was confirming the exit - which is what killed
  // a task at 10:49 and had been doing so intermittently for far longer.
  { id: 'claude-trust', agent: 'claude', match: CLAUDE_TRUST_RE, keys: ['\x1b[B', '\x1b[13u'] },
]

/** Beat between the keystrokes of one dialog answer. */
const KEY_GAP_MS = 200
/**
 * How long a dialog must have been on screen before we answer it.
 *
 * Matching the TEXT is not the same as the dialog being ready to take input.
 * Answering the instant the words appeared sent Down into a dialog that was
 * still painting: the arrow went nowhere, the Enter that followed confirmed the
 * highlighted row - "No, exit" - and Claude quit with code 1. Observed directly
 * against a live CLI, and the only difference from a working run was timing.
 */
const DIALOG_ARM_MS = 600

export interface SettleReplOpts {
  /** Provider whose startup screens are being settled. */
  agent?: string
  /** The full accumulated raw output of the session so far. */
  getOutput: () => string
  /** Is the PTY still alive? */
  isAlive: () => boolean
  /** Send a single Enter (raw `\r`, NEVER Esc). */
  sendEnter: () => void
  /** Send raw input without an appended Enter — how a named option is chosen. */
  sendRaw?: (input: string) => void
  /** Optional structured logging hook. */
  onEvent?: (event: string, fields: Record<string, unknown>) => void
  quietMs?: number
  pollMs?: number
  maxEnters?: number
  maxWaitMs?: number
  /** Override the arming beat. Tests set 0; production wants the real delay. */
  dialogArmMs?: number
}

export interface SettleResult {
  /** Did we positively see this agent's input box? */
  settled: boolean
  reason: 'ready' | 'no-output' | 'bounds' | 'timeout' | 'dead'
  /** A recognised dialog still holding the screen when we gave up. The caller
   *  MUST NOT type when this is set — that is how a task becomes menu input. */
  dialog?: string
}

/** Resolve once the REPL is at its idle input prompt (or bounds hit). */
export async function settleRepl(o: SettleReplOpts): Promise<SettleResult> {
  const QUIET_MS = o.quietMs ?? 700
  const POLL_MS = o.pollMs ?? 150
  const MAX_ENTERS = o.maxEnters ?? 6
  const MAX_WAIT_MS = o.maxWaitMs ?? 14_000
  const ARM_MS = o.dialogArmMs ?? DIALOG_ARM_MS
  const emit = o.onEvent ?? (() => {})

  const t0 = Date.now()
  let enters = 0
  let lastLen = -1
  let lastChange = Date.now()
  const answered = new Set<string>()
  const seenAt = new Map<string, number>()
  let lastSeenDialog: string | undefined

  const finish = (r: SettleResult): SettleResult => {
    if (!r.settled) emit('repl-not-settled', { enters, reason: r.reason, dialog: r.dialog ?? null })
    else emit('repl-settled', { enters, reason: r.reason })
    return r
  }

  while (Date.now() - t0 < MAX_WAIT_MS) {
    if (!o.isAlive()) return finish({ settled: false, reason: 'dead' })
    await new Promise((r) => setTimeout(r, POLL_MS))
    const raw = o.getOutput()
    const out = stripTui(raw.slice(-4000))

    // DIALOGS FIRST, THEN READY - and the order is load-bearing.
    //
    // `out` is the ACCUMULATED output, not the current screen. Codex paints its
    // banner (which contains "Ask Codex to do anything") and only then draws the
    // trust dialog, so the ready marker is in that buffer permanently and a
    // dialog arriving afterwards could never win. Checking ready first meant
    // every Codex task was declared ready, typed into the trust menu, and exited
    // 0 about 200ms later (field, 2026-08-28 10:06). A pending dialog outranks a
    // marker that may simply be scrollback.
    // Only an UNANSWERED dialog counts. Its text stays in the accumulated buffer
    // after we answer it, so treating a spent dialog as pending would block the
    // ready check forever - the same scrollback trap that made ready match too
    // early, in the other direction.
    const dialog = DIALOGS.find((d) =>
      (!d.agent || d.agent === o.agent) && !answered.has(d.id) && d.match.test(out))
    if (!dialog && readyFor(o.agent, out)) return finish({ settled: true, reason: 'ready' })
    if (dialog) {
      lastSeenDialog = dialog.id
      // Let it become interactive before typing at it. See DIALOG_ARM_MS.
      const firstSeen = seenAt.get(dialog.id)
      if (firstSeen === undefined) { seenAt.set(dialog.id, Date.now()); continue }
      if (Date.now() - firstSeen < ARM_MS) continue
      // Answer each dialog ONCE, then stop treating it as pending: its text
      // lingers in the accumulated buffer exactly like the ready marker does,
      // so a dialog we have already answered must not block the ready check
      // forever.
      if (o.sendRaw) {
        answered.add(dialog.id)
        // ONE WRITE PER KEYSTROKE. Sent together, "\x1b[B\r" is consumed as a
        // single input event: the selection moves to the right row and then
        // bounces straight back, so nothing is confirmed. Observed directly.
        for (const k of dialog.keys) {
          o.sendRaw(k)
          if (dialog.keys.length > 1) await new Promise((r) => setTimeout(r, KEY_GAP_MS))
        }
        emit('dialog-answered', { dialog: dialog.id, keys: JSON.stringify(dialog.keys) })
        lastChange = Date.now()
        continue
      }
      // Nothing can answer it — record it so the caller refuses to type.
      continue
    }
    lastSeenDialog = undefined

    // Below here is the QUIET path: nudge an unrecognised-but-idle screen with
    // Enter. It is CLAUDE'S, and it stays because it is proven there.
    //
    // Codex is deliberately excluded. It has its own ready marker and its own
    // named dialogs, so a blind Enter can only ever land somewhere we failed to
    // recognise — which is the exact move that quit a session by choosing
    // "Update now". For Codex, not knowing means waiting, and then reporting
    // not-settled so the caller declines to type.
    if (raw.length !== lastLen) { lastLen = raw.length; lastChange = Date.now(); continue }
    if (Date.now() - lastChange < QUIET_MS) continue
    if (raw.length === 0) return finish({ settled: true, reason: 'no-output' })
    if (o.agent === 'codex') continue
    if (enters < MAX_ENTERS) {
      o.sendEnter() // Enter = accept trust / no-op on empty prompt; NEVER Esc
      enters += 1
      lastChange = Date.now()
      emit('settle-enter', { attempt: enters, dialog: TRUST_DIALOG_RE.test(out) })
      continue
    }
    return finish({ settled: false, reason: 'bounds', dialog: lastSeenDialog })
  }
  return finish({ settled: false, reason: 'timeout', dialog: lastSeenDialog })
}
