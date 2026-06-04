// JWT verification for Supabase Auth.
//
// Strategy: hardcode the current JWKS public key for zero-latency verification.
// On first failure (key rotation), fall back to fetching JWKS from Supabase.
// Pattern lifted from BoloAI's pipeline worker — same Supabase project, same
// keys, but consolidated into a single reusable module.

import * as jose from 'jose'
import type { JWTPayload } from './types'

// ─── Hardcoded Supabase JWKS public key ─────────────────────────
// This must match the public key of the Supabase project this worker authenticates
// against. If the key is rotated in Supabase, the fallback to refreshKeyFromJWKS
// handles it transparently — but for fastest path, keep this updated.

const HARDCODED_JWK: jose.JWK = {
  alg: 'ES256',
  crv: 'P-256',
  kty: 'EC',
  use: 'sig',
  key_ops: ['verify'],
  kid: 'de219dfe-6abc-490a-8282-00c01f047703',
  x: 'bxi3wO0-ZMlLc8TNYx7gIcOWXulWq-tnN_avSfYeRWQ',
  y: '2JvprIgov0s-w2EjPbxp6YzakQZDlgGMCLw39vo-8ik',
}

// Per-worker-instance cache. Workers are warm across many requests, so this
// effectively becomes a one-time cost per worker.
let cachedKey: CryptoKey | null = null
let cachedIssuer: string | null = null

async function ensureKey(supabaseUrl: string): Promise<void> {
  if (cachedKey) return
  cachedIssuer = supabaseUrl + '/auth/v1'
  cachedKey = (await jose.importJWK(HARDCODED_JWK, 'ES256')) as CryptoKey
}

async function refreshKeyFromJWKS(supabaseUrl: string): Promise<void> {
  const jwksUrl = supabaseUrl + '/auth/v1/.well-known/jwks.json'
  const res = await fetch(jwksUrl)
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`)
  const jwks = (await res.json()) as { keys: jose.JWK[] }
  cachedKey = (await jose.importJWK(jwks.keys[0], 'ES256')) as CryptoKey
  cachedIssuer = supabaseUrl + '/auth/v1'
}

/**
 * Verify a Supabase JWT and return its payload, or null if invalid.
 * - First try: hardcoded JWK (sub-millisecond once worker is warm).
 * - Fallback: fetch fresh JWKS (handles key rotation).
 */
export async function verifyJWT(
  token: string,
  supabaseUrl: string
): Promise<JWTPayload | null> {
  try {
    await ensureKey(supabaseUrl)
    const { payload } = await jose.jwtVerify(token, cachedKey!, {
      issuer: cachedIssuer!,
    })
    return payload as unknown as JWTPayload
  } catch {
    try {
      await refreshKeyFromJWKS(supabaseUrl)
      const { payload } = await jose.jwtVerify(token, cachedKey!, {
        issuer: cachedIssuer!,
      })
      return payload as unknown as JWTPayload
    } catch {
      return null
    }
  }
}

/** Extract the bearer token from an Authorization header, or null. */
export function extractBearer(req: Request): string | null {
  const h = req.headers.get('Authorization') ?? req.headers.get('authorization')
  if (!h) return null
  const m = h.match(/^Bearer\s+(.+)$/i)
  return m ? m[1].trim() : null
}
