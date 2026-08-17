import { randomUUID } from 'node:crypto'

import type { CapabilityCallContext, McpPrincipal } from '../types'
import type {
  AttachmentDescriptor,
  OpenAttachmentHandle,
  StoreAttachmentInput,
} from './attachments'
import {
  memoryAuditRow,
  type MemoryAuditInput,
  type MemoryAuditOperation,
  type MemoryAuditSink,
} from './audit'
import type { MemoryIndex } from './index'
import type { MemoryMutationIntent, MemoryMutationJournal } from './journal'
import {
  memorySearchExactTier,
  rankMemorySearch,
  type MemorySearchQuery,
  type MemorySearchResult,
} from './search'
import {
  presentMemoryRecord,
} from './record-store'
import type {
  CreateMemoryRecordInput,
  MemoryRecord,
  MemoryRecordPatch,
  MemoryReference,
  PresentedMemoryRecord,
} from './types'

const DEFAULT_SEARCH_LIMIT = 20
const MAX_SEARCH_LIMIT = 100
const UNASSIGNED_MEMORY_ID = 'unassigned'
const SEARCH_QUERY_KEYS = new Set(['text', 'kinds', 'tags', 'scope', 'includeSensitive', 'limit'])
const GET_OPTION_KEYS = new Set(['includeContent', 'includeAttachments', 'includeDeleted'])
const UPDATE_PATCH_KEYS = new Set([
  'kind', 'title', 'content', 'tags', 'scope', 'sensitivity', 'references', 'provenance',
])

type MutationIntent = 'store' | 'update' | 'forget' | 'restore'

export type DeliveryHandle = OpenAttachmentHandle

export type MemoryStoreInput = Omit<CreateMemoryRecordInput, 'attachments'> & {
  attachments?: readonly string[]
}

export type MemoryRecordView = Omit<
  PresentedMemoryRecord,
  'content' | 'attachments' | 'references'
> & {
  content?: string
  attachments?: string[]
  references: MemoryReference[]
}

export interface MemoryGetOptions {
  includeContent?: boolean
  includeAttachments?: boolean
  includeDeleted?: boolean
}

export interface MemoryCanonicalStore {
  initialize(): Promise<void>
  list(): Promise<MemoryRecord[]>
  create(input: CreateMemoryRecordInput, expectedId?: string): Promise<MemoryRecord>
  read(id: string): Promise<MemoryRecord>
  readTrash(id: string): Promise<MemoryRecord>
  update(id: string, patch: MemoryRecordPatch): Promise<MemoryRecord>
  forget(id: string): Promise<void>
  restore(id: string): Promise<void>
}

export interface MemoryAttachmentStore {
  initialize(): Promise<void>
  store(principal: McpPrincipal, input: StoreAttachmentInput): Promise<AttachmentDescriptor>
  trashRecord(recordId: string): Promise<void>
  restoreRecord(recordId: string): Promise<void>
  purgeRecord(recordId: string): Promise<void>
  open(principal: McpPrincipal, attachmentId: string, expiresAt?: number): Promise<OpenAttachmentHandle>
}

export interface MemoryServiceOptions {
  records: MemoryCanonicalStore
  attachments: MemoryAttachmentStore
  index: MemoryIndex
  audit: MemoryAuditSink
  journal: MemoryMutationJournal
  createMemoryId?: () => string
}

export type MemoryServiceErrorCode =
  | 'access-denied'
  | 'intent-required'
  | 'invalid-input'
  | 'not-found'
  | 'operation-failed'
  | 'compensation-failed'

export class MemoryServiceError extends Error {
  constructor(readonly code: MemoryServiceErrorCode, message: string) {
    super(message)
    this.name = 'MemoryServiceError'
  }
}

type AgentContext = CapabilityCallContext & {
  principal: Extract<McpPrincipal, { kind: 'unmute-agent' }>
}

function requireAgent(ctx: CapabilityCallContext): asserts ctx is AgentContext {
  if (ctx.principal.kind !== 'unmute-agent' || ctx.principal.expiresAt <= ctx.now) {
    throw new MemoryServiceError('access-denied', 'Memory access is unavailable')
  }
}

