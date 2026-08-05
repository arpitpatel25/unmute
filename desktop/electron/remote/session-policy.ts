// Unmute Remote — session policy: everything Unmute is allowed to do to a
// Claude Code session at launch, in one place.
//
// THE PRINCIPLE (decided 2026-08-06): **Unmute observes a Claude Code session.
// It never modifies one.** Diff a session Unmute started against one the user
// started themselves and the only difference should be the task text.
//
// That is not a slogan — it is why users reported two things: that their
// terminal was full of Unmute's scaffolding, and that Claude Code performed
// worse under Unmute than on its own. Both were true, and both came from the
// same habit of reaching into the session:
//
//   * a 244-line operating contract, pasted as a USER TURN on project-bound
//     spawns, re-anchored on EVERY follow-up
//   * `--model` pinned to our default, silently overriding the user's own
//   * `--chrome` on unconditionally, in sessions that never open a browser
//   * a CLAUDE.md, a hook script, marker files and skill copies written into
//     the session's working directory
//   * a Stop hook that BLOCKED the end of every turn to demand paperwork
//
// None of that made the work better; several parts made it worse. So the
// session now gets: the user's own defaults, the task text, and hooks that
// report OUT. Everything Unmute needs to know is derived from what the session
// naturally emits (see observer.ts), never demanded from it.
//
// This module is PURE (no electron, no fs) apart from `writeHookSettings`, so
// the policy itself is unit-testable — including the guard in `ALLOWED_FLAGS`
// that stops the next well-meant injection from creeping back in.

/** Where hook events are POSTed. Same port as the MCP intercom (mcp-server.ts)
 *  so a session opens exactly one local connection to Unmute, not two. */
export const HOOK_PATH = '/hook'

/**
 * The ONLY text Unmute adds to a session, appended to the system prompt (not
 * typed as a user turn — it is framing, not a request).
 *
 * Four lines, and every one earns its place:
 *   1. why the session exists (a human spoke this and walked away)
 *   2. permission to behave normally — the explicit repeal of the old contract
 *   3. how to reach the user (just ask; Unmute routes the answer back)
 *   4. that nothing else is required of it
 *
 * What is deliberately NOT here: the status-file protocol, the JSON schema, the
 * atomic-write dance, the task taxonomy, heartbeat cadence, browser-first tool
 * routing, thoroughness exhortations, and the memory/librarian section (whose
 * librarian has been parked since 2026-08-03). Every one of those is either
 * derived by the observer, enforced by a hook, or dead.
 */
export const SESSION_PREAMBLE = [
  'You are running as an Unmute task: the user spoke this request out loud and walked away.',
  'Work exactly as you would in any other Claude Code session — Unmute watches from the outside and needs nothing from you.',
  'If you need the user, just say so plainly at the end of your reply and stop; they will hear it and their answer arrives here.',
  'When you finish, your final reply IS the result the user sees — write it for them.',
].join('\n')

/**
 * Flags Unmute may add to a `claude` launch. Anything outside this set is a
 * modification of the user's session and must not ship.
 *
 * `--model` is absent ON PURPOSE. Pinning it is how a user whose own default is
 * Opus silently got Sonnet on every Unmute task and reported that "Claude Code
 * works worse in Unmute" — with nothing anywhere telling them why. The model now
 * comes from the user's own configuration unless they pick one in the picker,
 * in which case it is their choice and travels as an explicit selection.
 */
export const ALLOWED_FLAGS: readonly string[] = [
  '--session-id',            // we mint it: our only handle on the conversation
  '--resume',                // continue/fork an existing conversation
  '--fork-session',
  '--continue',
  '--add-dir',               // the user's own sandbox roots, from settings
  '--mcp-config',            // the Unmute intercom — capability, not constraint
  '--settings',              // our hooks, WITHOUT writing into the user's repo
  '--append-system-prompt',  // SESSION_PREAMBLE, four lines
  '--model',                 // ONLY when the user explicitly picked one
  '--chrome',                // ONLY when the task actually targets the browser
  '--dangerously-skip-permissions', // ONLY in the user's auto-approve mode
]

