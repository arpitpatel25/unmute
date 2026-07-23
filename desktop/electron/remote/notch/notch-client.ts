// NotchClient — spawns the native `unmute-notch` helper and speaks to it over
// line-delimited JSON on stdio (see the plan's IPC protocol).
//
// Mirrors cua/driver-client.ts's spawn discipline: the child is spawned by THIS
// process (Unmute's signed Electron main), so its window inherits the app's
// identity and TCC posture. Unlike the cua client this is fire-and-forget
// (no request/response) — main pushes state, the helper pushes user intents.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface, type Interface } from 'node:readline'
import { EventEmitter } from 'node:events'
import { createLogger } from '../log'

const log = createLogger('notch-client')

// --- Command types (main → helper) ------------------------------------------

export type NotchStateName = 'idle' | 'peek' | 'panel'
export type PanelTaskState = 'needs-user' | 'stuck' | 'errored' | 'ready'

export interface PanelTaskPayload {
  id: string
  title: string
  state: PanelTaskState
  summary?: string
  options?: string[]
  terminalHint?: 'open' | 'collapsed'
}

export type NotchCommand =
  | { type: 'setState'; state: NotchStateName; attention: number; working: number }
  | { type: 'showTask'; task: PanelTaskPayload }
  | { type: 'notchGeometry'; hasNotch: boolean; x: number; y: number; w: number; h: number }
  | { type: 'collapse' }
  | { type: 'quit' }

// --- Event types (helper → main) ---------------------------------------------

export type NotchEvent =
  | { type: 'ready' }
  | { type: 'tap' }
  | { type: 'next' }
  | { type: 'openDashboard' }
  | { type: 'chooseOption'; index: number }
  | { type: 'toggleTerminal'; open: boolean }
  | { type: 'collapsed' }

export interface NotchClientOpts {
  binPath: string
  /** Override for tests: run a fake helper via `node <script>`. */
  binArgs?: string[]
  onExit?: (code: number | null) => void
}

/**
 * Emits: 'event' (NotchEvent), plus the raw event `type` as its own channel
 * (e.g. .on('tap', ...)). Consumers use whichever is convenient.
 */
export class NotchClient extends EventEmitter {
  private child: ChildProcessWithoutNullStreams
  private rl: Interface
  private dead = false

  constructor(private opts: NotchClientOpts) {
    super()
    this.child = spawn(opts.binPath, opts.binArgs ?? [], { stdio: ['pipe', 'pipe', 'pipe'] })
    this.rl = createInterface({ input: this.child.stdout })
    this.rl.on('line', (line) => this.onLine(line))
    this.child.stderr.on('data', (d: Buffer) =>
      log.warn('notch stderr', { text: d.toString().slice(0, 400) }))
    this.child.on('exit', (code) => {
      this.dead = true
      this.opts.onExit?.(code)
    })
    this.child.on('error', (e) => {
      this.dead = true
      log.warn('notch spawn error', { error: e.message })
      this.opts.onExit?.(null)
    })
    // A dying child turns a stdin write into an uncaught 'error' without this.
    this.child.stdin.on('error', (e) => log.warn('notch stdin error', { error: e.message }))
  }

  get alive(): boolean { return !this.dead }

  private onLine(line: string): void {
    const trimmed = line.trim()
    if (!trimmed) return
    let evt: NotchEvent
    try {
      evt = JSON.parse(trimmed) as NotchEvent
    } catch {
      log.warn('notch: bad event line', { line: trimmed.slice(0, 200) })
      return
    }
    if (!evt || typeof (evt as { type?: unknown }).type !== 'string') return
    this.emit('event', evt)
    this.emit(evt.type, evt)
  }

  /** Push a command to the helper. No-op once the child is gone. */
  send(cmd: NotchCommand): void {
    if (this.dead) return
    try {
      this.child.stdin.write(JSON.stringify(cmd) + '\n')
    } catch (e) {
      log.warn('notch send failed', { error: (e as Error).message })
    }
  }

  /** Ask the helper to quit, then hard-kill after a grace period. */
  dispose(): void {
    if (this.dead) return
    this.send({ type: 'quit' })
    const child = this.child
    setTimeout(() => { if (!this.dead) child.kill('SIGTERM') }, 500).unref?.()
  }
}
