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

function entKey(userId: string): string {
  return `ent:${userId}`
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
 *
 * KV writes are wrapped in try/catch because Cloudflare's free-tier quota
 * (1K puts/day) is easily exhausted under any non-trivial usage. When the
 * daily limit is hit, `kv.put()` throws `KV put() limit exceeded for the
 * day.` — without this guard, that exception propagates up through the
 * Worker and turns a successful Whisper transcription into an HTTP 500
 * for the user. Supabase is the source of truth for balances, so a missed
 * KV write only means the edge cache stays stale until the next reconcile;
 * the user-facing transcription still succeeds, which is what matters.
 */
export async function setBalance(
  kv: KVNamespace,
  userId: string,
  cents: number
): Promise<void> {
  try {
    await kv.put(key(userId), String(cents), { expirationTtl: TTL_SECONDS })
  } catch (e) {
    console.warn('[balance] setBalance KV put failed (continuing):', (e as Error).message)
  }
}

/**
 * Decrement balance by a delta (positive integer cents).
 * Returns the new cached balance. Updates KV only — Supabase is updated
 * separately via the `debit_wallet` RPC (which is what actually creates the
 * ledger row). This split is intentional: KV gives us edge-fast reads,
 * the RPC gives us auditable accounting.
 *
 * Same KV-quota guard as setBalance: if the put fails we still return the
 * computed next-balance so the caller can use it for the response, but
 * the cache entry stays at its prior value. Supabase reconcile catches
 * it on the next /v1/me with `fresh: true`.
 */
export async function cacheDebit(
  kv: KVNamespace,
  userId: string,
  deltaCents: number
): Promise<number> {
  let prevNum = 0
  try {
    const prev = await kv.get(key(userId))
    prevNum = prev !== null ? parseInt(prev, 10) : 0
    if (isNaN(prevNum)) prevNum = 0
  } catch (e) {
    console.warn('[balance] cacheDebit KV get failed (assuming 0):', (e as Error).message)
  }
  const next = prevNum - deltaCents
  try {
    await kv.put(key(userId), String(next), { expirationTtl: TTL_SECONDS })
  } catch (e) {
    console.warn('[balance] cacheDebit KV put failed (continuing):', (e as Error).message)
  }
  return next
}

/**
 * Invalidate the KV entry so the next read forces a Supabase reconcile.
 * Used after refunds / adjustments where Supabase and KV may drift.
 */
export async function invalidateBalance(kv: KVNamespace, userId: string): Promise<void> {
  await kv.delete(key(userId))
}

// ─── Subscription entitlement (mirrors the balance KV-cache pattern) ──────────
//
// We moved from prepaid wallet balance to flat subscriptions. Access is gated on
// the user's subscription plan/status rather than a per-call debit. Same caching
// shape as getBalance: KV read at the edge → on miss, reconcile from Supabase
// profiles and populate KV with the same TTL.
//
// `overFairUse` is a hidden soft cap (the over_fair_use RPC). It is read ONCE on
// the Supabase reconcile (cache miss / fresh) and cached on the entitlement so
// the hot path never makes an extra DB round-trip. It NEVER blocks — it only
// flips a notify header — so we fail it open (default false) on any error.

export type Entitlement = {
  plan: 'none' | 'dictation' | 'unmute'
  status: string
  periodEnd: number | null
  overFairUse: boolean
}

/** entitled = active subscription that hasn't lapsed. */
export function isEntitled(ent: Entitlement): boolean {
  return ent.status === 'active' && (ent.periodEnd == null || ent.periodEnd > Date.now())
}

/**
 * Get the user's subscription entitlement.
 *
 *  Default path: KV read (edge-fast). On miss → reconcile from Supabase
 *  (profiles + over_fair_use RPC), populate KV with the same TTL.
 *  Fresh path ({ fresh: true }): skip KV, read straight from Supabase and
 *  refresh the cache.
 *
 *  Fail-closed: on any fetch failure returns plan 'none' / status '' so the
 *  gate denies access (consistent with getBalance returning 0).
 */
export async function getEntitlement(
  env: PipelineEnv,
  userId: string,
  opts?: GetBalanceOpts,
): Promise<Entitlement> {
  if (opts?.fresh) {
    const authoritative = await fetchEntitlementFromSupabase(env, userId)
    try { await setEntitlement(env.USER_BALANCE, userId, authoritative) } catch {}
    return authoritative
  }

  const cached = await env.USER_BALANCE.get(entKey(userId))
  if (cached !== null) {
    try {
      const ent = JSON.parse(cached) as Entitlement
      if (ent && typeof ent.plan === 'string') return ent
    } catch { /* fall through to reconcile on malformed cache */ }
  }

  // KV miss — reconcile from Supabase
  const fresh = await fetchEntitlementFromSupabase(env, userId)
  await setEntitlement(env.USER_BALANCE, userId, fresh)
  return fresh
}

/**
 * Overwrite the KV entitlement cache with an authoritative value (from Supabase
 * or after a subscription webhook on the payments side). Same KV-quota guard as
 * setBalance — a failed put just leaves the edge cache stale until next reconcile.
 */
export async function setEntitlement(
  kv: KVNamespace,
  userId: string,
  ent: Entitlement,
): Promise<void> {
  try {
    await kv.put(entKey(userId), JSON.stringify(ent), { expirationTtl: TTL_SECONDS })
  } catch (e) {
    console.warn('[entitlement] setEntitlement KV put failed (continuing):', (e as Error).message)
  }
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
 * Read the subscription entitlement from Supabase (source of truth) and the
 * hidden soft-cap flag in one reconcile. Same REST helper/URL/headers shape as
 * fetchBalanceFromSupabase. Fail-closed (plan 'none') so a fetch failure denies
 * access rather than handing out free usage. The over_fair_use RPC is best-effort
 * and fails OPEN (false) — it never gates, only flips a notify header.
 */
async function fetchEntitlementFromSupabase(
  env: PipelineEnv,
  userId: string,
): Promise<Entitlement> {
  const url = `${env.SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&select=sub_plan,sub_status,sub_period_end`
  let ent: Entitlement = { plan: 'none', status: '', periodEnd: null, overFairUse: false }
  try {
    const res = await fetch(url, {
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        Accept: 'application/json',
      },
    })
    if (!res.ok) {
      console.warn('[entitlement] Supabase fetch failed:', res.status)
      return ent
    }
    const rows = (await res.json()) as Array<{
      sub_plan: string | null
      sub_status: string | null
      sub_period_end: string | null
    }>
    if (rows.length) {
      const r = rows[0]
      ent = {
        plan: (r.sub_plan as Entitlement['plan']) || 'none',
        status: r.sub_status || '',
        periodEnd: r.sub_period_end ? Date.parse(r.sub_period_end) : null,
        overFairUse: false,
      }
    }
  } catch (e) {
    console.warn('[entitlement] Supabase fetch threw (fail-closed):', (e as Error).message)
    return ent
  }

  // Hidden soft cap — best-effort, never blocks. Read once here so the hot path
  // never round-trips. Fail open (not-over) on any error.
  try {
    const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/over_fair_use`, {
      method: 'POST',
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ p_user_id: userId }),
    })
    if (res.ok) {
      const over = (await res.json()) as unknown
      ent.overFairUse = over === true
    }
  } catch (e) {
    console.warn('[entitlement] over_fair_use RPC failed (treating as not-over):', (e as Error).message)
  }

  return ent
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
