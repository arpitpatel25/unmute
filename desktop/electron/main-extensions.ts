// Glue that the OSS engine's main.ts imports + calls during app initialization.
// One function, idempotent. The build script adds a single line to OSS main.ts:
//
//     import { initPaywall } from './paywall/main-extensions'
//     initPaywall(app, sessionManager)

import { ipcMain, BrowserWindow, powerMonitor, type App } from 'electron'
import Store from 'electron-store'
import { ProviderRouter, pickProvider, type EngineMode, type Provider, type ProviderState } from './provider-router'
import { managedSTT, managedLLM } from './managed-client'
import { initPaywallGlue, warmNow, ensureFreshToken } from './paywall-glue'
// getWidgetWindow lives one directory up after wire-into-engine.sh
// places main-extensions.ts at engine/electron/paywall/.
import { getWidgetWindow } from '../windowManager'

// Reason the user is on the on-device model right now. Drives the awareness
// widget below the dictation pill. null means "no awareness widget needed"
// (managed or BYOK are active, or no provider is available at all).
export type OnDeviceReason =
  | 'not_signed_in'      // anonymous + no BYOK key → local is the only option
  | 'no_balance'         // signed in but $0 → managed unavailable
  | 'cloud_unreachable'  // managed/byok was first choice, fell back due to error
  | 'chose_on_device'    // user set Engine = Local explicitly

export interface EnginePeekStatus {
  provider: Provider | null
  reason: OnDeviceReason | null
}

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
let routerState: (() => Promise<ProviderState>) | null = null

// ─── Session-engine handoff (last STT path used) ──────────────────────
// Dictation is single-flight (push-to-talk), so a module-level scalar
// safely conveys "which engine ran" from the routing code to the DB
// save site. setLastEngine is called by sessionManager/paywall-route at
// the decision points; popLastEngine is called by db.ts saveSession at
// session-end, which clears the value as a side effect so a no-engine
// session can't accidentally inherit the previous one's tag.
export type EngineTag = 'cloud' | 'byok' | 'local'
let lastEngine: EngineTag | null = null
export function setLastEngine(tag: EngineTag): void { lastEngine = tag }
export function popLastEngine(): EngineTag | null {
  const v = lastEngine
  lastEngine = null
  return v
}

/** Why is the user on the on-device model right now? */
function localReason(state: ProviderState, mode: EngineMode): OnDeviceReason {
  if (mode === 'local') return 'chose_on_device'
  // In auto mode the priority chain is managed → byok → local.
  // Local is picked only when nothing higher qualifies.
  if (!state.signedIn && !state.byokKeySet) return 'not_signed_in'
  if (state.signedIn && state.balanceCents === 0) return 'no_balance'
  return 'chose_on_device' // catch-all for unusual configs (e.g. signed-out + BYOK off)
}

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

  // On wake from sleep the socket is dead (slept past keep-alive) and the token
  // may be stale — re-warm + refresh proactively so the first post-wake dictation
  // isn't cold (it would lose the local-fallback race → silent offline). The 25s
  // keep-alive timer can't cover this: it's suspended during sleep / App Nap.
  powerMonitor.on('resume', () => { void warmNow(); void ensureFreshToken() })

  // paywall:request-sign-in lives here (not in glue) so it can emit
  // paywall:show-sign-in to the focused window; the renderer's AuthContext
  // subscribes via paywallOnShowSignIn (preload) and mounts the modal.
  ipcMain.handle('paywall:request-sign-in', () => {
    const focused = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    focused?.webContents.send('paywall:show-sign-in')
    return true
  })

  // Shared state-builder — used by the router AND the awareness widget's
  // peek IPC so they can never disagree on what we'd route to.
  routerState = async (): Promise<ProviderState> => {
    const user = await oss.getCurrentUser()
    const byokKey = await oss.getByokKey()
    const token = await oss.getAccessToken()
    const balance = await (async () => {
      try {
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
  }

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
    getState: routerState,
    onProviderUsed: (provider, cost) => {
      // If a managed call succeeded, we already got balance back in the
      // response. The fallback case (managed → local) is signaled here.
      if (provider === 'local') {
        // Indicates fallback happened (auto mode); surface the banner.
        oss.notifyFellBackToLocal('https://unmute.app/topup')
        // Tag this as a runtime fallback so the awareness widget can swap
        // its reason text to "cloud unreachable" instead of whatever the
        // pre-call peek inferred. Broadcast to all windows.
        for (const w of BrowserWindow.getAllWindows()) {
          w.webContents.send('engine:fell-back', { reason: 'cloud_unreachable' as OnDeviceReason })
        }
      }
      void cost
    },
  })

  // Pre-call peek used by the awareness widget. Computes the same provider
  // pickProvider() would pick *right now*, plus the reason if it's local.
  // Reasons are derived from the same state inputs the router itself reads,
  // so the widget can never disagree with what actually routes.
  ipcMain.handle('engine:peek-status', async (): Promise<EnginePeekStatus> => {
    if (!router || !routerState) return { provider: null, reason: null }
    const mode = settings.get('engineMode', 'auto') as EngineMode
    const state = await routerState()
    const provider = pickProvider(state, mode)
    if (provider !== 'local') return { provider, reason: null }
    return { provider: 'local', reason: localReason(state, mode) }
  })

  // Dynamic HUD height — the awareness widget needs ~70px of extra vertical
  // canvas to sit below the pill. We grow the window only when the card
  // mounts and shrink back on dismiss/hide so the empty area below the pill
  // doesn't reintroduce a click-blocking dead zone.
  ipcMain.handle('hud:set-height', (_e, height: number) => {
    const w = getWidgetWindow()
    if (!w) return false
    const bounds = w.getBounds()
    const clamped = Math.max(72, Math.min(220, Math.round(height)))
    // Re-anchor: keep top-left corner where it is — the HUD is anchored to
    // the top of the screen, not the center, so growth happens downward.
    w.setBounds({ x: bounds.x, y: bounds.y, width: bounds.width, height: clamped })
    return true
  })

  // Balance polling is started inside initPaywallGlue() against
  // paywall-glue's currentSession.accessToken — don't double-start here.

  return router
}

export function getRouter(): ProviderRouter {
  if (!router) throw new Error('Paywall not initialized — call initPaywall() first')
  return router
}
