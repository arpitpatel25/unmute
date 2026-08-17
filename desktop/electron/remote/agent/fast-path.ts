import type { CapabilityCallContext } from './types'
import type { MemoryGetOptions, MemoryRecordView } from './memory/service'
import type { MemorySearchQuery, MemorySearchResult } from './memory/search'

export const FAST_PATH_MIN_SCORE = 1_500
export const FAST_PATH_MIN_MARGIN = 500

const MAX_QUERY_CODE_POINTS = 160
const RETRIEVAL = /^(get|find)\s+my\s+(.+?)[.!?]?$/iu
const ADDITIONAL_INTENT = /(?:[,;:]|\b(?:and|then|also|using|use|reply|respond|draft|write|rewrite|compose|summari[sz]e|explain|why|how|attach|send|email|post|share|copy|paste|open|deliver|remember|save|store|update|change|edit|delete|remove|forget|restore)\b)/iu
const SAFE_QUERY = /^[\p{L}\p{N}][\p{L}\p{N}\p{M}\s'’._+&()\/-]*$/u

export interface FastPathMemoryService {
  search(ctx: CapabilityCallContext, query: MemorySearchQuery): Promise<MemorySearchResult[]>
  get(ctx: CapabilityCallContext, id: string, options?: MemoryGetOptions): Promise<MemoryRecordView>
}

export interface FastPathClassification {
  verb: 'get' | 'find'
  query: string
}

export interface FastPathAnswer {
  kind: 'memory'
  memoryId: string
  title: string
  text: string
  score: number
}

export interface FastPathAttempt {
  transcript: string
  context: CapabilityCallContext
}

export interface FastPathRouterOptions {
  minScore?: number
  minMargin?: number
  searchLimit?: number
}

/**
 * A deliberately finite retrieval grammar. Anything which may contain a
 * second instruction is left to the selected Agent provider.
 */
export function classifyFastPathTranscript(transcript: string): FastPathClassification | null {
  if (typeof transcript !== 'string') return null
  const normalized = transcript.normalize('NFKC').trim().replace(/\s+/gu, ' ')
  const match = RETRIEVAL.exec(normalized)
  if (!match?.[1] || !match[2]) return null

  const query = match[2].trim().replace(/[.!?]+$/u, '').trim()
  if (
    query.length === 0
    || [...query].length > MAX_QUERY_CODE_POINTS
    || !SAFE_QUERY.test(query)
    || ADDITIONAL_INTENT.test(query)
  ) return null

  return { verb: match[1].toLocaleLowerCase('en-US') as 'get' | 'find', query }
}

/** Exact, normal-sensitivity lookup router. A refusal is represented by null. */
export class FastPathRouter {
  private readonly minScore: number
  private readonly minMargin: number
  private readonly searchLimit: number

  constructor(
    private readonly memory: FastPathMemoryService,
    options: FastPathRouterOptions = {},
  ) {
    this.minScore = finiteNonNegative(options.minScore, FAST_PATH_MIN_SCORE)
    this.minMargin = finiteNonNegative(options.minMargin, FAST_PATH_MIN_MARGIN)
    this.searchLimit = positiveInteger(options.searchLimit, 3)
  }

  async attempt(input: FastPathAttempt): Promise<FastPathAnswer | null> {
    const classified = classifyFastPathTranscript(input.transcript)
    if (!classified) return null

    const results = await this.memory.search(input.context, {
      text: classified.query,
      includeSensitive: false,
      limit: this.searchLimit,
    })
    const winner = uniqueWinner(results, this.minScore, this.minMargin)
    if (!winner) return null

    const record = await this.memory.get(input.context, winner.id, {
      includeContent: true,
      includeAttachments: false,
      includeDeleted: false,
    })
    // Search and get are separate reads. Re-check sensitivity so a concurrent
    // update cannot turn an accepted lookup into a concealed-content reveal.
    if (record.sensitivity !== 'normal') return null

    return {
      kind: 'memory',
      memoryId: record.id,
      title: record.title,
      text: record.content ?? decodeSnippet(winner.snippet) ?? record.title,
      score: winner.score,
    }
  }

  route(context: CapabilityCallContext, transcript: string): Promise<FastPathAnswer | null> {
    return this.attempt({ context, transcript })
  }
}

function uniqueWinner(
  results: readonly MemorySearchResult[],
  minScore: number,
  minMargin: number,
): MemorySearchResult | null {
  const [winner, runnerUp] = results
  if (!winner || winner.sensitivity !== 'normal' || !Number.isFinite(winner.score)) return null
  if (winner.score < minScore) return null
  if (runnerUp && (
    runnerUp.sensitivity !== 'normal'
    || !Number.isFinite(runnerUp.score)
    || winner.score - runnerUp.score < minMargin
  )) return null
  return winner
}

function decodeSnippet(value: string): string | undefined {
  try {
    const decoded = JSON.parse(value) as unknown
    return typeof decoded === 'string' && decoded.length > 0 ? decoded : undefined
  } catch {
    return undefined
  }
}

function finiteNonNegative(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isFinite(value) || value < 0) throw new Error('Fast-path threshold is invalid')
  return value
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Fast-path search limit is invalid')
  return value
}
