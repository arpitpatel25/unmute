// CDP lane — drives a Chromium/Electron renderer directly over the Chrome
// DevTools Protocol, ported from the proven POC driver
// (docs/superpowers/specs/2026-07-22-computer-use-router-poc/cdp.mjs, see
// MECHANISM.md in the same dir).
//
// WHY THIS LANE EXISTS: wheel/keyboard scroll and SCK screenshots are
// compositor-blocked / stale for an off-Space or backgrounded window — but
// the renderer itself is immune to Space/focus/compositor state. Everything
// here goes through `Runtime.evaluate` / `Input.dispatchKeyEvent` /
// `Page.captureScreenshot` on the app's own CDP debug port, so this lane
// NEVER touches the screen, cursor, or system focus.
//
// Gotcha carried over from the POC: rich-text editors (Notion's
// Lexical/Slate-style editor) silently discard one-shot `Input.insertText`.
// `typeKeys` therefore sends REAL per-character `Input.dispatchKeyEvent`
// keyDown+keyUp pairs, after focusing the last `[contenteditable="true"]`
// and collapsing the selection to its end.
//
// Target selection: CDP target ids are per-webContents and follow in-tab
// navigation (an SPA nav does not mint a new target). We cache the chosen
// target id PER APP so repeated calls keep driving the same tab even as its
// URL/title changes; if that id disappears from the target list (tab
// closed/reloaded away), we fall back to re-picking the first non-"Tab Bar"
// page target.
import WsPkg from 'ws'
import { createLogger } from '../../log'

// Prefer the runtime's BUILT-IN global WebSocket — Node 22+ / Electron 40's
// main process both expose it, and it's the exact implementation the POC
// proved against Notion. The `ws` package is kept only as a fallback for
// runtimes without the global: in the packaged Electron main process the `ws`
// client hangs on connect (the standalone Node client does not), so the global
// is both more portable and the one that actually works in the app.
const WebSocketImpl: any = (globalThis as any).WebSocket ?? WsPkg

const log = createLogger('cua-cdp')

export type CdpTarget = {
  id: string
  type: string
  title: string
  url: string
  webSocketDebuggerUrl: string
}

export type CdpSocket = {
  send(method: string, params?: object): Promise<any>
  close(): void
}

export type CdpTransport = {
  listTargets(port: number): Promise<CdpTarget[]>
  connect(wsUrl: string): Promise<CdpSocket>
}

// Finds the largest scrollable container on the page (same heuristic as the
// POC: any element whose computed overflow-y is auto/scroll and whose
// content meaningfully overflows its box, biggest first).
const SCROLLER_JS = `(() => {
  const cs = [...document.querySelectorAll("*")].filter(e => {
    const s = getComputedStyle(e);
    return /auto|scroll/.test(s.overflowY) && e.scrollHeight > e.clientHeight + 40;
  });
  cs.sort((a, b) => b.scrollHeight - a.scrollHeight);
  return cs[0] || null;
})()`

const SCROLL_BOTTOM_JS = `(() => {
  const s = ${SCROLLER_JS};
  if (!s) return "NO_SCROLLER";
  const before = s.scrollTop;
  s.scrollTop = s.scrollHeight;
  return { before, after: s.scrollTop, scrollHeight: s.scrollHeight, clientHeight: s.clientHeight, atBottom: s.scrollTop + s.clientHeight >= s.scrollHeight - 2 };
})()`

// Focuses the last visible contenteditable and collapses the caret to its
// end, so typeKeys always appends rather than landing wherever focus was.
const FOCUS_LAST_EDITABLE_JS = `(() => {
  const eds = [...document.querySelectorAll('[contenteditable="true"]')].filter(e => e.offsetParent !== null);
  const el = eds[eds.length - 1];
  if (!el) return false;
  el.focus();
  const r = document.createRange(); r.selectNodeContents(el); r.collapse(false);
  const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
  return true;
})()`

