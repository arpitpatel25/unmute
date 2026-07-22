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
import WebSocket from 'ws'
import { createLogger } from '../../log'

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

function defaultTransport(): CdpTransport {
  return {
    async listTargets(port: number): Promise<CdpTarget[]> {
      const res = await fetch(`http://127.0.0.1:${port}/json`)
      if (!res.ok) throw new Error(`CDP /json on port ${port} returned ${res.status}`)
      return (await res.json()) as CdpTarget[]
    },
    connect(wsUrl: string): Promise<CdpSocket> {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl)
        let nextId = 1
        const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
        ws.on('open', () => {
          resolve({
            send(method: string, params: object = {}): Promise<any> {
              return new Promise((res, rej) => {
                const id = nextId++
                pending.set(id, { resolve: res, reject: rej })
                ws.send(JSON.stringify({ id, method, params }))
              })
            },
            close() {
              try { ws.close() } catch { /* already closed */ }
            },
          })
        })
        ws.on('message', (data: WebSocket.RawData) => {
          let msg: { id?: number; result?: unknown; error?: { code: number; message: string } }
          try { msg = JSON.parse(data.toString()) } catch { return }
          if (typeof msg.id !== 'number') return // CDP event, not a reply — ignore
          const p = pending.get(msg.id)
          if (!p) return
          pending.delete(msg.id)
          if (msg.error) p.reject(new Error(`CDP error ${msg.error.code}: ${msg.error.message}`))
          else p.resolve(msg.result)
        })
        ws.on('error', (e) => reject(e))
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
