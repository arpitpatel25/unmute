// Unmute MCP — the intercom. A minimal local MCP server (streamable HTTP,
// JSON-RPC over POST) that lets Claude Code sessions ask Unmute for things.
//
// THE PRINCIPLE (settled with the user): sessions may ADD work to the
// attention layer, never TOUCH it. The entire tool surface is two tools:
//   - unmute_create_task : spawn a peer task (lands on the wall as a card,
//     with provenance, through the exact same dispatch as a voice command)
//   - unmute_task_status : check on YOUR OWN children only
// Deliberately absent, forever-by-default: speak/notify (the status-file
// channel already rings the doorbell), send-input/answer (injecting into
// sessions is consent-violating), kill/remove (destruction is human-only),
// list-all/wall-reading (no snooping on unrelated work).
//
// AUTH = IDENTITY: every Unmute-spawned task gets a per-task bearer token in
// its environment (UNMUTE_MCP_TOKEN). The token identifies the CALLER TASK,
// which is what makes the guardrails enforceable: provenance (the card shows
// who spawned it), depth-1 (agent-spawned tasks may not spawn), and per-task
// rate caps. A request with no/unknown token can handshake and list tools,
// but tool CALLS are rejected with an instructive error.

import http from 'node:http'
import { createLogger } from './log'
import { HOOK_PATH } from './session-policy'
import { normalizeState } from './status-file'

const log = createLogger('mcp')

export const MCP_PORT = 42117
export const MCP_PATH = '/mcp'
const PROTOCOL_VERSION = '2025-06-18'

export interface McpCreateTaskInput {
  intent: string
  dir?: string
  name?: string
  kind?: 'oneoff' | 'session'
  fork_from_session_id?: string
}

export interface McpToolResultTask {
  task_id: string
  name?: string
  note?: string
}

export interface McpHandlers {
  /** Resolve a bearer token to the calling task id (null = unidentified). */
  resolveCaller(token: string | null): string | null
  /** Spawn a task on behalf of callerTaskId. Throw Error with a clear message
   *  to reject (depth, rate, disabled, bad dir) — the message reaches the model. */
  createTask(callerTaskId: string, input: McpCreateTaskInput): Promise<McpToolResultTask>
  /** Status of one of callerTaskId's own children. Throw to reject. */
  taskStatus(callerTaskId: string, taskId: string): Promise<Record<string, unknown>>
  /** OPTIONAL precision channel: the session states its own status instead of
   *  letting the observer infer it (unmute_status). Throw to reject. */
  setStatus?(callerTaskId: string, input: McpStatusInput): Promise<void>
  /** A lifecycle hook fired. `token` is the app-wide hook token, NOT a task
   *  token — hooks are wired by us, per session, and identity comes from the
   *  payload's own session_id. Must never throw; must return immediately. */
  hookEvent?(token: string | null, payload: unknown): void
}

/** The optional self-report. Every field is optional except `state`: the point
 *  is that a session says only what the observer could not have known. */
export interface McpStatusInput {
  state: 'processing' | 'needs-user' | 'done' | 'failed'
  summary?: string
  detail?: string
  question?: string
  artifacts?: Array<{ type: 'path' | 'url'; value: string }>
}

