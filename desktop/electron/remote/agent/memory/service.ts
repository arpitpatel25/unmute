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
import { buildMemoryMap, listGroupMembers, listUngrouped, type MemoryMap, type MemoryMapEntry } from './map'
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
const SEARCH_QUERY_KEYS = new Set(['text', 'kinds', 'tags', 'scope', 'limit'])
const GET_OPTION_KEYS = new Set(['includeContent', 'includeAttachments', 'includeDeleted'])
/**
 * EVERY FIELD A RECORD HAS, BECAUSE THIS SET IS A GATE AND NOT A DESCRIPTION.
 *
 * `summary` and `links` were missing while the capability schema advertised
 * both and record-store applied both — so a gate in the middle refused what
 * either end was happy with, and mcp__unmute__memory_update could NEVER change
 * a summary, at any length. On 2026-09-07 the Agent spent eleven failed calls
 * shortening one from 661 characters to 94 chasing an error that had nothing
 * to do with length, because the refusal said only "Memory update input is
 * invalid".
 *
 * Keep it in step with MemoryRecordPatch: a key that record-store applies and
 * this set omits is silently unwritable.
 */
const UPDATE_PATCH_KEYS = new Set([
  'kind', 'title', 'summary', 'content', 'links', 'tags', 'scope', 'references', 'provenance',
])


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
  /**
   * Turns a path the user designated into an attachment handle. Supplied by the
   * app because minting a handle is the app's job; absent, memory_keep_file
   * simply reports that keeping a file is unavailable.
   */
  keepFile?: (
    principal: CapabilityCallContext['principal'],
    input: { path: string; name?: string },
  ) => Promise<string>
}

export type MemoryServiceErrorCode =
  | 'access-denied'
  | 'intent-required'
  | 'invalid-input'
  | 'not-found'
  | 'keychain-unavailable'
  | 'index-unavailable'
  | 'storage-full'
  | 'attachment-copy-failed'
  | 'recovery-failed'
  | 'service-unavailable'
  | 'operation-failed'
  | 'compensation-failed'

export interface MemoryListOptions {
  /** Enumerate this group's members instead of the whole map. */
  group?: string
  /** Enumerate what no group links to. Ignored when `group` is given. */
  ungrouped?: boolean
}

export type MemoryListResult =
  | { map: MemoryMap; entries?: undefined }
  | { entries: MemoryMapEntry[]; map?: undefined }

export interface MemoryLinkInput {
  /** The record joining the group. */
  id: string
  /** The group record it joins. */
  group: string
  /** Zero-based position; appended when absent. */
  position?: number
}

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


