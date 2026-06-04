// Top-of-window banner shown when a managed-cloud session fell back to local
// because the balance hit zero. Non-blocking — the user can keep working;
// the banner just surfaces "you fell back, here's where to top up".

import { useEffect, useState } from 'react'

export function OutOfCreditBanner() {
  const [shown, setShown] = useState(false)
  const [topUpUrl, setTopUpUrl] = useState('')

  useEffect(() => {
    window.electronAPI.paywallOnFellBackToLocal?.((url: string) => {
      setTopUpUrl(url)
      setShown(true)
    })
    return () => window.electronAPI.removeAllListeners('paywall:fell-back-to-local')
  }, [])

  if (!shown) return null

  return (
    <div className="absolute top-8 left-0 right-0 z-20 flex justify-center pointer-events-none">
      <div className="pointer-events-auto mt-2 flex items-center gap-3 px-4 py-2.5 rounded-full bg-warm/95 text-white shadow-lg border border-warm/30 animate-fade-up-in">
        <span className="text-[12px] font-medium">
          Out of credit — using <span className="font-bold">local whisper</span> for now.
        </span>
        <button
          onClick={() => window.electronAPI.paywallOpenExternal(topUpUrl)}
          className="text-[12px] font-semibold px-3 py-1 rounded-full bg-white text-warm hover:opacity-90 transition-opacity"
        >
          Top up
        </button>
        <button
          onClick={() => setShown(false)}
          className="text-[16px] leading-none text-white/70 hover:text-white px-1"
          aria-label="Dismiss"
        >
          ×
        </button>
      </div>
    </div>
  )
}
