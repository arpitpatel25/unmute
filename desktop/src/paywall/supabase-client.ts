// Supabase client initialized in the renderer. This is the ONLY supabase
// client in the product — main has no supabase-js instance; it talks to the
// auth REST API with a plain fetch (electron/paywall-glue.ts). The header
// here used to claim main had "its own client"; it never did, and believing
// it would make the refresh-ownership split below look like a choice between
// two clients rather than what it is.
//
// The renderer owns sign-in. It does NOT own refresh — main does, and this
// client is actively prevented from refreshing. See the long comment above
// rendererFetchWithoutRefresh.
//
// Tokens are stored in the OS keychain via Electron IPC, NOT in localStorage.
// We override Supabase's storage adapter to delegate to the main process.

import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// These come from the build script — substituted at compile time so
// nothing is hardcoded in the OSS engine's source.
declare const __SUPABASE_URL__: string
declare const __SUPABASE_ANON_KEY__: string

// ─── Keychain-backed storage adapter ────────────────────────────
// Bridges supabase-js to electron-store (which sits behind the keychain).
// All keychain access goes through IPC to the main process.

const KEYCHAIN_STORAGE = {
  async getItem(key: string): Promise<string | null> {
    return await window.electronAPI.paywallKeychainGet(key)
  },
  async setItem(key: string, value: string): Promise<void> {
    await window.electronAPI.paywallKeychainSet(key, value)
  },
  async removeItem(key: string): Promise<void> {
    await window.electronAPI.paywallKeychainDelete(key)
  },
}

// ─── The renderer is not allowed to refresh ─────────────────────
//
// The main process owns proactive token refresh (see the long comment on
// scheduleAutoRefresh in electron/paywall-glue.ts for why, and for the outage
// that two competing refreshers once caused). This is the half of that
// arrangement that makes it structural rather than merely intended.
//
// `autoRefreshToken: false` alone is NOT enough. With it off, @supabase/auth-js
// (2.108.2) still calls the token endpoint from __loadSession() — reached by
// getSession(), getUser(), and by the auth listener supabase-js registers in
// its own constructor — whenever the stored session is within its 90s expiry
// margin. Only _recoverAndRefresh() honours the flag. So the flag is set AND
// the request is refused here at the transport layer: the renderer's client
// physically cannot reach the token endpoint, whatever supabase-js decides
// it wants to do.
//
// Refusing by *throwing* is deliberate. auth-js turns a thrown fetch into an
// AuthRetryableFetchError, and its refresh path treats a retryable error as
// "the network is down" — it preserves the stored session and does NOT emit
// SIGNED_OUT. A rejected-looking HTTP response would destroy the session
// instead. The bounded internal retry (a few attempts with backoff) never
// touches the network; it re-enters this guard and is refused again.
//
// The session stays fresh because main broadcasts every new token pair on
// `paywall:token-refreshed` and AuthContext adopts it with setSession.

/** True for a Supabase refresh-token grant.
 *
 *  Parsed rather than string-matched, so parameter order and percent-encoding
 *  cannot slip past it. Deliberately *looser* than the one URL shape
 *  @supabase/auth-js 2.108.2 happens to build today (`${authUrl}/token?
 *  grant_type=refresh_token`, always absolute, no extra params): this is a
 *  safety interlock, and an interlock that only recognises the exact string
 *  the current version emits would be silently unpicked by a dependency bump.
 *  So: relative URLs are resolved and a trailing slash is tolerated. The path
 *  test is `/token` rather than `/auth/v1/token` for the same reason — any
 *  request to a `…/token` endpoint asking for `grant_type=refresh_token` is a
 *  refresh grant whatever the mount point. The `catch` is a backstop for the
 *  rare input `new URL()` rejects outright; note that resolving against a base
 *  means almost nothing reaches it, so it is the belt, not the braces.
 *
 *  It must not over-match: blocking a non-refresh auth call would break
 *  sign-in. Every other grant auth-js issues (`password`, `pkce`, `id_token`,
 *  `web3`) and every non-token endpoint (`/user`, `/logout`, `/authorize`)
 *  fails the `grant_type` test and goes to the network untouched. */
