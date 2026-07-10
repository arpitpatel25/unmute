// Small subscription-status indicator shown in the top-right corner of the
// main window. Visible only when the user is signed in to managed cloud.
// Clicking it opens the customer portal to manage the subscription.

import { useEffect, useState } from 'react'
import { useAuth } from './AuthContext'

interface SubState {
  active: boolean
  plan: 'dictation' | 'unmute' | null
}

export function BalancePill() {
  const auth = useAuth()
  const [state, setState] = useState<SubState | null>(null)
  const [showMenu, setShowMenu] = useState(false)

  // Re-fetch when the auth token propagates to main (auth.sessionEpoch), not
  // just on mount — the cold-start mount fetch races ahead of the token and
  // returns a false "Inactive" (Free) that only self-corrects on a refresh.
  useEffect(() => {
    window.electronAPI.paywallGetSubscription?.().then((s) => {
      if (s) setState(s)
    })
  }, [auth.sessionEpoch])

  if (!state) return null

  const label = state.active
    ? state.plan === 'unmute'
      ? 'Unmute'
      : state.plan === 'dictation'
        ? 'Dictation'
        : 'Active'
    : 'Inactive'

  async function manage() {
    setShowMenu(false)
    const result = await window.electronAPI.paywallOpenPortal?.()
    if (result?.ok && result.portalUrl) {
      await window.electronAPI.paywallOpenExternal(result.portalUrl)
    }
  }

  return (
    <div className="relative">
      <button
        onClick={() => setShowMenu((s) => !s)}
        className={`titlebar-no-drag inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold border transition-colors ${
          state.active
            ? 'bg-surface-2 text-ink border-border hover:bg-cream-mid'
            : 'bg-warm-soft text-warm border-warm/30 hover:bg-warm/15'
        }`}
      >
        <span
          className={`w-[6px] h-[6px] rounded-full ${
            state.active ? 'bg-green-500' : 'bg-warm'
          }`}
        />
        {label}
      </button>

      {showMenu && (
        <div
          className="absolute top-full right-0 mt-1.5 w-[200px] bg-white rounded-xl shadow-lg border border-border p-2 z-50"
          onMouseLeave={() => setShowMenu(false)}
        >
          <div className="px-2 py-1.5">
            <p className="text-[10px] text-ink-35 font-bold uppercase tracking-wider mb-0.5">
              Subscription
            </p>
            <p className="text-[16px] font-bold text-ink">{label}</p>
          </div>
          <div className="h-px bg-border my-1.5" />
          <button
            onClick={manage}
            className="w-full px-3 py-2 rounded-lg bg-ink text-white text-[11px] font-semibold hover:opacity-90 transition-opacity"
          >
            {state.active ? 'Manage subscription' : 'Subscribe'}
          </button>
        </div>
      )}
    </div>
  )
}
