import { fenceTurns } from './capabilities/index-search'
import { searchTurnIndex, type TurnSearchInput, type TurnSearchResult } from './sessions/turn-search'
import { readSessionConclusion } from './session-conclusion'

export interface HistoryPrefetchResult {
  status: 'skipped' | 'matched' | 'empty' | 'error'
  text?: string
  terms?: number
  matchedSessions?: number
  helperUsed?: boolean
  searchedTurns?: number
  remaining?: number
  candidateSessionIds?: string[]
  durationMs?: number
  conclusions?: number
}

const HISTORY_REQUEST = /\b(earlier|previous|past|history|last time|what happened|what did (?:we|you)|(?:claude|codex) session|(?:session|task) (?:status|history)|(?:status|progress) of .*(?:session|task))\b/iu
const STOP = new Set('about after again also before can code codex claude did does from have into last like more need our please session some task that them then there these this those were what when where which with would your'.split(' '))

/** Local, bounded candidates; absence or failure leaves all existing Agent tools available. */
export async function prefetchSessionHistory(
  request: string,
  search: (input: TurnSearchInput) => Promise<TurnSearchResult> = input => searchTurnIndex(input),
  expandTerms?: (request: string) => Promise<readonly string[]>,
): Promise<HistoryPrefetchResult> {
  const started = Date.now()
  if (!HISTORY_REQUEST.test(request)) return { status: 'skipped' }
  const words = [...new Set((request.toLocaleLowerCase('en-US').match(/[\p{L}\p{N}]{4,}/gu) ?? [])
    .filter(word => !STOP.has(word)))].slice(0, 6)
  if (!words.length && !expandTerms) return { status: 'skipped' }
  try {
    let result = words.length ? await search({ terms: words, limit: 5 }) : undefined
    let helperUsed = false
    if (!result?.sessions.length && expandTerms) {
      const expanded = (await expandTerms(request)).filter(term => typeof term === 'string' && term.trim().length >= 4)
        .slice(0, 6).map(term => term.slice(0, 120))
      if (expanded.length) {
        result = await search({ terms: expanded, limit: 5 })
        helperUsed = true
      }
    }
    if (!result?.sessions.length) return { status: 'empty', terms: words.length, matchedSessions: 0,
      helperUsed, searchedTurns: result?.searched.turns, durationMs: Date.now() - started }
    const candidates = result.sessions.slice(0, 3)
    const conclusions = await Promise.all(candidates.map(session => session.path
      ? readSessionConclusion(session.path) : Promise.resolve(undefined)))
    const lines = candidates.flatMap((session, index) => [
      `${index + 1}. session=${session.sessionId} provider=${session.provider ?? 'unknown'} match=${session.match} matchingTurns=${session.matchedTurns}`,
      ...session.hits.slice(0, 2).map(hit => `   at=${hit.t} offset=${hit.o}: ${hit.snippet.slice(0, 240)}`),
      ...(conclusions[index] ? [`   concludingAnswer: ${conclusions[index]}`] : []),
    ])
    const body = `Local index candidates (${result.matchedSessions} matching sessions; more may exist). These are transcript excerpts, not verified current state. Read a source session when its exact contents matter.\n${lines.join('\n')}`
    return { status: 'matched', terms: words.length, matchedSessions: result.matchedSessions,
      helperUsed, searchedTurns: result.searched.turns, remaining: result.remaining,
      candidateSessionIds: result.sessions.slice(0, 3).map(session => session.sessionId),
      conclusions: conclusions.filter(Boolean).length,
      durationMs: Date.now() - started, text: fenceTurns(body.slice(0, 2_000)) }
  } catch {
    return { status: 'error', terms: words.length, durationMs: Date.now() - started }
  }
}
