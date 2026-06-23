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
import { getPayment, createSubscriptionCheckout, createPortalSession, changePlan } from '../../shared/dodo'
import { verifyDodoWebhook } from '../../shared/dodoWebhook'

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
    if (req.method === 'POST' && url.pathname === '/checkout/subscription') {
      return handleSubscriptionCheckout(req, env, userId, payload.email)
    }
    if (req.method === 'POST' && url.pathname === '/portal') {
      return handlePortal(env, userId)
    }
    if (req.method === 'POST' && url.pathname === '/change-plan') {
      return handleChangePlan(env, userId)
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

// ─── Subscription product map ───────────────────────────────────
// DODO_SUBSCRIPTION_PRODUCTS is a JSON map of "<plan>:<interval>" → product_id.
// Parsed lazily per-request (cheap; the worker stays stateless).

type SubscriptionProductMap = Record<string, string>

function parseSubscriptionProducts(env: PaymentsEnv): SubscriptionProductMap {
  const raw = env.DODO_SUBSCRIPTION_PRODUCTS
  if (!raw) throw new Error('DODO_SUBSCRIPTION_PRODUCTS env var not set')
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>
  } catch (e) {
    throw new Error(`DODO_SUBSCRIPTION_PRODUCTS not valid JSON: ${(e as Error).message}`)
  }
  const map: SubscriptionProductMap = {}
  for (const [key, pid] of Object.entries(parsed)) {
    if (typeof pid !== 'string' || !pid) {
      throw new Error(`DODO_SUBSCRIPTION_PRODUCTS: product_id for ${key} not a string`)
    }
    map[key] = pid
  }
  return map
}

/** Reverse-lookup the "<plan>:<interval>" key for a given product_id. */
function productIdToKey(env: PaymentsEnv, productId: string): string | null {
  let map: SubscriptionProductMap
  try {
    map = parseSubscriptionProducts(env)
  } catch {
    return null
  }
  for (const [key, pid] of Object.entries(map)) {
    if (pid === productId) return key
  }
  return null
}

/** Reverse-lookup the plan (part before ':') for a Dodo product_id. */
function productIdToPlan(env: PaymentsEnv, productId: string): string | null {
  const key = productIdToKey(env, productId)
  return key ? (key.split(':')[0] ?? null) : null
}

/** Reverse-lookup the interval (part after ':') for a Dodo product_id. */
function productIdToInterval(env: PaymentsEnv, productId: string): string | null {
  const key = productIdToKey(env, productId)
  return key ? (key.split(':')[1] ?? null) : null
}

// ─── POST /checkout/subscription ────────────────────────────────
// Body: { plan: 'dictation'|'unmute', interval: 'month'|'year' }
// Returns: { ok: true, checkoutUrl }
//
// Client opens checkoutUrl in the system browser (NOT an Electron
// BrowserWindow — UPI/3DS/Apple Pay break in embedded webviews).

interface SubscriptionCheckoutRequest {
  plan?: string
  interval?: string
}

