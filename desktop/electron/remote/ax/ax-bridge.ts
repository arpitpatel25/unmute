// ax-bridge — the boundary between the MCP server (JS, main thread) and the
// native AX engine (unmute-native-ax addon).
//
// WHY a worker thread:
//   AX tree walks can take up to the 8s messaging timeout on a slow Electron
//   app. Running them on the Electron MAIN thread would block it — and this is
//   the same process that handles dictation, whose latency is sacred (never do
//   heavy main-thread work that could stall audio). So every AX call runs on a
//   dedicated worker thread. The worker is SAME-PROCESS (same PID) as the .app
//   bundle, so it still inherits the signed bundle's Accessibility TCC grant —
//   the whole reason we load the addon in-process rather than as a child binary
//   (the unmute-native-paste lesson). A worker thread does not change PID.
//   (The addon is N-API / node-addon-api, i.e. context-aware, so loading it in
//   a worker's isolated context is safe — no "Module did not self-register".)
//
//   Concurrency: a single worker serializes AX access (safest — AX has global-
//   ish state), which is fine because our win is N *Claude sessions* driving N
//   *apps*, not N threads hammering one app. Each session's calls queue here and
//   run back-to-back in milliseconds; there is no machine-wide lock like the
//   built-in computer-use holds, so sessions never block each other for long.
//
// WHY we pass an ABSOLUTE addon path into the worker:
//   The worker source is built inline and spawned with { eval: true } so we
//   don't depend on a separate .js file surviving the bundle/copy pipeline. But
//   an eval-worker has NO on-disk location, so a bare `require('unmute-native-ax')`
//   inside it cannot be resolved — it fails with
//     "Cannot find module 'unmute-native-ax'"  (require stack: /[worker eval])
//   which is exactly the bug that took the feature down. The fix: resolve the
//   addon's ENTRY FILE to an absolute path on the MAIN thread (where normal
//   module resolution works) and hand it to the worker via workerData, so the
//   worker does `require(absolutePath)` — absolute paths need no resolution root.
//
// FALLBACK (now actually wired): on startup we PING the worker and check whether
// the addon loaded inside it. If it did not — or the worker can't start — we
// disable the worker and run calls synchronously on the main-thread handle
// (this.direct) instead. The feature degrades to still-correct rather than
// hard-failing (which previously forced callers all the way back to focus-
// stealing AppleScript). The old code routed to the worker whenever it merely
// EXISTED, so a started-but-addon-less worker never fell back — that dead path
// is what this readiness gate fixes.

import { Worker } from 'node:worker_threads'
import { createLogger } from '../log'

const log = createLogger('ax')

/** Sentinel id for the startup readiness ping — kept out of the 1.. call range. */
const PING_ID = -1

/** The addon's method surface. Each maps 1:1 to a native function; args are
 *  passed positionally. Results are plain JSON objects (see ax.mm). */
export type AxMethod =
  | 'isTrusted' | 'processInfo' | 'listApps' | 'frontmostApp'
  | 'find' | 'getTree' | 'press' | 'setValue' | 'typeText' | 'fillForm' | 'menuAction' | 'captureWindow'
  // Real synthetic input. Needed for controls that answer to nothing else:
  // Claude Desktop's model popup ignores AXPress AND AXShowMenu, and the menu
  // it opens is invisible to accessibility, so it is driven by a click at its
  // position followed by arrow keys.
  | 'clickPoint' | 'sendKeys'
  // Apple-Event replacements. Both of these were `osascript -e 'tell
  // application "X" …'`, which macOS gates behind Automation and prompts for
  // PER TARGET APP. Routed through the addon they cost no TCC grant beyond the
  // Accessibility one the app already holds — and they belong on the worker for
  // the usual reason: activeTabURL walks a browser tree and a Chromium browser
  // answers slowly (measured: ~260ms on live Chrome).
  | 'activeTabURL' | 'quitApp'

