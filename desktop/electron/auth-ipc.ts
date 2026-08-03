// Main-process auth handlers.
//
// Responsibilities:
//   * Keychain bridge for token storage (so tokens never live in localStorage)
//   * Open external sign-in URLs (Apple OAuth, magic link)
//   * Deep-link handler for the OAuth callback (`unmute://auth/callback`)
//   * Push session updates to all renderers when state changes
//
// The renderer's @supabase/supabase-js does the actual auth via REST. We just
// store its tokens securely and surface deep-link callbacks.

import { ipcMain, shell, BrowserWindow, safeStorage } from 'electron'
import Store from 'electron-store'

// electron-store v11 has named export; we use the default for compatibility.
const store = new Store<{ paywall: Record<string, string> }>({
  name: 'unmute-paywall',
  // Encrypt values via safeStorage if available; falls back to clear text
  // (which is itself stored under ~/Library/Application Support, sandboxed).
})

// ─── Keychain bridge ────────────────────────────────────────────
//
// EXPORTED as of the Pack E auth work. These are the token store's only
// accessors, and main now needs them directly: it mints rotated refresh
// tokens itself, and previously those reached disk ONLY by being broadcast
// to a live renderer, which then wrote them back through supabase-js's
// storage adapter. A destroyed main window — which is what the red button
// does on macOS while the app keeps running in the notch — meant main
// rotated hourly and nothing persisted any of it, leaving an already-dead
// refresh token in the keychain and signing the user out on the next cold
// start. See paywall-glue.ts's persistRotatedSession().
//
// No behaviour change here, no new storage, no safeStorage change — these
// were already the accessors, just module-private.

export function keychainGet(key: string): string | null {
  const raw = store.get(`paywall.${key}`) as string | undefined
  if (!raw) return null
  if (safeStorage.isEncryptionAvailable()) {
    try {
      const buf = Buffer.from(raw, 'base64')
      return safeStorage.decryptString(buf)
    } catch {
      // Fall through — value may have been written when encryption was unavailable
    }
  }
  return raw
}

export function keychainSet(key: string, value: string): void {
  if (safeStorage.isEncryptionAvailable()) {
    const enc = safeStorage.encryptString(value)
    store.set(`paywall.${key}`, enc.toString('base64'))
  } else {
    store.set(`paywall.${key}`, value)
  }
}

function keychainDelete(key: string): void {
  store.delete(`paywall.${key}`)
}

// ─── Deep link handler (Apple OAuth callback, magic link, payment) ─
//
// Two URL shapes share the unmute:// scheme:
//   * unmute://auth/callback?access_token=…   — OAuth / magic link
//   * unmute://payment-success?payment_id=…   — Dodo checkout completion
//
// Both need a "pending" slot because the URL may arrive BEFORE the renderer
// is ready to receive it (cold launch via deep link). Each kind has its own
// pending var + pop IPC so the two flows don't trample each other if a user
// somehow triggers both in quick succession.

let pendingAuthDeepLink: string | null = null
let pendingPaymentDeepLink: string | null = null

/** Route a freshly-arrived unmute:// URL to the right renderer channel. */
export function setPendingDeepLink(url: string): void {
  if (!url.startsWith('unmute://')) return

  // unmute://payment-success?... — Dodo checkout return.
  if (url.startsWith('unmute://payment-success')) {
    pendingPaymentDeepLink = url
    for (const w of BrowserWindow.getAllWindows()) {
      w.webContents.send('paywall:payment-callback', url)
    }
    return
  }

  // Everything else is the auth/magic-link path.
  pendingAuthDeepLink = url
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send('paywall:auth-callback', url)
  }
}

// ─── IPC registration ───────────────────────────────────────────

export function registerAuthIPC(): void {
  ipcMain.handle('paywall:keychain-get', (_e, key: string) => keychainGet(key))
  ipcMain.handle('paywall:keychain-set', (_e, key: string, value: string) => {
    keychainSet(key, value)
    return true
  })
  ipcMain.handle('paywall:keychain-delete', (_e, key: string) => {
    keychainDelete(key)
    return true
  })

  ipcMain.handle('paywall:open-external', (_e, url: string) => {
    shell.openExternal(url)
    return true
  })

  ipcMain.handle('paywall:pop-pending-auth-callback', () => {
    const url = pendingAuthDeepLink
    pendingAuthDeepLink = null
    return url
  })

  ipcMain.handle('paywall:pop-pending-payment-callback', () => {
    const url = pendingPaymentDeepLink
    pendingPaymentDeepLink = null
    return url
  })
}
