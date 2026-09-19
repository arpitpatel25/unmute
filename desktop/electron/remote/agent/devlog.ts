import { createLogger } from '../log'
import { devEvent, devLogEnabled } from '../curator-devlog'

/**
 * DEV-ONLY TRACE OF HOW THE AGENT DECIDES.
 *
 * Written to answer, from the run log alone, the questions the 2026-09-18
 * Tanmay failure raised: did the Agent look before it acted, WHERE did it look
 * (index_search, a hand-written grep of the index, a transcript), was that
 * grep capped so it could only see part of the index, what did the search
 * find, and did what it found reach the task it created?
 *
 * Same gate as every other dev trace: devLogEnabled() — on for unpackaged
 * runs, flipped on in the working tree for a packaged test build, never on in
 * a public build. When it is off every function here returns immediately and
 * nothing is kept in memory. These lines carry what the person said, search
 * terms and snippets, which is exactly why they must stay behind that gate.
 *
 * Nothing logged here is ever read back into a decision.
 *
 * Greppable: every event is on the `agent-decision` component, and one
 * interaction is `interactionId=<id>` throughout.
 */

const log = createLogger('agent-decision')

/** Long enough to hold a whole grep command or a tool's arguments. */
const MAX_DETAIL = 1_200
const MAX_TRANSCRIPT = 600

export function devTrace(name: string, payload: Record<string, unknown> = {}): void {
  devEvent(log, name, payload)
}

export function clip(value: string, max = MAX_DETAIL): string {
  return value.length <= max ? value : `${value.slice(0, max)}…(+${value.length - max} chars)`
}

export type RetrievalPath =
  | 'index-search-tool'
  | 'index-grep'
  | 'index-read'
  | 'transcript-grep'
  | 'transcript-read'
  | 'other'

export interface RetrievalShape {
  path: RetrievalPath
  /** Anything that shows the Agent only part of what it asked for. */
  caps: string[]
}

const INDEX = /session-index|turns\.jsonl|sessions\.jsonl/
const TRANSCRIPTS = /\.claude\/projects|\.codex\/sessions/
const SEARCHES = /\b(?:rg|grep|ag|jq|awk)\b|"(?:pattern|query)"\s*:/
const CAPS: Array<[RegExp, (m: RegExpMatchArray) => string]> = [
  [/(?:^|\s)-m\s*(\d+)/, m => `-m ${m[1]}`],
  [/--max-count[= ](\d+)/, m => `--max-count ${m[1]}`],
  [/\|\s*head\b(?:\s+-n\s*|\s+-)?(\d+)?/, m => `| head${m[1] ? ` ${m[1]}` : ''}`],
  [/\|\s*tail\b(?:\s+-n\s*|\s+-)?(\d+)?/, m => `| tail${m[1] ? ` ${m[1]}` : ''}`],
  [/max_output_tokens\W+(\d+)/, m => `max_output_tokens ${m[1]}`],
  [/"head_limit"\s*:\s*(\d+)/, m => `head_limit ${m[1]}`],
  [/"limit"\s*:\s*(\d+)/, m => `limit ${m[1]}`],
]

/**
 * What kind of lookup a raw tool call was. Deliberately textual: the Agent
 * reaches the index through Grep, through a shell, and through JavaScript that
 * calls a shell, and all three leave the same words behind.
 */
export function classifyRetrieval(tool: string, input: string): RetrievalShape {
  const text = `${tool} ${input}`
  const caps = CAPS.flatMap(([pattern, describe]) => {
    const match = text.match(pattern)
    return match ? [describe(match)] : []
  })
  let path: RetrievalPath = 'other'
  if (/index_search/.test(text)) path = 'index-search-tool'
  else if (INDEX.test(text)) path = SEARCHES.test(text) || /^grep$/i.test(tool) ? 'index-grep' : 'index-read'
  else if (TRANSCRIPTS.test(text)) path = SEARCHES.test(text) || /^grep$/i.test(tool) ? 'transcript-grep' : 'transcript-read'
  return { path, caps: path === 'other' || path === 'index-search-tool' ? [] : caps }
}

interface ToolNote {
  at: number
  tool: string
  outcome?: string
  durationMs?: number
  facts?: Record<string, unknown>
}

interface InteractionTally {
  startedAt: number
  provider?: string
  transcript: string
  tools: ToolNote[]
  retrievals: Array<RetrievalShape & { tool: string }>
}

const interactions = new Map<string, InteractionTally>()
/** A run that never reports its end must not grow this forever. */
const MAX_TRACKED = 64

export function devInteractionStarted(interactionId: string, facts: { runId: string; provider?: string; transcript: string; resumed: boolean }): void {
  if (!devLogEnabled()) return
  if (interactions.size >= MAX_TRACKED) interactions.delete(interactions.keys().next().value!)
  interactions.set(interactionId, { startedAt: Date.now(), provider: facts.provider, transcript: facts.transcript, tools: [], retrievals: [] })
  devTrace('interaction.started', {
    interactionId, runId: facts.runId, provider: facts.provider ?? null, resumed: facts.resumed,
    transcript: clip(facts.transcript, MAX_TRANSCRIPT), transcriptChars: facts.transcript.length,
  })
}

/** An MCP capability call, as the registry dispatched it. */
export function devToolCall(interactionId: string | undefined, note: ToolNote): void {
  if (!devLogEnabled() || !interactionId) return
  interactions.get(interactionId)?.tools.push(note)
}