const TOOLS = [
  {
    name: 'unmute_create_task',
    description:
      'Create a new Unmute task: spawns a fresh Claude Code session that appears on the user\'s Unmute wall as a card, tracked like any voice-dispatched task. ' +
      'Use for delegating a sub-task or handing work to a successor session. The card shows it was agent-spawned. ' +
      'Optional fork_from_session_id starts the new session as a FORK of an existing Claude session (it inherits that conversation\'s context). ' +
      'Agent-created tasks cannot themselves create tasks (depth limit 1). Rate-limited.',
    inputSchema: {
      type: 'object',
      properties: {
        intent: { type: 'string', description: 'What the new task should do — a complete, self-contained instruction (the new session starts blank unless forked).' },
        dir: { type: 'string', description: 'Absolute path of the working directory (e.g. a repo). Omit for an isolated scratch directory.' },
        name: { type: 'string', description: 'Short display name (2-5 words) for the card.' },
        kind: { type: 'string', enum: ['oneoff', 'session'], description: 'oneoff = fire-and-forget errand (default); session = persistent working session.' },
        fork_from_session_id: { type: 'string', description: 'Claude Code session ID to fork from — the new session inherits that conversation\'s memory.' },
      },
      required: ['intent'],
    },
  },
  {
    name: 'unmute_task_status',
    description: 'Check the status of a task YOU created via unmute_create_task (state, result summary, any pending question). You can only see your own children.',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'string', description: 'The task_id returned by unmute_create_task.' } },
      required: ['task_id'],
    },
  },
  {
    // THE ESCAPE HATCH, NOT THE PROTOCOL. Unmute derives your state from your
    // final reply on its own, so this exists only for the handful of things
    // watching from outside cannot know exactly — the precise URL you landed
    // the user on, or the fact that you are blocked when your reply doesn't
    // read like a question. Deliberately worded to be OPTIONAL: making it feel
    // mandatory would rebuild, one tool call at a time, the reporting contract
    // this whole design deleted.
    name: 'unmute_status',
    description:
      'OPTIONAL. Unmute already reads your final reply and reports your progress for you — you do not need to call this, and most tasks never should. ' +
      'Use it only to state something Unmute could not infer: an exact URL you placed the user on, or that you are blocked when your reply does not read like a question.',
    inputSchema: {
      type: 'object',
      properties: {
        state: { type: 'string', enum: ['processing', 'needs-user', 'done', 'failed'], description: 'Where the task stands.' },
        summary: { type: 'string', description: 'One line. Omit to keep what Unmute derived from your reply.' },
        detail: { type: 'string', description: 'Full text. Omit to keep your reply itself, which is usually better.' },
        question: { type: 'string', description: 'What you need from the user (with state needs-user).' },
        artifacts: {
          type: 'array',
          description: 'Exact URLs or paths the result points at.',
          items: {
            type: 'object',
            properties: { type: { type: 'string', enum: ['path', 'url'] }, value: { type: 'string' } },
            required: ['type', 'value'],
          },
        },
      },
      required: ['state'],
    },
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

export interface McpServer {
  close(): void
  port: number
}

/** Start the local MCP server. Binds 127.0.0.1 only — this is a same-machine
 *  intercom, never a network service. */
export function startMcpServer(handlers: McpHandlers, port = MCP_PORT): Promise<McpServer> {
  const server = http.createServer((req, res) => {
    void handleRequest(handlers, req, res).catch((e) => {
      log.warn('mcp request handler error', { error: (e as Error).message })
      try { res.writeHead(500).end() } catch { /* already gone */ }
    })
  })
  return new Promise((resolve, reject) => {
    server.once('error', (e) => {
      log.warn('mcp server failed to start', { port, error: (e as Error).message })
      reject(e)
    })
    server.listen(port, '127.0.0.1', () => {
      log.event('mcp-server-started', { port })
      resolve({ close: () => server.close(), port })
    })
  })
}

/** Read a request body with the same 1 MB cap the MCP path uses. */
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, rejectP) => {
    let data = ''
    req.on('data', (c) => { data += c; if (data.length > 1_000_000) rejectP(new Error('body too large')) })
    req.on('end', () => resolve(data))
    req.on('error', rejectP)
  })
}

