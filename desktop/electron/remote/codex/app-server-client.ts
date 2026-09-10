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
 * THE PLATFORM'S WebSocket, NOT THE `ws` PACKAGE, and this is a scar.
 *
 * The first version imported `ws`. It passed a live end-to-end test under tsx
 * and then threw `bufferUtil$1.mask is not a function` on its very first frame
 * in the packaged app: `ws` ships optional native addons and falls back to JS
 * when they are missing, but the bundler inlined a broken reference to the
 * native masker. The dispatch then fell through a fallback and the user's task
 * silently ran on Claude instead.
 *
 * A GLOBAL CANNOT BE BUNDLED WRONGLY. There is no import for rollup to resolve
 * and no optional binary to lose — which is a stronger guarantee than "this
 * dependency happens to work today". Electron 40 / Node 24 provides WebSocket
 * in the main process (verified in the actual runtime, not in tsx, because
 * verifying in the wrong runtime is exactly how the first version shipped).
 *
 * NOT CODEX'S MANAGED DAEMON. `codex app-server daemon start` would give us a
 * machine-global server that outlives unmute and is entangled with
 * remote-control pairing and the desktop app. This process is ours: our port,
 * our lifetime, gone when unmute quits.
 */

import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readlink, symlink, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createLogger } from '../log'
import { writeFileAtomic } from '../atomic-file'
import { sessionLifecycleDev } from '../session-lifecycle-devlog'

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
  /** Synchronous socket enqueue, throws if this request's connection was lost. */
  respond?: (result: unknown) => void
}

export interface AppServerDeps {
  /** The `codex` to run. Resolved by the caller so this module owns no PATH logic. */
  bin: string
  /** Injected for tests. */
  spawnImpl?: typeof spawn
  fetchImpl?: typeof fetch
  wsFactory?: (url: string) => WebSocket
  port?: number
  ownerFile?: string
  inspectProcess?: (pid: number) => Promise<string | null>
  killImpl?: (pid: number) => void
  readyTimeoutMs?: number
  readyPollMs?: number
}

