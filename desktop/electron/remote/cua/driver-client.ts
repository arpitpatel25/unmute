// DriverClient — ONE embedded cua-driver child, spoken to over line-delimited
// JSON-RPC 2.0 (MCP 2025-06-18) on its stdio.
//
// THE INVARIANT THIS FILE CARRIES: the child is spawned by THIS process
// (Unmute's Electron main — the signed .app). That keeps the driver inside
// Unmute's TCC responsibility chain, so it inherits Unmute's Accessibility +
// Screen Recording grants (cua EMBEDDING.md). Anyone else spawning it — Claude
// Code over stdio, a terminal, LaunchServices — gives it the WRONG identity
// and it silently has no permissions. Never move this spawn elsewhere.
//
// Telemetry is forced off in code (opt-out ON by default upstream → PostHog):
// Unmute's promise is fully-local, so we never rely on user config for this.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { createLogger } from '../log'

const log = createLogger('cua-client')

export interface DriverClientOpts {
  binPath: string
  /** Override for tests (fake driver via `node <script>`). Default: ['mcp']. */
  binArgs?: string[]
  hostBundleId?: string
  /** Per-request timeout ms. Default 60s — window captures can be slow. */
  timeoutMs?: number
  onExit?: (code: number | null) => void
}

interface Pending { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }

export class DriverClient {
  private child: ChildProcessWithoutNullStreams
  private nextId = 1
  private pending = new Map<number, Pending>()
  private dead = false
  /** The driver's own `initialize` result — forwarded VERBATIM to HTTP clients
   *  (thin pass-through: its tool surface and instructions are the product). */
  readonly initResult: Promise<Record<string, unknown>>

  constructor(private opts: DriverClientOpts) {
    this.child = spawn(opts.binPath, opts.binArgs ?? ['mcp'], {
      env: {
        ...process.env,
        CUA_DRIVER_EMBEDDED: '1', // exact string "1" — anything else is ignored fail-safe
        CUA_DRIVER_HOST_BUNDLE_ID: opts.hostBundleId ?? 'unmute', // advisory (logs only)
        CUA_DRIVER_RS_TELEMETRY_ENABLED: 'false',
        CUA_TELEMETRY_ENABLED: 'false', // compat alias — belt and braces
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const rl = createInterface({ input: this.child.stdout })
    rl.on('line', (line) => this.onLine(line))
    this.child.stderr.on('data', (d: Buffer) => log.warn('driver stderr', { text: d.toString().slice(0, 400) }))
    this.child.on('exit', (code) => {
      this.dead = true
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('cua-driver exited')) }
      this.pending.clear()
      this.opts.onExit?.(code)
    })
    this.child.on('error', (e) => log.warn('driver spawn error', { error: e.message }))
    this.initResult = this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'unmute', version: '1.0.0' },
    }).then((r) => {
      this.notify('notifications/initialized')
      return r as Record<string, unknown>
    })
    this.initResult.catch(() => { /* surfaced per-request; avoid unhandled rejection */ })
  }

  get alive(): boolean { return !this.dead }
  get pid(): number | undefined { return this.child.pid }

  private onLine(line: string): void {
    if (!line.trim()) return
    let msg: { id?: number; result?: unknown; error?: { code: number; message: string } }
    try { msg = JSON.parse(line) } catch { log.warn('driver sent non-JSON line'); return }
    if (typeof msg.id !== 'number') return // driver-side notification — ignore
    const p = this.pending.get(msg.id)
    if (!p) return
    this.pending.delete(msg.id)
    clearTimeout(p.timer)
    if (msg.error) p.reject(new Error(`driver error ${msg.error.code}: ${msg.error.message}`))
    else p.resolve(msg.result)
  }

  request(method: string, params?: unknown): Promise<unknown> {
    if (this.dead) return Promise.reject(new Error('cua-driver is not running'))
    const id = this.nextId++
    const line = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`cua-driver timed out on ${method}`))
      }, this.opts.timeoutMs ?? 60_000)
      this.pending.set(id, { resolve, reject, timer })
      this.child.stdin.write(line, (err) => {
        if (err) { this.pending.delete(id); clearTimeout(timer); reject(err) }
      })
    })
  }

  notify(method: string, params?: unknown): void {
    if (this.dead) return
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
  }

  kill(): void {
    this.dead = true
    try { this.child.kill() } catch { /* already gone */ }
  }
}
