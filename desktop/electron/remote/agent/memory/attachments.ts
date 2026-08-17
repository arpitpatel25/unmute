import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  link,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  type FileHandle,
} from 'node:fs/promises'
import { basename, join } from 'node:path'

import type { McpPrincipal } from '../types.ts'
import { MemoryCrypto } from './crypto'

const DIRECTORY_MODE = 0o700
const FILE_MODE = 0o600
const DEFAULT_MAX_MANAGED_BYTES = 25 * 1024 * 1024
const ATTACHMENT_STREAM_HEADER = Buffer.concat([Buffer.from('UATT', 'ascii'), Buffer.from([1])])
const MAX_ENCRYPTED_FRAME_BYTES = 16 * 1024 * 1024
const DATA_FRAME = 0
const FINAL_FRAME = 1
const FRAME_PREFIX_BYTES = 5
const FINAL_FRAME_BYTES = 1 + 4 + 8 + 32
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

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
    if (
      !source || typeof source !== 'object' || Array.isArray(source)
      || typeof source.path !== 'string' || source.path.length === 0
      || (source.name !== undefined && (typeof source.name !== 'string' || source.name.length === 0))
      || (source.mimeType !== undefined && !isMimeType(source.mimeType))
    ) {
      throw new AttachmentStoreError('invalid-input', 'Capture attachment is invalid')
    }
    return this.mint(agent, {
      kind: 'capture',
      path: source.path,
      name: source.name ?? basename(source.path),
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
}

export type AttachmentStoreErrorCode =
  | 'invalid-input'
  | 'invalid-handle'
  | 'not-found'
  | 'not-managed'
  | 'corrupt-attachment'
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
    || metadata.sha256 !== expectedHash || !/^[a-f0-9]{64}$/.test(expectedHash)
    || typeof metadata.name !== 'string' || metadata.name.length === 0
    || !isMimeType(metadata.mimeType)
    || !Number.isSafeInteger(metadata.size) || Number(metadata.size) < 0
    || (metadata.storage !== 'managed-copy' && metadata.storage !== 'reference')
    || (metadata.referenceReason !== undefined && metadata.referenceReason !== 'large-file')
    || !Array.isArray(metadata.liveRecordIds) || metadata.liveRecordIds.some((id) => typeof id !== 'string')
    || !Array.isArray(metadata.trashRecordIds) || metadata.trashRecordIds.some((id) => typeof id !== 'string')
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
  private readonly crypto: MemoryCrypto
  private readonly handles: InteractionAttachmentHandles
  private readonly maxManagedBytes: number
  private readonly createAttachmentId: () => string
  private initialization: Promise<void> | null = null
  private mutationQueue: Promise<void> = Promise.resolve()

  constructor(options: EncryptedAttachmentStoreOptions) {
    if (!Number.isSafeInteger(options.maxManagedBytes ?? DEFAULT_MAX_MANAGED_BYTES)
      || (options.maxManagedBytes ?? DEFAULT_MAX_MANAGED_BYTES) < 0) {
      throw new AttachmentStoreError('invalid-input', 'Managed attachment size limit is invalid')
    }
    this.attachmentsDir = join(options.root, 'attachments')
    this.stagingDir = join(this.attachmentsDir, '.staging')
    this.crypto = options.crypto
    this.handles = options.handles
    this.maxManagedBytes = options.maxManagedBytes ?? DEFAULT_MAX_MANAGED_BYTES
    this.createAttachmentId = options.createAttachmentId ?? (() => `attachment-${randomUUID()}`)
  }

  initialize(): Promise<void> {
    this.initialization ??= this.runPublic('initialize', async () => {
      await mkdir(this.stagingDir, { recursive: true, mode: DIRECTORY_MODE })
      for (const entry of await readdir(this.stagingDir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.startsWith('.stage-')) {
          await unlink(join(this.stagingDir, entry.name))
        }
      }
    })
    return this.initialization
  }

  async store(principal: McpPrincipal, input: StoreAttachmentInput): Promise<AttachmentDescriptor> {
    return this.runPublic('copy', async () => {
      validateStoreInput(input)
      const source = this.handles.resolve(principal, input.handle, 'capture')
      return this.mutate(async () => {
        await this.initialize()
        const sourceStat = await stat(source.path)
        if (!sourceStat.isFile()) {
          throw new AttachmentStoreError('invalid-input', 'Attachment source must be a regular file')
        }
        const requestedStorage = input.storage
        const useReference = requestedStorage === 'reference'
          || (requestedStorage === undefined && sourceStat.size > this.maxManagedBytes)
        const referenceReason = requestedStorage === undefined && sourceStat.size > this.maxManagedBytes
          ? 'large-file' as const
          : undefined
        const mimeType = source.mimeType ?? inferMimeType(source.name)
        const staged = useReference
          ? { ...(await this.hashSource(source.path)), stagingPath: undefined }
          : await this.stageEncryptedSource(source.path)
        const attachmentDir = join(this.attachmentsDir, staged.sha256)
        const originalPath = join(attachmentDir, 'original.enc')
        let publishedPayload = false
        try {
          await mkdir(attachmentDir, { recursive: true, mode: DIRECTORY_MODE })
          const existing = await this.readMetadataIfPresent(staged.sha256)
          if (!useReference && staged.stagingPath) {
            try {
              await link(staged.stagingPath, originalPath)
              publishedPayload = true
            } catch (error) {
              if (!isNodeError(error, 'EEXIST')) throw error
            }
          }

          const metadata: AttachmentMetadata = existing
            ? {
                ...existing,
                storage: existing.storage === 'managed-copy' || !useReference ? 'managed-copy' : 'reference',
                ...(existing.storage === 'managed-copy' || !useReference
                  ? { referenceReason: undefined, sourcePath: undefined }
                  : {}),
                liveRecordIds: uniqueSorted([...existing.liveRecordIds, input.recordId]),
              }
            : {
                format: 'unmute-memory-attachment',
                version: 1,
                id: this.newAttachmentId(),
                sha256: staged.sha256,
                name: source.name,
                mimeType,
                size: staged.size,
                storage: useReference ? 'reference' : 'managed-copy',
                ...(referenceReason === undefined ? {} : { referenceReason }),
                ...(useReference ? { sourcePath: source.path } : {}),
                liveRecordIds: [input.recordId],
                trashRecordIds: [],
              }
          await this.writeMetadata(metadata)
          return descriptor(metadata)
        } catch (error) {
          if (publishedPayload) {
            try { await unlink(originalPath) } catch { /* best-effort publication rollback */ }
          }
          throw error
        } finally {
          if (staged.stagingPath) {
            try { await unlink(staged.stagingPath) } catch { /* startup recovery removes abandoned staging */ }
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
        open: () => this.openContent(path),
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
      for (const metadata of await this.allMetadata()) {
        if (!metadata.liveRecordIds.includes(recordId) && !metadata.trashRecordIds.includes(recordId)) continue
        const updated: AttachmentMetadata = {
          ...metadata,
          liveRecordIds: metadata.liveRecordIds.filter((id) => id !== recordId),
          trashRecordIds: metadata.trashRecordIds.filter((id) => id !== recordId),
        }
        if (updated.liveRecordIds.length === 0 && updated.trashRecordIds.length === 0) {
          await rm(join(this.attachmentsDir, metadata.sha256), { recursive: true })
        } else {
          await this.writeMetadata(updated)
        }
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
      for (const metadata of await this.allMetadata()) {
        const updated = update(metadata)
        if (
          updated.liveRecordIds.length !== metadata.liveRecordIds.length
          || updated.trashRecordIds.length !== metadata.trashRecordIds.length
        ) {
          await this.writeMetadata(updated)
        }
      }
    }))
  }

  private async hashSource(path: string): Promise<{ sha256: string; size: number }> {
    const hash = createHash('sha256')
    let size = 0
    for await (const rawChunk of createReadStream(path)) {
      const chunk = Buffer.from(rawChunk)
      hash.update(chunk)
      size += chunk.byteLength
    }
    return { sha256: hash.digest('hex'), size }
  }

  private async stageEncryptedSource(
    path: string,
  ): Promise<{ sha256: string; size: number; stagingPath: string }> {
    await this.initialize()
    const stagingPath = join(this.stagingDir, `.stage-${randomUUID()}.payload.tmp`)
    const hash = createHash('sha256')
    let size = 0
    let sequence = 0
    let file: FileHandle | null = null
    let failure: unknown
    try {
      file = await open(stagingPath, 'wx', FILE_MODE)
      await writeAll(file, ATTACHMENT_STREAM_HEADER)
      for await (const rawChunk of createReadStream(path)) {
        const chunk = Buffer.from(rawChunk)
        hash.update(chunk)
        size += chunk.byteLength
        if (sequence > 0xffff_ffff) throw new Error('Attachment contains too many encrypted frames')
        const frame = Buffer.allocUnsafe(FRAME_PREFIX_BYTES + chunk.byteLength)
        frame[0] = DATA_FRAME
        frame.writeUInt32BE(sequence, 1)
        chunk.copy(frame, FRAME_PREFIX_BYTES)
        sequence += 1
        const encrypted = await this.crypto.encrypt(frame)
        const length = Buffer.allocUnsafe(4)
        length.writeUInt32BE(encrypted.byteLength)
        await writeAll(file, length)
        await writeAll(file, encrypted)
      }
      const digest = hash.digest()
      const finalFrame = Buffer.alloc(FINAL_FRAME_BYTES)
      finalFrame[0] = FINAL_FRAME
      finalFrame.writeUInt32BE(sequence, 1)
      finalFrame.writeBigUInt64BE(BigInt(size), 5)
      digest.copy(finalFrame, 13)
      const encryptedFinal = await this.crypto.encrypt(finalFrame)
      const finalLength = Buffer.allocUnsafe(4)
      finalLength.writeUInt32BE(encryptedFinal.byteLength)
      await writeAll(file, finalLength)
      await writeAll(file, encryptedFinal)
      await file.sync()
      await file.close()
      file = null
      return { sha256: digest.toString('hex'), size, stagingPath }
    } catch (error) {
      failure = error
    }
    if (file) {
      try { await file.close() } catch (error) { failure ??= error }
    }
    try { await unlink(stagingPath) } catch (error) {
      if (!isNodeError(error, 'ENOENT')) failure ??= error
    }
    throw failure
  }

  private async *decryptContent(path: string): AsyncIterable<Uint8Array> {
    const file = await open(path, 'r')
    try {
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
          || frame.byteLength !== FINAL_FRAME_BYTES
          || frame.readUInt32BE(1) !== expectedSequence
        ) {
          throw new AttachmentStoreError('corrupt-attachment', 'Encrypted attachment payload is invalid')
        }
        const declaredSize = frame.readBigUInt64BE(5)
        if (
          declaredSize > BigInt(Number.MAX_SAFE_INTEGER)
          || Number(declaredSize) !== plaintextSize
          || !frame.subarray(13).equals(plaintextHash.digest())
        ) {
          throw new AttachmentStoreError('corrupt-attachment', 'Encrypted attachment payload is invalid')
        }
        sawFinalFrame = true
      }
      if (!sawFinalFrame) {
        throw new AttachmentStoreError('corrupt-attachment', 'Encrypted attachment payload is invalid')
      }
    } finally {
      await file.close()
    }
  }

  private async *openContent(path: string): AsyncIterable<Uint8Array> {
    try {
      yield* this.decryptContent(path)
    } catch (error) {
      if (error instanceof AttachmentStoreError) throw error
      throw new AttachmentStoreError('storage-failure', 'Attachment open failed')
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

  private async writeMetadata(metadata: AttachmentMetadata): Promise<void> {
    const directory = join(this.attachmentsDir, metadata.sha256)
    await mkdir(directory, { recursive: true, mode: DIRECTORY_MODE })
    const stagingPath = join(this.stagingDir, `.stage-${randomUUID()}.metadata.tmp`)
    let file: FileHandle | null = null
    let failure: unknown
    try {
      const encrypted = await this.crypto.encrypt(JSON.stringify(metadata))
      file = await open(stagingPath, 'wx', FILE_MODE)
      await file.writeFile(encrypted)
      await file.sync()
      await file.close()
      file = null
      await rename(stagingPath, join(directory, 'metadata.json'))
    } catch (error) {
      failure = error
    }
    if (file) {
      try { await file.close() } catch (error) { failure ??= error }
    }
    try { await unlink(stagingPath) } catch (error) {
      if (!isNodeError(error, 'ENOENT')) failure ??= error
    }
    if (failure !== undefined) throw failure
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
      if (!/^[a-f0-9]{64}$/.test(entry.name)) {
        throw new AttachmentStoreError('corrupt-attachment', 'Encrypted attachment directory is invalid')
      }
      metadata.push(await this.readMetadata(entry.name))
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
