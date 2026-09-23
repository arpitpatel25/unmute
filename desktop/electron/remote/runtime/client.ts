import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { RuntimeRpcClient } from './rpc'
import { diagnostic } from '../diagnostics'

export function runtimeSocket(root: string): string {
  const key = createHash('sha256').update(root).digest('hex').slice(0, 20)
  return join(tmpdir(), `unmute-runtime-${process.getuid?.() ?? 'user'}-${key}`, 'rpc.sock')
}

/**
 * A packaged macOS daemon must not run as Contents/MacOS/<app>. LaunchServices
 * identifies that executable as the GUI process, so leaving it alive can turn
 * the next `open` into a no-op. Electron's signed Node-capable helper has the
 * same runtime but a distinct process identity, allowing the UI to quit and
 * relaunch while work remains daemon-owned.
 */
export function runtimeExecutable(mainExecutable: string): string {
  const name = basename(mainExecutable)
  const contents = dirname(dirname(mainExecutable))
  const helper = join(contents, 'Frameworks', `${name} Helper.app`, 'Contents', 'MacOS', `${name} Helper`)
  return existsSync(helper) ? helper : mainExecutable
}

/** How to tell whether a running daemon is an older build, and whether it may
 *  be replaced right now. */
export interface RuntimeUpgrade {
  /** Fingerprint of the script this app would spawn (runtime/build.ts). */
  build?: string
  /** True when the daemon holds nothing a restart would interrupt. */
  idle: (rpc: RuntimeRpcClient) => Promise<boolean>
  /** Injected by tests; production retries conservatively. */
  retryAfterMs?: number
}

/** A per-user-data daemon; dev worktrees do not attach to production runtimes. */
export class PersistentRuntimeClient extends RuntimeRpcClient {
  private starting?: Promise<void>
  private disposed = false
  private retry?: ReturnType<typeof setTimeout>
  private upgrade?: RuntimeUpgrade
  private buildChecked = false
  private replacing = false
  private upgradeRetry?: ReturnType<typeof setTimeout>
  private upgradeAttempts = 0
  constructor(private root: string, private entry: string, private executable = runtimeExecutable(process.execPath)) {
    super(runtimeSocket(root))
    this.on('disconnected', () => this.scheduleReconnect())
  }
  /**
   * REPLACE A DAEMON LEFT OVER FROM AN OLDER BUILD, once, on first connect.
   *
   * Task daemons survive quits and reinstalls, and a new app used to attach to
   * whatever was running — so a fix inside the daemon (every Codex and Claude
   * session runs there) never reached the user until a reboot. Measured
   * 2026-09-18: Codex daemons from Sep 16 still serving after a Sep 18
   * install, which is why the managed-laptop fix in 1.5.29 did nothing.
   *
   * Only an idle daemon is replaced; a turn in flight finishes on the build
   * that started it and the next launch checks again. Conversations live on
   * disk, so the fresh daemon resumes them exactly as after a reboot — and
   * this runs before anything attaches. The Agent's own router does the same
   * for its process (runtime/agent-routing.ts).
   */
  replaceStaleBuild(upgrade: RuntimeUpgrade): this { this.upgrade = upgrade; return this }

  private async replacedStale(): Promise<boolean> {
    const upgrade = this.upgrade
    if (!upgrade?.build || this.buildChecked) return false
    const attempt = ++this.upgradeAttempts
    const hello = await this.call<{ build?: string; pid?: number }>('hello').catch(() => ({} as { build?: string; pid?: number }))
    const fields = { root: this.root, running: hello.build ?? 'unreported', expected: upgrade.build, attempt }
    if (hello.build === upgrade.build) {
      this.buildChecked = true
      diagnostic('runtime-build-current', fields)
      return false
    }
    if (!(await upgrade.idle(this).catch(() => false))) {
      diagnostic('runtime-stale-build-deferred', fields)
      this.scheduleUpgradeRetry()
      return false
    }
    this.buildChecked = true
    diagnostic('runtime-stale-build-replaced', fields)
    this.replacing = true
    try {
      try { await this.call('runtime.shutdown') }
      catch { if (hello.pid && hello.pid > 0 && hello.pid !== process.pid) { try { process.kill(hello.pid, 'SIGTERM') } catch { /* already gone */ } } }
      // Wait for the PROCESS, not just the socket: a daemon still exiting
      // holds the listening socket, and a fresh one would fail to bind.
      for (let i = 0; i < 100; i++) {
        const alive = hello.pid ? (() => { try { process.kill(hello.pid!, 0); return true } catch { return false } })() : this.connected
        if (!alive) break
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      super.disconnect()
    } finally { this.replacing = false }
    return true
  }

  private scheduleUpgradeRetry(): void {
    if (this.disposed || this.buildChecked || this.replacing || this.upgradeRetry) return
    const delayMs = this.upgrade?.retryAfterMs ?? 30_000
    diagnostic('runtime-stale-build-retry-scheduled', { root: this.root, delayMs, attempt: this.upgradeAttempts + 1 })
    this.upgradeRetry = setTimeout(() => {
      this.upgradeRetry = undefined
      void this.replacedStale().then(async replaced => {
        if (!replaced) return
        await this.connect()
        if (!this.disposed) this.emit('reconnected')
      }).catch(error => {
        diagnostic('runtime-stale-build-retry-failed', { root: this.root, error: (error as Error).message, attempt: this.upgradeAttempts })
        this.scheduleUpgradeRetry()
      })
    }, delayMs)
    this.upgradeRetry.unref()
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.retry || this.replacing) return
    this.retry = setTimeout(() => {
      this.retry = undefined
      void this.connect().then(() => { if (!this.disposed) this.emit('reconnected') })
        .catch(() => this.scheduleReconnect())
    }, 1_000)
    this.retry.unref()
  }
  override disconnect(): void {
    this.disposed = true
    if (this.retry) clearTimeout(this.retry)
    if (this.upgradeRetry) clearTimeout(this.upgradeRetry)
    this.retry = undefined
    this.upgradeRetry = undefined
    super.disconnect()
  }
  override connect(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('Runtime client has been disposed'))
    if (this.connected) return Promise.resolve()
    return this.starting ??= this.ensure().finally(() => { this.starting = undefined })
  }
  private async ensure(): Promise<void> {
    try {
      await super.connect()
      if (!(await this.replacedStale())) return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ECONNREFUSED') throw error
    }
    const child = spawn(this.executable, [this.entry, this.root], {
      detached: true, stdio: 'ignore',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })
    let spawnError: Error | undefined
    child.once('error', error => { spawnError = error })
    child.unref()
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError
      try { await super.connect(); return } catch (error) {
        if (!['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
      }
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new Error('Unmute background runtime did not start')
  }
}
