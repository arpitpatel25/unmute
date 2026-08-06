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

/** One question inside an ask, exactly as AskUserQuestion declares it. */
export interface AskQuestion {
  question: string
  header?: string
  multiSelect: boolean
  options: Array<{ label: string; description?: string }>
}

/**
 * Can Unmute answer this ask on the user's behalf?
 *
 * ONLY the simplest shape, and this is a deliberate refusal rather than a gap.
 * Verified against a live picker: a single single-select question is one
 * keystroke — the index — and lands exactly. Anything richer is a TAB BAR:
 * pick in tab 1, it auto-advances, toggle checkboxes in tab 2, Tab to a Submit
 * entry that has no number, Enter. We can watch that sequence; we have not
 * proven we can DRIVE it through a PTY, and a half-driven picker leaves the ask
 * hanging with the model waiting.
 *
 * So a complex ask is shown, not answered — the terminal underneath is live and
 * already knows how. Refusing loudly beats answering wrongly in silence, which
 * is the one failure mode of this whole design that corrupts instead of degrades.
 */
export function isAnswerable(questions: readonly AskQuestion[]): boolean {
  return questions.length === 1 && !questions[0].multiSelect && questions[0].options.length > 0
}

/**
 * The whole ask, written out for a card that cannot be clicked.
 *
 * Refusing to drive a picker does not excuse us from showing what it asks. The
 * user still has to DECIDE, and deciding needs what the terminal shows: every
 * question, every option, and the description that makes one option different
 * from another. Listing the questions and hiding the options — which is what
 * shipped — left the user a set of things they could not evaluate and a
 * terminal they had to go read anyway, which is strictly worse than the
 * terminal alone.
 *
 * A plan is the one shape with no options: its "question" IS the document, so
 * it goes through whole, without numbering or bullets bolted around markdown.
 */
export function renderAsk(questions: readonly AskQuestion[]): string {
  if (questions.length === 1 && questions[0].options.length === 0) return questions[0].question
  const numbered = questions.length > 1
  return questions
    .map((q, i) => {
      const head = numbered ? `${i + 1}. ${q.question}` : q.question
      const rule = q.multiSelect ? 'pick any' : 'pick one'
      const opts = q.options.map((o) => `   • ${o.label}${o.description ? ` — ${o.description}` : ''}`)
      return [q.options.length ? `${head}  (${rule})` : head, ...opts].join('\n')
    })
    .join('\n\n')
}

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
  /** AskUserQuestion OPENS an ask — every question it declared, plus the id
   *  that will close it. */
  | { kind: 'ask-opened'; sessionId: string; cwd?: string; askId: string; questions: AskQuestion[] }
  /** …and PostToolUse CLOSES that same ask, carrying what actually registered.
   *  `answers` is keyed by question text (verified live). */
  | { kind: 'ask-closed'; sessionId: string; cwd?: string; askId: string; answers: Record<string, string> }
  /** PermissionRequest — "may I run this?", with the exact command in hand. */
  | { kind: 'permission-asked'; sessionId: string; cwd?: string; tool: string; summary: string }
  /** SessionEnd — it is gone, and why. */
  | { kind: 'session-ended'; sessionId: string; cwd?: string; reason?: string }

/** The id that opens and closes one ask. `tool_use_id` correlates PreToolUse
 *  with PostToolUse exactly; `prompt_id` is the fallback, because a
 *  PermissionRequest arrives with tool_use_id NULL (verified live). */
function askIdOf(p: Record<string, unknown>): string {
  return (typeof p.tool_use_id === 'string' && p.tool_use_id)
    || (typeof p.prompt_id === 'string' && p.prompt_id)
    || 'ask'
}

/** Every question an AskUserQuestion call declared. PLURAL — verified live: one
 *  call carried two, and reading only the first silently dropped half the ask. */
