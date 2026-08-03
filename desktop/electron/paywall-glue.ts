// Minimal glue between OSS engine main.ts and the paywall layer in
// electron/paywall/. For this dev build we only wire the UI surface
// (auth, balance display, engine selector). Provider routing through
// our managed pipeline lands in a follow-up.

import { app, ipcMain, BrowserWindow } from 'electron'
import path from 'path'
import { registerAuthIPC, setPendingDeepLink, keychainGet, keychainSet } from './auth-ipc'
import { startBalancePolling } from './balance-ipc'
import Store from 'electron-store'
import { paywallFetch, verifyKeepAlive, startPoolStatsSampling } from './paywall-net'
import { deliverCaptureQuality, invokeDraftAccept } from './main-extensions'
// STATIC import — lazy/missing imports die silently in the bundled main
// (this exact line was missing on 2026-07-15 and capture-quality telemetry
// silently vanished; the handler's try/catch ate the ReferenceError).
import { logTelemetry } from '../dictationTelemetry'
// Unmute Remote trigger gate — STATIC for the same reason as the line above.
import {
  setRemoteTriggerEntitled,
  setRemoteTriggerUserPref,
  resetRemoteTriggerUserPref,
  getRemoteTriggerState,
} from '../remoteTriggerGate'

type EngineMode = 'auto' | 'managed' | 'local'
interface PaywallSettings {
  engineMode: EngineMode
  // Language picker — used by paywall-route to fill the STT `language` form
  // field. When autoDetect=true, the field is omitted from the request so
  // Whisper auto-detects; when false, sttLanguage is sent. Whisper's API
  // is binary: one language code or omit (auto-detect). It does not accept
  // multiple codes or a constrained-detect subset, so the UI is a single
  // language picker, not a multi-select.
  sttLanguageAutoDetect?: boolean
  sttLanguage?: string
  // Output formatting toggles. lowercaseOutput, when on, applies
  // .toLowerCase() to the final transcript/LLM output before it's pasted
  // or copied to the clipboard. User-requested feature; sub-microsecond
  // cost so no perf budget needed.
  lowercaseOutput?: boolean
  // Post-STT cleanup pass (fillers/stutters removed via a fast LLM call,
  // 900ms budget, fails open to the raw transcript). Default ON.
  dictationCleanup?: boolean
  // Last-known "this account's plan includes Unmute Remote". Cached ONLY so a
  // Pro user's Remote key works during the seconds before the subscription
  // fetch resolves on a cold start — the live answer always overwrites it.
  // Never a grant on its own: the refresh below runs on every launch.
  remoteTriggerEntitled?: boolean
}
const settings = new Store<PaywallSettings>({ name: 'unmute-paywall-settings' })

/** Read the STT language to send to the pipeline. Returns `null` when
 *  auto-detect is on — caller should omit the `language` form field. */
export function getSTTLanguageForRequest(): string | null {
  const auto = settings.get('sttLanguageAutoDetect', true)
  if (auto) return null
  return settings.get('sttLanguage', 'en') ?? null
}

/** True if the user wants final output forced to lowercase before paste/
 *  clipboard. Used by sessionManager just before deliverOutput so every
 *  flow (dictation / transform / context / quote) gets the same treatment. */
export function isLowercaseOutputEnabled(): boolean {
  return settings.get('lowercaseOutput', false) === true
}

/** Apply the user's output-formatting preferences to a transcript string.
 *  Single entry point for every delivery site (paste / clipboard / chained
 *  flows) so future formatting options (UPPERCASE, sentence case, strip-
 *  punctuation, …) slot into one place rather than every call site.
 *
 *  Current transforms, applied in order:
 *    1. Strip leading whitespace. Whisper has a long-standing habit of
 *       prefixing transcripts with a leading space (especially after
 *       silence), which feels like a bug to users when it pastes into
 *       an LLM prompt or code editor. Always-on; not opt-in. Trailing
 *       whitespace is left alone because users sometimes dictate
 *       sentences they want to keep punctuation-spaced for.
 *    2. Lowercase, if enabled. */
export function formatOutputForUser(text: string): string {
  if (!text) return text
  let out = text.replace(/^[\s ]+/, '')
  if (isLowercaseOutputEnabled()) out = out.toLowerCase()
  return out
}

interface PaywallSession {
  accessToken: string | null
  refreshToken: string | null
  expiresAt: number | null   // unix seconds; null = unknown
  user: { id: string; email: string | null } | null
}

let currentSession: PaywallSession = {
  accessToken: null,
  refreshToken: null,
  expiresAt: null,
  user: null,
}

let refreshTimer: NodeJS.Timeout | null = null
let refreshInFlight: Promise<boolean> | null = null

// ─── Proactive-refresh tuning ────────────────────────────────────
// Refresh this far ahead of expiry. Deliberately much larger than supabase-js's
// own EXPIRY_MARGIN_MS (90s, = AUTO_REFRESH_TICK_THRESHOLD * TICK_DURATION in
// @supabase/auth-js): main renews while the renderer's copy of the session still
// looks fresh, so the renderer never even reaches for the token endpoint.
const REFRESH_MARGIN_SEC = 300
// Floor between two proactive refreshes, whatever the server says about expiry.
// Insurance against a hot loop if a token ever comes back already inside the
// margin (refreshAccessToken re-arms the timer on every success).
const MIN_REFRESH_INTERVAL_MS = 30_000
// First re-arm delay after a failed refresh (offline, 5xx, or a rejection that
// wasn't decisive yet — see refreshAccessToken).
const REFRESH_RETRY_MS = 60_000
// ...doubling on each consecutive failure, capped here. Without the cap, a
// Supabase incident lasting hours would have every installed client hitting
// /auth/v1/token once a minute for its whole duration — new outbound traffic
// this pack would otherwise have introduced, since before it nothing re-armed
// after a failure at all. Recovery is not delayed by the backoff in the case
// that matters: ensureFreshToken() refreshes on demand at the top of every
// dictation, and powerMonitor's 'resume' does the same on wake.
const REFRESH_RETRY_MAX_MS = 15 * 60_000
// setTimeout's delay is a signed 32-bit int; larger values wrap and fire on the
// next tick instead of later. Everything armed here is clamped to it.
const MAX_TIMER_DELAY_MS = 2_147_483_647
// Ceiling on a single token request. Generous for a healthy round trip, short
// enough that a hung socket cannot hold up the dictation path — see the call.
const REFRESH_REQUEST_TIMEOUT_MS = 15_000
// Consecutive failed refreshes, for that backoff. Reset by any success.
let consecutiveRefreshFailures = 0
// Consecutive rejections we declined to act on because we could not tell
// whether the access token was still good (no expiry recorded). Bounded, so
// that path still converges on a sign-out instead of retrying forever.
let undecidedRejections = 0
const MAX_UNDECIDED_REJECTIONS = 3
let lastProactiveRefreshMs = 0
// Bumped whenever the current credential is torn down (clearSessionState) or
// replaced by a different one (paywall:set-session with a new refresh token).
// A refresh that started before that must not write its result into the session
// that replaced it — otherwise signing out while a refresh is in flight
// resurrects the user with a fresh token and re-arms the refresh timer.
// (auth-js guards its own refresh the same way; see _sessionRemovalEpoch.)
let sessionGeneration = 0

