import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { AgentProviderId } from './provider'

const DIRECTORY_MODE = 0o700
const FILE_MODE = 0o600
const DEFAULT_MAX_RUNS = 256
const DEFAULT_MAX_EXCHANGES = 512
const DEFAULT_MAX_BYTES = 256 * 1024
const MAX_SUMMARY_LENGTH = 512
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const HANDLE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/

export type AgentRunState =
  | 'starting'
  | 'running'
  | 'waiting'
  | 'complete'
  | 'failed'
  | 'closed'

export interface JournalAgentRun {
  id: string
  provider: AgentProviderId
  providerHandle?: string
  state: AgentRunState
  createdAt: number
  lastUserAt: number
  lastActivityAt: number
  completedAt?: number
  /** Distinguishes a resumable logical run from live provider work. */
  providerWorkEnded: boolean
}

export interface AgentExchangeSummary {
  runId: string
  interactionId: string
  at: number
  outcome: 'completed' | 'failed' | 'interrupted'
  summary: string
}

export interface AgentJournalSnapshot {
  runs: JournalAgentRun[]
  exchanges: AgentExchangeSummary[]
}

export interface AppendExchangeInput extends AgentExchangeSummary {
  /** Values which must be removed if they accidentally occur in a summary. */
  sensitiveValues?: readonly string[]
}

export interface AgentJournalStore {
  read(): Promise<AgentJournalSnapshot>
  upsertRun(run: JournalAgentRun): Promise<void>
  removeRun(runId: string): Promise<void>
  appendExchange(exchange: AppendExchangeInput): Promise<void>
}

export type AgentJournalErrorCode = 'invalid-journal' | 'journal-failed' | 'journal-full'

/** Public errors intentionally contain neither filesystem paths nor source errors. */
export class AgentJournalError extends Error {
  constructor(readonly code: AgentJournalErrorCode) {
    super(code === 'invalid-journal'
      ? 'The Agent recovery journal is invalid.'
      : code === 'journal-full'
        ? 'The Agent recovery journal is full.'
        : 'The Agent recovery journal could not be updated.')
    this.name = 'AgentJournalError'
  }
}

interface PersistedJournal {
  format: 'unmute-agent-journal'
  version: 1
  runs: JournalAgentRun[]
  exchanges: AgentExchangeSummary[]
}

export interface AgentJournalOptions {
  /** Either a containing root directory or an explicit JSON file path. */
  root?: string
  path?: string
  maxRuns?: number
  maxExchanges?: number
  maxBytes?: number
}

/**
 * A small, owner-private recovery journal. It stores lifecycle metadata and
 * explicitly supplied summaries only; transcripts, tokens and attachments are
 * never accepted as run metadata.
 */
export class AgentJournal implements AgentJournalStore {
  private readonly path: string
  private readonly directory: string
  private readonly maxRuns: number
  private readonly maxExchanges: number
  private readonly maxBytes: number
  private mutation: Promise<void> = Promise.resolve()

  constructor(options: AgentJournalOptions) {
    if (!options.path && !options.root) throw new AgentJournalError('journal-failed')
    this.path = options.path ?? join(options.root!, 'agent-journal.json')
    this.directory = dirname(this.path)
    this.maxRuns = positiveInteger(options.maxRuns, DEFAULT_MAX_RUNS)
    this.maxExchanges = positiveInteger(options.maxExchanges, DEFAULT_MAX_EXCHANGES)
    this.maxBytes = positiveInteger(options.maxBytes, DEFAULT_MAX_BYTES)
  }

  async read(): Promise<AgentJournalSnapshot> {
    await this.mutation
    try {
      const value = JSON.parse(await readFile(this.path, 'utf8')) as unknown
      return publicSnapshot(validateJournal(value))
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return { runs: [], exchanges: [] }
      if (error instanceof AgentJournalError) throw error
      throw new AgentJournalError('invalid-journal')
    }
  }