function requireActiveInteraction(ctx: CapabilityCallContext): void {
  requireAgent(ctx)
  if (ctx.interaction?.active !== true || ctx.interaction.id !== ctx.principal.interactionId) {
    throw new MemoryServiceError('intent-required', 'Memory operation requires explicit user intent')
  }
}

function requireIntent(ctx: CapabilityCallContext, intent: MutationIntent | 'reveal-sensitive'): void {
  requireActiveInteraction(ctx)
  if (!ctx.interaction?.intents?.includes(`memory.${intent}`)) {
    throw new MemoryServiceError('intent-required', 'Memory operation requires explicit user intent')
  }
}

function requireSearchQuery(query: MemorySearchQuery): Required<Pick<MemorySearchQuery, 'text' | 'limit'>> {
  const limit = query?.limit ?? DEFAULT_SEARCH_LIMIT
  if (
    !query || typeof query !== 'object' || Array.isArray(query)
    || Object.keys(query).some((key) => !SEARCH_QUERY_KEYS.has(key))
    || typeof query.text !== 'string' || query.text.trim().length === 0
    || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SEARCH_LIMIT
    || (query.includeSensitive !== undefined && typeof query.includeSensitive !== 'boolean')
    || (query.kinds !== undefined && (
      !Array.isArray(query.kinds)
      || query.kinds.some((value) => typeof value !== 'string' || value.trim().length === 0)
    ))
    || (query.tags !== undefined && (
      !Array.isArray(query.tags)
      || query.tags.some((value) => typeof value !== 'string' || value.trim().length === 0)
    ))
    || (query.scope !== undefined && (
      !query.scope || typeof query.scope !== 'object' || Array.isArray(query.scope)
      || Object.keys(query.scope).some((key) => !['app', 'project', 'purpose'].includes(key))
      || Object.values(query.scope).some((value) => typeof value !== 'string' || value.trim().length === 0)
    ))
  ) {
    throw new MemoryServiceError('invalid-input', 'Memory search query is invalid')
  }
  return { text: query.text, limit }
}

function requireGetOptions(options: MemoryGetOptions): void {
  if (
    !options || typeof options !== 'object' || Array.isArray(options)
    || Object.keys(options).some((key) => !GET_OPTION_KEYS.has(key))
    || Object.values(options).some((value) => typeof value !== 'boolean')
  ) {
    throw new MemoryServiceError('invalid-input', 'Memory get options are invalid')
  }
}

function requireUpdatePatch(patch: MemoryRecordPatch): void {
  if (
    !patch || typeof patch !== 'object' || Array.isArray(patch)
    || Object.keys(patch).length === 0
    || Object.keys(patch).some((key) => !UPDATE_PATCH_KEYS.has(key))
  ) throw new MemoryServiceError('invalid-input', 'Memory update input is invalid')
}

function dependencyCode(error: unknown): unknown {
  return error && typeof error === 'object' && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined
}

function isNotFound(error: unknown): boolean {
  return dependencyCode(error) === 'not-found'
}

function rollbackPatch(record: MemoryRecord): MemoryRecordPatch {
  return {
    kind: record.kind,
    title: record.title,
    content: record.content ?? null,
    tags: [...record.tags],
    scope: record.scope === undefined ? null : { ...record.scope },
    sensitivity: record.sensitivity,
    attachments: [...record.attachments],
    references: record.references.map((reference) => ({ ...reference })),
    provenance: { ...record.provenance },
  }
}

function pathFreeReferences(references: readonly MemoryReference[]): MemoryReference[] {
  return references
    .filter((reference) => reference.type !== 'path')
    .map((reference) => ({ ...reference }))
}

function view(record: MemoryRecord, options: MemoryGetOptions): MemoryRecordView {
  const presented = presentMemoryRecord(record)
  const result: MemoryRecordView = {
    id: presented.id,
    kind: presented.kind,
    title: presented.title,
    tags: [...presented.tags],
    ...(presented.scope === undefined ? {} : { scope: { ...presented.scope } }),
    sensitivity: presented.sensitivity,
    references: pathFreeReferences(presented.references),
    provenance: { source: presented.provenance.source },
    createdAt: presented.createdAt,
    updatedAt: presented.updatedAt,
    version: presented.version,
    ...(presented.deletedAt === undefined ? {} : { deletedAt: presented.deletedAt }),
  }
  if (options.includeContent && presented.content !== undefined) result.content = presented.content
  if (options.includeAttachments) result.attachments = [...presented.attachments]
  return result
}

