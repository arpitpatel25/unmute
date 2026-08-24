/**
 * Native meeting-app bundle IDs, matched against readNowPlaying()'s
 * bundleIdentifier or native-ax's listApps()/frontmostApp(). Browser bundle
 * IDs (Chrome, Safari, etc.) are deliberately excluded here — a browser
 * running is not itself a meeting signal; see isMeetingTabUrl for that case.
 */
/** Named separately (not just the array entry below) so other files that
 *  need to identify Zoom specifically — e.g. the notetaker's Zoom
 *  active-speaker poller — import one canonical constant instead of
 *  duplicating the literal string, which would otherwise be free to drift. */
export const ZOOM_BUNDLE_ID = 'us.zoom.xos'

export const MEETING_APP_BUNDLE_IDS: readonly string[] = [
  ZOOM_BUNDLE_ID, // Zoom desktop
  'com.microsoft.teams2', // Teams (new)
  'com.microsoft.teams', // Teams (classic)
  'Cisco-Systems.Spark', // Webex
  'com.cisco.webexmeetingsapp', // Webex Meetings
  'com.google.meet', // Google Meet desktop wrapper (rare, but exists)
  'com.hnc.Discord', // Discord voice/video channel
  'com.electron.discord',
]

export function isMeetingAppBundleId(bundleId: string | undefined): boolean {
  if (!bundleId) return false
  return MEETING_APP_BUNDLE_IDS.includes(bundleId)
}

/**
 * Browser tab URL patterns for the browser-based meeting surfaces (spec §3).
 * Deliberately requires a path/query beyond the bare root — meet.google.com/
 * alone is the marketing page, not an active or joinable call.
 */
export const MEETING_TAB_URL_PATTERNS: readonly RegExp[] = [
  /^https:\/\/meet\.google\.com\/[a-z0-9-]{3,}/i,
  /^https:\/\/([a-z0-9-]+\.)?zoom\.us\/(j|wc)\//i,
  /^https:\/\/teams\.microsoft\.com\/l\/meetup-join\//i,
  /^https:\/\/([a-z0-9-]+\.)?webex\.com\/(meet|join)\//i,
  /^https:\/\/[a-z0-9-]+\.webex\.com\/[a-z0-9-]+\/j\.php/i,
]

export function isMeetingTabUrl(url: string | undefined): boolean {
  if (!url) return false
  return MEETING_TAB_URL_PATTERNS.some((pattern) => pattern.test(url))
}
