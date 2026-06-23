// Billing pane — lives inside the managed card (EnginePillars) / Settings.
//
// Subscription model (two tiers, hard paywall, no free trial):
//   * Dictation — $5.99/mo · $59/yr   (anchor $11.99)
//   * Unmute    — $8.99/mo · $89/yr   (anchor $17.99)  ← recommended
//   Annual cards show "~2 months free".
//
// Flow when the user clicks Subscribe:
//   a. paywallCreateSubscription(plan, interval) → Dodo hosted checkout URL
//   b. paywallOpenExternal(checkoutUrl) → system browser
//   c. App goes into "waiting" state. Two exits:
//      i.  paywallOnPaymentCallback fires (deep-link arrived) → re-poll status.
//      ii. Browser stays open / tab closed → polling kicks in:
//          paywallGetSubscription() every 3s for 5 min until active.
//
// "Manage subscription" opens the Dodo customer portal (paywallOpenPortal).

import { useEffect, useRef, useState } from 'react'
import { useAuth } from './AuthContext'

const POLL_INTERVAL_MS = 3000
const POLL_DEADLINE_MS = 5 * 60 * 1000

type Plan = 'dictation' | 'unmute'
type Interval = 'month' | 'year'

interface PlanCopy {
  plan: Plan
  name: string
  tagline: string
  anchorCents: number
  monthCents: number
  yearCents: number
  recommended?: boolean
}

const PLANS: PlanCopy[] = [
  {
    plan: 'dictation',
    name: 'Dictation',
    tagline: 'Fast, accurate cloud dictation everywhere.',
    anchorCents: 1199,
    monthCents: 599,
    yearCents: 5900,
  },
  {
    plan: 'unmute',
    name: 'Unmute',
    tagline: 'Dictation + Remote. The whole thing.',
    anchorCents: 1799,
    monthCents: 899,
    yearCents: 8900,
    recommended: true,
  },
]

type Phase =
  | { kind: 'idle' }
  | { kind: 'opening'; plan: Plan }
  | { kind: 'waiting'; plan: Plan }
  | { kind: 'success'; plan: Plan }
  | { kind: 'error'; message: string }

interface SubState {
  active: boolean
  plan: Plan | null
}