function clickTextJs(text: string): string {
  return `(() => {
  const want = ${JSON.stringify(text)};
  const els = [...document.querySelectorAll('a, [role="link"], .notion-page-block, [data-block-id]')];
  let best = null, bestLen = 1e9;
  for (const e of els) {
    const txt = (e.textContent || '').trim();
    if (txt.includes(want) && txt.length < bestLen) { best = e; bestLen = txt.length; }
  }
  if (!best) return "NO_MATCH";
  const a = best.closest('a') || best.querySelector('a') || best;
  a.scrollIntoView({block:'center'});
  a.click();
  return { clicked: (best.textContent||'').trim().slice(0,60) };
})()`
}

const MODIFIER_BITS: Record<string, number> = {
  cmd: 4,
  meta: 4,
  ctrl: 2,
  shift: 8,
  alt: 1,
  option: 1,
}

function modifiersToBitmask(modifiers: string[]): number {
  return modifiers.reduce((acc, m) => acc | (MODIFIER_BITS[m] ?? 0), 0)
}

type KeyEventShape = { key: string; code?: string; windowsVirtualKeyCode?: number; text?: string }

// CDP key params for the named keys `key()` accepts, keyed by the SAME
// name callers pass in. Anything not listed here falls back to a
// single-printable-character dispatch (see `key()` below).
const NAMED_KEYS: Record<string, KeyEventShape> = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  Home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
  End: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
  Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
}

function defaultTransport(): CdpTransport {
  return {
    async listTargets(port: number): Promise<CdpTarget[]> {
      const res = await fetch(`http://127.0.0.1:${port}/json`)
      if (!res.ok) throw new Error(`CDP /json on port ${port} returned ${res.status}`)
      return (await res.json()) as CdpTarget[]
    },
    connect(wsUrl: string): Promise<CdpSocket> {
      // Uses the WHATWG event API (addEventListener/event.data) so the SAME
      // code drives both the built-in global WebSocket and the `ws` package.
      const CONNECT_TIMEOUT_MS = 10_000
      const REQUEST_TIMEOUT_MS = 20_000
      return new Promise((resolve, reject) => {
        const ws: any = new WebSocketImpl(wsUrl)
        let nextId = 1
        let connected = false
        const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()

        // A socket error/close/timeout must fail out in-flight send()s so a
        // caller never hangs forever (and withSocket's `finally { close() }`
        // can run). The connect timeout guards the case the packaged `ws`
        // client exhibited: neither 'open' nor 'error' ever fires.
        function rejectAllPending(reason: Error): void {
          for (const p of pending.values()) { clearTimeout(p.timer); p.reject(reason) }
          pending.clear()
        }
        const connectTimer = setTimeout(() => {
          if (!connected) { try { ws.close() } catch { /* noop */ } ; reject(new Error(`CDP socket did not open within ${CONNECT_TIMEOUT_MS}ms: ${wsUrl}`)) }
        }, CONNECT_TIMEOUT_MS)

        ws.addEventListener('open', () => {
          connected = true
          clearTimeout(connectTimer)
          resolve({
            send(method: string, params: object = {}): Promise<any> {
              return new Promise((res, rej) => {
                const id = nextId++
                const timer = setTimeout(() => { pending.delete(id); rej(new Error(`CDP request '${method}' timed out after ${REQUEST_TIMEOUT_MS}ms`)) }, REQUEST_TIMEOUT_MS)
                pending.set(id, { resolve: res, reject: rej, timer })
                ws.send(JSON.stringify({ id, method, params }))
              })
            },
            close() {
              try { ws.close() } catch { /* already closed */ }
            },
          })
        })
        ws.addEventListener('message', (ev: any) => {
          const raw = typeof ev.data === 'string' ? ev.data : (ev.data?.toString?.() ?? '')
          let msg: { id?: number; result?: unknown; error?: { code: number; message: string } }
          try { msg = JSON.parse(raw) } catch { return }
          if (typeof msg.id !== 'number') return // CDP event, not a reply — ignore
          const p = pending.get(msg.id)
          if (!p) return
          clearTimeout(p.timer)
          pending.delete(msg.id)
          // Resolve with the FULL JSON-RPC message (not just msg.result) —
          // consumers (eval/screenshot/scrollBottom/clickText/throwOnException)
          // all read res.result.* off of it.
          if (msg.error) p.reject(new Error(`CDP error ${msg.error.code}: ${msg.error.message}`))
          else p.resolve(msg)
        })
        ws.addEventListener('error', (ev: any) => {
          clearTimeout(connectTimer)
          const emsg = ev?.message || ev?.error?.message || 'unknown'
          if (!connected) { reject(new Error(`CDP socket error before open: ${emsg}`)); return }
          rejectAllPending(new Error(`CDP socket error: ${emsg}`))
        })
        ws.addEventListener('close', () => {
          clearTimeout(connectTimer)
          if (!connected) { reject(new Error('CDP socket closed before it opened')); return }
          rejectAllPending(new Error('CDP socket closed'))
        })
      })
    },
  }
}

