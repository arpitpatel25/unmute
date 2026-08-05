// Unmute Remote — the observer: deriving task state from what a session emits.
//
// This module replaces the 244-line operating contract. Instead of TELLING the
// model to report on itself in a schema we designed, we watch what Claude Code
// already produces — hook events plus its own transcript — and fill the status
// file ourselves. The session is left alone.
//
// The trade, stated plainly so nobody rediscovers it the hard way:
//
//   self-report  = authoritative, but costs a contract inside the session
//   observation  = free, but INFERRED
//
// So the rules below are deliberately conservative, and there is one hard rule
// running through all of them: **when the observer cannot tell, it says so.**
// A card reading "finished — couldn't tell if it needs you" is honest. A
// confidently wrong `done` is the failure mode we are actually trying to avoid,
// because it silently drops work out of the user's queue.
//
// Where precision genuinely matters, the session can still speak for itself via
// the optional `unmute_status` MCP tool — available, never required. That is the
// escape hatch, not the default.
//
// PURE by construction (no fs, no electron, no clock of its own) so every rule
// below is table-testable — house style, same as vadPolicy/correctionGate.

import type { StatusPayload, TaskState, TaskCategory } from './status-file'
import { urlsIn } from './transcript'

// ─── Hook events (what a session emits) ─────────────────────────────────────

export type HookEvent =
  /** UserPromptSubmit — the prompt actually landed. Retires verifyDispatch. */
  | { kind: 'prompt-submitted'; sessionId: string; cwd?: string }
  /** PostToolUse — real progress. Liveness only; never a state change. */
  | { kind: 'tool-used'; sessionId: string; cwd?: string; tool?: string }
  /** Stop — the turn ended, and here is the finished human-readable reply. */
  | { kind: 'turn-ended'; sessionId: string; cwd?: string; lastMessage: string }
  /** Notification — the session is waiting on the human. */
  | { kind: 'waiting'; sessionId: string; cwd?: string; message: string; notificationType?: string }
  /** SessionEnd — it is gone, and why. */
  | { kind: 'session-ended'; sessionId: string; cwd?: string; reason?: string }

/**
 * Normalize a raw hook payload into a typed event. Unknown events return null
 * rather than throwing: Claude Code keeps adding hook events, and an unfamiliar
 * one must be ignorable, never fatal.
 */
export function parseHookEvent(payload: unknown): HookEvent | null {
  if (typeof payload !== 'object' || payload === null) return null
  const p = payload as Record<string, unknown>
  const sessionId = typeof p.session_id === 'string' ? p.session_id : ''
  const cwd = typeof p.cwd === 'string' ? p.cwd : undefined
  if (!sessionId) return null
  switch (p.hook_event_name) {
    case 'UserPromptSubmit':
      return { kind: 'prompt-submitted', sessionId, cwd }
    case 'PostToolUse':
    case 'PostToolUseFailure':
      return { kind: 'tool-used', sessionId, cwd, tool: typeof p.tool_name === 'string' ? p.tool_name : undefined }
    case 'Stop':
      return {
        kind: 'turn-ended',
        sessionId,
        cwd,
        lastMessage: typeof p.last_assistant_message === 'string' ? p.last_assistant_message : '',
      }
    case 'Notification':
      return {
        kind: 'waiting',
        sessionId,
        cwd,
        message: typeof p.message === 'string' ? p.message : '',
        notificationType: typeof p.notification_type === 'string' ? p.notification_type : undefined,
      }
    case 'SessionEnd':
      return { kind: 'session-ended', sessionId, cwd, reason: typeof p.reason === 'string' ? p.reason : undefined }
    default:
      return null
  }
}

// ─── Reading a final message ────────────────────────────────────────────────

