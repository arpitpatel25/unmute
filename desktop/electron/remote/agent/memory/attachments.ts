import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  unlink,
  utimes,
  type FileHandle,
} from 'node:fs/promises'
import { basename, join } from 'node:path'

import type { McpPrincipal } from '../types.ts'
import { MemoryCrypto } from './crypto'

const DIRECTORY_MODE = 0o700
const FILE_MODE = 0o600
const DEFAULT_MAX_MANAGED_BYTES = 25 * 1024 * 1024
const DEFAULT_LOCK_TIMEOUT_MS = 2_000
const DEFAULT_STALE_LOCK_MS = 120_000
const DEFAULT_LOCK_RETRY_MS = 10
const ATTACHMENT_STREAM_HEADER = Buffer.concat([Buffer.from('UATT', 'ascii'), Buffer.from([1])])
const MAX_ENCRYPTED_FRAME_BYTES = 16 * 1024 * 1024
const DATA_FRAME = 0
const FINAL_FRAME = 1
const FRAME_PREFIX_BYTES = 5
const FINAL_FRAME_PREFIX_BYTES = 1 + 4 + 8 + 32 + 2
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/

type AgentPrincipal = Extract<McpPrincipal, { kind: 'unmute-agent' }>
type AttachmentStorage = 'managed-copy' | 'reference'

interface CaptureHandleValue {
  kind: 'capture'
  path: string
  name: string
  mimeType?: string
}

interface OpenHandleValue {
  kind: 'open'
  attachmentId: string
}

type HandleValue = CaptureHandleValue | OpenHandleValue

interface HandleEntry {
  runId: string
  interactionId: string
  expiresAt: number
  value: HandleValue
}

export interface InteractionAttachmentHandlesOptions {
  now?: () => number
  createHandle?: () => string
}

export interface CaptureAttachmentSource {
  path: string
  name?: string
  mimeType?: string
}

type AttachmentSourceFile = Pick<FileHandle, 'stat' | 'read' | 'close'>

export interface AttachmentSourceFileSystem {
  open(path: string, flags: number): Promise<AttachmentSourceFile>
}

export interface AttachmentLeaseHeartbeat {
  start(refresh: () => Promise<void>, intervalMs: number): () => Promise<void>
}

const nodeSourceFileSystem: AttachmentSourceFileSystem = {
  open: (path, flags) => open(path, flags),
}

const nodeLeaseHeartbeat: AttachmentLeaseHeartbeat = {
  start(refresh, intervalMs) {
    let pending = Promise.resolve()
    const timer = setInterval(() => {
      pending = pending.then(refresh).catch(() => { /* lease assertions surface the failure */ })
    }, intervalMs)
    timer.unref()
    return async () => {
      clearInterval(timer)
      await pending
    }
  },
}

function isSafeAttachmentName(name: unknown): name is string {
  return typeof name === 'string'
    && name.length > 0
    && name.length <= 255
    && name !== '.'
    && name !== '..'
    && !/[\\/\p{Cc}]/u.test(name)
    && !/^[A-Za-z]:/.test(name)
    && basename(name) === name
}

function requireAgentPrincipal(principal: McpPrincipal, now: number): AgentPrincipal {
  if (principal.kind !== 'unmute-agent' || principal.expiresAt <= now) {
    throw new AttachmentStoreError('invalid-handle', 'Attachment handle is invalid or expired')
  }
  return principal
}

/**
 * Host-owned interaction ledger. Its opaque values are the only accepted route
 * from captured filesystem inputs or managed attachments to Agent tools.
 */
export class InteractionAttachmentHandles {
  private readonly entries = new Map<string, HandleEntry>()
  private readonly now: () => number
  private readonly createHandle: () => string

  constructor(options: InteractionAttachmentHandlesOptions = {}) {
    this.now = options.now ?? Date.now
    this.createHandle = options.createHandle ?? randomUUID
  }

  mintCapture(
    principal: McpPrincipal,
    source: CaptureAttachmentSource,
    expiresAt?: number,
  ): string {
    const agent = requireAgentPrincipal(principal, this.now())
    const name = source?.name ?? (typeof source?.path === 'string' ? basename(source.path) : '')
    if (
      !source || typeof source !== 'object' || Array.isArray(source)
      || typeof source.path !== 'string' || source.path.length === 0
      || !isSafeAttachmentName(name)
      || (source.mimeType !== undefined && !isMimeType(source.mimeType))
    ) {
      throw new AttachmentStoreError('invalid-input', 'Capture attachment is invalid')
    }
    return this.mint(agent, {
      kind: 'capture',
      path: source.path,
      name,
      ...(source.mimeType === undefined ? {} : { mimeType: source.mimeType }),
    }, expiresAt)
  }

  mintOpen(principal: McpPrincipal, attachmentId: string, expiresAt?: number): string {
    const agent = requireAgentPrincipal(principal, this.now())
    requireIdentifier(attachmentId, 'attachment')
    return this.mint(agent, { kind: 'open', attachmentId }, expiresAt)
  }

  resolve(principal: McpPrincipal, handle: string, expectedKind: 'capture'): CaptureHandleValue
  resolve(principal: McpPrincipal, handle: string, expectedKind: 'open'): OpenHandleValue
  resolve(principal: McpPrincipal, handle: string, expectedKind: HandleValue['kind']): HandleValue {
    const now = this.now()
    const agent = requireAgentPrincipal(principal, now)
    const entry = typeof handle === 'string' ? this.entries.get(handle) : undefined
    if (
      !entry
      || entry.expiresAt <= now
      || entry.expiresAt > agent.expiresAt
      || entry.runId !== agent.runId
      || entry.interactionId !== agent.interactionId
      || entry.value.kind !== expectedKind
    ) {
      throw new AttachmentStoreError('invalid-handle', 'Attachment handle is invalid or expired')
    }
    return entry.value
  }