function isRefreshGrant(rawUrl: string): boolean {
  try {
    // The base only matters for a relative URL; an absolute one ignores it.
    const u = new URL(rawUrl, 'http://unmute.invalid')
    const path = u.pathname.replace(/\/+$/, '')
    return path.endsWith('/token') && u.searchParams.get('grant_type') === 'refresh_token'
  } catch {
    // Unparseable. Don't wave it through just because URL() choked on it —
    // if it names the grant at all, refuse. Failing closed here can only ever
    // affect a request that is both malformed AND a refresh grant.
    return /grant_type=refresh(_|%5f|%5F)token/i.test(rawUrl)
  }
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

/** The fetch handed to supabase-js. Everything except a refresh-token grant
 *  goes to the network untouched; a refresh-token grant never leaves this
 *  process. Exported for inspection/tests — it is the enforcement point for
 *  "exactly one process calls the token endpoint". */
export const rendererFetchWithoutRefresh: typeof fetch = (input, init) => {
  if (isRefreshGrant(requestUrl(input))) {
    console.warn(
      '[supabase] blocked a renderer token refresh — the main process owns refresh ' +
      '(see scheduleAutoRefresh in paywall-glue.ts). The session is kept; main will push a new token.',
    )
    return Promise.reject(new Error('unmute: token refresh belongs to the main process'))
  }
  return fetch(input, init)
}

let cachedClient: SupabaseClient | null = null

/** True when the managed-cloud Supabase backend is configured (build/dev env set). */
export function isSupabaseConfigured(): boolean {
  return Boolean(__SUPABASE_URL__ && __SUPABASE_ANON_KEY__)
}

export function getSupabase(): SupabaseClient {
  if (cachedClient) return cachedClient
  // Defensive: if the build/dev env didn't inject the URL (e.g. a dev run
  // without desktop/.env.dev), createClient("") throws "supabaseUrl is required"
  // and crashes the ENTIRE renderer to a blank screen. Fall back to a harmless
  // localhost URL so the app still renders — cloud sign-in is simply disabled,
  // while Local / BYOK / Remote (which don't need our backend) keep working.
  const url = __SUPABASE_URL__ || 'http://localhost:54321'
  const anonKey = __SUPABASE_ANON_KEY__ || 'anon-key-not-configured'
  if (!isSupabaseConfigured()) {
    console.warn('[supabase] __SUPABASE_URL__/__SUPABASE_ANON_KEY__ unset — cloud sign-in disabled. Set desktop/.env.dev for managed cloud in dev.')
  }
  cachedClient = createClient(url, anonKey, {
    auth: {
      // @ts-expect-error - supabase-js types want Storage but our async adapter
      // satisfies it functionally in v2.
      storage: KEYCHAIN_STORAGE,
      // Main owns proactive refresh. This turns off the ticker and the
      // recover-on-init/on-visibility refresh; rendererFetchWithoutRefresh
      // below closes the paths this flag does not cover.
      autoRefreshToken: false,
      persistSession: true,
      detectSessionInUrl: false, // we handle deep links explicitly via Electron
    },
    // Reaches the auth client too — supabase-js passes settings.global.fetch
    // straight into its GoTrueClient.
    global: { fetch: rendererFetchWithoutRefresh },
  })
  return cachedClient
}

// ─── Reading the credential without going through supabase-js ────
//
// getSession() fuses "read the session" with "refresh it if stale": once the
// stored access token has expired it tries to refresh, and because refreshing
// is main's job it comes back `session: null` even though a perfectly good
// refresh token is sitting in the keychain. Two things need the credential
// itself rather than a usable session:
//   - cold start, where main has nothing and only the refresh token can get it
//     going (main is the only process that can use one), and
//   - sign-out, which must be able to destroy the credential even when
//     supabase-js refuses to look at it.
// Both read and write through the same keychain IPC the storage adapter uses.
// Nothing about how tokens are stored changes.

/** The key supabase-js keeps its session under. Read off the client so it can
 *  never drift from the one actually in use; the fallback is supabase-js's own
 *  derivation (`sb-${hostname-first-label}-auth-token`). */
function sessionStorageKey(): string {
  const fromClient = (getSupabase() as unknown as { storageKey?: string }).storageKey
  if (fromClient) return fromClient
  try {
    return `sb-${new URL(__SUPABASE_URL__ || 'http://localhost:54321').hostname.split('.')[0]}-auth-token`
  } catch {
    return 'sb-localhost-auth-token'
  }
}

export interface StoredSession {
  accessToken: string | null
  refreshToken: string
  expiresAt: number | null
  user: { id: string; email: string | null } | null
}

/** The persisted session as it sits in the keychain, or null if there is none.
 *  Returns only sessions that still carry a refresh token — without one there
 *  is nothing main could do with it. */
export async function readStoredSession(): Promise<StoredSession | null> {
  try {
    const raw = await window.electronAPI.paywallKeychainGet(sessionStorageKey())
    if (!raw) return null
    const s = JSON.parse(raw) as {
      access_token?: unknown
      refresh_token?: unknown
      expires_at?: unknown
      user?: { id?: unknown; email?: unknown } | null
    }
    if (typeof s?.refresh_token !== 'string' || !s.refresh_token) return null
    return {
      accessToken: typeof s.access_token === 'string' ? s.access_token : null,
      refreshToken: s.refresh_token,
      expiresAt: typeof s.expires_at === 'number' ? s.expires_at : null,
      user: typeof s.user?.id === 'string'
        ? { id: s.user.id, email: typeof s.user.email === 'string' ? s.user.email : null }
        : null,
    }
  } catch {
    return null
  }
}

/** Destroy the persisted session.
 *
 *  Sign-out cannot rely on supabase-js alone: GoTrueClient._signOut() reads the
 *  session first and returns early — clearing nothing, emitting no SIGNED_OUT —
 *  if that read errors. Once the access token has expired the read always
 *  errors, because the refresh it wants is ours to refuse. Without this,
 *  "Sign out" would silently do nothing exactly when a user most wants it to. */
export async function clearStoredSession(): Promise<void> {
  try {
    await window.electronAPI.paywallKeychainDelete(sessionStorageKey())
  } catch {
    /* best-effort */
  }
}

/** Convenience: get the current access token for API calls, or null.
 *
 *  Currently unused, and think twice before using it: since main owns refresh,
 *  a `null` here can mean "the access token is stale and main hasn't pushed the
 *  new one yet" as easily as "signed out". The authoritative token for any API
 *  call lives in the main process (paywall-glue.getPaywallAccessToken, which
 *  ensureFreshToken keeps current). */
export async function getAccessToken(): Promise<string | null> {
  const supa = getSupabase()
  const { data } = await supa.auth.getSession()
  return data.session?.access_token ?? null
}

/** Convenience: get the current user, or null.
 *
 *  Currently unused, and carries the same hazard as getAccessToken above —
 *  more sharply, because it is not obvious from the name. `getUser()` reaches
 *  supabase-js's __loadSession, which tries to refresh a session inside its
 *  90s expiry margin; that refresh is main's to make and ours to refuse, so on
 *  a stale token this call sits in auth-js's bounded retry loop for ~25s and
 *  then returns null for a user who is perfectly signed in. Read the user from
 *  `useAuth()` (which is kept current by main's broadcasts) or ask main via
 *  `paywallGetUser()`. Do not await this on any path a user is waiting on. */
export async function getCurrentUser(): Promise<{ id: string; email: string | null } | null> {
  const supa = getSupabase()
  const { data } = await supa.auth.getUser()
  if (!data.user) return null
  return { id: data.user.id, email: data.user.email ?? null }
}
