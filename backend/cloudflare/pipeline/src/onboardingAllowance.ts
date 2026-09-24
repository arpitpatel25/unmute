import type { PipelineEnv } from '../../shared/types'

export const ONBOARDING_ACTIONS = [
  'notes-dictation',
  'notes-instruct',
  'clipboard-capture',
  'screenshot-capture',
  'orchestrator-task',
  'agent-task-link',
] as const

export type OnboardingAction = typeof ONBOARDING_ACTIONS[number]

export interface OnboardingGrantClaims {
  version: 1
  installationId: string
  actions: OnboardingAction[]
  maxRequests: 8
  maxAudioSeconds: 180
  expiresAt: number
  nonce: string
}

type GrantRecord = OnboardingGrantClaims & { requests: number; audioSeconds: number; revoked: boolean }
export type GrantConsumption =
  | { ok: true; record: GrantRecord }
  | { ok: false; reason: 'denied' | 'invalid' | 'exhausted' }

const encoder = new TextEncoder()
const MAX_ISSUES_PER_NETWORK_DAY = 3
// A user may leave for System Settings or restart the app mid-tour. The hard
// request/audio ceilings carry the abuse bound, so expiry can safely cover the
// whole day without turning permission setup into a race.
const GRANT_TTL_MS = 24 * 60 * 60_000

function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='))
  return Uint8Array.from(binary, char => char.charCodeAt(0))
}

async function hmac(secret: string, value: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value)))
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index++) difference |= left[index] ^ right[index]
  return difference === 0
}

export async function signGrant(claims: OnboardingGrantClaims, secret: string): Promise<string> {
  const payload = base64Url(encoder.encode(JSON.stringify(claims)))
  return `${payload}.${base64Url(await hmac(secret, payload))}`
}

export async function verifyGrant(token: string, secret: string): Promise<OnboardingGrantClaims | null> {
  try {
    const [payload, signature, extra] = token.split('.')
    if (!payload || !signature || extra) return null
    if (!constantTimeEqual(decodeBase64Url(signature), await hmac(secret, payload))) return null
    const claims = JSON.parse(new TextDecoder().decode(decodeBase64Url(payload))) as OnboardingGrantClaims
    if (claims.version !== 1 || !validInstallationId(claims.installationId) || !validNonce(claims.nonce)) return null
    if (claims.maxRequests !== 8 || claims.maxAudioSeconds !== 180) return null
    if (!Array.isArray(claims.actions) || claims.actions.some(action => !ONBOARDING_ACTIONS.includes(action))) return null
    return claims
  } catch {
    return null
  }
}

function validInstallationId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(value)
}

function validNonce(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{32}$/.test(value)
}

export function consumeGrantRecord(
  record: GrantRecord | null,
  input: { action: string; audioSeconds: number; now: number },
): GrantConsumption {
  if (!record || record.revoked || record.expiresAt <= input.now || !record.actions.includes(input.action as OnboardingAction)) {
    return { ok: false, reason: 'denied' }
  }
  if (!Number.isFinite(input.audioSeconds) || input.audioSeconds <= 0) return { ok: false, reason: 'invalid' }
  if (record.requests + 1 > record.maxRequests || record.audioSeconds + input.audioSeconds > record.maxAudioSeconds) {
    return { ok: false, reason: 'exhausted' }
  }
  return {
    ok: true,
    record: { ...record, requests: record.requests + 1, audioSeconds: record.audioSeconds + input.audioSeconds },
  }
}

async function privacyHash(secret: string, value: string): Promise<string> {
  return base64Url(await hmac(secret, value))
}

function objectStub(env: PipelineEnv, name: string): DurableObjectStub {
  return env.ONBOARDING_ALLOWANCE.get(env.ONBOARDING_ALLOWANCE.idFromName(name))
}

// The verified Supabase user ID is the coordination key. A Durable Object
// serializes submissions from every Cloudflare location for that account.
export async function reserveBugReportSlot(env: PipelineEnv, userId: string): Promise<{ allowed: boolean; retryAfter: number }> {
  const response = await objectStub(env, `bug-report:${userId}`).fetch('https://allowance.internal/bug-report-quota', {
    method: 'POST',
  })
  if (response.status === 204) return { allowed: true, retryAfter: 0 }
  if (response.status === 429) return { allowed: false, retryAfter: Number(response.headers.get('Retry-After')) || 3600 }
  throw new Error(`Bug report quota unavailable (${response.status})`)
}

