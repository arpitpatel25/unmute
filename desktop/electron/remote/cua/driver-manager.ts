// DriverManager — the pool of embedded cua-driver children, all spawned by
// THIS process (the TCC-responsible signed .app; see driver-client.ts).
//
// SHAPE (settled): one shared "default" child (initialize/tools/list and
// session-less traffic) + one lazy child per Claude Code MCP session. cua's
// own concurrency model: distinct connections give parallelism BETWEEN
// sessions; one stdio pipe serializes WITHIN a session (fine — that matches
// one agent taking turns). Embedded mode never proxies to cua's daemon (that
// path would leave the TCC chain), so multiple children IS the multiplexing.
//
// TCC CACHING: macOS caches permission answers per-process. A grant given
// while a child is running is INVISIBLE to that child until it restarts —
// so we poll, and on Accessibility flipping false→true, restart everything.
import { DriverClient } from './driver-client'
import { createLogger } from '../log'

const log = createLogger('cua-manager')

export interface DriverManagerOpts {
  binPath: string
  binArgs?: string[]
  hostBundleId?: string
  timeoutMs?: number
  /** Idle ms before a per-session child is reaped. Default 10 min. */
  sessionIdleMs?: number
  /** Permission re-check cadence ms. Default 30s; 0 disables (tests). */
  permissionPollMs?: number
  /** Opt-in gate for the background poll: when provided and false, the poll
   *  never spawns a child — nothing runs until the user enables Computer Use.
   *  On-demand paths (IPC, bridge tool calls) are user-initiated and unaffected. */
  getEnabled?: () => boolean
}

export class DriverManager {
  private def: DriverClient | null = null
  private bySession = new Map<string, { client: DriverClient; lastUsed: number }>()
  private reapTimer: NodeJS.Timeout | null = null
  private pollTimer: NodeJS.Timeout | null = null
  private lastAccessibility: boolean | null = null
  private disposed = false

  constructor(private opts: DriverManagerOpts) {
    const idle = opts.sessionIdleMs ?? 10 * 60_000
    this.reapTimer = setInterval(() => this.reap(idle), Math.max(15_000, Math.floor(idle / 4)))
    this.reapTimer.unref?.()
    const poll = opts.permissionPollMs ?? 30_000
    if (poll > 0) {
      this.pollTimer = setInterval(() => void this.pollPermissions(), poll)
      this.pollTimer.unref?.()
    }
  }

  /** Test observability only — proves gating paths never spawned. */
  private spawnCount = 0

  private spawnClient(): DriverClient {
    this.spawnCount++
    return new DriverClient({
      binPath: this.opts.binPath,
      binArgs: this.opts.binArgs,
      hostBundleId: this.opts.hostBundleId,
      timeoutMs: this.opts.timeoutMs,
    })
  }

  /** The shared child. Respawned lazily if it died (crash resilience). */
  default(): DriverClient {
    // After dispose() (app before-quit) the timers are gone — a late spawn
    // here would be a child nothing ever kills. Refuse instead of leaking.
    if (this.disposed) throw new Error('DriverManager disposed')
    if (!this.def || !this.def.alive) this.def = this.spawnClient()
    return this.def
  }

  /** Per-session child (lazy). No sessionId → the shared default. */
  forSession(sessionId: string | undefined): DriverClient {
    if (this.disposed || !sessionId) return this.default()
    const hit = this.bySession.get(sessionId)
    if (hit && hit.client.alive) { hit.lastUsed = Date.now(); return hit.client }
    const client = this.spawnClient()
    this.bySession.set(sessionId, { client, lastUsed: Date.now() })
    log.event('cua-session-child-spawned', { sessionId, pid: client.pid })
    return client
  }

  endSession(sessionId: string): void {
    const hit = this.bySession.get(sessionId)
    if (hit) { hit.client.kill(); this.bySession.delete(sessionId) }
  }

  /** Live permission state via the driver itself. screen_recording_capturable
   *  (a real ScreenCaptureKit probe) is authoritative over the TCC flag. */
  async checkPermissions(): Promise<{ accessibility: boolean; screenRecording: boolean }> {
    const res = (await this.default().request('tools/call', { name: 'check_permissions', arguments: {} })) as {
      structuredContent?: { accessibility?: boolean; screen_recording?: boolean; screen_recording_capturable?: boolean }
    }
    const s = res?.structuredContent ?? {}
    return {
      accessibility: s.accessibility === true,
      screenRecording: s.screen_recording_capturable === true || s.screen_recording === true,
    }
  }

  private async pollPermissions(): Promise<void> {
    // Opt-in principle: the background poll must not be the thing that spawns
    // a resident driver for users who never enabled Computer Use.
    if (this.opts.getEnabled && !this.opts.getEnabled()) return
    try {
      const { accessibility } = await this.checkPermissions()
      if (this.lastAccessibility === false && accessibility) {
        log.event('cua-grant-detected-restarting', {}) // stale TCC cache in children
        this.restartAll()
      }
      this.lastAccessibility = accessibility
    } catch { /* driver unavailable — nothing to track */ }
  }

  restartAll(): void {
    for (const [id, s] of this.bySession) { s.client.kill(); this.bySession.delete(id) }
    if (this.def) { this.def.kill(); this.def = null }
  }

  private reap(idleMs: number): void {
    const now = Date.now()
    for (const [id, s] of this.bySession) {
      if (!s.client.alive || now - s.lastUsed > idleMs) { s.client.kill(); this.bySession.delete(id) }
    }
  }

  dispose(): void {
    this.disposed = true
    if (this.reapTimer) clearInterval(this.reapTimer)
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.restartAll()
  }
}