function requireSearchQuery(query: MemorySearchQuery): Required<Pick<MemorySearchQuery, 'text' | 'limit'>> {
  const limit = query?.limit ?? DEFAULT_SEARCH_LIMIT
  if (
    !query || typeof query !== 'object' || Array.isArray(query)
    || Object.keys(query).some((key) => !SEARCH_QUERY_KEYS.has(key))
    || typeof query.text !== 'string' || query.text.trim().length === 0
    || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SEARCH_LIMIT
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
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).length === 0) {
    throw new MemoryServiceError('invalid-input', 'Memory update input is invalid')
  }
  // Name the key. The unnamed version of this refusal cost eleven calls,
  // because "invalid" with no field reads as "too long" to anyone holding a
  // long string, and shortening it can never work.
  const unknown = Object.keys(patch).filter((key) => !UPDATE_PATCH_KEYS.has(key))
  if (unknown.length) {
    throw new MemoryServiceError('invalid-input', `Memory update does not accept: ${unknown.sort().join(', ')}`)
  }
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
    ...(presented.summary === undefined ? {} : { summary: presented.summary }),
    tags: [...presented.tags],
    links: [...presented.links],
    ...(presented.scope === undefined ? {} : { scope: { ...presented.scope } }),
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
      await this.rebuildIndex(canonical)
    })
  }

  /** Readiness probe for production wiring; performs no search or audit. */
  async initialize(): Promise<void> {
    await this.ready('initialize')
  }

  async store(ctx: CapabilityCallContext, input: MemoryStoreInput): Promise<MemoryRecord> {
    requireActiveInteraction(ctx)
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
        await this.updateIndex(() => this.options.index.project(record!))
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
    await this.ready('search')
    try {
      const indexQuery = {
        text: validated.text,
        ...(query.kinds === undefined ? {} : { kinds: query.kinds }),
        limit: MAX_SEARCH_LIMIT,
      }
      let hits: ReturnType<MemoryIndex['search']>
      try {
        hits = this.options.index.search(indexQuery)
      } catch (error) {
        if (!isIndexFailure(error)) throw error
        await this.rebuildIndex(await this.options.records.list())
        hits = this.options.index.search(indexQuery)
      }
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
          if (query.kinds?.length && !query.kinds.includes(record.kind)) continue
          candidates.push({ hit, record })
        } catch (error) {
          if (!isNotFound(error)) throw error
          // Only a typed missing canonical row can be treated as stale projection state.
        }
      }
      const results = rankMemorySearch({ ...query, limit: validated.limit }, candidates, ctx.now)
      // ONE ROW FOR THE QUERY, not one per hit. Auditing per result meant a
      // search that matched nothing wrote nothing at all, so "looked and found
      // nothing" and "never looked" were the same in the log — and the one
      // time it mattered, the Agent claimed the store was empty and the log
      // could neither confirm nor contradict it.
      await this.audit(ctx, results[0]?.id ?? UNASSIGNED_MEMORY_ID, 'search', 'success')
      return results
    } catch (error) {
      try { await this.audit(ctx, UNASSIGNED_MEMORY_ID, 'search', 'failure') } catch (auditError) {
        throw this.failure('search', auditError)
      }
      throw this.failure('search', error)
    }
  }

  /**
   * What the store contains — the map when no group is named, one group's
   * members when it is.
   *
   * READ FROM THE FILES, NOT THE INDEX. The files are the record; the index is
   * a projection that can fall behind them. Enumeration is the one operation
   * where being right matters more than being fast, because its whole purpose
   * is to answer "is there anything here at all" — the question the Agent
   * previously had no tool for and answered wrongly.
   *
   * The cost is decrypting every record. At the scale a person accumulates by
   * speaking, that is nothing; past a few thousand it wants a cache.
   */
  async list(ctx: CapabilityCallContext, options: MemoryListOptions = {}): Promise<MemoryListResult> {
    requireAgent(ctx)
    await this.ready('list')
    try {
      const records = await this.options.records.list()
      const result: MemoryListResult = options.group === undefined
        ? (options.ungrouped === true
          ? { entries: listUngrouped(records) }
          : { map: buildMemoryMap(records) })
        : { entries: listGroupMembers(records, options.group) }
      // Audited once for the call, not once per row: a listing is a single act
      // of looking, and rows-as-events would make an empty store unauditable.
      await this.audit(ctx, options.group ?? UNASSIGNED_MEMORY_ID, 'list', 'success')
      return result
    } catch (error) {
      try { await this.audit(ctx, options.group ?? UNASSIGNED_MEMORY_ID, 'list', 'failure') } catch (auditError) {
        throw this.failure('list', auditError)
      }
      throw this.failure('list', error)
    }
  }

  /**
   * Attach a record to a group, optionally at a position.
   *
   * LINKS, NEVER MOVES. The record stays wherever else it is already linked
   * from, which is the entire reason groups are records rather than folders.
   *
   * Position is honoured because a group may be a workflow: appending a step to
   * the end when the user said "second" would silently corrupt the meaning.
   */
  async link(ctx: CapabilityCallContext, input: MemoryLinkInput): Promise<MemoryRecord> {
    requireActiveInteraction(ctx)
    await this.ready('link')
    return this.enqueueMutation(async () => {
      try {
        const group = await this.options.records.read(input.group)
        if (group.kind !== 'group') {
          throw new MemoryServiceError('invalid-input', 'That memory is not a group')
        }
        // Reading the member proves it exists before the group claims it: a
        // group holding an id that was never there is a dangling link nothing
        // would ever repair.
        const member = await this.options.records.read(input.id)
        if (member.deletedAt !== undefined) {
          throw new MemoryServiceError('not-found', 'That memory is in the trash')
        }
        if (member.id === group.id) {
          throw new MemoryServiceError('invalid-input', 'A group cannot contain itself')
        }
        const links = group.links.filter((id) => id !== input.id)
        const at = input.position === undefined
          ? links.length
          : Math.max(0, Math.min(links.length, input.position))
        links.splice(at, 0, input.id)
        const updated = await this.options.records.update(group.id, { links })
        await this.updateIndex(() => this.options.index.project(updated))
        await this.audit(ctx, group.id, 'link', 'success')
        return updated
      } catch (error) {
        try { await this.audit(ctx, input.group, 'link', 'failure') } catch (auditError) {
          throw this.failure('link', auditError)
        }
        throw this.failure('link', error)
      }
    })
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
    requireActiveInteraction(ctx)
    requireUpdatePatch(patch)
    await this.ready('update')
    return this.enqueueMutation(async () => {
      let prior: MemoryRecord | undefined
      let changed = false
      try {
        prior = await this.options.records.read(id)
        const updated = await this.options.records.update(id, patch)
        changed = true
        await this.updateIndex(() => this.options.index.project(updated))
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
    requireActiveInteraction(ctx)
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
        await this.updateIndex(() => this.options.index.setDeleted(id, ctx.now))
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
    requireActiveInteraction(ctx)
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
        await this.updateIndex(() => this.options.index.setDeleted(id, null))
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

  /**
   * A file the user pointed at becomes an attachment handle.
   *
   * WHY THIS IS ALLOWED TO TAKE A PATH. The Agent already holds `Read` over the
   * whole disk, so any path it can name is a file it can already open — this
   * grants it nothing new. The boundary that matters is DELIVERY, where a
   * composed path could push a file out to another application, and that gate
   * lives in delivery.ts and is untouched.
   *
   * What is enforced here is what a prompt cannot be trusted to enforce: the
   * thing must exist, must be a regular file, and must be readable. A directory,
   * a device node or a broken symlink is refused rather than half-stored.
   */
  async keepFile(
    ctx: CapabilityCallContext,
    input: { path: string; name?: string },
  ): Promise<string> {
    requireActiveInteraction(ctx)
    await this.ready('keep file')
    if (!this.options.keepFile) {
      throw new MemoryServiceError('invalid-input', 'Keeping a file is unavailable')
    }
    try {
      const handle = await this.options.keepFile(ctx.principal, input)
      await this.audit(ctx, UNASSIGNED_MEMORY_ID, 'keep-file', 'success')
      return handle
    } catch (error) {
      try { await this.audit(ctx, UNASSIGNED_MEMORY_ID, 'keep-file', 'failure') } catch (auditError) {
        throw this.failure('keep file', auditError)
      }
      throw this.failure('keep file', error)
    }
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

  private async updateIndex(operation: () => void): Promise<void> {
    try {
      this.options.index.runInTransaction(operation)
    } catch (error) {
      if (!isIndexFailure(error)) throw error
      await this.rebuildIndex(await this.options.records.list())
    }
  }

  private async rebuildIndex(records: readonly MemoryRecord[]): Promise<void> {
    try {
      this.options.index.rebuild(records)
    } catch (error) {
      if (!isIndexFailure(error)) throw error
      try {
        this.options.index.rebuild(records)
      } catch {
        throw new MemoryServiceError(
          'index-unavailable',
          'Encrypted memory search is unavailable',
        )
      }
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
    try {
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
    } catch {
      throw new MemoryServiceError(
        'recovery-failed',
        'Memory recovery could not be completed',
      )
    }
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
    if (code === 'ENOSPC' || code === 'EDQUOT') {
      return new MemoryServiceError('storage-full', 'Encrypted memory storage is full')
    }
    if (isKeychainFailure(error)) {
      return new MemoryServiceError('keychain-unavailable', 'Secure memory key protection is unavailable')
    }
    if (isIndexFailure(error)) {
      return new MemoryServiceError('index-unavailable', 'Encrypted memory search is unavailable')
    }
    if (operation === 'store' && isAttachmentFailure(error)) {
      return new MemoryServiceError('attachment-copy-failed', 'Memory attachment copy failed')
    }
    if (code === 'invalid-journal' || code === 'pending-mutation') {
      return new MemoryServiceError('recovery-failed', 'Memory recovery could not be completed')
    }
    if (operation === 'initialize') {
      return new MemoryServiceError('service-unavailable', 'Encrypted memory storage is unavailable')
    }
    return new MemoryServiceError(
      compensationFailed ? 'compensation-failed' : 'operation-failed',
      compensationFailed
        ? `Memory ${operation} failed and recovery is incomplete`
        : `Memory ${operation} failed`,
    )
  }
}

function dependencyName(error: unknown): unknown {
  return error && typeof error === 'object' && 'name' in error
    ? (error as { name?: unknown }).name
    : undefined
}

function dependencyMessage(error: unknown): string {
  return error instanceof Error ? error.message : ''
}

function isIndexFailure(error: unknown): boolean {
  const code = dependencyCode(error)
  return dependencyName(error) === 'MemoryIndexError'
    || code === 'index-unavailable'
    || code === 'invalid-key'
    || code === 'native-unavailable'
    || code === 'cipher-unavailable'
    || code === 'open-failed'
}

function isAttachmentFailure(error: unknown): boolean {
  const code = dependencyCode(error)
  return dependencyName(error) === 'AttachmentStoreError'
    || code === 'corrupt-attachment'
    || code === 'durability-uncertain'
    || code === 'storage-failure'
}

function isKeychainFailure(error: unknown): boolean {
  const code = dependencyCode(error)
  if (code === 'keychain-unavailable') return true
  const message = dependencyMessage(error)
  return message === 'Secure key protection is unavailable'
    || message === 'Protected memory master key is invalid'
}
