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
import { createCheckoutSession, getPayment, parseTopupConfig } from '../../shared/dodo'
import { verifyDodoWebhook } from '../../shared/dodoWebhook'
import { setBalance } from '../../shared/balance'

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

    // ─── Public return-page bounce (no JWT) ───────────────────
    // Dodo redirects users here after checkout. We bounce them back to the
    // desktop app via the unmute:// deep link.
    if (req.method === 'GET' && url.pathname === '/checkout/return') {
      return handleCheckoutReturn(url)
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
      return handleCreateCheckout(req, env, userId, payload.email)
    }
    // GET /v1/payment/:id — proxy lookup so the app can reconcile when the
    // user closes the checkout tab before redirect.
    if (req.method === 'GET' && url.pathname.startsWith('/v1/payment/')) {
      const id = url.pathname.slice('/v1/payment/'.length)
      return handlePaymentLookup(env, userId, id)
    }

    return json({ ok: false, code: 'NOT_FOUND', message: 'No route' }, 404)
  },
}

// ─── GET /checkout/return — bounce page ─────────────────────────
//
// Dodo doesn't support custom URL schemes (unmute://) in return_url, so we
// register a HTTPS return_url that lands here, then JS-trigger the deep
// link. Browsers vary in deep-link UX: Safari shows a one-time prompt,
// Chrome usually opens silently, Firefox needs a click. We try auto-click
// after 400ms; if the browser blocks it, the visible "Return to unmute"
// button serves as the explicit fallback.
//
// Robustness: the desktop app does NOT depend on this redirect succeeding.
// It polls /v1/me (balance) and /v1/payment/:id (status) regardless. This
// page is a UX nicety — failure here is invisible.

