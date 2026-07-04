// Mic-source resolution — the pure semantics behind the iPhone-mic
// tap-to-switch feature.
//
// Design rules (settled with the user, do not drift):
//   - The MacBook mic is ALWAYS the default and first priority. The iPhone
//     (Apple Continuity Camera microphone — zero-install, appears as a normal
//     macOS input device) is strictly opt-in via one tap on the widget glyph.
//   - NEVER prompt, nudge, or surface the feature proactively. The glyph state
//     is the entire UI.
//   - Preferring the iPhone while the phone is absent silently resolves to
//     the Mac mic (no error states); when the phone returns, the user's last
//     explicit choice is honored again — restoring THEIR choice is not the
//     product initiating anything.
//   - Resolution happens per-recording, at capture start. `undefined` means
//     "system default" downstream in getUserMedia. Sources are never swapped
//     mid-recording.
//
// Pure module: no DOM, no React — unit-tested by micSource.test.ts.

export type MicSource = 'mac' | 'iphone'

/** The subset of MediaDeviceInfo this module needs (keeps it DOM-type-free). */
export interface AudioInputDeviceInfo {
  kind: string
  label: string
  deviceId: string
}

/**
 * Find the Continuity iPhone microphone in a device list, if present.
 *
 * Chromium exposes it as an `audioinput` labeled e.g. "Arpit's iPhone
 * Microphone (Continuity Camera)" — matching "iphone" in the label is the
 * discriminator. The system-default alias (deviceId "default") duplicates
 * whatever device is default; prefer the concrete entry so capture pins the
 * exact device rather than whatever "default" later points at.
 */
export function findIphoneMic(
  devices: AudioInputDeviceInfo[]
): AudioInputDeviceInfo | null {
  const iphoneMics = devices.filter(
    (d) => d.kind === 'audioinput' && /iphone/i.test(d.label)
  )
  if (iphoneMics.length === 0) return null
  return iphoneMics.find((d) => d.deviceId !== 'default') ?? iphoneMics[0]
}

/**
 * Resolve the deviceId to capture from for ONE recording.
 * `undefined` = system default (the MacBook mic path) — including the silent
 * fallback when the iPhone is preferred but not around.
 */
export function resolveCaptureDeviceId(
  preference: MicSource,
  devices: AudioInputDeviceInfo[]
): string | undefined {
  if (preference !== 'iphone') return undefined
  return findIphoneMic(devices)?.deviceId
}

/**
 * What is ACTUALLY capturing given the preference and reality — drives the
 * glyph, which must always tell the truth about what's listening.
 */
export function effectiveSource(
  preference: MicSource,
  devices: AudioInputDeviceInfo[]
): MicSource {
  return preference === 'iphone' && findIphoneMic(devices) ? 'iphone' : 'mac'
}
