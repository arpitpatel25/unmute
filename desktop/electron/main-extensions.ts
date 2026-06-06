// Glue that the OSS engine's main.ts imports + calls during app initialization.
// One function, idempotent. The build script adds a single line to OSS main.ts:
//
//     import { initPaywall } from './paywall/main-extensions'
//     initPaywall(app, sessionManager)

import { ipcMain, BrowserWindow, type App } from 'electron'
import Store from 'electron-store'
import { ProviderRouter, type EngineMode } from './provider-router'
import { managedSTT, managedLLM } from './managed-client'
import { initPaywallGlue } from './paywall-glue'

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
  // initPaywallGlue does most of the wiring: registerAuthIPC,
  // registerBalanceIPC, registerSessionBridge (paywall:set-session — the
  // missing wire that left tryManagedSTT silently falling back to local),
  // the streaming POST IPC handlers (paywall:stream-open/chunk/close),
  // token refresh scheduler, HTTPS pre-warm, the keep-alive ping, balance
  // polling, the OAuth deep-link handler, and paywall:paste-auth-url. It
  // also owns paywall:get-engine-mode, paywall:set-engine-mode,
  // paywall:get-user, paywall:sign-out. Don't duplicate them here —
  // ipcMain.handle throws on second registration.
  //
  initPaywallGlue()

  // paywall:request-sign-in lives here (not in glue) so it can emit
  // paywall:show-sign-in to the focused window; the renderer's AuthContext
  // subscribes via paywallOnShowSignIn (preload) and mounts the modal.
  ipcMain.handle('paywall:request-sign-in', () => {
    const focused = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    focused?.webContents.send('paywall:show-sign-in')
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

  // Balance polling is started inside initPaywallGlue() against
  // paywall-glue's currentSession.accessToken — don't double-start here.

  return router
}

export function getRouter(): ProviderRouter {
  if (!router) throw new Error('Paywall not initialized — call initPaywall() first')
  return router
}
