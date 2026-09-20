/**
 * WHAT THIS TURN ALREADY FOUND, SO A HANDOFF CANNOT LEAVE IT BEHIND.
 *
 * FIELD FAILURE (2026-09-20, the fixed version of 2026-09-18). Asked to
 * message Tanmay, the Agent searched the index properly this time — five
 * spellings, two pages, 45 sessions — worked out that "Tanmay" is the contact
 * saved as "Tanmay IIT GN", and then created the task with `contextChars: 0`
 * and `sourceSessions: 0`, with the identification smuggled into `intent`.
 *
 * That is better than the original failure and still wrong in the way that
 * matters: `intent` is the person's own request, the thing the receiving
 * session is told to DO. Findings pushed in there read as instructions, carry
 * no provenance, and the next session cannot tell what was established from
 * what was asked. The constitution already says background goes in `context`
 * with `sourceSessions`; prose asked for it and the model did something else,
 * which is the whole argument for putting a rule where it is enforced.
 *
 * So index_search records what it returned, and task_create refuses to hand
 * work off empty-handed when this same turn found something — unless the Agent
 * says outright that none of it was relevant. A rule that cannot be satisfied
 * is worse than none, so that escape exists and is one field.
 *
 * Interaction-scoped and bounded: an entry lives for one turn, and the
 * controller drops it when the turn ends.
 */

export interface IndexFindings {
  /** Total matched sessions the search reported, across all pages. */
  matchedSessions: number
  /** Session ids actually handed back, newest pages last. */
  sessionIds: string[]
  /** The terms that found them, for the refusal's own explanation. */
  terms: string[]
}

/** A turn that searched more than this has ids enough to name its sources. */
const MAX_IDS = 20
/** Bounded against a turn that never reports its end. */
const MAX_INTERACTIONS = 64

const ledger = new Map<string, IndexFindings>()

export function noteIndexFindings(interactionId: string, found: { matchedSessions: number; sessionIds: readonly string[]; terms: readonly string[] }): void {
  if (!interactionId || found.matchedSessions <= 0) return
  if (!ledger.has(interactionId) && ledger.size >= MAX_INTERACTIONS) {
    ledger.delete(ledger.keys().next().value!)
  }
  const existing = ledger.get(interactionId)
  const merged: IndexFindings = {
    matchedSessions: Math.max(existing?.matchedSessions ?? 0, found.matchedSessions),
    sessionIds: [...new Set([...(existing?.sessionIds ?? []), ...found.sessionIds])].slice(0, MAX_IDS),
    terms: [...new Set([...(existing?.terms ?? []), ...found.terms])].slice(0, MAX_IDS),
  }
  ledger.set(interactionId, merged)
}

export function indexFindings(interactionId: string | undefined): IndexFindings | undefined {
  return interactionId ? ledger.get(interactionId) : undefined
}

export function clearIndexFindings(interactionId: string): void {
  ledger.delete(interactionId)
}
