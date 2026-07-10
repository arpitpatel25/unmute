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
import { getSupabase } from './supabase-client'

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
  const setUser = useCallback((u: AuthUser | null) => { setUserState(u); writeCachedUser(u) }, [])
  const [authState, setAuthState] = useState<AuthState>('idle')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [showSignIn, setShowSignIn] = useState(false)
  // Bumped after each successful push of a token-bearing session to main —
  // see AuthContextValue.sessionEpoch.
  const [sessionEpoch, setSessionEpoch] = useState(0)

  const waitTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

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

    supa.auth.getSession().then(({ data }) => {
      if (cancelled) return
      const u = data.session?.user
      setUser(u ? { id: u.id, email: u.email ?? null } : null)
      // Important: on cold start we still need to tell main about a restored
      // session (the keychain bridge persists tokens but main starts empty).
      pushSessionToMain(data.session)
    })

    const { data: sub } = supa.auth.onAuthStateChange((_event, session) => {
      const u = session?.user
      setUser(u ? { id: u.id, email: u.email ?? null } : null)
      pushSessionToMain(session)
      if (u) {
        // Successful sign-in — clear the modal + reset flow state
        clearWaitTimeout()
        setAuthState('idle')
        setErrorMessage(null)
        setShowSignIn(false)
      }
    })

    // Main-process forced refresh sync. When paywall-route hits a 401 on a
    // managed call, it refreshes via /auth/v1/token directly and broadcasts
    // the new tokens here. We adopt them into supabase-js so the renderer's
    // next auto-refresh doesn't re-use the now-rotated old refresh token
    // (which Supabase would reject as a replay attempt and sign the user
    // out of the app).
    window.electronAPI.paywallOnTokenRefreshed?.(({ accessToken, refreshToken }) => {
      if (!accessToken || !refreshToken) return
      supa.auth.setSession({ access_token: accessToken, refresh_token: refreshToken })
        .catch((e) => console.warn('[auth] setSession after main refresh failed:', e))
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

  const signOut = useCallback(async () => {
    try {
      await getSupabase().auth.signOut()
    } catch {
      /* swallow — onAuthStateChange will still clear state */
    }
  }, [])

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
