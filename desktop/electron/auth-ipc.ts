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

function keychainGet(key: string): string | null {
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

function keychainSet(key: string, value: string): void {
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

// ─── Deep link handler (Apple OAuth callback, magic link) ───────

let pendingDeepLink: string | null = null

export function setPendingDeepLink(url: string): void {
  pendingDeepLink = url
  // Broadcast to all renderers — main window will route it to supabase-js
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
    const url = pendingDeepLink
    pendingDeepLink = null
    return url
  })
}
