import type { Harness, LocatedSession } from './locate.ts'

/**
 * WAKE OR FORK, decided here rather than inside the adapter.
 *
 * The old adapter made this call inline in init.ts, which is why the branch
 * that matters most — a session Unmute never started — had no test. It is a
 * pure decision over three facts, so it belongs where it can be exercised.
 */

/** Said when the user reopened a session without saying what for. */
export const REOPEN_INTENT = 'Continue from where we left off.'

export type ResumePlan =
  | { action: 'wake'; taskId: string; followUp?: string }
  | { action: 'fork'; harness: Harness; sessionId: string; cwd: string; intent: string }
  | { action: 'refuse'; reason: string }

export function planResume(input: {
  located: LocatedSession
  /** The card already driving this session, if Unmute is the one that started it. */
  existingTaskId?: string
  intent?: string
}): ResumePlan {
  const intent = input.intent?.trim()

  // An Unmute task already has a card and a runtime: wake that one rather than
  // minting a second card for the same conversation.
  if (input.existingTaskId) {
    return { action: 'wake', taskId: input.existingTaskId, ...(intent ? { followUp: intent } : {}) }
  }

  // A fork must resume inside the directory the work happened in — dispatch
  // enforces this, and without it the "fork" is a fresh unrelated session that
  // inherits nothing. Refusing is the honest outcome.
  if (!input.located.cwd) {
    return {
      action: 'refuse',
      reason: 'That session does not record the directory it ran in, so it cannot be reopened in place.',
    }
  }

  return {
    action: 'fork',
    harness: input.located.harness,
    sessionId: input.located.sessionId,
    cwd: input.located.cwd,
    intent: intent || REOPEN_INTENT,
  }
}

/**
 * Is this cwd a scratch directory Unmute reaped?
 *
 * A scratch one-off's cwd IS its home, and until the lifecycle change the warm
 * timer fs.rm'd that home fifteen minutes after the task finished. The
 * conversation outlives it — Claude keeps transcripts under ~/.claude/projects
 * and Codex under ~/.codex/sessions, neither inside the task directory — so
 * the session is still perfectly resumable. Refusing because the folder is
 * missing left the resume feature unable to recover from the one bug it was
 * most needed for.
 *
 * Recreating it is faithful: Unmute made that directory, nothing of the
 * user's was ever in it, and an empty one is exactly what a fresh task gets.
 *
 * A USER'S OWN DIRECTORY IS DIFFERENT. If a project folder has gone, something
 * happened outside Unmute — a move, a delete, an unmounted disk — and quietly
 * conjuring an empty folder in its place would resume the conversation into a
 * workspace stripped of everything it refers to. Only paths Unmute owns
 * qualify, and only one level below the root, which is where task directories
 * live.
 */
export function isReapedScratchCwd(cwd: string, localRoot: string): boolean {
  const root = localRoot.endsWith('/') ? localRoot.slice(0, -1) : localRoot
  if (!cwd.startsWith(`${root}/`)) return false
  const rest = cwd.slice(root.length + 1)
  return rest.length > 0 && !rest.includes('/')
}