/** Singleton mutation boundary for canonical records, attachments, and the index projection. */
export class MemoryService {
  private mutationQueue: Promise<void> = Promise.resolve()
  private readonly initialization: Promise<void>
  private readonly createMemoryId: () => string

  constructor(private readonly options: MemoryServiceOptions) {
    this.createMemoryId = options.createMemoryId ?? randomUUID
    this.initialization = this.enqueueMutation(async () => {
      await Promise.all([options.records.initialize(), options.attachments.initialize()])
      const pending = await options.journal.read()
      if (pending) await this.recover(pending)
      const canonical = await options.records.list()
      options.index.rebuild(canonical)
    })
  }

  async store(ctx: CapabilityCallContext, input: MemoryStoreInput): Promise<MemoryRecord> {
    requireIntent(ctx, 'store')
    await this.ready('store')
    return this.enqueueMutation(async () => {
      const memoryId = this.createMemoryId()
      const intent = this.mutationIntent(ctx, memoryId, 'store')
      let record: MemoryRecord | undefined
      try { await this.options.journal.begin(intent) } catch (error) { throw this.failure('store', error) }
      try {
        const handles = [...(input.attachments ?? [])]
        record = await this.options.records.create({ ...input, attachments: [] }, memoryId)
        await this.checkpoint(intent, 'canonical')
        const attachmentIds: string[] = []
        for (const handle of handles) {
          const attachment = await this.options.attachments.store(ctx.principal, {
            recordId: record.id,
            handle,
          })
          attachmentIds.push(attachment.id)
        }
        await this.checkpoint(intent, 'attachments')
        if (attachmentIds.length > 0) {
          record = await this.options.records.update(record.id, { attachments: attachmentIds })
        }
        await this.checkpoint(intent, 'canonical-attached')
        this.options.index.runInTransaction(() => this.options.index.project(record!))
        await this.checkpoint(intent, 'indexed')
        await this.audit(ctx, record.id, 'store', 'success')
        await this.checkpoint(intent, 'audited')
        await this.options.journal.clear()
        return record
      } catch (error) {
        let compensationFailed = false
        try {
          intent.audit.outcome = 'failure'
          intent.stage = 'intent'
          await this.options.journal.checkpoint(intent)
        } catch {
          throw this.failure('store', error, true)
        }
        try { this.options.index.runInTransaction(() => this.options.index.remove(memoryId)) }
        catch { compensationFailed = true }
        try { await this.rollbackStoredRecord(memoryId) }
        catch { compensationFailed = true }
        try {
          await this.audit(ctx, memoryId, 'store', 'failure')
          if (!compensationFailed) {
            await this.checkpoint(intent, 'audited')
            await this.options.journal.clear()
          }
        } catch {
          compensationFailed = true
        }
        throw this.failure('store', error, compensationFailed)
      }
    })
  }

