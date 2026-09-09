import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { dirname } from 'node:path'

import type { ActionId } from './types'

const TRANSCRIPTION_ACTIONS = new Set<ActionId>([
  'notes-dictation', 'notes-instruct', 'clipboard-capture', 'screenshot-capture',
  'orchestrator-task', 'agent-task-link',
])

export type OnboardingAllowanceHeaders = {
  'X-Unmute-Onboarding-Grant': string
  'X-Unmute-Installation': string
  'X-Unmute-Onboarding-Action': string
}

export type StoredAllowanceGrant = { grant: string; expiresAt: number }

export class AllowanceGrantStore {
  constructor(private readonly path: string) {}
  async load(): Promise<StoredAllowanceGrant | null> {
    try {
      const value = JSON.parse(await fs.readFile(this.path, 'utf8')) as Partial<StoredAllowanceGrant>
      return typeof value.grant === 'string' && typeof value.expiresAt === 'number' ? { grant: value.grant, expiresAt: value.expiresAt } : null
    } catch { return null }
  }
  async save(value: StoredAllowanceGrant): Promise<void> {
    await fs.mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    await fs.writeFile(this.path, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 })
    await fs.chmod(this.path, 0o600)
  }
  async reset(): Promise<void> { await fs.rm(this.path, { force: true }) }
}

export class InstallationIdentityStore {
  constructor(private readonly path: string) {}

  async getOrCreate(): Promise<string> {
    try {
      const existing = (await fs.readFile(this.path, 'utf8')).trim()
      if (/^[A-Za-z0-9_-]{16,128}$/.test(existing)) return existing
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const value = `installation_${randomUUID().replace(/-/g, '')}`
    await fs.mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    await fs.writeFile(this.path, value, { encoding: 'utf8', mode: 0o600 })
    await fs.chmod(this.path, 0o600)
    return value
  }
}

export class OnboardingAllowanceSession {
  private grant: string | undefined
  private expiresAt = 0
  private action: ActionId | undefined
  private finished = false

  constructor(
    private readonly installationId: string,
    private readonly clock: () => number = Date.now,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async acquire(pipelineUrl: string): Promise<boolean> {
    const response = await this.fetcher(`${pipelineUrl}/v1/onboarding-grant`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ installationId: this.installationId }),
    })
    if (!response.ok) return false
    const body = await response.json() as { ok?: boolean; grant?: string; expires_at?: number }
    if (!body.ok || typeof body.grant !== 'string' || typeof body.expires_at !== 'number') return false
    this.acceptGrant({ grant: body.grant, expiresAt: body.expires_at })
    return true
  }

  acceptGrant(value: { grant: string; expiresAt: number }): void {
    this.grant = value.grant
    this.expiresAt = value.expiresAt
    this.finished = false
  }

  snapshotGrant(): StoredAllowanceGrant | null {
    return this.grant && this.expiresAt > this.clock() ? { grant: this.grant, expiresAt: this.expiresAt } : null
  }

  arm(action: ActionId): void { this.action = action }
  complete(): void { this.finished = true; this.action = undefined; this.grant = undefined }

  headers(): OnboardingAllowanceHeaders | null {
    if (this.finished || !this.grant || !this.action || this.expiresAt <= this.clock() || !TRANSCRIPTION_ACTIONS.has(this.action)) return null
    return {
      'X-Unmute-Onboarding-Grant': this.grant,
      'X-Unmute-Installation': this.installationId,
      'X-Unmute-Onboarding-Action': this.action,
    }
  }
}

let activeSession: OnboardingAllowanceSession | null = null
export function setOnboardingAllowanceSession(session: OnboardingAllowanceSession | null): void { activeSession = session }
export function onboardingAllowanceHeaders(): OnboardingAllowanceHeaders | null { return activeSession?.headers() ?? null }
