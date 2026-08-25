/**
 * Finding a session by what it was about.
 *
 * THE USE CASE THIS EXISTS FOR: "I did some task a day or two back, creating a
 * doc or a sheet. I want to edit it. I don't know which session that was or
 * what the doc is called — and I don't want to ask 'do you remember?' and wait
 * for a yes or no."
 *
 * So matching is over what a person would actually say: the words they opened
 * with, where it ran, and how it ended. Recency is a real signal here and not a
 * tiebreaker — "a day or two back" is most of the query — so it is scored, not
 * sorted afterwards.
 *
 * PURE. Handed records, returns ranked records.
 */
import type { SessionRecord } from './scan'

export interface SessionSearchQuery {
  text: string
  harness?: 'claude' | 'codex'
  /** Include forks, plan workers and the router. Off by default. */
  includeDerived?: boolean
  limit?: number
}

export interface ScoredSession {
  record: SessionRecord
  score: number
  /** Which field carried the match, so a caller can say why. */
  matched: 'opening' | 'closing' | 'project' | 'recency'
}

const STOP = new Set([
  'the', 'a', 'an', 'that', 'this', 'those', 'these', 'my', 'i', 'we', 'it',
  'was', 'is', 'were', 'be', 'been', 'did', 'do', 'does', 'done', 'about',
  'on', 'in', 'at', 'to', 'of', 'for', 'with', 'and', 'or', 'but', 'some',
  'thing', 'something', 'session', 'sessions', 'work', 'working', 'worked',
])

export function terms(text: string): string[] {
  return [...new Set(
    text.toLocaleLowerCase('en-US')
      .split(/[^\p{L}\p{N}_-]+/u)
      .filter((word) => word.length > 2 && !STOP.has(word)),
  )]
}

function hits(haystack: string | undefined, words: readonly string[]): number {
  if (!haystack) return 0
  const lower = haystack.toLocaleLowerCase('en-US')
  return words.reduce((total, word) => (lower.includes(word) ? total + 1 : total), 0)
}

/**
 * Recency as a score, not a sort.
 *
 * Full weight for the last day, decaying to nothing over a fortnight. A session
 * from this morning that matches one word should beat a session from March that
 * matches two, because "a day or two back" was half the question.
 */
export function recencyScore(lastTouchedAt: number, now: number): number {
  const days = Math.max(0, (now - lastTouchedAt) / 86_400_000)
  if (days <= 1) return 1
  if (days >= 14) return 0
  return 1 - (days - 1) / 13
}

export function searchSessions(
  records: readonly SessionRecord[],
  query: SessionSearchQuery,
  now: number,
): ScoredSession[] {
  const words = terms(query.text)
  const limit = Math.min(Math.max(query.limit ?? 10, 1), 50)

  const candidates = records.filter((record) => (
    (query.includeDerived || !record.derived)
    && (!query.harness || record.harness === query.harness)
  ))

  const scored: ScoredSession[] = []
  for (const record of candidates) {
    const opening = hits(record.opening, words)
    const closing = hits(record.closing, words)
    const project = hits(record.project, words)
    const recency = recencyScore(record.lastTouchedAt, now)

    // No words at all is a legitimate query — "what was I doing yesterday" —
    // and it should return the recent tier rather than nothing.
    const textual = opening * 3 + closing * 2 + project * 2
    if (words.length > 0 && textual === 0) continue

    scored.push({
      record,
      score: textual + recency * 2,
      matched: opening > 0 ? 'opening'
        : closing > 0 ? 'closing'
          : project > 0 ? 'project'
            : 'recency',
    })
  }

  return scored
    .sort((a, b) => b.score - a.score || b.record.lastTouchedAt - a.record.lastTouchedAt)
    .slice(0, limit)
}
