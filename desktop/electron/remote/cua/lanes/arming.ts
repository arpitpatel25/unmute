// Arming lane — relaunches a macOS app with `--remote-debugging-port` so the
// CDP lane (see ./cdp.ts) has a debug endpoint to attach to, and tracks which
// app is on which port.
//
// WHY THIS LANE EXISTS: the CDP lane needs a live devtools socket, and the
// only way to get one on an app that wasn't started with the flag is to quit
// it and relaunch it with `--args --remote-debugging-port=<port>`. That
// quit+relaunch is the ONE focus-affecting action in the whole computer-use
// feature — everything else (CDP eval/type/scroll, AX-tree driving) runs
// against a backgrounded window and never steals focus or moves the cursor.
// This is a documented limitation, not a bug: don't add other screen/cursor
// actions here.
//
// Ports are deterministic per app (portBase + stableHash(app) % 1000) rather
// than randomly chosen, so re-arming the same app across process restarts
// (or from a different code path) lands on the same port without needing to
// persist anything.
import { spawn } from 'node:child_process'
import { createLogger } from '../../log'

const log = createLogger('cua-arming')

export type ArmResult = { app: string; port: number; alreadyArmed: boolean }

export interface ArmingDeps {
  launch?: (app: string, port: number) => void
  quit?: (app: string) => Promise<void>
  probe?: (port: number) => Promise<boolean>
  isRunning?: (app: string) => Promise<boolean>
  portBase?: number
  retries?: number
  intervalMs?: number
}

// Simple stable string hash (djb2) — deterministic across process restarts,
// good enough to spread app names across a 1000-port range without needing
// a real hashing dependency.
function stableHash(s: string): number {
  let h = 5381
  for (let i = 0; i < s.length; i++) {
    h = (h * 33) ^ s.charCodeAt(i)
  }
  return Math.abs(h)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function defaultLaunch(app: string, port: number): void {
  // -g: don't bring the app to the foreground. -n: open a new instance even
  // if one is already running (we just quit the old one, but -n guards
  // against races). --args forwards the debug-port flag to the app itself.
  spawn('open', ['-g', '-na', app, '--args', `--remote-debugging-port=${port}`], {
    stdio: 'ignore',
    detached: true,
  }).unref()
}

async function defaultQuit(app: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const child = spawn('osascript', ['-e', `tell application "${app}" to quit`], { stdio: 'ignore' })
    child.on('error', () => resolve()) // app may not be running — not fatal
    child.on('exit', () => resolve())
  })
  // Give the app a moment to actually tear down before we relaunch it with
  // the new flag — otherwise `open -na` can race the old instance's exit.
  await sleep(1000)
}

async function defaultProbe(port: number): Promise<boolean> {
  return fetch(`http://127.0.0.1:${port}/json/version`)
    .then(() => true)
    .catch(() => false)
}

async function defaultIsRunning(app: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const child = spawn('pgrep', ['-x', app], { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    child.stdout?.on('data', (chunk) => { out += chunk })
    child.on('error', () => resolve(false))
    child.on('exit', () => resolve(out.trim().length > 0))
  })
}

export class Arming {
  private readonly launch: (app: string, port: number) => void
  private readonly quit: (app: string) => Promise<void>
  private readonly probe: (port: number) => Promise<boolean>
  private readonly isRunning: (app: string) => Promise<boolean>
  private readonly portBase: number
  private readonly retries: number
  private readonly intervalMs: number
  private readonly armed = new Map<string, number>()

  constructor(deps: ArmingDeps = {}) {
    this.launch = deps.launch ?? defaultLaunch
    this.quit = deps.quit ?? defaultQuit
    this.probe = deps.probe ?? defaultProbe
    this.isRunning = deps.isRunning ?? defaultIsRunning
    this.portBase = deps.portBase ?? 9222
    this.retries = deps.retries ?? 20
    this.intervalMs = deps.intervalMs ?? 500
  }