const dollars = (cents: number) =>
  cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`

export function Billing() {
  const auth = useAuth()
  const [billingInterval, setBillingInterval] = useState<Interval>('month')
  const [sub, setSub] = useState<SubState>({ active: false, plan: null })
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [portalNote, setPortalNote] = useState<string | null>(null)

  // Refresh subscription status on mount, and again when a checkout lands.
  useEffect(() => {
    refresh()
    window.electronAPI.paywallOnPaymentCallback?.(() => {
      // Don't trust the URL — re-poll authoritatively.
      refresh()
      setPhase((p) => (p.kind === 'waiting' ? { kind: 'success', plan: p.plan } : p))
    })
    window.electronAPI.paywallPopPendingPaymentCallback?.().then((url: string | null) => {
      if (url) refresh()
    })
    return () => window.electronAPI.removeAllListeners?.('paywall:payment-callback')
  }, [])

  async function refresh() {
    const s = await window.electronAPI.paywallGetSubscription?.()
    if (s) setSub({ active: !!s.active, plan: s.plan })
  }

  async function subscribe(plan: Plan) {
    if (!auth.signedIn) {
      auth.openSignIn()
      return
    }
    setPortalNote(null)
    setPhase({ kind: 'opening', plan })
    const result = await window.electronAPI.paywallCreateSubscription?.(plan, billingInterval)
    if (!result?.ok || !result.checkoutUrl) {
      setPhase({
        kind: 'error',
        message: result?.message ?? 'Could not open checkout. Try again in a moment.',
      })
      return
    }
    await window.electronAPI.paywallOpenExternal?.(result.checkoutUrl)
    setPhase({ kind: 'waiting', plan })
  }

  async function manageSubscription() {
    if (!auth.signedIn) {
      auth.openSignIn()
      return
    }
    setPortalNote(null)
    const result = await window.electronAPI.paywallOpenPortal?.()
    if (result?.noSubscription) {
      setPortalNote("You don't have a subscription yet — pick a plan above.")
      return
    }
    if (!result?.ok || !result.portalUrl) {
      setPortalNote(result?.message ?? 'Could not open the billing portal. Try again in a moment.')
      return
    }
    await window.electronAPI.paywallOpenExternal?.(result.portalUrl)
  }

  // Polling loop while in 'waiting' — exits when the subscription goes active.
  const pollRef = useRef<number | null>(null)
  useEffect(() => {
    if (phase.kind !== 'waiting') return
    const startedAt = Date.now()
    const tick = async () => {
      const s = await window.electronAPI.paywallGetSubscription?.()
      if (s?.active) {
        setSub({ active: true, plan: s.plan })
        setPhase({ kind: 'success', plan: phase.plan })
        return
      }
      if (Date.now() - startedAt > POLL_DEADLINE_MS) {
        setPhase({
          kind: 'error',
          message:
            "We didn't see your subscription activate within 5 minutes. If you completed checkout, it can take a moment — use refresh below.",
        })
        return
      }
      pollRef.current = window.setTimeout(tick, POLL_INTERVAL_MS)
    }
    pollRef.current = window.setTimeout(tick, POLL_INTERVAL_MS)
    return () => {
      if (pollRef.current !== null) window.clearTimeout(pollRef.current)
    }
  }, [phase])

  const busy = phase.kind === 'opening' || phase.kind === 'waiting'
  const statusLabel = sub.active
    ? sub.plan === 'unmute'
      ? 'Unmute'
      : sub.plan === 'dictation'
        ? 'Dictation'
        : 'Active'
    : 'Inactive'

  return (
    <div className="px-5 py-4 border-t border-border space-y-5">
      {/* Status + billing-interval toggle */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-wider text-ink-35 mb-1">Plan</p>
          <div className="flex items-center gap-2">
            <span
              className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[12px] font-semibold ${
                sub.active
                  ? 'bg-green-500/10 text-green-600'
                  : 'bg-cream-mid text-ink-60'
              }`}
            >
              <span
                className={`w-[6px] h-[6px] rounded-full ${
                  sub.active ? 'bg-green-500' : 'bg-ink-35'
                }`}
              />
              {statusLabel}
            </span>
            <button
              onClick={refresh}
              className="text-[10px] text-ink-35 hover:text-ink underline underline-offset-2"
            >
              refresh
            </button>
          </div>
        </div>

        <div className="inline-flex rounded-full border border-border p-0.5 bg-cream-mid/50">
          {(['month', 'year'] as Interval[]).map((iv) => (
            <button
              key={iv}
              onClick={() => setBillingInterval(iv)}
              className={`px-3 py-1 rounded-full text-[11px] font-semibold transition-colors ${
                billingInterval === iv ? 'bg-white text-ink shadow-sm' : 'text-ink-60 hover:text-ink'
              }`}
            >
              {iv === 'month' ? 'Monthly' : 'Annual'}
            </button>
          ))}
        </div>
      </div>

      {/* Plan cards */}
      <div className="grid grid-cols-2 gap-3">
        {PLANS.map((p) => {
          const priceCents = billingInterval === 'month' ? p.monthCents : p.yearCents
          const suffix = billingInterval === 'month' ? '/mo' : '/yr'
          return (
            <div
              key={p.plan}
              className={`relative flex flex-col rounded-2xl border p-4 ${
                p.recommended
                  ? 'border-ink/40 bg-cream-mid/40 shadow-sm'
                  : 'border-border'
              }`}
            >
              {p.recommended && (
                <span className="absolute -top-2 right-3 px-2 py-0.5 rounded-full bg-ink text-white text-[9px] font-bold uppercase tracking-wider">
                  Popular
                </span>
              )}
              <p className="text-[14px] font-bold text-ink">{p.name}</p>
              <p className="text-[11px] text-ink-60 mt-0.5 mb-3 leading-snug">{p.tagline}</p>

              <div className="flex items-baseline gap-2">
                <span className="text-[22px] font-bold text-ink leading-none">
                  {dollars(priceCents)}
                </span>
                <span className="text-[11px] text-ink-60">{suffix}</span>
              </div>
              <div className="flex items-baseline gap-2 mt-1">
                <span className="text-[11px] text-ink-35 line-through">
                  {dollars(p.anchorCents)}/mo
                </span>
                {billingInterval === 'year' && (
                  <span className="text-[10px] font-semibold text-green-600">~2 months free</span>
                )}
              </div>

              <button
                onClick={() => subscribe(p.plan)}
                disabled={busy}
                className={`mt-4 px-3 py-2 rounded-xl text-[13px] font-semibold transition-opacity disabled:opacity-50 disabled:cursor-not-allowed ${
                  p.recommended
                    ? 'bg-ink text-white hover:opacity-90'
                    : 'border border-border text-ink hover:bg-cream-mid'
                }`}
              >
                {sub.active && sub.plan === p.plan ? 'Current plan' : 'Subscribe'}
              </button>
            </div>
          )
        })}
      </div>

      {/* Phase feedback */}
      {phase.kind === 'opening' && (
        <p className="text-[12px] text-ink-60">Opening checkout in your browser…</p>
      )}
      {phase.kind === 'waiting' && (
        <div className="text-[12px] text-ink-60 space-y-1">
          <p>Waiting for your subscription to activate.</p>
          <p className="text-ink-35">
            Complete checkout in your browser. We'll switch you on automatically — usually within a
            few seconds.
          </p>
        </div>
      )}
      {phase.kind === 'success' && (
        <p className="text-[12px] text-green-600">
          You're subscribed. Welcome to {phase.plan === 'unmute' ? 'Unmute' : 'Dictation'}.
        </p>
      )}
      {phase.kind === 'error' && <p className="text-[12px] text-warm">{phase.message}</p>}

      {/* Manage subscription */}
      <div>
        <button
          onClick={manageSubscription}
          className="text-[11px] text-ink-60 hover:text-ink underline underline-offset-2"
        >
          Manage subscription
        </button>
        {portalNote && <p className="text-[11px] text-ink-35 mt-1.5">{portalNote}</p>}
      </div>
    </div>
  )
}
