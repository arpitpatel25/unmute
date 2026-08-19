/**
 * What the Agent knows about the user's sessions.
 *
 * SCOPE, v1: sessions Unmute created — not every Claude and Codex session on
 * the machine, of which there are hundreds. Narrow is also the better product:
 * for an Unmute session the Agent knows the intent, the card and the outcome,
 * so it can say "three sessions on Meta ads, two finished". A foreign session
 * is a transcript with no framing — vaguer answers and nothing it can act on.
 * It also keeps the privacy and injection surface small while this is young.
 *
 * The record nevertheless carries `source` from day one, and the Unmute-only
 * fields are optional, so widening later is additive: point a scanner at the
 * projects directory and write source 'external'. No schema change, no
 * backfill.
 *
 * HOT AND COLD IS A RETENTION WINDOW, NOT A MECHANISM. Inside it a lookup is
 * an index read and instant; outside it the Agent must read transcripts like
 * anything else — slow, and visibly so. That is the behaviour asked for, and
 * it falls out of the policy rather than being special-cased.
 *
 * Indexing happens AT CREATION, because Unmute already knows about the
 * session — so v1 needs no filesystem scanner at all. Nothing here makes a
 * model call: summaries are generated lazily, when a session is first asked
 * about.
 */

export const SESSION_INDEX_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000

export interface IndexedSession {
  id: string
  /** 'unmute' today; 'external' is what makes widening additive. */
  source: 'unmute' | 'external'
  startedAt: number
  updatedAt: number
  project?: string
  /** The user's own opening words — enough to recognise it without a model. */
  opening?: string
  turns: number
  /** Present only for source 'unmute'. */
  taskId?: string
  intent?: string
  state?: string
  /** Filled lazily, the first time this session is actually asked about. */
  summary?: string
}

export interface SessionQuery {
  now: number
  /** Widen past the retention window. Slow by construction. */
  includeCold?: boolean
  limit?: number
}

/** Newest first, and never the Agent's own turns. */
export function selectSessions(
  all: readonly IndexedSession[],
  query: SessionQuery,
): IndexedSession[] {
  const cutoff = query.now - SESSION_INDEX_RETENTION_MS
  const limit = query.limit && query.limit > 0 ? Math.min(query.limit, 100) : 20
  return [...all]
    .filter((session) => query.includeCold === true || session.updatedAt >= cutoff)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit)
}

/** Whether a lookup for this session can be answered from the index alone. */
export function isHot(session: IndexedSession, now: number): boolean {
  return session.updatedAt >= now - SESSION_INDEX_RETENTION_MS
}
