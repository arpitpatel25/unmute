import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'

export type AppleScriptBrowser = 'Safari' | 'Microsoft Edge' | 'Brave Browser' | 'Arc'

export const SUPPORTED_APPLESCRIPT_BROWSERS: readonly AppleScriptBrowser[] = [
  'Safari',
  'Microsoft Edge',
  'Brave Browser',
  'Arc',
]

export type ExecFile = (cmd: string, args: string[]) => Promise<string>

const defaultExecFile: ExecFile = promisify(execFileCb) as unknown as ExecFile

/**
 * Safari's AppleScript dictionary exposes "current tab of front window";
 * Chromium-family browsers (Edge, Brave, Arc — like Chrome) expose
 * "active tab of front window" instead. Firefox has no AppleScript tab-URL
 * support at all (dropped in Firefox 3.6, never restored) and is
 * deliberately not in SUPPORTED_APPLESCRIPT_BROWSERS — spec §3.
 */
function scriptFor(browser: AppleScriptBrowser): string {
  const tabExpr = browser === 'Safari' ? 'URL of current tab of front window' : 'URL of active tab of front window'
  return `tell application "${browser}" to get ${tabExpr}`
}

/**
 * Returns the active tab's URL for a running AppleScript-scriptable browser,
 * or undefined if the browser isn't running, has no windows, or the script
 * fails for any reason. Never throws — this is a best-effort polling signal,
 * not a hard dependency (spec §3, §9).
 */
export async function getActiveTabUrl(
  browser: AppleScriptBrowser,
  execFile: ExecFile = defaultExecFile
): Promise<string | undefined> {
  try {
    const stdout = await execFile('osascript', ['-e', scriptFor(browser)])
    const trimmed = stdout.trim()
    return trimmed.length > 0 ? trimmed : undefined
  } catch {
    return undefined
  }
}
