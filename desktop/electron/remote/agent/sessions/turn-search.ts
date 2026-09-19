import fs from 'node:fs/promises'
import { join } from 'node:path'
import { defaultIndexRoot, type IndexedSession, type IndexedTurn } from './turn-index'
import { devLogEnabled } from '../../curator-devlog'
import { devTrace } from '../devlog'

/**
 * EVERY SESSION THAT MATCHES, RANKED — NEVER THE FIRST FEW THAT HAPPENED TO.
 *
 * FIELD FAILURE (2026-09-18). "Message Tanmay that we are missing him on
 * WhatsApp." The Agent did look — it grepped turns.jsonl — but it wrote the
 * search itself: `rg -m 50 'Tanmay|WhatsApp'` with a 12,000-token output cap.
 * The index held 44 turns naming Tanmay across ~20 sessions, including "Yes
 * its Tanmay IIT GN" from the last time the same question came up. None of
 * them reached the Agent:
 *
 *  - `-m 50` stopped at the 50th matching LINE, in FILE order. The file is
 *    grouped by session, not sorted by time, so the cap kept whatever sat near
 *    the top — line 3,186 of 15,855 — and never reached the recent sessions.
 *  - "WhatsApp" is common, so it spent most of the 50.
 *  - Index lines run to 8 KB each; 50 of them were ~51,000 tokens, and the
 *    output cap cut the MIDDLE out, silently. Six lines survived.
 *
 * So the Agent handed a task "Message Tanmay" with no background, and the task
 * had to stop and ask which Tanmay. Across the 19 requests before it, the same
 * lookup was written six different ways (`-m 50`, `-m 80`, `| tail -n 120`,
 * no cap; output caps from 1,000 to 12,000 tokens), so whether the right
 * session surfaced depended on how the command came out that turn.
 *
 * WHY THIS IS NOT `sessions_search` AGAIN. That tool read 128 KB of each
 * transcript and required every word to match, and it failed silently. This
 * reads the WHOLE index on every call, matches ANY of the terms, groups by
 * session, ranks, and says how many matched in total and how many it has not
 * shown yet — an incomplete page is visibly incomplete. It does not replace
 * Grep: the files are still there for anything this cannot express.
 *
 * SEARCH, THEN RANK. Every turn is tested; ordering happens afterwards.
 * Recency decides order, never what is looked at.
 *
 * SPELLING IS THE NORMAL CASE, NOT AN EDGE. Most turns were spoken and
 * transcribed. The index holds the same person as "Tanmay IIT GN",
 * "Tanmayiitgn", "T I N M A Y", "Tanmay ITJN" and "Tanmay IIT Jiyan". So a
 * term matches three ways, and the result says which:
 *
 *   exact    the words appear as written (case and accents ignored)
 *   joined   they appear once spaces and punctuation are removed from both
 *            sides — "T A N M A Y" and "tanmayiitgn" both contain "tanmay"
 *   close    a single-word term is within one or two letters of a word in
 *            the turn — "Tanmai" finds "Tanmay"
 *
 * What code cannot guess — that "IIT Jiyan" is how a transcriber heard
 * "IITGN" — the caller supplies as more terms. The model writes the variants;
 * this guarantees every one of them is checked against everything.
 */

export type MatchKind = 'exact' | 'joined' | 'close'

const TIER: Record<MatchKind, number> = { exact: 3, joined: 2, close: 1 }

export const MAX_TERMS = 16
export const MAX_TERM_LENGTH = 120
export const DEFAULT_PAGE = 15
export const MAX_PAGE = 40
/** Shown per session. The rest are counted, and the offsets are in the file. */
const HITS_PER_SESSION = 3
const SNIPPET_BEFORE = 80
const SNIPPET_AFTER = 160
/** Joined matching on anything shorter is noise: "ai" is inside half the corpus. */
const MIN_JOINED = 4
const LINKS_SHOWN = 3

export interface TurnSearchHit {
  /** Epoch ms of the turn. */
  t: number
  /** Byte offset of the turn in the transcript — where to Read. */
  o: number
  match: MatchKind
  /** Which of the caller's terms matched here, as they wrote it. */
  term: string
  snippet: string
}

