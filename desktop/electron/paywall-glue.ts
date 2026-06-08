// Minimal glue between OSS engine main.ts and the paywall layer in
// electron/paywall/. For this dev build we only wire the UI surface
// (auth, balance display, engine selector). Provider routing through
// our managed pipeline lands in a follow-up.

import { app, ipcMain, BrowserWindow } from 'electron'
import path from 'path'
import { registerAuthIPC, setPendingDeepLink } from './auth-ipc'
import { registerBalanceIPC, startBalancePolling } from './balance-ipc'
import Store from 'electron-store'
import { paywallFetch, verifyKeepAlive, startPoolStatsSampling } from './paywall-net'

type EngineMode = 'auto' | 'managed' | 'byok' | 'local'
const settings = new Store<{ engineMode: EngineMode }>({ name: 'unmute-paywall-settings' })

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
 * Schedule a proactive refresh 5 minutes before the access token expires.
 * Called whenever we receive a fresh session (sign-in, refresh, app start).
 */
function scheduleAutoRefresh(): void {
  if (refreshTimer) {
    clearTimeout(refreshTimer)
    refreshTimer = null
  }
  if (!currentSession.expiresAt || !currentSession.refreshToken) return
  const now = Math.floor(Date.now() / 1000)
  const secondsUntilExpiry = currentSession.expiresAt - now
  // Refresh 5 minutes before expiry; if already past that point, refresh now
  const refreshIn = Math.max(0, (secondsUntilExpiry - 300) * 1000)
  console.log(`[paywall-glue] proactive refresh scheduled in ${Math.round(refreshIn / 1000)}s`)
  refreshTimer = setTimeout(() => { void refreshAccessToken() }, refreshIn)
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
      const { setInstructionEnabled } = await import('./keyListener')
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

  ipcMain.handle('paywall:create-checkout', async (_e, amountCents: number) => {
    const token = currentSession.accessToken
    if (!token) return { ok: false, code: 'UNAUTHORIZED', message: 'sign in first' }
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      return { ok: false, code: 'BAD_REQUEST', message: 'invalid amount' }
    }
    const { createCheckout } = await import('./payments-client')
    return createCheckout(amountCents, token)
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
}

export function initPaywallGlue(): void {
  registerAuthIPC()
  registerBalanceIPC()
  registerSessionBridge()

  // Push the persisted instruction-enabled setting to the keyListener so
  // Caps Lock events get filtered from the very first press. Without this
  // a user who disabled AI format in a previous session would still trigger
  // instructions until they touch the setting again this session.
  void (async () => {
    try {
      const { setInstructionEnabled } = await import('./keyListener')
      setInstructionEnabled(settings.get('instructionEnabled', true))
    } catch (e) {
      console.warn(
        '[paywall-glue] could not init instructionEnabled:',
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