/** Surfaces that are literally websites, so a task on one needs browser control. */
const WEB_SURFACES = new Set([
  'gmail', 'google-calendar', 'google-sheets', 'google-docs', 'google-drive',
  'canva', 'youtube', 'x', 'jiohotstar', 'whatsapp',
])

/**
 * Should THIS task get `--chrome`?
 *
 * The rule: a project-bound session is engineering work in a repo and never
 * wants a browser tool surface; an errand on a web surface always does; an
 * unclassified one-off keeps it, because spoken errands are usually web-shaped
 * and losing the browser there would be a real regression.
 *
 * `macos` is deliberately absent from WEB_SURFACES — it means Finder and native
 * apps, which is exactly the case that never needed Chrome.
 */
export function browserFor(o: { surface?: string | null; projectBound: boolean }): boolean {
  if (o.projectBound) return false
  if (!o.surface || o.surface === 'general') return true
  return WEB_SURFACES.has(o.surface)
}

/** Extract the flag names (leading `--…`) from a built argv, for the guard. */
export function flagsIn(argv: readonly string[]): string[] {
  return argv.filter((a) => a.startsWith('--'))
}

/** True when every flag in `argv` is one Unmute is allowed to add. The
 *  no-modification test asserts this against a real executor's argv. */
export function flagsAllowed(argv: readonly string[]): boolean {
  return flagsIn(argv).every((f) => ALLOWED_FLAGS.includes(f))
}

// ─── Hook settings (the report-OUT channel) ─────────────────────────────────

/**
 * The curl one-liner every hook runs. Hooks receive their event JSON on stdin,
 * so `--data-binary @-` forwards it verbatim — no jq, no node, no wrapper
 * script, and nothing to keep in sync with the event schema.
 *
 * Chosen over `type: "http"` deliberately: a command hook is the shape every
 * Claude Code version understands, so a user on an older CLI still reports.
 * `curl` ships with macOS, and a 2s cap means an unreachable Unmute costs the
 * session 2 seconds once, never a hang.
 */
export function hookCommand(port: number, token: string): string {
  const url = `http://127.0.0.1:${port}${HOOK_PATH}`
  return [
    'curl -sS -m 2 -X POST',
    `-H 'Content-Type: application/json'`,
    `-H 'Authorization: Bearer ${token}'`,
    '--data-binary @-',
    `'${url}'`,
    '>/dev/null 2>&1',
  ].join(' ')
}

/**
 * The settings document handed to `claude --settings <file>`.
 *
 * FIVE events, and each one replaces something we used to ask the model for in
 * prose or infer from a screen:
 *
 *   UserPromptSubmit — the prompt actually landed. This is what retires
 *     `verifyDispatch`: we no longer guess from a marker file's mtime whether a
 *     multi-line paste got swallowed, we are TOLD.
 *   PostToolUse      — liveness, keyed on real tool execution rather than TUI
 *     redraw noise. A genuinely hung session still goes quiet, so the staleness
 *     backstop keeps working.
 *   Stop             — the turn ended, and the payload carries
 *     `last_assistant_message`: the finished, human-readable answer, with no
 *     thinking and no tool traffic in it. This is the whole result channel.
 *   Notification     — the session is waiting on the human (permission prompt,
 *     idle prompt). The ask-channel, deterministically.
 *   SessionEnd       — it is gone, and why.
 *
 * Every hook is `async` so NOTHING Unmute does can delay a turn. The old Stop
 * hook blocked the end of every single turn to demand a status write; that is
 * the interruption users felt, and it is gone.
 */
export function buildHookSettings(port: number, token: string): Record<string, unknown> {
  const hook = { type: 'command', command: hookCommand(port, token), async: true, timeout: 5 }
  return {
    hooks: {
      UserPromptSubmit: [{ hooks: [hook] }],
      PostToolUse: [{ matcher: '*', hooks: [hook] }],
      Stop: [{ hooks: [hook] }],
      Notification: [{ hooks: [hook] }],
      SessionEnd: [{ hooks: [hook] }],
    },
  }
}
