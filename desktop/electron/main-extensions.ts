// Glue that the OSS engine's main.ts imports + calls during app initialization.
// One function, idempotent. The build script adds a single line to OSS main.ts:
//
//     import { initPaywall } from './paywall/main-extensions'
//     initPaywall(app, sessionManager)

import { ipcMain, app, type App } from 'electron'
import Store from 'electron-store'
import { registerAuthIPC, setPendingDeepLink } from './auth-ipc'
import { registerBalanceIPC, startBalancePolling, stopBalancePolling } from './balance-ipc'
import { ProviderRouter, type EngineMode } from './provider-router'
import { managedSTT, managedLLM } from './managed-client'

const settings = new Store<{ engineMode: EngineMode }>({ name: 'unmute-paywall-settings' })

// The OSS engine provides these via its sessionManager. We accept them
// as opaque interfaces so we don't entangle with the engine internals.
interface OSSAdapter {
  // Existing BYOK + Local providers from the OSS engine
  byokSTT: { transcribe: (opts: { audio: Buffer; durationSeconds: number; language?: string; flowType?: string }, apiKey: string) => Promise<{ text: string; durationSeconds: number; engine: 'byok'; costCents: number }> }
  byokLLM: { complete: (opts: { messages: Array<{ role: string; content: string }>; temperature?: number; maxTokens?: number }, apiKey: string) => Promise<{ text: string; engine: 'byok'; costCents: number }> }
  localSTT: { transcribe: (opts: { audio: Buffer; durationSeconds: number; language?: string; flowType?: string }) => Promise<{ text: string; durationSeconds: number; engine: 'local'; costCents: number }> }
  getByokKey: () => Promise<string | null>
  // For balance polling
  getAccessToken: () => Promise<string | null>
  getCurrentUser: () => Promise<{ id: string; email: string | null } | null>
  signOut: () => Promise<void>
  // Notify the renderer that we just fell back from managed → local
  notifyFellBackToLocal: (topUpUrl: string) => void
}

let router: ProviderRouter | null = null

export function initPaywall(_appHandle: App, oss: OSSAdapter): ProviderRouter {
  registerAuthIPC()
  registerBalanceIPC()

  // Deep-link handler for OAuth callback (unmute://auth/callback)
  if (process.platform === 'darwin') {
    _appHandle.on('open-url', (event, url) => {
      event.preventDefault()
      if (url.startsWith('unmute://auth/callback')) setPendingDeepLink(url)
    })
    // Register protocol if not already
    if (!_appHandle.isDefaultProtocolClient('unmute')) {
      _appHandle.setAsDefaultProtocolClient('unmute')
    }
  }

  // Engine-mode IPC
  ipcMain.handle('paywall:get-engine-mode', () => settings.get('engineMode', 'auto'))
  ipcMain.handle('paywall:set-engine-mode', (_e, mode: EngineMode) => {
    settings.set('engineMode', mode)
    return true
  })

  // User-state IPC
  ipcMain.handle('paywall:get-user', () => oss.getCurrentUser())
  ipcMain.handle('paywall:sign-out', async () => {
    await oss.signOut()
    stopBalancePolling()
    return true
  })
  ipcMain.handle('paywall:request-sign-in', () => {
    // The main window's renderer will pick this up via an IPC event and
    // present the sign-in screen.
    return true
  })

  // Provider router wiring
  router = new ProviderRouter({
    managedSTT,
    managedLLM,
    byokSTT: oss.byokSTT,
    byokLLM: oss.byokLLM,
    localSTT: oss.localSTT,
    getByokKey: oss.getByokKey,
    getAccessToken: oss.getAccessToken,
    getEngineMode: async () => settings.get('engineMode', 'auto') as EngineMode,
    getState: async () => {
      const user = await oss.getCurrentUser()
      const byokKey = await oss.getByokKey()
      const token = await oss.getAccessToken()
      // Balance check uses the cached pill state — already polled by balance-ipc
      // For the router's pre-check we read the live cache via the IPC channel.
      const balance = await (async () => {
        try {
          // Lazy import to avoid a circular load
          const { fetchMe } = await import('./managed-client')
          if (!token) return 0
          const me = await fetchMe(token)
          return me?.balanceCents ?? 0
        } catch {
          return 0
        }
      })()
      return {
        signedIn: !!user,
        balanceCents: balance,
        byokKeySet: !!byokKey,
        localReady: true, // OSS engine surfaces this — wire after submodule integration
      }
    },
    onProviderUsed: (provider, cost) => {
      // If a managed call succeeded, we already got balance back in the
      // response. The fallback case (managed → local) is signaled here.
      if (provider === 'local') {
        // Indicates fallback happened (auto mode); surface the banner.
        oss.notifyFellBackToLocal('https://unmute.app/topup')
      }
      void cost
    },
  })

  // Start polling once a session is available
  startBalancePolling(oss.getAccessToken)

  return router
}

export function getRouter(): ProviderRouter {
  if (!router) throw new Error('Paywall not initialized — call initPaywall() first')
  return router
}