  revokeInteraction(principal: McpPrincipal): void {
    if (principal.kind !== 'unmute-agent') return
    for (const [handle, entry] of this.entries) {
      if (entry.runId === principal.runId && entry.interactionId === principal.interactionId) {
        this.entries.delete(handle)
      }
    }
  }

  private mint(agent: AgentPrincipal, value: HandleValue, requestedExpiry?: number): string {
    const now = this.now()
    const expiresAt = Math.min(requestedExpiry ?? agent.expiresAt, agent.expiresAt)
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) {
      throw new AttachmentStoreError('invalid-input', 'Attachment handle expiry is invalid')
    }
    let handle = this.createHandle()
    if (typeof handle !== 'string' || handle.length < 1 || this.entries.has(handle)) {
      throw new AttachmentStoreError('storage-failure', 'Attachment handle creation failed')
    }
    this.entries.set(handle, {
      runId: agent.runId,
      interactionId: agent.interactionId,
      expiresAt,
      value,
    })
    return handle
  }
}

export interface AttachmentDescriptor {
  id: string
  sha256: string
  name: string
  mimeType: string
  size: number
  storage: AttachmentStorage
  referenceReason?: 'large-file'
  liveReferenceCount: number
  trashReferenceCount: number
}

interface AttachmentMetadata {
  format: 'unmute-memory-attachment'
  version: 1
  id: string
  sha256: string
  name: string
  mimeType: string
  size: number
  storage: AttachmentStorage
  referenceReason?: 'large-file'
  sourcePath?: string
  liveRecordIds: string[]
  trashRecordIds: string[]
}

interface StagedSource {
  sha256: string
  size: number
  storage: AttachmentStorage
  referenceReason?: 'large-file'
  stagingPath?: string
  sequence: number
}

interface HashLease {
  token: string
  assertOwned(): Promise<void>
  commit<T>(publication: () => Promise<T>): Promise<T>
  release(): Promise<void>
}

export interface StoreAttachmentInput {
  recordId: string
  handle: string
  storage?: 'copy' | 'reference'
}

export interface OpenAttachmentHandle {
  handle: string
  expiresAt: number
}

export interface DeliveryAttachment {
  name: string
  mimeType: string
  size: number
  open(): AsyncIterable<Uint8Array>
}

export interface EncryptedAttachmentStoreOptions {
  root: string
  crypto: MemoryCrypto
  handles: InteractionAttachmentHandles
  maxManagedBytes?: number
  createAttachmentId?: () => string
  sourceFileSystem?: AttachmentSourceFileSystem
  lockTimeoutMs?: number
  staleLockMs?: number
  lockRetryMs?: number
  leaseHeartbeat?: AttachmentLeaseHeartbeat
  directorySync?: (path: string) => Promise<void>
}

export type AttachmentStoreErrorCode =
  | 'invalid-input'
  | 'invalid-handle'
  | 'not-found'
  | 'not-managed'
  | 'corrupt-attachment'
  | 'durability-uncertain'
  | 'storage-failure'

export class AttachmentStoreError extends Error {
  readonly code: AttachmentStoreErrorCode

  constructor(code: AttachmentStoreErrorCode, message: string) {
    super(message)
    this.name = 'AttachmentStoreError'
    this.code = code
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

function requireIdentifier(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    throw new AttachmentStoreError('invalid-input', `${field} identifier is invalid`)
  }
}

function isMimeType(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(value)
}

function inferMimeType(name: string): string {
  const extension = name.slice(name.lastIndexOf('.')).toLowerCase()
  const known: Record<string, string> = {
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.json': 'application/json',
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.mov': 'video/quicktime',
    '.mp4': 'video/mp4',
  }
  return known[extension] ?? 'application/octet-stream'
}

function descriptor(metadata: AttachmentMetadata): AttachmentDescriptor {
  return {
    id: metadata.id,
    sha256: metadata.sha256,
    name: metadata.name,
    mimeType: metadata.mimeType,
    size: metadata.size,
    storage: metadata.storage,
    ...(metadata.referenceReason === undefined ? {} : { referenceReason: metadata.referenceReason }),
    liveReferenceCount: metadata.liveRecordIds.length,
    trashReferenceCount: metadata.trashRecordIds.length,
  }
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort()
}

function validateMetadata(value: unknown, expectedHash: string): AttachmentMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AttachmentStoreError('corrupt-attachment', 'Encrypted attachment metadata is invalid')
  }
  const metadata = value as Partial<AttachmentMetadata>
  if (
    metadata.format !== 'unmute-memory-attachment'
    || metadata.version !== 1
    || typeof metadata.id !== 'string' || !IDENTIFIER_PATTERN.test(metadata.id)
    || metadata.sha256 !== expectedHash || !SHA256_PATTERN.test(expectedHash)
    || !isSafeAttachmentName(metadata.name)
    || !isMimeType(metadata.mimeType)
    || !Number.isSafeInteger(metadata.size) || Number(metadata.size) < 0
    || (metadata.storage !== 'managed-copy' && metadata.storage !== 'reference')
    || (metadata.referenceReason !== undefined && metadata.referenceReason !== 'large-file')
    || !Array.isArray(metadata.liveRecordIds)
    || metadata.liveRecordIds.some((id) => typeof id !== 'string' || !IDENTIFIER_PATTERN.test(id))
    || new Set(metadata.liveRecordIds).size !== metadata.liveRecordIds.length
    || !Array.isArray(metadata.trashRecordIds)
    || metadata.trashRecordIds.some((id) => typeof id !== 'string' || !IDENTIFIER_PATTERN.test(id))
    || new Set(metadata.trashRecordIds).size !== metadata.trashRecordIds.length
    || metadata.liveRecordIds.some((id) => metadata.trashRecordIds?.includes(id))
    || (metadata.sourcePath !== undefined && typeof metadata.sourcePath !== 'string')
  ) {
    throw new AttachmentStoreError('corrupt-attachment', 'Encrypted attachment metadata is invalid')
  }
  return metadata as AttachmentMetadata
}

