// Supabase client initialized in the renderer. The Electron main process
// also has its own client (for verifying session liveness on startup before
// any API calls). Renderer uses this for sign-in flows; main uses its own
// instance for refresh + IPC.
//
// Tokens are stored in the OS keychain via Electron IPC, NOT in localStorage.
// We override Supabase's storage adapter to delegate to the main process.

import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// These come from the build script — substituted at compile time so
// nothing is hardcoded in the OSS engine's source.
declare const __SUPABASE_URL__: string
declare const __SUPABASE_ANON_KEY__: string

// ─── Keychain-backed storage adapter ────────────────────────────
// Bridges supabase-js to electron-store (which sits behind the keychain).
// All keychain access goes through IPC to the main process.

const KEYCHAIN_STORAGE = {
  async getItem(key: string): Promise<string | null> {
    return await window.electronAPI.paywallKeychainGet(key)
  },
  async setItem(key: string, value: string): Promise<void> {
    await window.electronAPI.paywallKeychainSet(key, value)
  },
  async removeItem(key: string): Promise<void> {
    await window.electronAPI.paywallKeychainDelete(key)
  },
}

let cachedClient: SupabaseClient | null = null

export function getSupabase(): SupabaseClient {
  if (cachedClient) return cachedClient
  cachedClient = createClient(__SUPABASE_URL__, __SUPABASE_ANON_KEY__, {
    auth: {
      // @ts-expect-error - supabase-js types want Storage but our async adapter
      // satisfies it functionally in v2.
      storage: KEYCHAIN_STORAGE,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false, // we handle deep links explicitly via Electron
    },
  })
  return cachedClient
}

/** Convenience: get the current access token for API calls, or null. */
export async function getAccessToken(): Promise<string | null> {
  const supa = getSupabase()
  const { data } = await supa.auth.getSession()
  return data.session?.access_token ?? null
}

/** Convenience: get the current user, or null. */
export async function getCurrentUser(): Promise<{ id: string; email: string | null } | null> {
  const supa = getSupabase()
  const { data } = await supa.auth.getUser()
  if (!data.user) return null
  return { id: data.user.id, email: data.user.email ?? null }
}
