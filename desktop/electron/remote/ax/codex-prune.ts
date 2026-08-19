// Removing Unmute's computer-use from Codex, over and over, because something
// else keeps putting it back.
//
// WHAT HAPPENS. Unmute registers `unmute-computer` with Claude Code — see
// register.ts, which shells out to the `claude` CLI and writes CLAUDE.md.
// Nothing here ever targeted Codex. But the ChatGPT desktop app offers to
// import an existing Claude setup, and that import copies the WHOLE config:
// every MCP server, plus CLAUDE.md into ~/.codex/AGENTS.md. Observed 19 August:
// deleting both by hand, then pressing Connect in Unmute's settings, restored
// them within thirty seconds — MCP entries and steer block together, alongside
// unrelated servers Unmute has never heard of.
//
// So Codex ends up holding a server we registered for a different agent, and a
// steer telling it to prefer those tools over its own. Its own computer-use had
// been switched off. That is not a state anyone chose.
//
// WHY REMOVAL AND NOT PREVENTION. The importer is another app's feature, on
// another app's schedule. Unmute cannot stop it and should not try. It can
// clean up after it, on every startup, for the one entry it can prove is its
// own.
//
// SCOPE, DELIBERATELY NARROW. This removes `unmute-computer` and the steer
// block Unmute authored. It does NOT touch:
//   * `cua-computer-use` — the user installed CuaDriver.app themselves; it is
//     theirs, whatever it is called and however it got here.
//   * `[mcp_servers.unmute]` — the task bridge. A Codex task Unmute dispatched
//     reports back through it, so removing it would break the feature.
//   * anything else in the file. We rewrite one section and one marked block.
//
// FAIL-OPEN, ALWAYS. A missing file, an unreadable one, a section that does not
// look like ours: leave it alone and say so. This runs on the startup path of
// an app whose job is dictation, and no cleanup is worth breaking that.

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createLogger } from '../log'

const log = createLogger('codex-prune')

/** The server name Unmute registers with Claude Code. Ours, unambiguously. */
const SERVER = 'unmute-computer'
/** Markers register.ts writes around the CLAUDE.md steer. */
const STEER_BEGIN = '<!-- UNMUTE-COMPUTER-USE:BEGIN -->'
const STEER_END = '<!-- UNMUTE-COMPUTER-USE:END -->'
/** The ax endpoint. A section not pointing here is not the one we wrote. */
const AX_ENDPOINT = '/ax'

function codexHome(home = homedir()): string { return join(home, '.codex') }

/**
 * Strip `[mcp_servers.unmute-computer]` from a Codex config.
 *
 * Returns the original text unchanged when the section is absent, or when it
 * does not point at our endpoint — a user who hand-wrote something under our
 * name meant it, and silently deleting it would be the same class of surprise
 * this function exists to undo.
 */
export function removeUnmuteComputerServer(toml: string): { text: string; removed: boolean } {
  const header = `[mcp_servers.${SERVER}]`
  const start = toml.indexOf(header)
  if (start < 0) return { text: toml, removed: false }
  // Only at the start of a line: `[mcp_servers.unmute-computer-extra]` and a
  // commented-out copy must both be left alone.
  if (start > 0 && toml[start - 1] !== '\n') return { text: toml, removed: false }

  // The section runs to the next line-initial '[' or to the end of the file.
  let end = toml.length
  for (let i = start + header.length; i < toml.length; i++) {
    if (toml[i] === '[' && toml[i - 1] === '\n') { end = i; break }
  }

  const body = toml.slice(start, end)
  if (!body.includes(AX_ENDPOINT)) {
    log.warn('left a [mcp_servers.unmute-computer] that is not ours', { body: body.length })
    return { text: toml, removed: false }
  }
  return { text: toml.slice(0, start) + toml.slice(end), removed: true }
}

/** Strip the steer block Unmute authored, leaving anything the user added. */
export function removeSteerBlock(markdown: string): { text: string; removed: boolean } {
  const start = markdown.indexOf(STEER_BEGIN)
  const end = markdown.indexOf(STEER_END)
  if (start < 0 || end < start) return { text: markdown, removed: false }
  const rest = (markdown.slice(0, start) + markdown.slice(end + STEER_END.length)).trim()
  return { text: rest ? rest + '\n' : '', removed: true }
}

async function rewriteIfChanged(
  path: string,
  transform: (text: string) => { text: string; removed: boolean },
  what: string,
): Promise<boolean> {
  let before: string
  try {
    before = await fs.readFile(path, 'utf8')
  } catch {
    return false // absent is the desired state
  }
  const { text, removed } = transform(before)
  if (!removed) return false
  // Written through a temp file in the same directory: a half-written
  // config.toml would break every Codex session on the machine, which is a far
  // worse outcome than the entry we are removing.
  const tmp = `${path}.unmute-prune.tmp`
  try {
    await fs.writeFile(tmp, text, { mode: 0o600 })
    await fs.rename(tmp, path)
    log.event('codex-prune', { what, path, bytesBefore: before.length, bytesAfter: text.length })
    return true
  } catch (error) {
    try { await fs.unlink(tmp) } catch { /* nothing staged */ }
    log.warn('could not rewrite', { what, error: String(error) })
    return false
  }
}

/**
 * Take Unmute's computer-use back out of Codex.
 *
 * Runs unconditionally — NOT gated on the computer-use toggle. The toggle says
 * whether Claude Code should have these tools; it has never said anything about
 * Codex, and `unmute-computer` should not be in Codex's config in either
 * position.
 */
export async function pruneUnmuteFromCodex(home = homedir()): Promise<void> {
  const dir = codexHome(home)
  try {
    const server = await rewriteIfChanged(
      join(dir, 'config.toml'), removeUnmuteComputerServer, 'mcp-server')
    const steer = await rewriteIfChanged(
      join(dir, 'AGENTS.md'), removeSteerBlock, 'steer-block')
    if (server || steer) {
      log.event('codex-prune-applied', { server, steer })
    }
  } catch (error) {
    // Codex may not be installed at all. Nothing here is worth a stack trace on
    // the startup path.
    log.warn('codex prune skipped', { error: String(error) })
  }
}

/**
 * The same removal, repeated over a short window.
 *
 * WHY ONCE IS NOT ENOUGH. The import does not happen while Connect is running;
 * it happens when the ChatGPT app comes up, which is AFTER the call returns.
 * Measured 19 August: the connect attempt failed at 11:59:51 and config.toml
 * was rewritten at 12:00:05 — fourteen seconds later. A single prune fired on
 * completion would have run before there was anything to remove, and the entry
 * would then have survived until the next launch, which is the whole gap this
 * closes.
 *
 * A few cheap passes over a minute rather than a file watcher: this reads two
 * small files and usually changes nothing, and a watcher on another app's
 * config is a lot of machinery — and another thing to leak — for a case that
 * happens when a person presses a button.
 */
export const CONNECT_SWEEP_DELAYS_MS = [1_000, 5_000, 15_000, 30_000, 60_000] as const

export function sweepUnmuteFromCodexAfterConnect(
  home = homedir(),
  schedule: (fn: () => void, ms: number) => unknown = setTimeout,
): void {
  for (const delay of CONNECT_SWEEP_DELAYS_MS) {
    const timer = schedule(() => { void pruneUnmuteFromCodex(home) }, delay)
    // Never hold the process open for a cleanup pass.
    ;(timer as { unref?: () => void })?.unref?.()
  }
}