type PublicOperation = 'initialize' | 'copy' | 'read' | 'open' | 'trash' | 'restore' | 'purge'

export class EncryptedAttachmentStore {
  private readonly attachmentsDir: string
  private readonly stagingDir: string
  private readonly locksDir: string
  private readonly quarantineDir: string
  private readonly crypto: MemoryCrypto
  private readonly handles: InteractionAttachmentHandles
  private readonly maxManagedBytes: number
  private readonly createAttachmentId: () => string
  private readonly sourceFileSystem: AttachmentSourceFileSystem
  private readonly lockTimeoutMs: number
  private readonly staleLockMs: number
  private readonly lockRetryMs: number
  private readonly leaseHeartbeat: AttachmentLeaseHeartbeat
  private readonly directorySync: (path: string) => Promise<void>
  private initialization: Promise<void> | null = null
  private mutationQueue: Promise<void> = Promise.resolve()

  constructor(options: EncryptedAttachmentStoreOptions) {
    if (!Number.isSafeInteger(options.maxManagedBytes ?? DEFAULT_MAX_MANAGED_BYTES)
      || (options.maxManagedBytes ?? DEFAULT_MAX_MANAGED_BYTES) < 0) {
      throw new AttachmentStoreError('invalid-input', 'Managed attachment size limit is invalid')
    }
    for (const [value, field, minimum] of [
      [options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS, 'timeout', 0],
      [options.staleLockMs ?? DEFAULT_STALE_LOCK_MS, 'stale lifetime', 1],
      [options.lockRetryMs ?? DEFAULT_LOCK_RETRY_MS, 'retry interval', 1],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < minimum) {
        throw new AttachmentStoreError('invalid-input', `Attachment lock ${field} is invalid`)
      }
    }
    this.attachmentsDir = join(options.root, 'attachments')
    this.stagingDir = join(this.attachmentsDir, '.staging')
    this.locksDir = join(this.attachmentsDir, '.locks')
    this.quarantineDir = join(this.attachmentsDir, '.quarantine')
    this.crypto = options.crypto
    this.handles = options.handles
    this.maxManagedBytes = options.maxManagedBytes ?? DEFAULT_MAX_MANAGED_BYTES
    this.createAttachmentId = options.createAttachmentId ?? (() => `attachment-${randomUUID()}`)
    this.sourceFileSystem = options.sourceFileSystem ?? nodeSourceFileSystem
    this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS
    this.staleLockMs = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS
    this.lockRetryMs = options.lockRetryMs ?? DEFAULT_LOCK_RETRY_MS
    this.leaseHeartbeat = options.leaseHeartbeat ?? nodeLeaseHeartbeat
    this.directorySync = options.directorySync ?? fsyncDirectory
  }

  initialize(): Promise<void> {
    this.initialization ??= this.runPublic('initialize', async () => {
      await Promise.all([
        mkdir(this.stagingDir, { recursive: true, mode: DIRECTORY_MODE }),
        mkdir(this.locksDir, { recursive: true, mode: DIRECTORY_MODE }),
        mkdir(this.quarantineDir, { recursive: true, mode: DIRECTORY_MODE }),
      ])
      await this.directorySync(this.attachmentsDir)
      await this.recoverHashDirectories()
    })
    return this.initialization
  }

  async store(principal: McpPrincipal, input: StoreAttachmentInput): Promise<AttachmentDescriptor> {
    return this.runPublic('copy', async () => {
      validateStoreInput(input)
      const source = this.handles.resolve(principal, input.handle, 'capture')
      return this.mutate(async () => {
        await this.initialize()
        const sourceFile = await this.sourceFileSystem.open(
          source.path,
          constants.O_RDONLY | constants.O_NOFOLLOW,
        )
        let staged: StagedSource
        try {
          const sourceStat = await sourceFile.stat()
          if (!sourceStat.isFile()) {
            throw new AttachmentStoreError('invalid-input', 'Attachment source must be a regular file')
          }
          const defaultReference = input.storage === undefined && sourceStat.size > this.maxManagedBytes
          const copy = input.storage === 'copy' || (input.storage === undefined && !defaultReference)
          staged = await this.readSource(sourceFile, {
            copy,
            enforceCopyLimit: input.storage === undefined && copy ? this.maxManagedBytes : undefined,
            referenceReason: defaultReference ? 'large-file' : undefined,
          })
        } finally {
          await sourceFile.close()
        }

        try {
          return await this.withHashLock(staged.sha256, async (lease) => {
            if (staged.stagingPath) await this.adoptStagedPayload(staged, lease)
            const existing = await this.loadMetadataForMutation(staged.sha256, lease)
            const attachmentDir = join(this.attachmentsDir, staged.sha256)
            if (!existing) {
              await mkdir(attachmentDir, { recursive: true, mode: DIRECTORY_MODE })
              await this.directorySync(this.attachmentsDir)
            }
            const attachmentId = existing?.id ?? this.newAttachmentId()
            const originalPath = join(attachmentDir, 'original.enc')
            let publishedPayload = false
            try {
              if (staged.storage === 'managed-copy' && existing?.storage !== 'managed-copy') {
                if (!staged.stagingPath) throw new Error('Managed attachment staging is missing')
                await lease.assertOwned()
                await this.finalizeStagedPayload(staged, attachmentId)
                await lease.commit(() => link(staged.stagingPath!, originalPath))
                publishedPayload = true
                await this.directorySync(attachmentDir)
              }

              const managed = existing?.storage === 'managed-copy' || staged.storage === 'managed-copy'
              const metadata: AttachmentMetadata = existing
                ? {
                    ...existing,
                    storage: managed ? 'managed-copy' : 'reference',
                    ...(managed
                      ? { referenceReason: undefined, sourcePath: undefined }
                      : {}),
                    liveRecordIds: uniqueSorted([...existing.liveRecordIds, input.recordId]),
                  }
                : {
                    format: 'unmute-memory-attachment',
                    version: 1,
                    id: attachmentId,
                    sha256: staged.sha256,
                    name: source.name,
                    mimeType: source.mimeType ?? inferMimeType(source.name),
                    size: staged.size,
                    storage: staged.storage,
                    ...(staged.referenceReason === undefined ? {} : { referenceReason: staged.referenceReason }),
                    ...(staged.storage === 'reference' ? { sourcePath: source.path } : {}),
                    liveRecordIds: [input.recordId],
                    trashRecordIds: [],
                  }
              await this.writeMetadata(metadata, lease)
              return descriptor(metadata)
            } catch (error) {
              if (
                publishedPayload
                && !(error instanceof AttachmentStoreError && error.code === 'durability-uncertain')
              ) {
                try {
                  await lease.commit(async () => {
                    await unlink(originalPath)
                    await this.directorySync(attachmentDir)
                  })
                } catch { /* a fenced owner never rolls back its successor's payload */ }
              }
              throw error
            }
          })
        } finally {
          if (staged.stagingPath) {
            try {
              await unlink(staged.stagingPath)
              await this.directorySync(this.stagingDir)
            } catch { /* a later fenced owner removes hash-owned encrypted staging */ }
          }
        }
      })
    })
  }