/** Strip the markdown a terminal reader wants but a spoken headline does not. */
export function plainLine(s: string): string {
  return s
    .replace(/^#{1,6}\s+/, '')          // heading markers
    .replace(/\*\*(.+?)\*\*/g, '$1')    // bold
    .replace(/\*(.+?)\*/g, '$1')        // italic
    .replace(/`(.+?)`/g, '$1')          // inline code
    .replace(/^[-*+]\s+/, '')           // list bullet
    .replace(/\[(.+?)\]\(.+?\)/g, '$1') // link text
    .trim()
}

/** The one-line summary: the message's first line that carries actual words.
 *  Not a model call — the first line of a well-written reply IS the headline. */
export function summarize(message: string, cap = 140): string {
  for (const raw of message.split('\n')) {
    const line = plainLine(raw)
    if (!line || /^[-=_|`>]+$/.test(line)) continue
    return line.length > cap ? `${line.slice(0, cap - 1).trimEnd()}…` : line
  }
  return ''
}

/**
 * Is the session's last word a question aimed at the user?
 *
 * Conservative on purpose. A real question to a human is SHORT and terminal —
 * it is the last thing said, and it is not a rhetorical aside buried in prose.
 * A long trailing line that happens to end in '?' is far more likely to be a
 * section heading or a rhetorical framing than an actual ask, and mislabelling a
 * finished task as blocked parks it in the user's queue forever.
 */
export function endsWithQuestion(message: string, maxLen = 200): boolean {
  const lines = message.split('\n').map((l) => plainLine(l)).filter(Boolean)
  const last = lines[lines.length - 1]
  if (!last) return false
  return last.endsWith('?') && last.length <= maxLen
}

// ─── Deriving the status ────────────────────────────────────────────────────

export interface ObserverContext {
  /** oneoff = an errand that ends; session = a thread the user returns to. */
  kind: 'oneoff' | 'session'
  /** Canonical surface from the router (gmail, youtube, …), when it had one. */
  surface?: string | null
  /** Did the transcript show mutating tool use? Drives info vs act. */
  sideEffects?: boolean
  /** The task's state before this event. */
  prior?: TaskState
  /** ISO timestamp to stamp (injected — this module owns no clock). */
  now: string
}

/** Surfaces whose whole point is media that plays. The category taxonomy exists
 *  so Unmute can hand off correctly (focus a video, don't steal focus for
 *  audio), and these two are the only entries in the canonical vocabulary that
 *  are unambiguously "it plays". */
const WATCH_SURFACES = new Set(['youtube', 'jiohotstar'])

/** Classify by END-STATE, exactly as the old contract asked the model to — the
 *  difference is that we now decide it from evidence instead of instruction. */
export function deriveCategory(ctx: ObserverContext, urls: readonly string[]): TaskCategory {
  if (ctx.surface && WATCH_SURFACES.has(ctx.surface)) return 'watch'
  if (ctx.sideEffects) return 'act'
  if (urls.length) return 'navigate'
  return 'info'
}

/** Two plain sentences for a human returning cold, built from what we know.
 *  Never invented: it restates the headline and names whose move it is. */
export function deriveThreadContext(summary: string, state: TaskState, kind: 'oneoff' | 'session'): string {
  const whose =
    state === 'needs-user' ? 'It is waiting on your answer before it can continue.'
      : state === 'ready' ? 'It has finished this step and is waiting for your next direction.'
        : state === 'failed' ? 'It stopped before finishing.'
          : state === 'done' ? (kind === 'session' ? 'Nothing is pending on this thread right now.' : 'Nothing further is expected.')
            : 'It is still working.'
  return summary ? `${summary} ${whose}` : whose
}

/**
 * Turn one hook event into a status write, or null when the event carries no
 * state (a heartbeat is liveness, not news — the caller bumps its own clock).
 *
 * The `turn-ended` branch is the whole product: Claude's own final reply becomes
 * `result.detail` verbatim. It is better prose than anything we could have asked
 * it to cram into a JSON field, because it was written for a human to read.
 */
export function deriveStatus(event: HookEvent, ctx: ObserverContext): StatusPayload | null {
  switch (event.kind) {
    case 'tool-used':
      return null // liveness only

    case 'prompt-submitted':
      return { schema_version: 1, state: 'processing', updated_at: ctx.now, step: 'working' }

    case 'waiting': {
      // A permission prompt is unambiguous: the session is stopped until a human
      // answers. Other notifications (idle, auth) are not state — ignore them
      // rather than parking a working task in the user's queue.
      if (event.notificationType && event.notificationType !== 'permission_prompt') return null
      const text = event.message.trim() || 'The session is waiting for your input.'
      return {
        schema_version: 1,
        state: 'needs-user',
        updated_at: ctx.now,
        step: 'waiting for you',
        question: { text, kind: 'free_text' },
        thread_context: deriveThreadContext(summarize(text), 'needs-user', ctx.kind),
      }
    }

    case 'session-ended': {
      // Only meaningful if the task never reached a terminal state — a session
      // that ends after finishing is just cleanup.
      if (ctx.prior === 'done' || ctx.prior === 'failed' || ctx.prior === 'ready') return null
      return {
        schema_version: 1,
        state: 'failed',
        updated_at: ctx.now,
        error: { reason: 'The session ended before the task finished.', detail: event.reason },
        thread_context: deriveThreadContext('', 'failed', ctx.kind),
      }
    }

    case 'turn-ended': {
      const message = event.lastMessage.trim()
      if (!message) {
        // The turn produced no prose at all. We genuinely cannot tell what
        // happened, and saying so is the honest move (see the header).
        return {
          schema_version: 1,
          state: ctx.kind === 'session' ? 'ready' : 'done',
          updated_at: ctx.now,
          category: 'act',
          result: { summary: 'Finished — the session ended its turn without a written reply.' },
          thread_context: 'The task finished its turn but wrote no reply, so there is nothing to report back. Open it to see what it did.',
        }
      }
      const blocked = endsWithQuestion(message)
      const state: TaskState = blocked ? 'needs-user' : ctx.kind === 'session' ? 'ready' : 'done'
      const urls = urlsIn(message)
      const summary = summarize(message)
      const payload: StatusPayload = {
        schema_version: 1,
        state,
        updated_at: ctx.now,
        category: deriveCategory(ctx, urls),
        result: {
          summary,
          detail: message,
          ...(urls.length ? { artifacts: urls.map((value) => ({ type: 'url' as const, value })) } : {}),
        },
        thread_context: deriveThreadContext(summary, state, ctx.kind),
      }
      if (blocked) {
        const lines = message.split('\n').map((l) => plainLine(l)).filter(Boolean)
        payload.question = { text: lines[lines.length - 1], kind: 'free_text' }
      }
      return payload
    }
  }
}