async function handleSubscriptionCheckout(
  req: Request,
  env: PaymentsEnv,
  userId: string,
  userEmail: string | undefined,
): Promise<Response> {
  let body: SubscriptionCheckoutRequest
  try {
    body = (await req.json()) as SubscriptionCheckoutRequest
  } catch {
    return json({ ok: false, code: 'BAD_REQUEST', message: 'invalid JSON' }, 400)
  }
  const { plan, interval } = body
  if (plan !== 'dictation' && plan !== 'unmute') {
    return json({ ok: false, code: 'BAD_REQUEST', message: 'plan must be dictation or unmute' }, 400)
  }
  if (interval !== 'month' && interval !== 'year') {
    return json({ ok: false, code: 'BAD_REQUEST', message: 'interval must be month or year' }, 400)
  }
  if (!userEmail) {
    // Supabase JWTs from email/password and OAuth flows include email; if
    // it's missing, the account is in some non-standard state. Fail loud.
    return json({ ok: false, code: 'BAD_REQUEST', message: 'user has no email on file' }, 400)
  }

  let products: SubscriptionProductMap
  try {
    products = parseSubscriptionProducts(env)
  } catch (e) {
    console.error('[checkout:sub] bad config:', (e as Error).message)
    return json({ ok: false, code: 'INTERNAL_ERROR', message: 'checkout misconfigured' }, 500)
  }

  const productId = products[`${plan}:${interval}`]
  if (!productId) {
    return json(
      { ok: false, code: 'BAD_REQUEST', message: `no product for ${plan}:${interval}` },
      400,
    )
  }

  // Double-subscribe guard: if the caller already has an active subscription,
  // creating a second Dodo checkout would charge them twice. Read their active
  // sub from Supabase via PostgREST (same query handleChangePlan uses) and
  // refuse with 409 { already_subscribed } so the UI can surface it gently.
  try {
    const subUrl =
      `${env.SUPABASE_URL}/rest/v1/subscriptions` +
      `?user_id=eq.${userId}&status=eq.active` +
      `&select=dodo_subscription_id&order=updated_at.desc&limit=1`
    const res = await fetch(subUrl, {
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        Accept: 'application/json',
      },
    })
    if (res.ok) {
      const rows = (await res.json()) as Array<{ dodo_subscription_id: string | null }>
      if (rows[0]?.dodo_subscription_id) {
        return json({ ok: false, error: 'already_subscribed' }, 409)
      }
    } else {
      // A read failure here shouldn't hard-block checkout — log and proceed.
      // The worst case is a rare double-sub, which the portal can refund; a
      // false 500 here would block a legitimate first subscription.
      console.warn('[checkout:sub] active-sub guard read failed:', res.status)
    }
  } catch (e) {
    console.warn('[checkout:sub] active-sub guard threw:', (e as Error).message)
  }

  try {
    const session = await createSubscriptionCheckout({
      apiBase: env.DODO_API_BASE,
      apiKey: env.DODO_API_KEY,
      productId,
      userId,
      email: userEmail,
      returnUrl: `${env.PUBLIC_API_BASE}/checkout/return`,
    })
    return json({ ok: true, checkoutUrl: session.checkoutUrl })
  } catch (e) {
    const msg = (e as Error).message
    console.error('[checkout:sub] create failed:', msg)
    // Don't leak Dodo internals to the client.
    return json({ ok: false, code: 'UPSTREAM_ERROR', message: 'could not create checkout session' }, 502)
  }
}

// ─── POST /portal ───────────────────────────────────────────────
// Returns: { ok: true, portalUrl } for the caller to manage their
// subscription, or 409 { error: 'no_subscription' } if they have no Dodo
// customer on file (never subscribed).

async function handlePortal(env: PaymentsEnv, userId: string): Promise<Response> {
  // Read the caller's dodo_customer_id from profiles via PostgREST.
  const profUrl = `${env.SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&select=dodo_customer_id`
  let customerId: string | null = null
  try {
    const res = await fetch(profUrl, {
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        Accept: 'application/json',
      },
    })
    if (!res.ok) {
      console.error('[portal] profile read failed:', res.status)
      return json({ ok: false, code: 'INTERNAL_ERROR', message: 'profile lookup failed' }, 500)
    }
    const rows = (await res.json()) as Array<{ dodo_customer_id: string | null }>
    customerId = rows[0]?.dodo_customer_id ?? null
  } catch (e) {
    console.error('[portal] profile read threw:', (e as Error).message)
    return json({ ok: false, code: 'INTERNAL_ERROR', message: 'profile lookup failed' }, 500)
  }

  if (!customerId) {
    return json({ error: 'no_subscription' }, 409)
  }

  try {
    const session = await createPortalSession({
      apiBase: env.DODO_API_BASE,
      apiKey: env.DODO_API_KEY,
      customerId,
    })
    return json({ ok: true, portalUrl: session.portalUrl })
  } catch (e) {
    console.error('[portal] create failed:', (e as Error).message)
    return json({ ok: false, code: 'UPSTREAM_ERROR', message: 'could not create portal session' }, 502)
  }
}

// ─── POST /change-plan ──────────────────────────────────────────
// In-app upgrade: Dictation → Unmute on the user's EXISTING subscription via
// Dodo's change-plan endpoint, so they pay only the prorated difference (no
// second subscription). The target Unmute interval matches the user's current
// interval (month→month / year→year). We do NOT touch Supabase here — the
// subscription.plan_changed webhook flips entitlement once Dodo confirms.
//
// Returns: { ok: true } on success. Mapped failures:
//   no active subscription → 409 { error: 'no_active_subscription' }
//   already on unmute      → 400 { error: 'already_unmute' }
//   product not configured → 500 { error: 'product_not_configured' }
//   Dodo 409 (pending)     → { ok: false, error: 'change_pending' }
//   Dodo 422 (inactive)    → { ok: false, error: 'not_upgradeable' }
//   anything else          → { ok: false, error: 'upgrade_failed', message }

