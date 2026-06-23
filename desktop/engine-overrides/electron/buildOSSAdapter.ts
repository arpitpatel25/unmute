// OSSAdapter implementation that the paywall layer's initPaywall() expects.
//
// Wraps the OSS engine's Local (whisper.cpp) provider + session helpers so the
// ProviderRouter can route Local calls through them. Until this existed we
// passed `{} as any` and the router silently no-op'd on every non-managed path.
//
// File ends up at engine/electron/buildOSSAdapter.ts after wire_paywall
// overlays engine-overrides/, so imports are relative siblings of main.ts.

import { BrowserWindow } from 'electron'
import { whisperManager } from './whisper'
import { getPaywallAccessToken, getPaywallUser } from './paywall/paywall-glue'

interface STTOpts {
  audio: Buffer
  durationSeconds: number
  language?: string
  flowType?: string
}

export function buildOSSAdapter() {
  return {
    localSTT: {
      transcribe: async (opts: STTOpts) => {
        const text = await whisperManager.transcribe(opts.audio)
        return {
          text,
          durationSeconds: opts.durationSeconds,
          engine: 'local' as const,
          costCents: 0,
        }
      },
    },

    /** Managed access token — read from paywall-glue's currentSession. */
    getAccessToken: async (): Promise<string | null> => getPaywallAccessToken(),

    /** Managed user — read from paywall-glue's currentSession. */
    getCurrentUser: async (): Promise<{ id: string; email: string | null } | null> =>
      getPaywallUser(),

    /**
     * No-op. Renderer-driven sign-out (the profile button) calls
     * supabase.auth.signOut(); that fires onAuthStateChange which fires
     * paywallSetSession(null), which clears paywall-glue's currentSession.
     * Nothing to do here.
     */
    signOut: async (): Promise<void> => {
      /* renderer handles it */
    },

    /** Broadcast managed → local fallback to all renderers (drives the banner). */
    notifyFellBackToLocal: (topUpUrl: string): void => {
      for (const w of BrowserWindow.getAllWindows()) {
        w.webContents.send('paywall:fell-back-to-local', topUpUrl)
      }
    },
  }
}
