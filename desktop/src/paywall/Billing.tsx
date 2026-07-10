// Billing pane — lives inside the managed card (EnginePillars) / Settings.
//
// Subscription model (two tiers, hard paywall, no free trial):
//   * Dictation — $4.99/mo · $49/yr   (anchor $11.99)
//   * Unmute    — $7.99/mo · $79/yr   (anchor $17.99)  ← recommended
//   Annual cards show "~2 months free".
//
// Two distinct views depending on subscription status:
//   * INACTIVE → the sales grid (two plan cards + interval toggle). This is the
//     only place a NEW subscription is created.
//   * ACTIVE → a clear "your plan" summary. We do NOT re-pitch the price grid
//     (clicking Subscribe again would create a SECOND subscription / double
//     charge). A Dictation subscriber upgrades to Unmute in-app via the
//     payments worker's /change-plan (Dodo change-plan on the existing
//     subscription) — prorated, no second subscription. Cancel / payment-method
//     changes still go through the Dodo customer portal.
//
// Flow when an INACTIVE user clicks Subscribe:
//   a. paywallCreateSubscription(plan, interval) → Dodo hosted checkout URL
//   b. paywallOpenExternal(checkoutUrl) → system browser
//   c. "waiting" state; exits via paywallOnPaymentCallback (deep-link) or polling
//      paywallGetSubscription() every 3s for 5 min until active.
//
// "Upgrade to Unmute" calls paywallChangePlan (in-app, prorated). "Manage
// subscription" opens the Dodo customer portal (paywallOpenPortal) for
// cancel / payment-method changes.

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
    monthCents: 499,
    yearCents: 4900,
  },
  {
    plan: 'unmute',
    name: 'Unmute',
    tagline: 'Dictation + Remote. The whole thing.',
    anchorCents: 1799,
    monthCents: 799,
    yearCents: 7900,
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
  const [upgrading, setUpgrading] = useState(false)
  // Item 1: in-card confirmation gate before the prorated Dictation→Unmute
  // upgrade actually charges. Clicking "Upgrade to Unmute" flips this true and
  // renders an inline confirm panel; only "Confirm upgrade" runs upgrade().
  const [confirmingUpgrade, setConfirmingUpgrade] = useState(false)

  // Refresh subscription status on mount, again when a checkout lands, and
  // again once the auth token has propagated to main (auth.sessionEpoch) — the
  // mount fetch on cold start races ahead of the token and reads a false
  // "inactive" until the epoch bumps.
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth.sessionEpoch])

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
    // Item 2: the user already has an active subscription — the worker refused
    // to mint a second checkout (409). Don't open checkout; refresh status (so
    // the card flips to the ACTIVE view) and note why.
    if (result?.alreadySubscribed) {
      setPhase({ kind: 'idle' })
      setPortalNote('You already have an active subscription.')
      await refresh()
      return
    }
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

  // Opens the Dodo customer portal — used for manage, cancel, AND plan upgrades
  // (the portal prorates a Dictation→Unmute change automatically).
  async function openPortal() {
    if (!auth.signedIn) {
      auth.openSignIn()
      return
    }
    setPortalNote(null)
    const result = await window.electronAPI.paywallOpenPortal?.()
    if (result?.noSubscription) {
      setPortalNote('No billing profile yet — pick a plan to get started.')
      return
    }
    if (!result?.ok || !result.portalUrl) {
      setPortalNote(result?.message ?? 'Could not open the billing portal. Try again in a moment.')
      return
    }
    await window.electronAPI.paywallOpenExternal?.(result.portalUrl)
  }

  // In-app upgrade Dictation → Unmute via Dodo's change-plan (prorated, no
  // second subscription). On success we don't redirect to the browser — we
  // poll refresh() a few times so the UI flips to Unmute once the
  // subscription.plan_changed webhook lands (usually within seconds).
  async function upgrade() {
    if (!auth.signedIn) {
      auth.openSignIn()
      return
    }
    setPortalNote(null)
    setConfirmingUpgrade(false)
    setUpgrading(true)
    try {
      const result = await window.electronAPI.paywallChangePlan?.()
      if (result?.ok) {
        setPortalNote('Upgrading… your plan will switch to Unmute in a moment.')
        // Short poll: re-check entitlement a few times over ~15s so the card
        // flips to Unmute once the webhook updates the subscription.
        for (let i = 0; i < 5; i++) {
          await new Promise((r) => setTimeout(r, 3000))
          await refresh()
        }
        return
      }
      if (result?.error === 'change_pending') {
        setPortalNote('An upgrade is already processing.')
        return
      }
      if (result?.error === 'already_unmute') {
        await refresh()
        return
      }
      setPortalNote(
        "Couldn't start the upgrade — try again or use Manage subscription.",
      )
    } finally {
      setUpgrading(false)
    }
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
            "We didn't see your subscription activate within 5 minutes. If you completed checkout, it can take a moment — use refresh above.",
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
  const current = PLANS.find((p) => p.plan === sub.plan) ?? null
  const statusLabel = sub.active
    ? sub.plan === 'unmute'
      ? 'Unmute'
      : sub.plan === 'dictation'
        ? 'Dictation'
        : 'Active'
    : 'Inactive'

  return (
    <div className="px-5 py-4 border-t border-border space-y-5">
      {/* Status + (inactive only) billing-interval toggle */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-wider text-ink-35 mb-1">Plan</p>
          <div className="flex items-center gap-2">
            <span
              className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[12px] font-semibold ${
                sub.active ? 'bg-green-500/10 text-green-600' : 'bg-cream-mid text-ink-60'
              }`}
            >
              <span
                className={`w-[6px] h-[6px] rounded-full ${sub.active ? 'bg-green-500' : 'bg-ink-35'}`}
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

        {!sub.active && (
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
        )}
      </div>

      {sub.active ? (
        /* ───── ACTIVE: current plan, no sales grid ───── */
        <div className="rounded-2xl border border-ink/30 bg-cream-mid/40 p-4">
          <p className="text-[15px] font-bold text-ink">
            {current?.name ?? 'Active'}
            <span className="ml-2 text-[11px] font-semibold text-green-600">· your plan</span>
          </p>
          <p className="text-[11px] text-ink-60 mt-0.5 leading-snug">
            {sub.plan === 'unmute'
              ? 'Dictation + Remote — the whole thing. Cloud dictation is on.'
              : 'Fast, accurate cloud dictation everywhere. Cloud dictation is on.'}
          </p>

          {/* Dictation subscribers get a prorated in-app upgrade path. */}
          {sub.plan === 'dictation' && (
            <div className="mt-4 rounded-xl border border-border bg-white/60 p-3">
              <p className="text-[12px] font-semibold text-ink">Want Remote too?</p>
              <p className="text-[11px] text-ink-60 mt-0.5 leading-snug">
                Upgrade to <span className="font-semibold">Unmute</span> to voice-control your Claude
                Code. You only pay the prorated difference — no second subscription.
              </p>

              {confirmingUpgrade ? (
                /* Item 1: explicit confirmation step — no accidental charges. */
                <div className="mt-3 rounded-lg border border-ink/30 bg-cream-mid/50 p-3">
                  <p className="text-[12px] font-bold text-ink">Upgrade to Unmute?</p>
                  <p className="text-[11px] text-ink-60 mt-1 leading-snug">
                    You'll be charged the prorated difference now (about $3 — the gap to $7.99/mo),
                    and your plan switches to Unmute immediately. If you pay by UPI, the charge
                    settles in the background over ~24h.
                  </p>
                  <div className="mt-2.5 flex items-center gap-2">
                    <button
                      onClick={upgrade}
                      disabled={busy || upgrading}
                      className="px-3 py-1.5 rounded-lg text-[12px] font-semibold bg-ink text-white hover:opacity-90 disabled:opacity-50"
                    >
                      {upgrading ? 'Upgrading…' : 'Confirm upgrade'}
                    </button>
                    <button
                      onClick={() => setConfirmingUpgrade(false)}
                      disabled={upgrading}
                      className="px-3 py-1.5 rounded-lg text-[12px] font-semibold border border-border text-ink hover:bg-cream-mid disabled:opacity-50"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => {
                    setPortalNote(null)
                    setConfirmingUpgrade(true)
                  }}
                  disabled={busy || upgrading}
                  className="mt-2 px-3 py-1.5 rounded-lg text-[12px] font-semibold bg-ink text-white hover:opacity-90 disabled:opacity-50"
                >
                  {upgrading ? 'Upgrading…' : 'Upgrade to Unmute →'}
                </button>
              )}
            </div>
          )}

          {/* Item 3: prominent cancel / manage. Both open the Dodo portal —
              Dodo hosts the cancel + payment-method flows. */}
          <div className="mt-4 pt-3 border-t border-border">
            <div className="flex items-center gap-3">
              <button
                onClick={openPortal}
                className="px-3 py-1.5 rounded-lg text-[12px] font-semibold border border-warm/40 text-warm hover:bg-warm/10"
              >
                Cancel subscription
              </button>
              <button
                onClick={openPortal}
                className="text-[11px] text-ink-60 hover:text-ink underline underline-offset-2"
              >
                Manage billing
              </button>
            </div>
            <p className="text-[10px] text-ink-35 mt-2 leading-snug">
              Cancel or manage anytime — you keep access until the end of your billing period. UPI
              users can also revoke the AutoPay mandate in their UPI app.
            </p>
            {portalNote && <p className="text-[11px] text-ink-35 mt-1.5">{portalNote}</p>}
          </div>
        </div>
      ) : (
        /* ───── INACTIVE: sales grid (creates the first subscription) ───── */
        <>
          <div className="grid grid-cols-2 gap-3">
            {PLANS.map((p) => {
              const priceCents = billingInterval === 'month' ? p.monthCents : p.yearCents
              const suffix = billingInterval === 'month' ? '/mo' : '/yr'
              return (
                <div
                  key={p.plan}
                  className={`relative flex flex-col rounded-2xl border p-4 ${
                    p.recommended ? 'border-ink/40 bg-cream-mid/40 shadow-sm' : 'border-border'
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
                    Subscribe
                  </button>
                </div>
              )
            })}
          </div>

          <div>
            <button
              onClick={openPortal}
              className="text-[11px] text-ink-60 hover:text-ink underline underline-offset-2"
            >
              Manage subscription
            </button>
            {portalNote && <p className="text-[11px] text-ink-35 mt-1.5">{portalNote}</p>}
          </div>
        </>
      )}

      {/* Phase feedback (shared) */}
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
    </div>
  )
}
