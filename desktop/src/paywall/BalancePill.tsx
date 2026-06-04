// Small balance indicator shown in the top-right corner of the main window.
// Visible only when the user is signed in to managed cloud. Clicking it opens
// the top-up flow.

import { useEffect, useState } from 'react'
import { TopUpButton } from './TopUpButton'

interface BalanceState {
  balanceCents: number
  topUpUrl: string
}

export function BalancePill() {
  const [state, setState] = useState<BalanceState | null>(null)
  const [showMenu, setShowMenu] = useState(false)

  useEffect(() => {
    window.electronAPI.paywallGetBalance().then(setState)
    window.electronAPI.paywallOnBalanceUpdated((next) => setState(next))
    return () => window.electronAPI.removeAllListeners('paywall:balance-updated')
  }, [])

  if (!state || state.balanceCents === 0 && !state.topUpUrl) return null

  const dollars = (state.balanceCents / 100).toFixed(2)
  const low = state.balanceCents > 0 && state.balanceCents < 100 // <$1 is low

  return (
    <div className="relative">
      <button
        onClick={() => setShowMenu((s) => !s)}
        className={`titlebar-no-drag inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold border transition-colors ${
          low
            ? 'bg-warm-soft text-warm border-warm/30 hover:bg-warm/15'
            : 'bg-surface-2 text-ink border-border hover:bg-cream-mid'
        }`}
      >
        <span className={`w-[6px] h-[6px] rounded-full ${low ? 'bg-warm' : 'bg-green-500'}`} />
        ${dollars}
      </button>

      {showMenu && (
        <div
          className="absolute top-full right-0 mt-1.5 w-[200px] bg-white rounded-xl shadow-lg border border-border p-2 z-50"
          onMouseLeave={() => setShowMenu(false)}
        >
          <div className="px-2 py-1.5">
            <p className="text-[10px] text-ink-35 font-bold uppercase tracking-wider mb-0.5">Balance</p>
            <p className="text-[16px] font-bold text-ink">${dollars}</p>
          </div>
          <div className="h-px bg-border my-1.5" />
          <TopUpButton topUpUrl={state.topUpUrl} />
        </div>
      )}
    </div>
  )
}
