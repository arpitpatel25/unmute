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

/**
 * THE PURGE CLOCK — how long a conversation survives being ignored.
 *
 * It was five minutes, and five minutes was right for what the Agent used to
 * be: a caption that answered and vanished, where "and what about the other
 * one?" was the only continuity worth having. It is now a chat you can open and
 * read, and a chat that forgets itself over a coffee break is not a chat.
 *
 * Six hours is a working day's half. Come back after lunch and it is still
 * there; come back tomorrow and you start clean, which is the honest default —
 * yesterday's topic bleeding into today's unrelated question is the failure
 * this window exists to prevent, and it is a failure measured in days, not
 * minutes.
 *
 * WHAT THE CLOCK CLEARS IS THE CONVERSATION, NEVER THE MEMORY. The memory store
 * is the durable half and is untouched by any of this — which is exactly why a
 * conversation may be thrown away cheaply.
 */
export const AGENT_IDLE_WINDOW_MS = 6 * 60 * 60 * 1_000

/**
 * However lively, a conversation ends before its context becomes the cost.
 *
 * Raised with the window, and for the same reason. Twenty turns is a caption's
 * worth of follow-ups; a chat you work in all afternoon passes it before lunch,
 * and hitting it silently drops the thread mid-subject. The ceiling still
 * exists — an unbounded context is a real cost and a real risk — it is just no
 * longer the thing you meet first.
 */
export const AGENT_TURN_CEILING = 200

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
