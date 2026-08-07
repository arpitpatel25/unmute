// Unmute Remote — what we type into a session.
//
// It is the user's words. That is the whole module now, and the shrinking is
// the point.
//
// It used to be a header, a status-file path, a recipe-scratch path, hedged
// "memory leads" from a parked librarian, stale-skill caveats, an "Act now"
// imperative, and — on project-bound spawns — the entire 244-line operating
// contract pasted inline as a user turn. Then `followUp()` re-sent the same
// scaffolding around EVERY subsequent sentence the user spoke, for the life of
// the session.
//
// Two user complaints came out of that: their terminal was full of Unmute's
// paperwork, and Claude Code behaved worse under Unmute than on its own. The
// second is the serious one — the contract did not merely take up room, it
// installed a different personality ("act, don't ask", "the browser is your
// default tool", "scroll and paginate the full scope") onto sessions doing
// careful engineering work, stated with more force and more words than the
// user's actual request.
//
// Everything it carried now lives somewhere better:
//   * the status protocol   → hooks report OUT (session-policy.ts, observer.ts)
//   * the result            → Claude's own final reply (transcript.ts)
//   * the four-line framing → the system prompt (SESSION_PREAMBLE), not a turn
//   * the memory leads      → deleted; the librarian has been parked since
//                             2026-08-03 and nothing consumed them
//   * the recipe scratch    → deleted from the prompt, for the same reason
//
// If you are about to add a line here: that is exactly how the last one grew.
// Ask first whether a hook can observe it instead.

import { createLogger } from './log'

const log = createLogger('dispatch-prompt')

export interface DispatchInput {
  /** The cleaned intent (post intent-cleanup / router). Nothing else. */
  intent: string
}

/** The exact text typed into a session to dispatch one task: the intent. */
export function buildDispatch({ intent }: DispatchInput): string {
  const payload = intent.trim()
  log.event('dispatch-payload-built', { bytes: payload.length })
  return payload
}

/**
 * Built ONLY when resuming a task that did NOT finish (interrupted/killed
 * mid-work). `--resume` restores the session's full prior context, but the REPL
 * comes back idle — without a nudge it just sits there. This one stays because
 * it is genuinely task content: it says continue rather than restart. NEVER
 * sent to a task that already completed.
 */
export function buildResumeNudge(intent: string): string {
  return [
    'This was interrupted before it finished and has just been resumed with your full prior context.',
    'Pick up exactly where you left off and complete it — do NOT restart from scratch.',
    `Original request: ${intent}`,
  ].join('\n')
}
