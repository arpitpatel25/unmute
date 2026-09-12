// The frontmost browser's active tab URL, for meeting detection (spec §3).
//
// THIS WAS APPLESCRIPT, AND THE APPLESCRIPT WAS THE BUG.
// `tell application "Safari" to get URL of current tab` is an Apple Event, so
// macOS gates it behind Automation (kTCCServiceAppleEvents) and raises a
// consent dialog PER BROWSER the first time the poll touches one. That poll
// runs every 3s whenever a supported browser is frontmost (notetakerInit.ts),
// with no task and no meeting required — so users saw "unmute wants to control
// Safari" with nothing on screen to explain it. The prompt was never the
// feature asking for something it needed; it was the feature asking in the
// most expensive dialect available.
//
// The same string is reachable through the Accessibility grant Unmute ALREADY
// holds (dictation paste, computer use), via AXWebArea's AXURL — the COMMITTED
// page url, which is exactly what the AppleScript returned. No new grant, no
// dialog, same answer. Verified against a live Chromium browser: full URL
// including query string.
//
// OFF THE MAIN THREAD, DELIBERATELY. The old call was a child process and
// therefore free to the main thread; this one is an AX tree walk, and a
// Chromium browser answers it slowly (measured: ~260ms on live Chrome, vs ~0ms
// on an app that exposes AXURL on the window). Routing it through the AX worker
// bridge keeps that cost off the Electron main thread, where dictation latency
// is decided. Do not "simplify" this to a direct require of the addon.
//
// The browser list is UNCHANGED. Chrome is still excluded for the same reason
// as before (meetingApps.ts leaves com.google.Chrome out of the meeting bundle
// ids), even though AX would now reach it — that is a detection decision, not a
// transport one, and this change is not the place to revisit it.

export type TabUrlBrowser = 'Safari' | 'Microsoft Edge' | 'Brave Browser' | 'Arc'

/** Firefox has no scriptable tab-URL surface and never had one; it stays out
 *  here for the same reason it did under AppleScript — spec §3. */
export const SUPPORTED_TAB_URL_BROWSERS: readonly TabUrlBrowser[] = [
  'Safari',
  'Microsoft Edge',
  'Brave Browser',
  'Arc',
]

/** Injected by tests. The real one asks the AX worker for the app's front
 *  window URL; it resolves to '' for an app that is not running. */
export type ReadTabUrl = (browser: string) => Promise<string>

interface AxCall { call(method: string, args: unknown[]): Promise<unknown> }

/**
 * The AX worker bridge, loaded by its POST-WIRE path.
 *
 * Deliberately a lazy `require` and not a static import. engine-overrides/ and
 * electron/remote/ are SIBLING trees in this repo and only become
 * parent/child once build/wire-into-engine.sh runs — and this file is one of
 * the few under engine-overrides/electron/ that carries standing typecheck
 * coverage (see the include list in tsconfig.typecheck.json, which names it).
 * A static `./paywall/remote/...` import would trade that coverage for a
 * permanent TS2307, which is the exact wall the tsconfig's exclude list exists
 * to document. A require resolves in both places this code actually runs: the
 * wired app, and `npm test` (wired-tree-setup.mjs patches precisely this
 * resolution path). Same idiom notetakerInit.ts uses for the addon itself.
 *
 * Cached only on success — a failure during early startup must not pin this to
 * "unavailable" for the life of the process.
 */
let cachedBridge: AxCall | null = null
function axBridge(): AxCall | null {
  if (cachedBridge) return cachedBridge
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('./paywall/remote/ax/ax-bridge') as { getAxBridge(): AxCall }
    cachedBridge = mod.getAxBridge()
  } catch {
    return null
  }
  return cachedBridge
}

const defaultReadTabUrl: ReadTabUrl = async (browser) => {
  const bridge = axBridge()
  if (!bridge) return ''
  return (await bridge.call('activeTabURL', [browser])) as string
}

/**
 * The active tab's URL for a running supported browser, or undefined if the
 * browser isn't running, has no window, or the read fails for any reason.
 *
 * Never throws — this is a best-effort polling signal, not a hard dependency
 * (spec §3, §9). A miss degrades to exactly what an osascript failure degraded
 * to before: no tab signal for this tick, and the now-playing/bundle-id signal
 * carries meeting detection on its own.
 */
export async function getActiveTabUrl(
  browser: TabUrlBrowser,
  read: ReadTabUrl = defaultReadTabUrl
): Promise<string | undefined> {
  try {
    const url = (await read(browser))?.trim() ?? ''
    return url.length > 0 ? url : undefined
  } catch {
    return undefined
  }
}
