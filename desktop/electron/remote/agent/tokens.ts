import { createHash, randomBytes as nodeRandomBytes } from 'node:crypto'

import type { McpPrincipal } from './types'
import type { AgentProviderId } from './provider'

export interface AgentTokenStoreOptions {
  now?: () => number
  /** Test-only seam for deterministic token values. */
  randomToken?: () => string
  /** Test-only seam for cryptographically random token bytes. */
  randomBytes?: (size: number) => Uint8Array
}

interface TokenRecord {
  runId: string
  interactionId: string
  provider: AgentProviderId
  expiresAt: number
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * Holds short-lived MCP bearer-token grants only in memory. Tokens are never
 * persisted: the store indexes records exclusively by a SHA-256 token hash.
 */
export class AgentTokenStore {
  private readonly now: () => number
  private readonly randomToken: () => string
  private readonly recordsByHash = new Map<string, TokenRecord>()
  private readonly activeHashByRun = new Map<string, string>()
  private readonly sessions = new Map<string, { token: string; provider: AgentProviderId }>()
  private readonly sessionHashToRun = new Map<string, string>()

  constructor(options: AgentTokenStoreOptions = {}) {
    this.now = options.now ?? Date.now
    this.randomToken = options.randomToken ?? (() => Buffer.from(
      (options.randomBytes ?? nodeRandomBytes)(32),
    ).toString('base64url'))
  }

  mint(runId: string, interactionId: string, provider: AgentProviderId, ttlMs: number): string {
    this.closeRun(runId)

    const token = this.randomToken()
    const hash = tokenHash(token)
    const record = { runId, interactionId, provider, expiresAt: this.now() + ttlMs }

    this.recordsByHash.set(hash, record)
    this.activeHashByRun.set(runId, hash)
    return token
  }

  resolve(token: string): McpPrincipal | null {
    let hash = tokenHash(token)
    const sessionRun = this.sessionHashToRun.get(hash)
    if (sessionRun) {
      const active = this.activeHashByRun.get(sessionRun)
      if (!active) return null
      hash = active
    }
    const record = this.recordsByHash.get(hash)
    if (!record) return null
    if (sessionRun && this.sessions.get(sessionRun)?.provider !== record.provider) return null

    if (record.expiresAt <= this.now()) {
      this.remove(record.runId, hash)
      return null
    }

    if (this.activeHashByRun.get(record.runId) !== hash) return null

    return { kind: 'unmute-agent', ...record }
  }

  closeRun(runId: string): void {
    const hash = this.activeHashByRun.get(runId)
    if (hash) this.remove(runId, hash)
  }

  /** Stable transport credential, not a grant. Between turns it resolves to
   * nothing; mint activates only the new interaction's existing scoped grant. */
  sessionToken(runId: string, provider: AgentProviderId): string {
    const previous = this.sessions.get(runId)
    if (previous?.provider === provider) return previous.token
    if (previous) this.sessionHashToRun.delete(tokenHash(previous.token))
    const token = this.randomToken()
    this.sessions.set(runId, { token, provider })
    this.sessionHashToRun.set(tokenHash(token), runId)
    return token
  }

  forgetSession(runId: string): void {
    this.closeRun(runId)
    const session = this.sessions.get(runId)
    if (session) this.sessionHashToRun.delete(tokenHash(session.token))
    this.sessions.delete(runId)
  }

  sweep(): void {
    const now = this.now()
    for (const [hash, record] of this.recordsByHash) {
      if (record.expiresAt <= now) this.remove(record.runId, hash)
    }
  }

  private remove(runId: string, hash: string): void {
    this.recordsByHash.delete(hash)
    if (this.activeHashByRun.get(runId) === hash) this.activeHashByRun.delete(runId)
  }
}
