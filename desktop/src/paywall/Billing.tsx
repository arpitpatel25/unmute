// Billing pane — lives inside Settings.tsx as a new section.
//
// Three regions:
//   1. Balance summary + tier buttons ($10 / $25 / $50)
//   2. Pending-payment overlay while waiting for the webhook to land
//   3. Recent ledger (usage + topups) — last 50 rows
//
// Flow when user clicks a tier:
//   a. paywallCreateCheckout(amountCents) → Dodo session URL
//   b. paywallOpenExternal(checkoutUrl) → system browser
//   c. App goes into "waiting" state. Two exits:
//      i.  paywallOnPaymentCallback fires (deep-link arrived) →
//          refresh balance + refresh ledger.
//      ii. Browser stays open, user closes tab → polling kicks in:
//          paywallGetPaymentStatus(payment_id) every 3s for 5 min, or
//          paywallRefreshBalance until balance increments past pre-topup.

import { useEffect, useRef, useState } from 'react'
import { useAuth } from './AuthContext'

const TIERS_CENTS = [1000, 2500, 5000] // $10 / $25 / $50
const POLL_INTERVAL_MS = 3000
const POLL_DEADLINE_MS = 5 * 60 * 1000

interface LedgerRow {
  id: string
  created_at: string
  delta_cents: number
  source: string
  metadata: Record<string, unknown>
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'opening'; amountCents: number }
  | { kind: 'waiting'; amountCents: number; paymentSessionId?: string; preBalance: number }
  | { kind: 'success'; amountCents: number }
  | { kind: 'error'; message: string }

export function Billing() {
  const auth = useAuth()
  const [balanceCents, setBalanceCents] = useState<number>(0)
  const [ledger, setLedger] = useState<LedgerRow[]>([])
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })

  // Refresh balance + ledger on mount, and again whenever a payment lands.
  useEffect(() => {
    refresh()
    // Live deep-link arrival.
    window.electronAPI.paywallOnPaymentCallback?.(() => {
      // Don't trust the URL — just refresh authoritatively.
      refresh()
      setPhase((p) => (p.kind === 'waiting' ? { kind: 'success', amountCents: p.amountCents } : p))
    })
    // Pending callback on mount (cold launch via deep link).
    window.electronAPI.paywallPopPendingPaymentCallback?.().then((url: string | null) => {
      if (url) refresh()
    })
    return () => window.electronAPI.removeAllListeners?.('paywall:payment-callback')
  }, [])

  async function refresh() {
    const me = await window.electronAPI.paywallRefreshBalance?.()
    if (me) setBalanceCents(me.balanceCents)
    const rows = (await window.electronAPI.paywallGetLedger?.()) ?? []
    setLedger(rows)
  }

  async function startTopup(amountCents: number) {
    if (!auth.signedIn) {
      auth.openSignIn()
      return
    }
    setPhase({ kind: 'opening', amountCents })
    const result = await window.electronAPI.paywallCreateCheckout?.(amountCents)
    if (!result?.ok || !result.checkoutUrl) {
      setPhase({
        kind: 'error',
        message: result?.message ?? 'Could not open checkout. Try again in a moment.',
      })
      return
    }
    await window.electronAPI.paywallOpenExternal?.(result.checkoutUrl)
    setPhase({
      kind: 'waiting',
      amountCents,
      paymentSessionId: result.paymentSessionId,
      preBalance: balanceCents,
    })
  }

  // Polling loop while in 'waiting' — exits on balance bump or deadline.
  const pollRef = useRef<number | null>(null)
  useEffect(() => {
    if (phase.kind !== 'waiting') return
    const startedAt = Date.now()
    const tick = async () => {
      const me = await window.electronAPI.paywallRefreshBalance?.()
      if (me && me.balanceCents > phase.preBalance) {
        setBalanceCents(me.balanceCents)
        const rows = (await window.electronAPI.paywallGetLedger?.()) ?? []
        setLedger(rows)
        setPhase({ kind: 'success', amountCents: phase.amountCents })
        return
      }
      if (Date.now() - startedAt > POLL_DEADLINE_MS) {
        setPhase({
          kind: 'error',
          message:
            "Payment didn't land within 5 minutes. If you completed checkout, refresh below — your balance will update once the payment confirms.",
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

  const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`

  return (
    <div className="px-5 py-4 border-t border-border space-y-5">
      <div>
        <p className="text-[10px] font-bold uppercase tracking-wider text-ink-35 mb-1">Balance</p>
        <div className="flex items-baseline gap-2">
          <p className="text-[26px] font-bold text-ink leading-none">{dollars(balanceCents)}</p>
          <button
            onClick={refresh}
            className="text-[10px] text-ink-35 hover:text-ink underline underline-offset-2"
          >
            refresh
          </button>
        </div>
      </div>

      <div>
        <p className="text-[12px] text-ink-60 mb-2">Top up</p>
        <div className="grid grid-cols-3 gap-2">
          {TIERS_CENTS.map((cents) => (
            <button
              key={cents}
              onClick={() => startTopup(cents)}
              disabled={phase.kind === 'opening' || phase.kind === 'waiting'}
              className="px-3 py-3 rounded-xl border border-border text-[14px] font-semibold text-ink hover:bg-cream-mid disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {dollars(cents)}
            </button>
          ))}
        </div>
        <p className="text-[10px] text-ink-35 mt-2">
          Credits never expire. {dollars(1000)} typically lasts a heavy user multiple months.
        </p>
      </div>

      {phase.kind === 'opening' && (
        <p className="text-[12px] text-ink-60">Opening checkout in your browser…</p>
      )}
      {phase.kind === 'waiting' && (
        <div className="text-[12px] text-ink-60 space-y-1">
          <p>Waiting for payment confirmation.</p>
          <p className="text-ink-35">
            Complete checkout in your browser. We'll credit your account automatically — usually
            within a few seconds.
          </p>
        </div>
      )}
      {phase.kind === 'success' && (
        <p className="text-[12px] text-green-600">
          Top-up confirmed. {dollars(phase.amountCents)} added to your balance.
        </p>
      )}
      {phase.kind === 'error' && (
        <p className="text-[12px] text-warm">{phase.message}</p>
      )}

      <div>
        <p className="text-[10px] font-bold uppercase tracking-wider text-ink-35 mb-2">
          Recent activity
        </p>
        {ledger.length === 0 ? (
          <p className="text-[12px] text-ink-35">No activity yet.</p>
        ) : (
          <ul className="text-[12px] space-y-1.5">
            {ledger.slice(0, 12).map((row) => (
              <li key={row.id} className="flex items-baseline justify-between gap-3">
                <span className="text-ink truncate">{labelForRow(row)}</span>
                <span
                  className={`tabular-nums font-mono ${
                    row.delta_cents >= 0 ? 'text-green-600' : 'text-ink-60'
                  }`}
                >
                  {row.delta_cents >= 0 ? '+' : ''}
                  {dollars(row.delta_cents)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function labelForRow(row: LedgerRow): string {
  const when = new Date(row.created_at).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
  if (row.source === 'topup') return `Top-up · ${when}`
  if (row.source === 'usage') return `Dictation · ${when}`
  if (row.source === 'refund') return `Refund · ${when}`
  if (row.source === 'starter') return `Starter credit · ${when}`
  return `${row.source} · ${when}`
}
