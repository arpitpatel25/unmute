import { randomUUID } from 'node:crypto'
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
  type FileHandle,
} from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import { MemoryCrypto } from './crypto'
import {
  MEMORY_KINDS,
  type CreateMemoryRecordInput,
  type MemoryKind,
  type MemoryProvenance,
  type MemoryRecord,
  type MemoryRecordPatch,
  type MemoryReference,
  type MemoryScope,
  type MemorySensitivity,
  type PresentedMemoryRecord,
} from './types'

const SERIALIZER_FORMAT = 'unmute-memory-record'
const SERIALIZER_VERSION = 1
const FILE_MODE = 0o600
const DIRECTORY_MODE = 0o700
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const STAGING_PATTERN = /^\.stage-.+\.tmp$/

type RecordTempFile = Pick<FileHandle, 'writeFile' | 'sync' | 'close'>

export interface RecordStoreFileSystem {
  mkdir(path: string, options: { recursive: true; mode: number }): Promise<void>
  readFile(path: string): Promise<Buffer>
  open(path: string, flags: 'wx', mode: number): Promise<RecordTempFile>
  rename(oldPath: string, newPath: string): Promise<void>
  readdir(path: string, options: { withFileTypes: true }): Promise<Dirent[]>
  unlink(path: string): Promise<void>
}

export interface EncryptedRecordStoreOptions {
  root: string
  crypto: MemoryCrypto
  createId?: () => string
  now?: () => number
  fileSystem?: RecordStoreFileSystem
}

const nodeFileSystem: RecordStoreFileSystem = {
  async mkdir(path, options) { await mkdir(path, options) },
  readFile: (path) => readFile(path),
  open: (path, flags, mode) => open(path, flags, mode),
  async rename(oldPath, newPath) { await rename(oldPath, newPath) },
  readdir: (path, options) => readdir(path, options),
  async unlink(path) { await unlink(path) },
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

function requireIdentifier(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !IDENTIFIER_PATTERN.test(id)) {
    throw new Error('Memory identifier is invalid')
  }
}

function requireNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Memory ${field} must be a non-empty string`)
  }
}

function requireStringArray(value: unknown, field: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim() === '')) {
    throw new Error(`Memory ${field} must contain non-empty strings`)
  }
}

function requireScope(value: unknown): asserts value is MemoryScope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Memory scope is invalid')
  }
  const scope = value as Record<string, unknown>
  const allowed = new Set(['app', 'project', 'purpose'])
  if (Object.keys(scope).some((key) => !allowed.has(key))) throw new Error('Memory scope is invalid')
  for (const key of allowed) {
    if (scope[key] !== undefined) requireNonEmptyString(scope[key], `scope ${key}`)
  }
}

function requireSensitivity(value: unknown): asserts value is MemorySensitivity {
  if (value !== 'normal' && value !== 'private' && value !== 'sensitive') {
    throw new Error('Memory sensitivity is invalid')
  }
}

function requireReferences(value: unknown): asserts value is MemoryReference[] {
  if (!Array.isArray(value)) throw new Error('Memory references are invalid')
  for (const reference of value) {
    if (!reference || typeof reference !== 'object' || Array.isArray(reference)) {
      throw new Error('Memory reference is invalid')
    }
    const candidate = reference as Record<string, unknown>
    if (
      Object.keys(candidate).some((key) => key !== 'type' && key !== 'value')
      || !['url', 'path', 'external'].includes(String(candidate.type))
    ) {
      throw new Error('Memory reference is invalid')
    }
    requireNonEmptyString(candidate.value, 'reference value')
  }
}

function requireProvenance(value: unknown): asserts value is MemoryProvenance {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Memory provenance is invalid')
  }
  const provenance = value as Record<string, unknown>
  if (
    Object.keys(provenance).some((key) => key !== 'source' && key !== 'original')
    || !['voice', 'selection', 'attachment', 'import'].includes(String(provenance.source))
  ) {
    throw new Error('Memory provenance is invalid')
  }
  if (provenance.original !== undefined && typeof provenance.original !== 'string') {
    throw new Error('Memory provenance original is invalid')
  }
}

function requireTimestamp(value: unknown, field: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Memory ${field} is invalid`)
  }
}