// ─── Public getters for sessionManager to consult before routing ───
export function getPaywallAccessToken(): string | null {
  return currentSession.accessToken
}
export function getPaywallEngineMode(): EngineMode {
  return settings.get('engineMode', 'auto')
}
/** Post-STT cleanup pass toggle — default ON. Consulted by sessionManager's
 *  maybeCleanupDictation before making the LLM polish call. */
export function getDictationCleanupEnabled(): boolean {
  return (settings.get('dictationCleanup') as boolean | undefined) ?? true
}
export function getPaywallUser(): { id: string; email: string | null } | null {
  return currentSession.user
}

// ─── Unmute Remote trigger entitlement ──────────────────────────
//
// Remote (the task trigger on the key opposite dictation) ships with the
// 'unmute' plan only. paywall-glue owns the plan → gate translation; the gate
// module (../remoteTriggerGate) owns the rule, and keyboard.ts reads it on
// every press. The user's own on/off lives in the gate too, session-scoped by
// design — it is NOT written to `settings`, so reopening the app restores the
// default (on for Pro).

/** Broadcast the current gate state so every open window's toggle agrees
 *  (Settings, the Remote tab, the overlay's task panel). */
function broadcastRemoteTriggerState(): void {
  const state = getRemoteTriggerState()
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send('paywall:remote-trigger-changed', state)
  }
}

/** Apply a freshly-read subscription to the gate. `null` means "we couldn't
 *  tell" (no token yet / network blip) — keep the last known answer rather
 *  than dropping a paying user's Remote key mid-session. */
function applySubscriptionToRemoteTrigger(
  sub: { active: boolean; plan: 'dictation' | 'unmute' | null } | null,
): void {
  if (!sub) return
  const entitled = !!sub.active && sub.plan === 'unmute'
  settings.set('remoteTriggerEntitled', entitled)
  setRemoteTriggerEntitled(entitled)
  broadcastRemoteTriggerState()
}

/** Re-read the subscription and push the answer into the gate. Cheap enough to
 *  call on sign-in, on settings-open and at startup; silent on failure. */
export async function refreshRemoteTriggerEntitlement(): Promise<void> {
  const token = currentSession.accessToken
  if (!token) return
  try {
    const { fetchSubscription } = await import('./managed-client')
    applySubscriptionToRemoteTrigger(await fetchSubscription(token))
  } catch (e) {
    console.warn(
      '[paywall-glue] remote-trigger entitlement refresh failed:',
      e instanceof Error ? e.message : e,
    )
  }
}


// Substituted by build script
declare const __SUPABASE_URL__: string
declare const __SUPABASE_ANON_KEY__: string

/** supabase-js's own storage key, derived exactly as the renderer derives it
 *  (`supabase-client.ts:177`): `sb-<first hostname label>-auth-token`. Main and
 *  the renderer MUST agree on this string — they are reading and writing the
 *  same keychain entry. */
function authStorageKey(): string {
  try {
    return `sb-${new URL(__SUPABASE_URL__ || 'http://localhost:54321').hostname.split('.')[0]}-auth-token`
  } catch {
    return 'sb-localhost-auth-token'
  }
}

/**
 * Persist a rotation main performed itself.
 *
 * WHY THIS EXISTS. Main holds `currentSession` in memory only. Before this,
 * every rotation reached disk exclusively by being broadcast to a live
 * renderer, which wrote it back through supabase-js's storage adapter. That
 * chain has a hole: `BrowserWindow.getAllWindows()` reaches live webContents
 * only, and on macOS the red button DESTROYS the main window while the app
 * carries on in the notch — which is how this app is normally used. Main would
 * then rotate hourly with nobody listening, leaving an already-rotated, dead
 * refresh token in the keychain. The next cold start hands main that dead
 * token, the refresh is correctly rejected, and the user is signed out
 * permanently having done nothing wrong. That is a regression against the old
 * arrangement, where one process both refreshed and persisted.
 *
 * READ-MODIFY-WRITE, NEVER A FRESH OBJECT. supabase-js validates whatever it
 * loads (`_isValidSession`) and calls `_removeSession()` on anything it judges
 * malformed. Writing a partial session here would not "mostly work" — it would
 * delete the credential outright. So we parse what is stored, patch only the
 * four token fields, and write the rest back untouched.
 *
 * Best-effort by design: a failure here must never break a refresh that
 * otherwise succeeded. The broadcast still happens either way.
 */
function persistRotatedSession(): void {
  try {
    const key = authStorageKey()
    const raw = keychainGet(key)
    if (!raw) return // nothing stored yet — the renderer owns first write
    const stored = JSON.parse(raw) as Record<string, unknown>
    if (!stored || typeof stored !== 'object') return
    stored.access_token = currentSession.accessToken
    stored.refresh_token = currentSession.refreshToken
    if (currentSession.expiresAt != null) {
      stored.expires_at = currentSession.expiresAt
      stored.expires_in = Math.max(0, currentSession.expiresAt - Math.floor(Date.now() / 1000))
    }
    keychainSet(key, JSON.stringify(stored))
  } catch (e) {
    console.warn('[paywall-glue] could not persist rotated session:', (e as Error).message)
  }
}

