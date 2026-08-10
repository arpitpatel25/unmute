/**
 * CODEX CLI — the App Server connection.
 *
 * Codex ships a schema'd JSON-RPC control API (`codex app-server`). This owns
 * one server process and one connection to it, and nothing above it speaks
 * JSON-RPC directly.
 *
 * WHY THIS REPLACES READING ROLLOUT FILES. Task state for Codex CLI was derived
 * by polling ~/.codex/sessions/*.jsonl and matching event names. That is
 * Codex's internal storage, not an interface: between 0.142 and 0.147 the
 * conversation moved from `event_msg`/`agent_message` records to
 * `response_item`/`message`, and unmute silently stopped seeing what Codex
 * said — tasks still started and finished, but every card read "no recorded
 * output". A file we were never promised changed shape and nothing failed
 * loudly. The protocol is the promise; the rollout stays only for readback of
 * sessions we did not run (the import rail).
 *
 * ONE SERVER, MANY THREADS. Permissions, model, effort and cwd are all
 * per-thread parameters of `thread/start` (verified against the generated
 * schema), so a single shared server can host every task without them
 * inheriting each other's posture. That is what makes a per-task sandbox fence
 * possible at all.
 *
 * WEBSOCKET ON LOOPBACK, NOT STDIO, AND NOT A UNIX SOCKET.
 *   • stdio would bind the server to one client — and the terminal view needs a
 *     second one (`codex --remote <url>` attaches the real TUI to this same
 *     server, which is what lets one session have both a chat view and a
 *     terminal).
 *   • `unix://<path>` refuses paths over SUN_LEN and rejected every directory
 *     tried outside ~/.codex; its default location is shared with Codex's own
 *     daemon, which we must not collide with.
 *   • `ws://127.0.0.1:<port>` starts clean, needs no auth on loopback (the
 *     --ws-auth modes exist for non-loopback listeners), and comes with a
 *     /readyz endpoint so startup is a fact rather than a sleep.
 *
 * NOT CODEX'S MANAGED DAEMON. `codex app-server daemon start` would give us a
 * machine-global server that outlives unmute and is entangled with
 * remote-control pairing and the desktop app. This process is ours: our port,
 * our lifetime, gone when unmute quits.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import WebSocket from 'ws'
import { createLogger } from '../log'

const log = createLogger('codex-app-server')

/** How long to wait for /readyz before giving up on a start. */
const READY_TIMEOUT_MS = 20_000
const READY_POLL_MS = 150
/** A request that never comes back must not wedge a task forever. */
const REQUEST_TIMEOUT_MS = 120_000

export interface JsonRpcError { code: number; message: string; data?: unknown }

/** A server→client request: Codex is BLOCKED until we answer. Approvals arrive
 *  this way, which is the whole reason a task can stop needing a human at a
 *  terminal — see the approval methods in the protocol schema. */
export interface ServerRequest {
  id: number | string
  method: string
  params: unknown
}

export interface AppServerDeps {
  /** The `codex` to run. Resolved by the caller so this module owns no PATH logic. */
  bin: string
  /** Injected for tests. */
  spawnImpl?: typeof spawn
  fetchImpl?: typeof fetch
  wsFactory?: (url: string) => WebSocket
  port?: number
}

/** Ask the OS for a free loopback port. Racy in principle, immediately reused
 *  in practice, and far better than a hardcoded port that collides with a
 *  second unmute instance (which the test tiers deliberately run). */
async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => (port ? resolve(port) : reject(new Error('no port'))))
    })
  })
}

export class CodexAppServer {
  private proc: ChildProcess | null = null
  private ws: WebSocket | null = null
  private nextId = 1
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()
  private notifyHandlers = new Map<string, Set<(params: unknown) => void>>()
  private requestHandler: ((req: ServerRequest) => Promise<unknown>) | null = null
  private starting: Promise<void> | null = null
  private port = 0
  private stopped = false

  constructor(private deps: AppServerDeps) {}