type AppServerOwner = { pid: number; port: number; generation: string }

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
  private owner: AppServerOwner | null = null

  constructor(private deps: AppServerDeps) {}

  /** The URL a TUI attaches to: `codex --remote <this>`. Empty until started. */
  get url(): string { return this.port ? `ws://127.0.0.1:${this.port}` : '' }
  get running(): boolean { return !!this.ws && this.ws.readyState === 1 /* OPEN */ }

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
    const adopted = await this.adoptOwner()
    if (adopted) {
      this.port = adopted.port
      this.owner = adopted
      try {
        await this.waitReady(false)
        await this.connect()
        await this.request('initialize', { clientInfo: { name: 'unmute', version: '1' } })
        this.notify('initialized', {})
        log.event('app-server-adopted', { port: adopted.port, pid: adopted.pid, generation: adopted.generation })
        sessionLifecycleDev('writer-owner-adopted', { pid: adopted.pid, port: adopted.port, generation: adopted.generation })
        return
      } catch (error) {
        this.ws?.close(); this.ws = null
        sessionLifecycleDev('writer-owner-fenced', { pid: adopted.pid, port: adopted.port, phase: 'health-check' })
        throw new Error(`existing app-server owner is alive but unreachable: ${(error as Error).message}`)
      }
    }
    const spawnClaim = await this.acquireSpawnClaim()
    this.port = this.deps.port ?? await freePort()
    const spawnImpl = this.deps.spawnImpl ?? spawn
    const args = ['app-server', '--listen', `ws://127.0.0.1:${this.port}`]
    // A MARKER SO OUR STRAYS CAN BE FOUND AND REAPED. Four dead app-servers
    // were left running on this machine by starts that threw before `stop()`
    // could own them — each one a Codex process the user never launched and
    // cannot see. `env` is the only channel that survives into `ps` without
    // changing the command Codex parses.
    try {
      this.proc = spawnImpl(this.deps.bin, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, UNMUTE_APP_SERVER: '1' },
      })
      if (!this.proc.pid) throw new Error('app-server spawn returned no pid')
      this.owner = { pid: this.proc.pid, port: this.port, generation: randomUUID() }
      await this.writeOwner(this.owner)
    }
    catch (error) {
      try { this.proc?.kill() } catch { /* best-effort rollback */ }
      this.proc = null; this.owner = null
      throw error
    } finally {
      await this.releaseSpawnClaim(spawnClaim)
    }
    sessionLifecycleDev('writer-owner-spawned', { pid: this.owner.pid, port: this.owner.port, generation: this.owner.generation })
    log.event('app-server-spawn', { bin: this.deps.bin, port: this.port, pid: this.proc.pid ?? null })

    // Codex writes its banner to stdout and its complaints to stderr. Neither is
    // the protocol — that lives on the socket — but a start that fails says why
    // here, and saying nothing is how the model-list bug stayed invisible.
    this.proc.stdout?.on('data', (d: Buffer) => log.event('app-server-out', { text: String(d).trim().slice(0, 300) }))
    this.proc.stderr?.on('data', (d: Buffer) => log.warn('app-server-err', { text: String(d).trim().slice(0, 300) }))
    this.proc.on('exit', (code, signal) => {
      log.warn('app-server-exited', { code, signal, deliberate: this.stopped })
      this.failAllPending(new Error('app-server exited'))
      if (!this.stopped) this.dispatchNotification('transport/disconnected', { reason: 'app-server exited' })
      this.ws = null
      this.proc = null
      void this.clearOwner(this.owner)
      this.owner = null
    })

    await this.waitReady()
    await this.connect()
    // The protocol requires a handshake before anything else is accepted.
    await this.request('initialize', { clientInfo: { name: 'unmute', version: '1' } })
    this.notify('initialized', {})
    log.event('app-server-ready', { url: this.url })
  }

  private async inspectProcess(pid: number): Promise<string | null> {
    if (this.deps.inspectProcess) return this.deps.inspectProcess(pid)
    return new Promise(resolve => execFile('/bin/ps', ['-p', String(pid), '-wwEo', 'command='], (error, stdout) => {
      resolve(error ? null : String(stdout).trim() || null)
    }))
  }

  private async adoptOwner(): Promise<AppServerOwner | null> {
    if (!this.deps.ownerFile) return null
    let owner: AppServerOwner
    try { owner = JSON.parse(await readFile(this.deps.ownerFile, 'utf8')) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    sessionLifecycleDev('writer-owner-record-read', { pid: owner.pid, port: owner.port, generation: owner.generation })
    if (!Number.isInteger(owner.pid) || owner.pid <= 0 || !Number.isInteger(owner.port) || owner.port <= 0 || !owner.generation) {
      throw new Error('invalid app-server owner record')
    }
    const command = await this.inspectProcess(owner.pid)
    if (!command) {
      sessionLifecycleDev('writer-owner-stale', { pid: owner.pid, port: owner.port, generation: owner.generation })
      await this.clearOwner(owner); return null
    }
    const endpoint = `ws://127.0.0.1:${owner.port}`
    if (!command.includes('UNMUTE_APP_SERVER=1') || !command.includes('app-server') || !command.includes(endpoint)) {
      throw new Error('existing app-server owner could not be verified')
    }
    return owner
  }

  private async writeOwner(owner: AppServerOwner): Promise<void> {
    if (!this.deps.ownerFile) return
    await mkdir(dirname(this.deps.ownerFile), { recursive: true, mode: 0o700 })
    await writeFileAtomic(this.deps.ownerFile, JSON.stringify(owner))
    sessionLifecycleDev('writer-owner-record-written', { pid: owner.pid, port: owner.port, generation: owner.generation })
  }

  /** A fixed symlink is an atomic cross-process election. Its target carries
   * the runtime PID, so a crash before owner publication is recoverable. */
  private async acquireSpawnClaim(retried = false): Promise<string | null> {
    if (!this.deps.ownerFile) return null
    const file = `${this.deps.ownerFile}.claim`
    const token = `${process.pid}:${randomUUID()}`
    await mkdir(dirname(file), { recursive: true, mode: 0o700 })
    try { await symlink(token, file); return token }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      let current = ''
      try { current = await readlink(file) } catch { throw new Error('app-server owner election could not be verified') }
      const pid = Number(current.split(':', 1)[0])
      if (!Number.isInteger(pid) || pid <= 0) throw new Error('invalid app-server owner election')
      if (await this.inspectProcess(pid)) throw new Error('app-server owner election is already in progress')
      if (retried) throw new Error('stale app-server owner election could not be cleared')
      await unlink(file).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error })
      return this.acquireSpawnClaim(true)
    }
  }

  private async releaseSpawnClaim(token: string | null): Promise<void> {
    if (!this.deps.ownerFile || !token) return
    const file = `${this.deps.ownerFile}.claim`
    try { if (await readlink(file) === token) await unlink(file) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') log.warn('app-server-owner-claim-release-failed', { error: (error as Error).message }) }
  }

  private async clearOwner(expected: AppServerOwner | null): Promise<void> {
    if (!this.deps.ownerFile || !expected) return
    try {
      const current = JSON.parse(await readFile(this.deps.ownerFile, 'utf8')) as AppServerOwner
      if (current.generation === expected.generation && current.pid === expected.pid && current.port === expected.port) {
        await unlink(this.deps.ownerFile)
        sessionLifecycleDev('writer-owner-record-cleared', { pid: expected.pid, port: expected.port, generation: expected.generation })
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') log.warn('app-server-owner-clear-failed', { error: (error as Error).message })
    }
  }

  /** Poll /readyz rather than sleeping — a fixed wait is either too short on a
   *  cold machine or wasted on a warm one. */
  private async waitReady(requireSpawnedProcess = true): Promise<void> {
    const f = this.deps.fetchImpl ?? fetch
    const timeout = this.deps.readyTimeoutMs ?? READY_TIMEOUT_MS
    const poll = this.deps.readyPollMs ?? READY_POLL_MS
    const deadline = Date.now() + timeout
    let lastErr = 'never answered'
    while (Date.now() < deadline) {
      if (requireSpawnedProcess && !this.proc) throw new Error(`app-server died before ready: ${lastErr}`)
      try {
        const res = await f(`http://127.0.0.1:${this.port}/readyz`)
        if (res.ok) return
        lastErr = `status ${res.status}`
      } catch (e) { lastErr = (e as Error).message }
      await new Promise((r) => setTimeout(r, poll))
    }
    throw new Error(`app-server not ready after ${timeout}ms: ${lastErr}`)
  }

  private async connect(): Promise<void> {
    const make = this.deps.wsFactory ?? ((u: string) => new WebSocket(u))
    const ws = make(this.url)
    this.ws = ws
    await new Promise<void>((resolve, reject) => {
      const onOpen = () => { cleanup(); resolve() }
      const onErr = () => { cleanup(); reject(new Error('websocket failed to open')) }
      const cleanup = () => {
        ws.removeEventListener('open', onOpen)
        ws.removeEventListener('error', onErr)
      }
      ws.addEventListener('open', onOpen)
      ws.addEventListener('error', onErr)
    })
    // `data` is a string for text frames on the platform WebSocket; Blob/
    // ArrayBuffer only for binary, which this protocol never sends. Coerced
    // anyway so a binary frame degrades to an unparseable line rather than a
    // crash in the message loop.
    ws.addEventListener('message', (ev: MessageEvent) => this.onMessage(String(ev.data)))
    ws.addEventListener('close', () => {
      log.warn('app-server-socket-closed', {})
      this.failAllPending(new Error('socket closed'))
      if (!this.stopped) this.dispatchNotification('transport/disconnected', { reason: 'socket closed' })
      this.ws = null
    })
    ws.addEventListener('error', () => log.warn('app-server-socket-error', {}))
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
    const socket = this.ws
    let delivered = false
    req.respond = (result) => {
      if (delivered) throw new Error('Codex request already answered')
      if (!socket || this.ws !== socket || socket.readyState !== 1) throw new Error('Codex request connection lost')
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }))
      delivered = true
    }
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
      if (!delivered) req.respond(result)
    } catch (e) {
      log.warn('app-server-request-handler-threw', { method: req.method, error: (e as Error).message })
      if (socket && this.ws === socket && socket.readyState === 1 && !delivered) {
        socket.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -32603, message: (e as Error).message } }))
      }
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
    if (!this.ws || this.ws.readyState !== 1 /* OPEN */) { log.warn('app-server-send-dropped', {}); return }
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

  /**
   * Kill app-servers WE started that outlived their owner.
   *
   * Only ours: matched on the UNMUTE_APP_SERVER marker in the environment, so a
   * Codex the user launched — or the desktop app's own app-server — is never
   * touched. Best-effort and silent on failure; a stray process is a leak, not
   * a reason to fail a launch.
   *
   * Needed because `stop()` only ever reaches the servers this process owns. A
   * start that throws, a crash, or a reinstall leaves the child behind, and
   * they accumulate: twelve were found running after a day of failed starts.
   */
  static reapStrays(execFileImpl = execFile): void {
    execFileImpl('/bin/ps', ['-eo', 'pid=,command='], (err, stdout) => {
      if (err) return
      const mine: string[] = []
      for (const line of String(stdout).split('\n')) {
        if (!/codex.*app-server .*--listen ws:\/\/127\.0\.0\.1/.test(line)) continue
        const pid = line.trim().split(/\s+/)[0]
        if (pid && pid !== String(process.pid)) mine.push(pid)
      }
      if (!mine.length) return
      // Confirm each one is OURS before killing — the command line alone cannot
      // tell our server from one the user started the same way.
      for (const pid of mine) {
        execFileImpl('/bin/ps', ['-p', pid, '-wwEo', 'command='], (e2, out2) => {
          if (e2 || !String(out2).includes('UNMUTE_APP_SERVER=1')) return
          try { process.kill(Number(pid)) ; log.event('app-server-stray-reaped', { pid }) }
          catch { /* already gone */ }
        })
      }
    })
  }

  /** Stop the server. Safe to call twice; safe to call when never started. */
  stop(): void {
    this.stopped = true
    this.failAllPending(new Error('app-server stopped'))
    try { this.ws?.close() } catch { /* already gone */ }
    this.ws = null
    const adoptedPid = !this.proc ? this.owner?.pid : undefined
    try { this.proc?.kill() } catch { /* already gone */ }
    if (adoptedPid) {
      try { (this.deps.killImpl ?? process.kill)(adoptedPid) } catch { /* already gone */ }
    }
    this.proc = null
    void this.clearOwner(this.owner)
    this.owner = null
    this.port = 0
    log.event('app-server-stopped', {})
  }
}
