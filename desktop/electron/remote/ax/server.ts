// ax-mcp — the Computer Use MCP server. A second local MCP server inside the
// Unmute main process (sibling of the "unmute" intercom in ../mcp-server.ts)
// that lets Claude Code drive macOS apps IN THE BACKGROUND via the Accessibility
// API — no stolen focus, no window hiding, no machine-wide lock.
//
// WHY in-process HTTP (not the brief's shim+socket): Unmute already runs an
// in-process HTTP MCP server that Claude registers via `claude mcp add-json`.
// Our AX engine (unmute-native-ax) runs in this SAME main process, which holds
// the Accessibility grant. So the cleanest shape is a second HTTP MCP server
// here — Claude Code in ANY terminal connects to the running Unmute over
// 127.0.0.1, and Unmute's single permission covers every call. That achieves
// the brief's goal (one permanent grant, enforcement + kill switch owned by
// Unmute) with nothing to sign or distribute separately. See
// docs/ax-mcp-implementation-shape.md.
//
// ENFORCEMENT lives here, not in config a user could forget:
//   - master toggle off  ⇒ every tool call refused (the kill switch).
//   - app not allowed     ⇒ refused, naming the policy.
//   - screenshots off     ⇒ capture_window refused, everything else works.
// The policy is read LIVE on every call (getPolicy()), so toggling in the UI
// takes effect with no restart.

import http from 'node:http'
import { createLogger } from '../log'
import { getAxBridge, type AxBridge, type AxMethod } from './ax-bridge'
import { isAppAllowed, type AxPolicy } from './policy'

const log = createLogger('ax-mcp')

export const AX_MCP_PORT = 42118 // one above the intercom (42117)
export const AX_MCP_PATH = '/ax'
const PROTOCOL_VERSION = '2025-06-18'

export interface AxServerDeps {
  /** Read the current policy live (so UI toggles apply without restart). */
  getPolicy(): AxPolicy
  /** Optional: report activity to the UI (menu-bar indicator). */
  onActivity?(ev: { app?: string; tool: string; ok: boolean }): void
  /** Injectable for tests. */
  bridge?: AxBridge
  port?: number
}

