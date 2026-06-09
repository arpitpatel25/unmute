// Account tab — identity + engine selection.
//
// The Engine selector is the centerpiece — 3 pillar cards (Managed /
// BYOK / On-device) with inline setup per pillar. The Managed card
// embeds the full Billing UI (balance + top-up + recent activity)
// inside itself, since billing IS the managed-cloud flow rather than
// a separate concept.
//
// The legacy local-Groq-pricing Usage card was removed — it was a
// BYOK-only artifact that always showed $0.00 for Managed users
// (where real spend is tracked in Supabase via Billing) and never
// counted Local at all. Misleading for the majority case.

import { EnginePillars } from '../paywall/EnginePillars'
import { useAuth } from '../paywall/AuthContext'
import { SectionHeader, BehaviorIcon } from './_shared'

export default function Account() {
  const auth = useAuth()

  return (
    <div className="max-w-lg">
      <h2 className="font-display text-[22px] font-bold text-ink tracking-tight mb-6">Account</h2>

      {/* ═══ Profile ═══ */}
      <SectionHeader icon={<BehaviorIcon />} title="Profile" />
      <div className="bg-surface-2 border border-border rounded-2xl overflow-hidden mb-3 shadow-sm">
        <div className="px-5 py-4 flex items-center justify-between">
          {auth.signedIn ? (
            <>
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-8 h-8 rounded-full bg-ink text-white flex items-center justify-center text-[12px] font-semibold shrink-0">
                  {(auth.user?.email?.[0] ?? 'U').toUpperCase()}
                </div>
                <div className="min-w-0">
                  <p className="text-[13px] font-medium text-ink truncate">
                    {auth.user?.email ?? 'Signed in'}
                  </p>
                  <p className="text-[11px] text-ink-35">Signed in to managed cloud</p>
                </div>
              </div>
              <button
                onClick={() => auth.signOut()}
                className="px-3 py-1.5 rounded-full border border-border text-[11px] font-semibold text-ink-60 hover:bg-cream-mid hover:border-border-md transition-all shrink-0"
              >
                Sign out
              </button>
            </>
          ) : (
            <>
              <div>
                <p className="text-[13px] font-medium text-ink">Not signed in</p>
                <p className="text-[11px] text-ink-35 mt-0.5">
                  Sign in to use managed cloud and top up credits.
                </p>
              </div>
              <button
                onClick={() => auth.openSignIn()}
                className="px-4 py-2 rounded-full bg-ink text-white text-[12px] font-semibold hover:opacity-90 transition-opacity shrink-0"
              >
                Sign in
              </button>
            </>
          )}
        </div>
      </div>

      {/* ═══ Engine ═══ (3-pillar selector with inline setup per pillar) */}
      <SectionHeader icon={<BehaviorIcon />} title="Engine" />
      <div className="mb-3">
        <EnginePillars />
      </div>
    </div>
  )
}