export interface AxBridge {
  call(method: AxMethod, args: unknown[]): Promise<any>
  trusted(): Promise<boolean>
  dispose(): void
}

interface Pending { resolve(v: any): void; reject(e: Error): void }

/** Resolve the addon's entry file to an absolute path on the main thread, where
 *  module resolution works. This absolute path is what the eval-worker requires
 *  (it cannot resolve the bare package name itself). Returns null if the package
 *  isn't installed/resolvable — in which case both the worker and the direct
 *  handle will be unavailable and calls degrade with a clear error. */
function resolveAddonEntry(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require.resolve('unmute-native-ax')
  } catch (e) {
    log.warn('could not resolve unmute-native-ax entry path', { error: (e as Error).message })
    return null
  }
}

/** Directly-required addon (main-thread fallback path + synchronous trusted check). */
function loadAddonDirect(): any | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('unmute-native-ax')
  } catch (e) {
    log.warn('native-ax addon failed to load (main thread)', { error: (e as Error).message })
    return null
  }
}

/** Build the worker source inline so we don't depend on a separate .js file
 *  surviving the bundle/copy pipeline. It requires the addon by the ABSOLUTE
 *  path passed in workerData (see the WHY note above), then pumps
 *  {id, method, args} → {id, ok|error}. Same-PID, so TCC identity is intact. */
const WORKER_SRC = `
const { parentPort, workerData } = require('node:worker_threads')
let addon = null, loadError = null
try {
  const entry = workerData && workerData.addonEntry
  addon = entry ? require(entry) : require('unmute-native-ax')
} catch (e) { loadError = String(e && e.message || e) }
parentPort.on('message', (m) => {
  if (m.method === '__ping') { parentPort.postMessage({ id: m.id, ok: addon ? 'ready' : 'noaddon', error: loadError }); return }
  if (!addon) { parentPort.postMessage({ id: m.id, error: 'native-ax addon not loaded: ' + loadError }); return }
  try {
    const fn = addon[m.method]
    if (typeof fn !== 'function') { parentPort.postMessage({ id: m.id, error: 'unknown method ' + m.method }); return }
    const res = fn.apply(addon, m.args || [])
    parentPort.postMessage({ id: m.id, ok: res })
  } catch (e) {
    parentPort.postMessage({ id: m.id, error: String(e && e.message || e) })
  }
})
`

class WorkerBridge implements AxBridge {
  private worker: Worker | null = null
  private seq = 0
  private pending = new Map<number, Pending>()
  private direct: any | null
  /** Resolves once we know whether the worker's addon loaded. All calls await
   *  this so none race the startup probe. */
  private ready: Promise<void>
  private markReady!: () => void

  constructor() {
    this.direct = loadAddonDirect()
    this.ready = new Promise((res) => { this.markReady = res })

    const addonEntry = resolveAddonEntry()
    try {
      this.worker = new Worker(WORKER_SRC, { eval: true, workerData: { addonEntry } })
      this.worker.on('message', (m: { id: number; ok?: any; error?: string }) => {
        if (m.id === PING_ID) return // handled by the readiness probe below
        const p = this.pending.get(m.id)
        if (!p) return
        this.pending.delete(m.id)
        if (m.error) p.reject(new Error(m.error))
        else p.resolve(m.ok)
      })
      this.worker.on('error', (e: Error) => { log.warn('ax worker error', { error: e.message }); this.failAll(e) })
      this.worker.on('exit', (code) => { if (code !== 0) log.warn('ax worker exited', { code }); this.worker = null })
      this.probeWorker()
    } catch (e) {
      log.warn('ax worker could not start — using main-thread fallback', { error: (e as Error).message })
      this.worker = null
      this.markReady()
    }
  }

