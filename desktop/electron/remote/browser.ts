// Unmute Remote — dedicated automation browser (DECIDED isolation model).
//
// To keep Claude-in-Chrome automation from interrupting the user's *own*
// browsing, we drive a DEDICATED Chrome instance with its own user-data-dir,
// parked off to the side (ideally a separate macOS Space). The "started
// debugging this browser" banner + any opened tabs live in THAT window, so the
// user's main Chrome (Netflix/YouTube/etc.) is untouched.
//
// What this module owns (deterministic, testable):
//   * the automation profile path,
//   * constructing the launch command/args for the isolated Chrome.
//
// What is RUNTIME-DEPENDENT (verify on-device, can't unit-test):
//   * the Claude-in-Chrome extension must be installed/enabled in THIS profile,
//   * `claude --chrome` must connect to THIS instance (select-browser),
//   * placing the window on a separate Space (macOS window-management).
// These are the on-device steps; the launch + profile here are the parts we
// can build and test now.

import { join } from 'node:path'
import { homedir } from 'node:os'
import { createLogger } from './log'

const log = createLogger('browser')

const CHROME_BIN = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

/** The dedicated automation profile dir (separate from the user's real Chrome). */
export function automationProfileDir(baseDir?: string): string {
  return join(baseDir ?? join(homedir(), '.unmute', 'remote'), 'chrome-profile')
}

export interface LaunchOpts {
  /** Override the Chrome binary (tests / Edge). */
  chromeBin?: string
  /** Override the profile dir. */
  profileDir?: string
  /** Enable CDP on this port (a browser-automation MCP can attach to it). */
  debugPort?: number
  /** Injected spawner (tests). Default: child_process.spawn detached. */
  spawn?: (file: string, args: string[]) => void
}

/**
 * Build the launch args for the isolated automation Chrome. Pure + testable.
 * Separate `--user-data-dir` = a distinct Chrome instance, so its debug banner
 * and tabs never touch the user's main browser.
 */
export function buildLaunchArgs(opts: LaunchOpts = {}): { bin: string; args: string[] } {
  const profileDir = opts.profileDir ?? automationProfileDir()
  const args = [
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
  ]
  if (opts.debugPort) args.push(`--remote-debugging-port=${opts.debugPort}`)
  return { bin: opts.chromeBin ?? CHROME_BIN, args }
}

/**
 * Launch the dedicated automation Chrome (best-effort). Returns the command it
 * ran so callers/logs can show it. Does NOT guarantee the extension is
 * connected — that's a one-time on-device setup (guided in onboarding).
 */
export function launchAutomationChrome(opts: LaunchOpts = {}): { bin: string; args: string[] } {
  const { bin, args } = buildLaunchArgs(opts)
  log.event('launch-automation-chrome', { bin, profileDir: opts.profileDir ?? automationProfileDir() })
  try {
    if (opts.spawn) {
      opts.spawn(bin, args)
    } else {
      // Lazy-require so this module unit-tests without electron/node spawn deps
      // resolving in the overlay.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { spawn } = require('node:child_process') as typeof import('node:child_process')
      const child = spawn(bin, args, { detached: true, stdio: 'ignore' })
      child.unref()
    }
  } catch (e) {
    log.warn('automation Chrome launch failed (browser tasks may use the user\'s Chrome instead)', {
      error: (e as Error).message,
    })
  }
  return { bin, args }
}
