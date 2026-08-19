/**
 * How long the Agent remembers a conversation.
 *
 * Neither extreme is right. UNBOUNDED continuity grows context every turn,
 * lets yesterday's topic bleed into today's unrelated question, and lets one
 * poisoned read — a bad memory, injected content — contaminate every turn
 * after it. PER-UTTERANCE loses "and what about the other one?", which is the
 * exchange that makes this feel like an agent rather than a query box.
 *
 * So continuity follows ATTENTION rather than the clock: resume if the next
 * utterance arrives shortly after the last one finished, otherwise start
 * fresh, with a hard ceiling on length regardless.
 *
 * WHY A SHORT CONVERSATION LOSES NOTHING. Memory is the durable continuity;
 * the conversation is only short-term. That is what the memory store is for.
 * The conversation can be deliberately short-lived provided the Agent saves
 * what matters — and what matters is the model's judgement, never a pattern.
 *
 * Both numbers are configuration, not architecture: a wrong guess costs a
 * tuning change.
 */

/** A follow-up is defined by immediacy, not by date. */
export const AGENT_IDLE_WINDOW_MS = 5 * 60 * 1_000

/** However lively, a conversation ends before its context becomes the cost. */
export const AGENT_TURN_CEILING = 20

export interface Conversation {
  runId: string
  turns: number
  /** When the last turn finished. Zero means it never did. */
  endedAt: number
}

export type ContinuityDecision =
  | { resume: true; runId: string }
  | { resume: false }

export function nextConversation(
  prior: Conversation | null,
  now: number,
  idleWindowMs: number = AGENT_IDLE_WINDOW_MS,
  ceiling: number = AGENT_TURN_CEILING,
): ContinuityDecision {
  if (!prior) return { resume: false }
  // A conversation that never finished has no point to measure from, and
  // resuming into an unknown state is how a turn inherits context nobody
  // intended it to have.
  if (!prior.endedAt) return { resume: false }
  if (prior.turns >= ceiling) return { resume: false }
  if (now - prior.endedAt > idleWindowMs) return { resume: false }
  return { resume: true, runId: prior.runId }
}
