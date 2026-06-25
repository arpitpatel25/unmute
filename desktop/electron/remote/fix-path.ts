// Unmute Remote — fix the PATH for the packaged (Finder/Dock-launched) app.
//
// macOS apps launched from Finder/Dock inherit a MINIMAL PATH (roughly
// /usr/bin:/bin:/usr/sbin:/sbin) — it does NOT include ~/.local/bin,
// /opt/homebrew/bin, /usr/local/bin, etc. So user CLIs like `claude` (in
// ~/.local/bin) aren't found, the Remote session can't spawn the agent, and the
// task dies at 0s with "[exited]". In dev this never shows because the app is
// launched from a terminal that already has the full shell PATH.
//
// Fix: capture the user's REAL login-shell PATH once at startup and merge it
// into process.env.PATH. Remote sessions spawn with env: process.env, so every
// Claude session (and any command a task runs) then resolves correctly. Static
// fallback covers a failed shell probe.

import { execSync } from 'node:child_process'
import { createLogger } from './log'

const log = createLogger('fix-path')
let fixed = false

export function fixPath(): void {
  if (fixed) return
  fixed = true

  const before = process.env.PATH || ''

  // 1) Best source: the user's interactive login shell PATH (sources .zshrc /
  //    .zprofile, so it has nvm, pyenv, ~/.local/bin, Homebrew, etc.).
  try {
    const shell = process.env.SHELL || '/bin/zsh'
    const out = execSync(`${shell} -ilc 'printf "%s" "$PATH"'`, {
      timeout: 5000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (out.includes('/')) {
      const merged = [...out.split(':'), ...before.split(':')].filter(Boolean)
      process.env.PATH = Array.from(new Set(merged)).join(':')
    }
  } catch {
    /* fall through to the static fallback below */
  }

  // 2) Always guarantee the common CLI dirs are present (covers a failed probe).
  const home = process.env.HOME || ''
  const common = [
    home ? `${home}/.local/bin` : '',
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ].filter(Boolean)
  const have = new Set((process.env.PATH || '').split(':').filter(Boolean))
  const missing = common.filter((d) => !have.has(d))
  if (missing.length) process.env.PATH = [process.env.PATH || '', ...missing].filter(Boolean).join(':')

  if (process.env.PATH !== before) {
    log.event('path-fixed', { hadLocalBin: have.has(`${home}/.local/bin`) })
  }
}
