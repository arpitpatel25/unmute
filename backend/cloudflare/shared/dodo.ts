// Dodo Payments REST API wrapper.
//
// Thin wrapper around the two endpoints we need for v1:
//   * POST /checkouts        — create a hosted checkout session
//   * GET  /payments/{id}    — fetch payment status (used by the app to
//                              reconcile if the user closed the browser
//                              before the redirect)
//
// Notes:
//   - Hosts: test  → https://test.dodopayments.com
//            live  → https://live.dodopayments.com
//     Picked via env.DODO_API_BASE.
//   - Auth: Bearer token (env.DODO_API_KEY).
//   - Products are created out-of-band in the Dodo dashboard; their IDs are
//     plumbed via env.DODO_TOPUP_PRODUCTS (JSON map of cents → product_id).
//   - "Credit-topup" framing: passing credit_cents in metadata lets the
//     webhook handler know exactly how much to credit without re-deriving
//     from product_id (defensive — products can be misconfigured).

import type { PaymentsEnv } from './types'

export interface DodoTopupConfig {
  /** {"1000":"prod_topup_10","2500":"prod_topup_25", ...} */
  productByCents: Record<string, string>
}

/** Parse the JSON env var into a usable map. Throws on malformed config —
 *  worker startup should fail loud rather than silently default. */
export function parseTopupConfig(env: PaymentsEnv): DodoTopupConfig {
  const raw = env.DODO_TOPUP_PRODUCTS
  if (!raw) throw new Error('DODO_TOPUP_PRODUCTS env var not set')
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>
  } catch (e) {
    throw new Error(`DODO_TOPUP_PRODUCTS not valid JSON: ${(e as Error).message}`)
  }
  const productByCents: Record<string, string> = {}
  for (const [cents, pid] of Object.entries(parsed)) {
    if (typeof pid !== 'string' || !pid) {
      throw new Error(`DODO_TOPUP_PRODUCTS: product_id for ${cents} not a string`)
    }
    if (!/^\d+$/.test(cents) || Number(cents) <= 0) {
      throw new Error(`DODO_TOPUP_PRODUCTS: ${cents} not a positive integer (cents)`)
    }
    productByCents[cents] = pid
  }
  return { productByCents }
}

export interface CreateCheckoutInput {
  amountCents: number
  userId: string
  userEmail: string
  returnUrl: string
}

export interface CheckoutSession {
  /** Hosted checkout URL — the client opens this in the system browser. */
  checkout_url: string
  /** Dodo's session ID, useful for support / reconciliation. */
  payment_session_id?: string
}

/**
 * Create a Dodo hosted checkout session for one of our top-up tiers.
 *
 * Throws Error with a code-shaped message on failure. The caller maps that
 * to a Worker response (4xx vs 5xx) — don't echo Dodo's raw error body to
 * the user.
 */
export async function createCheckoutSession(
  env: PaymentsEnv,
  cfg: DodoTopupConfig,
  input: CreateCheckoutInput,
): Promise<CheckoutSession> {
  const productId = cfg.productByCents[String(input.amountCents)]
  if (!productId) {
    throw new Error(`UNSUPPORTED_AMOUNT:${input.amountCents}`)
  }

  // Standard fields per Dodo's Checkout Sessions docs. metadata flows through
  // to the webhook so the handler can credit the right user.
  const reqBody = {
    product_cart: [{ product_id: productId, quantity: 1 }],
    customer: { email: input.userEmail },
    metadata: {
      user_id: input.userId,
      credit_cents: String(input.amountCents),
    },
    return_url: input.returnUrl,
  }

  const res = await fetch(`${env.DODO_API_BASE}/checkouts`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.DODO_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(reqBody),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '<no body>')
    throw new Error(`DODO_API_ERROR:${res.status}:${detail.slice(0, 200)}`)
  }
  const data = (await res.json()) as { checkout_url?: string; payment_session_id?: string }
  if (!data.checkout_url) {
    throw new Error('DODO_API_ERROR:200:missing checkout_url in response')
  }
  return {
    checkout_url: data.checkout_url,
    payment_session_id: data.payment_session_id,
  }
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