async function handleRequest(handlers: McpHandlers, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  // ── Hook lane (session-policy.ts). Claude Code lifecycle hooks curl their
  //    stdin JSON here. ANSWER FIRST, THINK AFTER: the hook is `async` so it
  //    never blocks a turn, but we still respond before doing any work so a
  //    slow Unmute can never become latency inside the user's session. A
  //    malformed body is a 200 too — a hook is telemetry, and arguing with it
  //    would only surface errors in the user's terminal.
  if (req.url && req.url.startsWith(HOOK_PATH)) {
    if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }).end(); return }
    const raw = await readBody(req).catch(() => '')
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}')
    if (!raw) return
    const auth = req.headers.authorization
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null
    let payload: unknown
    try { payload = JSON.parse(raw) } catch { return }
    try { handlers.hookEvent?.(token, payload) } catch (e) {
      log.warn('hook handler threw', { error: (e as Error).message })
    }
    return
  }
  if (!req.url || !req.url.startsWith(MCP_PATH)) { res.writeHead(404).end(); return }
  if (req.method === 'GET') { res.writeHead(405, { Allow: 'POST' }).end(); return } // no SSE stream — plain JSON responses
  if (req.method === 'DELETE') { res.writeHead(200).end(); return } // session teardown: stateless, nothing to do
  if (req.method !== 'POST') { res.writeHead(405).end(); return }

  const body = await readBody(req)

  let msg: JsonRpcReq
  try { msg = JSON.parse(body) } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' }).end(rpcError(null, -32700, 'parse error'))
    return
  }

  // Notifications (no id) get a 202 and no body, per streamable HTTP.
  if (msg.id === undefined && msg.method?.startsWith('notifications/')) {
    res.writeHead(202).end()
    return
  }

  const auth = req.headers.authorization
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null
  const caller = handlers.resolveCaller(token)

  const respond = (payload: string) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(payload)

  switch (msg.method) {
    case 'initialize':
      respond(rpcResult(msg.id, {
        protocolVersion: typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'unmute', version: '1.0.0' },
      }))
      return
    case 'ping':
      respond(rpcResult(msg.id, {}))
      return
    case 'tools/list':
      respond(rpcResult(msg.id, { tools: TOOLS }))
      return
    case 'tools/call': {
      const toolName = msg.params?.name as string | undefined
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>
      if (!caller) {
        // Unidentified callers can handshake but not act — the message teaches.
        respond(rpcResult(msg.id, toolText(
          'Unmute rejected this call: no valid task identity. Only sessions spawned by Unmute carry the per-task token (UNMUTE_MCP_TOKEN) required to create tasks.', true)))
        return
      }
      try {
        if (toolName === 'unmute_create_task') {
          const input = args as unknown as McpCreateTaskInput
          if (!input.intent || typeof input.intent !== 'string') throw new Error('intent (string) is required')
          const out = await handlers.createTask(caller, input)
          respond(rpcResult(msg.id, toolText(JSON.stringify(out))))
          return
        }
        if (toolName === 'unmute_task_status') {
          const tid = args.task_id
          if (!tid || typeof tid !== 'string') throw new Error('task_id (string) is required')
          const out = await handlers.taskStatus(caller, tid)
          respond(rpcResult(msg.id, toolText(JSON.stringify(out))))
          return
        }
        if (toolName === 'unmute_status') {
          if (!handlers.setStatus) throw new Error('status reporting is not available')
          let state = args.state
          // `ready` is still ACCEPTED on the wire and folded to `done`: an
          // agent may be working from a cached copy of the old tool schema, and
          // rejecting its status write would leave the task frozen mid-run over
          // a word. See normalizeState.
          state = normalizeState(state)
          if (typeof state !== 'string' || !['processing', 'needs-user', 'done', 'failed'].includes(state)) {
            throw new Error('state must be one of: processing, needs-user, ready, done, failed')
          }
          await handlers.setStatus(caller, {
            state: state as McpStatusInput['state'],
            ...(typeof args.summary === 'string' ? { summary: args.summary } : {}),
            ...(typeof args.detail === 'string' ? { detail: args.detail } : {}),
            ...(typeof args.question === 'string' ? { question: args.question } : {}),
            ...(Array.isArray(args.artifacts) ? { artifacts: args.artifacts as McpStatusInput['artifacts'] } : {}),
          })
          respond(rpcResult(msg.id, toolText('recorded')))
          return
        }
        respond(rpcError(msg.id, -32602, `unknown tool: ${toolName}`))
        return
      } catch (e) {
        respond(rpcResult(msg.id, toolText(`Unmute rejected this call: ${(e as Error).message}`, true)))
        return
      }
    }
    default:
      respond(rpcError(msg.id, -32601, `method not found: ${msg.method}`))
      return
  }
}