  /** Alias useful to diagnostics without exposing the persisted envelope. */
  snapshot(): Promise<AgentJournalSnapshot> {
    return this.read()
  }

  load(): Promise<AgentJournalSnapshot> {
    return this.read()
  }

  upsertRun(run: JournalAgentRun): Promise<void> {
    const safeRun = validateRun(run)
    return this.mutate((journal) => {
      const index = journal.runs.findIndex(({ id }) => id === safeRun.id)
      if (index === -1) journal.runs.push(safeRun)
      else journal.runs[index] = safeRun
    })
  }

  removeRun(runId: string): Promise<void> {
    if (!ID.test(runId)) return Promise.reject(new AgentJournalError('journal-failed'))
    return this.mutate((journal) => {
      journal.runs = journal.runs.filter(({ id }) => id !== runId)
    })
  }

  appendExchange(exchange: AppendExchangeInput): Promise<void> {
    const value = validateExchange({
      runId: exchange.runId,
      interactionId: exchange.interactionId,
      at: exchange.at,
      outcome: exchange.outcome,
      summary: redactJournalSummary(exchange.summary, exchange.sensitiveValues),
    })
    return this.mutate((journal) => { journal.exchanges.push(value) })
  }

  append(exchange: AppendExchangeInput): Promise<void> {
    return this.appendExchange(exchange)
  }

  /** Replace all durable run metadata while retaining bounded exchanges. */
  replaceRuns(runs: readonly JournalAgentRun[]): Promise<void> {
    const safeRuns = runs.map(validateRun)
    return this.mutate((journal) => { journal.runs = safeRuns })
  }

  private mutate(change: (journal: PersistedJournal) => void): Promise<void> {
    const operation = this.mutation.then(async () => {
      const journal = await this.readPersisted()
      change(journal)
      this.bound(journal)
      await this.write(journal)
    })
    this.mutation = operation.catch(() => {})
    return operation
  }

  private async readPersisted(): Promise<PersistedJournal> {
    try {
      return validateJournal(JSON.parse(await readFile(this.path, 'utf8')) as unknown)
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return emptyJournal()
      if (error instanceof AgentJournalError) throw error
      throw new AgentJournalError('invalid-journal')
    }
  }

  private bound(journal: PersistedJournal): void {
    journal.exchanges.sort((a, b) => a.at - b.at)
    if (journal.exchanges.length > this.maxExchanges) {
      journal.exchanges.splice(0, journal.exchanges.length - this.maxExchanges)
    }

    if (journal.runs.length > this.maxRuns) {
      const removable = journal.runs
        .filter(({ state, providerWorkEnded }) => providerWorkEnded && isTerminal(state))
        .sort((a, b) => a.lastActivityAt - b.lastActivityAt)
      const remove = new Set(removable
        .slice(0, journal.runs.length - this.maxRuns)
        .map(({ id }) => id))
      journal.runs = journal.runs.filter(({ id }) => !remove.has(id))
    }
    if (journal.runs.length > this.maxRuns) throw new AgentJournalError('journal-full')

    while (Buffer.byteLength(JSON.stringify(journal), 'utf8') > this.maxBytes) {
      if (journal.exchanges.length > 0) journal.exchanges.shift()
      else {
        const candidate = journal.runs
          .filter(({ state, providerWorkEnded }) => providerWorkEnded && isTerminal(state))
          .sort((a, b) => a.lastActivityAt - b.lastActivityAt)[0]
        if (!candidate) throw new AgentJournalError('journal-full')
        journal.runs = journal.runs.filter(({ id }) => id !== candidate.id)
      }
    }
  }

