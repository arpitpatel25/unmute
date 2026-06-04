# Engine source patches

The build script auto-patches `electron/main.ts` and `electron/preload.ts`. Other files need one-time manual patches because the right insertion points depend on the existing JSX/control-flow structure.

## electron/sessionManager.ts — abort dangling stream in chunked path

Single-stream-for-all-chunks was tested and removed: Cloudflare terminates
streaming POSTs that stay open longer than ~30s. For long dictations the
chunked path stays upload-based (per-chunk POSTs via tryManagedSTT). Per-chunk
streaming POSTs are the proper architectural fix — separate PR.

The renderer still opens a single stream on Fn-down (for the short-clip fast
path). In chunked mode that stream gets aborted as soon as the first chunk
arrives, so it doesn't linger.

### Imports
```diff
 import { tryManagedSTT, tryManagedLLM } from './paywall-route'
+import { closeImmediate as abortStream, isStreaming } from './paywall-stream'
```

### `transcribeChunk` — abort dangling stream
Inside the `try {` block at the top of `transcribeChunk`, BEFORE the existing managed intercept:
```diff
+      if (isStreaming()) {
+        abortStream('chunked-mode-fallback')
+      }
       // ─── Managed-cloud intercept (paywall) — upload-based ────────
       const durationGuess = Math.max(1, Math.round(buffer.length / 4000))
       const managed = await tryManagedSTT(buffer, durationGuess, 'dictation')
```

## renderer/widget/useAudioRecorder.ts — wire streaming IPC
Inside `ondataavailable`, after `chunksRef.current.push(e.data)`:
```diff
+        e.data.arrayBuffer().then((buf) => {
+          window.electronAPI?.paywallStreamChunk?.(buf)
+        }).catch(() => {})
```

After `setIsRecording(true)` in startRecording:
```diff
+    window.electronAPI?.paywallStreamOpen?.({
+      flowType: mode === 'instruction' ? 'instruction' : 'dictation',
+    })
```

## renderer/app/App.tsx — add BalancePill + OutOfCreditBanner

```diff
+import { BalancePill } from '../paywall/BalancePill'
+import { OutOfCreditBanner } from '../paywall/OutOfCreditBanner'
 ...

 return (
   <div className="flex h-screen bg-cream">
     <div className="titlebar-drag absolute top-0 left-0 right-0 h-8 z-10" />

+    {/* Paywall overlays */}
+    <OutOfCreditBanner />
+    <div className="absolute top-2 right-3 z-30">
+      <BalancePill />
+    </div>

     {/* Update-ready banner */}
     ...
```

## renderer/app/Settings.tsx — add EngineSettings, remove old toggle

Find the existing **"Use Groq cloud transcription"** row (added in v1.3.4) and replace it with `<EngineSettings />`. The new component covers both the cloud/local toggle and the new managed mode in one selector.

```diff
+import { EngineSettings } from '../paywall/EngineSettings'
 ...

-{/* ═══ Behavior ═══ */}
-<SectionHeader icon={<BehaviorIcon />} title="Behavior" />
-<div className="bg-surface-2 border border-border rounded-2xl overflow-hidden mb-3 shadow-sm">
-  <SettingRow label="Use Groq cloud transcription" ...>
-    <Toggle checked={useCloudSTT} ... />
-  </SettingRow>
-  ...
+{/* ═══ Behavior ═══ */}
+<SectionHeader icon={<BehaviorIcon />} title="Behavior" />
+<div className="bg-surface-2 border border-border rounded-2xl overflow-hidden mb-3 shadow-sm">
+  <EngineSettings />
+  ...
```

## renderer/app/Onboarding.tsx — add the 3-card step

After the existing Shortcuts step, add a new step using `<OnboardingCards onComplete={(choice) => handleEngineChoice(choice)} />`.

## electron/main.ts — buildOSSAdapter()

The build script injects `initPaywall(app, buildOSSAdapter())`. You need to define `buildOSSAdapter()` once, exposing the OSS engine's existing BYOK/Local providers + the new Supabase user helpers. Reference shape:

```ts
import { whisperManager } from './whisper'
import { groqTranscribe, groqChat } from './groq'
import { hasApiKey, getApiKey } from './keyStore'
import { getSupabase, getAccessToken, getCurrentUser } from '../renderer/paywall/supabase-client'

function buildOSSAdapter() {
  return {
    byokSTT: {
      transcribe: async (opts, apiKey) => {
        const r = await groqTranscribe(opts.audio, apiKey, { ... })
        return { text: r.text, durationSeconds: r.duration, engine: 'byok', costCents: 0 }
      },
    },
    byokLLM: {
      complete: async (opts, apiKey) => {
        const r = await groqChat(opts.messages, apiKey, { ... })
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

## Sessionmanager wiring

In `sessionManager.transcribeChunk()`, replace the existing provider routing with a call to `getRouter().transcribe(...)`. Same for LLM transforms. The router handles the auto-fallback chain transparently.
