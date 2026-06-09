/**
 * Feature flags — engine-override.
 *
 * OSS engine defaults `localModels = false` and gates the whisper.cpp
 * path (model status, download, transcription) on this flag — meaning
 * the entire Local pillar is silently disabled in stock OSS builds:
 * `getWhisperModelStatus()` returns false even when the model file
 * exists, and `downloadWhisperModel()` returns `{success: false}`
 * without actually downloading anything.
 *
 * For unmute Pro we want all three pillars (Managed / BYOK / Local)
 * to work out of the box. Override the default to `true` here. The
 * server config can still override this at runtime via
 * `updateFeaturesFromConfig()` (which is preserved verbatim).
 */

export const features = {
  localModels: true,
}

/**
 * Update feature flags from the server config response.
 * Called after every successful config fetch in refreshServerConfig().
 */
export function updateFeaturesFromConfig(config: { devFeatures?: { localModels: boolean } }): void {
  const prev = features.localModels
  // Server config can still flip this off if we ever want to disable
  // local models per-environment; default if missing is the Pro
  // default (true), not the OSS default (false).
  features.localModels = config.devFeatures?.localModels ?? true
  if (features.localModels !== prev) {
    console.log(`[features] localModels: ${prev} → ${features.localModels}`)
  }
}
