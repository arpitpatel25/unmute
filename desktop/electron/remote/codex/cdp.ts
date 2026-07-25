// Unmute Remote — Codex desktop WRITE side: a minimal CDP client.
//
// WHY CDP AND NOT THE APP-SERVER PROTOCOL. Codex ships an official JSON-RPC
// app-server (`codex app-server`, schema via `generate-json-schema`) and it is
// genuinely better on paper — headless, push notifications, rename, approvals.
// We tested it end to end on 2026-07-25 and it is NOT usable as the write lane:
// a turn sent through a second app-server client lands in the store (the rollout
// grows, the agent answers) but the RUNNING desktop app never shows it — the UI
// only picked the thread up after a full app restart. Two writers, one thread,
// no synchronisation. Since Unmute's whole promise is "tap through and you are
// in the real chat", a write the user cannot see is worse than no write.
// So: the app the user looks at is the ONLY writer. Reads come from disk
// (rollout.ts), which is safe precisely because there is exactly one writer.
//
// TWO NON-OBVIOUS REQUIREMENTS, both measured:
//   1. Emulation.setFocusEmulationEnabled(true) on connect. Without it every
//      Input.dispatchMouseEvent on the backgrounded window blocks ~5s
//      (measured 5331ms → 176ms). It does NOT raise the window.
//   2. A freshly created thread's DOM id is a transient
//      `local:client-new-thread:<uuid>`; the durable id only appears later.
//      resolveThreadId() waits for the real one instead of persisting the fake.
//
// The DOM hooks (`data-app-action-*`) are shipped by OpenAI as an automation
// surface, so they are stable by intent rather than by accident.

import { createLogger } from '../log'

const log = createLogger('codex-cdp')

const CONNECT_TIMEOUT_MS = 10_000
const REQUEST_TIMEOUT_MS = 20_000

// Packaged Electron may lack a global WebSocket; fall back to `ws` like the
// computer-use lane does.
async function getWebSocketImpl(): Promise<any> {
  const g = (globalThis as any).WebSocket
  if (g) return g
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore -- 'ws' ships no types here; same fallback the cua CDP lane uses.
  const mod = await import('ws')
  return (mod as any).default ?? mod
}

export interface CdpTarget { id: string; title: string; url: string; webSocketDebuggerUrl: string; type: string }

/** Is a Codex desktop CDP endpoint live on this port? */
export async function isArmed(port: number, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) })
    return res.ok
  } catch { return false }
}

async function mainTarget(port: number, fetchImpl: typeof fetch = fetch): Promise<CdpTarget | null> {
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(3000) })
    const list = (await res.json()) as CdpTarget[]
    // The app renders several page targets (avatar overlay etc.); the main app
    // window is the bare index.
    return list.find((t) => t.type === 'page' && t.url === 'app://-/index.html')
      ?? list.find((t) => t.type === 'page') ?? null
  } catch { return null }
}

/** A live CDP session against the Codex desktop window. */
export class CodexCdp {
  private ws: any = null
  private nextId = 1
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()

  constructor(private readonly port: number, private readonly fetchImpl: typeof fetch = fetch) {}

  get connected(): boolean { return !!this.ws }

