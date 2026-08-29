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

/** The stored value meaning "follow whatever macOS is set to". */
export const AUTOMATIC_DEVICE_ID = 'automatic'

/**
 * The Mac-side inputs a user may pick in Settings → Audio → Microphone.
 *
 * Everything real is offered — built-in, USB, interface, virtual. Two kinds of
 * entry are removed: the iPhone (the widget glyph owns that choice; a second
 * selector for it here read as if this picker routed Continuity capture), and
 * Chromium's synthetic "default" alias, which merely duplicates another entry
 * under a confusing name — AUTOMATIC is our own, clearer spelling of it.
 */
export function selectableMacInputs(
  devices: AudioInputDeviceInfo[]
): AudioInputDeviceInfo[] {
  const seen = new Set<string>()
  return devices.filter((d) => {
    if (d.kind !== 'audioinput') return false
    if (!d.deviceId || d.deviceId === 'default' || d.deviceId === 'communications') return false
    if (/iphone|continuity/i.test(d.label)) return false
    if (seen.has(d.deviceId)) return false
    seen.add(d.deviceId)
    return true
  })
}

/**
 * Resolve the deviceId to capture from for ONE recording.
 *
 * `undefined` = system default. Order: the iPhone when it is preferred AND
 * present, otherwise the user's chosen Mac input, otherwise the system
 * default. A chosen device that is no longer plugged in resolves to automatic
 * rather than a dead id — same silent-fallback guarantee the phone path has:
 * unplugging a mic must never error or kill a dictation.
 */
export function resolveCaptureDeviceId(
  preference: MicSource,
  devices: AudioInputDeviceInfo[],
  macDeviceId?: string
): string | undefined {
  if (preference === 'iphone') {
    const phone = findIphoneMic(devices)
    if (phone) return phone.deviceId
  }
  if (!macDeviceId || macDeviceId === AUTOMATIC_DEVICE_ID) return undefined
  return selectableMacInputs(devices).some((d) => d.deviceId === macDeviceId)
    ? macDeviceId
    : undefined
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