export interface TurnSearchSession {
  sessionId: string
  provider?: IndexedSession['provider']
  provenance?: IndexedSession['provenance']
  cwd?: string
  path?: string
  briefing?: true
  linkedTo?: string[]
  /** Present when there are more links than linkedTo shows. */
  linkedCount?: number
  firstAt?: number
  lastAt?: number
  returns?: number
  /** Every turn in the session, matched or not. */
  turns?: number
  /** How many of its turns matched any term. */
  matchedTurns: number
  /** The strongest way any turn matched. */
  match: MatchKind
  matchedTerms: string[]
  /** When it was last mentioned — the recency the ranking uses. */
  lastMatchAt: number
  hits: TurnSearchHit[]
}

export interface TurnSearchResult {
  /** What was read. Always the whole index; these numbers say how big that was. */
  searched: { turns: number; sessions: number; from?: number; to?: number; unreadable: number }
  matchedSessions: number
  matchedTurns: number
  sessions: TurnSearchSession[]
  /** Pass back as `cursor` for the next page; absent when nothing is left. */
  nextCursor?: number
  /** How many matched sessions are after this page. */
  remaining: number
}

interface PreparedTerm {
  raw: string
  norm: string
  joined: string
  /** Edit distance allowed for a close match; 0 means close matching is off. */
  slack: number
}

export function normalize(text: string): string {
  return text.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase('en-US').replace(/\s+/gu, ' ')
}

function joinedForm(normalized: string): string {
  return normalized.replace(/[^\p{L}\p{N}]+/gu, '')
}

function words(normalized: string): string[] {
  return normalized.split(/[^\p{L}\p{N}]+/u).filter(Boolean)
}

/** One slip in a short word, two in a long one. Under four letters a slip
 *  turns one real word into another, so close matching is off there. */
function slackFor(word: string): number {
  const length = [...word].length
  if (length < 4) return 0
  return length < 7 ? 1 : 2
}

/** Levenshtein, abandoned as soon as it cannot come in under `max`. */
export function withinDistance(a: string, b: string, max: number): boolean {
  if (Math.abs(a.length - b.length) > max) return false
  if (a === b) return true
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    let best = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      const value = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost)
      current.push(value)
      if (value < best) best = value
    }
    if (best > max) return false
    previous = current
  }
  return previous[b.length]! <= max
}

function prepare(terms: readonly string[]): PreparedTerm[] {
  const seen = new Set<string>()
  const prepared: PreparedTerm[] = []
  for (const raw of terms) {
    const norm = normalize(raw).trim()
    if (!norm || seen.has(norm)) continue
    seen.add(norm)
    const parts = words(norm)
    prepared.push({
      raw: raw.trim(), norm, joined: joinedForm(norm),
      slack: parts.length === 1 ? slackFor(parts[0]!) : 0,
    })
  }
  return prepared
}

interface TurnMatch { kind: MatchKind; term: PreparedTerm; needle: string }

/** A turn with the three forms matching needs, computed once per turn for
 *  the life of the process rather than once per call. */
interface PreparedTurn {
  s: string
  t: number
  o: number
  text: string
  norm: string
  joined: string
}

/**
 * The index, held ready to search. turns.jsonl is append-only, so a later
 * call reads only the bytes added since the last one; a file that shrank was
 * rewritten and is read again from the start. Preparing ~16k turns costs about
 * a second, and paying that on every call is what would make a caller reach
 * back for a capped grep.
 */
interface Corpus {
  size: number
  turns: PreparedTurn[]
  /** Every distinct word → the turns it occurs in. Close matching compares a
   *  term against the ~25k distinct words instead of every word of every turn. */
  vocabulary: Map<string, number[]>
  unreadable: number
  sessions?: { size: number; mtimeMs: number; byId: Map<string, IndexedSession> }
}

const corpora = new Map<string, Corpus>()
/** One load at a time per index. Without this the warm-up and the first
 *  search both found no corpus and each built one (caught by the dev trace:
 *  two first-loads, 6.6 s instead of 3), and two loads appending to the same
 *  corpus from the same byte offset would index every new turn twice. */
const loading = new Map<string, Promise<Corpus>>()

function loadTurns(root: string): Promise<Corpus> {
  const previous = loading.get(root) ?? Promise.resolve(undefined)
  const next = previous.catch(() => undefined).then(() => loadTurnsNow(root))
  loading.set(root, next)
  void next.finally(() => { if (loading.get(root) === next) loading.delete(root) }).catch(() => {})
  return next
}