  async get(attachmentId: string): Promise<AttachmentDescriptor> {
    return this.runPublic('read', async () => descriptor(await this.findMetadata(attachmentId)))
  }

  async open(
    principal: McpPrincipal,
    attachmentId: string,
    expiresAt?: number,
  ): Promise<OpenAttachmentHandle> {
    return this.runPublic('open', async () => {
      if (principal.kind !== 'unmute-agent') {
        throw new AttachmentStoreError('invalid-handle', 'Attachment handle is invalid or expired')
      }
      const metadata = await this.findMetadata(attachmentId)
      if (metadata.storage !== 'managed-copy') {
        throw new AttachmentStoreError('not-managed', 'Attachment is not a managed copy')
      }
      const handle = this.handles.mintOpen(principal, attachmentId, expiresAt)
      return { handle, expiresAt: Math.min(expiresAt ?? principal.expiresAt, principal.expiresAt) }
    })
  }

  async resolveForDelivery(principal: McpPrincipal, handle: string): Promise<DeliveryAttachment> {
    return this.runPublic('open', async () => {
      const { attachmentId } = this.handles.resolve(principal, handle, 'open')
      const metadata = await this.findMetadata(attachmentId)
      if (metadata.storage !== 'managed-copy') {
        throw new AttachmentStoreError('not-managed', 'Attachment is not a managed copy')
      }
      const path = join(this.attachmentsDir, metadata.sha256, 'original.enc')
      return {
        name: metadata.name,
        mimeType: metadata.mimeType,
        size: metadata.size,
        open: () => this.openContent(path, metadata),
      }
    })
  }

  async trashRecord(recordId: string): Promise<void> {
    return this.updateRecordReferences('trash', recordId, (metadata) => ({
      ...metadata,
      liveRecordIds: metadata.liveRecordIds.filter((id) => id !== recordId),
      trashRecordIds: metadata.liveRecordIds.includes(recordId)
        ? uniqueSorted([...metadata.trashRecordIds, recordId])
        : metadata.trashRecordIds,
    }))
  }

  async restoreRecord(recordId: string): Promise<void> {
    return this.updateRecordReferences('restore', recordId, (metadata) => ({
      ...metadata,
      liveRecordIds: metadata.trashRecordIds.includes(recordId)
        ? uniqueSorted([...metadata.liveRecordIds, recordId])
        : metadata.liveRecordIds,
      trashRecordIds: metadata.trashRecordIds.filter((id) => id !== recordId),
    }))
  }

  async purgeRecord(recordId: string): Promise<void> {
    requireIdentifier(recordId, 'record')
    return this.runPublic('purge', () => this.mutate(async () => {
      for (const snapshot of await this.allMetadata()) {
        await this.withHashLock(snapshot.sha256, async (lease) => {
          const metadata = await this.readMetadataIfPresent(snapshot.sha256)
          if (!metadata) return
          if (!metadata.liveRecordIds.includes(recordId) && !metadata.trashRecordIds.includes(recordId)) return
          const updated: AttachmentMetadata = {
            ...metadata,
            liveRecordIds: metadata.liveRecordIds.filter((id) => id !== recordId),
            trashRecordIds: metadata.trashRecordIds.filter((id) => id !== recordId),
          }
          if (updated.liveRecordIds.length === 0 && updated.trashRecordIds.length === 0) {
            await lease.commit(async () => {
              await rm(join(this.attachmentsDir, metadata.sha256), { recursive: true })
              await this.directorySync(this.attachmentsDir)
            })
          } else {
            await this.writeMetadata(updated, lease)
          }
        })
      }
    }))
  }

  private async updateRecordReferences(
    operation: 'trash' | 'restore',
    recordId: string,
    update: (metadata: AttachmentMetadata) => AttachmentMetadata,
  ): Promise<void> {
    requireIdentifier(recordId, 'record')
    return this.runPublic(operation, () => this.mutate(async () => {
      for (const snapshot of await this.allMetadata()) {
        await this.withHashLock(snapshot.sha256, async (lease) => {
          const metadata = await this.readMetadataIfPresent(snapshot.sha256)
          if (!metadata) return
          const updated = update(metadata)
          if (
            JSON.stringify(updated.liveRecordIds) !== JSON.stringify(metadata.liveRecordIds)
            || JSON.stringify(updated.trashRecordIds) !== JSON.stringify(metadata.trashRecordIds)
          ) {
            await this.writeMetadata(updated, lease)
          }
        })
      }
    }))
  }