export class CdpLane {
  private readonly transport: CdpTransport
  /** Chosen page target id per app — keeps driving the same webContents
   *  across in-tab (SPA) navigation. See file header. */
  private readonly targetIds = new Map<string, string>()

  constructor(private readonly portFor: (app: string) => number | undefined, transport?: CdpTransport) {
    this.transport = transport ?? defaultTransport()
  }

  async eval(app: string, js: string): Promise<unknown> {
    return this.withSocket(app, async (socket) => {
      const res: any = await socket.send('Runtime.evaluate', { expression: js, returnByValue: true, awaitPromise: true })
      this.throwOnException(app, res)
      return res?.result?.result?.value ?? res?.result?.result
    })
  }

  async typeKeys(app: string, text: string): Promise<void> {
    await this.withSocket(app, async (socket) => {
      await socket.send('Runtime.evaluate', { expression: FOCUS_LAST_EDITABLE_JS, returnByValue: true })
      for (const ch of text) {
        await socket.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, unmodifiedText: ch, key: ch })
        await socket.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch })
      }
    })
  }

  async screenshot(app: string): Promise<Buffer> {
    return this.withSocket(app, async (socket) => {
      await socket.send('Page.enable')
      const res: any = await socket.send('Page.captureScreenshot', { format: 'png' })
      const data = res?.result?.data
      if (typeof data !== 'string') throw new Error(`CDP screenshot of ${app} returned no image data`)
      return Buffer.from(data, 'base64')
    })
  }

  async scrollBottom(app: string): Promise<{ before: number; after: number; atBottom: boolean }> {
    return this.withSocket(app, async (socket) => {
      const res: any = await socket.send('Runtime.evaluate', { expression: SCROLL_BOTTOM_JS, returnByValue: true })
      this.throwOnException(app, res)
      const value = res?.result?.result?.value
      if (value === 'NO_SCROLLER') throw new Error(`no scrollable container found in ${app}`)
      return value
    })
  }

  async clickText(app: string, text: string): Promise<{ clicked: string }> {
    return this.withSocket(app, async (socket) => {
      const res: any = await socket.send('Runtime.evaluate', { expression: clickTextJs(text), returnByValue: true })
      this.throwOnException(app, res)
      const value = res?.result?.result?.value
      if (value === 'NO_MATCH') throw new Error(`no element matching text ${JSON.stringify(text)} found in ${app}`)
      return value
    })
  }

  async click(app: string, x: number, y: number): Promise<{ clicked: { x: number; y: number } }> {
    return this.withSocket(app, async (socket) => {
      await socket.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
      await socket.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
      return { clicked: { x, y } }
    })
  }

  async key(app: string, key: string, modifiers: string[] = []): Promise<{ key: string; modifiers: string[] }> {
    return this.withSocket(app, async (socket) => {
      const bitmask = modifiersToBitmask(modifiers)
      const shape: KeyEventShape | undefined = NAMED_KEYS[key] ?? (key.length === 1 ? { key, text: key } : undefined)
      if (!shape) throw new Error(`CDP key: unsupported key ${JSON.stringify(key)}`)
      const includeText = shape.text !== undefined

      const downParams: Record<string, unknown> = { type: 'keyDown', key: shape.key, modifiers: bitmask }
      if (shape.code !== undefined) downParams.code = shape.code
      if (shape.windowsVirtualKeyCode !== undefined) downParams.windowsVirtualKeyCode = shape.windowsVirtualKeyCode
      if (includeText) downParams.text = shape.text
      await socket.send('Input.dispatchKeyEvent', downParams)

      const upParams: Record<string, unknown> = { type: 'keyUp', key: shape.key, modifiers: bitmask }
      if (shape.code !== undefined) upParams.code = shape.code
      if (shape.windowsVirtualKeyCode !== undefined) upParams.windowsVirtualKeyCode = shape.windowsVirtualKeyCode
      await socket.send('Input.dispatchKeyEvent', upParams)

      return { key, modifiers }
    })
  }

  async drag(app: string, x1: number, y1: number, x2: number, y2: number): Promise<{ from: { x1: number; y1: number }; to: { x2: number; y2: number } }> {
    return this.withSocket(app, async (socket) => {
      await socket.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1, y: y1 })
      await socket.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x1, y: y1, button: 'left', clickCount: 1 })
      await socket.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x2, y: y2 })
      await socket.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x2, y: y2, button: 'left', clickCount: 1 })
      return { from: { x1, y1 }, to: { x2, y2 } }
    })
  }

  async navigate(app: string, url: string): Promise<{ navigated: string }> {
    return this.withSocket(app, async (socket) => {
      await socket.send('Page.enable')
      await socket.send('Page.navigate', { url })
      return { navigated: url }
    })
  }

  async scroll(app: string, deltaY: number, deltaX = 0, x = 0, y = 0): Promise<{ deltaY: number; deltaX: number }> {
    return this.withSocket(app, async (socket) => {
      await socket.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY })
      return { deltaY, deltaX }
    })
  }

  async waitFor(app: string, js: string, timeoutMs = 5000): Promise<{ ok: true }> {
    const start = Date.now()
    for (;;) {
      const value = await this.eval(app, js)
      if (value) return { ok: true }
      if (Date.now() - start >= timeoutMs) throw new Error(`waitFor timed out after ${timeoutMs}ms`)
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }

  async targets(app: string): Promise<{ id: string; title: string; url: string }[]> {
    const port = this.portFor(app)
    if (port === undefined) throw new Error(`${app} is not armed for CDP (no debug port)`)
    const pages = (await this.transport.listTargets(port)).filter((t) => t.type === 'page')
    return pages.map(({ id, title, url }) => ({ id, title, url }))
  }

  private throwOnException(app: string, res: any): void {
    const details = res?.result?.exceptionDetails
    if (details) {
      const desc = details.exception?.description ?? JSON.stringify(details)
      throw new Error(`CDP eval error in ${app}: ${desc}`)
    }
  }

  private async withSocket<T>(app: string, fn: (socket: CdpSocket) => Promise<T>): Promise<T> {
    const target = await this.resolveTarget(app)
    const socket = await this.transport.connect(target.webSocketDebuggerUrl)
    try {
      return await fn(socket)
    } finally {
      socket.close()
    }
  }

  private async resolveTarget(app: string): Promise<CdpTarget> {
    const port = this.portFor(app)
    if (port === undefined) throw new Error(`${app} is not armed for CDP (no debug port)`)
    const pages = (await this.transport.listTargets(port)).filter((t) => t.type === 'page')

    const cachedId = this.targetIds.get(app)
    let target = cachedId ? pages.find((t) => t.id === cachedId) : undefined
    if (!target) {
      target = pages.find((t) => t.title !== 'Tab Bar')
      if (!target) throw new Error(`no CDP page target found for ${app} on port ${port}`)
      if (cachedId) log.event('cdp-target-rebound', { app, cachedId, reboundId: target.id })
    }
    this.targetIds.set(app, target.id)
    return target
  }
}
