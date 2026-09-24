// Unmute Remote — keep the user's Claude Code and Codex CLIs up to date.
//
// WHY THIS EXISTS. Unmute does not ship its own agent: it drives whatever
// `claude` and `codex` the user has installed, and every model list it offers
// comes FROM those CLIs (Claude's initialize, Codex's `model/list`). A CLI that
// is never upgraded therefore hides every model released after it — and many
// users never upgrade, because they never open a terminal once Unmute works.
// Claude's own autoupdater only runs inside an interactive session, which
// Unmute's headless turns never are, and Codex has no background updater.
//
// DECIDED: update IN PLACE, through the channel the CLI was installed with.
// We never install a second copy (that splits the user's login, config and
// PATH), and we never use sudo. The install channel is read from where the
// binary actually lives; one we don't recognise is reported, not guessed at.
//
// Checks are cheap (a `--version` and one npm-registry GET per CLI) and the
// update itself only runs when the installed version is behind.

import { execFile } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { belowMinimum, compareVersions, MIN_CLI_VERSIONS, parseVersion } from '../onboarding/cli-versions'
import { resolveKnownProviderBinary } from '../onboarding/provider-probe'
import { installProvider } from '../onboarding/provider-setup'
import type { ProviderId } from '../onboarding/types'

export type CliId = ProviderId

/** Where the published version is announced. The native Claude installer and
 *  Homebrew both ship the same version numbers as these npm packages. */
export const CLI_PACKAGES: Record<CliId, string> = {
  claude: '@anthropic-ai/claude-code',
  codex: '@openai/codex',
}

/** How a CLI got onto this Mac, which decides how it may be updated. */
export type InstallChannel =
  /** Claude's native installer (or its legacy local install): `claude update`. */
  | { kind: 'self-update' }
  /** A global npm package, under this npm prefix. */
  | { kind: 'npm'; prefix: string }
  /** Homebrew, as a cask or a formula, managed by this `brew`. */
  | { kind: 'brew'; brew: string; name: string; cask: boolean }
  /** Codex's standalone installer (~/.codex): re-running it upgrades in place. */
  | { kind: 'installer' }
  /** The copy inside a desktop app — the app updates it, we must not. */
  | { kind: 'app-bundled' }
  | { kind: 'unknown' }

