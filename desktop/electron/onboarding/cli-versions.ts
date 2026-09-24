// Agent CLI versions: reading them, comparing them, and the oldest Unmute can
// drive. Shared by the onboarding probe and the updater (remote/cli-updates).

import type { ProviderId } from './types'

/** The first `x.y.z` in a `--version` line ("2.1.280 (Claude Code)",
 *  "codex-cli 0.156.1"). Prerelease suffixes are ignored. */
export function parseVersion(text: string): string | null {
  return text.match(/(\d+)\.(\d+)\.(\d+)/)?.[0] ?? null
}

/**
 * The oldest CLI Unmute can drive, measured rather than guessed. Below these a
 * CLI is not "old but working": tasks fail at spawn, so it counts as not ready
 * and is updated at once instead of on the next routine pass.
 *
 * Claude Code 2.1.38 is the first release that accepts `--effort` (2.1.37
 * exits with "unknown option"); every other flag Unmute passes is older.
 * Codex 0.136.0 is the first whose app-server has every method Unmute calls
 * (0.135 lacks `skills/extraRoots/set`).
 */
export const MIN_CLI_VERSIONS: Record<ProviderId, string> = {
  claude: '2.1.38',
  codex: '0.136.0',
}

/** Is this installed version older than Unmute can drive? */
export function belowMinimum(cli: ProviderId, version: string): boolean {
  return compareVersions(version, MIN_CLI_VERSIONS[cli]) < 0
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return Math.sign(d)
  }
  return 0
}
