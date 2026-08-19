import { createHash } from 'node:crypto'
import { mkdir, open } from 'node:fs/promises'
import { join } from 'node:path'

import type { McpPrincipal } from '../types'

const DIRECTORY_MODE = 0o700
const FILE_MODE = 0o600
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

/**
 * ONE list, used by both the type and the runtime check below.
 *
 * These were two lists once — a type union and a literal array inside
 * writeRow — and adding an operation to the union alone compiled cleanly,
 * typechecked cleanly, passed every unit test (which audit through a fake
 * sink), and then rejected every real write at runtime. A second copy of a
 * vocabulary is a second chance to be wrong about it.
 */
export const MEMORY_AUDIT_OPERATIONS = [
  'store',
  'search',
  'get',
  'update',
  'forget',
  'restore',
  'list',
  'link',
  'open-attachment',
] as const

export type MemoryAuditOperation = typeof MEMORY_AUDIT_OPERATIONS[number]

export type MemoryAuditOutcome = 'success' | 'failure'

export interface MemoryAuditInput {
  principal: McpPrincipal
  memoryId: string
  operation: MemoryAuditOperation
  at: number
  outcome: MemoryAuditOutcome
}

export interface MemoryAuditRow {
  principalKind: McpPrincipal['kind']
  principalIdHash: string
  memoryId: string
  operation: MemoryAuditOperation
  at: number
  outcome: MemoryAuditOutcome
}

export interface MemoryAuditSink {
  write(event: MemoryAuditInput): Promise<void>
  writeRow(row: MemoryAuditRow): Promise<void>
}

export interface JsonlMemoryAuditOptions {
  root: string
}

export class MemoryAuditError extends Error {
  readonly code = 'audit-failed'

  constructor() {
    super('Memory audit write failed')
    this.name = 'MemoryAuditError'
  }
}

function principalIdentity(principal: McpPrincipal): string {
  return principal.kind === 'task'
    ? `task\u0000${principal.taskId}`
    : `unmute-agent\u0000${principal.runId}\u0000${principal.interactionId}`
}

export function principalIdHash(principal: McpPrincipal): string {
  return createHash('sha256').update(principalIdentity(principal), 'utf8').digest('hex')
}

export function memoryAuditRow(event: MemoryAuditInput): MemoryAuditRow {
  if (
    !IDENTIFIER_PATTERN.test(event.memoryId)
    || !Number.isSafeInteger(event.at)
    || event.at < 0
  ) {
    throw new MemoryAuditError()
  }
  return {
    principalKind: event.principal.kind,
    principalIdHash: principalIdHash(event.principal),
    memoryId: event.memoryId,
    operation: event.operation,
    at: event.at,
    outcome: event.outcome,
  }
}

/** Append-only, content-free memory access audit. */
export class JsonlMemoryAudit implements MemoryAuditSink {
  private readonly directory: string
  private readonly path: string
  private queue: Promise<void> = Promise.resolve()

  constructor(options: JsonlMemoryAuditOptions) {
    this.directory = join(options.root, 'audit')
    this.path = join(this.directory, 'access.jsonl')
  }

  write(event: MemoryAuditInput): Promise<void> {
    let value: MemoryAuditRow
    try {
      value = memoryAuditRow(event)
    } catch {
      return Promise.reject(new MemoryAuditError())
    }
    return this.writeRow(value)
  }

  writeRow(row: MemoryAuditRow): Promise<void> {
    let value: MemoryAuditRow
    try {
      const keys = row && typeof row === 'object' ? Object.keys(row) : []
      if (
        keys.length !== 6
        || !['principalKind', 'principalIdHash', 'memoryId', 'operation', 'at', 'outcome']
          .every((key) => keys.includes(key))
        || !['task', 'unmute-agent'].includes(row.principalKind)
        || !/^[a-f0-9]{64}$/.test(row.principalIdHash)
        || !IDENTIFIER_PATTERN.test(row.memoryId)
        || !(MEMORY_AUDIT_OPERATIONS as readonly string[]).includes(row.operation)
        || !Number.isSafeInteger(row.at) || row.at < 0
        || !['success', 'failure'].includes(row.outcome)
      ) throw new MemoryAuditError()
      value = { ...row }
    } catch {
      return Promise.reject(new MemoryAuditError())
    }
    const operation = this.queue.then(() => this.append(value))
    this.queue = operation.catch(() => {})
    return operation
  }

  private async append(value: MemoryAuditRow): Promise<void> {
    try {
      await mkdir(this.directory, { recursive: true, mode: DIRECTORY_MODE })
      const file = await open(this.path, 'a', FILE_MODE)
      try {
        await file.writeFile(`${JSON.stringify(value)}\n`, 'utf8')
        await file.sync()
      } finally {
        await file.close()
      }
      const directory = await open(this.directory, 'r')
      try { await directory.sync() } finally { await directory.close() }
    } catch {
      throw new MemoryAuditError()
    }
  }
}