  async search(ctx: CapabilityCallContext, query: MemorySearchQuery): Promise<MemorySearchResult[]> {
    requireAgent(ctx)
    const validated = requireSearchQuery(query)
    if (query.includeSensitive) requireIntent(ctx, 'reveal-sensitive')
    await this.ready('search')
    try {
      const hits = this.options.index.search({
        text: validated.text,
        ...(query.kinds === undefined ? {} : { kinds: query.kinds }),
        includePrivate: query.includeSensitive === true,
        includeSensitive: query.includeSensitive === true,
        limit: MAX_SEARCH_LIMIT,
      })
      const hitById = new Map(hits.map((hit) => [hit.id, hit]))
      for (const record of await this.options.records.list()) {
        const tier = memorySearchExactTier(validated.text, record)
        if (tier === 0 || record.deletedAt !== undefined || hitById.has(record.id)) continue
        hitById.set(record.id, {
          id: record.id,
          kind: record.kind,
          title: record.title,
          tags: [...record.tags],
          ...(record.scope === undefined ? {} : { scope: { ...record.scope } }),
          sensitivity: record.sensitivity,
          updatedAt: record.updatedAt,
          exactTitle: tier === 2,
          lexicalRank: 0,
        })
      }
      const candidates = []
      for (const hit of hitById.values()) {
        try {
          const record = await this.options.records.read(hit.id)
          if (record.deletedAt !== undefined) continue
          if (!query.includeSensitive && record.sensitivity !== 'normal') continue
          if (query.kinds?.length && !query.kinds.includes(record.kind)) continue
          candidates.push({ hit, record })
        } catch (error) {
          if (!isNotFound(error)) throw error
          // Only a typed missing canonical row can be treated as stale projection state.
        }
      }
      const results = rankMemorySearch({ ...query, limit: validated.limit }, candidates, ctx.now)
      for (const result of results) await this.audit(ctx, result.id, 'search', 'success')
      return results
    } catch (error) {
      try { await this.audit(ctx, UNASSIGNED_MEMORY_ID, 'search', 'failure') } catch (auditError) {
        throw this.failure('search', auditError)
      }
      throw this.failure('search', error)
    }
  }

  async get(
    ctx: CapabilityCallContext,
    id: string,
    options: MemoryGetOptions = {},
  ): Promise<MemoryRecordView> {
    requireAgent(ctx)
    requireGetOptions(options)
    await this.ready('get')
    try {
      let record: MemoryRecord
      try {
        record = await this.options.records.read(id)
      } catch (error) {
        if (!options.includeDeleted || !isNotFound(error)) throw error
        const deleted = await this.options.records.readTrash(id)
        record = { ...deleted, deletedAt: deleted.deletedAt ?? deleted.updatedAt }
      }
      if (options.includeAttachments && record.deletedAt !== undefined) {
        throw new MemoryServiceError('not-found', 'Memory record was not found')
      }
      if ((options.includeContent || options.includeAttachments) && record.sensitivity === 'sensitive') {
        requireIntent(ctx, 'reveal-sensitive')
      }
      const result = view(record, options)
      await this.audit(ctx, id, 'get', 'success')
      return result
    } catch (error) {
      try { await this.audit(ctx, id, 'get', 'failure') } catch (auditError) {
        throw this.failure('get', auditError)
      }
      if (error instanceof MemoryServiceError) throw error
      throw this.failure('get', error)
    }
  }

  async update(
    ctx: CapabilityCallContext,
    id: string,
    patch: MemoryRecordPatch,
  ): Promise<MemoryRecord> {
    requireIntent(ctx, 'update')
    requireUpdatePatch(patch)
    await this.ready('update')
    return this.enqueueMutation(async () => {
      let prior: MemoryRecord | undefined
      let changed = false
      try {
        prior = await this.options.records.read(id)
        const updated = await this.options.records.update(id, patch)
        changed = true
        this.options.index.runInTransaction(() => this.options.index.project(updated))
        await this.audit(ctx, id, 'update', 'success')
        return updated
      } catch (error) {
        let compensationFailed = false
        if (prior && changed) {
          try {
            await this.options.records.update(id, rollbackPatch(prior))
            this.options.index.rebuild(await this.options.records.list())
          } catch {
            compensationFailed = true
          }
        }
        try { await this.audit(ctx, id, 'update', 'failure') } catch { compensationFailed = true }
        throw this.failure('update', error, compensationFailed)
      }
    })
  }

