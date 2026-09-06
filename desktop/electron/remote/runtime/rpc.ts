import { createServer, createConnection, type Socket, type Server } from 'node:net'
import { mkdir, chmod, lstat, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { diagnostic, diagnosticError, type DiagnosticSink } from '../diagnostics'

const MAX_FRAME = 64 * 1024 * 1024
type Frame = { id?: string; method?: string; args?: unknown[]; result?: unknown; error?: string; event?: string; data?: unknown }

function readFrames(socket: Socket, receive: (frame: Frame) => void, audit: DiagnosticSink): void {
  let chunks: Buffer[] = []
  let size = 0
  socket.on('data', data => {
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data)
    let start = 0
    while (start < bytes.length) {
      const newline = bytes.indexOf(10, start)
      const end = newline === -1 ? bytes.length : newline
      const part = bytes.subarray(start, end)
      chunks.push(part); size += part.length
      if (size > MAX_FRAME) { audit('runtime-frame-rejected', { reason: 'size-limit', bytes: size, limit: MAX_FRAME }); socket.destroy(new Error('Runtime frame exceeds limit')); return }
      if (newline === -1) break
      const frameBytes = size
      const line = Buffer.concat(chunks, size).toString('utf8')
      chunks = []; size = 0
      let frame: Frame
      try { frame = JSON.parse(line) }
      catch (error) { audit('runtime-frame-rejected', { reason: 'invalid-json', bytes: frameBytes, ...diagnosticError(error) }); socket.destroy(new Error('Invalid runtime frame')); return }
      if (!frame || typeof frame !== 'object') { audit('runtime-frame-rejected', { reason: 'invalid-shape', bytes: frameBytes }); socket.destroy(); return }
      audit('runtime-frame-received', { bytes: frameBytes, requestId: frame.id, method: frame.method, event: frame.event })
      // A UI consumer exception is NOT corrupt JSON. Do not discard other replies.
      try { receive(frame) } catch (error) { audit('runtime-frame-handler-failed', { requestId: frame.id, event: frame.event, ...diagnosticError(error) }) }
      start = newline + 1
    }
  })
}
function write(socket: Socket, frame: Frame): void {
  if (!socket.destroyed) socket.write(JSON.stringify(frame) + '\n')
}

/** Local UI connections never own the lifetime of this server or its work. */
export class RuntimeRpcServer {
  private server?: Server
  private clients = new Set<Socket>()
  constructor(private readonly path: string, private readonly invoke: (method: string, args: unknown[]) => Promise<unknown>, private readonly audit: DiagnosticSink = diagnostic) {}
  async listen(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    await chmod(dirname(this.path), 0o700)
    const old = await lstat(this.path).catch(error => { if (error.code !== 'ENOENT') throw error; return null })
    if (old) {
      if (!old.isSocket()) throw new Error('Runtime endpoint is not a socket')
      const live = await new Promise<boolean>((resolve, reject) => {
        const probe = createConnection(this.path)
        probe.once('connect', () => { probe.destroy(); resolve(true) })
        probe.once('error', error => (error as NodeJS.ErrnoException).code === 'ECONNREFUSED' ? resolve(false) : reject(error))
      })
      if (live) throw new Error('Runtime already running')
      await unlink(this.path)
    }
    const server = createServer(socket => {
      const connectionId = randomUUID()
      const audit: DiagnosticSink = (event, fields) => this.audit(event, { connectionId, side: 'server', endpoint: this.path, ...fields })
      audit('runtime-connected', {})
      this.clients.add(socket)
      socket.on('error', error => audit('runtime-socket-error', diagnosticError(error)))
      socket.on('close', hadError => { this.clients.delete(socket); audit('runtime-disconnected', { hadError, bytesRead: socket.bytesRead, bytesWritten: socket.bytesWritten }) })
      readFrames(socket, frame => {
        if (typeof frame.id !== 'string' || typeof frame.method !== 'string' || !Array.isArray(frame.args)) { socket.destroy(); return }
        const started = Date.now()
        audit('runtime-request-started', { requestId: frame.id, method: frame.method })
        void Promise.resolve().then(() => this.invoke(frame.method!, frame.args!)).then(
          result => { audit('runtime-request-completed', { requestId: frame.id, method: frame.method, durationMs: Date.now() - started, outcome: 'success', connected: !socket.destroyed }); write(socket, { id: frame.id, result }) },
          error => { audit('runtime-request-completed', { requestId: frame.id, method: frame.method, durationMs: Date.now() - started, outcome: 'error', ...diagnosticError(error) }); write(socket, { id: frame.id, error: error instanceof Error ? error.message : 'Runtime request failed' }) },
        )
      }, audit)
    })
    this.server = server
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(this.path, resolve) })
    await chmod(this.path, 0o600)
  }
  emit(event: string, data: unknown): void { for (const client of this.clients) write(client, { event, data }) }
  async close(): Promise<void> {
    for (const socket of this.clients) socket.destroy()
    await new Promise<void>(resolve => this.server ? this.server.close(() => resolve()) : resolve())
  }
}