function handleCheckoutReturn(url: URL): Response {
  // Whitelist + sanitize. Anything we render is appended to a URI scheme;
  // the deep link is built server-side so the renderer doesn't have to
  // worry about XSS — but we still strip control chars defensively.
  const safe = (s: string | null, fallback: string): string =>
    (s ?? fallback).replace(/[^\x20-\x7E]/g, '').slice(0, 256)
  const paymentId = encodeURIComponent(safe(url.searchParams.get('payment_id'), ''))
  const status = encodeURIComponent(safe(url.searchParams.get('status'), 'unknown'))
  const deepLink = `unmute://payment-success?payment_id=${paymentId}&status=${status}`
  const escapedDeepLink = deepLink.replace(/"/g, '&quot;')

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Return to unmute</title>
<style>
  :root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  body { min-height: 100vh; margin: 0; display: flex; align-items: center; justify-content: center;
         background: #0a0a0a; color: #f4f4f4; }
  .card { max-width: 420px; padding: 40px 32px; text-align: center; }
  h1 { font-size: 20px; font-weight: 600; margin: 0 0 12px; }
  p  { font-size: 14px; color: #b5b5b5; margin: 0 0 28px; line-height: 1.5; }
  a.btn { display: inline-block; padding: 10px 22px; border-radius: 8px;
          background: #fff; color: #000; text-decoration: none; font-weight: 500; }
  .hint { margin-top: 18px; font-size: 12px; color: #6b6b6b; }
</style>
</head>
<body>
<div class="card">
  <h1>Payment received</h1>
  <p>Returning you to unmute&hellip;</p>
  <a class="btn" id="back" href="${escapedDeepLink}">Open unmute</a>
  <p class="hint">If unmute doesn't open automatically, click the button above.</p>
</div>
<script>
  // Click programmatically after 400ms. Browsers that block this still
  // honor the visible button; the desktop app polls /v1/me regardless.
  setTimeout(function () {
    try { document.getElementById('back').click() } catch (e) {}
  }, 400);
</script>
</body>
</html>`

  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // No caching — query params change per-payment.
      'Cache-Control': 'no-store',
    },
  })
}

// ─── POST /checkout/session ─────────────────────────────────────
// Body: { amount_cents: number }   — must match one of the configured tiers.
// Returns: { ok: true, checkout_url, payment_session_id? }
//
// Client opens checkout_url in the system browser (NOT an Electron
// BrowserWindow — UPI/3DS/Apple Pay break in embedded webviews).

interface CreateCheckoutRequest {
  amount_cents?: number
}

async function handleCreateCheckout(
  req: Request,
  env: PaymentsEnv,
  userId: string,
  userEmail: string | undefined,
): Promise<Response> {
  let body: CreateCheckoutRequest
  try {
    body = (await req.json()) as CreateCheckoutRequest
  } catch {
    return json({ ok: false, code: 'BAD_REQUEST', message: 'invalid JSON' }, 400)
  }
  const amount = body.amount_cents
  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount <= 0) {
    return json({ ok: false, code: 'BAD_REQUEST', message: 'amount_cents must be a positive integer' }, 400)
  }
  if (!userEmail) {
    // Supabase JWTs from email/password and OAuth flows include email; if
    // it's missing, the account is in some non-standard state. Fail loud.
    return json({ ok: false, code: 'BAD_REQUEST', message: 'user has no email on file' }, 400)
  }

  let cfg
  try {
    cfg = parseTopupConfig(env)
  } catch (e) {
    console.error('[checkout] bad config:', (e as Error).message)
    return json({ ok: false, code: 'INTERNAL_ERROR', message: 'checkout misconfigured' }, 500)
  }

  if (!cfg.productByCents[String(amount)]) {
    return json(
      { ok: false, code: 'BAD_REQUEST', message: `amount ${amount} not a configured tier` },
      400,
    )
  }

  try {
    const session = await createCheckoutSession(env, cfg, {
      amountCents: amount,
      userId,
      userEmail,
      returnUrl: `${env.PUBLIC_API_BASE}/checkout/return`,
    })
    return json({
      ok: true,
      checkout_url: session.checkout_url,
      payment_session_id: session.payment_session_id,
    })
  } catch (e) {
    const msg = (e as Error).message
    console.error('[checkout] create failed:', msg)
    // Don't leak Dodo internals to the client.
    return json({ ok: false, code: 'UPSTREAM_ERROR', message: 'could not create checkout session' }, 502)
  }
}

// ─── Dodo webhook handler ───────────────────────────────────────
//
// Contract:
//   * Signature verified via Standard Webhooks HMAC (shared/dodoWebhook.ts).
//     On any verification failure we return 401 — Dodo will retry.
//   * Idempotency on webhook-id, enforced server-side by the
//     process_topup_webhook / process_topup_terminal RPCs (UNIQUE on
//     topups.provider_event_id + ON CONFLICT DO NOTHING).
//   * We 200-ACK any event we've recognized and persisted, including
//     duplicates. We only return non-2xx for true protocol-level errors
//     (bad signature, DB failure) where a retry could help.
//   * Unknown event types are 200-ACKed with a log line — Dodo's catalog
//     can grow without breaking us.

// Dodo event payload shape we depend on. Kept narrow — we don't try to model
// the full Dodo schema; just what we read.
interface DodoEvent {
  type?: string
  data?: {
    payload_type?: string
    payment_id?: string
    total_amount?: number          // in subunits (cents for USD)
    settlement_amount?: number
    currency?: string
    customer?: { email?: string; customer_id?: string }
    metadata?: Record<string, string>
    status?: string
  }
}

async function handleDodoWebhook(req: Request, env: PaymentsEnv): Promise<Response> {
  // 1. Read raw body ONCE — Workers can't re-read, and HMAC needs the exact bytes.
  let rawBody: string
  try {
    rawBody = await req.text()
  } catch {
    return json({ ok: false, code: 'BAD_REQUEST', message: 'could not read body' }, 400)
  }

  // 2. Verify signature.
  const verified = await verifyDodoWebhook(req.headers, rawBody, env.DODO_WEBHOOK_SECRET)
  if (!verified.ok) {
    console.warn('[webhook:dodo] verification failed:', verified.code, verified.detail)
    // 401 invites Dodo to retry — appropriate for signature/timestamp failures
    // since transient clock skew can trigger STALE_TIMESTAMP at the edge of
    // the replay window. (BAD_SECRET_FORMAT is a config bug on our side and
    // also benefits from a retry while we fix it.)
    return json({ ok: false, code: 'UNAUTHORIZED', message: 'signature' }, 401)
  }

  // 3. Dispatch by event type.
  const evt = verified.body as DodoEvent
  const eventType = evt.type
  if (!eventType) {
    console.warn('[webhook:dodo] event missing type, id:', verified.id)
    return ack()
  }

  try {
    if (eventType === 'payment.succeeded') {
      await onPaymentSucceeded(env, verified.id, evt)
    } else if (eventType === 'payment.failed' || eventType === 'payment.cancelled') {
      await onPaymentTerminal(env, verified.id, evt, 'failed')
    } else if (eventType === 'refund.succeeded') {
      await onPaymentTerminal(env, verified.id, evt, 'refunded')
    } else if (
      eventType === 'dispute.opened' ||
      eventType === 'dispute.lost' ||
      eventType === 'dispute.won' ||
      eventType === 'dispute.accepted'
    ) {
      // v1: log + alert manually. v2 will freeze the account on dispute.opened.
      console.warn('[webhook:dodo] dispute event:', eventType, 'payment_id:', evt.data?.payment_id)
    } else {
      console.log('[webhook:dodo] unhandled event type:', eventType)
    }
  } catch (e) {
    // Persistence error → 500. Dodo will retry. This is the right behavior
    // for transient Supabase outages; it'd be wrong for permanent bugs but
    // the dispatch table above is small enough that bug-induced retries are
    // visible quickly.
    console.error('[webhook:dodo] handler error:', (e as Error).message, 'type:', eventType)
    return json({ ok: false, code: 'INTERNAL_ERROR', message: 'persistence' }, 500)
  }

  return ack()
}

function ack(): Response {
  return json({ ok: true })
}

/** Credit a user's wallet for a successful payment. Idempotent on webhook-id. */
async function onPaymentSucceeded(env: PaymentsEnv, eventId: string, evt: DodoEvent): Promise<void> {
  const d = evt.data ?? {}
  const userId = d.metadata?.user_id
  const creditCentsRaw = d.metadata?.credit_cents
  const paymentId = d.payment_id
  const currency = (d.currency ?? 'usd').toLowerCase()

  if (!userId || !paymentId) {
    console.warn('[webhook:dodo] payment.succeeded missing user_id or payment_id; event:', eventId)
    return
  }
  const creditCents = Number(creditCentsRaw)
  if (!Number.isFinite(creditCents) || creditCents <= 0) {
    console.warn(
      '[webhook:dodo] payment.succeeded bad credit_cents metadata; event:', eventId,
      'value:', creditCentsRaw,
    )
    return
  }

  const result = await rpc<Array<{ topup_id: string; new_balance: number; is_duplicate: boolean }>>(
    env,
    'process_topup_webhook',
    {
      p_event_id: eventId,
      p_payment_id: paymentId,
      p_user_id: userId,
      p_amount_cents: creditCents,
      p_currency: currency,
      p_raw: evt,
    },
  )
  if (!result || result.length === 0) {
    throw new Error('process_topup_webhook returned empty')
  }
  const { is_duplicate, new_balance } = result[0]

  if (is_duplicate) {
    console.log('[webhook:dodo] duplicate payment.succeeded ack; event:', eventId)
    return
  }

  // Update the KV cache so the next pipeline call sees the fresh balance
  // without a Supabase round-trip. Non-critical: cache TTL would catch up
  // within an hour anyway, but doing it here means the user's next
  // dictation after top-up shows the new balance instantly.
  try {
    await setBalance(env.USER_BALANCE, userId, new_balance)
  } catch (e) {
    console.warn('[webhook:dodo] KV cache update failed (will reconcile via TTL):', (e as Error).message)
  }
}

// ─── GET /v1/payment/:id ────────────────────────────────────────
// Authoritative status read from Dodo. Used by the desktop app's
// reconciliation polling — when the browser redirect fails (closed tab,
// blocked popup), the app polls this until status === 'succeeded' (the
// webhook is the source of truth for crediting, but the app needs a way
// to KNOW when to stop polling).
//
// Authorization: JWT-authed AND we verify metadata.user_id matches the
// caller. Otherwise any user could enumerate payments by ID.

async function handlePaymentLookup(
  env: PaymentsEnv,
  userId: string,
  paymentId: string,
): Promise<Response> {
  if (!paymentId || !/^[A-Za-z0-9_\-]{1,128}$/.test(paymentId)) {
    return json({ ok: false, code: 'BAD_REQUEST', message: 'invalid payment id' }, 400)
  }
  let payment
  try {
    payment = await getPayment(env, paymentId)
  } catch (e) {
    console.error('[payment-lookup] dodo error:', (e as Error).message)
    return json({ ok: false, code: 'UPSTREAM_ERROR', message: 'lookup failed' }, 502)
  }
  if (!payment) {
    return json({ ok: false, code: 'NOT_FOUND', message: 'payment not found' }, 404)
  }
  const ownerId = (payment.metadata?.user_id as string | undefined) ?? null
  if (ownerId !== userId) {
    // Don't leak that the payment exists — return 404, not 403.
    return json({ ok: false, code: 'NOT_FOUND', message: 'payment not found' }, 404)
  }
  return json({
    ok: true,
    data: {
      id: payment.id,
      status: payment.status,
      amount: payment.amount,
      currency: payment.currency,
    },
  })
}

/** Record a failed/refunded payment for audit. Does NOT touch balance. */
async function onPaymentTerminal(
  env: PaymentsEnv,
  eventId: string,
  evt: DodoEvent,
  status: 'failed' | 'refunded',
): Promise<void> {
  const d = evt.data ?? {}
  const userId = d.metadata?.user_id
  const creditCents = Number(d.metadata?.credit_cents ?? d.total_amount ?? 0)
  const paymentId = d.payment_id
  const currency = (d.currency ?? 'usd').toLowerCase()

  if (!userId || !paymentId) {
    console.warn('[webhook:dodo]', status, 'missing user_id or payment_id; event:', eventId)
    return
  }

  await rpc(env, 'process_topup_terminal', {
    p_event_id: eventId,
    p_payment_id: paymentId,
    p_user_id: userId,
    p_amount_cents: creditCents,
    p_currency: currency,
    p_status: status,
    p_raw: evt,
  })
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
