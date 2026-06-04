// Top-up button — opens the Dodo checkout in the external browser.
// Until Dodo is wired, opens a "coming soon" placeholder URL.

interface Props {
  topUpUrl: string
  variant?: 'compact' | 'full'
}

const PRESET_AMOUNTS_CENTS = [1000, 1500, 2500] // $10 / $15 / $25

export function TopUpButton({ topUpUrl, variant = 'compact' }: Props) {
  if (variant === 'compact') {
    return (
      <button
        onClick={() => window.electronAPI.paywallOpenExternal(topUpUrl)}
        className="w-full px-3 py-2 rounded-lg bg-ink text-white text-[11px] font-semibold hover:opacity-90 transition-opacity"
      >
        Top up
      </button>
    )
  }
  return (
    <div className="flex flex-col gap-2">
      <p className="text-[12px] text-ink-60 mb-1">Choose an amount:</p>
      <div className="grid grid-cols-3 gap-2">
        {PRESET_AMOUNTS_CENTS.map((cents) => {
          const dollars = (cents / 100).toFixed(0)
          return (
            <button
              key={cents}
              onClick={() => window.electronAPI.paywallOpenExternal(`${topUpUrl}?amount=${cents}`)}
              className="px-3 py-2.5 rounded-xl border border-border text-[13px] font-semibold text-ink hover:bg-cream-mid transition-colors"
            >
              ${dollars}
            </button>
          )
        })}
      </div>
      <p className="text-[10px] text-ink-35 mt-1">
        $10 typically lasts a heavy user 10-12 months. Credits never expire.
      </p>
    </div>
  )
}