/** True when a non-2xx body is recognisably GoTrue's own error shape, i.e. the
 *  auth server really did answer. GoTrue replies to a rejected refresh token
 *  with JSON carrying some of `error_code` / `code` / `error` / `msg` /
 *  `error_description`; a captive portal or a proxy replies with HTML. Only a
 *  real Supabase verdict is allowed to end a session — see the call site. */
function looksLikeSupabaseAuthError(raw: string): boolean {
  try {
    const j = JSON.parse(raw) as Record<string, unknown>
    if (!j || typeof j !== 'object') return false
    return ['error_code', 'code', 'error', 'msg', 'error_description']
      .some((k) => typeof j[k] === 'string' || typeof j[k] === 'number')
  } catch {
    return false
  }
}

/**
 * Force a token refresh by calling Supabase REST directly using the stored
 * refresh_token. Dedupes concurrent calls so a burst of 401s only refreshes
 * once. Returns true if a new token was obtained.
 */
export async function refreshAccessToken(): Promise<boolean> {
  if (!currentSession.refreshToken) return false
  if (refreshInFlight) return refreshInFlight
  refreshInFlight = (async () => {
    const t0 = Date.now()
    const generationAtStart = sessionGeneration
    try {
      const res = await fetch(`${__SUPABASE_URL__}/auth/v1/token?grant_type=refresh_token`, {
        method: 'POST',
        headers: {
          apikey: __SUPABASE_ANON_KEY__,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ refresh_token: currentSession.refreshToken }),
        // Bound it. `refreshInFlight` dedupes every caller onto this one
        // promise, and two of those callers are `await ensureFreshToken()` on
        // the managed-STT path (paywall-route) — so a hung socket here doesn't
        // just delay a refresh, it stalls a dictation for as long as the
        // request takes to give up (undici's default body timeout is 300s).
        // A timeout rejects into the catch below, which keeps the session and
        // lets the retry timer try again.
        signal: AbortSignal.timeout(REFRESH_REQUEST_TIMEOUT_MS),
      })
      if (!res.ok) {
        // Commit guard FIRST, before anything reads or writes session state.
        // If the session was torn down or replaced while this request was in
        // flight, this response is a verdict on a credential we no longer
        // hold. Acting on it would judge the REPLACEMENT by the old
        // credential's rejection and delete a credential nobody rejected.
        // Destructive paths need this guard at least as much as the
        // constructive one below.
        if (sessionGeneration !== generationAtStart) {
          console.warn('[paywall-glue] refresh outcome is for a session that has since been replaced — ignoring')
          return false
        }
        // The ONLY thing that means "signed out" is the server rejecting this
        // refresh token — revoked, already-rotated, or the account is gone. A
        // 5xx (including Cloudflare 520-530) or a 429 is the network having a
        // bad day; the credential is still good, so keep the session and let
        // the retry timer try again. This is the same split @supabase/auth-js
        // makes in lib/fetch.ts (NETWORK_ERROR_CODES → retryable → session
        // preserved; anything else → session removed).
        const transient = res.status >= 500 || res.status === 429
        if (transient) {
          console.warn(`[paywall-glue] token refresh failed transiently (${res.status}) — session kept`)
          undecidedRejections = 0
          return false
        }
        // Is this a verdict from Supabase, or from something standing in the
        // way of it? A hotel or conference captive portal, a corporate MITM
        // proxy and a misconfigured gateway all answer POSTs with a 4xx and an
        // HTML body — and the case where that matters most is the one where
        // this branch is most likely to be decisive: the laptop has been
        // asleep, so the access token is already expired, so none of the
        // protections below apply. GoTrue itself always answers a rejected
        // refresh with its own JSON error shape, so requiring that shape costs
        // nothing against the real server and keeps a portal from signing
        // anyone out. (auth-js draws the same line, via isAuthApiError on a
        // parsed body.) Note this is deliberately GoTrue's shape and not
        // Supabase's gateway's: a bare `{"message":"…"}` from Kong is treated
        // as transient, which is the right call — the auth server never saw it.
        const errorBody = await res.text().catch(() => '')
        if (!looksLikeSupabaseAuthError(errorBody)) {
          console.warn(
            `[paywall-glue] refresh failed with ${res.status} but the body is not a Supabase error ` +
            `(captive portal or proxy in the way?) — session kept`,
          )
          undecidedRejections = 0
          return false
        }
        // A rejection is only decisive once the ACCESS token is also gone.
        //
        // This timer fires REFRESH_MARGIN_SEC *before* expiry, so a rejection
        // here usually arrives while the user's access token still works
        // perfectly. Tearing the session down at that moment would sign out a
        // user whose credential is fine — and a non-2xx does not always mean
        // "revoked": a WAF rule, a captive portal, a corporate MITM proxy or a
        // misrouted 4xx all land here. Keep the session, let armRefreshTimer
        // retry, and only conclude "signed out" once the access token has
        // actually expired and the refresh token is the sole credential left —
        // at which point a rejection really does mean there is nothing to
        // recover. @supabase/auth-js draws the line in exactly the same place
        // and for the same reason (GoTrueClient._callRefreshToken: "destroying
        // it now would log out a user whose access token works").
        const nowSec = Math.floor(Date.now() / 1000)
        const expiresAt = currentSession.expiresAt
        if (currentSession.accessToken && expiresAt != null && expiresAt > nowSec) {
          console.warn(
            `[paywall-glue] refresh rejected (${res.status}) but the access token is still valid ` +
            `for ${expiresAt - nowSec}s — keeping the session and retrying`,
          )
          return false
        }
        // Expiry unknown: we hold an access token but nothing said when it
        // dies. That is reachable — readStoredSession() tolerates a session
        // with no numeric `expires_at`, and a refresh response can carry
        // neither `expires_at` nor `expires_in`. Treating unknown as expired
        // would put the whole "don't sign out a user whose token works"
        // protection back on the floor for exactly those sessions; treating it
        // as valid forever would make revocation undetectable. So: hold, but
        // only for a bounded number of rejections, then accept the verdict.
        if (currentSession.accessToken && expiresAt == null &&
            ++undecidedRejections < MAX_UNDECIDED_REJECTIONS) {
          console.warn(
            `[paywall-glue] refresh rejected (${res.status}) and this session has no recorded expiry — ` +
            `holding (${undecidedRejections}/${MAX_UNDECIDED_REJECTIONS}) before treating it as a sign-out`,
          )
          return false
        }
        undecidedRejections = 0
        console.warn(`[paywall-glue] refresh token REJECTED (${res.status}) — this is a real sign-out`)
        clearSessionState()
        // Tell the renderer on the channel it already listens to. A null token
        // pair is the "your credential was rejected" signal — see AuthContext.
        for (const w of BrowserWindow.getAllWindows()) {
          w.webContents.send('paywall:token-refreshed', { accessToken: null, refreshToken: null })
        }
        return false
      }
      const body = await res.json() as {
        access_token?: string
        refresh_token?: string
        expires_at?: number
        expires_in?: number
      }
      if (!body.access_token) return false
      // The session was torn down while this request was in flight (sign-out,
      // or another refresh being rejected). Drop the result on the floor: this
      // token belongs to a session that no longer exists.
      if (sessionGeneration !== generationAtStart) {
        console.warn('[paywall-glue] session ended mid-refresh — discarding the new token')
        return false
      }
      // A working credential clears the whole failure history: the retry
      // backoff goes back to its floor and any held-but-undecided rejections
      // are forgotten.
      consecutiveRefreshFailures = 0
      undecidedRejections = 0
      // Count REACTIVE refreshes (ensureFreshToken, the 401 path) against the
      // minimum-interval floor too, not just the timer's own. Without this a
      // reactive refresh that returns a token already inside the 300s margin
      // computes floorMs = 0 and re-arms at once, and a server issuing
      // short-lived tokens would sustain two rotations a minute indefinitely.
      lastProactiveRefreshMs = Date.now()
      currentSession.accessToken = body.access_token
      currentSession.refreshToken = body.refresh_token ?? currentSession.refreshToken
      currentSession.expiresAt = body.expires_at ??
        (body.expires_in ? Math.floor(Date.now() / 1000) + body.expires_in : null)
      console.log(`[paywall-glue] token refreshed in ${Date.now() - t0}ms (next exp in ${
        currentSession.expiresAt ? currentSession.expiresAt - Math.floor(Date.now() / 1000) : '?'
      }s)`)
      scheduleAutoRefresh()
      // DURABILITY BEFORE SYNC. Persist what we just minted ourselves, rather
      // than relying on a renderer to write it back for us. See
      // persistRotatedSession() for why this is not optional.
      persistRotatedSession()
      // Push the new pair to the renderer so its supabase-js client stays in
      // sync without ever refreshing itself. Send currentSession.refreshToken,
      // not body.refresh_token: if the server ever omits a rotated token the
      // former still holds the working one, and a null in this field is the
      // agreed "credential rejected" signal — it must never be sent by accident.
      for (const w of BrowserWindow.getAllWindows()) {
        w.webContents.send('paywall:token-refreshed', {
          accessToken: currentSession.accessToken,
          refreshToken: currentSession.refreshToken,
        })
      }
      return true
    } catch (e) {
      // The request never completed (offline, DNS, TLS). That is not the
      // server rejecting anything, so it breaks a run of rejections in exactly
      // the way a transient status does — keep `undecidedRejections` meaning
      // *consecutive* rejections rather than "rejections seen at some point".
      console.warn('[paywall-glue] token refresh threw:', (e as Error).message)
      undecidedRejections = 0
      return false
    } finally {
      refreshInFlight = null
    }
  })()
  return refreshInFlight
}

