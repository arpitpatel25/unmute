/**
 * CODEX CLI — turning a rollout into task state.
 *
 * The Claude side of the house works because Unmute installs hooks that write
 * status.json, and `observer.deriveStatus` turns those events into a state. The
 * open question for Codex CLI was where the equivalent signal comes from, and
 * the answer is that Codex already writes one: every session records a rollout
 * to ~/.codex, and its `event_msg` records are a strictly richer version of the
 * hooks we ask Claude for.
 *
 * Measured across 25 real rollouts on 2026-08-09:
 *
 *   task_started        the turn began              → processing
 *   task_complete       the turn ended              → done
 *   turn_aborted        YOU stopped it              → done (see below)
 *   agent_message       what it said                → result.summary / detail
 *   user_message        what you said
 *   mcp_tool_call_end   } activity — the cadence Claude's PostToolUse gives us,
 *   patch_apply_end     } which is what keeps a working task from reading stale
 *   web_search_end      }
 *   agent_reasoning, token_count, thread_settings_applied — ignored here
 *
 * SO NO HOOKS ARE INSTALLED FOR CODEX, and that is the point. The natural-
 * session rule — observe, never modify — is satisfied for free: we read a file
 * Codex writes for its own reasons. Nothing is injected into the user's
 * session, no config is touched, and a Codex session started outside Unmute
 * looks identical to one started inside it.
 *
 * PURE, AND CLOCKLESS. Same contract as observer.ts: events in, a status out,
 * `now` injected. It owns no clock and no filesystem so the mapping can be
 * tested against real rollout lines.
 *
 * DELIBERATELY SEPARATE FROM codex/rollout.ts. That parses the same file family
 * for the DESKTOP backend, where the question is "has the thread moved since we
 * last looked" against a conversation the user owns in another app. This maps a
 * session Unmute itself spawned onto the task lifecycle. Sharing a parser would
 * be reasonable; sharing the interpretation would not, and merging them is how
 * the desktop backend would start inheriting CLI semantics.
 */

import type { StatusPayload, TaskState } from '../status-file'

/** One line of a rollout, reduced to what the mapping needs. */
export interface RolloutEvent {
  /** Outer record type: 'event_msg' | 'response_item' | 'session_meta' | … */
  type?: string
  timestamp?: string
  payload?: {
    type?: string
    message?: string
    /** agent_message carries its text here on some versions, `message` on others. */
    text?: string
    turn_id?: string
    [k: string]: unknown
  }
}

/** Events that mean the session did something — the cadence signal. Claude gets
 *  this from a PostToolUse hook; Codex records it without being asked. */
const ACTIVITY = new Set([
  'mcp_tool_call_end', 'mcp_tool_call_begin',
  'patch_apply_end', 'patch_apply_begin',
  'web_search_end', 'web_search_begin',
  'exec_command_end', 'exec_command_begin',
])

/** The text of an agent_message, whichever field this Codex version used. */
function messageText(e: RolloutEvent): string {
  const p = e.payload ?? {}
  const raw = typeof p.message === 'string' ? p.message
    : typeof p.text === 'string' ? p.text
      : ''
  return raw.trim()
}

/**
 * The exchange, as Codex itself recorded it.
 *
 * A Codex CLI task's chat view is fed from `task.conversation`, and the only
 * thing that ever filled that array was Claude Code's `Stop` hook. Codex ships
 * no such hook, so the view stayed empty for the task's whole life while the
 * terminal beside it showed the real conversation. The rollout has it — this
 * poller already reads that file for status — so read the turns from there and
 * stop depending on another agent's hooks.
 *
 * Only user/agent messages are conversation: reasoning, tool traffic and
 * bookkeeping records are not something the user said or was told.
 */