// ─── Tool catalog. Descriptions are written to STEER the model: prefer find,
// avoid get_tree, and note that nothing brings the app forward. ───
const TOOLS = [
  {
    name: 'list_apps',
    description:
      'List running apps you can control, with window counts. Call this FIRST to get exact app names. ' +
      'windowsHere = windows on the current Space (reachable); windowsAnywhere counts other Spaces too — ' +
      'an app with windowsHere=0 but windowsAnywhere>0 is parked on another Space and cannot be reached until the user moves it here.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'find',
    description:
      'Find UI elements in an app by label and/or role. PREFER THIS over get_tree — it keeps context small. ' +
      'Returns element ids to use with press/set_value. Runs in the background — does NOT bring the app forward. ' +
      'Element ids come from a live tree walk and CHANGE after any action; re-run find before the next step.',
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string', description: 'App name from list_apps (or its bundle id).' },
        label: { type: 'string', description: 'Case-insensitive substring of the element label.' },
        role: { type: 'string', description: 'AX role filter, e.g. AXButton, AXTextField.' },
      },
      required: ['app'],
    },
  },
  {
    name: 'get_tree',
    description:
      'Dump an app window\'s UI tree. NOISY and context-heavy — use find first; reach for this only when find isn\'t enough. Does not focus the app.',
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string' },
        window: { type: 'integer', description: 'Window index, default 0.' },
        roles: { type: 'string', description: 'Comma-separated role filter, e.g. "AXButton,AXTextField".' },
        max_depth: { type: 'integer' },
        all: { type: 'boolean', description: 'Include unlabeled wrapper nodes (very noisy).' },
      },
      required: ['app'],
    },
  },
  {
    name: 'press',
    description: 'Press (AXPress) an element by id from find/get_tree. Background — does NOT bring the app forward. Re-run find afterward; ids may have shifted.',
    inputSchema: { type: 'object', properties: { app: { type: 'string' }, id: { type: 'integer' } }, required: ['app', 'id'] },
  },
  {
    name: 'set_value',
    description: 'Set a text field\'s value by element id. Background, no focus change. If it fails, the field may need focus — fall back to menu_action or press.',
    inputSchema: { type: 'object', properties: { app: { type: 'string' }, id: { type: 'integer' }, text: { type: 'string' } }, required: ['app', 'id', 'text'] },
  },
  {
    name: 'type_text',
    description:
      'PREFERRED way to enter text into an app IN THE BACKGROUND — no focus steal, no keystrokes. You do NOT need an element id: it types into the app\'s currently-focused field, or the first text field/area it finds. Works on native apps AND Electron/Chromium apps (WhatsApp, Notion, Slack) via the accessibility bridge. Set replace=true to overwrite existing text, submit=true to press Enter/confirm after (e.g. to run a search or send a message). Use this instead of AppleScript keystrokes.',
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string' },
        text: { type: 'string' },
        replace: { type: 'boolean', description: 'Clear the field before typing (overwrite). Default false = insert at caret.' },
        submit: { type: 'boolean', description: 'Press Enter/confirm after typing (search, send). Default false.' },
      },
      required: ['app', 'text'],
    },
  },
  {
    name: 'fill_form',
    description: 'Set several fields at once: fields = {"12": "text", "15": "other"}. One round-trip instead of many.',
    inputSchema: { type: 'object', properties: { app: { type: 'string' }, fields: { type: 'object' } }, required: ['app', 'fields'] },
  },
  {
    name: 'menu_action',
    description: 'Click a menu-bar item by path, e.g. "File > Save". Often the CLEANEST way to drive an app — no element ids needed. Background.',
    inputSchema: { type: 'object', properties: { app: { type: 'string' }, path: { type: 'string' } }, required: ['app', 'path'] },
  },
  {
    name: 'capture_window',
    description:
      'Screenshot ONE app window (not the whole screen) so you can SEE it — to verify a result, read canvas/custom-drawn UI the tree can\'t express, or spot a visual bug. Does not bring the app forward. Requires Screen Recording permission.',
    inputSchema: { type: 'object', properties: { app: { type: 'string' } }, required: ['app'] },
  },
] as const

type JsonRpcReq = { jsonrpc: '2.0'; id?: number | string | null; method: string; params?: any }

function rpcResult(id: number | string | null | undefined, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result })
}
function rpcError(id: number | string | null | undefined, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } })
}
function toolText(text: string, isError = false) {
  return { content: [{ type: 'text', text }], isError }
}
function toolImage(text: string, b64: string) {
  return { content: [{ type: 'text', text }, { type: 'image', data: b64, mimeType: 'image/png' }], isError: false }
}

export interface AxServer { close(): void; port: number }

/** The app name argument as the model passed it. */
function appArg(args: Record<string, unknown>): string {
  return typeof args.app === 'string' ? args.app : ''
}

/**
 * Run one tool call: enforce policy, dispatch to the AX bridge, shape an MCP
 * result. Exported for direct unit testing (no HTTP needed).
 */
