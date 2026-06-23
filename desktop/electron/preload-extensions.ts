// Additional methods to merge into the OSS engine's electronAPI surface
// during the build step. Each maps to an IPC handler in the main process.
//
// The build script appends these to the existing preload.ts via a marker
// comment (see PATCHES.md → "preload.ts injection").

import { ipcRenderer } from 'electron'

export const paywallPreloadExtensions = {
  // Keychain bridge (used by supabase-js storage adapter)
  paywallKeychainGet: (key: string): Promise<string | null> =>
    ipcRenderer.invoke('paywall:keychain-get', key),
  paywallKeychainSet: (key: string, value: string): Promise<boolean> =>
    ipcRenderer.invoke('paywall:keychain-set', key, value),
  paywallKeychainDelete: (key: string): Promise<boolean> =>
    ipcRenderer.invoke('paywall:keychain-delete', key),

  // External URL (Apple OAuth, magic link, checkout/portal)
  paywallOpenExternal: (url: string): Promise<boolean> =>
    ipcRenderer.invoke('paywall:open-external', url),

  // Deep-link callback (OAuth return)
  paywallOnAuthCallback: (cb: (url: string) => void) => {
    ipcRenderer.on('paywall:auth-callback', (_e, url) => cb(url))
  },
  paywallPopPendingAuthCallback: (): Promise<string | null> =>
    ipcRenderer.invoke('paywall:pop-pending-auth-callback'),

  // Deep-link callback (Dodo checkout completion). Renderer's Billing pane
  // listens to start polling /v1/me + /v1/payment/:id immediately.
  paywallOnPaymentCallback: (cb: (url: string) => void) => {
    ipcRenderer.on('paywall:payment-callback', (_e, url) => cb(url))
  },
  paywallPopPendingPaymentCallback: (): Promise<string | null> =>
    ipcRenderer.invoke('paywall:pop-pending-payment-callback'),

  // Dodo subscription checkout — main proxies to the payments worker.
  paywallCreateSubscription: (
    plan: 'dictation' | 'unmute',
    interval: 'month' | 'year',
  ): Promise<{
    ok: boolean
    checkoutUrl?: string
    code?: string
    message?: string
  }> => ipcRenderer.invoke('paywall:create-subscription', plan, interval),

  // Dodo customer portal — manage/cancel an existing subscription. Returns
  // { noSubscription: true } when the user has no Dodo customer record (409).
  paywallOpenPortal: (): Promise<{
    ok: boolean
    portalUrl?: string
    noSubscription?: boolean
    code?: string
    message?: string
  }> => ipcRenderer.invoke('paywall:open-portal'),

  // Subscription/entitlement status — drives the subscription-status pill and
  // Billing's post-checkout "is it active yet?" poll.
  paywallGetSubscription: (): Promise<{
    active: boolean
    plan: 'dictation' | 'unmute' | null
  }> => ipcRenderer.invoke('paywall:get-subscription'),

  // Recent wallet ledger rows for the in-app history pane.
  paywallGetLedger: (): Promise<Array<{
    id: string
    created_at: string
    delta_cents: number
    source: string
    metadata: Record<string, unknown>
  }>> => ipcRenderer.invoke('paywall:get-ledger'),

  // Reconciliation: poll payment status when the browser redirect doesn't
  // fire (closed tab, popup blocker).
  paywallGetPaymentStatus: (paymentId: string): Promise<{
    id: string
    status: string
    amount?: number
    currency?: string
  } | null> => ipcRenderer.invoke('paywall:get-payment-status', paymentId),

  // Output mode — paste-at-cursor vs clipboard-only.
  paywallGetOutputMode: (): Promise<'paste' | 'clipboard'> =>
    ipcRenderer.invoke('paywall:get-output-mode'),
  paywallSetOutputMode: (mode: 'paste' | 'clipboard'): Promise<boolean> =>
    ipcRenderer.invoke('paywall:set-output-mode', mode),

  // Launch at login — backed by Electron's setLoginItemSettings.
  paywallGetLaunchAtLogin: (): Promise<boolean> =>
    ipcRenderer.invoke('paywall:get-launch-at-login'),
  paywallSetLaunchAtLogin: (enabled: boolean): Promise<boolean> =>
    ipcRenderer.invoke('paywall:set-launch-at-login', enabled),

  // Balance state
  paywallGetBalance: (): Promise<{ balanceCents: number; topUpUrl: string }> =>
    ipcRenderer.invoke('paywall:get-balance'),
  paywallRefreshBalance: (): Promise<{ balanceCents: number; topUpUrl: string }> =>
    ipcRenderer.invoke('paywall:refresh-balance'),
  paywallOnBalanceUpdated: (cb: (state: { balanceCents: number; topUpUrl: string }) => void) => {
    ipcRenderer.on('paywall:balance-updated', (_e, state) => cb(state))
  },

  // Engine mode + sign-in
  paywallGetEngineMode: (): Promise<'auto' | 'managed' | 'local'> =>
    ipcRenderer.invoke('paywall:get-engine-mode'),
  paywallSetEngineMode: (mode: 'auto' | 'managed' | 'local'): Promise<boolean> =>
    ipcRenderer.invoke('paywall:set-engine-mode', mode),

  // AI format on/off — gates Caps Lock detection in the keyListener.
  paywallGetInstructionEnabled: (): Promise<boolean> =>
    ipcRenderer.invoke('paywall:get-instruction-enabled'),
  paywallSetInstructionEnabled: (enabled: boolean): Promise<boolean> =>
    ipcRenderer.invoke('paywall:set-instruction-enabled', enabled),
  paywallGetUser: (): Promise<{ id: string; email: string | null } | null> =>
    ipcRenderer.invoke('paywall:get-user'),
  paywallRequestSignIn: (): Promise<boolean> =>
    ipcRenderer.invoke('paywall:request-sign-in'),
  paywallSignOut: (): Promise<boolean> =>
    ipcRenderer.invoke('paywall:sign-out'),

  // Renderer-→-main session push. AuthContext calls this whenever supabase-js
  // fires onAuthStateChange so the main process has the live access token
  // available for tryManagedSTT / tryManagedLLM.
  paywallSetSession: (session: {
    accessToken: string | null
    refreshToken?: string | null
    expiresAt?: number | null
    user: { id: string; email: string | null } | null
  }): Promise<boolean> => ipcRenderer.invoke('paywall:set-session', session),

  // Per-chunk streaming bridge. useAudioRecorder calls these to push audio
  // into a streaming POST against the managed pipeline /v1/stt-stream
  // endpoint while the user is still talking, so the upload finishes by the
  // time recording stops. Without these the renderer's calls go to
  // `undefined` and the streaming path silently dies — every dictation
  // falls back to the upload path (POST whole audio when recording ends).
  paywallStreamOpen: (opts: {
    flowType: string
    chunkIndex?: number
    estimatedDurationSeconds?: number
  }) => ipcRenderer.send('paywall:stream-open', opts),
  paywallStreamChunk: (bytes: ArrayBuffer | Uint8Array) =>
    ipcRenderer.send('paywall:stream-chunk', bytes),
  paywallStreamClose: () => ipcRenderer.send('paywall:stream-close'),
  paywallStreamAbort: () => ipcRenderer.send('paywall:stream-abort'),

  // Surfacing the SignInScreen (sent from main when something — e.g. a future
  // menu item, or a 401 → sign-in flow — wants to prompt the user).
  paywallOnShowSignIn: (cb: () => void) => {
    ipcRenderer.on('paywall:show-sign-in', () => cb())
  },

  // Manual OAuth callback URL paste (DNS-blocked-region fallback). Returns
  // true if the URL was a valid callback that main handed back to the
  // renderer through the regular auth-callback channel.
  paywallPasteAuthUrl: (url: string): Promise<boolean> =>
    ipcRenderer.invoke('paywall:paste-auth-url', url),

  // Fallback notification (managed → local because balance ran out)
  paywallOnFellBackToLocal: (cb: (topUpUrl: string) => void) => {
    ipcRenderer.on('paywall:fell-back-to-local', (_e, url) => cb(url))
  },

  // Awareness widget — pre-call peek tells us which provider would route
  // *right now* and, if it's local, why. Mirrors what ProviderRouter would
  // do without actually consuming an STT slot.
  paywallEnginePeekStatus: (): Promise<{
    provider: 'managed' | 'local' | null
    reason: 'not_signed_in' | 'no_subscription' | 'cloud_unreachable' | 'chose_on_device' | null
  }> => ipcRenderer.invoke('engine:peek-status'),

  // Runtime fallback signal — fires when a managed call fell through
  // to local during this dictation. Used to swap the awareness widget's
  // reason text to "cloud unreachable" mid-flight.
  paywallOnEngineFellBack: (
    cb: (info: { reason: 'cloud_unreachable' }) => void
  ) => {
    ipcRenderer.on('engine:fell-back', (_e, info) => cb(info))
  },

  // HUD window dynamic resize — grow when the awareness card mounts,
  // shrink back when it dismisses. Width and top-left position stay; only
  // height changes. Clamped in main to [72, 220].
  paywallSetHUDHeight: (height: number): Promise<boolean> =>
    ipcRenderer.invoke('hud:set-height', height),

  // Token refresh sync — main broadcasts new tokens when paywall-route
  // forces a refresh on 401. Renderer subscribes and pushes them into
  // supabase-js via setSession so the renderer doesn't later try the
  // (now-rotated) old refresh token and get signed out.
  paywallOnTokenRefreshed: (
    cb: (tokens: { accessToken: string; refreshToken: string }) => void
  ) => {
    ipcRenderer.on('paywall:token-refreshed', (_e, tokens) => cb(tokens))
  },

  // Language picker — auto-detect toggle + single language code.
  // Whisper's API is binary: send one ISO-639-1 code, or omit the field
  // entirely (auto-detect). It does not accept multiple codes or a
  // constrained-detect subset, so the picker is single-select.
  // When autoDetect=true, sttLanguage is stored but ignored at request
  // time. When false, sttLanguage is sent.
  paywallGetLanguageAutoDetect: (): Promise<boolean> =>
    ipcRenderer.invoke('paywall:get-language-auto-detect'),
  paywallSetLanguageAutoDetect: (enabled: boolean): Promise<boolean> =>
    ipcRenderer.invoke('paywall:set-language-auto-detect', enabled),
  paywallGetLanguage: (): Promise<string> =>
    ipcRenderer.invoke('paywall:get-language'),
  paywallSetLanguage: (code: string): Promise<boolean> =>
    ipcRenderer.invoke('paywall:set-language', code),

  // Output formatting — lowercase toggle. Single-microsecond cost at
  // delivery time; doesn't affect dictation latency in any measurable
  // way. Drives the "Format output as lowercase" switch in Settings.
  paywallGetLowercaseOutput: (): Promise<boolean> =>
    ipcRenderer.invoke('paywall:get-lowercase-output'),
  paywallSetLowercaseOutput: (enabled: boolean): Promise<boolean> =>
    ipcRenderer.invoke('paywall:set-lowercase-output', enabled),
}

export type PaywallAPI = typeof paywallPreloadExtensions
