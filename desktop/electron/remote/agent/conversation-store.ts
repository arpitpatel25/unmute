import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, unlink, access } from 'node:fs/promises'
import { join } from 'node:path'
import type { MemoryCrypto } from './memory/crypto'
import type { AgentChatSnapshot } from './conversation'
import type { AgentInteractionInput, AgentInteractionResult } from './controller'

export interface AgentConversationSnapshot {
  generation: number
  /** Last input, draft edit, or completed work; absent legacy snapshots start a new idle window. */
  lastActivityAt?: number
  chat: AgentChatSnapshot
  draft: { text: string; revision: number }
  queued: Array<{ submissionId: string; input: AgentInteractionInput }>
  results?: Record<string, AgentInteractionResult>
  notice?: string
  error?: string
  /** Presentation-only indication; the terminal result has its own recovery file. */
  settlementPending?: boolean
}

export interface AgentPendingSettlement {
  generation: number
  runId: string
  submissionId: string
  at: number
  result: AgentInteractionResult
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
export class AgentConversationStore {
  constructor(private readonly options: { root: string; crypto: Pick<MemoryCrypto, 'encrypt' | 'decrypt'> }) {}

  async established(): Promise<boolean> {
    try { await access(join(this.options.root, 'established')); return true }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw this.failure() }
  }

  async markEstablished(): Promise<void> {
    await mkdir(this.options.root, { recursive: true, mode: 0o700 })
    const file = await open(join(this.options.root, 'established'), 'a', 0o600)
    try { await file.sync() } finally { await file.close() }
    await this.syncDirectory()
  }

  async write(snapshot: AgentConversationSnapshot): Promise<string> {
    const id = randomUUID()
    validate(snapshot)
    await this.writeEnvelope(id, { format: 'unmute-agent-conversation', version: 1, snapshot })
    return id
  }

  async writeSettlement(settlement: AgentPendingSettlement): Promise<void> {
    validateSettlement(settlement)
    await this.writeEnvelope('pending-settlement', { format: 'unmute-agent-settlement', version: 1, settlement })
  }

  async readSettlement(): Promise<AgentPendingSettlement | null> {
    try { await access(join(this.options.root, 'pending-settlement.enc')) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw this.failure() }
    const envelope = await this.readEnvelope('pending-settlement', 'unmute-agent-settlement')
    return validateSettlement(envelope.settlement)
  }

  async clearSettlement(): Promise<void> {
    await unlink(join(this.options.root, 'pending-settlement.enc')).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw this.failure()
    })
    await this.syncDirectory()
  }

  private async writeEnvelope(id: string, envelope: object): Promise<void> {
    const staging = join(this.options.root, `${randomUUID()}.tmp`)
    try {
      const encrypted = await this.options.crypto.encrypt(JSON.stringify(envelope))
      await mkdir(this.options.root, { recursive: true, mode: 0o700 })
      const file = await open(staging, 'wx', 0o600)
      try { await file.writeFile(encrypted); await file.sync() } finally { await file.close() }
      await rename(staging, join(this.options.root, `${id}.enc`))
      await this.syncDirectory()
    } catch { throw this.failure() }
    finally { await unlink(staging).catch(() => {}) }
  }

  async read(id: string): Promise<AgentConversationSnapshot> {
    const envelope = await this.readEnvelope(id, 'unmute-agent-conversation')
    return validate(envelope.snapshot)
  }

  private async readEnvelope(id: string, format: string): Promise<Record<string, any>> {
    if (!ID.test(id)) throw this.failure()
    try {
      const plaintext = await this.options.crypto.decrypt(await readFile(join(this.options.root, `${id}.enc`)))
      try {
        const envelope = JSON.parse(plaintext.toString('utf8'))
        if (!envelope || envelope.format !== format || envelope.version !== 1) throw this.failure()
        return envelope
      } finally { plaintext.fill(0) }
    } catch { throw this.failure() }
  }

  /** Only a caller's previously referenced immutable snapshot may be removed. */
  async remove(id: string): Promise<void> {
    if (!ID.test(id)) throw this.failure()
    await unlink(join(this.options.root, `${id}.enc`)).catch(() => {})
  }

  private async syncDirectory(): Promise<void> {
    const directory = await open(this.options.root, 'r')
    try { await directory.sync() } finally { await directory.close() }
  }
  private failure(): Error { return new Error('The Agent conversation could not be restored or saved. Input has been retained.') }
}

function validateSettlement(value: AgentPendingSettlement): AgentPendingSettlement {
  if (!value || !Number.isSafeInteger(value.generation) || value.generation < 1
    || !ID.test(value.runId) || !ID.test(value.submissionId) || !Number.isFinite(value.at)
    || !value.result || !['completed', 'failed', 'interrupted'].includes(value.result.outcome)
    || value.result.agentRunId !== value.runId
    || (value.result.text !== undefined && typeof value.result.text !== 'string')) throw new Error('Invalid pending Agent settlement')
  return value
}

function validate(value: AgentConversationSnapshot): AgentConversationSnapshot {
  if (!value || !Number.isSafeInteger(value.generation) || value.generation < 1
    || !value.chat || (value.chat.runId !== null && !ID.test(value.chat.runId))
    || !Array.isArray(value.chat.turns) || value.chat.turns.some(t => !t || !['user', 'agent'].includes(t.role) || typeof t.text !== 'string' || !Number.isFinite(t.at))
    || !value.draft || typeof value.draft.text !== 'string' || !Number.isSafeInteger(value.draft.revision)
    || !Array.isArray(value.queued) || value.queued.some(q => !q || !ID.test(q.submissionId) || typeof q.input?.transcript !== 'string')) throw new Error('Invalid Agent conversation')
  return value
}