export async function handleAxTool(
  deps: AxServerDeps,
  bridge: AxBridge,
  name: string,
  args: Record<string, unknown>,
): Promise<ReturnType<typeof toolText> | ReturnType<typeof toolImage>> {
  const policy = deps.getPolicy()

  if (!policy.enabled) {
    return toolText('Computer Use is turned OFF in Unmute. Ask the user to enable it in Unmute settings → Computer Use.', true)
  }

  // list_apps needs no app arg and leaks nothing actionable — but we still
  // annotate which apps are allowed so the model doesn't try a blocked one.
  if (name === 'list_apps') {
    try {
      const apps = (await bridge.call('listApps', [])) as Array<{ name: string; bundleId: string; pid: number; windowsHere: number; windowsAnywhere: number }>
      const lines = apps.map((a) => {
        const allowed = isAppAllowed(policy, a.name, a.bundleId)
        const space = a.windowsHere === 0 && a.windowsAnywhere > 0 ? '  [on another Space — unreachable]' : ''
        const block = allowed ? '' : '  [NOT ALLOWED]'
        return `${a.name}  (${a.bundleId})  windows=${a.windowsHere}${space}${block}`
      })
      lines.push('\nNotes: control runs in the BACKGROUND — nothing is brought to the front. Apps on other macOS Spaces are unreachable until moved to the current Space.')
      if (!policy.allowAll) lines.push(`Allowlist is active — only: ${policy.allowed.join(', ') || '(none)'}.`)
      deps.onActivity?.({ tool: name, ok: true })
      return toolText(lines.join('\n'))
    } catch (e) {
      return toolText(`list_apps failed: ${(e as Error).message}`, true)
    }
  }

  const app = appArg(args)
  if (!app) return toolText("missing 'app' argument", true)

  // Allowlist enforcement. We resolve the app's real name+bundle via the
  // bridge only when a restriction is active (allowAll short-circuits).
  if (!policy.allowAll) {
    // Cheap path: the arg itself might be an allowed name/bundle. Otherwise
    // confirm against the running app's identity.
    let allowed = isAppAllowed(policy, app)
    if (!allowed) {
      try {
        const apps = (await bridge.call('listApps', [])) as Array<{ name: string; bundleId: string }>
        const hit = apps.find((a) => a.name.toLowerCase() === app.toLowerCase() || a.bundleId.toLowerCase() === app.toLowerCase())
        if (hit) allowed = isAppAllowed(policy, hit.name, hit.bundleId)
      } catch { /* fall through to refusal */ }
    }
    if (!allowed) {
      deps.onActivity?.({ app, tool: name, ok: false })
      return toolText(`'${app}' is not in the Computer Use allowlist. The user can add it in Unmute settings, or switch to allow-all.`, true)
    }
  }

  if (name === 'capture_window' && !policy.screenshotEnabled) {
    return toolText('Screenshots are turned off for Computer Use. Ask the user to enable the screenshot toggle in Unmute settings.', true)
  }

  try {
    let out: any
    let result: ReturnType<typeof toolText> | ReturnType<typeof toolImage>
    switch (name) {
      case 'find':
        out = await bridge.call('find', [app, args.label ?? '', args.role ?? ''])
        result = out.error ? toolText(out.error, true) : toolText(formatFind(out))
        break
      case 'get_tree':
        out = await bridge.call('getTree', [app, args.window ?? 0, args.roles ?? '', args.max_depth ?? 14, args.all === true])
        result = out.error ? toolText(out.error, true) : toolText(formatTree(out))
        break
      case 'press':
        out = await bridge.call('press', [app, args.id])
        result = out.error
          ? toolText(out.error, true)
          : toolText(`pressed ${out.role} "${out.label}" — the app was NOT brought to front. Element ids may have changed; re-run find before the next action.`)
        break
      case 'set_value':
        out = await bridge.call('setValue', [app, args.id, args.text ?? ''])
        result = out.error ? toolText(out.error, true) : toolText(`set ${out.role} "${out.label}" = "${args.text ?? ''}"`)
        break
      case 'type_text':
        out = await bridge.call('typeText', [app, args.text ?? '', args.replace === true, args.submit === true])
        result = out.error
          ? toolText(out.error, true)
          : toolText(`typed into ${out.target || 'field'} (background, no focus change)${args.submit === true ? ' + submitted' : ''}: "${args.text ?? ''}"`)
        break
      case 'fill_form':
        out = await bridge.call('fillForm', [app, args.fields ?? {}])
        result = out.error ? toolText(out.error, true) : toolText((out.results as any[]).map((r) => `${r.id} (${r.label ?? ''}): ${r.ok ? 'ok' : 'failed — ' + (r.error ?? '')}`).join('\n'))
        break
      case 'menu_action':
        out = await bridge.call('menuAction', [app, args.path ?? ''])
        result = out.ok ? toolText(`menu: ${args.path} — done (background).`) : toolText(out.error ?? 'menu action failed', true)
        break
      case 'capture_window':
        out = await bridge.call('captureWindow', [app, 1400])
        result = out.error
          ? toolText(out.error, true)
          : toolImage(`${app} window (captured in the background — app not brought to front) ${out.width}x${out.height}`, out.base64)
        break
      default:
        return toolText(`unknown tool: ${name}`, true)
    }
    deps.onActivity?.({ app, tool: name, ok: !(result as any).isError })
    return result
  } catch (e) {
    deps.onActivity?.({ app, tool: name, ok: false })
    return toolText(`${name} failed: ${(e as Error).message}`, true)
  }
}