  async forget(ctx: CapabilityCallContext, id: string): Promise<void> {
    requireIntent(ctx, 'forget')
    await this.ready('forget')
    return this.enqueueMutation(async () => {
      const intent = this.mutationIntent(ctx, id, 'forget')
      let prior: MemoryRecord | undefined
      let journalStarted = false
      try {
        prior = await this.options.records.read(id)
        await this.options.journal.begin(intent)
        journalStarted = true
        await this.options.records.forget(id)
        await this.checkpoint(intent, 'canonical')
        await this.options.attachments.trashRecord(id)
        await this.checkpoint(intent, 'attachments')
        this.options.index.runInTransaction(() => this.options.index.setDeleted(id, ctx.now))
        await this.checkpoint(intent, 'indexed')
        await this.audit(ctx, id, 'forget', 'success')
        await this.checkpoint(intent, 'audited')
        await this.options.journal.clear()
      } catch (error) {
        let compensationFailed = false
        if (journalStarted) {
          try {
            intent.audit.outcome = 'failure'
            intent.stage = 'intent'
            await this.options.journal.checkpoint(intent)
          } catch {
            throw this.failure('forget', error, true)
          }
        }
        if (journalStarted) {
          try { await this.rollbackForget(id) }
          catch { compensationFailed = true }
        }
        if (prior) {
          try { this.options.index.runInTransaction(() => this.options.index.project(prior!)) }
          catch { /* the original index failure remains authoritative */ }
        }
        try {
          await this.audit(ctx, id, 'forget', 'failure')
          if (journalStarted && !compensationFailed) {
            await this.checkpoint(intent, 'audited')
            await this.options.journal.clear()
          }
        } catch {
          compensationFailed = true
        }
        throw this.failure('forget', error, compensationFailed)
      }
    })
  }

  async restore(ctx: CapabilityCallContext, id: string): Promise<void> {
    requireIntent(ctx, 'restore')
    await this.ready('restore')
    return this.enqueueMutation(async () => {
      const intent = this.mutationIntent(ctx, id, 'restore')
      let journalStarted = false
      try {
        await this.options.records.readTrash(id)
        await this.options.journal.begin(intent)
        journalStarted = true
        await this.options.records.restore(id)
        await this.checkpoint(intent, 'canonical')
        await this.options.attachments.restoreRecord(id)
        await this.checkpoint(intent, 'attachments')
        this.options.index.runInTransaction(() => this.options.index.setDeleted(id, null))
        await this.checkpoint(intent, 'indexed')
        await this.audit(ctx, id, 'restore', 'success')
        await this.checkpoint(intent, 'audited')
        await this.options.journal.clear()
      } catch (error) {
        let compensationFailed = false
        if (journalStarted) {
          try {
            intent.audit.outcome = 'failure'
            intent.stage = 'intent'
            await this.options.journal.checkpoint(intent)
          } catch {
            throw this.failure('restore', error, true)
          }
        }
        if (journalStarted) {
          try { await this.rollbackRestore(id) }
          catch { compensationFailed = true }
        }
        try {
          await this.audit(ctx, id, 'restore', 'failure')
          if (journalStarted && !compensationFailed) {
            await this.checkpoint(intent, 'audited')
            await this.options.journal.clear()
          }
        } catch {
          compensationFailed = true
        }
        throw this.failure('restore', error, compensationFailed)
      }
    })
  }