async function loadTurnsNow(root: string): Promise<Corpus> {
  const started = Date.now()
  const path = join(root, 'turns.jsonl')
  const stat = await fs.stat(path).catch(() => null)
  let corpus = corpora.get(root)
  if (!stat) {
    devTrace('index-search.corpus', { root, reason: 'no-index-file' })
    corpus = { size: 0, turns: [], vocabulary: new Map(), unreadable: 0 }; corpora.set(root, corpus); return corpus
  }
  const reason = !corpus ? 'first-load' : stat.size < corpus.size ? 'shrunk-rebuild' : stat.size > corpus.size ? 'appended' : 'unchanged'
  const before = { turns: corpus?.turns.length ?? 0, bytes: corpus?.size ?? 0 }
  if (!corpus || stat.size < corpus.size) {
    corpus = { size: 0, turns: [], vocabulary: new Map(), unreadable: 0, ...(corpus?.sessions ? { sessions: corpus.sessions } : {}) }
    corpora.set(root, corpus)
  }
  if (stat.size === corpus.size) {
    devTrace('index-search.corpus', { reason, turns: corpus.turns.length, bytes: corpus.size, ms: Date.now() - started })
    return corpus
  }

  const handle = await fs.open(path, 'r')
  let chunk: string
  try {
    const buffer = Buffer.alloc(stat.size - corpus.size)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, corpus.size)
    // Stop at the last complete line; a half-written one is read next time.
    const end = buffer.subarray(0, bytesRead).lastIndexOf(0x0a)
    if (end < 0) {
      devTrace('index-search.corpus', { reason: 'partial-line-only', pendingBytes: bytesRead, turns: corpus.turns.length })
      return corpus
    }
    chunk = buffer.subarray(0, end + 1).toString('utf8')
    corpus.size += end + 1
  } finally { await handle.close().catch(() => {}) }

  for (const line of chunk.split('\n')) {
    if (!line.trim()) continue
    let turn: IndexedTurn
    try { turn = JSON.parse(line) as IndexedTurn } catch { corpus.unreadable++; continue }
    if (!turn || typeof turn.s !== 'string' || typeof turn.text !== 'string') { corpus.unreadable++; continue }
    const norm = normalize(turn.text)
    const index = corpus.turns.length
    corpus.turns.push({ s: turn.s, t: turn.t, o: turn.o, text: turn.text, norm, joined: joinedForm(norm) })
    for (const word of new Set(words(norm))) {
      const at = corpus.vocabulary.get(word)
      if (at) at.push(index); else corpus.vocabulary.set(word, [index])
    }
  }
  devTrace('index-search.corpus', {
    reason, fileBytes: stat.size, readFromByte: before.bytes, bytesRead: corpus.size - before.bytes,
    pendingPartialBytes: stat.size - corpus.size,
    turnsBefore: before.turns, turnsAdded: corpus.turns.length - before.turns, turns: corpus.turns.length,
    vocabulary: corpus.vocabulary.size, unreadable: corpus.unreadable, ms: Date.now() - started,
  })
  return corpus
}

/** sessions.jsonl is rewritten whole on every flush, so it is re-read when it
 *  changes and not otherwise. */
async function loadSessions(root: string, corpus: Corpus): Promise<Map<string, IndexedSession>> {
  const path = join(root, 'sessions.jsonl')
  const stat = await fs.stat(path).catch(() => null)
  if (!stat) return new Map()
  if (corpus.sessions && corpus.sessions.size === stat.size && corpus.sessions.mtimeMs === stat.mtimeMs) return corpus.sessions.byId
  const started = Date.now()
  const byId = new Map<string, IndexedSession>()
  let raw = ''
  try { raw = await fs.readFile(path, 'utf8') } catch { return byId }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const session = JSON.parse(line) as IndexedSession
      if (session?.id) byId.set(session.id, session)
    } catch { /* one bad line is not a bad file */ }
  }
  corpus.sessions = { size: stat.size, mtimeMs: stat.mtimeMs, byId }
  devTrace('index-search.sessions-loaded', { sessions: byId.size, bytes: stat.size, ms: Date.now() - started })
  return byId
}

/** For each close-matchable term, the turns containing a word within its
 *  slack — found through the vocabulary, not by re-reading every turn. */