/**
 * Warm the pool's TLS socket NOW (best-effort, no auth — a cheap OPTIONS via the
 * undici pool). Used at recording-start and on power-resume — the cases the 25s
 * keep-alive timer can't cover: macOS App Nap suspends that timer while the app
 * is backgrounded, and sleep stops it entirely, so the socket goes cold and the
 * first dictation pays a fresh TLS handshake (which loses the local-fallback
 * race → silent offline). Warming here keeps the cloud STT call on a live socket.
 */
export async function warmNow(): Promise<void> {
  try { await paywallFetch('/v1/me', { method: 'OPTIONS' }) } catch { /* best-effort */ }
}

/**
 * Refresh the access token if it expires within `withinSec` (or already has), so
 * a managed call never eats a mid-request 401 — that reactive refresh adds
 * ~0.4-1.2s, enough to lose the cloud-vs-local race. Cheap when fresh (just an
 * expiry compare, no network); deduped via refreshAccessToken when it does run.
 */
export async function ensureFreshToken(withinSec = 120): Promise<void> {
  if (!currentSession.refreshToken || currentSession.expiresAt == null) return
  const now = Math.floor(Date.now() / 1000)
  if (currentSession.expiresAt - now <= withinSec) {
    await refreshAccessToken()
  }
}

/**
 * MAIN is the sole proactive refresher. Read this before changing it.
 *
 * ── The outage this arrangement exists to prevent ──
 * Main and the renderer both used to run a timer firing ~5min before expiry,
 * and both called /auth/v1/token?grant_type=refresh_token with the same
 * refresh token. Supabase rotates refresh tokens, so whichever request
 * arrived second presented an already-rotated token and was rejected.
 * supabase-js reads a rejected refresh as "session compromised", fires
 * SIGNED_OUT, and the user is kicked out of the app. That was real and it
 * shipped. Two refreshers is the failure mode; never reintroduce it.
 *
 * ── Why the renderer lost, and main won ──
 * The first fix kept the renderer as the sole refresher. It was right about
 * the race and wrong about which side to keep, because in unmute the renderer
 * is the part of the app that is not running. Users live in the notch; the
 * main window is hidden most of the time, and:
 *   - Electron throttles a hidden window's timers, and
 *   - supabase-js calls _stopAutoRefresh() on document.visibilityState
 *     'hidden' all by itself (GoTrueClient._onVisibilityChanged).
 * So the sole refresher stopped refreshing whenever the window was hidden,
 * the access token expired, and the next dictation fell back to the local
 * model and announced "you're signed out". Main has no window and no
 * visibility state, so nothing switches it off.
 *
 * Main's timer is not immune to *everything*, and it doesn't need to be.
 * macOS App Nap can stretch a backgrounded app's timers (see warmNow's
 * comment above — the 25s keep-alive already loses to it) and sleep stops
 * them outright. The difference is that main can always refresh ON DEMAND:
 * ensureFreshToken() runs at recording start (sessionManager) and again
 * before every managed call (paywall-route), and powerMonitor's 'resume'
 * handler calls it on wake (main-extensions). So a late timer costs one
 * on-demand refresh at the top of a dictation. A renderer that has stopped
 * refreshing has no such recovery — by the time supabase-js notices, the
 * routing decision has already been made and the call is on the local model.
 * "Main is awake" is not the load-bearing claim; "main can still act when it
 * wakes up" is.
 *
 * ── Why the race cannot come back ──
 * Turning the renderer's `autoRefreshToken` off is NOT sufficient on its own:
 * with it off, @supabase/auth-js still calls the token endpoint from
 * getSession(), getUser() and client construction whenever the stored session
 * is inside its 90s expiry margin (verified against the installed 2.108.2 —
 * see docs/superpowers/specs/launch/decisions/pack-e-auth.md). The renderer is
 * therefore additionally denied the endpoint at the transport layer: its
 * supabase client is built with a fetch that refuses
 * /auth/v1/token?grant_type=refresh_token outright (supabase-client.ts).
 * One process can reach the token endpoint. The other cannot reach it at all.
 *
 * Main pushes every new token pair to the renderer over
 * `paywall:token-refreshed`; AuthContext adopts it with setSession, so
 * supabase-js's own session stays fresh without it ever refreshing.
 *
 * ── The timer ──
 * Fires REFRESH_MARGIN_SEC (5min) BEFORE expiry, not on it. That margin is
 * deliberately far larger than supabase-js's 90s margin, so in normal
 * operation the renderer's session never even looks stale to it.
 * A due-in-the-past deadline (cold start with a stale token, wake from sleep)
 * fires as soon as the event loop allows, floored by MIN_REFRESH_INTERVAL_MS.
 */
