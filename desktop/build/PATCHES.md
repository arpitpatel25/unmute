# Engine source patches

The build script applies engine source modifications in two layers:

1. **Sed-based patcher** for two stable, single-line inserts:
   - `electron/main.ts` — `initPaywall(app, buildOSSAdapter())` after `createWidgetWindow()`
   - `electron/preload.ts` — spread `...paywallPreloadExtensions` into `electronAPI`

2. **Full-file overrides** under `desktop/engine-overrides/` for files that need larger
   structural changes. The build script's `wire_paywall` step does a recursive copy of
   `engine-overrides/` over the freshly-cloned OSS engine right before sed-patching.
   Mirroring the OSS path structure makes the copy trivial and keeps each override
   diffable against the OSS original.

## Current overrides

| File | Purpose |
|---|---|
| `renderer/app/App.tsx` | Mounts `<BalancePill />` and `<OutOfCreditBanner />` |
| `renderer/app/Settings.tsx` | Replaces the "Use Groq cloud transcription" row with `<EngineSettings />` |
| `renderer/widget/useAudioRecorder.ts` | Opens a paywall stream on record-start; forwards each MediaRecorder blob via `paywallStreamChunk` |
| `electron/sessionManager.ts` | Adds a managed-cloud intercept at the top of `transcribeChunk` (await streaming POST result if one exists, else `tryManagedSTT` upload-based, else abort dangling stream and fall through to the OSS engine's own STT) |

## Adding a new override

1. Copy the OSS file from `desktop/work/oss-engine/<path>` to `desktop/engine-overrides/<same-path>`.
2. Apply your edits to the override.
3. Add a `grep` paranoia check in `wire-into-engine.sh`'s `patch_engine_sources` so the build
   warns if the override didn't land.
4. Document it in the table above.

## Why we don't use `.patch` files

OSS file structure changes too often. A full-file override stays valid as long as the
override stays in sync with the OSS file's surrounding context — which is easy to verify
with `diff` and easy to update when a new OSS release lands.

## OSS-side context: `buildOSSAdapter()` in `electron/main.ts`

The sed patcher injects `initPaywall(app, buildOSSAdapter())`. `buildOSSAdapter()` must be
defined somewhere in main.ts and expose the OSS engine's existing BYOK / Local providers
plus Supabase user helpers:

```ts
import { whisperManager } from './whisper'
import { groqTranscribe, groqChat } from './groq'
import { hasApiKey, getApiKey } from './keyStore'
import { getSupabase, getAccessToken, getCurrentUser } from '../renderer/paywall/supabase-client'

function buildOSSAdapter() {
  return {
    byokSTT: {
      transcribe: async (opts, apiKey) => {
        const r = await groqTranscribe(opts.audio, apiKey, { /* ... */ })
        return { text: r.text, durationSeconds: r.duration, engine: 'byok', costCents: 0 }
      },
    },
    byokLLM: {
      complete: async (opts, apiKey) => {
        const r = await groqChat(opts.messages, apiKey, { /* ... */ })
        return { text: r.content, engine: 'byok', costCents: 0 }
      },
    },
    localSTT: {
      transcribe: async (opts) => {
        const text = await whisperManager.transcribe(opts.audio)
        return { text, durationSeconds: opts.durationSeconds, engine: 'local', costCents: 0 }
      },
    },
    getByokKey: async () => hasApiKey() ? await getApiKey() : null,
    getAccessToken,
    getCurrentUser,
    signOut: async () => { await getSupabase().auth.signOut() },
    notifyFellBackToLocal: (url) => {
      for (const w of BrowserWindow.getAllWindows()) {
        w.webContents.send('paywall:fell-back-to-local', url)
      }
    },
  }
}
```

This is currently still manual — moving it into a 5th override is a follow-up.