export function conversationFromCodexEvents(
  events: readonly RolloutEvent[],
): Array<{ role: 'user' | 'assistant'; text: string }> {
  // THREE READERS, TRIED IN ORDER, NEVER COMBINED.
  //
  // Codex has changed how it records an exchange twice, and an old rollout
  // carries BOTH the old and the new shape for the SAME messages — one measured
  // file had 8 event_msg/user_message records and 8 response_item/message:user
  // records describing the same 8 messages. So these are FALLBACKS: the first
  // reader that finds anything wins outright. Reading them together would
  // double every turn in the chat view of every task that works today, which
  // trades a broken-reply bug for a broken-history one.
  //
  // Order is oldest-first on purpose: it leaves every rollout that renders
  // correctly today on byte-for-byte the same path it is on now.
  return fromEventMessages(events)
    || fromItemCompleted(events)
    || fromResponseItems(events)
    || []
}

/** Null, not [], so "this reader found nothing" is distinguishable from "this
 *  reader read an empty conversation" — that difference is what makes the
 *  fallback chain above a chain rather than three merged passes. */
type Turns = Array<{ role: 'user' | 'assistant'; text: string }> | null

function nonEmpty(turns: Array<{ role: 'user' | 'assistant'; text: string }>): Turns {
  return turns.length ? turns : null
}

/** The original shape: one event_msg per message. Gone in newer Codex. */
function fromEventMessages(events: readonly RolloutEvent[]): Turns {
  const turns: Array<{ role: 'user' | 'assistant'; text: string }> = []
  for (const e of events) {
    if (e.type !== 'event_msg') continue
    const kind = e.payload?.type
    if (kind !== 'user_message' && kind !== 'agent_message') continue
    const text = messageText(e)
    if (!text) continue
    turns.push({ role: kind === 'user_message' ? 'user' : 'assistant', text })
  }
  return nonEmpty(turns)
}

/** Newer Codex (seen from 2026-08-24): every per-kind event_msg collapsed into
 *  one `item_completed` envelope discriminated by `item.type`, alongside
 *  custom_tool_call replacing function_call. Reasoning, CommandExecution and
 *  McpToolCall arrive through the same envelope and are not conversation. */
function fromItemCompleted(events: readonly RolloutEvent[]): Turns {
  const turns: Array<{ role: 'user' | 'assistant'; text: string }> = []
  for (const e of events) {
    if (e.type !== 'event_msg' || e.payload?.type !== 'item_completed') continue
    const item = (e.payload as { item?: { type?: string; content?: unknown } }).item
    const role = item?.type === 'UserMessage' ? 'user'
      : item?.type === 'AgentMessage' ? 'assistant'
        : null
    if (!role) continue
    const text = contentText(item?.content)
    if (!text) continue
    turns.push({ role, text })
  }
  return nonEmpty(turns)
}

/** The durable record, present in EVERY format seen so far — old rollouts and
 *  new ones both carry it. Last resort precisely because anchoring on a single
 *  event_msg wrapper is what broke twice. `developer` is the injected
 *  environment context, not something the user said. */
function fromResponseItems(events: readonly RolloutEvent[]): Turns {
  const turns: Array<{ role: 'user' | 'assistant'; text: string }> = []
  for (const e of events) {
    if (e.type !== 'response_item' || e.payload?.type !== 'message') continue
    const p = e.payload as { role?: string; content?: unknown }
    if (p.role !== 'user' && p.role !== 'assistant') continue
    const text = contentText(p.content)
    if (!text) continue
    turns.push({ role: p.role, text })
  }
  return nonEmpty(turns)
}

/** Both newer shapes carry text as an array of parts. The part's own `type`
 *  varies by shape and even by case ('text' on a UserMessage, 'Text' on an
 *  AgentMessage, 'input_text'/'output_text' on a response_item), so it is not
 *  matched on — every part carrying a string `text` is joined. */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => (part && typeof (part as { text?: unknown }).text === 'string'
      ? (part as { text: string }).text
      : ''))
    .filter(Boolean)
    .join('')
    .trim()
}

export interface CodexRollupContext {
  /** ISO timestamp to stamp. Injected — this module owns no clock. */
  now: string
  /** oneoff = an errand that ends; session = a thread you return to. Mirrors
   *  the Claude observer, and it is what decides whether a finish wants you. */
  kind: 'oneoff' | 'session'
}