function scheduleAutoRefresh(): void {
  if (refreshTimer) {
    clearTimeout(refreshTimer)
    refreshTimer = null
  }
  // No credential to renew. Sign-out and cold start both land here.
  if (!currentSession.refreshToken) return
  // Token of unknown lifetime — renew periodically rather than never, but
  // SLOWLY. This is the one branch where a *success* re-arms itself: with no
  // expiry there is no deadline to compute, so every refresh lands back here
  // and the interval becomes the rotation rate. At the retry delay that is one
  // rotation a minute, forever. At the cap it is four an hour, which keeps an
  // exotic session alive without turning into a self-inflicted storm.
  if (currentSession.expiresAt == null) {
    armRefreshTimer(REFRESH_RETRY_MAX_MS)
    return
  }
  const dueMs = (currentSession.expiresAt - REFRESH_MARGIN_SEC) * 1000 - Date.now()
  const floorMs = Math.max(0, MIN_REFRESH_INTERVAL_MS - (Date.now() - lastProactiveRefreshMs))
  armRefreshTimer(Math.max(dueMs, floorMs))
}

/** Arm the single refresh timer. Success re-arms via refreshAccessToken →
 *  scheduleAutoRefresh; a failure re-arms here with an exponential backoff, so
 *  an offline stretch doesn't leave the session with nothing to renew it and a
 *  multi-hour outage doesn't turn into once-a-minute polling from every client.
 *  A decisively rejected refresh token clears the session, so the guard below
 *  stops the loop rather than polling a credential that no longer exists. */
function armRefreshTimer(delayMs: number): void {
  if (refreshTimer) clearTimeout(refreshTimer)
  // setTimeout takes a signed 32-bit delay: anything larger silently fires on
  // the NEXT TICK instead of later, which here would mean a hot loop against
  // the token endpoint. `dueMs` is derived from a server-supplied expiry, so
  // clamp rather than trust it — and fall back to the retry delay for a NaN,
  // which Math.min/max would otherwise propagate straight into the timer.
  const safeDelayMs = Number.isFinite(delayMs)
    ? Math.min(Math.max(delayMs, 0), MAX_TIMER_DELAY_MS)
    : REFRESH_RETRY_MS
  refreshTimer = setTimeout(() => {
    refreshTimer = null
    void (async () => {
      const generationAtTick = sessionGeneration
      lastProactiveRefreshMs = Date.now()
      const ok = await refreshAccessToken()
      // A different credential arrived while that was in flight (a sign-in, an
      // account switch, a sign-out). It has already armed its own timer via
      // paywall:set-session → scheduleAutoRefresh, and this failure belongs to
      // the credential it replaced. Re-arming here would clobber the new
      // session's correct ~55-minute deadline with a retry meant for a dead
      // one, and would re-dirty the failure counters that set-session just
      // reset.
      if (sessionGeneration !== generationAtTick) return
      if (!ok && currentSession.refreshToken) {
        consecutiveRefreshFailures++
        armRefreshTimer(Math.min(
          REFRESH_RETRY_MS * 2 ** (consecutiveRefreshFailures - 1),
          REFRESH_RETRY_MAX_MS,
        ))
      }
    })()
  }, safeDelayMs)
}

/** Drop every trace of the current session. Shared by the explicit sign-out
 *  IPC and by refreshAccessToken when the server rejects the refresh token,
 *  so a revocation leaves main in exactly the state an explicit sign-out does. */
function clearSessionState(): void {
  sessionGeneration++
  currentSession = { accessToken: null, refreshToken: null, expiresAt: null, user: null }
  if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null }
  // The failure history belonged to the credential that just died. A sign-in
  // that follows must not inherit its backoff or its rejection tally.
  consecutiveRefreshFailures = 0
  undecidedRejections = 0
  // Signed out = no plan: lock Remote and forget this session's choice so the
  // next account starts from its own default.
  settings.set('remoteTriggerEntitled', false)
  setRemoteTriggerEntitled(false)
  resetRemoteTriggerUserPref()
  broadcastRemoteTriggerState()
}