function validateRecord(record: MemoryRecord): void {
  requireIdentifier(record.id)
  requireNonEmptyString(record.kind, 'kind')
  requireNonEmptyString(record.title, 'title')
  if (record.content !== undefined && typeof record.content !== 'string') {
    throw new Error('Memory content is invalid')
  }
  requireStringArray(record.tags, 'tags')
  if (record.scope !== undefined) requireScope(record.scope)
  requireSensitivity(record.sensitivity)
  requireStringArray(record.attachments, 'attachments')
  requireReferences(record.references)
  requireProvenance(record.provenance)
  requireTimestamp(record.createdAt, 'createdAt')
  requireTimestamp(record.updatedAt, 'updatedAt')
  if (!Number.isSafeInteger(record.version) || record.version < 1) {
    throw new Error('Memory version is invalid')
  }
  if (record.deletedAt !== undefined) requireTimestamp(record.deletedAt, 'deletedAt')
}

function validateCreateInput(input: CreateMemoryRecordInput): void {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Memory create input is invalid')
  }
  const expected = new Set([
    'kind', 'title', 'content', 'tags', 'scope', 'sensitivity',
    'attachments', 'references', 'provenance',
  ])
  if (Object.keys(input).some((key) => !expected.has(key))) {
    throw new Error('Memory create input contains unsupported fields')
  }
}

function metadataLine(key: string, value: unknown): string {
  return `${key}: ${JSON.stringify(value)}`
}

function canonicalScope(scope: MemoryScope | undefined): MemoryScope | null {
  if (!scope) return null
  return {
    ...(scope.app === undefined ? {} : { app: scope.app }),
    ...(scope.project === undefined ? {} : { project: scope.project }),
    ...(scope.purpose === undefined ? {} : { purpose: scope.purpose }),
  }
}

function canonicalReferences(references: MemoryReference[]): MemoryReference[] {
  return references.map(({ type, value }) => ({ type, value }))
}

function canonicalProvenance(provenance: MemoryProvenance): MemoryProvenance {
  return {
    source: provenance.source,
    ...(provenance.original === undefined ? {} : { original: provenance.original }),
  }
}

/** Serializes in fixed field order. JSON literals are valid YAML scalar values. */
export function serializeMemoryRecord(record: MemoryRecord): string {
  validateRecord(record)
  const document = [
    '---',
    metadataLine('serializerVersion', SERIALIZER_VERSION),
    metadataLine('id', record.id),
    metadataLine('kind', record.kind),
    metadataLine('title', record.title),
    metadataLine('tags', record.tags),
    metadataLine('scope', canonicalScope(record.scope)),
    metadataLine('sensitivity', record.sensitivity),
    metadataLine('attachments', record.attachments),
    metadataLine('references', canonicalReferences(record.references)),
    metadataLine('provenance', canonicalProvenance(record.provenance)),
    metadataLine('createdAt', record.createdAt),
    metadataLine('updatedAt', record.updatedAt),
    metadataLine('version', record.version),
    metadataLine('deletedAt', record.deletedAt ?? null),
    '---',
    record.content ?? '',
  ].join('\n')
  return JSON.stringify({ format: SERIALIZER_FORMAT, serializerVersion: SERIALIZER_VERSION, document })
}

function parseDocument(document: unknown): MemoryRecord {
  if (typeof document !== 'string' || !document.startsWith('---\n')) {
    throw new Error('Encrypted memory record document is invalid')
  }
  const metadataEnd = document.indexOf('\n---\n', 4)
  if (metadataEnd < 0) throw new Error('Encrypted memory record metadata is invalid')
  const metadata = new Map<string, unknown>()
  for (const line of document.slice(4, metadataEnd).split('\n')) {
    const separator = line.indexOf(': ')
    if (separator < 1) throw new Error('Encrypted memory record metadata is invalid')
    const key = line.slice(0, separator)
    if (metadata.has(key)) throw new Error('Encrypted memory record metadata is invalid')
    try {
      metadata.set(key, JSON.parse(line.slice(separator + 2)))
    } catch {
      throw new Error('Encrypted memory record metadata is invalid')
    }
  }
  if (metadata.get('serializerVersion') !== SERIALIZER_VERSION) {
    throw new Error('Encrypted memory record serializer version is unsupported')
  }
  const content = document.slice(metadataEnd + 5)
  const record: MemoryRecord = {
    id: metadata.get('id') as string,
    kind: metadata.get('kind') as string,
    title: metadata.get('title') as string,
    ...(content === '' ? {} : { content }),
    tags: metadata.get('tags') as string[],
    ...(metadata.get('scope') === null ? {} : { scope: metadata.get('scope') as MemoryScope }),
    sensitivity: metadata.get('sensitivity') as MemorySensitivity,
    attachments: metadata.get('attachments') as string[],
    references: metadata.get('references') as MemoryReference[],
    provenance: metadata.get('provenance') as MemoryProvenance,
    createdAt: metadata.get('createdAt') as number,
    updatedAt: metadata.get('updatedAt') as number,
    version: metadata.get('version') as number,
    ...(metadata.get('deletedAt') === null ? {} : { deletedAt: metadata.get('deletedAt') as number }),
  }
  validateRecord(record)
  return record
}

