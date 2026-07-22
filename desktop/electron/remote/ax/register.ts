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
import { promisify } from 'node:util'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createLogger } from '../log'
import { CUA_MCP_PORT as AX_MCP_PORT, CUA_MCP_PATH as AX_MCP_PATH } from '../cua/server'

const log = createLogger('ax-register')
const execFileP = promisify(execFile)

// `claude mcp get <name>` → its stdout if registered, else null. Every `claude
// mcp` invocation writes ~/.claude.json, so these MUST run serially (see
// applyAxRegistration): two concurrent ones clobber each other's write, which
// is exactly how the rename migration silently failed to remove the old entry.
async function mcpGet(name: string): Promise<string | null> {
  try { return (await execFileP('claude', ['mcp', 'get', name], { timeout: 10_000 })).stdout }
  catch { return null }
}

// The MCP server name Claude Code sees. Prefixed with `unmute-` so it's
// unambiguously OURS: it can't collide with Claude Code's built-in
// `computer-use`, nor with any other computer-use MCP the user installs, and
// it reads as Unmute's in the /mcp list. Pairs with the `unmute` task MCP.
export const AX_MCP_NAME = 'unmute-computer'
// The pre-rename name. We remove it on migration so upgraded installs don't
// keep a dead/duplicate `computer` entry pointing at our bridge.
export const LEGACY_MCP_NAME = 'computer'

const STEER_BEGIN = '<!-- UNMUTE-COMPUTER-USE:BEGIN -->'
const STEER_END = '<!-- UNMUTE-COMPUTER-USE:END -->'
// Exported (test-only) so register.test.ts can assert on lane guidance without
// re-duplicating the literal strings.
export const STEER_BODY =
  'For GUI tasks that touch a desktop app (Notion, WhatsApp, Slack, Notes, Mail, any Mac app), ' +
  'PREFER the `unmute-computer` MCP tools (list_apps, get_window_state, click, type_text, press_key, set_value). ' +
  'They operate apps in the BACKGROUND without stealing focus or moving the user\'s windows or cursor. ' +
  'If a result reports an escalation recommending foreground, re-call that tool with delivery_mode:"foreground". ' +
  'Do NOT reach for built-in computer-use / screen control unless the `unmute-computer` tools genuinely cannot do it — ' +
  'screen control brings apps to the front and interrupts the user. ' +
  'Lane guide: for a browser or Electron app (Notion, Slack, VS Code, Chrome, any website): `web_arm` the app once, ' +
  'then drive it with `web_eval` (scroll = set the scroller\'s scrollTop; click = el.click(); read the DOM), ' +
  '`web_type` (types via real key events — use it, not web_eval, to enter text into editors), and `web_screenshot`. ' +
  'For scriptable native apps (Notes, Mail, Calendar): `run_applescript`. ' +
  'For everything else: the `get_window_state`/`click`/`type_text`/`scroll` tools (they need the app on the current Space). ' +
  'New CDP verbs (after web_arm): web_click(x,y) for a trusted click when el.click() doesn\'t fire or for canvas; web_key for ' +
  'Enter/Escape/Tab/shortcuts; plus web_drag, web_scroll, web_navigate, web_wait, web_targets, web_click_text. ' +
  'If web_arm ERRORS (e.g. ARM_QUIT_FAILED — the app wouldn\'t quit to relaunch with the debug port), do NOT retry web_* — drive ' +
  'that app with the cua tools (get_window_state/click/type_text/scroll) instead.'

function claudeMdPath(home = homedir()): string { return join(home, '.claude', 'CLAUDE.md') }
function claudeConfigPath(home = homedir()): string { return join(home, '.claude.json') }

/** Register (idempotent) the ax-mcp server in Claude's user-scope config. */
export async function registerAxServer(port = AX_MCP_PORT): Promise<void> {
  if (await mcpGet(AX_MCP_NAME)) return // already registered
  const cfg = JSON.stringify({ type: 'http', url: `http://127.0.0.1:${port}${AX_MCP_PATH}` })
  try {
    await execFileP('claude', ['mcp', 'add-json', AX_MCP_NAME, cfg, '--scope', 'user'], { timeout: 15_000 })
    log.event('ax-registered-user-scope', { port })
  } catch (e) {
    log.warn('ax registration failed', { error: String((e as any).stderr || (e as Error).message) })
  }
}

