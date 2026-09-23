/**
 * How long the Agent remembers a conversation.
 *
 * Neither extreme is right. UNBOUNDED continuity grows context every turn,
 * lets yesterday's topic bleed into today's unrelated question, and lets one
 * poisoned read — a bad memory, injected content — contaminate every turn
 * after it. PER-UTTERANCE loses "and what about the other one?", which is the
 * exchange that makes this feel like an agent rather than a query box.
 *
 * Keep connected follow-ups together, but start a fresh provider conversation
 * before the next turn when either the turn count or measured context reaches
 * its ceiling. A bounded handoff carries the recent exchange across it.
 *
 * WHY A SHORT CONVERSATION LOSES NOTHING. Memory is the durable continuity;
 * the conversation is only short-term. That is what the memory store is for.
 * The conversation can be deliberately short-lived provided the Agent saves
 * what matters — and what matters is the model's judgement, never a pattern.
 *
 * These thresholds are tuning values; they do not gate task creation.
 */

/**
 * Legacy idle-window tuning. The live lifecycle logs idle time for diagnosis;
 * it no longer requires idle time before rotating at a turn/context ceiling.
 *
 * Kept for compatibility with the older standalone continuity helper. The
 * lifecycle's active rotation decision uses turn count and context instead.
 */
export const AGENT_IDLE_WINDOW_MS = 6 * 60 * 60 * 1_000

/**
 * Hard maximum for one provider conversation, regardless of idle time. The
 * visible chat stays intact and a short handoff preserves the current topic.
 */
export const AGENT_TURN_CEILING = 20
/** Rotate before large repeated contexts dominate subsequent provider calls. */
export const AGENT_CONTEXT_ROTATION_TOKENS = 160_000

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
  return { resume: true, runId: prior.runId }
}
