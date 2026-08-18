/**
 * Protecting what the Agent put on the clipboard from the user's next sentence.
 *
 * THE TRAP. The Agent's only text channel is the clipboard, and dictation
 * delivers through that same clipboard — it writes the transcript and pastes.
 * So an answer the user asked for is destroyed the moment they speak again.
 * Observed 18 August: three retrievals of the same email, every one of them
 * successful, every one wiped within seconds. And the trap closes on itself,
 * because reporting the problem requires speaking, which wipes it again.
 *
 * The narrow reading is that this only bites if the user speaks BEFORE
 * pasting — but that is exactly what happens when the answer was not what they
 * expected, or when they want to ask a follow-up first.
 *
 * So a delivery is protected for a short window: a dictation inside it restores
 * the Agent's text afterwards instead of leaving its own transcript behind.
 * Once the user pastes, the protection is spent — the clipboard belongs to
 * whatever they do next.
 */

/** How long an Agent delivery outranks a dictation's own residue. */
export const AGENT_DELIVERY_PROTECTION_MS = 30_000

let deliveredText: string | null = null
let deliveredAt = 0

/** Record what the Agent handed the user, so it can be put back. */
export function noteAgentDelivery(text: string, at: number): void {
  if (!text.trim()) return
  deliveredText = text
  deliveredAt = at
}

/** Called once the user has actually used it, or when it expires. */
export function clearAgentDelivery(): void {
  deliveredText = null
  deliveredAt = 0
}

export type RestoreDecision =
  | { restore: true; text: string }
  | { restore: false }

export function shouldRestoreAgentDelivery(now: number): RestoreDecision {
  if (!deliveredText) return { restore: false }
  if (now - deliveredAt > AGENT_DELIVERY_PROTECTION_MS) return { restore: false }
  return { restore: true, text: deliveredText }
}