function formatFind(out: { app: string; nodes: Array<{ id: number; role: string; label: string; actions: string[] }>; total: number }): string {
  if (!out.nodes.length) return `no matches (${out.total} nodes scanned). Try a different label/role, or capture_window to look.`
  const lines = out.nodes.map((n) => `id=${n.id}  ${n.role}  "${n.label}"${n.actions.length ? '  actions=' + n.actions.join(',') : ''}`)
  return lines.join('\n')
}

function formatTree(out: { app: string; window: string; nodes: Array<{ id: number; depth: number; role: string; label: string; actions: string[] }> }): string {
  const lines = [`window: "${out.window}"`]
  for (const n of out.nodes) {
    const pad = '  '.repeat(n.depth)
    const acts = n.actions.length ? `  [${n.actions.join(',')}]` : ''
    lines.push(`${n.id}\t${pad}${n.role}  "${n.label}"${acts}`)
  }
  return lines.join('\n')
}

/** Start the ax-mcp HTTP server. Binds 127.0.0.1 only — same-machine, never
 *  a network service. */
export function startAxServer(deps: AxServerDeps): Promise<AxServer> {
  const bridge = deps.bridge ?? getAxBridge()
  const port = deps.port ?? AX_MCP_PORT
  const server = http.createServer((req, res) => {
    void handleRequest(deps, bridge, req, res).catch((e) => {
      log.warn('ax request handler error', { error: (e as Error).message })
      try { res.writeHead(500).end() } catch { /* gone */ }
    })
  })
  return new Promise((resolve, reject) => {
    server.once('error', (e) => { log.warn('ax server failed to start', { port, error: (e as Error).message }); reject(e) })
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address()
      const boundPort = typeof addr === 'object' && addr ? addr.port : port
      log.event('ax-mcp-started', { port: boundPort })
      resolve({ close: () => server.close(), port: boundPort })
    })
  })
}

async function handleRequest(deps: AxServerDeps, bridge: AxBridge, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!req.url || !req.url.startsWith(AX_MCP_PATH)) { res.writeHead(404).end(); return }
  if (req.method === 'GET') { res.writeHead(405, { Allow: 'POST' }).end(); return }
  if (req.method === 'DELETE') { res.writeHead(200).end(); return }
  if (req.method !== 'POST') { res.writeHead(405).end(); return }

  const body = await new Promise<string>((resolve, rejectP) => {
    let data = ''
    req.on('data', (c) => { data += c; if (data.length > 8_000_000) rejectP(new Error('body too large')) })
    req.on('end', () => resolve(data))
    req.on('error', rejectP)
  })

  let msg: JsonRpcReq
  try { msg = JSON.parse(body) } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' }).end(rpcError(null, -32700, 'parse error')); return
  }

  if (msg.id === undefined && msg.method?.startsWith('notifications/')) { res.writeHead(202).end(); return }
  const respond = (payload: string) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(payload)

  switch (msg.method) {
    case 'initialize':
      respond(rpcResult(msg.id, {
        protocolVersion: typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'ax-mcp', version: '1.0.0' },
      }))
      return
    case 'ping':
      respond(rpcResult(msg.id, {})); return
    case 'tools/list':
      respond(rpcResult(msg.id, { tools: TOOLS })); return
    case 'tools/call': {
      const toolName = msg.params?.name as string | undefined
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>
      if (!toolName) { respond(rpcError(msg.id, -32602, 'missing tool name')); return }
      const result = await handleAxTool(deps, bridge, toolName, args)
      respond(rpcResult(msg.id, result))
      return
    }
    default:
      respond(rpcError(msg.id, -32601, `method not found: ${msg.method}`)); return
  }
}