/** A raw provider tool use — Grep, Read, a shell, a JavaScript cell. */
export function devProviderTool(interactionId: string, tool: string, input: string): void {
  if (!devLogEnabled()) return
  const shape = classifyRetrieval(tool, input)
  interactions.get(interactionId)?.retrievals.push({ ...shape, tool })
  devTrace('provider-tool', { interactionId, tool, path: shape.path, caps: shape.caps, input: clip(input) })
  if ((shape.path === 'index-grep' || shape.path === 'transcript-grep') && shape.caps.length) {
    // The exact failure of 2026-09-18: a search that can only return what
    // happens to come first in the file, reported to the Agent as if whole.
    devTrace('retrieval.capped-grep', { interactionId, tool, path: shape.path, caps: shape.caps, input: clip(input) })
  }
}

const READS = new Set(['index_search', 'sessions_open', 'memory_list', 'memory_search', 'memory_get'])
const ACTIONS = new Set(['task_create', 'session_resume', 'session_fork', 'session_send', 'session_close',
  'memory_store', 'memory_update', 'memory_forget', 'memory_link'])

/**
 * One line that answers "what did the Agent do with this request": which of
 * the three reads it made before its first action (the constitution's LOOK
 * rule), whether it used index_search or grepped the index itself, whether
 * that grep was capped, and whether the task it made carried any context.
 */
export function devInteractionEnded(interactionId: string, facts: { outcome: string; finalText?: string; error?: string }): void {
  if (!devLogEnabled()) return
  const tally = interactions.get(interactionId)
  interactions.delete(interactionId)
  if (!tally) { devTrace('interaction.ended', { interactionId, outcome: facts.outcome, tracked: false }); return }

  const bare = (tool: string) => tool.replace(/^mcp__unmute__/, '')
  const firstAction = tally.tools.find(note => ACTIONS.has(bare(note.tool)))
  const beforeAction = tally.tools.filter(note => !firstAction || note.at <= firstAction.at).map(note => bare(note.tool))
  const indexGreps = tally.retrievals.filter(r => r.path === 'index-grep')
  const indexSearches = tally.tools.filter(note => bare(note.tool) === 'index_search')
  const handoffs = tally.tools.filter(note => ['task_create', 'session_send', 'session_resume', 'session_fork'].includes(bare(note.tool)))
  const lookedAtIndex = indexSearches.length > 0 || indexGreps.length > 0 || tally.retrievals.some(r => r.path === 'index-read')

  devTrace('interaction.summary', {
    interactionId,
    provider: tally.provider ?? null,
    outcome: facts.outcome,
    durationMs: Date.now() - tally.startedAt,
    transcript: clip(tally.transcript, MAX_TRANSCRIPT),
    mcpTools: tally.tools.map(note => `${bare(note.tool)}:${note.outcome ?? '?'}`),
    providerTools: tally.retrievals.map(r => `${r.tool}:${r.path}${r.caps.length ? `[${r.caps.join(',')}]` : ''}`),
    // The LOOK rule: sessions_open, the index and memory_list before acting.
    readsBeforeFirstAction: {
      sessionsOpen: beforeAction.includes('sessions_open'),
      index: lookedAtIndex,
      memoryList: beforeAction.includes('memory_list'),
    },
    firstAction: firstAction ? bare(firstAction.tool) : null,
    indexSearchCalls: indexSearches.length,
    indexSearchResults: indexSearches.map(note => note.facts ?? {}),
    indexGreps: indexGreps.length,
    cappedIndexGreps: indexGreps.filter(r => r.caps.length).map(r => r.caps),
    handoffs: handoffs.map(note => ({ tool: bare(note.tool), ...(note.facts ?? {}) })),
    ...(facts.error ? { error: facts.error } : {}),
    ...(facts.finalText ? { finalText: clip(facts.finalText, MAX_TRANSCRIPT) } : {}),
  })
  if (handoffs.length && !lookedAtIndex) devTrace('decision.acted-without-index', { interactionId, actions: handoffs.map(n => bare(n.tool)) })
  if (indexGreps.length && !indexSearches.length) devTrace('decision.grep-instead-of-index-search', { interactionId, greps: indexGreps.length })
}

/** What a capability's input says about a decision, without the payload. */
export function describeToolInput(tool: string, input: unknown): Record<string, unknown> {
  const value = (input ?? {}) as Record<string, unknown>
  const name = tool.replace(/^mcp__unmute__/, '')
  const length = (field: unknown) => (typeof field === 'string' ? field.length : 0)
  const count = (field: unknown) => (Array.isArray(field) ? field.length : 0)
  switch (name) {
    case 'index_search':
      return { terms: Array.isArray(value.terms) ? value.terms : [], cursor: value.cursor ?? null, limit: value.limit ?? null }
    case 'task_create':
    case 'session_send':
      return {
        title: value.title ?? null, group: value.group ?? null, kind: value.kind ?? null,
        intent: clip(String(value.intent ?? ''), 300),
        contextChars: length(value.context),
        sourceSessions: count(value.sourceSessions),
        artifacts: count(value.artifacts),
        ...(value.sameJobNewInstance ? { sameJobNewInstance: true } : {}),
        ...(value.taskId ? { taskId: value.taskId } : {}),
      }
    case 'session_resume':
    case 'session_fork':
      return { sessionId: value.sessionId ?? null, title: value.title ?? null, group: value.group ?? null, intentChars: length(value.intent) }
    case 'memory_search':
      return { query: value.query ?? null, kinds: value.kinds ?? null }
    default:
      return { fields: Object.keys(value) }
  }
}
