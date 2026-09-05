import { createServer, createConnection, type Socket, type Server } from 'node:net'
import { mkdir, chmod, lstat, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'

const MAX_FRAME = 64 * 1024 * 1024
type Frame = { id?: string; method?: string; args?: unknown[]; result?: unknown; error?: string; event?: string; data?: unknown }

function readFrames(socket: Socket, receive: (frame: Frame) => void): void {
  let buffer = ''
  socket.setEncoding('utf8')
  socket.on('data', data => {
    buffer += data
    if (Buffer.byteLength(buffer) > MAX_FRAME) { socket.destroy(new Error('Runtime frame exceeds limit')); return }
    let newline: number
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1)
      try { receive(JSON.parse(line)) } catch { socket.destroy(new Error('Invalid runtime frame')); return }
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
  constructor(private readonly path: string, private readonly invoke: (method: string, args: unknown[]) => Promise<unknown>) {}
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
      this.clients.add(socket)
      socket.on('error', () => {})
      socket.on('close', () => this.clients.delete(socket))
      readFrames(socket, frame => {
        if (typeof frame.id !== 'string' || typeof frame.method !== 'string' || !Array.isArray(frame.args)) { socket.destroy(); return }
        void this.invoke(frame.method, frame.args).then(
          result => write(socket, { id: frame.id, result }),
          error => write(socket, { id: frame.id, error: error instanceof Error ? error.message : 'Runtime request failed' }),
        )
      })
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
  constructor(private readonly path: string) { super() }
  get connected(): boolean { return !!this.socket && !this.socket.destroyed }
  connect(): Promise<void> {
    if (this.connected) return Promise.resolve()
    return this.connecting ??= new Promise<void>((resolve, reject) => {
      const socket = createConnection(this.path)
      socket.once('connect', () => { this.socket = socket; resolve() })
      socket.on('error', reject)
      socket.on('close', () => {
        if (this.socket === socket) this.socket = undefined
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
      })
    }).finally(() => { this.connecting = undefined })
  }
  async call<T = any>(method: string, ...args: unknown[]): Promise<T> {
    await this.connect()
    return new Promise<T>((resolve, reject) => {
      const id = randomUUID()
      this.pending.set(id, { resolve, reject })
      write(this.socket!, { id, method, args })
    })
  }
  /** Disconnect only: never requests termination of provider work. */
  disconnect(): void { this.socket?.destroy(); this.socket = undefined }
}