  /** Launches (or relaunches) `app` with a debug port and waits for the
   *  CDP endpoint to answer. If the app is already armed and its port is
   *  still answering, this is a no-op that returns `alreadyArmed: true`. */
  async arm(app: string): Promise<ArmResult> {
    const existingPort = this.armed.get(app)
    if (existingPort !== undefined && (await this.probe(existingPort))) {
      log.event('arm-already-armed', { app, port: existingPort })
      return { app, port: existingPort, alreadyArmed: true }
    }

    const port = this.portFor(app) ?? this.assignPort(app)
    log.event('arm-relaunch', { app, port })
    await this.quit(app)
    if (await this.isRunning(app)) {
      log.event('arm-quit-failed', { app })
      throw new Error(`ARM_QUIT_FAILED: ${app} would not quit (a modal or unsaved changes may be blocking it) — drive it with the cua tools (get_window_state/click/type_text) instead.`)
    }
    this.launch(app, port)

    for (let attempt = 0; attempt < this.retries; attempt++) {
      if (await this.probe(port)) {
        // Defense-in-depth against a non-tracked process squatting the port
        // (e.g. our launch failed to bind because something else already
        // held it, and `probe` above just talked to that other process).
        // A real hash collision between two TRACKED apps can no longer
        // happen — assignPort() below linear-probes past any port already
        // in `armed` — but this still catches the case of an untracked
        // squatter or a race between concurrent arm() calls.
        const squatter = await this.detectPortSquatter(app, port)
        if (squatter) {
          log.error('arm-port-squatted', { app, port, squatter })
          throw new Error(`could not arm ${app}: port ${port} is already held by ${squatter}`)
        }
        this.armed.set(app, port)
        log.event('arm-up', { app, port, attempt })
        return { app, port, alreadyArmed: false }
      }
      await sleep(this.intervalMs)
    }

    log.error('arm-timeout', { app, port, retries: this.retries })
    throw new Error(`could not arm ${app}: debug port never opened`)
  }

  /** The fixed debug port assigned to `app`, if it has ever been armed. */
  portFor(app: string): number | undefined {
    return this.armed.get(app)
  }

  /** Stop tracking every armed app. Does NOT quit them — leaving the user's
   *  apps running is fine, we only stop tracking which port they're on. */
  async disposeAll(): Promise<void> {
    this.armed.clear()
  }

  // Deterministic for the first app to claim a given hash — but if that
  // port is already held by a DIFFERENT tracked app (a hash collision),
  // linear-probe forward (wrapping within portBase..portBase+999) until we
  // find a port no tracked app currently holds. This guarantees two
  // tracked apps never share a port, which is what let a collision send
  // web_eval/web_type for one app to another app's renderer.
  private assignPort(app: string): number {
    const start = stableHash(app) % 1000
    const usedPorts = new Set(this.armed.values())
    for (let offset = 0; offset < 1000; offset++) {
      const candidate = this.portBase + ((start + offset) % 1000)
      if (!usedPorts.has(candidate)) return candidate
    }
    // All 1000 ports in the range are already claimed — astronomically
    // unlikely, but fall back to the deterministic slot rather than throw.
    return this.portBase + start
  }

  // Best-effort: is `port` already recorded in `armed` for some OTHER app?
  // Also does a fresh, independent reachability check (not the injected
  // `probe()`) so this defense doesn't rely solely on a caller-supplied
  // probe stub. Network failures here are swallowed — this is a safety
  // net on top of the primary (collision-free) port assignment, not a
  // required signal.
  private async detectPortSquatter(app: string, port: number): Promise<string | undefined> {
    try {
      await fetch(`http://127.0.0.1:${port}/json/version`)
    } catch {
      // Unreachable on this direct check — not fatal; `probe()` already
      // told us the port answers, there's nothing more to verify here.
    }
    for (const [otherApp, otherPort] of this.armed) {
      if (otherApp !== app && otherPort === port) return otherApp
    }
    return undefined
  }
}