  private async readSource(
    source: AttachmentSourceFile,
    options: {
      copy: boolean
      enforceCopyLimit?: number
      referenceReason?: 'large-file'
    },
  ): Promise<StagedSource> {
    const stagingPath = options.copy
      ? join(this.stagingDir, `.stage-${randomUUID()}.payload.tmp`)
      : undefined
    const hash = createHash('sha256')
    let size = 0
    let sequence = 0
    let staging: FileHandle | null = null
    let copying = options.copy
    let failure: unknown
    try {
      if (stagingPath) {
        staging = await open(stagingPath, 'wx', FILE_MODE)
        await writeAll(staging, ATTACHMENT_STREAM_HEADER)
      }
      let position = 0
      const buffer = Buffer.allocUnsafe(64 * 1024)
      for (;;) {
        const { bytesRead } = await source.read(buffer, 0, buffer.byteLength, position)
        if (bytesRead === 0) break
        position += bytesRead
        const chunk = Buffer.from(buffer.subarray(0, bytesRead))
        hash.update(chunk)
        size += chunk.byteLength
        if (!Number.isSafeInteger(size)) throw new Error('Attachment source is too large')
        if (
          copying
          && options.enforceCopyLimit !== undefined
          && size > options.enforceCopyLimit
        ) {
          copying = false
          if (staging) {
            await staging.close()
            staging = null
          }
          if (stagingPath) await unlink(stagingPath)
        }
        if (!copying) continue
        if (sequence > 0xffff_ffff) throw new Error('Attachment contains too many encrypted frames')
        const frame = Buffer.allocUnsafe(FRAME_PREFIX_BYTES + chunk.byteLength)
        frame[0] = DATA_FRAME
        frame.writeUInt32BE(sequence, 1)
        chunk.copy(frame, FRAME_PREFIX_BYTES)
        sequence += 1
        const encrypted = await this.crypto.encrypt(frame)
        const length = Buffer.allocUnsafe(4)
        length.writeUInt32BE(encrypted.byteLength)
        if (!staging) throw new Error('Attachment encrypted staging is unavailable')
        await writeAll(staging, length)
        await writeAll(staging, encrypted)
      }
      const digest = hash.digest()
      if (staging) {
        await staging.sync()
        await staging.close()
        staging = null
      }
      const managed = copying && stagingPath !== undefined
      return {
        sha256: digest.toString('hex'),
        size,
        storage: managed ? 'managed-copy' : 'reference',
        ...(!managed && (options.referenceReason || options.enforceCopyLimit !== undefined)
          ? { referenceReason: 'large-file' as const }
          : {}),
        ...(managed ? { stagingPath } : {}),
        sequence,
      }
    } catch (error) {
      failure = error
    }
    if (staging) {
      try { await staging.close() } catch (error) { failure ??= error }
    }
    if (stagingPath) {
      try { await unlink(stagingPath) } catch (error) {
        if (!isNodeError(error, 'ENOENT')) failure ??= error
      }
    }
    throw failure
  }

  private async finalizeStagedPayload(staged: StagedSource, attachmentId: string): Promise<void> {
    if (!staged.stagingPath || staged.storage !== 'managed-copy') {
      throw new Error('Managed attachment staging is unavailable')
    }
    const identity = Buffer.from(attachmentId, 'utf8')
    if (identity.byteLength > 0xffff) throw new Error('Attachment identity is too long')
    const finalFrame = Buffer.alloc(FINAL_FRAME_PREFIX_BYTES + identity.byteLength)
    finalFrame[0] = FINAL_FRAME
    finalFrame.writeUInt32BE(staged.sequence, 1)
    finalFrame.writeBigUInt64BE(BigInt(staged.size), 5)
    Buffer.from(staged.sha256, 'hex').copy(finalFrame, 13)
    finalFrame.writeUInt16BE(identity.byteLength, 45)
    identity.copy(finalFrame, FINAL_FRAME_PREFIX_BYTES)
    const encryptedFinal = await this.crypto.encrypt(finalFrame)
    const finalLength = Buffer.allocUnsafe(4)
    finalLength.writeUInt32BE(encryptedFinal.byteLength)
    const file = await open(staged.stagingPath, 'a', FILE_MODE)
    try {
      await writeAll(file, finalLength)
      await writeAll(file, encryptedFinal)
      await file.sync()
    } finally {
      await file.close()
    }
  }

