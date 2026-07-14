// Minimal glue between OSS engine main.ts and the paywall layer in
// electron/paywall/. For this dev build we only wire the UI surface
// (auth, balance display, engine selector). Provider routing through
// our managed pipeline lands in a follow-up.

import { app, ipcMain, BrowserWindow } from 'electron'
import path from 'path'
import { registerAuthIPC, setPendingDeepLink } from './auth-ipc'
import { startBalancePolling } from './balance-ipc'
import Store from 'electron-store'
import { paywallFetch, verifyKeepAlive, startPoolStatsSampling } from './paywall-net'
import { deliverCaptureQuality, invokeDraftAccept } from './main-extensions'

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

// ─── Public getters for sessionManager to consult before routing ───
export function getPaywallAccessToken(): string | null {
  return currentSession.accessToken
}
export function getPaywallEngineMode(): EngineMode {
  return settings.get('engineMode', 'auto')
}
export function getPaywallUser(): { id: string; email: string | null } | null {
  return currentSession.user
}


// Substituted by build script
declare const __SUPABASE_URL__: string
declare const __SUPABASE_ANON_KEY__: string

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
    try {
      const res = await fetch(`${__SUPABASE_URL__}/auth/v1/token?grant_type=refresh_token`, {
        method: 'POST',
        headers: {
          apikey: __SUPABASE_ANON_KEY__,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ refresh_token: currentSession.refreshToken }),
      })
      if (!res.ok) {
        console.warn(`[paywall-glue] token refresh failed: ${res.status}`)
        return false
      }
      const body = await res.json() as {
        access_token?: string
        refresh_token?: string
        expires_at?: number
        expires_in?: number
      }
      if (!body.access_token) return false
      currentSession.accessToken = body.access_token
      currentSession.refreshToken = body.refresh_token ?? currentSession.refreshToken
      currentSession.expiresAt = body.expires_at ??
        (body.expires_in ? Math.floor(Date.now() / 1000) + body.expires_in : null)
      console.log(`[paywall-glue] token refreshed in ${Date.now() - t0}ms (next exp in ${
        currentSession.expiresAt ? currentSession.expiresAt - Math.floor(Date.now() / 1000) : '?'
      }s)`)
      scheduleAutoRefresh()
      // Push the new token back to the renderer so its supabase-js client stays in sync
      for (const w of BrowserWindow.getAllWindows()) {
        w.webContents.send('paywall:token-refreshed', { accessToken: body.access_token, refreshToken: body.refresh_token })
      }
      return true
    } catch (e) {
      console.warn('[paywall-glue] token refresh threw:', (e as Error).message)
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
 * Proactive auto-refresh is intentionally a no-op.
 *
 * Historically main+renderer both ran timers that fired ~5min before
 * access-token expiry. Both would call /auth/v1/token?grant_type=refresh_token
 * with the same refresh token. With Supabase's refresh-token rotation,
 * whichever request arrived second saw its refresh token already-rotated
 * and was rejected — which supabase-js interprets as "session compromised"
 * and fires SIGNED_OUT, kicking the user out of the app.
 *
 * Fix: supabase-js (renderer) is the sole proactive refresher. It already
 * fires onAuthStateChange with the new tokens, which AuthContext pushes
 * into main via paywallSetSession. Main stays in sync without competing.
 *
 * The reactive refreshAccessToken() below still exists for the rare case
 * where main hits a 401 on a managed STT call (paywall-route). It broadcasts
 * paywall:token-refreshed so the renderer's supabase-js can adopt the new
 * tokens via setSession, keeping both sides aligned.
 */
function scheduleAutoRefresh(): void {
  // intentionally no-op — see comment above
  if (refreshTimer) {
    clearTimeout(refreshTimer)
    refreshTimer = null
  }
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
    }
    return true
  })
  ipcMain.handle('paywall:get-user', () => currentSession.user)
  ipcMain.handle('paywall:sign-out', () => {
    currentSession = { accessToken: null, refreshToken: null, expiresAt: null, user: null }
    if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null }
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
    return (await fetchSubscription(token)) ?? { active: false, plan: null }
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
      const { logTelemetry } = require('../dictationTelemetry') as { logTelemetry: (event: string, data: Record<string, unknown>) => void } // eslint-disable-line @typescript-eslint/no-var-requires
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