export function deserializeMemoryRecord(payload: Uint8Array | string): MemoryRecord {
  let envelope: unknown
  try {
    envelope = JSON.parse(typeof payload === 'string' ? payload : Buffer.from(payload).toString('utf8'))
  } catch {
    throw new Error('Encrypted memory record payload is invalid')
  }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new Error('Encrypted memory record payload is invalid')
  }
  const candidate = envelope as Record<string, unknown>
  if (candidate.format !== SERIALIZER_FORMAT || candidate.serializerVersion !== SERIALIZER_VERSION) {
    throw new Error('Encrypted memory record serializer version is unsupported')
  }
  return parseDocument(candidate.document)
}

export function presentMemoryRecord(record: MemoryRecord): PresentedMemoryRecord {
  const kind: MemoryKind = (MEMORY_KINDS as readonly string[]).includes(record.kind)
    ? record.kind as MemoryKind
    : 'note'
  return { ...record, kind }
}

export class EncryptedRecordStore {
  private readonly recordsDir: string
  private readonly versionsDir: string
  private readonly trashRecordsDir: string
  private readonly crypto: MemoryCrypto
  private readonly createId: () => string
  private readonly now: () => number
  private readonly fileSystem: RecordStoreFileSystem
  private initialization: Promise<void> | null = null

  constructor(options: EncryptedRecordStoreOptions) {
    this.recordsDir = join(options.root, 'records')
    this.versionsDir = join(options.root, 'versions')
    this.trashRecordsDir = join(options.root, 'trash', 'records')
    this.crypto = options.crypto
    this.createId = options.createId ?? randomUUID
    this.now = options.now ?? Date.now
    this.fileSystem = options.fileSystem ?? nodeFileSystem
  }

  initialize(): Promise<void> {
    this.initialization ??= this.initializeFileSystem()
    return this.initialization
  }

  async create(input: CreateMemoryRecordInput): Promise<MemoryRecord> {
    await this.initialize()
    validateCreateInput(input)
    const id = this.createId()
    requireIdentifier(id)
    const at = this.now()
    const record: MemoryRecord = { id, ...input, createdAt: at, updatedAt: at, version: 1 }
    validateRecord(record)
    const target = this.recordPath(id)
    try {
      await this.fileSystem.readFile(target)
      throw new Error('Memory identifier already exists')
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error
    }
    await this.writeEncryptedRecord(target, record)
    return record
  }

  async read(id: string): Promise<MemoryRecord> {
    await this.initialize()
    requireIdentifier(id)
    return this.readEncryptedRecord(this.recordPath(id))
  }

  async readTrash(id: string): Promise<MemoryRecord> {
    await this.initialize()
    requireIdentifier(id)
    return this.readEncryptedRecord(this.trashPath(id))
  }

  async readVersion(id: string, version: number): Promise<MemoryRecord> {
    await this.initialize()
    requireIdentifier(id)
    if (!Number.isSafeInteger(version) || version < 1) throw new Error('Memory version is invalid')
    return this.readEncryptedRecord(this.versionPath(id, version))
  }

  async update(id: string, patch: MemoryRecordPatch): Promise<MemoryRecord> {
    await this.initialize()
    requireIdentifier(id)
    this.validatePatch(patch)
    const target = this.recordPath(id)
    const priorEnvelope = await this.fileSystem.readFile(target)
    const prior = await this.decryptRecord(priorEnvelope)
    if (prior.id !== id) throw new Error('Encrypted memory record identifier does not match its path')
    const updated: MemoryRecord = { ...prior }
    if (patch.kind !== undefined) updated.kind = patch.kind
    if (patch.title !== undefined) updated.title = patch.title
    if (patch.content === null) delete updated.content
    else if (patch.content !== undefined) updated.content = patch.content
    if (patch.tags !== undefined) updated.tags = patch.tags
    if (patch.scope === null) delete updated.scope
    else if (patch.scope !== undefined) updated.scope = patch.scope
    if (patch.sensitivity !== undefined) updated.sensitivity = patch.sensitivity
    if (patch.attachments !== undefined) updated.attachments = patch.attachments
    if (patch.references !== undefined) updated.references = patch.references
    if (patch.provenance !== undefined) updated.provenance = patch.provenance
    updated.updatedAt = this.now()
    updated.version = prior.version + 1
    validateRecord(updated)

    await this.atomicWrite(this.versionPath(id, prior.version), priorEnvelope)
    await this.writeEncryptedRecord(target, updated)
    return updated
  }