/** Renderer pushes session state to main when supabase-js fires auth-state-change. */
function registerSessionBridge() {
  ipcMain.handle('paywall:set-session', async (_e, data: {
    accessToken: string | null
    refreshToken?: string | null
    expiresAt?: number | null
    user: { id: string; email: string | null } | null
  }) => {
    const hadToken = !!currentSession.accessToken
    // Refuse a push that is OLDER than what we already hold for the same user.
    // A renderer reads the credential from the keychain at startup, so a second
    // window — or a cold-start hand-off that crossed a refresh main had already
    // done — can arrive carrying the pre-rotation pair. Adopting it would swap a
    // good token for a rotated-away one, whose next refresh gets a 400 and
    // signs the user out for real. Sign-out pushes (no expiry) and account
    // switches (different user) are not affected.
    const sameUser = data.user?.id == null || data.user.id === currentSession.user?.id
    if (
      currentSession.refreshToken &&
      currentSession.expiresAt != null &&
      data.expiresAt != null &&
      data.expiresAt < currentSession.expiresAt &&
      sameUser
    ) {
      console.warn('[paywall-glue] ignoring a stale session push (older than the one held)')
      return true
    }
    // A different refresh token means this is a different credential (sign-in,
    // account switch, a token main didn't mint). Any refresh already in flight
    // was based on the credential being replaced, so its result is stale —
    // bump the generation so it is discarded rather than written back over
    // this one. An identical refresh token is the ordinary echo of main's own
    // broadcast coming back through setSession, and must NOT bump.
    if (currentSession.refreshToken !== (data.refreshToken ?? null)) {
      sessionGeneration++
      // Same reasoning as clearSessionState: a different credential starts
      // with a clean failure history.
      consecutiveRefreshFailures = 0
      undecidedRejections = 0
    }
    currentSession = {
      accessToken: data.accessToken,
      refreshToken: data.refreshToken ?? null,
      expiresAt: data.expiresAt ?? null,
      user: data.user,
    }
    // Schedule proactive refresh based on the new expiry
    scheduleAutoRefresh()
    // If we just gained a token (sign-in completed), kick the balance poll
    // immediately rather than waiting up to 60s for the next tick.
    if (!hadToken && data.accessToken) {
      const { refreshBalanceNow } = await import('./balance-ipc')
      await refreshBalanceNow()
      // Same moment, same reason: settle whether this account's plan includes
      // Remote so the trigger is live (or locked) before the first key press.
      void refreshRemoteTriggerEntitlement()
    }
    return true
  })
  ipcMain.handle('paywall:get-user', () => currentSession.user)
  ipcMain.handle('paywall:sign-out', () => {
    clearSessionState()
    return true
  })
  // NOTE: paywall:request-sign-in is registered by main-extensions.ts (it has
  // the improved implementation that emits paywall:show-sign-in to the
  // focused window). Don't register here — ipcMain.handle throws on a second
  // registration of the same channel.

  ipcMain.handle('paywall:get-engine-mode', () => settings.get('engineMode', 'auto'))
  ipcMain.handle('paywall:set-engine-mode', (_e, mode: EngineMode) => {
    settings.set('engineMode', mode)
    return true
  })

  // ─── Language picker settings (used by paywall-route's STT call) ───
  ipcMain.handle('paywall:get-language-auto-detect', () => {
    return settings.get('sttLanguageAutoDetect', true)
  })
  ipcMain.handle('paywall:set-language-auto-detect', (_e, enabled: boolean) => {
    settings.set('sttLanguageAutoDetect', !!enabled)
    return true
  })
  ipcMain.handle('paywall:get-language', () => {
    return settings.get('sttLanguage', 'en')
  })
  ipcMain.handle('paywall:set-language', (_e, code: string) => {
    if (typeof code !== 'string' || code.length === 0) return false
    settings.set('sttLanguage', code)
    return true
  })

  // ─── Output formatting (lowercase) ──────────────────────────
  ipcMain.handle('paywall:get-lowercase-output', () => {
    return settings.get('lowercaseOutput', false)
  })
  ipcMain.handle('paywall:set-lowercase-output', (_e, enabled: boolean) => {
    settings.set('lowercaseOutput', !!enabled)
    return true
  })

  // ─── Post-STT cleanup pass (fillers/stutters) ───────────────
  ipcMain.handle('paywall:get-dictation-cleanup', () => getDictationCleanupEnabled())
  ipcMain.handle('paywall:set-dictation-cleanup', (_e, v: boolean) => {
    settings.set('dictationCleanup', !!v)
    return true
  })

  // ─── AI format (instruction) on/off ─────────────────────────
  // Owns the persisted setting + pushes it to the keyListener so Caps Lock
  // events get dropped at the source when the user disables AI format.
  ipcMain.handle('paywall:get-instruction-enabled', () => {
    return settings.get('instructionEnabled', true)
  })
  ipcMain.handle('paywall:set-instruction-enabled', async (_e, enabled: boolean) => {
    const next = !!enabled
    settings.set('instructionEnabled', next)
    try {
      const { setInstructionEnabled } = await import('../keyListener')
      setInstructionEnabled(next)
    } catch (e) {
      console.warn(
        '[paywall-glue] could not push instructionEnabled to keyListener:',
        e instanceof Error ? e.message : e,
      )
    }
    return true
  })

  // ─── Unmute Remote trigger on/off ───────────────────────────
  // Sibling of the AI-format toggle above, with two differences: it is gated
  // on the Unmute (Pro) plan, and the user's choice lives for this app session
  // only (see ../remoteTriggerGate). Both handlers return the full state so the
  // renderer never has to infer `locked` itself.
  ipcMain.handle('paywall:get-remote-trigger', () => {
    // Opportunistic re-read: opening Settings is exactly when a stale
    // entitlement (just upgraded, just lapsed) should correct itself.
    void refreshRemoteTriggerEntitlement()
    return getRemoteTriggerState()
  })
  ipcMain.handle('paywall:set-remote-trigger-enabled', (_e, enabled: boolean) => {
    setRemoteTriggerUserPref(!!enabled) // no-ops when the plan doesn't include Remote
    const state = getRemoteTriggerState()
    broadcastRemoteTriggerState()
    return state
  })

  // ─── Dodo payments IPC ──────────────────────────────────────
  // All three go through payments-client which calls the payments worker.
  // They require a valid session — if the user isn't signed in, they
  // return a structured error rather than crashing the renderer.

  ipcMain.handle('paywall:create-subscription', async (
    _e,
    plan: 'dictation' | 'unmute',
    interval: 'month' | 'year',
  ) => {
    const token = currentSession.accessToken
    if (!token) return { ok: false, code: 'UNAUTHORIZED', message: 'sign in first' }
    if (plan !== 'dictation' && plan !== 'unmute') {
      return { ok: false, code: 'BAD_REQUEST', message: 'invalid plan' }
    }
    if (interval !== 'month' && interval !== 'year') {
      return { ok: false, code: 'BAD_REQUEST', message: 'invalid interval' }
    }
    const { createSubscriptionCheckout } = await import('./payments-client')
    return createSubscriptionCheckout(plan, interval, token)
  })

  ipcMain.handle('paywall:open-portal', async () => {
    const token = currentSession.accessToken
    if (!token) return { ok: false, code: 'UNAUTHORIZED', message: 'sign in first' }
    const { openCustomerPortal } = await import('./payments-client')
    return openCustomerPortal(token)
  })

  // In-app upgrade (Dictation → Unmute) via Dodo's change-plan — the worker
  // prorates the existing subscription, no second subscription is created.
  ipcMain.handle('paywall:change-plan', async () => {
    const token = currentSession.accessToken
    if (!token) return { ok: false, error: 'UNAUTHORIZED', message: 'sign in first' }
    const { changePlan } = await import('./payments-client')
    return changePlan(token)
  })

  // Subscription/entitlement status — read off the same /v1/me status
  // endpoint as the balance poll. Used by Billing's post-checkout poll and
  // the subscription-status pill.
  ipcMain.handle('paywall:get-subscription', async () => {
    const token = currentSession.accessToken
    // No token yet ≠ "inactive". On cold start the renderer's session token
    // hasn't propagated to main yet (it arrives via paywall:set-session after
    // supabase getSession resolves). Returning a definitive { active:false }
    // here is exactly what made signed-in Pro users flash "Inactive" until a
    // refresh. Return null = "unknown, ask again once the token is live" — the
    // renderer keeps its cached/last-known plan instead of showing Free.
    if (!token) return null
    const { fetchSubscription } = await import('./managed-client')
    const sub = await fetchSubscription(token)
    // Free ride for the Remote gate: this poll already knows the plan, so an
    // upgrade (or lapse) flips the trigger without a second round trip.
    applySubscriptionToRemoteTrigger(sub)
    return sub ?? { active: false, plan: null }
  })

  ipcMain.handle('paywall:get-ledger', async () => {
    const token = currentSession.accessToken
    if (!token) return []
    const { fetchLedger } = await import('./payments-client')
    return fetchLedger(token)
  })

  ipcMain.handle('paywall:get-payment-status', async (_e, paymentId: string) => {
    const token = currentSession.accessToken
    if (!token || !paymentId) return null
    const { fetchPaymentStatus } = await import('./payments-client')
    return fetchPaymentStatus(paymentId, token)
  })

  // ─── Output mode: paste-at-cursor vs clipboard-only ──────────
  // Wires the persisted setting into clipboard.ts's outputMode flag.
  ipcMain.handle('paywall:get-output-mode', () => {
    return settings.get('outputMode', 'paste')
  })
  ipcMain.handle('paywall:set-output-mode', async (_e, mode: 'paste' | 'clipboard') => {
    const next = mode === 'clipboard' ? 'clipboard' : 'paste'
    settings.set('outputMode', next)
    try {
      const { setOutputMode } = await import('../clipboard')
      setOutputMode(next)
    } catch (e) {
      console.warn(
        '[paywall-glue] could not push outputMode to clipboard:',
        e instanceof Error ? e.message : e,
      )
    }
    return true
  })

  // ─── Launch at login (macOS) ─────────────────────────────────
  // Backed by Electron's app.setLoginItemSettings(). macOS persists this
  // in launchd; we don't need our own electron-store entry.
  ipcMain.handle('paywall:get-launch-at-login', () => {
    try {
      return app.getLoginItemSettings().openAtLogin
    } catch {
      return false
    }
  })
  ipcMain.handle('paywall:set-launch-at-login', (_e, enabled: boolean) => {
    try {
      app.setLoginItemSettings({ openAtLogin: !!enabled })
      return true
    } catch (e) {
      console.warn(
        '[paywall-glue] setLoginItemSettings failed:',
        e instanceof Error ? e.message : e,
      )
      return false
    }
  })
}