  async connect(): Promise<void> {
    if (this.ws) return
    const target = await mainTarget(this.port, this.fetchImpl)
    if (!target) throw new Error(`CODEX_NOT_ARMED: no CDP page target on port ${this.port}`)
    const WebSocketImpl = await getWebSocketImpl()
    const ws = new WebSocketImpl(target.webSocketDebuggerUrl)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP connect timeout')), CONNECT_TIMEOUT_MS)
      ws.addEventListener('open', () => { clearTimeout(timer); resolve() })
      ws.addEventListener('error', (e: any) => { clearTimeout(timer); reject(new Error(`CDP connect error: ${e?.message ?? 'unknown'}`)) })
    })
    ws.addEventListener('message', (ev: any) => {
      let msg: any
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)) } catch { return }
      if (msg.id === undefined) return
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.error) p.reject(new Error(`CDP error ${msg.error.code}: ${msg.error.message}`))
      else p.resolve(msg)
    })
    ws.addEventListener('close', () => { this.ws = null })
    this.ws = ws
    // MANDATORY: un-throttle the backgrounded renderer. Without this every input
    // dispatch blocks ~5s. Does not raise or focus the window.
    await this.send('Page.enable')
    await this.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    log.event('cdp-connected', { port: this.port })
  }

  close(): void {
    try { this.ws?.close() } catch { /* best-effort */ }
    this.ws = null
    for (const [, p] of this.pending) p.reject(new Error('CDP closed'))
    this.pending.clear()
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    if (!this.ws) return Promise.reject(new Error('CDP not connected'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)) }, REQUEST_TIMEOUT_MS)
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v) },
        reject: (e) => { clearTimeout(timer); reject(e) },
      })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  /** Evaluate JS in the page and return the value (undefined on exception). */
  async evaluate<T = unknown>(expression: string): Promise<T | undefined> {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true })
    if (r?.result?.exceptionDetails) {
      log.warn('cdp-eval-exception', { detail: String(r.result.exceptionDetails?.exception?.description ?? '').slice(0, 200) })
      return undefined
    }
    return r?.result?.result?.value as T
  }

  /** A TRUSTED click. Radix/React ignore synthetic el.click(); these are real. */
  async click(x: number, y: number): Promise<void> {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  }

  /** Click an element by exact aria-label. Returns false when absent. */
  async clickAriaLabel(label: string): Promise<boolean> {
    const box = await this.evaluate<string>(`(() => {
      const el = [...document.querySelectorAll('button,[role=button],a,[role=menuitem]')]
        .find(b => (b.getAttribute('aria-label') || '').trim() === ${JSON.stringify(label)});
      if (!el) return '';
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
    })()`)
    if (!box) return false
    const { x, y } = JSON.parse(box)
    await this.click(x, y)
    return true
  }

  /** Click an element by exact text content, preferring an open dialog. */
  async clickText(text: string): Promise<boolean> {
    const box = await this.evaluate<string>(`(() => {
      const scope = document.querySelector('[role=dialog]') || document;
      const el = [...scope.querySelectorAll('button,[role=button],[role=menuitem]')]
        .find(b => (b.textContent || '').trim() === ${JSON.stringify(text)});
      if (!el) return '';
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
    })()`)
    if (!box) return false
    const { x, y } = JSON.parse(box)
    await this.click(x, y)
    return true
  }

  /** Type via real key events (the composer is a contenteditable React surface). */
  async typeText(text: string): Promise<void> {
    for (const ch of text) {
      await this.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch })
      await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch })
    }
  }

  async pressEnter(): Promise<void> {
    const base = { code: 'Enter', key: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }
    await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base })
    await this.send('Input.dispatchKeyEvent', { type: 'char', text: '\r', key: 'Enter' })
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  }

  /** Focus the composer with a trusted click. False when no composer is present. */
  async focusComposer(): Promise<boolean> {
    const box = await this.evaluate<string>(`(() => {
      const ce = document.querySelector('[contenteditable=true]');
      if (!ce) return '';
      ce.scrollIntoView({ block: 'center' });
      const r = ce.getBoundingClientRect();
      return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
    })()`)
    if (!box) return false
    const { x, y } = JSON.parse(box)
    await this.click(x, y)
    return true
  }

  async composerText(): Promise<string> {
    return (await this.evaluate<string>(`(() => { const ce = document.querySelector('[contenteditable=true]'); return ce ? (ce.textContent || '') : ''; })()`)) ?? ''
  }
}

// ─── DOM readers (shape of Codex's automation hooks) ───────────────────

export interface CodexProject { id: string; name: string }
export interface CodexThreadRow { id: string; title: string; active: boolean }

export async function listProjects(cdp: CodexCdp): Promise<CodexProject[]> {
  const json = await cdp.evaluate<string>(`(() => {
    const clean = s => (s || '').replace(/\\s+/g, ' ').trim();
    const names = [...new Set([...document.querySelectorAll('button,[role=button]')]
      .map(b => clean(b.getAttribute('aria-label')))
      .filter(l => /^Start new chat in /.test(l))
      .map(l => l.replace('Start new chat in ', '')))];
    const ids = [...document.querySelectorAll('[data-app-action-sidebar-project-list-id]')]
      .map(p => p.getAttribute('data-app-action-sidebar-project-list-id'));
    return JSON.stringify(names.map((name, i) => ({ id: ids[i] || name, name })));
  })()`)
  try { return json ? JSON.parse(json) : [] } catch { return [] }
}

export async function listThreads(cdp: CodexCdp): Promise<CodexThreadRow[]> {
  const json = await cdp.evaluate<string>(`(() => JSON.stringify(
    [...document.querySelectorAll('[data-app-action-sidebar-thread-id]')].map(r => ({
      id: r.getAttribute('data-app-action-sidebar-thread-id'),
      title: r.getAttribute('data-app-action-sidebar-thread-title'),
      active: r.getAttribute('data-app-action-sidebar-thread-active') === 'true',
    }))))()`)
  try { return json ? JSON.parse(json) : [] } catch { return [] }
}

/** Strip Codex's `local:` prefix so ids match rollout filenames. */
export function bareThreadId(domId: string): string {
  return domId.replace(/^local:/, '')
}

/** True for the transient id a row carries between creation and persistence. */
export function isTransientThreadId(domId: string): boolean {
  return domId.includes('client-new-thread')
}