async function postObject(env: PipelineEnv, name: string, path: string, body: unknown): Promise<Response> {
  return objectStub(env, name).fetch(`https://allowance.internal${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
}

export async function issueOnboardingGrant(
  env: PipelineEnv,
  input: { installationId: string },
  networkAddress: string,
  now = Date.now(),
): Promise<{ ok: true; grant: string; expiresAt: number } | { ok: false; reason: string }> {
  if (!validInstallationId(input.installationId)) return { ok: false, reason: 'invalid-installation' }
  const day = Math.floor(now / 86_400_000)
  const networkHash = await privacyHash(env.ONBOARDING_GRANT_SECRET, `${day}:${networkAddress || 'unknown'}`)
  const installationHash = await privacyHash(env.ONBOARDING_GRANT_SECRET, input.installationId)
  const issueResponse = await postObject(env, `issue:${day}:${networkHash}`, '/issue', {
    installationHash, limit: MAX_ISSUES_PER_NETWORK_DAY,
  })
  if (!issueResponse.ok) return { ok: false, reason: 'issuance-limit' }

  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('')
  const claims: OnboardingGrantClaims = {
    version: 1,
    installationId: input.installationId,
    actions: [...ONBOARDING_ACTIONS],
    maxRequests: 8,
    maxAudioSeconds: 180,
    expiresAt: now + GRANT_TTL_MS,
    nonce,
  }
  const initialized = await postObject(env, `grant:${nonce}`, '/initialize', claims)
  if (!initialized.ok) return { ok: false, reason: 'initialization-failed' }
  return { ok: true, grant: await signGrant(claims, env.ONBOARDING_GRANT_SECRET), expiresAt: claims.expiresAt }
}

export async function authorizeOnboardingGrant(
  env: PipelineEnv,
  token: string,
  input: { installationId: string; action: string; audioSeconds: number },
  now = Date.now(),
): Promise<boolean> {
  const claims = await verifyGrant(token, env.ONBOARDING_GRANT_SECRET)
  if (!claims || claims.expiresAt <= now || claims.installationId !== input.installationId) return false
  if (!ONBOARDING_ACTIONS.includes(input.action as OnboardingAction)) return false
  if (!claims.actions.includes(input.action as OnboardingAction)) return false
  if (!Number.isFinite(input.audioSeconds) || input.audioSeconds <= 0 || input.audioSeconds > claims.maxAudioSeconds) return false
  const response = await postObject(env, `grant:${claims.nonce}`, '/consume', {
    action: input.action, audioSeconds: input.audioSeconds, now,
  })
  return response.ok
}

export async function revokeOnboardingGrant(env: PipelineEnv, token: string): Promise<void> {
  const claims = await verifyGrant(token, env.ONBOARDING_GRANT_SECRET)
  if (claims) await postObject(env, `grant:${claims.nonce}`, '/revoke', {})
}

export class OnboardingAllowance {
  constructor(
    private readonly ctx: DurableObjectState,
    _env: PipelineEnv,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname
    if (path === '/bug-report-quota' && request.method === 'POST') return this.reserveBugReport()
    const body = await request.json<Record<string, unknown>>()
    if (path === '/issue') return this.issue(body)
    if (path === '/initialize') return this.initialize(body)
    if (path === '/consume') return this.consume(body)
    if (path === '/revoke') {
      const record = await this.ctx.storage.get<GrantRecord>('grant')
      if (record) await this.ctx.storage.put('grant', { ...record, revoked: true })
      return new Response(null, { status: 204 })
    }
    return new Response('Not found', { status: 404 })
  }

  private async reserveBugReport(): Promise<Response> {
    const now = Date.now()
    const windowMs = 60 * 60_000
    const result = await this.ctx.storage.transaction(async storage => {
      const recent = (await storage.get<number[]>('bug-report-times') ?? [])
        .filter(time => Number.isFinite(time) && time > now - windowMs && time <= now)
      if (recent.length >= 10) {
        return { allowed: false, retryAfter: Math.max(1, Math.ceil((recent[0] + windowMs - now) / 1000)) }
      }
      await storage.put('bug-report-times', [...recent, now])
      return { allowed: true, retryAfter: 0 }
    })
    return result.allowed
      ? new Response(null, { status: 204 })
      : new Response('Bug report limit reached', { status: 429, headers: { 'Retry-After': String(result.retryAfter) } })
  }

  private async issue(body: Record<string, unknown>): Promise<Response> {
    const hash = typeof body.installationHash === 'string' ? body.installationHash : ''
    const limit = typeof body.limit === 'number' ? body.limit : 0
    if (!hash || limit < 1) return new Response('Invalid', { status: 400 })
    const installations = await this.ctx.storage.get<string[]>('installations') ?? []
    if (installations.includes(hash)) return new Response('Already issued', { status: 409 })
    if (installations.length >= limit) return new Response('Limited', { status: 429 })
    await this.ctx.storage.put('installations', [...installations, hash])
    return new Response(null, { status: 201 })
  }

  private async initialize(body: Record<string, unknown>): Promise<Response> {
    if (await this.ctx.storage.get('grant')) return new Response('Exists', { status: 409 })
    const claims = body as unknown as OnboardingGrantClaims
    if (!validNonce(claims.nonce) || !validInstallationId(claims.installationId)) return new Response('Invalid', { status: 400 })
    await this.ctx.storage.put('grant', { ...claims, requests: 0, audioSeconds: 0, revoked: false } satisfies GrantRecord)
    return new Response(null, { status: 201 })
  }

  private async consume(body: Record<string, unknown>): Promise<Response> {
    const record = await this.ctx.storage.get<GrantRecord>('grant')
    const seconds = typeof body.audioSeconds === 'number' ? body.audioSeconds : NaN
    const now = typeof body.now === 'number' ? body.now : Date.now()
    const action = typeof body.action === 'string' ? body.action as OnboardingAction : null
    if (!action) return new Response('Denied', { status: 403 })
    const result = consumeGrantRecord(record ?? null, { action, audioSeconds: seconds, now })
    if (!result.ok) return new Response(result.reason, { status: result.reason === 'invalid' ? 400 : result.reason === 'exhausted' ? 429 : 403 })
    await this.ctx.storage.put('grant', result.record)
    return new Response(null, { status: 204 })
  }
}