/** One-time migration from the old `computer` name to `unmute-computer`.
 *  Removes the legacy registration ONLY if it points at our bridge (so we never
 *  delete an unrelated `computer` MCP the user set up themselves). */
export async function migrateLegacyRegistration(port = AX_MCP_PORT): Promise<void> {
  const out = await mcpGet(LEGACY_MCP_NAME)
  if (!out) return // not registered → nothing to migrate
  const isOurs = out.includes(`127.0.0.1:${port}${AX_MCP_PATH}`) || out.includes(`:${port}${AX_MCP_PATH}`)
  if (!isOurs) return // a different `computer` server — leave it alone
  try {
    await execFileP('claude', ['mcp', 'remove', LEGACY_MCP_NAME, '--scope', 'user'], { timeout: 10_000 })
    log.event('ax-legacy-computer-removed', {})
  } catch (e) {
    const msg = String((e as any).stderr || (e as Error).message)
    if (!msg.includes('not found')) log.warn('legacy computer removal failed', { error: msg })
  }
}

/** Remove the ax-mcp server registration (toggle off). */
export async function unregisterAxServer(): Promise<void> {
  try {
    await execFileP('claude', ['mcp', 'remove', AX_MCP_NAME, '--scope', 'user'], { timeout: 10_000 })
    log.event('ax-unregistered', {})
  } catch (e) {
    const msg = String((e as any).stderr || (e as Error).message)
    if (!msg.includes('not found')) log.warn('ax unregister failed', { error: msg })
  }
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

/** Pure helper (exported for tests): strip `names` from every project's
 *  `disabledMcpServers` list (and the top-level `disabledMcpjsonServers`) in a
 *  parsed ~/.claude.json object. Returns whether anything actually changed —
 *  callers write back only on change, so the common "nothing disabled" path
 *  never rewrites the file (no clobber risk against Claude Code's own writes). */
export function pruneDisabledServers(config: any, names: string[]): { changed: boolean } {
  const kill = new Set(names)
  let changed = false
  const prune = (arr: unknown): unknown => {
    if (!Array.isArray(arr)) return arr
    const next = arr.filter((n) => !kill.has(n as string))
    if (next.length !== arr.length) changed = true
    return next
  }
  const projects = config?.projects
  if (projects && typeof projects === 'object') {
    for (const key of Object.keys(projects)) {
      const proj = projects[key]
      if (proj && typeof proj === 'object' && Array.isArray(proj.disabledMcpServers)) {
        proj.disabledMcpServers = prune(proj.disabledMcpServers)
      }
    }
  }
  if (Array.isArray(config?.disabledMcpjsonServers)) {
    config.disabledMcpjsonServers = prune(config.disabledMcpjsonServers)
  }
  return { changed }
}

/** Make Unmute's toggle authoritative: whenever Computer Use is ON, ensure our
 *  MCP is not sitting in any project's `disabledMcpServers` (which Unmute's
 *  toggle otherwise can't override — Claude Code has no enable/disable CLI).
 *  Best-effort, atomic, and a no-op when nothing is disabled. */
export async function ensureNotDisabled(names: string[], home = homedir()): Promise<void> {
  const path = claudeConfigPath(home)
  try {
    const raw = await fs.readFile(path, 'utf-8')
    const config = JSON.parse(raw)
    const { changed } = pruneDisabledServers(config, names)
    if (!changed) return // common path — never rewrite, no race with Claude Code
    const tmp = `${path}.unmute-${process.pid}.tmp`
    await fs.writeFile(tmp, JSON.stringify(config, null, 2))
    await fs.rename(tmp, path) // atomic swap
    log.event('ax-cleared-disabled-flag', { names })
  } catch (e) {
    log.warn('ensureNotDisabled failed', { error: (e as Error).message })
  }
}

/** Apply the whole registration state for a given enabled flag. Every step is
 *  awaited in sequence: the `claude mcp` calls each rewrite ~/.claude.json, so
 *  running them concurrently clobbers writes (the bug that left both `computer`
 *  and `unmute-computer` registered). Serial = deterministic. */
export async function applyAxRegistration(enabled: boolean, port = AX_MCP_PORT): Promise<void> {
  if (enabled) {
    await migrateLegacyRegistration(port)
    await registerAxServer(port)
    await ensureNotDisabled([AX_MCP_NAME, LEGACY_MCP_NAME])
    await addSteer()
  } else {
    await unregisterAxServer()
    await removeSteer()
  }
}