  private async write(journal: PersistedJournal): Promise<void> {
    let staging: string | undefined
    try {
      await mkdir(this.directory, { recursive: true, mode: DIRECTORY_MODE })
      staging = join(this.directory, `.agent-journal-${randomUUID()}.tmp`)
      const file = await open(staging, 'wx', FILE_MODE)
      try {
        await file.writeFile(JSON.stringify(journal), 'utf8')
        await file.sync()
      } finally {
        await file.close()
      }
      await rename(staging, this.path)
      staging = undefined
      const directory = await open(this.directory, 'r')
      try { await directory.sync() } finally { await directory.close() }
    } catch (error) {
      if (error instanceof AgentJournalError) throw error
      throw new AgentJournalError('journal-failed')
    } finally {
      if (staging) {
        try { await unlink(staging) } catch { /* best effort for unpublished data */ }
      }
    }
  }
}

export { AgentJournal as DurableAgentJournal }

/** Removes paths and token-like material, then caps the durable summary. */
export function redactJournalSummary(value: string, sensitiveValues: readonly string[] = []): string {
  let summary = typeof value === 'string' ? value : ''
  for (const sensitive of sensitiveValues) {
    if (sensitive) summary = summary.split(sensitive).join('[redacted]')
  }
  summary = summary
    .replace(/file:\/\/[^\s,;:)}\]"'`]+/gi, '[path]')
    .replace(/(^|[\s("'`])\/(?!\/)[^\s,;:)}\]"'`]+/g, '$1[path]')
    .replace(/[A-Za-z]:\\[^\s,;:)}\]"']+/g, '[path]')
    .replace(/\b(?:bearer|token|secret|authorization)\s*[:=]\s*[^\s,;]+/gi, '[redacted]')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
  return summary.slice(0, MAX_SUMMARY_LENGTH)
}

function emptyJournal(): PersistedJournal {
  return { format: 'unmute-agent-journal', version: 1, runs: [], exchanges: [] }
}

function publicSnapshot(journal: PersistedJournal): AgentJournalSnapshot {
  return structuredClone({ runs: journal.runs, exchanges: journal.exchanges })
}

function validateJournal(value: unknown): PersistedJournal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentJournalError('invalid-journal')
  }
  const journal = value as Partial<PersistedJournal>
  if (journal.format !== 'unmute-agent-journal' || journal.version !== 1
    || !Array.isArray(journal.runs) || !Array.isArray(journal.exchanges)) {
    throw new AgentJournalError('invalid-journal')
  }
  return {
    format: 'unmute-agent-journal',
    version: 1,
    runs: journal.runs.map(validateRun),
    exchanges: journal.exchanges.map(validateExchange),
  }
}

function validateRun(value: JournalAgentRun): JournalAgentRun {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.id !== 'string' || !ID.test(value.id)
    || !isProvider(value.provider) || !isState(value.state)
    || (value.providerHandle !== undefined
      && (typeof value.providerHandle !== 'string' || !HANDLE.test(value.providerHandle)))
    || !timestamp(value.createdAt) || !timestamp(value.lastUserAt)
    || !timestamp(value.lastActivityAt)
    || (value.completedAt !== undefined && !timestamp(value.completedAt))
    || typeof value.providerWorkEnded !== 'boolean') {
    throw new AgentJournalError('invalid-journal')
  }
  return structuredClone(value)
}

function validateExchange(value: AgentExchangeSummary): AgentExchangeSummary {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.runId !== 'string' || !ID.test(value.runId)
    || typeof value.interactionId !== 'string' || !ID.test(value.interactionId)
    || !timestamp(value.at)
    || !['completed', 'failed', 'interrupted'].includes(value.outcome)
    || typeof value.summary !== 'string' || value.summary.length > MAX_SUMMARY_LENGTH) {
    throw new AgentJournalError('invalid-journal')
  }
  return structuredClone(value)
}

function isProvider(value: unknown): value is AgentProviderId {
  return value === 'claude' || value === 'codex'
}

function isState(value: unknown): value is AgentRunState {
  return ['starting', 'running', 'waiting', 'complete', 'failed', 'closed'].includes(String(value))
}

function isTerminal(state: AgentRunState): boolean {
  return state === 'complete' || state === 'failed' || state === 'closed'
}

function timestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value <= 0) throw new AgentJournalError('journal-failed')
  return value
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}
