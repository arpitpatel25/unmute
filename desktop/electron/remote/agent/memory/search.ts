import type { MemoryIndexSearchHit } from './index'
import {
  MEMORY_KINDS,
  type MemoryKind,
  type MemoryRecord,
  type MemoryScope,
} from './types'

const MAX_SNIPPET_CODE_POINTS = 240
const RECENCY_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000

export interface MemorySearchQuery {
  text: string
  kinds?: readonly string[]
  tags?: readonly string[]
  scope?: MemoryScope
  limit?: number
}

export interface MemorySearchResult {
  id: string
  title: string
  kind: MemoryKind
  /**
   * What the record is for, as written when it was stored. THIS is what a
   * result is meant to be decided on — the snippet below is raw material and
   * exists only for records written before summaries did.
   */
  summary?: string
  snippet: string
  score: number
  attachmentCount: number
  scopes: string[]
}

export interface MemorySearchCandidate {
  hit: MemoryIndexSearchHit
  record: MemoryRecord
}

export function normalizeMemorySearchText(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US')
}

function aliasValues(tags: readonly string[]): string[] {
  const aliases: string[] = []
  for (const tag of tags) {
    const match = /^alias\s*[:=]\s*(.+)$/iu.exec(tag)
    if (match?.[1]) aliases.push(normalizeMemorySearchText(match[1]))
  }
  return aliases
}

export function memorySearchExactTier(query: string, record: MemoryRecord): number {
  const normalized = normalizeMemorySearchText(query)
  if (normalizeMemorySearchText(record.title) === normalized) return 2
  return aliasValues(record.tags).includes(normalized) ? 1 : 0
}

function exactTier(query: string, candidate: MemorySearchCandidate): number {
  if (candidate.hit.exactTitle || normalizeMemorySearchText(candidate.record.title) === query) return 2
  return memorySearchExactTier(query, candidate.record)
}

function matchesNormalized(values: readonly string[], expected: string): boolean {
  const normalized = normalizeMemorySearchText(expected)
  return values.some((value) => normalizeMemorySearchText(value) === normalized)
}

function contextBoost(
  query: MemorySearchQuery,
  candidate: MemorySearchCandidate,
  now: number,
): number {
  const ordinaryTags = candidate.record.tags.filter((tag) => !/^alias\s*[:=]/iu.test(tag))
  const requestedTags = query.tags ?? []
  const tagMatches = requestedTags.filter((tag) => matchesNormalized(ordinaryTags, tag)).length
  const tagBoost = Math.min(0.2, tagMatches * 0.1)

  let scopeMatches = 0
  for (const key of ['app', 'project', 'purpose'] as const) {
    const requested = query.scope?.[key]
    const actual = candidate.record.scope?.[key]
    if (
      requested !== undefined
      && actual !== undefined
      && normalizeMemorySearchText(requested) === normalizeMemorySearchText(actual)
    ) scopeMatches += 1
  }
  const scopeBoost = Math.min(0.15, scopeMatches * 0.05)
  const age = Math.max(0, now - candidate.record.updatedAt)
  const recencyBoost = Math.max(0, 1 - age / RECENCY_WINDOW_MS) * 0.05
  return tagBoost + scopeBoost + recencyBoost
}

function kind(record: MemoryRecord): MemoryKind {
  return (MEMORY_KINDS as readonly string[]).includes(record.kind)
    ? record.kind as MemoryKind
    : 'note'
}

/**
 * Prefers the summary over an excerpt of the body. A slice of content shows
 * what a record CONTAINS; a summary says what it is FOR, and only the second
 * can be decided on without opening the record.
 */
function quotedSnippet(record: MemoryRecord): string {
  if (record.kind === 'credential-ref') {
    return JSON.stringify('[credential content withheld from search]')
  }
  const source = record.summary ?? record.content ?? record.title
  const codePoints = [...source]
  const excerpt = codePoints.length <= MAX_SNIPPET_CODE_POINTS
    ? source
    : `${codePoints.slice(0, MAX_SNIPPET_CODE_POINTS - 1).join('')}…`
  return JSON.stringify(excerpt)
}

function scopes(scope: MemoryScope | undefined): string[] {
  if (!scope) return []
  return [scope.app, scope.project, scope.purpose].filter((value): value is string => value !== undefined)
}

function score(query: MemorySearchQuery, candidate: MemorySearchCandidate, now: number): number {
  const tier = exactTier(normalizeMemorySearchText(query.text), candidate)
  const lexical = Number.isFinite(candidate.hit.lexicalRank) ? -candidate.hit.lexicalRank : 0
  return Number((tier * 1_000 + lexical + contextBoost(query, candidate, now)).toFixed(6))
}

function compareIdentifiers(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1
}

export function rankMemorySearch(
  query: MemorySearchQuery,
  candidates: readonly MemorySearchCandidate[],
  now: number,
): MemorySearchResult[] {
  const ranked = candidates.map((candidate) => ({
    candidate,
    tier: exactTier(normalizeMemorySearchText(query.text), candidate),
    score: score(query, candidate, now),
  }))
  ranked.sort((left, right) => (
    right.tier - left.tier
    || right.score - left.score
    || compareIdentifiers(left.candidate.record.id, right.candidate.record.id)
  ))
  return ranked.slice(0, query.limit ?? 20).map(({ candidate, score: value }) => ({
    id: candidate.record.id,
    title: candidate.record.title,
    kind: kind(candidate.record),
    ...(candidate.record.summary === undefined ? {} : { summary: candidate.record.summary }),
    snippet: quotedSnippet(candidate.record),
    score: value,
    attachmentCount: candidate.record.attachments.length,
    scopes: scopes(candidate.record.scope),
  }))
}
