// unmute-cloud / payments worker (stub)
//
// Will handle Dodo Payments webhooks. Structured but not wired —
// payment integration lands in a follow-up PR.
//
// Endpoints (planned):
//   POST /webhook/dodo          — Dodo payment events (signature-verified)
//   POST /checkout/session      — Create a Dodo checkout session for top-up
//   GET  /v1/ledger             — JWT-authed list of recent ledger rows
//
// For now this worker:
//   * Returns a "coming soon" payload on /webhook/dodo
//   * Exposes /v1/ledger (the only thing the desktop app uses today)

import { verifyJWT, extractBearer } from '../../shared/auth'
import type { PaymentsEnv } from '../../shared/types'
import { rpc } from '../../shared/supabase'

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Dodo-Signature',
  'Access-Control-Max-Age': '86400',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  })
}

export default {
  async fetch(req: Request, env: PaymentsEnv): Promise<Response> {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS })

    const url = new URL(req.url)

    // ─── Dodo webhook (signature-verified, no JWT) ──────────────
    if (req.method === 'POST' && url.pathname === '/webhook/dodo') {
      return handleDodoWebhook(req, env)
    }

    // ─── Everything else requires JWT ───────────────────────────
    const token = extractBearer(req)
    if (!token) return json({ ok: false, code: 'UNAUTHORIZED', message: 'Missing token' }, 401)
    const payload = await verifyJWT(token, env.SUPABASE_URL)
    if (!payload?.sub) return json({ ok: false, code: 'UNAUTHORIZED', message: 'Invalid token' }, 401)

    const userId = payload.sub

    if (req.method === 'GET' && url.pathname === '/v1/ledger') {
      return handleLedger(env, userId)
    }
    if (req.method === 'POST' && url.pathname === '/checkout/session') {
      return json({ ok: false, code: 'NOT_IMPLEMENTED', message: 'Dodo integration lands soon' }, 501)
    }

    return json({ ok: false, code: 'NOT_FOUND', message: 'No route' }, 404)
  },
}

// ─── Dodo webhook handler (skeleton) ────────────────────────────

async function handleDodoWebhook(_req: Request, _env: PaymentsEnv): Promise<Response> {
  // TODO (next PR):
  //   1. Verify Dodo signature using DODO_WEBHOOK_SECRET
  //   2. Parse event payload
  //   3. On 'payment.succeeded':
  //        - upsert public.topups (status=succeeded, provider_event_id for idempotency)
  //        - call credit_wallet RPC (creates ledger row + bumps balance_cents)
  //        - invalidate KV cache for user so next request reconciles fresh
  //   4. On 'payment.failed' / 'payment.refunded':
  //        - log only (and for refund: call credit_wallet with source='refund', negative ledger)
  //   5. Return 200 to ACK Dodo (always — never let Dodo retry an event we've decided is bad)
  return json({ ok: false, code: 'NOT_IMPLEMENTED', message: 'Webhook handler not wired yet' }, 501)
}

// ─── Ledger view ────────────────────────────────────────────────

interface LedgerRow {
  id: string
  created_at: string
  delta_cents: number
  source: string
  metadata: Record<string, unknown>
}

async function handleLedger(env: PaymentsEnv, userId: string): Promise<Response> {
  // Simple PostgREST query — most recent 50 rows
  const url = `${env.SUPABASE_URL}/rest/v1/wallet_ledger?user_id=eq.${userId}&select=id,created_at,delta_cents,source,metadata&order=created_at.desc&limit=50`
  const res = await fetch(url, {
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      Accept: 'application/json',
    },
  })
  if (!res.ok) return json({ ok: false, code: 'INTERNAL_ERROR', message: 'Failed to fetch ledger' }, 500)
  const rows = (await res.json()) as LedgerRow[]
  return json({ ok: true, data: rows })
}

// Stub so TS doesn't drop the import as unused
void rpc