  private async *decryptContent(
    file: FileHandle,
    expected: Pick<AttachmentMetadata, 'id' | 'sha256' | 'size'>,
  ): AsyncIterable<Uint8Array> {
    const header = Buffer.alloc(ATTACHMENT_STREAM_HEADER.byteLength)
    await readExact(file, header, 0)
    if (!header.equals(ATTACHMENT_STREAM_HEADER)) {
      throw new AttachmentStoreError('corrupt-attachment', 'Encrypted attachment payload is invalid')
    }
    let position = header.byteLength
    let expectedSequence = 0
    let plaintextSize = 0
    let sawFinalFrame = false
    const plaintextHash = createHash('sha256')
    for (;;) {
      const lengthBuffer = Buffer.alloc(4)
      const lengthRead = await file.read(lengthBuffer, 0, 4, position)
      if (lengthRead.bytesRead === 0) break
      if (lengthRead.bytesRead !== 4) {
        throw new AttachmentStoreError('corrupt-attachment', 'Encrypted attachment payload is invalid')
      }
      position += 4
      const frameLength = lengthBuffer.readUInt32BE()
      if (frameLength < 1 || frameLength > MAX_ENCRYPTED_FRAME_BYTES) {
        throw new AttachmentStoreError('corrupt-attachment', 'Encrypted attachment payload is invalid')
      }
      const encrypted = Buffer.alloc(frameLength)
      await readExact(file, encrypted, position)
      position += frameLength
      let frame: Buffer
      try {
        frame = await this.crypto.decrypt(encrypted)
      } catch {
        throw new AttachmentStoreError('corrupt-attachment', 'Encrypted attachment payload is invalid')
      }
      if (frame[0] === DATA_FRAME) {
        if (
          sawFinalFrame
          || frame.byteLength < FRAME_PREFIX_BYTES
          || frame.readUInt32BE(1) !== expectedSequence
        ) {
          throw new AttachmentStoreError('corrupt-attachment', 'Encrypted attachment payload is invalid')
        }
        expectedSequence += 1
        const chunk = frame.subarray(FRAME_PREFIX_BYTES)
        plaintextHash.update(chunk)
        plaintextSize += chunk.byteLength
        yield chunk
        continue
      }
      if (
        frame[0] !== FINAL_FRAME
        || sawFinalFrame
        || frame.byteLength < FINAL_FRAME_PREFIX_BYTES
        || frame.readUInt32BE(1) !== expectedSequence
      ) {
        throw new AttachmentStoreError('corrupt-attachment', 'Encrypted attachment payload is invalid')
      }
      const declaredSize = frame.readBigUInt64BE(5)
      const identityLength = frame.readUInt16BE(45)
      const identity = frame.subarray(FINAL_FRAME_PREFIX_BYTES).toString('utf8')
      const digest = plaintextHash.digest()
      if (
        declaredSize > BigInt(Number.MAX_SAFE_INTEGER)
        || Number(declaredSize) !== plaintextSize
        || Number(declaredSize) !== expected.size
        || !frame.subarray(13, 45).equals(digest)
        || digest.toString('hex') !== expected.sha256
        || frame.byteLength !== FINAL_FRAME_PREFIX_BYTES + identityLength
        || identity !== expected.id
      ) {
        throw new AttachmentStoreError('corrupt-attachment', 'Encrypted attachment payload is invalid')
      }
      sawFinalFrame = true
    }
    if (!sawFinalFrame) {
      throw new AttachmentStoreError('corrupt-attachment', 'Encrypted attachment payload is invalid')
    }
  }

  private async *openContent(
    path: string,
    expected: Pick<AttachmentMetadata, 'id' | 'sha256' | 'size'>,
  ): AsyncIterable<Uint8Array> {
    let file: FileHandle | undefined
    try {
      file = await open(path, 'r')
      for await (const _chunk of this.decryptContent(file, expected)) {
        // Verify the complete stream before any plaintext reaches a consumer.
      }
      yield* this.decryptContent(file, expected)
    } catch (error) {
      if (error instanceof AttachmentStoreError) throw error
      throw new AttachmentStoreError('storage-failure', 'Attachment open failed')
    } finally {
      await file?.close()
    }
  }

  private async recoverHashDirectories(): Promise<void> {
    for (const entry of await readdir(this.attachmentsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !SHA256_PATTERN.test(entry.name)) continue
      await this.withHashLock(entry.name, async (lease) => {
        let metadata: AttachmentMetadata
        try {
          metadata = await this.readMetadata(entry.name)
        } catch (error) {
          if (
            error instanceof AttachmentStoreError
            && (error.code === 'not-found' || error.code === 'corrupt-attachment')
          ) {
            await this.quarantineHashDirectory(entry.name, lease)
            return
          }
          throw error
        }
        const originalPath = join(this.attachmentsDir, entry.name, 'original.enc')
        if (metadata.storage === 'managed-copy') {
          try {
            if (!(await lstat(originalPath)).isFile()) await this.quarantineHashDirectory(entry.name, lease)
          } catch (error) {
            if (isNodeError(error, 'ENOENT')) await this.quarantineHashDirectory(entry.name, lease)
            else throw error
          }
          return
        }
        try {
          await lease.commit(async () => {
            await unlink(originalPath)
            await this.directorySync(join(this.attachmentsDir, entry.name))
          })
        } catch (error) {
          if (!isNodeError(error, 'ENOENT')) throw error
        }
      })
    }
  }

  private async loadMetadataForMutation(
    sha256: string,
    lease: HashLease,
  ): Promise<AttachmentMetadata | undefined> {
    try {
      return await this.readMetadata(sha256)
    } catch (error) {
      if (
        error instanceof AttachmentStoreError
        && (error.code === 'not-found' || error.code === 'corrupt-attachment')
      ) {
        await this.quarantineHashDirectory(sha256, lease)
        return undefined
      }
      throw error
    }
  }

  private async quarantineHashDirectory(sha256: string, lease: HashLease): Promise<void> {
    const source = join(this.attachmentsDir, sha256)
    try {
      await lstat(source)
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return
      throw error
    }
    await mkdir(this.quarantineDir, { recursive: true, mode: DIRECTORY_MODE })
    await lease.commit(() => rename(source, join(this.quarantineDir, `${sha256}-${randomUUID()}`)))
    await Promise.all([
      this.directorySync(this.attachmentsDir),
      this.directorySync(this.quarantineDir),
    ])
  }

  private async adoptStagedPayload(staged: StagedSource, lease: HashLease): Promise<void> {
    if (!staged.stagingPath) return
    const ownedPath = join(
      this.stagingDir,
      `.stage-${staged.sha256}-${lease.token}.payload.tmp`,
    )
    await lease.commit(() => rename(staged.stagingPath!, ownedPath))
    staged.stagingPath = ownedPath
    await this.directorySync(this.stagingDir)
  }

  private async cleanHashStaging(sha256: string): Promise<void> {
    const prefix = `.stage-${sha256}-`
    let changed = false
    for (const entry of await readdir(this.stagingDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.startsWith(prefix)) continue
      try {
        await unlink(join(this.stagingDir, entry.name))
        changed = true
      } catch (error) {
        if (!isNodeError(error, 'ENOENT')) throw error
      }
    }
    if (changed) await this.directorySync(this.stagingDir)
  }

  private async withHashLock<T>(
    sha256: string,
    action: (lease: HashLease) => Promise<T>,
  ): Promise<T> {
    const lease = await this.acquireHashLock(sha256)
    try {
      await lease.commit(() => this.cleanHashStaging(sha256))
      return await action(lease)
    } finally {
      await lease.release()
    }
  }