export function initPaywallGlue(): void {
  registerAuthIPC()
  registerSessionBridge()

  // Push the persisted instruction-enabled setting to the keyListener so
  // Caps Lock events get filtered from the very first press. Without this
  // a user who disabled AI format in a previous session would still trigger
  // instructions until they touch the setting again this session.
  void (async () => {
    try {
      const { setInstructionEnabled } = await import('../keyListener')
      setInstructionEnabled(settings.get('instructionEnabled', true))
    } catch (e) {
      console.warn(
        '[paywall-glue] could not init instructionEnabled:',
        e instanceof Error ? e.message : e,
      )
    }
  })()

  // Unmute Remote trigger: start from the cached entitlement so a Pro user's
  // Remote key isn't dead for the first seconds after launch, then confirm it
  // against the server as soon as a token exists. The user's own on/off is
  // NOT restored — a fresh app session always starts at the default (on for
  // Pro), which is the whole point of it being session-scoped.
  setRemoteTriggerEntitled(settings.get('remoteTriggerEntitled', false) === true)
  void refreshRemoteTriggerEntitlement()

  // Same pattern for outputMode — paste vs clipboard-only.
  void (async () => {
    try {
      const { setOutputMode } = await import('../clipboard')
      const persisted = settings.get('outputMode', 'paste')
      setOutputMode(persisted === 'clipboard' ? 'clipboard' : 'paste')
    } catch (e) {
      console.warn(
        '[paywall-glue] could not init outputMode:',
        e instanceof Error ? e.message : e,
      )
    }
  })()

  // Deep link for OAuth callbacks
  if (process.platform === 'darwin') {
    app.on('open-url', (event, url) => {
      event.preventDefault()
      if (url.startsWith('unmute://')) setPendingDeepLink(url)
    })
    // In dev mode (`npx electron dist/electron/main.js`), the binary is a bare
    // Electron with no Info.plist URL scheme. We must pass the full launch
    // command so LaunchServices can route unmute:// back to OUR app, not a
    // splash screen.
    if (process.defaultApp && process.argv.length >= 2) {
      app.setAsDefaultProtocolClient('unmute', process.execPath, [
        path.resolve(process.argv[1]),
      ])
    } else if (!app.isDefaultProtocolClient('unmute')) {
      app.setAsDefaultProtocolClient('unmute')
    }
  }

  // Renderer-callable IPC: paste a raw sign-in URL when the protocol handler
  // is wedged in macOS LaunchServices. Lets the user complete OAuth by
  // copy-pasting the redirect URL from their email/browser.
  ipcMain.handle('paywall:paste-auth-url', (_e, url: string) => {
    if (url.startsWith('unmute://') || url.includes('access_token=') || url.includes('#')) {
      setPendingDeepLink(url)
      return true
    }
    return false
  })

  // ─── Streaming upload IPC (managed mode — per-chunk streaming) ─
  ipcMain.on('paywall:stream-open', async (_e, opts: { flowType: string; chunkIndex?: number; estimatedDurationSeconds?: number }) => {
    const { openStream } = await import('./paywall-stream')
    openStream(opts)
  })
  ipcMain.on('paywall:stream-chunk', async (_e, bytes: Uint8Array) => {
    const { writeChunk } = await import('./paywall-stream')
    writeChunk(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes as ArrayBuffer))
  })
  ipcMain.on('paywall:stream-close', async () => {
    const { closeActiveStream } = await import('./paywall-stream')
    closeActiveStream()
  })
  ipcMain.on('paywall:stream-abort', async () => {
    const { closeImmediate } = await import('./paywall-stream')
    closeImmediate('renderer-abort')
  })

  ipcMain.on('paywall:capture-quality', (_e, sessionId: string | undefined, q: Record<string, unknown>) => {
    deliverCaptureQuality(sessionId, q)
    try {
      // Same fact, durable: the physical capture quality of this dictation.
      // Glue is copied into engine/electron/paywall/ at build time, while
      // dictationTelemetry lands at engine/electron/ — hence the relative
      // path below. Lazy require (not a static import) because that path
      // doesn't exist in this standalone repo's typecheck.
      logTelemetry('capture-quality', { sessionId: sessionId ?? null, ...q })
    } catch { /* telemetry is best-effort */ }
  })

  ipcMain.on('paywall:accept-draft', () => {
    invokeDraftAccept()
  })

  // Balance polling — token comes from the renderer-pushed session
  startBalancePolling(async () => currentSession.accessToken)

  // Pre-warm HTTPS to the pipeline worker so the first real call doesn't
  // pay the TLS handshake cost (~30-50ms saved on cold start).
  prewarmPipeline()

  console.log('[paywall-glue] initialized')
}