function closeMatches(corpus: Corpus, terms: readonly PreparedTerm[]): Map<PreparedTerm, Map<number, string>> {
  const found = new Map<PreparedTerm, Map<number, string>>()
  for (const term of terms) {
    if (term.slack <= 0) continue
    const turns = new Map<number, string>()
    for (const [word, at] of corpus.vocabulary) {
      if (word.length < 3 || !withinDistance(word, term.norm, term.slack)) continue
      for (const index of at) if (!turns.has(index)) turns.set(index, word)
    }
    found.set(term, turns)
  }
  return found
}

/** Every term that matches this turn, each at its strongest. */
function matchTurn(turn: PreparedTurn, index: number, terms: readonly PreparedTerm[], close: Map<PreparedTerm, Map<number, string>>): TurnMatch[] {
  const found: TurnMatch[] = []
  for (const term of terms) {
    if (turn.norm.includes(term.norm)) { found.push({ kind: 'exact', term, needle: term.norm }); continue }
    if (term.joined.length >= MIN_JOINED && turn.joined.includes(term.joined)) { found.push({ kind: 'joined', term, needle: term.joined }); continue }
    const word = close.get(term)?.get(index)
    if (word) found.push({ kind: 'close', term, needle: word })
  }
  return found
}

/** The words around the match, so the reader can tell hits apart before
 *  opening any. A joined match has no single place in the original text, so
 *  it falls back to where the first word of the term appears. */