  private async acquireHashLock(sha256: string): Promise<HashLease> {
    if (!SHA256_PATTERN.test(sha256)) {
      throw new AttachmentStoreError('invalid-input', 'Attachment hash is invalid')
    }
    await mkdir(this.locksDir, { recursive: true, mode: DIRECTORY_MODE })
    const lockDirectory = join(this.locksDir, `${sha256}.lock`)
    const deadline = Date.now() + this.lockTimeoutMs
    let firstAttempt = true
    for (;;) {
      if (!firstAttempt && Date.now() >= deadline) {
        throw new AttachmentStoreError('storage-failure', 'Attachment lock timed out')
      }
      firstAttempt = false
      const gateRelease = await this.acquireReaperGate(sha256, deadline)
      let token: string | undefined
      try {
        token = await this.tryClaimHashLease(lockDirectory)
      } finally {
        await gateRelease()
      }
      if (token) return this.startHashLease(sha256, lockDirectory, token)
      await delay(Math.min(this.lockRetryMs, Math.max(0, deadline - Date.now())))
    }
  }

  private async acquireReaperGate(
    sha256: string,
    deadline: number,
  ): Promise<() => Promise<void>> {
    const gateDirectory = join(this.locksDir, `${sha256}.reaper`)
    const token = randomUUID()
    const ownerPath = join(gateDirectory, `owner-${token}`)
    let firstAttempt = true
    for (;;) {
      if (!firstAttempt && Date.now() >= deadline) {
        throw new AttachmentStoreError('storage-failure', 'Attachment lock timed out')
      }
      firstAttempt = false
      try {
        await mkdir(gateDirectory, { mode: DIRECTORY_MODE })
        const owner = await open(ownerPath, 'wx', FILE_MODE)
        try {
          await owner.writeFile(String(process.pid))
        } finally {
          await owner.close()
        }
        return async () => {
          let removedOwnToken = false
          try {
            await unlink(ownerPath)
            removedOwnToken = true
          } catch (error) {
            if (!isNodeError(error, 'ENOENT')) throw error
          }
          if (!removedOwnToken) return
          try {
            await rmdir(gateDirectory)
          } catch (error) {
            if (!isNodeError(error, 'ENOENT') && !isNodeError(error, 'ENOTEMPTY')) throw error
          }
        }
      } catch (error) {
        if (!isNodeError(error, 'EEXIST')) throw error
      }
      await delay(Math.min(this.lockRetryMs, Math.max(0, deadline - Date.now())))
    }
  }

  private async tryClaimHashLease(lockDirectory: string): Promise<string | undefined> {
    try {
      await mkdir(lockDirectory, { mode: DIRECTORY_MODE })
    } catch (error) {
      if (!isNodeError(error, 'EEXIST')) throw error
      const owners = (await readdir(lockDirectory, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && entry.name.startsWith('owner-'))
      let stale = owners.length !== 1
      if (owners.length === 1) {
        const ownerStat = await lstat(join(lockDirectory, owners[0]!.name))
        stale = Date.now() - ownerStat.mtimeMs >= this.staleLockMs
      } else {
        const lockStat = await lstat(lockDirectory)
        stale = Date.now() - lockStat.mtimeMs >= this.staleLockMs
      }
      if (!stale) return undefined
      const fencedPath = join(this.locksDir, `.fenced-${randomUUID()}`)
      await rename(lockDirectory, fencedPath)
      await this.directorySync(this.locksDir)
      await rm(fencedPath, { recursive: true })
      await this.directorySync(this.locksDir)
      await mkdir(lockDirectory, { mode: DIRECTORY_MODE })
    }

    const token = randomUUID()
    const ownerPath = join(lockDirectory, `owner-${token}`)
    const owner = await open(ownerPath, 'wx', FILE_MODE)
    try {
      await owner.writeFile(String(process.pid))
      await owner.sync()
    } finally {
      await owner.close()
    }
    await Promise.all([
      this.directorySync(lockDirectory),
      this.directorySync(this.locksDir),
    ])
    return token
  }

  private startHashLease(
    sha256: string,
    lockDirectory: string,
    token: string,
  ): HashLease {
    const ownerPath = join(lockDirectory, `owner-${token}`)
    let heartbeatFailure: unknown
    const fenced = () => new AttachmentStoreError(
      'storage-failure',
      'Attachment lease was fenced',
    )
    const assertOwnedWithoutGate = async () => {
      if (heartbeatFailure !== undefined) throw fenced()
      try {
        if (!(await lstat(ownerPath)).isFile()) throw fenced()
      } catch (error) {
        if (error instanceof AttachmentStoreError) throw error
        if (isNodeError(error, 'ENOENT')) throw fenced()
        throw error
      }
    }
    const withGate = async <T>(action: () => Promise<T>): Promise<T> => {
      const releaseGate = await this.acquireReaperGate(
        sha256,
        Date.now() + this.lockTimeoutMs,
      )
      try {
        await assertOwnedWithoutGate()
        return await action()
      } finally {
        await releaseGate()
      }
    }
    const stopHeartbeat = this.leaseHeartbeat.start(async () => {
      try {
        await withGate(async () => {
          const now = new Date()
          await utimes(ownerPath, now, now)
        })
      } catch (error) {
        heartbeatFailure ??= error
        throw error
      }
    }, Math.max(1, Math.floor(this.staleLockMs / 3)))
    let released = false
    return {
      token,
      assertOwned: () => withGate(async () => {}),
      commit: (publication) => withGate(publication),
      release: async () => {
        if (released) return
        released = true
        await stopHeartbeat()
        let releaseGate: (() => Promise<void>) | undefined
        try {
          releaseGate = await this.acquireReaperGate(
            sha256,
            Date.now() + this.lockTimeoutMs,
          )
          let removedOwnToken = false
          try {
            await unlink(ownerPath)
            removedOwnToken = true
          } catch (error) {
            if (!isNodeError(error, 'ENOENT')) throw error
          }
          if (removedOwnToken) {
            try {
              await rmdir(lockDirectory)
              await this.directorySync(this.locksDir)
            } catch (error) {
              if (!isNodeError(error, 'ENOENT') && !isNodeError(error, 'ENOTEMPTY')) throw error
            }
          }
        } finally {
          await releaseGate?.()
        }
      },
    }
  }

  private async readMetadataIfPresent(sha256: string): Promise<AttachmentMetadata | undefined> {
    try {
      return await this.readMetadata(sha256)
    } catch (error) {
      if (error instanceof AttachmentStoreError && error.code === 'not-found') return undefined
      throw error
    }
  }

  private async readMetadata(sha256: string): Promise<AttachmentMetadata> {
    try {
      const file = await readFile(join(this.attachmentsDir, sha256, 'metadata.json'))
      const plaintext = await this.crypto.decrypt(file)
      return validateMetadata(JSON.parse(plaintext.toString('utf8')), sha256)
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) {
        throw new AttachmentStoreError('not-found', 'Attachment was not found')
      }
      if (error instanceof AttachmentStoreError) throw error
      throw new AttachmentStoreError('corrupt-attachment', 'Encrypted attachment metadata is invalid')
    }
  }