  /** The URL a TUI attaches to: `codex --remote <this>`. Empty until started. */
  get url(): string { return this.port ? `ws://127.0.0.1:${this.port}` : '' }
  get running(): boolean { return !!this.ws && this.ws.readyState === WebSocket.OPEN }

  /**
   * Start the server and connect. Idempotent and coalesced — several tasks
   * dispatching at once must not each spawn a Codex.
   */
  async start(): Promise<void> {
    if (this.running) return
    if (this.starting) return this.starting
    this.starting = this.doStart().finally(() => { this.starting = null })
    return this.starting
  }

  private async doStart(): Promise<void> {
    this.stopped = false
    this.port = this.deps.port ?? await freePort()
    const spawnImpl = this.deps.spawnImpl ?? spawn
    const args = ['app-server', '--listen', `ws://127.0.0.1:${this.port}`]
    this.proc = spawnImpl(this.deps.bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    log.event('app-server-spawn', { bin: this.deps.bin, port: this.port, pid: this.proc.pid ?? null })

    // Codex writes its banner to stdout and its complaints to stderr. Neither is
    // the protocol — that lives on the socket — but a start that fails says why
    // here, and saying nothing is how the model-list bug stayed invisible.
    this.proc.stdout?.on('data', (d: Buffer) => log.event('app-server-out', { text: String(d).trim().slice(0, 300) }))
    this.proc.stderr?.on('data', (d: Buffer) => log.warn('app-server-err', { text: String(d).trim().slice(0, 300) }))
    this.proc.on('exit', (code, signal) => {
      log.warn('app-server-exited', { code, signal, deliberate: this.stopped })
      this.failAllPending(new Error('app-server exited'))
      this.ws = null
      this.proc = null
    })

    await this.waitReady()
    await this.connect()
    // The protocol requires a handshake before anything else is accepted.
    await this.request('initialize', { clientInfo: { name: 'unmute', version: '1' } })
    this.notify('initialized', {})
    log.event('app-server-ready', { url: this.url })
  }

  /** Poll /readyz rather than sleeping — a fixed wait is either too short on a
   *  cold machine or wasted on a warm one. */
  private async waitReady(): Promise<void> {
    const f = this.deps.fetchImpl ?? fetch
    const deadline = Date.now() + READY_TIMEOUT_MS
    let lastErr = 'never answered'
    while (Date.now() < deadline) {
      if (!this.proc) throw new Error(`app-server died before ready: ${lastErr}`)
      try {
        const res = await f(`http://127.0.0.1:${this.port}/readyz`)
        if (res.ok) return
        lastErr = `status ${res.status}`
      } catch (e) { lastErr = (e as Error).message }
      await new Promise((r) => setTimeout(r, READY_POLL_MS))
    }
    throw new Error(`app-server not ready after ${READY_TIMEOUT_MS}ms: ${lastErr}`)
  }

  private async connect(): Promise<void> {
    const make = this.deps.wsFactory ?? ((u: string) => new WebSocket(u))
    const ws = make(this.url)
    this.ws = ws
    await new Promise<void>((resolve, reject) => {
      const onOpen = () => { cleanup(); resolve() }
      const onErr = (e: Error) => { cleanup(); reject(e) }
      const cleanup = () => { ws.off('open', onOpen); ws.off('error', onErr) }
      ws.on('open', onOpen)
      ws.on('error', onErr)
    })
    ws.on('message', (data: Buffer | string) => this.onMessage(String(data)))
    ws.on('close', () => {
      log.warn('app-server-socket-closed', {})
      this.failAllPending(new Error('socket closed'))
      this.ws = null
    })
    ws.on('error', (e: Error) => log.warn('app-server-socket-error', { error: e.message }))
  }

  /**
   * One frame. Three shapes: a response to something we asked, a notification,
   * or a REQUEST FROM THE SERVER that blocks Codex until we reply — which is
   * how approvals arrive.
   */
  private onMessage(raw: string): void {
    let msg: {
      id?: number | string; method?: string; params?: unknown
      result?: unknown; error?: JsonRpcError
    }
    try { msg = JSON.parse(raw) } catch { log.warn('app-server-unparseable', { head: raw.slice(0, 120) }); return }

    if (msg.method && msg.id !== undefined) { void this.handleServerRequest(msg as ServerRequest); return }
    if (msg.method) { this.dispatchNotification(msg.method, msg.params); return }
    if (typeof msg.id === 'number') {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      clearTimeout(p.timer)
      if (msg.error) p.reject(new Error(`${msg.error.code}: ${msg.error.message}`))
      else p.resolve(msg.result)
    }
  }

  private async handleServerRequest(req: ServerRequest): Promise<void> {
    if (!this.requestHandler) {
      // AN UNANSWERED REQUEST HANGS THE TURN. Codex is waiting; there is no
      // timeout on its side that rescues us. Refusing loudly is the only safe
      // default — a silent drop looks exactly like a model that stopped
      // thinking, which is the failure mode the whole observer layer exists to
      // prevent.
      log.warn('app-server-request-unhandled', { method: req.method })
      this.respond(req.id, null, { code: -32601, message: `unmute has no handler for ${req.method}` })
      return
    }
    try {
      const result = await this.requestHandler(req)
      this.respond(req.id, result)
    } catch (e) {
      log.warn('app-server-request-handler-threw', { method: req.method, error: (e as Error).message })
      this.respond(req.id, null, { code: -32603, message: (e as Error).message })
    }
  }

  private respond(id: number | string, result: unknown, error?: JsonRpcError): void {
    this.send(error ? { jsonrpc: '2.0', id, error } : { jsonrpc: '2.0', id, result })
  }

  private dispatchNotification(method: string, params: unknown): void {
    for (const h of this.notifyHandlers.get(method) ?? []) {
      try { h(params) } catch (e) { log.warn('notification handler threw', { method, error: (e as Error).message }) }
    }
    // '*' sees everything — how the task layer follows a thread without
    // subscribing to seventy method names one at a time.
    for (const h of this.notifyHandlers.get('*') ?? []) {
      try { h({ method, params }) } catch (e) { log.warn('wildcard handler threw', { method, error: (e as Error).message }) }
    }
  }

  private send(o: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) { log.warn('app-server-send-dropped', {}); return }
    this.ws.send(JSON.stringify(o))
  }

