// Last-known subscription/entitlement, cached SYNCHRONOUSLY in localStorage so
// the subscription-status surfaces (BalancePill, EnginePillars, Billing) paint
// the CORRECT plan on the very first frame after a cold launch — instead of
// defaulting to "Inactive/Free" and flipping to the real plan a beat later once
// the auth token reaches the main process.
//
// This mirrors the cached-user hint in AuthContext: it's an OPTIMISTIC UI hint,
// not the source of truth. The authoritative paywallGetSubscription() fetch
// (re-fired on auth.sessionEpoch, i.e. once the token is live in main)
// overwrites it, and sign-out clears it. The only cost is that a plan changed
// on ANOTHER device shows the old value for the ~beat until the confirmed fetch
// lands — the same trade-off the cached user already accepts, and far better
// than showing every Pro user "Inactive" on every launch.

export interface CachedSubscription {
  active: boolean
  plan: 'dictation' | 'unmute' | null
}

const CACHED_SUB_KEY = 'unmute_cached_subscription'

export function readCachedSubscription(): CachedSubscription | null {
  try {
    const raw = localStorage.getItem(CACHED_SUB_KEY)
    if (!raw) return null
    const s = JSON.parse(raw) as { active?: unknown; plan?: unknown }
    if (typeof s?.active !== 'boolean') return null
    const plan = s.plan === 'dictation' || s.plan === 'unmute' ? s.plan : null
    return { active: s.active, plan }
  } catch {
    return null
  }
}

export function writeCachedSubscription(s: CachedSubscription | null): void {
  try {
    if (s) {
      localStorage.setItem(CACHED_SUB_KEY, JSON.stringify({ active: s.active, plan: s.plan }))
    } else {
      localStorage.removeItem(CACHED_SUB_KEY)
    }
  } catch {
    /* ignore — cache is best-effort */
  }
}
