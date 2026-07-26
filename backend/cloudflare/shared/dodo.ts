// Dodo Payments REST API wrapper.
//
// Thin wrapper around the endpoints we need:
//   * POST /checkouts                                   — create a hosted
//                                                         subscription checkout
//   * POST /customers/{id}/customer-portal/session      — manage subscription
//   * GET  /payments/{id}                               — fetch payment status
//                                                         (reconciliation)
//
// Notes:
//   - Hosts: test  → https://test.dodopayments.com
//            live  → https://live.dodopayments.com
//     Picked via env.DODO_API_BASE / the apiBase arg.
//   - Auth: Bearer token (env.DODO_API_KEY / the apiKey arg).
//   - Recurring products are created out-of-band in the Dodo dashboard; their
//     IDs are plumbed via env.DODO_SUBSCRIPTION_PRODUCTS (JSON map of
//     "<plan>:<interval>" → product_id).

import type { PaymentsEnv } from './types'

// ─── Subscriptions ──────────────────────────────────────────────
//
// Recurring billing replaces one-time top-ups. A subscription checkout is
// created the same way as a one-time checkout (POST /checkouts) — the only
// difference is the product_id points at a recurring product. metadata flows
// through to subscription.* webhooks so the handler can resolve the user.

export interface CreateSubscriptionCheckoutInput {
  apiBase: string
  apiKey: string
  productId: string
  userId: string
  email: string
  returnUrl: string
}

export interface SubscriptionCheckout {
  /** Hosted checkout URL — the client opens this in the system browser. */
  checkoutUrl: string
}

/**
 * Create a Dodo hosted checkout session for a recurring subscription product.
 *
 * Throws Error with a code-shaped message on failure — the caller maps that
 * to a Worker response (don't echo Dodo's raw error body to the user).
 */
export async function createSubscriptionCheckout(
  { apiBase, apiKey, productId, userId, email, returnUrl }: CreateSubscriptionCheckoutInput,
  fetchImpl: typeof fetch = fetch,
): Promise<SubscriptionCheckout> {
  const reqBody = {
    product_cart: [{ product_id: productId, quantity: 1 }],
    customer: { email },
    metadata: { user_id: userId },
    return_url: returnUrl,
  }

  const res = await fetchImpl(`${apiBase}/checkouts`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(reqBody),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '<no body>')
    throw new Error(`DODO_API_ERROR:${res.status}:${detail.slice(0, 200)}`)
  }
  const data = (await res.json()) as { checkout_url?: string; payment_link?: string }
  const checkoutUrl = data.checkout_url ?? data.payment_link
  if (!checkoutUrl) {
    throw new Error('DODO_API_ERROR:200:missing checkout_url in response')
  }
  return { checkoutUrl }
}

export interface CreatePortalSessionInput {
  apiBase: string
  apiKey: string
  customerId: string
}

export interface PortalSession {
  /** Hosted customer-portal URL — the client opens this in the system browser. */
  portalUrl: string
}

/**
 * Create a Dodo customer-portal session so a subscriber can manage / cancel
 * their subscription. Throws on failure (same code-shaped message style).
 */
export async function createPortalSession(
  { apiBase, apiKey, customerId }: CreatePortalSessionInput,
  fetchImpl: typeof fetch = fetch,
): Promise<PortalSession> {
  const res = await fetchImpl(
    `${apiBase}/customers/${encodeURIComponent(customerId)}/customer-portal/session`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    },
  )
  if (!res.ok) {
    const detail = await res.text().catch(() => '<no body>')
    throw new Error(`DODO_API_ERROR:${res.status}:${detail.slice(0, 200)}`)
  }
  const data = (await res.json()) as { link?: string; url?: string }
  const portalUrl = data.link ?? data.url
  if (!portalUrl) {
    throw new Error('DODO_API_ERROR:200:missing portal link in response')
  }
  return { portalUrl }
}

// ─── Change plan (in-app upgrade) ───────────────────────────────
//
// Upgrade an existing subscription to a different product (Dictation →
// Unmute) in place, so the subscriber pays only the prorated difference
// instead of starting a second subscription. The subscription.plan_changed
// webhook flips entitlement afterward.

export interface ChangePlanInput {
  apiBase: string
  apiKey: string
  subscriptionId: string
  productId: string
  quantity?: number
  prorationMode?: string
}

