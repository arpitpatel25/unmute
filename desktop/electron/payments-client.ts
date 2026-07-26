// Main-process client for the payments worker.
//
// Endpoints:
//   * POST /checkout/subscription — mint a Dodo hosted subscription checkout URL
//   * POST /portal                — mint a Dodo customer-portal URL (manage sub)
//   * GET  /v1/ledger             — recent wallet_ledger rows (usage history)
//   * GET  /v1/payment/:id        — authoritative payment status (reconcile)
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
  checkoutUrl?: string
  portal_url?: string
  portalUrl?: string
  payment_session_id?: string
  error?: string
  code?: string
  message?: string
  // Dodo subscription status accompanying a 409 already_subscribed. Named to
  // avoid `status`, which callPayments overwrites with the HTTP status below.
  subscription_status?: string
}

async function callPayments<T>(
  path: string,
  init: RequestInit,
  token: string,
): Promise<Envelope<T> & { status: number }> {
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
    return { ok: false, code: 'BAD_RESPONSE', message: `HTTP ${res.status} non-JSON body`, status: res.status }
  }
  if (!res.ok && body.ok !== false) {
    body.ok = false
    body.code = body.code ?? `HTTP_${res.status}`
  }
  return { ...body, status: res.status }
}

// ─── /checkout/subscription ─────────────────────────────────────

export type SubscriptionPlan = 'dictation' | 'unmute'
export type SubscriptionInterval = 'month' | 'year'

export interface CreateSubscriptionResult {
  ok: boolean
  checkoutUrl?: string
  alreadySubscribed?: boolean
  /** Dodo status of the subscription they already hold, when known. */
  subscriptionStatus?: string
  code?: string
  message?: string
}

export async function createSubscriptionCheckout(
  plan: SubscriptionPlan,
  interval: SubscriptionInterval,
  token: string,
): Promise<CreateSubscriptionResult> {
  const env = await callPayments<unknown>(
    '/checkout/subscription',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan, interval }),
    },
    token,
  )
  // Worker returns 409 { error: 'already_subscribed' } when the caller already
  // holds a LIVE subscription — creating a second checkout would double-charge.
  // subscription_status says which kind, so an on_hold subscriber gets pointed
  // at their card rather than told they're fine.
  if (env.status === 409 || env.error === 'already_subscribed') {
    return {
      ok: false,
      alreadySubscribed: true,
      subscriptionStatus: env.subscription_status,
      code: env.code,
      message: env.message ?? env.error,
    }
  }
  return {
    ok: !!env.ok,
    checkoutUrl: env.checkoutUrl ?? env.checkout_url,
    code: env.code,
    message: env.message ?? env.error,
  }
}

// ─── /portal ────────────────────────────────────────────────────

export interface OpenPortalResult {
  ok: boolean
  portalUrl?: string
  noSubscription?: boolean
  code?: string
  message?: string
}

export async function openCustomerPortal(token: string): Promise<OpenPortalResult> {
  const env = await callPayments<unknown>('/portal', { method: 'POST' }, token)
  // Worker returns 409 { error: 'no_subscription' } when the user has never
  // had a Dodo customer record (e.g. never subscribed). Surface as a friendly
  // flag rather than a hard error so the UI can hide the "Manage" affordance.
  if (env.status === 409 || env.error === 'no_subscription') {
    return { ok: false, noSubscription: true, code: env.code, message: env.message ?? env.error }
  }
  return {
    ok: !!env.ok,
    portalUrl: env.portalUrl ?? env.portal_url,
    code: env.code,
    message: env.message ?? env.error,
  }
}

// ─── /change-plan ───────────────────────────────────────────────
//
// In-app upgrade (Dictation → Unmute). The worker calls Dodo's change-plan on
// the user's existing subscription so they pay only the prorated difference.
// Tolerant of the worker's response shapes:
//   200 { ok: true }
//   409 { error: 'no_active_subscription' }      (no row)
//   400 { error: 'already_unmute' }
//   500 { error: 'product_not_configured' }
//   200 { ok: false, error: 'change_pending' | 'not_upgradeable' | 'upgrade_failed', message? }

export interface ChangePlanResult {
  ok: boolean
  error?: string
  message?: string
}

export async function changePlan(token: string): Promise<ChangePlanResult> {
  const env = await callPayments<unknown>('/change-plan', { method: 'POST' }, token)
  return {
    ok: !!env.ok,
    error: env.error ?? env.code,
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