export interface CodexRollup {
  status: StatusPayload | null
  /** When the session last did anything — the heartbeat, for staleness. Null if
   *  nothing in the rollout carried a usable timestamp. */
  lastActivityAt: number | null
}

/**
 * Fold a rollout into a single status.
 *
 * Reads the WHOLE event list rather than the last line, because the last line
 * is routinely `token_count` — a bookkeeping record that says nothing about
 * whether the turn is over. Deciding from the tail would report a finished task
 * as working for as long as the accounting kept trickling in.
 */
export function rollupCodexEvents(events: readonly RolloutEvent[], ctx: CodexRollupContext): CodexRollup {
  let state: TaskState | null = null
  let lastAgentText = ''
  let lastActivityAt: number | null = null
  let step: string | undefined
  let aborted = false

  for (const e of events) {
    const t = e.timestamp ? Date.parse(e.timestamp) : NaN
    if (!Number.isNaN(t)) lastActivityAt = Math.max(lastActivityAt ?? 0, t)
    if (e.type !== 'event_msg') continue
    const kind = e.payload?.type
    if (!kind) continue

    if (kind === 'task_started') { state = 'processing'; aborted = false; step = undefined }
    else if (kind === 'task_complete') { state = 'done' }
    else if (kind === 'turn_aborted') {
      // DONE, NOT FAILED. `turn_aborted` is what Codex records when the user
      // presses Esc, which is the ordinary way to end a turn you have seen
      // enough of — not a crash. Mapping it to `failed` made it DEMANDING, so
      // the surface would have nagged about every turn deliberately cancelled.
      //
      // Caught by running this over 25 real rollouts rather than fixtures: five
      // of twelve sessions end this way. A mapping that calls 42% of ordinary
      // endings a failure is not a mapping, it is an alarm.
      state = 'done'
      aborted = true
    }
    else if (kind === 'agent_message') {
      const text = messageText(e)
      if (text) lastAgentText = text
    } else if (ACTIVITY.has(kind)) {
      // Not a state change — the task is still working, and this is the proof.
      // Recorded as the step so a long turn says what it is doing rather than
      // sitting on a stale line.
      step = humanizeActivity(kind)
      if (state === null) state = 'processing'
    }
  }

  if (state === null) return { status: null, lastActivityAt }

  const summary = lastAgentText ? summarize(lastAgentText) : ''
  const status: StatusPayload = {
    schema_version: 1,
    state,
    updated_at: ctx.now,
    category: 'act',
    ...(step && state === 'processing' ? { step } : {}),
    ...(state === 'done' && lastAgentText
      ? { result: { summary, detail: lastAgentText } }
      : {}),
    // Recorded, but NOT as an error — see turn_aborted above. The card should
    // be able to say the turn was cut short without the task reading broken.
    ...(aborted && state === 'done' ? { step: undefined } : {}),
    thread_context: threadContext(state, ctx.kind, summary, aborted),
  }
  return { status, lastActivityAt }
}

function humanizeActivity(kind: string): string {
  if (kind.startsWith('patch_apply')) return 'editing files'
  if (kind.startsWith('web_search')) return 'searching the web'
  if (kind.startsWith('exec_command')) return 'running a command'
  return 'using a tool'
}

/** First sentence or 140 chars, whichever is shorter — the card shows one line. */
function summarize(text: string): string {
  const firstLine = text.split('\n').map((l) => l.trim()).find(Boolean) ?? ''
  if (firstLine.length <= 140) return firstLine
  return firstLine.slice(0, 139).trimEnd() + '…'
}

/** Two plain sentences for someone returning cold. Same rule as the Claude
 *  observer: a THREAD finishing is a checkpoint, an ERRAND finishing is the end. */
function threadContext(state: TaskState, kind: 'oneoff' | 'session', summary: string, aborted = false): string {
  const whose =
    state === 'failed' ? 'It stopped before finishing.'
      : aborted ? 'You stopped it part-way. Pick it up whenever you like.'
      : state === 'done'
        ? (kind === 'session'
          ? 'It has finished this step and is waiting for your next direction.'
          : 'Nothing further is expected.')
        : 'It is still working.'
  return summary ? `${summary} ${whose}` : whose
}
