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
// (managed is active, or no provider is available at all).
export type OnDeviceReason =
  | 'not_signed_in'      // anonymous → local is the only option
  | 'no_subscription'    // signed in, never subscribed → managed unavailable
  | 'payment_failed'     // subscriber whose renewal failed AND whose paid period has lapsed
  | 'cloud_unreachable'  // managed was first choice, fell back due to error
  | 'chose_on_device'    // user set Engine = Local explicitly

export interface EnginePeekStatus {
  provider: Provider | null
  reason: OnDeviceReason | null
}

const settings = new Store<{ engineMode: EngineMode; iphoneMicEnabled?: boolean }>({ name: 'unmute-paywall-settings' })

// The OSS engine provides these via its sessionManager. We accept them
// as opaque interfaces so we don't entangle with the engine internals.
interface OSSAdapter {
  // Local provider from the OSS engine
  localSTT: { transcribe: (opts: { audio: Buffer; durationSeconds: number; language?: string; flowType?: string }) => Promise<{ text: string; durationSeconds: number; engine: 'local'; costCents: number }> }
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
export type EngineTag = 'cloud' | 'local'
let lastEngine: EngineTag | null = null
export function setLastEngine(tag: EngineTag): void { lastEngine = tag }
export function popLastEngine(): EngineTag | null {
  const v = lastEngine
  lastEngine = null
  return v
}

// ── Capture-quality handoff (renderer → glue → sessionManager) ──────────
// paywall-glue owns the ipcMain.on; sessionManager registers a sink here to
// avoid a glue→sessionManager import cycle.
let captureQualitySink: ((sessionId: string | undefined, q: Record<string, unknown>) => void) | null = null
export function registerCaptureQualitySink(fn: (sessionId: string | undefined, q: Record<string, unknown>) => void): void {
  captureQualitySink = fn
}
export function deliverCaptureQuality(sessionId: string | undefined, q: Record<string, unknown>): void {
  try { captureQualitySink?.(sessionId, q) } catch { /* never break IPC */ }
}

// ── Draft-accept handoff (widget tap → glue → sessionManager) ──────────
let draftAcceptHandler: (() => void) | null = null
export function registerDraftAcceptHandler(fn: () => void): void {
  draftAcceptHandler = fn
}
export function invokeDraftAccept(): void {
  try { draftAcceptHandler?.() } catch { /* never break IPC */ }
}

/** Why is the user on the on-device model right now? */
function localReason(state: ProviderState, mode: EngineMode): OnDeviceReason {
  if (mode === 'local') return 'chose_on_device'
  // In auto mode the priority chain is managed → local.
  // Local is picked only when nothing higher qualifies.
  if (!state.signedIn) return 'not_signed_in'
  if (state.signedIn && !state.subActive) {
    // A paying customer whose card was declined is not a stranger. The backend
    // keeps them entitled for the whole period they paid for, so reaching here
    // with on_hold means that period has also lapsed — they need to fix their
    // card, not be sold the product they already bought.
    return state.subStatus === 'on_hold' ? 'payment_failed' : 'no_subscription'
  }
  return 'chose_on_device' // catch-all for unusual configs
}

export function initPaywall(appHandle: App, oss: OSSAdapter): ProviderRouter {
  // initPaywallGlue does most of the wiring: registerAuthIPC,
  // registerSessionBridge (paywall:set-session — the
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

  // App version for the Settings footer — so users can see which build they're
  // on and we can tell them when to update. Sourced from app.getVersion(), which
  // returns the version electron-builder baked into the package (the real build
  // number), so it can never drift from what's installed.
  ipcMain.handle('paywall:app-version', () => appHandle.getVersion())

  // Shared state-builder — used by the router AND the awareness widget's
  // peek IPC so they can never disagree on what we'd route to.
  routerState = async (): Promise<ProviderState> => {
    const user = await oss.getCurrentUser()
    const token = await oss.getAccessToken()
    const sub = await (async () => {
      try {
        if (!token) return null
        const { fetchSubscription } = await import('./managed-client')
        return await fetchSubscription(token)
      } catch {
        return null
      }
    })()
    return {
      signedIn: !!user,
      subActive: !!sub?.active,
      subStatus: sub?.status ?? null,
      localReady: true, // OSS engine surfaces this — wire after submodule integration
    }
  }

  // Provider router wiring
  router = new ProviderRouter({
    managedSTT,
    managedLLM,
    localSTT: oss.localSTT,
    getAccessToken: oss.getAccessToken,
    getEngineMode: async () => settings.get('engineMode', 'auto') as EngineMode,
    getState: routerState,
    onProviderUsed: (provider, cost) => {
      // If a managed call succeeded, we already got balance back in the
      // response. The fallback case (managed → local) is signaled here.
      if (provider === 'local') {
        // Indicates fallback happened (auto mode); surface the banner.
        oss.notifyFellBackToLocal('https://unmute.app/subscribe')
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
  // HUD click-through toggle: the window is click-through by default (so the
  // empty area around the pill doesn't block the apps behind it); the renderer
  // flips it interactive while the cursor is over the pill/badge/card.
  ipcMain.on('hud:set-interactive', (_e, on: boolean) => {
    const w = getWidgetWindow()
    if (!w || w.isDestroyed()) return
    ;(w as unknown as { setIgnoreMouseEvents: (ignore: boolean, options?: { forward?: boolean }) => void })
      .setIgnoreMouseEvents(!on, { forward: true })
  })
  // iPhone-microphone feature gate: OFF by default — the mic-source chip and
  // the whole Continuity path stay invisible until the user enables it in
  // Settings. Broadcast on change so the widget applies it live.
  ipcMain.handle('settings:get-iphone-mic', () => settings.get('iphoneMicEnabled', false))
  ipcMain.handle('settings:set-iphone-mic', (_e, on: boolean) => {
    settings.set('iphoneMicEnabled', !!on)
    const { BrowserWindow } = require('electron') as typeof import('electron')
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('settings:iphone-mic-changed', !!on)
    }
    return true
  })

  ipcMain.handle('hud:set-height', (_e, height: number, opts?: { upward?: boolean }) => {
    const w = getWidgetWindow()
    if (!w) return false
    const bounds = w.getBounds()
    // 220 was enough for one flat list of models. Codex has three axes with
    // headings, and the cap silently truncated it — the list simply ended.
    const clamped = Math.max(72, Math.min(460, Math.round(height)))
    // GROW UPWARD when asked. The comment here used to say the HUD is anchored
    // to the TOP of the screen; the pill now sits near the BOTTOM, so keeping
    // the top-left corner fixed grew the panel off the bottom edge and the
    // dropdown opened downward into nothing. Holding the BOTTOM edge instead
    // makes it open up over the screen, which is the only direction with room.
    const bottom = bounds.y + bounds.height
    const y = opts?.upward ? bottom - clamped : bounds.y
    w.setBounds({ x: bounds.x, y, width: bounds.width, height: clamped })
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