function snippetOf(text: string, match: TurnMatch): string {
  const flat = text.replace(/\s+/gu, ' ').trim()
  const lower = normalize(flat)
  let at = lower.indexOf(match.needle)
  if (at < 0) {
    const head = words(match.term.norm)[0]
    at = head ? lower.indexOf(head) : -1
  }
  if (at < 0) at = 0
  const start = Math.max(0, at - SNIPPET_BEFORE)
  const end = Math.min(flat.length, at + SNIPPET_AFTER)
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`
}

export interface TurnSearchInput {
  terms: readonly string[]
  cursor?: number
  limit?: number
}

export async function searchTurnIndex(input: TurnSearchInput, root: string = defaultIndexRoot()): Promise<TurnSearchResult> {
  const terms = prepare(input.terms)
  const limit = Math.min(MAX_PAGE, Math.max(1, input.limit ?? DEFAULT_PAGE))
  const cursor = Math.max(0, input.cursor ?? 0)

  const started = Date.now()
  const corpus = await loadTurns(root)
  const described = await loadSessions(root, corpus)
  const loadedAt = Date.now()
  const close = closeMatches(corpus, terms)
  const closedAt = Date.now()
  // DEV-ONLY: how each term actually matched, which is where a bad variant or
  // a noisy respelling ("hardness" finding every "harness") shows up.
  const perTerm = devLogEnabled()
    ? new Map(terms.map(term => [term, { exact: 0, joined: 0, close: 0 }]))
    : undefined

  const bySession = new Map<string, TurnSearchSession>()
  const allSessions = new Set<string>()
  let matchedTurns = 0
  let from: number | undefined
  let to: number | undefined

  for (let index = 0; index < corpus.turns.length; index++) {
    const turn = corpus.turns[index]!
    allSessions.add(turn.s)
    if (typeof turn.t === 'number') {
      if (from === undefined || turn.t < from) from = turn.t
      if (to === undefined || turn.t > to) to = turn.t
    }
    if (!terms.length) continue
    const matches = matchTurn(turn, index, terms, close)
    if (!matches.length) continue
    matchedTurns++
    if (perTerm) for (const match of matches) perTerm.get(match.term)![match.kind]++

    const best = matches.reduce((a, b) => (TIER[b.kind] > TIER[a.kind] ? b : a))
    let entry = bySession.get(turn.s)
    if (!entry) {
      const session = described.get(turn.s)
      entry = {
        sessionId: turn.s,
        ...(session ? {
          provider: session.provider,
          provenance: session.provenance,
          ...(session.cwd ? { cwd: session.cwd } : {}),
          path: session.path,
          ...(session.briefing ? { briefing: true as const } : {}),
          // A replayed batch links one session to hundreds of copies — 20 KB
          // of ids on one real row. A few and the count say the same thing.
          ...(session.linkedTo?.length ? {
            linkedTo: session.linkedTo.slice(0, LINKS_SHOWN),
            ...(session.linkedTo.length > LINKS_SHOWN ? { linkedCount: session.linkedTo.length } : {}),
          } : {}),
          firstAt: session.firstAt,
          lastAt: session.lastAt,
          ...(session.returns ? { returns: session.returns } : {}),
          turns: session.turns,
        } : {}),
        matchedTurns: 0, match: best.kind, matchedTerms: [], lastMatchAt: turn.t, hits: [],
      }
      bySession.set(turn.s, entry)
    }
    entry.matchedTurns++
    if (TIER[best.kind] > TIER[entry.match]) entry.match = best.kind
    if (turn.t > entry.lastMatchAt) entry.lastMatchAt = turn.t
    for (const match of matches) if (!entry.matchedTerms.includes(match.term.raw)) entry.matchedTerms.push(match.term.raw)
    entry.hits.push({ t: turn.t, o: turn.o, match: best.kind, term: best.term.raw, snippet: snippetOf(turn.text, best) })
    // Keep the strongest, then newest, so a long session cannot grow this
    // without bound; the count above still says how many there were.
    if (entry.hits.length > HITS_PER_SESSION) {
      entry.hits.sort((a, b) => TIER[b.match] - TIER[a.match] || b.t - a.t)
      entry.hits.length = HITS_PER_SESSION
    }
  }

  // Ranking, after everything has been looked at. Something the person did
  // themselves comes before something software opened; a match as written
  // before a respelled one, since a close match is the likelier false hit;
  // then the most recent mention.
  const ranked = [...bySession.values()]
    .map((entry) => ({ ...entry, hits: entry.hits.sort((a, b) => TIER[b.match] - TIER[a.match] || b.t - a.t) }))
    .sort((a, b) =>
      Number(isSecondary(a)) - Number(isSecondary(b))
      || TIER[b.match] - TIER[a.match]
      || b.lastMatchAt - a.lastMatchAt)

  const page = ranked.slice(cursor, cursor + limit)
  const next = cursor + page.length
  if (devLogEnabled()) {
    devTrace('index-search.search', {
      terms: terms.map(term => ({ raw: term.raw, norm: term.norm, joined: term.joined, slack: term.slack })),
      perTerm: terms.map(term => ({
        term: term.raw, ...perTerm!.get(term)!,
        // The vocabulary words a respelling accepted — read these to judge
        // whether close matching found the person or found noise.
        closeWords: [...new Set(close.get(term)?.values() ?? [])].filter(word => word !== term.norm).slice(0, 25),
      })),
      searchedTurns: corpus.turns.length, searchedSessions: allSessions.size,
      matchedTurns, matchedSessions: ranked.length,
      byTier: {
        exact: ranked.filter(s => s.match === 'exact').length,
        joined: ranked.filter(s => s.match === 'joined').length,
        close: ranked.filter(s => s.match === 'close').length,
      },
      secondary: ranked.filter(isSecondary).length,
      cursor, limit, returned: page.length, remaining: Math.max(0, ranked.length - next),
      // The ranking as the Agent will see it, with why each is where it is.
      ranking: ranked.slice(cursor, cursor + limit).map((s, i) => ({
        rank: cursor + i + 1, sessionId: s.sessionId, match: s.match, secondary: isSecondary(s),
        lastMatchAt: new Date(s.lastMatchAt).toISOString(), matchedTurns: s.matchedTurns,
        terms: s.matchedTerms, provider: s.provider ?? null, cwd: s.cwd ?? null,
      })),
      ms: { load: loadedAt - started, close: closedAt - loadedAt, match: Date.now() - closedAt, total: Date.now() - started },
    })
  }
  return {
    searched: {
      turns: corpus.turns.length, sessions: allSessions.size,
      ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}),
      unreadable: corpus.unreadable,
    },
    matchedSessions: ranked.length,
    matchedTurns,
    sessions: page,
    ...(next < ranked.length ? { nextCursor: next } : {}),
    remaining: Math.max(0, ranked.length - next),
  }
}

/** Opened by software, or not a main conversation: still returned, never first. */
function isSecondary(entry: TurnSearchSession): boolean {
  return entry.briefing === true || entry.provenance === 'subagent'
}

/** Prepare the index ahead of the first question, so the first search of a
 *  process does not pay the one-time ~3 s it takes to read 28 MB. */
export function warmTurnSearch(root: string = defaultIndexRoot()): void {
  const started = Date.now()
  devTrace('index-search.warm-started', { root })
  void loadTurns(root).then(corpus => loadSessions(root, corpus))
    .then(sessions => devTrace('index-search.warm-done', { sessions: sessions.size, ms: Date.now() - started }))
    .catch(error => devTrace('index-search.warm-failed', { error: String(error), ms: Date.now() - started }))
}