declare const __PIPELINE_URL__: string

async function prewarmPipeline(): Promise<void> {
  const t0 = Date.now()
  try {
    await paywallFetch('/v1/me', { method: 'OPTIONS' })
    console.log(`[paywall-glue] HTTPS pre-warm complete in ${Date.now() - t0}ms`)
  } catch (e) {
    console.log('[paywall-glue] HTTPS pre-warm failed (ok, will warm on first call):', (e as Error).message)
  }
  // Self-test: send 5 back-to-back pings and report whether connections
  // are actually being reused. This is the ground-truth for keep-alive.
  await verifyKeepAlive()
  startKeepAlive()
  startPoolStatsSampling()
}

// ─── Keep-alive ping ─────────────────────────────────────────────
// Cloudflare and most CDNs close idle TCP connections after ~60s. A small
// periodic ping keeps the TCP + TLS connection (and Node's undici pool slot)
// warm, so the first dictation after idle isn't paying the handshake cost
// (which is 100-300ms in our setup). Ping cost is essentially zero: a
// 204 OPTIONS response, no auth, no body.
const KEEPALIVE_INTERVAL_MS = 25_000
let keepAliveTimer: NodeJS.Timeout | null = null

function startKeepAlive(): void {
  if (keepAliveTimer) return
  let consecutiveFailures = 0
  keepAliveTimer = setInterval(async () => {
    const t0 = Date.now()
    try {
      const res = await paywallFetch('/v1/me', { method: 'OPTIONS' })
      const dt = Date.now() - t0
      consecutiveFailures = 0
      // Only log slow pings — a healthy keep-alive ping should be <100ms.
      if (dt > 200) {
        console.log(`[paywall-glue] keep-alive ping: ${dt}ms (status ${res.status}) — slower than expected`)
      } else {
        // Periodically log a "healthy" ping so we know the loop is running
        // (about every 5 pings = once every ~2 minutes)
        if (Math.random() < 0.2) {
          console.log(`[paywall-glue] keep-alive ping: ${dt}ms (healthy)`)
        }
      }
    } catch (e) {
      consecutiveFailures++
      console.warn(`[paywall-glue] keep-alive ping failed (#${consecutiveFailures}): ${(e as Error).message}`)
      // If we've failed 5 times in a row, log loudly — something's wrong
      if (consecutiveFailures >= 5) {
        console.error('[paywall-glue] keep-alive failing repeatedly — network or worker outage')
      }
    }
  }, KEEPALIVE_INTERVAL_MS)
  console.log(`[paywall-glue] keep-alive started (every ${KEEPALIVE_INTERVAL_MS / 1000}s)`)
}