/** Read the install channel off the binary's real (symlink-resolved) path. */
export function detectChannel(cli: CliId, realPath: string, env: { home: string; codexHome?: string }): InstallChannel {
  if (realPath.startsWith('/Applications/') || realPath.includes('.app/Contents/')) return { kind: 'app-bundled' }
  const brew = realPath.match(/^(.*)\/(Caskroom|Cellar)\/([^/]+)\//)
  if (brew) return { kind: 'brew', brew: `${brew[1]}/bin/brew`, name: brew[3], cask: brew[2] === 'Caskroom' }
  const npm = realPath.match(/^(.*)\/lib\/node_modules\/(@[^/]+\/[^/]+)\//)
  if (npm && npm[2] === CLI_PACKAGES[cli]) return { kind: 'npm', prefix: npm[1] }
  if (cli === 'claude') {
    if (realPath.startsWith(join(env.home, '.local', 'share', 'claude') + '/')) return { kind: 'self-update' }
    if (realPath.startsWith(join(env.home, '.claude', 'local') + '/')) return { kind: 'self-update' }
  }
  if (cli === 'codex') {
    const codexHome = env.codexHome || join(env.home, '.codex')
    if (realPath.startsWith(codexHome + '/')) return { kind: 'installer' }
  }
  return { kind: 'unknown' }
}

export { belowMinimum, compareVersions, MIN_CLI_VERSIONS, parseVersion } from '../onboarding/cli-versions'

type Command = { command: string; args: string[] }

/** The in-place update for a channel, or null when Unmute must not do it. */
export function updateCommandFor(cli: CliId, binary: string, channel: InstallChannel, exists: (path: string) => boolean): Command | 'installer' | null {
  switch (channel.kind) {
    case 'self-update':
      return { command: binary, args: ['update'] }
    case 'npm': {
      // The npm that owns this prefix, so an nvm/Homebrew/system split can
      // never upgrade a different copy than the one Unmute actually runs.
      const npm = join(channel.prefix, 'bin', 'npm')
      return { command: exists(npm) ? npm : 'npm', args: ['install', '--global', '--prefix', channel.prefix, `${CLI_PACKAGES[cli]}@latest`] }
    }
    case 'brew':
      return { command: exists(channel.brew) ? channel.brew : 'brew', args: channel.cask ? ['upgrade', '--cask', channel.name] : ['upgrade', channel.name] }
    case 'installer':
      return 'installer'
    default:
      return null
  }
}

/** What the user can run themselves when Unmute could not update for them. */
export function manualCommandFor(cli: CliId, channel: InstallChannel): string | undefined {
  switch (channel.kind) {
    case 'self-update': return 'claude update'
    case 'npm': return `npm install -g ${CLI_PACKAGES[cli]}@latest`
    case 'brew': return channel.cask ? `brew upgrade --cask ${channel.name}` : `brew upgrade ${channel.name}`
    case 'installer': return 'curl -fsSL https://chatgpt.com/codex/install.sh | sh'
    case 'app-bundled': return undefined
    case 'unknown': return cli === 'claude' ? 'claude update' : `npm install -g ${CLI_PACKAGES.codex}@latest`
  }
}

export type CliUpdateResult =
  | { cli: CliId; state: 'not-installed' }
  /** Was missing, and Unmute installed it with the official installer. */
  | { cli: CliId; state: 'installed'; version: string }
  | { cli: CliId; state: 'install-failed'; detail: string }
  | { cli: CliId; state: 'disabled' }
  /** Could not learn the installed or the published version; nothing done. */
  | { cli: CliId; state: 'unknown'; detail: string }
  | { cli: CliId; state: 'current'; version: string }
  | { cli: CliId; state: 'updated'; from: string; to: string }
  /** Behind, and not ours to update (a desktop app's copy, or an install we
   *  don't recognise). Reported so the user can be told. */
  | { cli: CliId; state: 'outdated'; version: string; latest: string; channel: InstallChannel['kind']; command?: string; belowMinimum?: true }
  | { cli: CliId; state: 'failed'; version: string; latest: string; detail: string; command?: string; belowMinimum?: true }

type RunResult = { code: number | null; stdout: string; stderr: string }

export interface CliUpdateDeps {
  resolveBinary(cli: CliId): Promise<string | null>
  realpath(path: string): string
  exists(path: string): boolean
  run(command: string, args: string[], timeoutMs: number): Promise<RunResult>
  latestVersion(pkg: string): Promise<string | null>
  runInstaller(cli: CliId): Promise<{ ok: boolean; detail?: string }>
  /** The user has opted this CLI out of automatic updates. */
  disabled(cli: CliId): boolean
  home: string
  codexHome?: string
}

const VERSION_TIMEOUT_MS = 10_000
const UPDATE_TIMEOUT_MS = 5 * 60_000

async function installedVersion(deps: CliUpdateDeps, binary: string): Promise<string | null> {
  const r = await deps.run(binary, ['--version'], VERSION_TIMEOUT_MS)
  return r.code === 0 ? parseVersion(r.stdout) ?? parseVersion(r.stderr) : null
}

/** Install a missing CLI with its official installer (a fresh install has no
 *  channel to respect yet, and the installer is what the onboarding button
 *  runs too). */
async function installMissing(cli: CliId, deps: CliUpdateDeps): Promise<CliUpdateResult> {
  const r = await deps.runInstaller(cli)
  if (!r.ok) return { cli, state: 'install-failed', detail: r.detail || 'The installer did not finish.' }
  const binary = await deps.resolveBinary(cli)
  const version = binary ? await installedVersion(deps, binary) : null
  if (!version) return { cli, state: 'install-failed', detail: 'The installer finished, but the CLI is still not where Unmute looks for it.' }
  return { cli, state: 'installed', version }
}

/** Check one CLI and, when it is behind and ours to update, update it.
 *  `installIfMissing` also installs it when it is absent — the caller decides,
 *  because a Mac that runs only the other agent must not be given this one. */
export async function updateCli(cli: CliId, deps: CliUpdateDeps, opts: { installIfMissing?: boolean } = {}): Promise<CliUpdateResult> {
  if (deps.disabled(cli)) return { cli, state: 'disabled' }
  const binary = await deps.resolveBinary(cli)
  if (!binary) return opts.installIfMissing ? installMissing(cli, deps) : { cli, state: 'not-installed' }

  const version = await installedVersion(deps, binary)
  if (!version) return { cli, state: 'unknown', detail: `Could not read ${binary} --version.` }
  // Below the minimum the update is not optional, so it goes ahead even when
  // the registry cannot be reached: every channel installs @latest anyway.
  const tooOld = belowMinimum(cli, version)
  const published = await deps.latestVersion(CLI_PACKAGES[cli]).catch(() => null)
  if (!published && !tooOld) return { cli, state: 'unknown', detail: 'Could not read the latest published version.' }
  if (published && compareVersions(version, published) >= 0) return { cli, state: 'current', version }
  const latest = published ?? MIN_CLI_VERSIONS[cli]
  const flag = tooOld ? { belowMinimum: true as const } : {}

  let real = binary
  try { real = deps.realpath(binary) } catch { /* keep the unresolved path */ }
  const channel = detectChannel(cli, real, { home: deps.home, codexHome: deps.codexHome })
  const command = manualCommandFor(cli, channel)
  const update = updateCommandFor(cli, binary, channel, deps.exists)
  if (!update) return { cli, state: 'outdated', version, latest, channel: channel.kind, ...(command ? { command } : {}), ...flag }

  if (update === 'installer') {
    const r = await deps.runInstaller(cli)
    if (!r.ok) return { cli, state: 'failed', version, latest, detail: r.detail || 'The installer did not finish.', ...(command ? { command } : {}), ...flag }
  } else {
    const r = await deps.run(update.command, update.args, UPDATE_TIMEOUT_MS)
    if (r.code !== 0) {
      const detail = (r.stderr.trim() || r.stdout.trim() || `${update.command} exited ${r.code}`).slice(-500)
      return { cli, state: 'failed', version, latest, detail, ...(command ? { command } : {}), ...flag }
    }
  }

  // Re-read rather than trust the exit code: Homebrew can lag npm by a release,
  // in which case `brew upgrade` succeeds and changes nothing.
  const after = await installedVersion(deps, binary) ?? version
  if (compareVersions(after, version) > 0 && !belowMinimum(cli, after)) return { cli, state: 'updated', from: version, to: after }
  if (compareVersions(after, version) > 0) return { cli, state: 'outdated', version: after, latest, channel: channel.kind, ...(command ? { command } : {}), ...flag }
  return { cli, state: 'outdated', version, latest, channel: channel.kind, ...(command ? { command } : {}), ...flag }
}

// ---------------------------------------------------------------------------
// Electron-side defaults and scheduling.

function exec(command: string, args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    // Non-interactive: nothing we run may sit waiting on a prompt nobody sees.
    const env = { ...process.env, CI: '1', HOMEBREW_NO_ENV_HINTS: '1', npm_config_yes: 'true', npm_config_fund: 'false', npm_config_audit: 'false' }
    execFile(command, args, { env, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1) : 0
      resolve({ code, stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

/** Claude Code's own opt-out, honoured so we never override a deliberate
 *  choice: DISABLE_AUTOUPDATER in the environment or in ~/.claude/settings.json. */
export function claudeAutoUpdateDisabled(env: NodeJS.ProcessEnv, settingsJson: string | null): boolean {
  const on = (v: unknown) => v === '1' || v === 'true' || v === 1 || v === true
  if (on(env.DISABLE_AUTOUPDATER)) return true
  if (!settingsJson) return false
  try { return on((JSON.parse(settingsJson) as { env?: Record<string, unknown> }).env?.DISABLE_AUTOUPDATER) } catch { return false }
}

export function defaultCliUpdateDeps(opts: { enabled: () => boolean }): CliUpdateDeps {
  const home = homedir()
  return {
    resolveBinary: (cli) => resolveKnownProviderBinary(cli, {
      which: (bin) => new Promise((resolve) => {
        execFile('/usr/bin/which', [bin], { env: process.env }, (err, stdout) => resolve(err ? null : String(stdout).trim() || null))
      }),
      home,
      exists: async (p) => existsSync(p),
    }),
    realpath: (p) => realpathSync(p),
    exists: (p) => existsSync(p),
    run: exec,
    async latestVersion(pkg) {
      const res = await fetch(`https://registry.npmjs.org/${pkg}/latest`, { signal: AbortSignal.timeout(15_000) })
      if (!res.ok) return null
      const v = (await res.json() as { version?: unknown }).version
      return typeof v === 'string' ? parseVersion(v) : null
    },
    async runInstaller(cli) {
      const r = await installProvider(cli)
      return r.state === 'installed' ? { ok: true } : { ok: false, detail: r.detail }
    },
    disabled(cli) {
      if (!opts.enabled() || process.env.UNMUTE_CLI_AUTOUPDATE === '0') return true
      if (cli !== 'claude') return false
      let settingsJson: string | null = null
      try { settingsJson = readFileSync(join(home, '.claude', 'settings.json'), 'utf8') } catch { /* none */ }
      return claudeAutoUpdateDisabled(process.env, settingsJson)
    },
    home,
    codexHome: process.env.CODEX_HOME,
  }
}

export interface CliUpdaterOptions {
  deps: CliUpdateDeps
  /** True while an agent turn is running — updates wait rather than swap a
   *  binary out from under a live task. */
  busy: () => boolean
  onResult: (result: CliUpdateResult) => void
  firstDelayMs?: number
  intervalMs?: number
  busyRetryMs?: number
  setTimer?: (fn: () => void, ms: number) => { unref?: () => void }
}

/** Runs updateCli for both CLIs shortly after launch and then periodically. */
export class CliUpdater {
  private running: Promise<CliUpdateResult[]> | null = null
  private readonly setTimer: NonNullable<CliUpdaterOptions['setTimer']>

  constructor(private readonly opts: CliUpdaterOptions) {
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  }

  /** The routine pass waits two minutes so it never competes with launch. That
   *  wait is skipped when no agent can run at all — nothing is installed, or
   *  what is installed is too old — because then every task would fail until
   *  it happens. Resolves once the urgent pass (if any) has finished. */
  async start(): Promise<void> {
    if (await this.urgent().catch(() => false)) {
      await this.runOnce()
      this.schedule(this.opts.intervalMs ?? 6 * 60 * 60_000)
      return
    }
    this.schedule(this.opts.firstDelayMs ?? 2 * 60_000)
  }

  private async urgent(): Promise<boolean> {
    const { deps } = this.opts
    let usable = false
    for (const cli of ['claude', 'codex'] as const) {
      const binary = await deps.resolveBinary(cli)
      if (!binary) continue
      const version = await installedVersion(deps, binary)
      // An unreadable version is not evidence of an old CLI; leave it be.
      if (!version || !belowMinimum(cli, version)) usable = true
    }
    return !usable
  }

  /** One pass over both CLIs, one at a time (both may share a Homebrew lock).
   *  Concurrent calls share the pass in flight. A missing CLI is installed only
   *  when NEITHER is on this Mac: someone who runs just Codex never had Claude
   *  Code put on their machine, and vice versa. */
  runOnce(): Promise<CliUpdateResult[]> {
    return this.running ??= (async () => {
      const results: CliUpdateResult[] = []
      const present = await Promise.all((['claude', 'codex'] as const).map((cli) => this.opts.deps.resolveBinary(cli).catch(() => null)))
      const installIfMissing = present.every((binary) => !binary)
      for (const cli of ['claude', 'codex'] as const) {
        const result = await updateCli(cli, this.opts.deps, { installIfMissing }).catch((error): CliUpdateResult =>
          ({ cli, state: 'unknown', detail: error instanceof Error ? error.message : String(error) }))
        results.push(result)
        this.opts.onResult(result)
      }
      return results
    })().finally(() => { this.running = null })
  }

  private schedule(ms: number): void {
    this.setTimer(() => void this.tick(), ms).unref?.()
  }

  private async tick(): Promise<void> {
    if (this.opts.busy()) { this.schedule(this.opts.busyRetryMs ?? 10 * 60_000); return }
    await this.runOnce()
    this.schedule(this.opts.intervalMs ?? 6 * 60 * 60_000)
  }
}
