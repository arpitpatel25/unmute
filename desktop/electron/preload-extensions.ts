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

  // External URL (Apple OAuth, magic link, top-up)
  paywallOpenExternal: (url: string): Promise<boolean> =>
    ipcRenderer.invoke('paywall:open-external', url),

  // Deep-link callback (OAuth return)
  paywallOnAuthCallback: (cb: (url: string) => void) => {
    ipcRenderer.on('paywall:auth-callback', (_e, url) => cb(url))
  },
  paywallPopPendingAuthCallback: (): Promise<string | null> =>
    ipcRenderer.invoke('paywall:pop-pending-auth-callback'),

  // Balance state
  paywallGetBalance: (): Promise<{ balanceCents: number; topUpUrl: string }> =>
    ipcRenderer.invoke('paywall:get-balance'),
  paywallRefreshBalance: (): Promise<{ balanceCents: number; topUpUrl: string }> =>
    ipcRenderer.invoke('paywall:refresh-balance'),
  paywallOnBalanceUpdated: (cb: (state: { balanceCents: number; topUpUrl: string }) => void) => {
    ipcRenderer.on('paywall:balance-updated', (_e, state) => cb(state))
  },

  // Engine mode + sign-in
  paywallGetEngineMode: (): Promise<'auto' | 'managed' | 'byok' | 'local'> =>
    ipcRenderer.invoke('paywall:get-engine-mode'),
  paywallSetEngineMode: (mode: 'auto' | 'managed' | 'byok' | 'local'): Promise<boolean> =>
    ipcRenderer.invoke('paywall:set-engine-mode', mode),
  paywallGetUser: (): Promise<{ id: string; email: string | null } | null> =>
    ipcRenderer.invoke('paywall:get-user'),
  paywallRequestSignIn: (): Promise<boolean> =>
    ipcRenderer.invoke('paywall:request-sign-in'),
  paywallSignOut: (): Promise<boolean> =>
    ipcRenderer.invoke('paywall:sign-out'),

  // Fallback notification (managed → local because balance ran out)
  paywallOnFellBackToLocal: (cb: (topUpUrl: string) => void) => {
    ipcRenderer.on('paywall:fell-back-to-local', (_e, url) => cb(url))
  },
}

export type PaywallAPI = typeof paywallPreloadExtensions