  private async writeMetadata(metadata: AttachmentMetadata, lease: HashLease): Promise<void> {
    const directory = join(this.attachmentsDir, metadata.sha256)
    await mkdir(directory, { recursive: true, mode: DIRECTORY_MODE })
    const stagingPath = join(this.stagingDir, `.stage-${randomUUID()}.metadata.tmp`)
    let file: FileHandle | null = null
    let failure: unknown
    let published = false
    try {
      const encrypted = await this.crypto.encrypt(JSON.stringify(metadata))
      file = await open(stagingPath, 'wx', FILE_MODE)
      await file.writeFile(encrypted)
      await file.sync()
      await file.close()
      file = null
      await lease.commit(async () => {
        await rename(stagingPath, join(directory, 'metadata.json'))
        published = true
      })
      await Promise.all([
        this.directorySync(directory),
        this.directorySync(this.stagingDir),
      ])
    } catch (error) {
      failure = error
    }
    if (file) {
      try { await file.close() } catch (error) { failure ??= error }
    }
    try { await unlink(stagingPath) } catch (error) {
      if (!isNodeError(error, 'ENOENT')) failure ??= error
    }
    if (failure !== undefined) {
      if (published) {
        throw new AttachmentStoreError(
          'durability-uncertain',
          'Attachment metadata was committed but durability is uncertain',
        )
      }
      throw failure
    }
  }

  private async findMetadata(attachmentId: string): Promise<AttachmentMetadata> {
    requireIdentifier(attachmentId, 'attachment')
    for (const metadata of await this.allMetadata()) {
      if (metadata.id === attachmentId) return metadata
    }
    throw new AttachmentStoreError('not-found', 'Attachment was not found')
  }

  private async allMetadata(): Promise<AttachmentMetadata[]> {
    await this.initialize()
    const metadata: AttachmentMetadata[] = []
    for (const entry of await readdir(this.attachmentsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      if (!SHA256_PATTERN.test(entry.name)) {
        throw new AttachmentStoreError('corrupt-attachment', 'Encrypted attachment directory is invalid')
      }
      await this.withHashLock(entry.name, async () => {
        const current = await this.readMetadataIfPresent(entry.name)
        if (current) metadata.push(current)
      })
    }
    return metadata
  }

  private newAttachmentId(): string {
    const id = this.createAttachmentId()
    requireIdentifier(id, 'attachment')
    return id
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    const prior = this.mutationQueue
    let release!: () => void
    this.mutationQueue = new Promise<void>((resolve) => { release = resolve })
    await prior
    try {
      return await operation()
    } finally {
      release()
    }
  }

  private async runPublic<T>(operation: PublicOperation, action: () => Promise<T>): Promise<T> {
    try {
      return await action()
    } catch (error) {
      if (error instanceof AttachmentStoreError) throw error
      if (isNodeError(error, 'ENOENT') && operation === 'read') {
        throw new AttachmentStoreError('not-found', 'Attachment was not found')
      }
      throw new AttachmentStoreError('storage-failure', `Attachment ${operation} failed`)
    }
  }
}

function validateStoreInput(input: StoreAttachmentInput): void {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new AttachmentStoreError('invalid-input', 'Attachment store input is invalid')
  }
  const allowed = new Set(['recordId', 'handle', 'storage'])
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw new AttachmentStoreError('invalid-input', 'Attachment store input contains unsupported input')
  }
  requireIdentifier(input.recordId, 'record')
  if (typeof input.handle !== 'string' || input.handle.length === 0) {
    throw new AttachmentStoreError('invalid-input', 'Attachment handle is invalid')
  }
  if (input.storage !== undefined && input.storage !== 'copy' && input.storage !== 'reference') {
    throw new AttachmentStoreError('invalid-input', 'Attachment storage choice is invalid')
  }
}

async function readExact(file: FileHandle, buffer: Buffer, position: number): Promise<void> {
  let offset = 0
  while (offset < buffer.byteLength) {
    const { bytesRead } = await file.read(buffer, offset, buffer.byteLength - offset, position + offset)
    if (bytesRead === 0) {
      throw new AttachmentStoreError('corrupt-attachment', 'Encrypted attachment payload is invalid')
    }
    offset += bytesRead
  }
}

async function writeAll(file: FileHandle, buffer: Buffer): Promise<void> {
  let offset = 0
  while (offset < buffer.byteLength) {
    const { bytesWritten } = await file.write(buffer, offset, buffer.byteLength - offset)
    if (bytesWritten === 0) throw new Error('Attachment staging write made no progress')
    offset += bytesWritten
  }
}

async function fsyncDirectory(path: string): Promise<void> {
  const directory = await open(path, 'r')
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
