// ax-mcp registration — wires the server into Claude Code so it's PREFERRED
// over the built-in computer-use, and steers the model toward it.
//
// Two side effects, both idempotent and both reversible when the toggle flips off:
//   1. Register the ax-mcp HTTP server in the user's Claude config (user scope
//      ⇒ every project). Claude Code's tool routing prefers an MCP server over
//      screen control, so once ax-mcp is present it reaches for these tools
//      first — and only falls back to the built-in mouse computer-use for the
//      rare thing AX genuinely can't do (our deliberate safety net; we do NOT
//      disable the built-in).
//   2. Append a one-line steer to ~/.claude/CLAUDE.md so the model actively
//      prefers background control and doesn't reach for focus-stealing screen
//      control. Belt-and-braces on top of the routing priority.

import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createLogger } from '../log'
import { CUA_MCP_PORT as AX_MCP_PORT, CUA_MCP_PATH as AX_MCP_PATH } from '../cua/server'

const log = createLogger('ax-register')

export const AX_MCP_NAME = 'computer'

const STEER_BEGIN = '<!-- UNMUTE-COMPUTER-USE:BEGIN -->'
const STEER_END = '<!-- UNMUTE-COMPUTER-USE:END -->'
const STEER_BODY =
  'For GUI tasks that touch a desktop app (Notion, WhatsApp, Slack, Notes, Mail, any Mac app), ' +
  'PREFER the `computer` MCP tools (list_apps, get_window_state, click, type_text, press_key, set_value). ' +
  'They operate apps in the BACKGROUND without stealing focus or moving the user\'s windows or cursor. ' +
  'If a result reports an escalation recommending foreground, re-call that tool with delivery_mode:"foreground". ' +
  'Do NOT reach for built-in computer-use / screen control unless the `computer` tools genuinely cannot do it — ' +
  'screen control brings apps to the front and interrupts the user.'

function claudeMdPath(home = homedir()): string { return join(home, '.claude', 'CLAUDE.md') }

/** Register (idempotent) the ax-mcp server in Claude's user-scope config. */
export function registerAxServer(port = AX_MCP_PORT): void {
  execFile('claude', ['mcp', 'get', AX_MCP_NAME], { timeout: 10_000 }, (err) => {
    if (!err) return // already registered
    const cfg = JSON.stringify({ type: 'http', url: `http://127.0.0.1:${port}${AX_MCP_PATH}` })
    execFile('claude', ['mcp', 'add-json', AX_MCP_NAME, cfg, '--scope', 'user'], { timeout: 15_000 }, (e2, _o, stderr2) => {
      if (e2) log.warn('ax registration failed', { error: String(stderr2 || e2.message) })
      else log.event('ax-registered-user-scope', { port })
    })
  })
}

/** Remove the ax-mcp server registration (toggle off). */
export function unregisterAxServer(): void {
  execFile('claude', ['mcp', 'remove', AX_MCP_NAME, '--scope', 'user'], { timeout: 10_000 }, (err, _o, stderr) => {
    if (err && !String(stderr).includes('not found')) log.warn('ax unregister failed', { error: String(stderr || err.message) })
    else log.event('ax-unregistered', {})
  })
}

/** Append (or refresh) the CLAUDE.md steer block. Idempotent — replaces any
 *  existing block between the markers. */
export async function addSteer(home = homedir()): Promise<void> {
  const path = claudeMdPath(home)
  const block = `${STEER_BEGIN}\n${STEER_BODY}\n${STEER_END}`
  try {
    await fs.mkdir(join(home, '.claude'), { recursive: true })
    let content = ''
    try { content = await fs.readFile(path, 'utf-8') } catch { /* new file */ }
    const stripped = removeBlock(content)
    const next = stripped.trimEnd() + (stripped.trim() ? '\n\n' : '') + block + '\n'
    await fs.writeFile(path, next)
    log.event('ax-steer-added', {})
  } catch (e) {
    log.warn('ax steer add failed', { error: (e as Error).message })
  }
}

/** Remove the CLAUDE.md steer block (toggle off). */
export async function removeSteer(home = homedir()): Promise<void> {
  const path = claudeMdPath(home)
  try {
    let content = ''
    try { content = await fs.readFile(path, 'utf-8') } catch { return }
    const next = removeBlock(content).trimEnd()
    await fs.writeFile(path, next ? next + '\n' : '')
    log.event('ax-steer-removed', {})
  } catch (e) {
    log.warn('ax steer remove failed', { error: (e as Error).message })
  }
}

/** Pure helper (exported for tests): strip the steer block from CLAUDE.md text. */
export function removeBlock(content: string): string {
  const start = content.indexOf(STEER_BEGIN)
  if (start === -1) return content
  const end = content.indexOf(STEER_END)
  if (end === -1) return content.slice(0, start) // truncated block — drop the tail
  return content.slice(0, start) + content.slice(end + STEER_END.length)
}

/** Apply the whole registration state for a given enabled flag. */
export async function applyAxRegistration(enabled: boolean, port = AX_MCP_PORT): Promise<void> {
  if (enabled) { registerAxServer(port); await addSteer() }
  else { unregisterAxServer(); await removeSteer() }
}
