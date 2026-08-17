import { createHash } from 'node:crypto'
import { mkdir, open } from 'node:fs/promises'
import { join } from 'node:path'

import type { McpPrincipal } from '../types'

const DIRECTORY_MODE = 0o700
const FILE_MODE = 0o600
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

export type MemoryAuditOperation =
  | 'store'
  | 'search'
  | 'get'
  | 'update'
  | 'forget'
  | 'restore'
  | 'open-attachment'

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

function row(event: MemoryAuditInput): MemoryAuditRow {
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
      value = row(event)
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
    } catch {
      throw new MemoryAuditError()
    }
  }
}
