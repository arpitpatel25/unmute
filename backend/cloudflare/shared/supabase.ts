// Tiny Supabase REST helper for workers — service-role auth, used for
// admin-level writes (usage_logs inserts, balance reads, ledger updates).

import type { PipelineEnv, PaymentsEnv } from './types'

type Env = Pick<PipelineEnv | PaymentsEnv, 'SUPABASE_URL' | 'SUPABASE_SERVICE_ROLE_KEY'>

function headers(env: Env, extra: Record<string, string> = {}): Record<string, string> {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...extra,
  }
}

/** Insert a row, return the inserted row's ID. Fire-and-forget safe. */
export async function insertReturningId(
  env: Env,
  table: string,
  row: Record<string, unknown>
): Promise<string | null> {
  const url = `${env.SUPABASE_URL}/rest/v1/${table}?select=id`
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: headers(env, { Prefer: 'return=representation' }),
      body: JSON.stringify(row),
    })
    if (!res.ok) {
      console.warn(`[supabase] insert ${table} failed:`, res.status)
      return null
    }
    const rows = (await res.json()) as Array<{ id: string }>
    return rows[0]?.id ?? null
  } catch (e) {
    console.warn(`[supabase] insert ${table} threw:`, e)
    return null
  }
}

/** Call a Postgres RPC. Returns the parsed JSON result or null on failure. */
export async function rpc<T = unknown>(
  env: Env,
  fn: string,
  params: Record<string, unknown>
): Promise<T | null> {
  const url = `${env.SUPABASE_URL}/rest/v1/rpc/${fn}`
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: headers(env),
      body: JSON.stringify(params),
    })
    if (!res.ok) {
      console.warn(`[supabase] rpc ${fn} failed:`, res.status, await res.text())
      return null
    }
    // VOID-returning RPCs (e.g. process_subscription_event) reply with an empty
    // body / 204 — res.json() would throw "Unexpected end of JSON input". Read as
    // text and only parse when there's actually a body.
    const text = await res.text()
    return (text ? JSON.parse(text) : null) as T
  } catch (e) {
    console.warn(`[supabase] rpc ${fn} threw:`, e)
    return null
  }
}