async function handleChangePlan(env: PaymentsEnv, userId: string): Promise<Response> {
  // Read the caller's CURRENT active subscription from Supabase via PostgREST
  // (mirrors how /portal reads profiles).
  const subUrl =
    `${env.SUPABASE_URL}/rest/v1/subscriptions` +
    `?user_id=eq.${userId}&status=eq.active` +
    `&select=dodo_subscription_id,plan,interval&order=updated_at.desc&limit=1`
  let sub: { dodo_subscription_id: string; plan: string; interval: string } | null = null
  try {
    const res = await fetch(subUrl, {
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        Accept: 'application/json',
      },
    })
    if (!res.ok) {
      console.error('[change-plan] subscription read failed:', res.status)
      return json({ ok: false, code: 'INTERNAL_ERROR', message: 'subscription lookup failed' }, 500)
    }
    const rows = (await res.json()) as Array<{
      dodo_subscription_id: string
      plan: string
      interval: string
    }>
    sub = rows[0] ?? null
  } catch (e) {
    console.error('[change-plan] subscription read threw:', (e as Error).message)
    return json({ ok: false, code: 'INTERNAL_ERROR', message: 'subscription lookup failed' }, 500)
  }

  if (!sub || !sub.dodo_subscription_id) {
    return json({ error: 'no_active_subscription' }, 409)
  }
  if (sub.plan === 'unmute') {
    return json({ error: 'already_unmute' }, 400)
  }

  // Resolve the target Unmute product matching the user's current interval.
  let products: SubscriptionProductMap
  try {
    products = parseSubscriptionProducts(env)
  } catch (e) {
    console.error('[change-plan] bad config:', (e as Error).message)
    return json({ error: 'product_not_configured' }, 500)
  }
  const targetProductId = products[`unmute:${sub.interval}`]
  if (!targetProductId) {
    return json({ error: 'product_not_configured' }, 500)
  }

  try {
    await changePlan({
      apiBase: env.DODO_API_BASE,
      apiKey: env.DODO_API_KEY,
      subscriptionId: sub.dodo_subscription_id,
      productId: targetProductId,
    })
    // Entitlement flips via the subscription.plan_changed webhook; don't write
    // Supabase here.
    return json({ ok: true })
  } catch (e) {
    const msg = (e as Error).message
    console.error('[change-plan] dodo change-plan failed:', msg)
    // Error message shape from changePlan: "DODO_API_ERROR:<status>:<body>".
    const status = Number(msg.split(':')[1])
    if (status === 409) {
      return json({ ok: false, error: 'change_pending' })
    }
    if (status === 422) {
      return json({ ok: false, error: 'not_upgradeable' })
    }
    return json({ ok: false, error: 'upgrade_failed', message: msg })
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
    subscription_id?: string
    product_id?: string
    next_billing_date?: string
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
    if (eventType.startsWith('subscription.')) {
      // The only crediting/entitlement path now: upsert the subscription and
      // denormalize entitlement onto profiles (idempotent on webhook-id).
      await onSubscriptionEvent(env, verified.id, evt)
    } else if (
      eventType === 'dispute.opened' ||
      eventType === 'dispute.lost' ||
      eventType === 'dispute.won' ||
      eventType === 'dispute.accepted'
    ) {
      // v1: log + alert manually. v2 will freeze the account on dispute.opened.
      console.warn('[webhook:dodo] dispute event:', eventType, 'payment_id:', evt.data?.payment_id)
    } else {
      // Renewal payment.* events, refunds, and anything else: no crediting.
      // Entitlement is driven entirely by subscription.* events, so we just
      // ACK these to keep Dodo from retrying.
      console.log('[webhook:dodo] non-subscription event acked:', eventType)
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

/**
 * Process a Dodo subscription.* event: upsert the subscription row and
 * denormalize entitlement onto profiles. Idempotent on webhook-id (the RPC
 * dedupes via processed_events). This is the only path that grants/revokes
 * access now that crediting is gone.
 */
async function onSubscriptionEvent(env: PaymentsEnv, eventId: string, evt: DodoEvent): Promise<void> {
  const d = evt.data ?? {}
  const userId = d.metadata?.user_id
  const subscriptionId = d.subscription_id
  const productId = d.product_id

  if (!userId || !subscriptionId || !productId) {
    console.warn(
      '[webhook:dodo] subscription event missing user_id/subscription_id/product_id; event:', eventId,
    )
    return
  }

  await rpc(env, 'process_subscription_event', {
    p_event_id: eventId,
    p_subscription_id: subscriptionId,
    p_customer_id: d.customer?.customer_id ?? null,
    p_user_id: userId,
    p_plan: productIdToPlan(env, productId),
    p_interval: productIdToInterval(env, productId),
    p_status: d.status,
    p_period_end: d.next_billing_date ?? null,
    p_product_id: productId,
  })
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