export class RuntimeRpcClient extends EventEmitter {
  private socket?: Socket
  private connecting?: Promise<void>
  private pending = new Map<string, { resolve(value: any): void; reject(error: Error): void }>()
  constructor(private readonly path: string, private readonly requestTimeoutMs = 30_000, private readonly audit: DiagnosticSink = diagnostic) { super() }
  get connected(): boolean { return !!this.socket && !this.socket.destroyed }
  connect(): Promise<void> {
    if (this.connected) return Promise.resolve()
    return this.connecting ??= new Promise<void>((resolve, reject) => {
      const socket = createConnection(this.path)
      const connectionId = randomUUID()
      const audit: DiagnosticSink = (event, fields) => this.audit(event, { connectionId, side: 'client', endpoint: this.path, ...fields })
      socket.once('connect', () => { this.socket = socket; audit('runtime-connected', {}); resolve() })
      socket.on('error', error => { audit('runtime-socket-error', diagnosticError(error)); reject(error) })
      socket.on('close', hadError => {
        audit('runtime-disconnected', { hadError, pendingRequests: this.pending.size, bytesRead: socket.bytesRead, bytesWritten: socket.bytesWritten })
        if (this.socket !== socket) return
        this.socket = undefined
        for (const p of this.pending.values()) p.reject(new Error('Runtime disconnected; submission may have been accepted'))
        this.pending.clear()
        this.emit('disconnected')
      })
      readFrames(socket, frame => {
        if (frame.event) { this.emit(frame.event, frame.data); return }
        const pending = frame.id && this.pending.get(frame.id)
        if (!pending) return
        this.pending.delete(frame.id!)
        if (frame.error) pending.reject(new Error(frame.error)); else pending.resolve(frame.result)
      }, audit)
    }).finally(() => { this.connecting = undefined })
  }
  async call<T = any>(method: string, ...args: unknown[]): Promise<T> {
    await this.connect()
    return new Promise<T>((resolve, reject) => {
      const id = randomUUID()
      const started = Date.now()
      this.audit('runtime-request-started', { endpoint: this.path, requestId: id, method })
      // These methods intentionally await a complete agent turn. Ordinary
      // sends acknowledge acceptance and must remain bounded.
      const timer = ['agent.submit', 'agent.retry'].includes(method) ? undefined : setTimeout(() => {
        this.pending.delete(id)
        this.audit('runtime-request-timeout', { endpoint: this.path, requestId: id, method, durationMs: Date.now() - started })
        reject(new Error(`Background runtime request ${method} timed out; its outcome is unknown. Check the conversation before retrying.`))
      }, this.requestTimeoutMs)
      this.pending.set(id, {
        resolve: value => { clearTimeout(timer); this.audit('runtime-request-completed', { endpoint: this.path, requestId: id, method, durationMs: Date.now() - started, outcome: 'success' }); resolve(value) },
        reject: error => { clearTimeout(timer); this.audit('runtime-request-completed', { endpoint: this.path, requestId: id, method, durationMs: Date.now() - started, outcome: 'error', ...diagnosticError(error) }); reject(error) },
      })
      write(this.socket!, { id, method, args })
    })
  }
  /** Disconnect only: never requests termination of provider work. */
  disconnect(): void { this.socket?.destroy() }
}