/**
 * Change an existing subscription's plan via Dodo's change-plan endpoint.
 *
 * Effective immediately, prorated; if the payment fails the change is
 * prevented (the subscription stays on its current plan). Returns
 * { ok: true } on a 2xx; throws a code-shaped error (status + body text) on
 * any non-2xx — the caller maps that to a Worker response. Dodo statuses we
 * care about: 200 ok, 409 pending change exists, 422 inactive/on-demand.
 */
export async function changePlan(
  {
    apiBase,
    apiKey,
    subscriptionId,
    productId,
    quantity = 1,
    prorationMode = 'difference_immediately',
  }: ChangePlanInput,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true }> {
  const reqBody = {
    product_id: productId,
    quantity,
    proration_billing_mode: prorationMode,
    effective_at: 'immediately',
    // apply_change: flip the plan to Unmute IMMEDIATELY and settle the prorated
    // charge in the background (UPI auto-debit is async / slow). If that charge
    // ultimately fails, Dodo fires subscription.on_hold → our webhook revokes
    // access. This is the standard optimistic-upgrade UX; the alternative
    // (prevent_change) leaves the upgrade hanging until the slow UPI charge clears.
    on_payment_failure: 'apply_change',
  }

  const res = await fetchImpl(
    `${apiBase}/subscriptions/${encodeURIComponent(subscriptionId)}/change-plan`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(reqBody),
    },
  )
  if (!res.ok) {
    const detail = await res.text().catch(() => '<no body>')
    throw new Error(`DODO_API_ERROR:${res.status}:${detail.slice(0, 200)}`)
  }
  return { ok: true }
}

// ─── Cancel a subscription ──────────────────────────────────────
//
// Used by the duplicate-subscription reconciler: if a user ends up billed on
// two live subscriptions at once, we cancel the redundant one rather than
// leaving them double-charged.
//
// Endpoint shape verified against the live API (2026-07-26): a PATCH with an
// invalid status returns
//   "status: unknown variant `__probe__`, expected one of `pending`, `active`,
//    `on_hold`, `cancelled`, `failed`, `expired`"
// so `status: 'cancelled'` cancels immediately. `cancel_at_next_billing_date`
// is the softer alternative (stops renewing, keeps the paid period) and is
// what we use when the duplicate has already been consumed.

export interface CancelSubscriptionInput {
  apiBase: string
  apiKey: string
  subscriptionId: string
  /**
   * true  → cancel now (the redundant-charge case; pair with a refund).
   * false → stop renewing but honour the period already paid for.
   */
  immediate?: boolean
  reason?: string
  comment?: string
}

export async function cancelSubscription(
  { apiBase, apiKey, subscriptionId, immediate = true, reason = 'cancelled_by_merchant', comment }: CancelSubscriptionInput,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true }> {
  const reqBody: Record<string, unknown> = immediate
    ? { status: 'cancelled', cancel_reason: reason }
    : { cancel_at_next_billing_date: true, cancel_reason: reason }
  if (comment) reqBody.cancellation_comment = comment

  const res = await fetchImpl(`${apiBase}/subscriptions/${encodeURIComponent(subscriptionId)}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(reqBody),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '<no body>')
    throw new Error(`DODO_API_ERROR:${res.status}:${detail.slice(0, 200)}`)
  }
  return { ok: true }
}

/** Minimal shape of a Dodo payment — we only read what we need. */
export interface DodoPayment {
  id: string
  status: 'pending' | 'processing' | 'succeeded' | 'failed' | 'cancelled' | string
  amount?: number
  currency?: string
  metadata?: Record<string, unknown>
  customer?: { email?: string }
}

/**
 * Fetch a payment's current status by ID.
 *
 * Used by the app's reconciliation path: if the user closed the browser
 * before redirect, the app polls /v1/payment/:id until the webhook lands.
 */
export async function getPayment(env: PaymentsEnv, paymentId: string): Promise<DodoPayment | null> {
  const res = await fetch(`${env.DODO_API_BASE}/payments/${encodeURIComponent(paymentId)}`, {
    headers: {
      Authorization: `Bearer ${env.DODO_API_KEY}`,
      Accept: 'application/json',
    },
  })
  if (res.status === 404) return null
  if (!res.ok) {
    const detail = await res.text().catch(() => '<no body>')
    throw new Error(`DODO_API_ERROR:${res.status}:${detail.slice(0, 200)}`)
  }
  return (await res.json()) as DodoPayment
}
