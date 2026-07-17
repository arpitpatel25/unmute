// Computer Use v2 MCP bridge — the SAME pipe Claude Code already knows
// (127.0.0.1:42118, path /ax, registered as `computer`), now backed by
// embedded cua-driver children instead of the native-ax engine.
//
// THIN PASS-THROUGH (settled): the driver's tool surface IS the product.
// We forward initialize / tools/list / tools/call verbatim — no renaming,
// no filtering, no re-description, no result reshaping. Local logic is ONLY:
//   - master kill switch (policy.enabled, read live per call)
//   - Mcp-Session-Id assignment + routing (one driver child per session →
//     parallelism between Claude Code sessions)
//   - activity broadcast (menu-bar "something is being driven" affordance)
// Escalation hints (a result recommending delivery_mode:"foreground") flow
// through untouched — the AGENT decides, exactly as cua designed.
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { createLogger } from '../log'
import type { DriverManager } from './driver-manager'
import type { AxPolicy } from '../ax/policy'

const log = createLogger('cua-mcp')

export const CUA_MCP_PORT = 42118 // unchanged from v1 — existing registrations keep working
export const CUA_MCP_PATH = '/ax'
const PROTOCOL_VERSION = '2025-06-18'

export interface CuaServerDeps {
  manager: DriverManager
  /** Read live so UI toggles apply with no restart. Only .enabled is used. */
  getPolicy(): AxPolicy
  onActivity?(ev: { app?: string; tool: string; ok: boolean }): void
  port?: number
}

export interface CuaServer { close(): void; port: number }

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

export function startCuaServer(deps: CuaServerDeps): Promise<CuaServer> {
  const port = deps.port ?? CUA_MCP_PORT
  const server = http.createServer((req, res) => {
    void handleRequest(deps, req, res).catch((e) => {
      log.warn('cua request handler error', { error: (e as Error).message })
      try { res.writeHead(500).end() } catch { /* gone */ }
    })
  })
  return new Promise((resolve, reject) => {
    server.once('error', (e) => { log.warn('cua server failed to start', { port, error: (e as Error).message }); reject(e) })
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address()
      const boundPort = typeof addr === 'object' && addr ? addr.port : port
      log.event('cua-mcp-started', { port: boundPort })
      resolve({ close: () => server.close(), port: boundPort })
    })
  })
}

async function handleRequest(deps: CuaServerDeps, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!req.url || !req.url.startsWith(CUA_MCP_PATH)) { res.writeHead(404).end(); return }
  const sessionId = typeof req.headers['mcp-session-id'] === 'string' ? req.headers['mcp-session-id'] : undefined
  if (req.method === 'GET') { res.writeHead(405, { Allow: 'POST' }).end(); return }
  if (req.method === 'DELETE') {
    if (sessionId) deps.manager.endSession(sessionId)
    res.writeHead(200).end(); return
  }
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

  if (msg.id === undefined && msg.method?.startsWith('notifications/')) {
    // Each child got its own initialized during OUR handshake — client
    // notifications need no forwarding.
    res.writeHead(202).end(); return
  }

  const respond = (payload: string, extraHeaders: Record<string, string> = {}) =>
    res.writeHead(200, { 'Content-Type': 'application/json', ...extraHeaders }).end(payload)

  switch (msg.method) {
    case 'initialize': {
      // New MCP session: mint an id (streamable-HTTP convention) and forward
      // the DRIVER's initialize result verbatim (tool capabilities +
      // instructions are cua's — pass-through). Fallback only if the driver
      // can't start at all, so registration/handshake never hard-fails.
      const sid = randomUUID()
      let result: unknown
      try {
        result = await deps.manager.default().initResult
      } catch (e) {
        log.warn('driver init unavailable — fallback initialize', { error: (e as Error).message })
        result = {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'computer', version: '2.0.0' },
        }
      }
      respond(rpcResult(msg.id, result), { 'Mcp-Session-Id': sid })
      return
    }
    case 'ping':
      respond(rpcResult(msg.id, {})); return
    case 'tools/list': {
      try {
        const out = await deps.manager.forSession(sessionId).request('tools/list', msg.params ?? {})
        respond(rpcResult(msg.id, out))
      } catch (e) {
        respond(rpcError(msg.id, -32603, `cua-driver unavailable: ${(e as Error).message}`))
      }
      return
    }
    case 'tools/call': {
      const toolName = msg.params?.name as string | undefined
      if (!toolName) { respond(rpcError(msg.id, -32602, 'missing tool name')); return }
      if (!deps.getPolicy().enabled) {
        respond(rpcResult(msg.id, toolText('Computer Use is turned OFF in Unmute. Ask the user to enable it in Unmute settings → Computer Use.', true)))
        return
      }
      const app = typeof msg.params?.arguments?.app === 'string' ? msg.params.arguments.app : undefined
      try {
        const out: any = await deps.manager.forSession(sessionId).request('tools/call', msg.params)
        deps.onActivity?.({ app, tool: toolName, ok: out?.isError !== true })
        respond(rpcResult(msg.id, out))
      } catch (e) {
        deps.onActivity?.({ app, tool: toolName, ok: false })
        respond(rpcResult(msg.id, toolText(`${toolName} failed: ${(e as Error).message}`, true)))
      }
      return
    }
    default:
      respond(rpcError(msg.id, -32601, `method not found: ${msg.method}`)); return
  }
}