  async forget(id: string): Promise<void> {
    await this.initialize()
    requireIdentifier(id)
    await this.ensureDestinationAbsent(this.trashPath(id))
    await this.fileSystem.rename(this.recordPath(id), this.trashPath(id))
  }

  async restore(id: string): Promise<void> {
    await this.initialize()
    requireIdentifier(id)
    await this.ensureDestinationAbsent(this.recordPath(id))
    await this.fileSystem.rename(this.trashPath(id), this.recordPath(id))
  }

  private async initializeFileSystem(): Promise<void> {
    await Promise.all([
      this.fileSystem.mkdir(this.recordsDir, { recursive: true, mode: DIRECTORY_MODE }),
      this.fileSystem.mkdir(this.versionsDir, { recursive: true, mode: DIRECTORY_MODE }),
      this.fileSystem.mkdir(this.trashRecordsDir, { recursive: true, mode: DIRECTORY_MODE }),
    ])
    await Promise.all([
      this.removeStagingFiles(this.recordsDir, false),
      this.removeStagingFiles(this.versionsDir, true),
      this.removeStagingFiles(this.trashRecordsDir, false),
    ])
  }

  private async removeStagingFiles(directory: string, recurse: boolean): Promise<void> {
    const entries = await this.fileSystem.readdir(directory, { withFileTypes: true })
    await Promise.all(entries.map(async (entry) => {
      const path = join(directory, entry.name)
      if (entry.isFile() && STAGING_PATTERN.test(entry.name)) {
        await this.fileSystem.unlink(path)
      } else if (recurse && entry.isDirectory()) {
        await this.removeStagingFiles(path, false)
      }
    }))
  }

  private recordPath(id: string): string {
    return join(this.recordsDir, `${id}.md.enc`)
  }

  private trashPath(id: string): string {
    return join(this.trashRecordsDir, `${id}.md.enc`)
  }

  private versionPath(id: string, version: number): string {
    return join(this.versionsDir, id, `${version}.json.enc`)
  }

  private async readEncryptedRecord(path: string): Promise<MemoryRecord> {
    return this.decryptRecord(await this.fileSystem.readFile(path))
  }

  private async decryptRecord(envelope: Buffer): Promise<MemoryRecord> {
    return deserializeMemoryRecord(await this.crypto.decrypt(envelope))
  }

  private async writeEncryptedRecord(path: string, record: MemoryRecord): Promise<void> {
    const envelope = await this.crypto.encrypt(serializeMemoryRecord(record))
    await this.atomicWrite(path, envelope)
  }

  private async atomicWrite(path: string, data: Uint8Array): Promise<void> {
    await this.fileSystem.mkdir(dirname(path), { recursive: true, mode: DIRECTORY_MODE })
    const stem = basename(path).replace(/\.(?:md|json)\.enc$/, '')
    const stagingPath = join(dirname(path), `.stage-${stem}.${randomUUID()}.tmp`)
    let file: RecordTempFile | null = null
    try {
      file = await this.fileSystem.open(stagingPath, 'wx', FILE_MODE)
      await file.writeFile(data)
      await file.sync()
      await file.close()
      file = null
      await this.fileSystem.rename(stagingPath, path)
    } finally {
      if (file) await file.close()
      try {
        await this.fileSystem.unlink(stagingPath)
      } catch (error) {
        if (!isNodeError(error, 'ENOENT')) throw error
      }
    }
  }

  private validatePatch(patch: MemoryRecordPatch): void {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new Error('Memory update patch is invalid')
    }
    const allowed = new Set([
      'kind', 'title', 'content', 'tags', 'scope', 'sensitivity',
      'attachments', 'references', 'provenance',
    ])
    if (Object.keys(patch).length === 0 || Object.keys(patch).some((key) => !allowed.has(key))) {
      throw new Error('Memory update patch is invalid')
    }
  }

  private async ensureDestinationAbsent(path: string): Promise<void> {
    try {
      await this.fileSystem.readFile(path)
      throw new Error('Memory destination already exists')
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error
    }
  }
}
