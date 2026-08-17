import type { CapabilityCallContext, McpPrincipal } from '../types'
import type {
  AttachmentDescriptor,
  OpenAttachmentHandle,
  StoreAttachmentInput,
} from './attachments'
import type { MemoryAuditInput, MemoryAuditOperation, MemoryAuditSink } from './audit'
import type { MemoryIndex } from './index'
import { rankMemorySearch, type MemorySearchQuery, type MemorySearchResult } from './search'
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
  create(input: CreateMemoryRecordInput): Promise<MemoryRecord>
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

  constructor(private readonly options: MemoryServiceOptions) {
    this.initialization = this.enqueueMutation(async () => {
      await Promise.all([options.records.initialize(), options.attachments.initialize()])
      const canonical = await options.records.list()
      options.index.rebuild(canonical)
    })
  }

  async store(ctx: CapabilityCallContext, input: MemoryStoreInput): Promise<MemoryRecord> {
    requireIntent(ctx, 'store')
    await this.ready('store')
    return this.enqueueMutation(async () => {
      let record: MemoryRecord | undefined
      let attachmentAttempted = false
      try {
        const handles = [...(input.attachments ?? [])]
        record = await this.options.records.create({ ...input, attachments: [] })
        const attachmentIds: string[] = []
        for (const handle of handles) {
          attachmentAttempted = true
          const attachment = await this.options.attachments.store(ctx.principal, {
            recordId: record.id,
            handle,
          })
          attachmentIds.push(attachment.id)
        }
        if (attachmentIds.length > 0) {
          record = await this.options.records.update(record.id, { attachments: attachmentIds })
        }
        this.options.index.runInTransaction(() => this.options.index.project(record!))
        await this.audit(ctx, record.id, 'store', 'success')
        return record
      } catch (error) {
        const memoryId = record?.id ?? UNASSIGNED_MEMORY_ID
        let compensationFailed = false
        if (record) {
          try { this.options.index.runInTransaction(() => this.options.index.remove(record!.id)) }
          catch { compensationFailed = true }
          if (attachmentAttempted) {
            let detached = record.attachments.length === 0
            if (!detached) {
              try {
                record = await this.options.records.update(record.id, { attachments: [] })
                detached = true
              } catch {
                compensationFailed = true
              }
            }
            if (detached) {
              try { await this.options.attachments.purgeRecord(record.id) }
              catch { compensationFailed = true }
            } else {
              try { await this.options.attachments.trashRecord(record.id) }
              catch { compensationFailed = true }
            }
          }
          try { await this.options.records.forget(record.id) }
          catch { compensationFailed = true }
        }
        await this.audit(ctx, memoryId, 'store', 'failure')
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
      const candidates = []
      for (const hit of hits) {
        try {
          const record = await this.options.records.read(hit.id)
          if (record.deletedAt !== undefined) continue
          if (!query.includeSensitive && record.sensitivity !== 'normal') continue
          if (query.kinds?.length && !query.kinds.includes(record.kind)) continue
          candidates.push({ hit, record })
        } catch {
          // A stale projection row is not evidence. Startup/recovery rebuild removes it.
        }
      }
      const results = rankMemorySearch({ ...query, limit: validated.limit }, candidates, ctx.now)
      for (const result of results) await this.audit(ctx, result.id, 'search', 'success')
      return results
    } catch (error) {
      await this.audit(ctx, UNASSIGNED_MEMORY_ID, 'search', 'failure')
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
        if (!options.includeDeleted) throw error
        const deleted = await this.options.records.readTrash(id)
        record = { ...deleted, deletedAt: deleted.deletedAt ?? deleted.updatedAt }
      }
      if (options.includeContent && record.sensitivity === 'sensitive') {
        requireIntent(ctx, 'reveal-sensitive')
      }
      const result = view(record, options)
      await this.audit(ctx, id, 'get', 'success')
      return result
    } catch (error) {
      await this.audit(ctx, id, 'get', 'failure')
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
        await this.audit(ctx, id, 'update', 'failure')
        throw this.failure('update', error, compensationFailed)
      }
    })
  }

  async forget(ctx: CapabilityCallContext, id: string): Promise<void> {
    requireIntent(ctx, 'forget')
    await this.ready('forget')
    return this.enqueueMutation(async () => {
      let prior: MemoryRecord | undefined
      let canonicalMoved = false
      let attachmentAttempted = false
      try {
        prior = await this.options.records.read(id)
        await this.options.records.forget(id)
        canonicalMoved = true
        attachmentAttempted = true
        await this.options.attachments.trashRecord(id)
        this.options.index.runInTransaction(() => this.options.index.setDeleted(id, ctx.now))
        await this.audit(ctx, id, 'forget', 'success')
      } catch (error) {
        let compensationFailed = false
        if (attachmentAttempted) {
          try { await this.options.attachments.restoreRecord(id) }
          catch { compensationFailed = true }
        }
        if (canonicalMoved) {
          try { await this.options.records.restore(id) }
          catch { compensationFailed = true }
        }
        if (prior) {
          try { this.options.index.runInTransaction(() => this.options.index.project(prior!)) }
          catch { /* the original index failure remains authoritative */ }
        }
        await this.audit(ctx, id, 'forget', 'failure')
        throw this.failure('forget', error, compensationFailed)
      }
    })
  }

  async restore(ctx: CapabilityCallContext, id: string): Promise<void> {
    requireIntent(ctx, 'restore')
    await this.ready('restore')
    return this.enqueueMutation(async () => {
      let canonicalMoved = false
      let attachmentAttempted = false
      try {
        await this.options.records.readTrash(id)
        await this.options.records.restore(id)
        canonicalMoved = true
        attachmentAttempted = true
        await this.options.attachments.restoreRecord(id)
        this.options.index.runInTransaction(() => this.options.index.setDeleted(id, null))
        await this.audit(ctx, id, 'restore', 'success')
      } catch (error) {
        let compensationFailed = false
        if (attachmentAttempted) {
          try { await this.options.attachments.trashRecord(id) }
          catch { compensationFailed = true }
        }
        if (canonicalMoved) {
          try { await this.options.records.forget(id) }
          catch { compensationFailed = true }
        }
        await this.audit(ctx, id, 'restore', 'failure')
        throw this.failure('restore', error, compensationFailed)
      }
    })
  }

  async openAttachment(ctx: CapabilityCallContext, id: string): Promise<DeliveryHandle> {
    requireActiveInteraction(ctx)
    await this.ready('open attachment')
    return this.enqueueMutation(async () => {
      try {
        const handle = await this.options.attachments.open(ctx.principal, id)
        await this.audit(ctx, id, 'open-attachment', 'success')
        return handle
      } catch (error) {
        await this.audit(ctx, id, 'open-attachment', 'failure')
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
    try {
      await this.options.audit.write({ principal: ctx.principal, memoryId, operation, at: ctx.now, outcome })
    } catch {
      // Audit storage never changes an already-authoritative memory outcome.
    }
  }

  private failure(operation: string, error: unknown, compensationFailed = false): MemoryServiceError {
    if (error instanceof MemoryServiceError) return error
    const dependencyCode = error && typeof error === 'object' && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined
    if (dependencyCode === 'not-found') {
      return new MemoryServiceError('not-found', 'Memory record was not found')
    }
    if (dependencyCode === 'invalid-input' || dependencyCode === 'invalid-query') {
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
