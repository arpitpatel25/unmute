// Single source of truth for paywall auth state across the renderer.
//
// Wraps supabase-js' session and exposes a typed `useAuth()` hook for any
// component that needs to know who's signed in, present a sign-in CTA, or
// drive the OAuth flow. Eliminates the duplicated `signedIn` / `user` state
// scattered across BalancePill, EngineSettings, etc.
//
// State machine for the sign-in flow:
//
//   idle ──openSignIn()──▶ idle (modal open, user can pick a method)
//     ▲                          │
//     │                          │ signInWithGoogle()
//     │                          ▼
//     │                       opening
//     │      paywallOpenExternal(supabaseOAuthUrl) returned
//     │                          │
//     │                          ▼
//     │                       waiting (browser is open; we expect a deep-link callback)
//     │                          │
//     │     paywall:auth-callback IPC arrives (or user pastes URL)
//     │                          │
//     │                          ▼
//     │                      exchanging (calling supabase.exchangeCodeForSession)
//     │                          │
//     │            ┌─────────────┴───────────┐
//     │            ▼                         ▼
//     └──── success (signedIn=true)        error (errorMessage set)
//
// cancelSignIn() can be called from any non-idle state to abort and return
// to idle. The Cmd+W back button in SignInScreen drives this.

import { createContext, useContext, useEffect, useState, useCallback, useRef, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { getSupabase, readStoredSession, clearStoredSession } from './supabase-client'
import { writeCachedSubscription } from './subscription-cache'

export type AuthState = 'idle' | 'opening' | 'waiting' | 'exchanging' | 'error'
export interface AuthUser { id: string; email: string | null }

interface AuthContextValue {
  user: AuthUser | null
  signedIn: boolean
  authState: AuthState
  errorMessage: string | null
  /** True when the SignInScreen modal should be visible. */
  showSignIn: boolean
  /**
   * Increments each time the access token is propagated to the main process
   * (cold-start restore, sign-in, or refresh). Subscription-status fetchers
   * depend on this so they RE-FETCH once the token is actually live in main —
   * their first mount fetch races ahead of the token and would otherwise read
   * a false "Free/Inactive" until a manual refresh. Starts at 0.
   */
  sessionEpoch: number

  /** Open the SignInScreen modal. No-op if user is already signed in. */
  openSignIn(): void
  /** Close the SignInScreen modal without changing auth state. */
  closeSignIn(): void
  /** Cancel an in-flight OAuth attempt (revert authState to idle). */
  cancelSignIn(): void

  signInWithGoogle(): Promise<void>
  signInWithMagicLink(email: string): Promise<{ ok: boolean; message: string }>
  /** Manual paste of an auth callback URL (DNS-blocked-region fallback). */
  pasteAuthUrl(url: string): Promise<boolean>
  signOut(): Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

// Timeout for "waiting" state — if no callback in 5 min, revert to idle so the
// user isn't stuck looking at a spinner. Tunable.
const OAUTH_WAIT_TIMEOUT_MS = 5 * 60 * 1000

// How long sign-out waits for supabase-js to revoke the token server-side
// before tearing the session down regardless. Generous enough for a real
// /auth/v1/logout round trip, short enough that "Sign out" always feels
// immediate. The revoke request is not cancelled when this elapses.
const SIGN_OUT_REVOKE_BUDGET_MS = 1500

// Last-known signed-in user, cached SYNCHRONOUSLY in localStorage so the very
// first render already shows the signed-in UI. Without this, `user` starts null
// and the app flashes the signed-out state for the ~beat it takes the async
// keychain session check (getSession) to resolve. This is just an optimistic UI
// hint — getSession remains the source of truth and corrects it if the cached
// session is actually gone.
const CACHED_USER_KEY = 'unmute_cached_user'
function readCachedUser(): AuthUser | null {
  try {
    const raw = localStorage.getItem(CACHED_USER_KEY)
    if (!raw) return null
    const u = JSON.parse(raw) as { id?: unknown; email?: unknown }
    return typeof u?.id === 'string' ? { id: u.id, email: typeof u.email === 'string' ? u.email : null } : null
  } catch { return null }
}
function writeCachedUser(u: AuthUser | null): void {
  try {
    if (u) localStorage.setItem(CACHED_USER_KEY, JSON.stringify({ id: u.id, email: u.email }))
    else localStorage.removeItem(CACHED_USER_KEY)
  } catch { /* ignore */ }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  // Seed from the synchronous cache so the first paint is already signed-in.
  const [user, setUserState] = useState<AuthUser | null>(() => readCachedUser())
  // Every user change also updates the cache (covers sign-out → cache cleared).
  // On sign-out we also drop the optimistic subscription cache so a returning
  // signed-out user never sees a stale "Pro" pill seeded from the last session.
  const setUser = useCallback((u: AuthUser | null) => {
    setUserState(u)
    writeCachedUser(u)
    if (!u) writeCachedSubscription(null)
  }, [])
  const [authState, setAuthState] = useState<AuthState>('idle')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [showSignIn, setShowSignIn] = useState(false)
  // Bumped after each successful push of a token-bearing session to main —
  // see AuthContextValue.sessionEpoch.
  const [sessionEpoch, setSessionEpoch] = useState(0)

  const waitTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Set when a sign-out is accounted for: either the user asked for one, or the
  // main process told us the refresh token was rejected. See honourSignOut.
  const signOutExpectedRef = useRef(false)

  /**
   * End the session everywhere, unconditionally. The one teardown both
   * sign-out routes use — the user pressing Sign out, and main reporting that
   * the server rejected the refresh token.
   *
   * It does not delegate to supabase-js, because supabase-js cannot be relied
   * on to finish the job here. `GoTrueClient._signOut()` reads the session
   * first and returns early — clearing nothing, emitting no SIGNED_OUT — if
   * that read errors, and the read errors whenever the access token has
   * expired, because the refresh it wants is main's to make and ours to
   * refuse. Worse, it *resolves* with an `{ error }` rather than throwing, so
   * neither a `try/catch` nor a `.catch()` notices. Both sign-out routes run
   * precisely when the token is most likely to be stale, so both must tear the
   * session down themselves.
   *
   * supabase-js is still asked — when it can, it revokes the token server-side,
   * which nothing else here does — but it is never waited on for long. With a
   * stale access token its signOut() sits in the same ~25s refresh-retry loop
   * as getSession() and then clears nothing, so awaiting it would leave the
   * user looking at a signed-in UI long after pressing Sign out. It is given a
   * short budget; the request keeps running in the background either way, so a
   * slow-but-successful revoke is not lost, it just stops holding up the UI.
   */
  const tearDownSession = useCallback(async (scope: 'global' | 'local' = 'global') => {
    // Mark it BEFORE asking, so any SIGNED_OUT this produces is recognised as
    // one we asked for and skips the second opinion honourSignOut applies to
    // unsolicited ones.
    signOutExpectedRef.current = true
    const revoke = getSupabase().auth.signOut({ scope }).catch(() => { /* best-effort */ })
    await Promise.race([
      revoke,
      new Promise((resolve) => setTimeout(resolve, SIGN_OUT_REVOKE_BUDGET_MS)),
    ])
    await clearStoredSession()
    try {
      await window.electronAPI.paywallSignOut?.()
    } catch {
      /* best-effort */
    }
    setUser(null)
    // Never leave this latched: a stuck `true` would let the next unsolicited
    // SIGNED_OUT through without corroboration.
    signOutExpectedRef.current = false
  }, [setUser])

  // ─── Bootstrap: read existing session, subscribe to auth-state changes ───
  useEffect(() => {
    const supa = getSupabase()

    let cancelled = false

    /**
     * Push the supabase session to the main process so paywall-glue can use
     * the access token for tryManagedSTT/tryManagedLLM. Without this, the
     * main process never learns about the sign-in and managed STT silently
     * falls through to local whisper.
     */
    function pushSessionToMain(session: Session | null) {
      const u = session?.user
      window.electronAPI.paywallSetSession?.({
        accessToken: session?.access_token ?? null,
        refreshToken: session?.refresh_token ?? null,
        expiresAt: session?.expires_at ?? null,
        user: u ? { id: u.id, email: u.email ?? null } : null,
      })
        .then(() => {
          // The access token is now live in main. Signal subscription-status
          // fetchers to re-fetch — on cold start this is the moment that clears
          // the "signed-in but shows Free" flash (they fetched on mount, before
          // the token propagated). Only bump when there's actually a token so a
          // signed-out push doesn't trigger a pointless re-fetch.
          if (session?.access_token) setSessionEpoch((e) => e + 1)
        })
        .catch(() => { /* best-effort */ })
    }

    /**
     * Clear the user — but only for a reason that actually means "signed out".
     *
     * A stale access token is not a signed-out user. Main owns proactive
     * refresh now (paywall-glue.scheduleAutoRefresh) and the renderer's
     * supabase client is denied the token endpoint outright, so between an
     * access token expiring and main's next push supabase-js has no way to
     * produce a session and will hand us `null`. Treating that as a sign-out
     * is the bug this pack exists to fix — it flips the UI to signed-out *and*
     * pushes a null token into main, which is what makes the next dictation
     * fall back to the local model and announce a downgrade.
     *
     * Only two things are real sign-outs:
     *   1. the user asked, or
     *   2. the server rejected the refresh token.
     * Main is the only process that calls the token endpoint, so main is the
     * only one that can observe (2) — it reports it as a null token pair on
     * `paywall:token-refreshed`. Both routes set signOutExpectedRef.
     *
     * An unsolicited SIGNED_OUT is something else: supabase-js also emits one
     * for a stored session it could not parse. We ask main for a second
     * opinion before acting on it. If main still holds a session, ignoring the
     * event is not just safe but self-healing — main's next broadcast feeds a
     * good token back through setSession and repopulates the keychain.
     */
    async function honourSignOut() {
      if (!signOutExpectedRef.current) {
        try {
          // Cast: window.electronAPI's ambient type comes from the OSS engine
          // at build time and isn't available in this repo. paywallGetUser is
          // real (electron/preload-extensions.ts) — the cast just avoids
          // depending on a declaration we cannot see from here.
          const api = window.electronAPI as unknown as {
            paywallGetUser?: () => Promise<AuthUser | null>
          }
          const mainUser = await api.paywallGetUser?.()
          if (mainUser) {
            console.warn('[auth] ignoring an unsolicited SIGNED_OUT — main still holds a live session')
            return
          }
        } catch {
          /* couldn't ask — fall through and honour the event */
        }
      }
      signOutExpectedRef.current = false
      setUser(null)
      // paywallSignOut, NOT pushSessionToMain(null). Both null out main's
      // session, but only `paywall:sign-out` runs clearSessionState() — which
      // also cancels the refresh timer and drops the Remote entitlement
      // (`remoteTriggerEntitled`, the trigger state, the per-account pref).
      // Pushing a null session instead leaves the Remote key live for a user
      // main considers signed out, and leaves the next account inheriting this
      // one's trigger choice. A sign-out honoured here is as real as one the
      // user pressed, so it gets the same teardown.
      window.electronAPI.paywallSignOut?.().catch(() => { /* best-effort */ })
    }

    // ── Hand main the credential FIRST, before asking supabase-js anything ──
    //
    // Main starts empty and is the only process that can use a refresh token,
    // so the sooner it has one the sooner cloud dictation works. This is a
    // plain keychain read: measured at ~0ms.
    //
    // It must not wait for getSession(). When the stored access token has
    // expired, getSession() spends **~25 seconds** inside supabase-js's bounded
    // refresh-retry loop (auth-js retries a refresh with exponential backoff
    // until AUTO_REFRESH_TICK_DURATION_MS elapses; ours is refused instantly,
    // so the whole budget is spent sleeping) before returning `session: null`.
    // Blocking the hand-off on that would leave main with no token for 25s
    // after every launch that follows a night's downtime — dictation on the
    // local model, announcing a downgrade. That is the very symptom this pack
    // exists to remove, and it is exactly when a user reaches for it.
    //
    // Main's scheduleAutoRefresh then sees a past-due expiry, refreshes at
    // once, and broadcasts — which repairs supabase-js's own session via
    // setSession in the handler below.
    void (async () => {
      const stored = await readStoredSession()
      if (cancelled || !stored) return
      if (stored.user) setUser(stored.user)
      window.electronAPI.paywallSetSession?.({
        accessToken: stored.accessToken,
        refreshToken: stored.refreshToken,
        expiresAt: stored.expiresAt,
        user: stored.user,
      }).catch(() => { /* best-effort */ })
    })()

    supa.auth.getSession().then(({ data, error }) => {
      if (cancelled) return
      const u = data.session?.user
      if (u) {
        setUser({ id: u.id, email: u.email ?? null })
        // Fresh session — this is the same credential the read above pushed,
        // now with a confirmed-live access token. Same refresh token, so main
        // treats it as an echo rather than a replacement.
        pushSessionToMain(data.session)
        return
      }
      if (error) {
        // Not "no credential" — "couldn't produce a usable session right now".
        // getSession() returns null whenever the stored access token has
        // expired, because renewing it is main's job. Keep the cached user, and
        // above all do NOT push a null token into main. The credential hand-off
        // above already happened, and main is refreshing.
        console.warn('[auth] getSession failed — keeping the last known session:', error.message)
        return
      }
      // A clean null with no error: there is genuinely nothing stored.
      setUser(null)
      pushSessionToMain(null)
    })

    const { data: sub } = supa.auth.onAuthStateChange((event, session) => {
      const u = session?.user
      if (u) {
        setUser({ id: u.id, email: u.email ?? null })
        pushSessionToMain(session)
        // Successful sign-in — clear the modal + reset flow state
        clearWaitTimeout()
        setAuthState('idle')
        setErrorMessage(null)
        setShowSignIn(false)
        return
      }
      // A null session on INITIAL_SESSION / TOKEN_REFRESHED / USER_UPDATED
      // means a refresh could not be completed. None of those is a sign-out.
      if (event !== 'SIGNED_OUT') return
      void honourSignOut()
    })

    // Main-process refresh sync. Main is the sole proactive refresher and also
    // refreshes reactively when paywall-route hits a 401; either way it
    // broadcasts the new pair here and we adopt it into supabase-js, which is
    // how the renderer's session stays fresh without ever refreshing itself.
    window.electronAPI.paywallOnTokenRefreshed?.((tokens) => {
      const accessToken = tokens?.accessToken ?? null
      const refreshToken = tokens?.refreshToken ?? null
      if (accessToken && refreshToken) {
        supa.auth.setSession({ access_token: accessToken, refresh_token: refreshToken })
          .catch((e) => console.warn('[auth] setSession after main refresh failed:', e))
        return
      }
      // BOTH null is main reporting that the server REJECTED the refresh
      // token. That is the one remote event that is a genuine sign-out, and
      // main has already cleared its own copy. Tear the local session down
      // too; scope 'local' because there is no credential left to revoke.
      // A half-filled pair is malformed, not a sign-out — ignore it.
      if (accessToken || refreshToken) return
      console.warn('[auth] main reports the refresh token was rejected — signing out')
      // Scope 'local': the credential has already been rejected, so there is
      // nothing left to revoke server-side. Full teardown, because this fires
      // exactly when the access token is stale — the case where supabase-js's
      // own signOut() quietly does nothing.
      void tearDownSession('local')
    })

    return () => {
      cancelled = true
      sub.subscription.unsubscribe()
      clearWaitTimeout()
    }
  }, [])

  // ─── Drain any deep-link callback the main process picked up before the
  //     renderer was ready to listen, then subscribe for new callbacks.
  useEffect(() => {
    let mounted = true

    async function drainPending() {
      const url = await window.electronAPI.paywallPopPendingAuthCallback?.()
      if (mounted && url) processCallbackUrl(url)
    }
    drainPending()

    window.electronAPI.paywallOnAuthCallback?.((url) => {
      if (mounted) processCallbackUrl(url)
    })

    // Main process can request that we surface the SignInScreen (e.g. from a
    // future "Sign in" menu item). Wire it via the same IPC channel.
    window.electronAPI.paywallOnShowSignIn?.(() => {
      if (mounted) setShowSignIn(true)
    })

    return () => { mounted = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function clearWaitTimeout() {
    if (waitTimeoutRef.current) {
      clearTimeout(waitTimeoutRef.current)
      waitTimeoutRef.current = null
    }
  }

  /**
   * Handle an `unmute://auth/callback?code=...` (PKCE flow) or `#access_token=...`
   * (implicit/magic-link flow) URL by handing it to supabase-js for the session
   * exchange. Successful exchange triggers onAuthStateChange above, which
   * resets `authState` and `showSignIn`.
   */
  const processCallbackUrl = useCallback(async (url: string) => {
    clearWaitTimeout()
    setAuthState('exchanging')
    setErrorMessage(null)
    try {
      const supa = getSupabase()
      const u = new URL(url)
      const code = u.searchParams.get('code')
      if (code) {
        const { error } = await supa.auth.exchangeCodeForSession(code)
        if (error) throw error
        // onAuthStateChange will fire and clear state.
        return
      }

      // Implicit / magic-link callback — tokens live in the hash fragment.
      const hash = u.hash.startsWith('#') ? u.hash.slice(1) : u.hash
      const params = new URLSearchParams(hash)
      const access_token = params.get('access_token')
      const refresh_token = params.get('refresh_token')
      if (access_token && refresh_token) {
        const { error } = await supa.auth.setSession({ access_token, refresh_token })
        if (error) throw error
        return
      }

      throw new Error('Callback URL had no code or tokens — try again.')
    } catch (e) {
      setAuthState('error')
      setErrorMessage(e instanceof Error ? e.message : 'Sign-in failed.')
    }
  }, [])

  const openSignIn = useCallback(() => {
    if (user) return
    setErrorMessage(null)
    setAuthState('idle')
    setShowSignIn(true)
  }, [user])

  const closeSignIn = useCallback(() => {
    setShowSignIn(false)
  }, [])

  const cancelSignIn = useCallback(() => {
    clearWaitTimeout()
    setAuthState('idle')
    setErrorMessage(null)
  }, [])

  const signInWithGoogle = useCallback(async () => {
    setAuthState('opening')
    setErrorMessage(null)
    try {
      const supa = getSupabase()
      const { data, error } = await supa.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: 'unmute://auth/callback', skipBrowserRedirect: true },
      })
      if (error || !data.url) {
        setAuthState('error')
        setErrorMessage(error?.message ?? 'Failed to start Google sign-in.')
        return
      }
      const opened = await window.electronAPI.paywallOpenExternal?.(data.url)
      if (!opened) {
        setAuthState('error')
        setErrorMessage("Couldn't open your browser. Copy the link manually below.")
        return
      }
      setAuthState('waiting')
      // Stuck-state guard — if the user closes the browser tab without
      // completing OAuth we want to release the modal eventually.
      clearWaitTimeout()
      waitTimeoutRef.current = setTimeout(() => {
        setAuthState((s) => (s === 'waiting' ? 'idle' : s))
      }, OAUTH_WAIT_TIMEOUT_MS)
    } catch (e) {
      setAuthState('error')
      setErrorMessage(e instanceof Error ? e.message : 'Sign-in failed.')
    }
  }, [])

  const signInWithMagicLink = useCallback(
    async (email: string): Promise<{ ok: boolean; message: string }> => {
      if (!email.trim()) return { ok: false, message: 'Enter an email first.' }
      setAuthState('opening')
      setErrorMessage(null)
      try {
        const supa = getSupabase()
        const { error } = await supa.auth.signInWithOtp({
          email: email.trim(),
          options: { emailRedirectTo: 'unmute://auth/callback' },
        })
        if (error) {
          setAuthState('error')
          setErrorMessage(error.message)
          return { ok: false, message: error.message }
        }
        setAuthState('waiting')
        clearWaitTimeout()
        waitTimeoutRef.current = setTimeout(() => {
          setAuthState((s) => (s === 'waiting' ? 'idle' : s))
        }, OAUTH_WAIT_TIMEOUT_MS)
        return {
          ok: true,
          message: `Magic link sent to ${email.trim()}. Open it on this Mac to finish signing in.`,
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Something went wrong.'
        setAuthState('error')
        setErrorMessage(msg)
        return { ok: false, message: msg }
      }
    },
    []
  )

  const pasteAuthUrl = useCallback(async (url: string): Promise<boolean> => {
    const u = url.trim()
    if (!u.startsWith('unmute://auth/callback')) return false
    // Hand directly to the same exchange path the deep-link uses.
    await processCallbackUrl(u)
    return true
  }, [processCallbackUrl])

  /** Sign out at the user's request. 'global' so the refresh token is revoked
   *  server-side too, when supabase-js can still reach the endpoint. */
  const signOut = useCallback(async () => {
    await tearDownSession('global')
  }, [tearDownSession])

  const value: AuthContextValue = {
    user,
    signedIn: !!user,
    authState,
    errorMessage,
    showSignIn,
    sessionEpoch,
    openSignIn,
    closeSignIn,
    cancelSignIn,
    signInWithGoogle,
    signInWithMagicLink,
    pasteAuthUrl,
    signOut,
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}