  async openAttachment(ctx: CapabilityCallContext, id: string): Promise<DeliveryHandle> {
    requireActiveInteraction(ctx)
    await this.ready('open attachment')
    return this.enqueueMutation(async () => {
      let memoryId = UNASSIGNED_MEMORY_ID
      try {
        const owner = (await this.options.records.list())
          .filter((record) => record.deletedAt === undefined && record.attachments.includes(id))
          .sort((left, right) => left.id === right.id ? 0 : left.id < right.id ? -1 : 1)[0]
        if (!owner) throw new MemoryServiceError('not-found', 'Memory record was not found')
        memoryId = owner.id
        if (owner.sensitivity === 'sensitive') requireIntent(ctx, 'reveal-sensitive')
        const handle = await this.options.attachments.open(ctx.principal, id)
        await this.audit(ctx, memoryId, 'open-attachment', 'success')
        return handle
      } catch (error) {
        try { await this.audit(ctx, memoryId, 'open-attachment', 'failure') } catch (auditError) {
          throw this.failure('open attachment', auditError)
        }
        throw this.failure('open attachment', error)
      }
    })
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation)
    this.mutationQueue = result.then(() => {}, () => {})
    return result
  }

  private async ready(operation: string): Promise<void> {
    try {
      await this.initialization
    } catch (error) {
      throw this.failure(operation, error)
    }
  }

  private async audit(
    ctx: CapabilityCallContext,
    memoryId: string,
    operation: MemoryAuditOperation,
    outcome: MemoryAuditInput['outcome'],
  ): Promise<void> {
    await this.options.audit.write({ principal: ctx.principal, memoryId, operation, at: ctx.now, outcome })
  }

  private mutationIntent(
    ctx: CapabilityCallContext,
    memoryId: string,
    operation: MemoryMutationIntent['operation'],
  ): MemoryMutationIntent {
    try {
      return {
        format: 'unmute-memory-mutation',
        version: 1,
        operation,
        memoryId,
        stage: 'intent',
        audit: memoryAuditRow({
          principal: ctx.principal,
          memoryId,
          operation,
          at: ctx.now,
          outcome: 'success',
        }),
      }
    } catch (error) {
      throw this.failure(operation, error)
    }
  }

  private async checkpoint(
    intent: MemoryMutationIntent,
    stage: MemoryMutationIntent['stage'],
  ): Promise<void> {
    intent.stage = stage
    await this.options.journal.checkpoint(intent)
  }

  private async recover(intent: MemoryMutationIntent): Promise<void> {
    if (intent.stage === 'audited') {
      await this.options.journal.clear()
      return
    }
    if (intent.operation === 'store') {
      await this.rollbackStoredRecord(intent.memoryId)
      intent.audit.outcome = 'failure'
    } else if (intent.operation === 'forget') {
      if (intent.audit.outcome === 'success') await this.completeForget(intent.memoryId)
      else await this.rollbackForget(intent.memoryId)
    } else if (intent.audit.outcome === 'success') {
      await this.completeRestore(intent.memoryId)
    } else {
      await this.rollbackRestore(intent.memoryId)
    }
    await this.options.audit.writeRow(intent.audit)
    await this.checkpoint(intent, 'audited')
    await this.options.journal.clear()
  }

  private async rollbackStoredRecord(id: string): Promise<void> {
    let active: MemoryRecord | undefined
    try {
      active = await this.options.records.read(id)
    } catch (error) {
      if (!isNotFound(error)) throw error
      try {
        const trashed = await this.options.records.readTrash(id)
        await this.options.records.restore(id)
        active = trashed
      } catch (trashError) {
        if (!isNotFound(trashError)) throw trashError
      }
    }
    if (active?.attachments.length) {
      await this.options.records.update(id, { attachments: [] })
    }
    await this.options.attachments.purgeRecord(id)
    if (active) await this.options.records.forget(id)
  }

  private async completeForget(id: string): Promise<void> {
    try {
      await this.options.records.readTrash(id)
    } catch (error) {
      if (!isNotFound(error)) throw error
      await this.options.records.forget(id)
    }
    await this.options.attachments.trashRecord(id)
  }

  private async rollbackForget(id: string): Promise<void> {
    try {
      await this.options.records.read(id)
    } catch (error) {
      if (!isNotFound(error)) throw error
      await this.options.records.restore(id)
    }
    await this.options.attachments.restoreRecord(id)
  }

  private async completeRestore(id: string): Promise<void> {
    try {
      await this.options.records.read(id)
    } catch (error) {
      if (!isNotFound(error)) throw error
      await this.options.records.restore(id)
    }
    await this.options.attachments.restoreRecord(id)
  }

  private async rollbackRestore(id: string): Promise<void> {
    try {
      await this.options.records.readTrash(id)
    } catch (error) {
      if (!isNotFound(error)) throw error
      await this.options.records.forget(id)
    }
    await this.options.attachments.trashRecord(id)
  }

  private failure(operation: string, error: unknown, compensationFailed = false): MemoryServiceError {
    if (error instanceof MemoryServiceError) return error
    const code = dependencyCode(error)
    if (code === 'not-found') {
      return new MemoryServiceError('not-found', 'Memory record was not found')
    }
    if (code === 'invalid-input' || code === 'invalid-query') {
      return new MemoryServiceError('invalid-input', `Memory ${operation} input is invalid`)
    }
    return new MemoryServiceError(
      compensationFailed ? 'compensation-failed' : 'operation-failed',
      compensationFailed
        ? `Memory ${operation} failed and recovery is incomplete`
        : `Memory ${operation} failed`,
    )
  }
}