  /** Ping the worker once at startup. If its addon didn't load (or it never
   *  answers), disable the worker so call() uses the main-thread handle. This
   *  is the fallback that was documented but never actually wired. */
  private probeWorker(): void {
    const w = this.worker
    if (!w) { this.markReady(); return }
    const done = (usable: boolean, detail?: string) => {
      clearTimeout(timer)
      w.off('message', onMsg)
      if (!usable) {
        log.warn('ax worker addon not loaded — using main-thread fallback', { error: detail, hasDirect: !!this.direct })
        this.disableWorker()
      } else {
        log.event('ax-worker-ready')
      }
      this.markReady()
    }
    const onMsg = (m: { id: number; ok?: any; error?: string }) => {
      if (m.id !== PING_ID) return
      done(m.ok === 'ready', m.error)
    }
    const timer = setTimeout(() => done(false, 'ping timed out'), 5_000)
    w.on('message', onMsg)
    try { w.postMessage({ id: PING_ID, method: '__ping' }) }
    catch (e) { done(false, (e as Error).message) }
  }

  private disableWorker(): void {
    const w = this.worker
    this.worker = null
    try { w?.terminate() } catch { /* best-effort */ }
  }

  private failAll(e: Error) {
    for (const p of this.pending.values()) p.reject(e)
    this.pending.clear()
  }

  async call(method: AxMethod, args: unknown[]): Promise<any> {
    // Wait for the startup probe so we never route to a worker that turned out
    // to have no addon. Prefer the worker; fall back to direct main-thread call.
    await this.ready
    if (this.worker) {
      const id = ++this.seq
      const worker = this.worker
      return new Promise((resolve, reject) => {
        // Safety timeout slightly above the addon's 8s AX messaging timeout.
        const t = setTimeout(() => {
          if (this.pending.delete(id)) reject(new Error(`ax ${method} timed out`))
        }, 12_000)
        this.pending.set(id, {
          resolve: (v: any) => { clearTimeout(t); resolve(v) },
          reject: (e: Error) => { clearTimeout(t); reject(e) },
        })
        worker.postMessage({ id, method, args })
      })
    }
    if (this.direct && typeof this.direct[method] === 'function') {
      return this.direct[method](...args)
    }
    throw new Error('native-ax unavailable (addon did not load in the worker or on the main thread)')
  }

  async trusted(): Promise<boolean> {
    // Cheap + synchronous on the addon; use direct handle if we have it,
    // else round-trip the worker (call() awaits readiness for us).
    if (this.direct && typeof this.direct.isTrusted === 'function') {
      try { return this.direct.isTrusted() === true } catch { /* fall through */ }
    }
    try { return (await this.call('isTrusted', [])) === true } catch { return false }
  }

  /** Preflight signal: resolves to how the engine is running so init can log /
   *  surface a broken build instead of it failing silently at first use. */
  async health(): Promise<{ mode: 'worker' | 'main-thread' | 'unavailable'; direct: boolean }> {
    await this.ready
    const direct = !!this.direct
    const mode = this.worker ? 'worker' : direct ? 'main-thread' : 'unavailable'
    return { mode, direct }
  }

  dispose(): void {
    try { this.worker?.terminate() } catch { /* best-effort */ }
    this.worker = null
    this.failAll(new Error('bridge disposed'))
  }
}

let singleton: AxBridge | null = null

/** Process-wide AX bridge (lazy). One worker for the whole app. */
export function getAxBridge(): AxBridge {
  if (!singleton) singleton = new WorkerBridge()
  return singleton
}

/** Preflight helper: returns how the AX engine actually loaded, or null if the
 *  active bridge doesn't report health (e.g. a test fake). Safe to call at init
 *  to log worker vs main-thread vs unavailable. */
export async function axBridgeHealth(): Promise<{ mode: 'worker' | 'main-thread' | 'unavailable'; direct: boolean } | null> {
  const b = getAxBridge() as Partial<WorkerBridge>
  return typeof b.health === 'function' ? b.health() : null
}

/** For tests: inject a fake bridge. */
export function __setAxBridge(b: AxBridge | null): void { singleton = b }
