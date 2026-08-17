import { randomUUID } from 'node:crypto'
import { link, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'

import type { MemoryAuditRow } from './audit'

const DIRECTORY_MODE = 0o700
const FILE_MODE = 0o600
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/

export type MemoryMutationOperation = 'store' | 'forget' | 'restore'
export type MemoryMutationStage =
  | 'intent'
  | 'canonical'
  | 'attachments'
  | 'canonical-attached'
  | 'indexed'
  | 'audited'

export interface MemoryMutationIntent {
  format: 'unmute-memory-mutation'
  version: 1
  operation: MemoryMutationOperation
  memoryId: string
  stage: MemoryMutationStage
  audit: MemoryAuditRow
}

export interface MemoryMutationJournal {
  read(): Promise<MemoryMutationIntent | undefined>
  begin(intent: MemoryMutationIntent): Promise<void>
  checkpoint(intent: MemoryMutationIntent): Promise<void>
  clear(): Promise<void>
}

export type MemoryMutationJournalErrorCode =
  | 'pending-mutation'
  | 'invalid-journal'
  | 'journal-failed'

export class MemoryMutationJournalError extends Error {
  constructor(readonly code: MemoryMutationJournalErrorCode, message: string) {
    super(message)
    this.name = 'MemoryMutationJournalError'
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value)
  return keys.length === expected.length && keys.every((key) => expected.includes(key))
}

function validateIntent(value: unknown): MemoryMutationIntent {
  if (
    !value || typeof value !== 'object' || Array.isArray(value)
    || !exactKeys(value, ['format', 'version', 'operation', 'memoryId', 'stage', 'audit'])
  ) throw new MemoryMutationJournalError('invalid-journal', 'Memory mutation journal is invalid')
  const intent = value as Partial<MemoryMutationIntent>
  const audit = intent.audit
  if (
    intent.format !== 'unmute-memory-mutation'
    || intent.version !== 1
    || !['store', 'forget', 'restore'].includes(intent.operation ?? '')
    || typeof intent.memoryId !== 'string' || !IDENTIFIER_PATTERN.test(intent.memoryId)
    || !['intent', 'canonical', 'attachments', 'canonical-attached', 'indexed', 'audited']
      .includes(intent.stage ?? '')
    || !audit || typeof audit !== 'object' || Array.isArray(audit)
    || !exactKeys(audit, ['principalKind', 'principalIdHash', 'memoryId', 'operation', 'at', 'outcome'])
    || !['task', 'unmute-agent'].includes(audit.principalKind)
    || typeof audit.principalIdHash !== 'string' || !SHA256_PATTERN.test(audit.principalIdHash)
    || audit.memoryId !== intent.memoryId
    || audit.operation !== intent.operation
    || !Number.isSafeInteger(audit.at) || audit.at < 0
    || !['success', 'failure'].includes(audit.outcome)
  ) throw new MemoryMutationJournalError('invalid-journal', 'Memory mutation journal is invalid')
  return structuredClone(intent as MemoryMutationIntent)
}

export interface DurableMemoryMutationJournalOptions {
  root: string
}

/** Owner-private, content-free recovery intent for cross-store service mutations. */
export class DurableMemoryMutationJournal implements MemoryMutationJournal {
  private readonly directory: string
  private readonly path: string

  constructor(options: DurableMemoryMutationJournalOptions) {
    this.directory = join(options.root, 'transactions')
    this.path = join(this.directory, 'pending.json')
  }

  async read(): Promise<MemoryMutationIntent | undefined> {
    try {
      const persisted = await readFile(this.path, 'utf8')
      return validateIntent(JSON.parse(persisted) as unknown)
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return undefined
      if (error instanceof MemoryMutationJournalError) throw error
      throw new MemoryMutationJournalError('invalid-journal', 'Memory mutation journal is invalid')
    }
  }

  async begin(intent: MemoryMutationIntent): Promise<void> {
    const value = validateIntent(intent)
    try {
      await mkdir(this.directory, { recursive: true, mode: DIRECTORY_MODE })
      const staging = await this.writeStaging(value)
      try {
        await link(staging, this.path)
        await this.syncDirectory()
      } finally {
        try { await unlink(staging) } catch { /* best effort after atomic publication */ }
      }
    } catch (error) {
      if (isNodeError(error, 'EEXIST')) {
        throw new MemoryMutationJournalError('pending-mutation', 'A memory mutation is pending recovery')
      }
      if (error instanceof MemoryMutationJournalError) throw error
      throw new MemoryMutationJournalError('journal-failed', 'Memory mutation journal write failed')
    }
  }

  async checkpoint(intent: MemoryMutationIntent): Promise<void> {
    const value = validateIntent(intent)
    try {
      await mkdir(this.directory, { recursive: true, mode: DIRECTORY_MODE })
      const staging = await this.writeStaging(value)
      try {
        await rename(staging, this.path)
        await this.syncDirectory()
      } finally {
        try { await unlink(staging) } catch { /* rename normally consumed staging */ }
      }
    } catch (error) {
      if (error instanceof MemoryMutationJournalError) throw error
      throw new MemoryMutationJournalError('journal-failed', 'Memory mutation journal write failed')
    }
  }

  async clear(): Promise<void> {
    try {
      await unlink(this.path)
      await this.syncDirectory()
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return
      throw new MemoryMutationJournalError('journal-failed', 'Memory mutation journal clear failed')
    }
  }

  private async writeStaging(intent: MemoryMutationIntent): Promise<string> {
    const path = join(this.directory, `.pending-${randomUUID()}.tmp`)
    const file = await open(path, 'wx', FILE_MODE)
    try {
      await file.writeFile(JSON.stringify(intent), 'utf8')
      await file.sync()
    } finally {
      await file.close()
    }
    return path
  }

  private async syncDirectory(): Promise<void> {
    const directory = await open(this.directory, 'r')
    try { await directory.sync() } finally { await directory.close() }
  }
}
