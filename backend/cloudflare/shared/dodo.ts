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