export function parseAskQuestions(toolInput: unknown): AskQuestion[] {
  const input = (toolInput ?? {}) as { questions?: unknown }
  const raw = Array.isArray(input.questions) ? input.questions : []
  const out: AskQuestion[] = []
  for (const q of raw) {
    const o = q as { question?: unknown; header?: unknown; options?: unknown; multiSelect?: unknown }
    if (typeof o?.question !== 'string' || !o.question) continue
    const options = (Array.isArray(o.options) ? o.options : [])
      .map((x) => x as { label?: unknown; description?: unknown })
      .filter((x) => typeof x?.label === 'string' && x.label)
      .map((x) => ({ label: x.label as string, ...(typeof x.description === 'string' ? { description: x.description } : {}) }))
    out.push({ question: o.question, ...(typeof o.header === 'string' ? { header: o.header } : {}), multiSelect: o.multiSelect === true, options })
  }
  return out
}

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
      // AN ASK CLOSES WHEN ITS TOOL RETURNS. This is the event that was missing:
      // without it a question stayed "pending" forever, so a stale ask could
      // shadow a live one and nothing could tell us what the user actually
      // chose. `tool_response.answers` is the record of what registered — the
      // docs promised `tool_output`, which is null.
      if (p.tool_name === 'AskUserQuestion' || p.tool_name === 'ExitPlanMode') {
        const resp = (p.tool_response ?? {}) as { answers?: unknown }
        const answers: Record<string, string> = {}
        if (resp.answers && typeof resp.answers === 'object') {
          for (const [k, v] of Object.entries(resp.answers as Record<string, unknown>)) {
            if (typeof v === 'string') answers[k] = v
          }
        }
        return { kind: 'ask-closed', sessionId, cwd, askId: askIdOf(p), answers }
      }
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

    // THE ASK CHANNEL — see session-policy.ts for why these two exist.
    case 'PreToolUse': {
      // Only AskUserQuestion is matched, but check anyway: a matcher is
      // configuration, and configuration drifts.
      // A PLAN AWAITING APPROVAL IS AN ASK. Same interval, same id, different
      // content: `plan` is the full markdown the user is being asked to approve.
      // Deliberately NOT answerable by us — its picker's options are unverified,
      // and the rule is that we refuse what we have not proven we can drive.
      if (p.tool_name === 'ExitPlanMode') {
        const input = (p.tool_input ?? {}) as { plan?: unknown }
        const plan = typeof input.plan === 'string' ? input.plan.trim() : ''
        if (!plan) return null
        return {
          kind: 'ask-opened', sessionId, cwd, askId: askIdOf(p),
          questions: [{ question: plan, header: 'Plan', multiSelect: false, options: [] }],
        }
      }
      if (p.tool_name !== 'AskUserQuestion') return null
      const questions = parseAskQuestions(p.tool_input)
      if (!questions.length) return null
      // `tool_use_id` is what closes this ask. It correlates PreToolUse with
      // PostToolUse exactly (verified live); prompt_id is the fallback, because
      // PermissionRequest arrives with tool_use_id NULL.
      const askId = askIdOf(p)
      return { kind: 'ask-opened', sessionId, cwd, askId, questions }
    }
    case 'PermissionRequest': {
      const tool = typeof p.tool_name === 'string' ? p.tool_name : 'a tool'
      // ASKING PERMISSION TO ASK A QUESTION IS NOISE. Claude Code fires a
      // PermissionRequest for AskUserQuestion itself, so a single question
      // produced "Allow AskUserQuestion?" and then buried the real question
      // underneath it. The question IS the ask; there is nothing to approve.
      if (tool === 'AskUserQuestion') return null
      // The command itself is the question. `Bash` is the case that matters —
      // "may I run this?" is unanswerable without seeing what "this" is.
      const input = (p.tool_input ?? {}) as Record<string, unknown>
      const detail = typeof input.command === 'string' ? input.command
        : typeof input.file_path === 'string' ? input.file_path
          : ''
      return { kind: 'permission-asked', sessionId, cwd, tool, summary: detail }
    }
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
  /**
   * Is a question already pending on this task?
   *
   * THE ASK CHANNEL IS NOT LAST-WRITER-WINS. One question from the model fires
   * up to three events, and they arrive WORST LAST:
   *
   *   PreToolUse/AskUserQuestion → the real text AND its options   (richest)
   *   PermissionRequest          → a tool and its input
   *   Notification               → "Claude needs your permission"  (poorest)
   *
   * Observed live: the real question was captured and then overwritten twice,
   * leaving a bare "Claude needs your permission" with no question and no
   * choices — while the terminal underneath showed the actual picker. So the
   * poorer two may only speak when nothing better is already pending.
   */
  pendingQuestion?: boolean
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
      // DEMOTED OUT OF THE STATE PATH ENTIRELY (2026-08-07).
      //
      // It is unkeyed, content-free ("Claude needs your permission"), and the
      // docs classify it as ASYNC with no ordering guarantee — so it can arrive
      // after the keyed events that actually describe the same moment. It did:
      // it buried a real question and its options under a bare sentence.
      //
      // Everything it could tell us, a keyed event tells us better. It survives
      // only as liveness, handled by the caller.
      return null
    }

    case 'ask-opened': {
      // The CLI is showing a picker right now. An ask is an INTERVAL, keyed by
      // askId — it opens here and closes on PostToolUse. Nothing else may write
      // over it, which is what makes the precedence problem disappear: two asks
      // are two ids, not a fight over one field.
      const answerable = isAnswerable(event.questions)
      const first = event.questions[0]
      // A SHAPE WE CANNOT DRIVE IS NOT A FREE-TEXT QUESTION.
      //
      // It used to be marked `free_text`, which put a text box and "speak your
      // answer" under an ask whose session is showing a PICKER. Whatever the
      // user then said went to `answer()`, which typed it at the picker —
      // keystrokes landing somewhere unpredictable, with the model still
      // waiting. The card invited a reply the rest of the system could not
      // keep. `terminal_only` says the true thing instead, and the card offers
      // no input at all.
      return {
        schema_version: 1,
        state: 'needs-user',
        updated_at: ctx.now,
        step: answerable ? 'waiting for you' : 'waiting for you in the terminal',
        question: {
          text: answerable ? first.question : renderAsk(event.questions),
          kind: answerable ? 'choice' : 'terminal_only',
          ...(answerable ? { choices: first.options.map((o) => o.label) } : {}),
        },
        thread_context: deriveThreadContext(summarize(first.question), 'needs-user', ctx.kind),
      }
    }

    case 'ask-closed': {
      // The tool returned, so the question is over however it was answered —
      // by us, or by the user typing into the terminal underneath. Either way
      // the card stops asking. Back to processing; Stop decides the end state.
      return {
        schema_version: 1,
        state: 'processing',
        updated_at: ctx.now,
        step: 'working',
      }
    }

    case 'permission-asked': {
      // Richer than a Notification, poorer than a real question — so it yields
      // to one already pending (see ObserverContext.pendingQuestion).
      if (ctx.pendingQuestion) return null
      // "May I run this?" The command IS the question — `Bash` unqualified is
      // unanswerable, so the input is put in the text rather than a label.
      const text = event.summary
        ? `Allow ${event.tool}?\n${event.summary}`
        : `Allow ${event.tool}?`
      return {
        schema_version: 1,
        state: 'needs-user',
        updated_at: ctx.now,
        step: 'waiting for permission',
        question: { text, kind: 'choice', choices: ['Allow', 'Deny'] },
        thread_context: deriveThreadContext(`Asking permission to run ${event.tool}.`, 'needs-user', ctx.kind),
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
      // A TRAILING QUESTION IS AN OFFER, NOT A BLOCK.
      //
      // This used to set `needs-user`, and it was the only thing that ever
      // could — so every "Want me to spec that first?" at the end of a finished
      // answer became a task demanding a reply, presented as a one-line
      // question with a text box and none of the reasoning that made it
      // answerable.
      //
      // But the turn ENDED. Nothing is blocked; the agent did the work and
      // offered a next step. That is precisely `ready` in ORCHESTRATE-VISION's
      // own words — "the step is over but the ball is with you". It still
      // reaches the user through the queue; it just stops claiming to be stuck,
      // and the composer is already there to answer it.
      //
      // `needs-user` is now reserved for a REAL block — AskUserQuestion or a
      // PermissionRequest — where there is something concrete to answer and an
      // affordance to answer it with.
      const offering = endsWithQuestion(message)
      const state: TaskState = offering || ctx.kind === 'session' ? 'ready' : 'done'
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
      return payload
    }
  }
}
