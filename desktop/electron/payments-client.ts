// Main-process client for the payments worker.
//
// Three endpoints:
//   * POST /checkout/session   — mint a Dodo hosted checkout URL
//   * GET  /v1/ledger          — recent wallet_ledger rows (usage history)
//   * GET  /v1/payment/:id     — authoritative payment status (reconcile)
//
// The renderer can't fetch the workers directly because:
//   1. JWT bearer lives in main-process keychain (auth-ipc.ts).
//   2. The worker URL is build-time defined (__PAYMENTS_URL__) and the
//      renderer doesn't have it in scope.
// So renderer calls go through IPC → here → fetch.

declare const __PAYMENTS_URL__: string

interface Envelope<T> {
  ok: boolean
  data?: T
  checkout_url?: string
  payment_session_id?: string
  code?: string
  message?: string
}

async function callPayments<T>(
  path: string,
  init: RequestInit,
  token: string,
): Promise<Envelope<T>> {
  const res = await fetch(`${__PAYMENTS_URL__}${path}`, {
    ...init,
    headers: {
      ...(init.headers || {}),
      Authorization: `Bearer ${token}`,
    },
  })
  let body: Envelope<T>
  try {
    body = (await res.json()) as Envelope<T>
  } catch {
    return { ok: false, code: 'BAD_RESPONSE', message: `HTTP ${res.status} non-JSON body` }
  }
  if (!res.ok && body.ok !== false) {
    body.ok = false
    body.code = body.code ?? `HTTP_${res.status}`
  }
  return body
}

// ─── /checkout/session ──────────────────────────────────────────

export interface CreateCheckoutResult {
  ok: boolean
  checkoutUrl?: string
  paymentSessionId?: string
  code?: string
  message?: string
}

export async function createCheckout(
  amountCents: number,
  token: string,
): Promise<CreateCheckoutResult> {
  const env = await callPayments<unknown>(
    '/checkout/session',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount_cents: amountCents }),
    },
    token,
  )
  return {
    ok: !!env.ok,
    checkoutUrl: env.checkout_url,
    paymentSessionId: env.payment_session_id,
    code: env.code,
    message: env.message,
  }
}

// ─── /v1/ledger ─────────────────────────────────────────────────

export interface LedgerRow {
  id: string
  created_at: string
  delta_cents: number
  source: 'topup' | 'usage' | 'refund' | 'adjustment' | 'starter' | string
  metadata: Record<string, unknown>
}

export async function fetchLedger(token: string): Promise<LedgerRow[]> {
  const env = await callPayments<LedgerRow[]>('/v1/ledger', { method: 'GET' }, token)
  if (!env.ok || !env.data) return []
  return env.data
}

// ─── /v1/payment/:id ────────────────────────────────────────────

export interface PaymentStatus {
  id: string
  status: string
  amount?: number
  currency?: string
}

export async function fetchPaymentStatus(
  paymentId: string,
  token: string,
): Promise<PaymentStatus | null> {
  const env = await callPayments<PaymentStatus>(
    `/v1/payment/${encodeURIComponent(paymentId)}`,
    { method: 'GET' },
    token,
  )
  if (!env.ok || !env.data) return null
  return env.data
}