  /** Fire a request and wait for its reply. */
  async request<T = unknown>(method: string, params: unknown = {}): Promise<T> {
    if (!this.running) await this.start()
    const id = this.nextId++
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out after ${REQUEST_TIMEOUT_MS}ms`))
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
      this.send({ jsonrpc: '2.0', id, method, params })
    })
  }

  notify(method: string, params: unknown = {}): void {
    this.send({ jsonrpc: '2.0', method, params })
  }

  /** Subscribe to a notification method, or '*' for all of them. Returns an
   *  unsubscribe. */
  on(method: string, handler: (params: unknown) => void): () => void {
    let set = this.notifyHandlers.get(method)
    if (!set) { set = new Set(); this.notifyHandlers.set(method, set) }
    set.add(handler)
    return () => { set!.delete(handler) }
  }

  /** Answer server→client requests (approvals). One handler; it routes by
   *  method and by the thread the request names. */
  onRequest(handler: (req: ServerRequest) => Promise<unknown>): void {
    this.requestHandler = handler
  }

  private failAllPending(e: Error): void {
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(e) }
    this.pending.clear()
  }

  /** Stop the server. Safe to call twice; safe to call when never started. */
  stop(): void {
    this.stopped = true
    this.failAllPending(new Error('app-server stopped'))
    try { this.ws?.close() } catch { /* already gone */ }
    this.ws = null
    try { this.proc?.kill() } catch { /* already gone */ }
    this.proc = null
    this.port = 0
    log.event('app-server-stopped', {})
  }
}
