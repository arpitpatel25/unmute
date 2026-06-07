// OSSAdapter implementation that the paywall layer's initPaywall() expects.
//
// Wraps the OSS engine's existing BYOK (Groq) + Local (whisper.cpp) providers
// + key store + session helpers so the ProviderRouter can route BYOK / Local
// calls through them. Until this existed we passed `{} as any` and the
// router silently no-op'd on every non-managed path.
//
// File ends up at engine/electron/buildOSSAdapter.ts after wire_paywall
// overlays engine-overrides/, so imports are relative siblings of main.ts.

import { BrowserWindow } from 'electron'
import { whisperManager } from './whisper'
import { groqTranscribe, groqChat } from './groq'
import { hasApiKey, getApiKey } from './keyStore'
import { getPaywallAccessToken, getPaywallUser } from './paywall/paywall-glue'

interface STTOpts {
  audio: Buffer
  durationSeconds: number
  language?: string
  flowType?: string
}

interface LLMOpts {
  messages: Array<{ role: string; content: string }>
  temperature?: number
  maxTokens?: number
}

export function buildOSSAdapter() {
  return {
    byokSTT: {
      /**
       * BYOK STT. The `apiKey` parameter is accepted for interface parity but
       * ignored — groqTranscribe pulls from the OSS keychain via requireKey()
       * which already knows the user's stored key. Passing it again would
       * just be lying about which key was used.
       */
      transcribe: async (opts: STTOpts, _apiKey: string) => {
        void _apiKey
        const text = await groqTranscribe(opts.audio, {
          language: opts.language,
        })
        return {
          text,
          durationSeconds: opts.durationSeconds,
          engine: 'byok' as const,
          // Local usage estimate is recorded inside groqTranscribe via
          // recordSttUsage(); we don't double-count here.
          costCents: 0,
        }
      },
    },

    byokLLM: {
      complete: async (opts: LLMOpts, _apiKey: string) => {
        void _apiKey
        const text = await groqChat(
          opts.messages as Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
          { temperature: opts.temperature, maxTokens: opts.maxTokens },
        )
        return {
          text,
          engine: 'byok' as const,
          costCents: 0,
        }
      },
    },

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

    getByokKey: async (): Promise<string | null> => (hasApiKey() ? getApiKey() : null),

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
