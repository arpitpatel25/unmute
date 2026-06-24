// Top-of-window banners shown when a managed-cloud call was gated or flagged.
// Three non-blocking surfaces, all dismissible — the user can keep working on
// local whisper while they decide:
//   * SUBSCRIPTION_INACTIVE (402) → "Subscribe to use Unmute"
//   * UPGRADE_REQUIRED      (403) → "Upgrade to Unmute to use Remote" (distinct)
//   * fair-use notify             → soft "you're a power user" heads-up
//
// Each fires from a distinct main→renderer IPC event (see paywall-route.ts /
// managed-client.ts). They never block dictation; they only inform.

import { useEffect, useState } from 'react'

export function OutOfCreditBanner() {
  // 402 — no active subscription → subscribe prompt.
  const [shownSubscribe, setShownSubscribe] = useState(false)
  const [subscribeUrl, setSubscribeUrl] = useState('')
  // 403 — active but wrong plan → distinct upgrade prompt (Item 4).
  const [shownUpgrade, setShownUpgrade] = useState(false)
  const [upgradeUrl, setUpgradeUrl] = useState('')
  // Fair-use heads-up (Item 5).
  const [shownFairUse, setShownFairUse] = useState(false)

  useEffect(() => {
    window.electronAPI.paywallOnFellBackToLocal?.((url: string) => {
      setSubscribeUrl(url)
      setShownSubscribe(true)
    })
    window.electronAPI.paywallOnUpgradeRequired?.((url: string) => {
      setUpgradeUrl(url)
      setShownUpgrade(true)
    })
    window.electronAPI.paywallOnFairUseNotify?.(() => {
      setShownFairUse(true)
    })
    return () => {
      window.electronAPI.removeAllListeners('paywall:fell-back-to-local')
      window.electronAPI.removeAllListeners('paywall:upgrade-required')
      window.electronAPI.removeAllListeners('paywall:fair-use-notify')
    }
  }, [])

  if (!shownSubscribe && !shownUpgrade && !shownFairUse) return null

  return (
    <div className="absolute top-8 left-0 right-0 z-20 flex flex-col items-center gap-2 pointer-events-none">
      {/* 403 — distinct UPGRADE prompt (Remote needs the Unmute plan). */}
      {shownUpgrade && (
        <div className="pointer-events-auto mt-2 flex items-center gap-3 px-4 py-2.5 rounded-full bg-ink/95 text-white shadow-lg border border-white/10 animate-fade-up-in">
          <span className="text-[12px] font-medium">
            Remote needs the <span className="font-bold">Unmute</span> plan — upgrade to use it.
          </span>
          <button
            onClick={() => window.electronAPI.paywallOpenExternal(upgradeUrl)}
            className="text-[12px] font-semibold px-3 py-1 rounded-full bg-white text-ink hover:opacity-90 transition-opacity"
          >
            Upgrade to Unmute
          </button>
          <button
            onClick={() => setShownUpgrade(false)}
            className="text-[16px] leading-none text-white/70 hover:text-white px-1"
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      )}

      {/* 402 — no active subscription → subscribe. */}
      {shownSubscribe && (
        <div className="pointer-events-auto mt-2 flex items-center gap-3 px-4 py-2.5 rounded-full bg-warm/95 text-white shadow-lg border border-warm/30 animate-fade-up-in">
          <span className="text-[12px] font-medium">
            Subscription inactive — using <span className="font-bold">on-device Parakeet</span> for now.
          </span>
          <button
            onClick={() => window.electronAPI.paywallOpenExternal(subscribeUrl)}
            className="text-[12px] font-semibold px-3 py-1 rounded-full bg-white text-warm hover:opacity-90 transition-opacity"
          >
            Subscribe
          </button>
          <button
            onClick={() => setShownSubscribe(false)}
            className="text-[16px] leading-none text-white/70 hover:text-white px-1"
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      )}

      {/* Fair-use heads-up — soft, informational, non-blocking. */}
      {shownFairUse && (
        <div className="pointer-events-auto mt-2 flex items-center gap-3 px-4 py-2.5 rounded-full bg-surface-2/95 text-ink shadow-lg border border-border animate-fade-up-in">
          <span className="text-[12px] font-medium">
            You're a power user — heads up, but your plan still covers you.
          </span>
          <button
            onClick={() => setShownFairUse(false)}
            className="text-[16px] leading-none text-ink-35 hover:text-ink px-1"
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      )}
    </div>
  )
}
