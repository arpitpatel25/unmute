// Balance read/write via Cloudflare KV — the hot path for managed-cloud auth.
//
// Design:
//   * KV stores the user's current balance in cents (integer) keyed by user ID.
//   * Reads happen at the edge in ~1-5ms. Writes are eventually consistent
//     globally (~60s), but reads after writes from the SAME PoP are immediate.
//   * Source of truth is Supabase profiles.balance_cents. KV is a CACHE,
//     reconciled on every successful debit and on every top-up webhook.
//   * On KV miss → fetch from Supabase, populate KV with short TTL.
//
// IMPORTANT: KV is NOT transactionally safe across workers/PoPs. We accept
// brief overshoot (user can burn $0.02-0.05 past their balance under heavy
// concurrent fire). For higher correctness we'd move to Durable Objects.
// For unmute's traffic shape (single-user mic, mostly sequential calls)
// the overshoot is negligible.

import type { KVNamespace } from '@cloudflare/workers-types'
import type { PipelineEnv } from './types'

const TTL_SECONDS = 60 * 60 // 1 hour cache; refresh on every debit

function key(userId: string): string {
  return `bal:${userId}`
}

/**
 * Get current balance in cents.
 *
 *  Default path (no opts):
 *    - First: KV read (edge-fast, eventually-consistent within ~60s).
 *    - On miss: fetch from Supabase, populate KV.
 *
 *  Fresh path ({ fresh: true }):
 *    - Skips KV entirely. Reads straight from Supabase (~50-150ms).
 *    - Also updates KV with the authoritative value so subsequent
 *      cached reads return correct data faster.
 *    - Use ONLY for low-frequency / user-blocking endpoints like
 *      `/v1/me` where staleness right after a top-up is visible to
 *      the user. Cloudflare KV's edge cache has a 60s minimum TTL
 *      so there's no sub-60s knob on the .get() call itself — the
 *      only way to guarantee freshness is to bypass KV.
 *    - Do NOT use on the dictation hot path (STT/LLM) — the
 *      Supabase round-trip latency compounds.
 *
 *  Returns 0 if user doesn't exist or fetch fails — fail-closed for safety
 *  (vs fail-open for auth, since debiting 0 is fine but allowing infinite
 *  spend isn't).
 */
export interface GetBalanceOpts { fresh?: boolean }

export async function getBalance(
  env: PipelineEnv,
  userId: string,
  opts?: GetBalanceOpts,
): Promise<number> {
  if (opts?.fresh) {
    const authoritative = await fetchBalanceFromSupabase(env, userId)
    // Refresh the KV cache with the truth so subsequent default-path
    // reads (hot path) see the correct value sooner.
    try { await setBalance(env.USER_BALANCE, userId, authoritative) } catch {}
    return authoritative
  }

  const cached = await env.USER_BALANCE.get(key(userId))
  if (cached !== null) {
    const n = parseInt(cached, 10)
    if (!isNaN(n)) return n
  }

  // KV miss — reconcile from Supabase
  const fresh = await fetchBalanceFromSupabase(env, userId)
  await setBalance(env.USER_BALANCE, userId, fresh)
  return fresh
}

/**
 * Overwrite KV with an authoritative value (from Supabase or after a top-up).
 */
export async function setBalance(
  kv: KVNamespace,
  userId: string,
  cents: number
): Promise<void> {
  await kv.put(key(userId), String(cents), { expirationTtl: TTL_SECONDS })
}

/**
 * Decrement balance by a delta (positive integer cents).
 * Returns the new cached balance. Updates KV only — Supabase is updated
 * separately via the `debit_wallet` RPC (which is what actually creates the
 * ledger row). This split is intentional: KV gives us edge-fast reads,
 * the RPC gives us auditable accounting.
 */
export async function cacheDebit(
  kv: KVNamespace,
  userId: string,
  deltaCents: number
): Promise<number> {
  const prev = await kv.get(key(userId))
  const prevNum = prev !== null ? parseInt(prev, 10) : 0
  const next = (isNaN(prevNum) ? 0 : prevNum) - deltaCents
  await kv.put(key(userId), String(next), { expirationTtl: TTL_SECONDS })
  return next
}

/**
 * Invalidate the KV entry so the next read forces a Supabase reconcile.
 * Used after refunds / adjustments where Supabase and KV may drift.
 */
export async function invalidateBalance(kv: KVNamespace, userId: string): Promise<void> {
  await kv.delete(key(userId))
}

// ─── Internal: Supabase REST fetch (service-role auth) ───────────

async function fetchBalanceFromSupabase(
  env: PipelineEnv,
  userId: string
): Promise<number> {
  const url = `${env.SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&select=balance_cents`
  const res = await fetch(url, {
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      Accept: 'application/json',
    },
  })
  if (!res.ok) {
    console.warn('[balance] Supabase fetch failed:', res.status)
    return 0
  }
  const rows = (await res.json()) as Array<{ balance_cents: number }>
  if (!rows.length) return 0
  return rows[0].balance_cents ?? 0
}

/**
 * Call the Supabase `debit_wallet` RPC. Inserts a ledger row + decrements
 * balance_cents atomically. Fire this AFTER the upstream call completes so we
 * only charge for successful work.
 *
 * Returns the new balance from Supabase (authoritative).
 */
export async function debitSupabase(
  env: PipelineEnv,
  userId: string,
  amountCents: number,
  usageLogId: string | null,
  metadata: Record<string, unknown> = {}
): Promise<number | null> {
  const url = `${env.SUPABASE_URL}/rest/v1/rpc/debit_wallet`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      p_user_id: userId,
      p_amount_cents: amountCents,
      p_usage_log_id: usageLogId,
      p_metadata: metadata,
    }),
  })
  if (!res.ok) {
    console.error('[balance] debit RPC failed:', res.status, await res.text())
    return null
  }
  const newBalance = (await res.json()) as number
  return typeof newBalance === 'number' ? newBalance : null
}
