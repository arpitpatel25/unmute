// Account tab — identity + engine selection.
//
// The Engine selector is the centerpiece — pillar cards (Managed /
// On-device) with inline setup per pillar. The Managed card
// embeds the full Billing UI (balance + top-up + recent activity)
// inside itself, since billing IS the managed-cloud flow rather than
// a separate concept.
//
// The legacy local-Groq-pricing Usage card was removed — it always
// showed $0.00 for Managed users (where real spend is tracked in
// Supabase via Billing) and never counted Local at all.
//
// PACK B TOUCHED FIVE LINES HERE, all of them D8 discipline: the two section
// icons (see below), two off-scale 12-pixel sizes, and the signed-out line that
// still offered to "top up credits" — a billing model that migration
// 012_retire_payperuse.sql retired. The same stale story was on the Privacy
// page and is gone from there too. The file was unowned at dispatch; the
// coordinator reassigned it to this pack (integration note I7) precisely
// because of the two icons.

import { EnginePillars } from '../paywall/EnginePillars'
import { useAuth } from '../paywall/AuthContext'
// ICONS (decision D8 — one glyph per concept). Both section headers here used
// to draw `BehaviorIcon`, which a third screen also drew, so three unrelated
// sections were marked with the same mark. Pack A added `ProfileIcon` (an ID
// card, deliberately not the person figure the sidebar's Account row uses) and
// `EngineIcon` (a chip, deliberately not the gear Settings uses) for exactly
// these two call sites, and left them unwired because it did not own this file.
// Wiring them is all that changed in Account.tsx.
import { SectionHeader, ProfileIcon, EngineIcon } from './_shared'

export default function Account() {
  const auth = useAuth()

  return (
    <div className="max-w-2xl">
      <h2 className="font-display text-[22px] font-bold text-ink tracking-tight mb-6">Account</h2>

      {/* ═══ Profile ═══ */}
      <SectionHeader icon={<ProfileIcon />} title="Profile" />
      <div className="bg-surface-2 border border-border rounded-2xl overflow-hidden mb-3 shadow-sm">
        <div className="px-5 py-4 flex items-center justify-between">
          {auth.signedIn ? (
            <>
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-8 h-8 rounded-full bg-ink text-white flex items-center justify-center text-[12.5px] font-semibold shrink-0">
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
                  Sign in to use the cloud engine and manage your subscription.
                </p>
              </div>
              <button
                onClick={() => auth.openSignIn()}
                className="px-4 py-2 rounded-full bg-ink text-white text-[12.5px] font-semibold hover:opacity-90 transition-opacity shrink-0"
              >
                Sign in
              </button>
            </>
          )}
        </div>
      </div>

      {/* ═══ Engine ═══ (3-pillar selector with inline setup per pillar) */}
      <SectionHeader icon={<EngineIcon />} title="Engine" />
      <div className="mb-3">
        <EnginePillars />
      </div>
    </div>
  )
}
