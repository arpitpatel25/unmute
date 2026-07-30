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

  /** Move the pointer without pressing — submenus open on hover, not click. */
  async hover(x: number, y: number): Promise<void> {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  }

  /**
   * Hover as a MOVEMENT, not a teleport.
   *
   * One `mouseMoved` is a pointer that was never anywhere else, and menu
   * libraries do not treat that as intent: Radix-style submenus arm on a
   * sequence of pointer events (and a "safe triangle" that reasons about where
   * the pointer came from). A single event at the row's centre left the submenu
   * shut, which is why every pick found only the parent menu's rows.
   *
   * Approaching from the row's left edge also matters — it is the direction a
   * real pointer travels to reach a submenu trigger.
   */
  async hoverPath(x: number, y: number, steps = 4): Promise<void> {
    const fromX = Math.max(0, x - 90)
    for (let i = 1; i <= steps; i++) {
      const t = i / steps
      await this.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: Math.round(fromX + (x - fromX) * t), y,
      })
    }
  }

  /** One key, by code — for menu navigation (ArrowRight opens a submenu). */
  async pressKey(code: string, key: string, vk: number): Promise<void> {
    const base = { code, key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }
    await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base })
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  }

  async pressEscape(): Promise<void> {
    await this.pressKey('Escape', 'Escape', 27)
  }
}

// ─── Approval level (the composer's permissions control) ────────────────
//
// Codex renders the current level as the TEXT of one button and the offered
// levels as that button's menu. Both matter, and the menu especially: a level
// missing from it cannot be selected on this device no matter what any API
// reports, which is exactly the company/managed-plan case where "Full access"
// simply does not exist. Reading it is how we ask for the most we are ALLOWED
// rather than the most that exists.

/**
 * Which conversation the composer is currently attached to.
 *
 * This is the only trustworthy "where am I" signal. The sidebar cannot answer
 * it: rows exist in the DOM only while their section is expanded and within the
 * rendered window, so a thread can be open and on screen while having no row at
 * all (measured — a collapsed Recents hides every recent thread).
 */
export async function currentConversationId(cdp: CodexCdp): Promise<string | null> {
  const id = await cdp.evaluate<string>(
    `(() => { const el = document.querySelector('[data-above-composer-conversation-id]');
              return el ? (el.getAttribute('data-above-composer-conversation-id') || '') : ''; })()`,
  )
  return id ? id : null
}

const PERMISSIONS_BUTTON = '[data-composer-navigation-target="permissions"]'

/** Centre of an element, or null when it isn't on screen. */
async function centreOf(cdp: CodexCdp, selector: string): Promise<{ x: number; y: number } | null> {
  const box = await cdp.evaluate<string>(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return '';
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return '';
    return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
  })()`)
  if (!box) return null
  try { return JSON.parse(box) } catch { return null }
}

/**
 * Open the permissions menu with a TRUSTED click.
 *
 * `el.click()` opened it once and then stopped working — this dropdown only
 * responds reliably to a real pointer event, the same reason focusComposer()
 * clicks rather than calling .focus(). A silent no-op here would mean the level
 * is never raised and nobody finds out.
 */
async function openPermissionsMenu(cdp: CodexCdp, sleep: (ms: number) => Promise<void>): Promise<boolean> {
  const at = await centreOf(cdp, PERMISSIONS_BUTTON)
  if (!at) return false
  await cdp.click(at.x, at.y)
  await sleep(900)
  const n = await cdp.evaluate<number>(`document.querySelectorAll('[role="menuitem"],[role="menuitemradio"],[role="option"]').length`)
  return (n ?? 0) > 0
}

/** The level Codex is currently set to, as its own button labels it. */
export async function readApprovalLabel(cdp: CodexCdp): Promise<string | null> {
  const t = await cdp.evaluate<string>(
    `(() => { const b = document.querySelector('${PERMISSIONS_BUTTON}'); return b ? (b.innerText || '').trim() : ''; })()`,
  )
  return t ? t : null
}

/** Open the menu, read what this device offers, close it again. */
export async function readApprovalMenu(cdp: CodexCdp, sleep: (ms: number) => Promise<void>): Promise<string[]> {
  if (!(await openPermissionsMenu(cdp, sleep))) return []
  const raw = await cdp.evaluate<string>(`JSON.stringify(
    [...document.querySelectorAll('[role="menuitem"],[role="menuitemradio"],[role="option"]')].map((e) => (e.innerText || '').trim())
  )`)
  // ALWAYS close it. Leaving the user's composer menu hanging open would be a
  // visible, confusing side effect of a background capability probe.
  await cdp.pressEscape()
  await sleep(250)
  try { return JSON.parse(raw ?? '[]') as string[] } catch { return [] }
}

/** Select a level by its menu label. False when the device does not offer it. */
export async function selectApprovalLevel(
  cdp: CodexCdp,
  label: string,
  sleep: (ms: number) => Promise<void>,
): Promise<boolean> {
  if (!(await openPermissionsMenu(cdp, sleep))) return false
  // Harvest, then choose in TypeScript — see pickMenuItem. The old inline
  // `startsWith` is the same trap that killed every model pick: we ask for
  // "full-access" and the row reads "Full Access", so it matched nothing,
  // returned false, and auto-approve silently never applied
  // (codex-approval-set ok:false in the field logs). pickMenuItem normalises
  // separators and prefers an exact first-line match.
  const rowsJson = await cdp.evaluate<string>(`(() => {
    const items = [...document.querySelectorAll('[role="menuitem"],[role="menuitemradio"],[role="option"]')];
    return JSON.stringify(items.map((e) => {
      const r = e.getBoundingClientRect();
      return { text: (e.innerText || '').trim(), x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }));
  })()`)
  let rows: MenuItem[] = []
  try { rows = JSON.parse(rowsJson || '[]') as MenuItem[] } catch { rows = [] }
  const at = pickMenuItem(rows, label) ?? pickMenuItem(rows, label.replace(/[-_]+/g, ' '))
  if (!at) {
    log.warn('approval value not in menu', { want: label, offered: rows.map((r) => r.text.split('\n')[0]) })
    await cdp.pressEscape(); await sleep(250); return false
  }
  await cdp.click(at.x, at.y)
  await sleep(500)

  // CODEX GUARDS AN ESCALATION WITH A CONFIRMATION DIALOG.
  //
  // Selecting "Full access" does not apply it — it opens "Turn on Full Access?"
  // with Cancel / Confirm, and the level only changes when Confirm is clicked.
  // Nothing here answered it, so every attempt read back the OLD level and
  // reported ok:false, and the next pressEscape cancelled the dialog outright.
  // That is why auto-approve never applied on any dispatch, and why the failure
  // looked like a click that missed: the click had always landed.
  //
  // Scoped to a dialog that is actually asking about THIS change — a blind
  // "click Confirm" would answer whatever modal happened to be on screen.
  const confirmable = await cdp.evaluate<boolean>(`(() => {
    const d = document.querySelector('[role="dialog"],[role="alertdialog"]');
    if (!d) return false;
    const t = (d.innerText || '').toLowerCase();
    const wants = ${JSON.stringify(label.toLowerCase())};
    const asksAboutThis = wants.split(/\s+/).every((w) => t.includes(w));
    return asksAboutThis && [...d.querySelectorAll('button,[role=button]')]
      .some((b) => (b.innerText || '').trim().toLowerCase() === 'confirm');
  })()`)
  if (confirmable) {
    const confirmed = await cdp.clickText('Confirm')
    log.event('codex-approval-confirmed', { label, clicked: confirmed })
    await sleep(800)
  }

  // Confirm from the button itself rather than trusting the click: this is the
  // difference between "we set the level" and "we think we set the level".
  const now = (await readApprovalLabel(cdp)) ?? ''
  const ok = now.trim().toLowerCase().startsWith(label.toLowerCase())
  if (!ok) { await cdp.pressEscape() }
  return ok
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

/**
 * Click a thread's row in the sidebar. Null when the row is not rendered.
 *
 * This is the focus-FREE way to switch threads, so it is tried first — CDP
 * input never brings the app forward. Its limit is that the sidebar only
 * renders a window of the threads: sections can be collapsed (their contents
 * are absent, not hidden) and lists are truncated.
 */
export async function clickThreadRow(cdp: CodexCdp, threadId: string): Promise<boolean> {
  const domId = threadId.startsWith('local:') ? threadId : `local:${threadId}`
  const box = await cdp.evaluate<string>(`(() => {
    const el = document.querySelector('[data-app-action-sidebar-thread-id=' + ${JSON.stringify(JSON.stringify(domId))} + ']');
    if (!el) return '';
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return '';
    return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
  })()`)
  if (!box) return false
  const { x, y } = JSON.parse(box) as { x: number; y: number }
  await cdp.click(x, y)
  return true
}

/**
 * Expand every collapsed sidebar section, so more rows become reachable.
 *
 * Measured: expanding a collapsed Recents took the DOM from 8 rows to 16, with
 * no focus steal. It does not reach everything — the list is still windowed —
 * but it converts the common "it's right there, just collapsed" case into one
 * that needs no deep link.
 */
export async function expandSidebarSections(cdp: CodexCdp, sleep: (ms: number) => Promise<void>): Promise<number> {
  const boxes = await cdp.evaluate<string>(`JSON.stringify(
    [...document.querySelectorAll('[data-app-action-sidebar-section]')]
      .filter((e) => e.getAttribute('data-app-action-sidebar-section-collapsed') === 'true')
      .map((e) => { const t = e.querySelector('[data-app-action-sidebar-section-toggle]') || e;
                    const r = t.getBoundingClientRect();
                    return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })
  )`)
  let opened = 0
  for (const b of JSON.parse(boxes ?? '[]') as Array<{ x: number; y: number }>) {
    await cdp.click(b.x, b.y)
    await sleep(700)
    opened++
  }
  return opened
}

// ─── Model / effort / speed (the composer's reasoning control) ──────────
//
// Codex puts these behind one control that reads "5.6 Terra High". Its menu has
// three submenus — Model, Effort, Speed — each revealed by HOVERING the parent
// row, which is why this dispatches mouseMoved rather than clicking through.
//
// The names are read, never hardcoded. "5.6 Terra" will not exist in two
// releases, and a managed plan may not offer every tier; the same
// discovery-not-assumption rule that the approval levels follow.

const REASONING_BUTTON = '[data-composer-navigation-target="reasoning"]'

export type ReasoningAxis = 'Model' | 'Effort' | 'Speed'

export interface ReasoningState {
  /** The control's own label, e.g. "5.6 Terra High". */
  label: string | null
  /** Current value per axis, as Codex words it. */
  current: Partial<Record<ReasoningAxis, string>>
  /** What this device offers per axis. */
  options: Partial<Record<ReasoningAxis, string[]>>
}

async function openReasoningMenu(cdp: CodexCdp, sleep: (ms: number) => Promise<void>): Promise<boolean> {
  const at = await centreOf(cdp, REASONING_BUTTON)
  if (!at) return false
  await cdp.click(at.x, at.y)
  // POLL, don't sleep. The menu's rows mount progressively — measured taking
  // past 800ms, and a fixed sleep that expired early made the axis rows look
  // absent, so the caller escalated against a menu that was merely still
  // arriving. Waiting for the axis rows specifically (not just any menuitem)
  // is what makes "the menu is open" mean something.
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    const n = await cdp.evaluate<number>(
      `document.querySelectorAll('[aria-haspopup="menu"][aria-label^="Model"],[aria-haspopup="menu"][aria-label^="Effort"]').length`)
    if ((n ?? 0) > 0) return true
    await sleep(80)
  }
  return (await cdp.evaluate<number>(`document.querySelectorAll('[role="menuitem"]').length`) ?? 0) > 0
}

/** Rows of the top menu, as "Axis / value" pairs. */
async function readAxes(cdp: CodexCdp): Promise<Partial<Record<ReasoningAxis, string>>> {
  const raw = await cdp.evaluate<string>(`JSON.stringify(
    [...document.querySelectorAll('[role="menuitem"]')].map((e) => (e.innerText || '').trim())
  )`)
  const out: Partial<Record<ReasoningAxis, string>> = {}
  for (const line of JSON.parse(raw ?? '[]') as string[]) {
    const m = /^(Model|Effort|Speed)\n?\s*(.*)$/.exec(line)
    if (m && m[2]) out[m[1] as ReasoningAxis] = m[2].trim()
  }
  return out
}

const AXIS_ROWS = new Set(['', 'Reset to default', 'Model', 'Effort', 'Speed'])

/** Every menu row currently in the document, first line only. */
async function readItemTexts(cdp: CodexCdp): Promise<string[]> {
  return JSON.parse(await cdp.evaluate<string>(`JSON.stringify(
    [...document.querySelectorAll('[role="menuitem"],[role="menuitemradio"],[role="option"]')]
      .map((e) => (e.innerText || '').trim().split(String.fromCharCode(10))[0].trim())
      .filter(Boolean)
  )`) ?? '[]') as string[]
}

/** How the submenu came open — recorded so a regression names itself. */
export type OpenStrategy = 'pointer-events' | 'hover' | 'failed'

/**
 * Open a Radix submenu by dispatching pointer events AT the trigger element.
 *
 * MEASURED, not assumed. The axis rows are Radix `MenuSubTrigger`s — the DOM
 * says so: `aria-haspopup="menu"`, `data-state="closed"`. Radix opens them from
 * `onPointerMove`, and React's synthetic event system does not require
 * `isTrusted`, so an event constructed in the page reaches the handler.
 *
 * What does NOT work, each verified against the live app:
 *   * `Input.dispatchMouseEvent` mouseMoved — three hovers, still "closed".
 *     CDP's synthetic mouse never satisfies the pointer-intent logic.
 *   * the same with `pointerType: 'mouse'` — still "closed".
 *   * a trusted click on the trigger — CLOSES THE WHOLE MENU, which is how an
 *     escalation ladder ended up reading an empty document.
 *   * ArrowDown/ArrowRight — roving focus never reaches the axis rows.
 *
 * The one that works dispatches pointerover/pointerenter/pointermove with
 * `pointerType: 'mouse'` and real client coordinates.
 */
async function dispatchPointerAt(cdp: CodexCdp, ariaPrefix: string): Promise<boolean> {
  const ok = await cdp.evaluate<boolean>(`(() => {
    const el = [...document.querySelectorAll('[aria-haspopup="menu"]')]
      .find((x) => (x.getAttribute('aria-label') || '').startsWith(${JSON.stringify(ariaPrefix)}));
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, composed: true, pointerType: 'mouse',
                isPrimary: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    for (const t of ['pointerover', 'pointerenter', 'pointermove']) {
      el.dispatchEvent(new PointerEvent(t, o));
    }
    return true;
  })()`)
  return ok === true
}

/**
 * Tell the page the pointer LEFT. The other half of dispatchPointerAt.
 *
 * We open submenus by dispatching pointerover/pointerenter/pointermove at the
 * trigger. Nothing ever dispatched the matching leave, so Radix went on
 * believing the cursor was sitting inside the menu — its pointer tracking (the
 * safe-triangle heuristic, onPointerLeave) never stood down, and neither did
 * the DismissableLayer/FocusScope that come with an open menu. Escape closed
 * the menu visually while the app still behaved as though one were live: the
 * composer accepted TYPING (key events reach whatever is focused) but would not
 * SUBMIT. That is the dispatch that typed its whole intent and then died.
 *
 * Main never had this problem because its hover approach never opened a submenu
 * at all — it could not unbalance a state machine it never reached.
 */
async function releasePointerFrom(cdp: CodexCdp, ariaPrefix: string): Promise<void> {
  await cdp.evaluate(`(() => {
    const el = [...document.querySelectorAll('[aria-haspopup="menu"]')]
      .find((x) => (x.getAttribute('aria-label') || '').startsWith(${JSON.stringify(ariaPrefix)}));
    if (!el) return;
    const r = el.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, composed: true, pointerType: 'mouse',
                isPrimary: true, clientX: r.left + r.width / 2, clientY: r.top - 200 };
    // Move away first, then leave — the order a real pointer produces.
    el.dispatchEvent(new PointerEvent('pointermove', o));
    for (const t of ['pointerout', 'pointerleave']) el.dispatchEvent(new PointerEvent(t, o));
    for (const t of ['mouseout', 'mouseleave']) el.dispatchEvent(new MouseEvent(t, o));
  })()`)
}

/** Is this axis's submenu open, per Radix's own state attribute? */
async function submenuIsOpen(cdp: CodexCdp, ariaPrefix: string): Promise<boolean> {
  return (await cdp.evaluate<boolean>(`(() => {
    const el = [...document.querySelectorAll('[aria-haspopup="menu"]')]
      .find((x) => (x.getAttribute('aria-label') || '').startsWith(${JSON.stringify(ariaPrefix)}));
    return !!el && el.getAttribute('data-state') === 'open';
  })()`)) === true
}

export interface SubmenuResult {
  strategy: OpenStrategy
  /** Rows that appeared and were NOT already in the parent menu. */
  items: string[]
  /** Everything on screen when we gave up — only set on failure. */
  sawInstead?: string[]
  ms: number
}

/**
 * Open one axis's submenu and return what it offers.
 *
 * ESCALATES rather than trusting any single gesture, because the previous
 * single-hover-plus-800ms-sleep failed silently and took every model pick with
 * it. Each strategy is tried and VERIFIED by polling for rows the parent menu
 * did not already have; a set difference cannot mistake the parent's "Advanced"
 * row for a submenu item, which is the bug that shipped a catalogue of one.
 *
 *   1. hover along a path  — what a real pointer does, and cheapest
 *   2. trusted click       — a Radix SubTrigger opens on click too
 *   3. ArrowRight          — the keyboard contract, immune to pointer heuristics
 *
 * Returns which one worked so the log can show the gesture degrading over a
 * Codex release instead of one day just breaking.
 */
async function openSubmenu(
  cdp: CodexCdp, axis: ReasoningAxis, at: { x: number; y: number },
  sleep: (ms: number) => Promise<void>, startedAt: number,
): Promise<SubmenuResult> {
  const before = new Set(await readItemTexts(cdp))
  const fresh = (rows: string[]) => rows.filter((t) => !before.has(t) && !AXIS_ROWS.has(t))

  // Poll instead of sleeping a fixed budget: a submenu that opens in 90ms
  // should not cost 800, and one that needs 1.2s should not be declared dead.
  const settle = async (budgetMs: number): Promise<string[]> => {
    const deadline = Date.now() + budgetMs
    let last: string[] = []
    while (Date.now() < deadline) {
      last = fresh(await readItemTexts(cdp))
      if (last.length) return last
      await sleep(80)
    }
    return last
  }

  // The gesture that works. Confirmed by data-state AND by new rows appearing:
  // either alone can lie — Radix flips state a frame before the items mount.
  if (await dispatchPointerAt(cdp, axis)) {
    const items = await settle(1200)
    if (items.length) return { strategy: 'pointer-events', items, ms: Date.now() - startedAt }
    if (await submenuIsOpen(cdp, axis)) {
      // Open but empty: give the portal one more beat rather than declaring
      // failure and tearing the menu down.
      const late = await settle(600)
      if (late.length) return { strategy: 'pointer-events', items: late, ms: Date.now() - startedAt }
    }
  }

  // Kept as a fallback ONLY because it costs one gesture: if a future Codex
  // moves off Radix, a plain hover may be all that is needed, and this fails
  // over silently instead of regressing to nothing.
  await cdp.hoverPath(at.x, at.y)
  const viaHover = await settle(700)
  if (viaHover.length) return { strategy: 'hover', items: viaHover, ms: Date.now() - startedAt }

  return {
    strategy: 'failed', items: [],
    sawInstead: await readItemTexts(cdp),
    ms: Date.now() - startedAt,
  }
}

/** Locate an axis row in the open parent menu. */
async function axisRowBox(cdp: CodexCdp, axis: ReasoningAxis): Promise<{ x: number; y: number } | null> {
  const box = await cdp.evaluate<string>(`(() => {
    const e = [...document.querySelectorAll('[role="menuitem"]')].find((x) => new RegExp('^' + ${JSON.stringify(axis)}).test((x.innerText || '').trim()));
    if (!e) return '';
    const r = e.getBoundingClientRect();
    return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
  })()`)
  if (!box) return null
  return JSON.parse(box) as { x: number; y: number }
}

/**
 * Open the menu, hover ONE axis, and read the submenu it reveals.
 *
 * Deliberately reopens the whole menu per axis. Hovering from one axis row to
 * the next does not reliably switch the submenu — measured: Model → Effort left
 * Model's items on screen, while Effort → Speed switched correctly, because the
 * pointer travels across the open submenu on the way. Diffing before/after then
 * reports the wrong list, or an empty one, which is how Effort came back empty
 * while Model and Speed read fine. Three open/close cycles is slower and always
 * right, and this runs once per task creation.
 */
async function readAxisOptions(
  cdp: CodexCdp, axis: ReasoningAxis, sleep: (ms: number) => Promise<void>,
): Promise<string[]> {
  const t0 = Date.now()
  if (!(await openReasoningMenu(cdp, sleep))) return []
  const at = await axisRowBox(cdp, axis)
  if (!at) { await cdp.pressEscape(); return [] }

  // A SET DIFFERENCE, never "everything minus the axis names".
  //
  // This used to scrape everything after hovering and subtract the three axis
  // names, on the assumption that whatever remained belonged to the submenu.
  // When the submenu had NOT opened, what remained was the parent menu's other
  // rows — and Codex has one called "Advanced". That is why every axis came
  // back offering exactly one value, and why a correct-looking cache could
  // still be garbage. openSubmenu keeps that discipline and adds escalation.
  const r = await openSubmenu(cdp, axis, at, sleep, t0)
  if (r.strategy === 'failed') log.warn('submenu never opened', { axis, sawInstead: r.sawInstead, ms: r.ms })
  else log.info('submenu opened', { axis, via: r.strategy, count: r.items.length, ms: r.ms })
  await releasePointerFrom(cdp, axis)      // balance the enter — see the helper
  await cdp.pressEscape()
  await sleep(250)
  return r.items
}

/** Read the whole control: current values and what this device offers. */
export async function readReasoning(cdp: CodexCdp, sleep: (ms: number) => Promise<void>): Promise<ReasoningState> {
  const label = (await cdp.evaluate<string>(
    `(() => { const b = document.querySelector('${REASONING_BUTTON}'); return b ? (b.innerText || '').trim().replace(/\\n/g, ' ') : ''; })()`,
  )) || null
  if (!(await openReasoningMenu(cdp, sleep))) return { label, current: {}, options: {} }
  const current = await readAxes(cdp)
  await cdp.pressEscape()
  await sleep(250)
  const options: Partial<Record<ReasoningAxis, string[]>> = {}
  for (const axis of ['Model', 'Effort', 'Speed'] as ReasoningAxis[]) {
    options[axis] = await readAxisOptions(cdp, axis, sleep)
  }
  return { label, current, options }
}

/** One row of an open submenu: its text and where to click it. */
export interface MenuItem { text: string; x: number; y: number }

/**
 * Which submenu row is `value`?
 *
 * EXACT BEFORE PREFIX. The old matcher was a bare `startsWith`, and Codex's own
 * catalogue contains "5.4" alongside "5.4 Mini" — whichever the DOM listed
 * first won, so choosing the plain model could silently select the mini. Rows
 * also carry a description on a second line ("5.6 Sol\nLatest frontier…"), which
 * is why a whole-innerText equality check cannot replace the prefix outright:
 * we compare the FIRST LINE exactly, then fall back to prefix for rows that
 * render their subtitle inline.
 *
 * Exported so this is covered by tests rather than living as an unreadable
 * string inside an `evaluate` call.
 */
export function pickMenuItem(items: MenuItem[], value: string): MenuItem | null {
  const want = value.trim().toLowerCase()
  if (!want) return null
  const head = (t: string) => (t || '').split('\n')[0].trim().toLowerCase()
  return items.find((i) => head(i.text) === want)
    ?? items.find((i) => head(i.text).startsWith(want))
    ?? null
}

/**
 * The whole story of one attempt to set an axis.
 *
 * Every field exists because its absence once cost a build. Three releases
 * shipped with every Codex pick dead, and the log said only that a choice had
 * been made — never what we clicked, what the menu contained, or whether
 * anything changed. `stage` alone answers "why didn't it work".
 */
export interface SetReasoningTrace {
  axis: ReasoningAxis
  /** What the pill asked for, in the menu's own vocabulary. */
  want: string
  /** How far we got. The first stage that fails is the cause. */
  stage: 'menu-closed' | 'axis-row-missing' | 'submenu-closed' | 'value-absent' | 'clicked'
  ok: boolean
  /** Which gesture opened the submenu (or that none did). */
  via?: OpenStrategy
  /** Exactly what the submenu offered — the vocabulary check, in the log. */
  offered?: string[]
  /** The row text we actually clicked, so a near-miss match is visible. */
  matched?: string
  /** The reasoning button's label before and after. */
  labelBefore?: string
  labelAfter?: string
  /** Did the button's label actually move? The only real proof. */
  changed?: boolean
  ms: number
}

/**
 * The reasoning button's own label ("5.6 Sol High"), read WITHOUT opening
 * anything. One evaluate, no menus, no pointer events — which is what makes a
 * "do we even need to change this?" pre-check affordable on every dispatch.
 */
export const readReasoningLabel = async (cdp: CodexCdp): Promise<string> =>
  (await cdp.evaluate<string>(
    `(() => { const b = document.querySelector('${REASONING_BUTTON}'); return b ? (b.innerText || '').trim().replace(/\\n/g, ' ') : ''; })()`,
  )) ?? ''

/**
 * Choose a value on one axis, and report exactly what happened.
 *
 * VERIFIES rather than assumes. The old version returned true the moment it
 * dispatched a click, so "the pick worked" meant "we clicked somewhere". It now
 * re-reads the button label and reports whether it moved — which is the only
 * evidence that Codex agreed with us.
 */
export async function setReasoning(
  cdp: CodexCdp, axis: ReasoningAxis, value: string, sleep: (ms: number) => Promise<void>,
): Promise<SetReasoningTrace> {
  const t0 = Date.now()
  const done = (t: Omit<SetReasoningTrace, 'axis' | 'want' | 'ms'>): SetReasoningTrace =>
    ({ axis, want: value, ms: Date.now() - t0, ...t })

  const labelBefore = await readReasoningLabel(cdp)
  if (!(await openReasoningMenu(cdp, sleep))) return done({ stage: 'menu-closed', ok: false, labelBefore })

  const row = await axisRowBox(cdp, axis)
  if (!row) { await cdp.pressEscape(); return done({ stage: 'axis-row-missing', ok: false, labelBefore }) }

  const sub = await openSubmenu(cdp, axis, row, sleep, t0)
  if (sub.strategy === 'failed') {
    await releasePointerFrom(cdp, axis)
    await cdp.pressEscape(); await sleep(200)
    return done({ stage: 'submenu-closed', ok: false, via: 'failed', offered: sub.sawInstead, labelBefore })
  }

  // Harvest every row WITH its box, then choose in TypeScript — see
  // pickMenuItem. Doing the choosing in the page put the one rule that decides
  // whether a pick lands beyond the reach of any test.
  const itemsJson = await cdp.evaluate<string>(`(() => {
    const items = [...document.querySelectorAll('[role="menuitem"],[role="menuitemradio"],[role="option"]')];
    return JSON.stringify(items.map((e) => {
      const r = e.getBoundingClientRect();
      return { text: (e.innerText || '').trim(), x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }));
  })()`)
  let rows: MenuItem[] = []
  try { rows = JSON.parse(itemsJson || '[]') as MenuItem[] } catch { rows = [] }

  const at = pickMenuItem(rows, value)
  if (!at) {
    await releasePointerFrom(cdp, axis)
    await cdp.pressEscape(); await sleep(200)
    return done({ stage: 'value-absent', ok: false, via: sub.strategy, offered: sub.items, labelBefore })
  }

  await cdp.click(at.x, at.y)
  await sleep(500)
  // The pointer must be released even on the SUCCESS path — this is the one the
  // real dispatch takes, and the one that stranded a task.
  await releasePointerFrom(cdp, axis)
  await cdp.pressEscape()
  await sleep(200)
  const labelAfter = await readReasoningLabel(cdp)
  return done({
    stage: 'clicked', ok: true, via: sub.strategy, offered: sub.items,
    matched: at.text.split('\n')[0], labelBefore, labelAfter,
    changed: labelAfter !== labelBefore,
  })
}

/** Strip Codex's `local:` prefix so ids match rollout filenames. */
export function bareThreadId(domId: string): string {
  return domId.replace(/^local:/, '')
}

/** True for the transient id a row carries between creation and persistence. */
export function isTransientThreadId(domId: string): boolean {
  return domId.includes('client-new-thread')
}

// ── Computer Use consents ───────────────────────────────────────────────────
//
// A SECOND, separate approval surface, and the one that was invisible to unmute
// until 2026-07-30. Codex has two permission systems:
//
//   tool approvals ("run this bash?")  -> PermissionRequest hook -> hooks.ts
//   Computer Use   ("use WhatsApp?")   -> NEITHER hook NOR rollout
//
// Verified on a live blocked task: ~/.codex/hooks.json was trusted+enabled and
// the hook never fired; nothing was written to codex-approvals/; the rollout
// recorded no approval event. The turn just stopped mid-exec.
//
// It IS in the DOM, which is why this exists. But note the cost, because it is
// unlike everything else in this file: the consent panel carries NO
// `data-app-action-*` attributes (probed live — zero matches). OpenAI's stable
// automation surface does not cover it. So this reader is structural + textual:
//
//   * the panel is located by SHAPE — the element owning >=2 buttons — not by a
//     selector, so option count and wording are free to change;
//   * the options are whatever the DOM says. Never hardcode "Deny"/"Allow": the
//     third option here is "Allow this conversation", and Codex is free to add
//     more.
//   * only the blocked MARKER ("Awaiting approval") is a literal string, and it
//     is the one thing that will break on a copy change or a localised build.
//     Treat a null result as "unknown", never as "not blocked" — the disk-side
//     pendingToolCalls signal in rollout.ts is the backstop.

/** A consent Codex is blocking on, exactly as its own window words it. */
export interface CodexConsent {
  /** The question, e.g. "Allow ChatGPT to use WhatsApp?". */
  question: string
  /** Every option offered, in DOM order. Read, never assumed. */
  options: string[]
}

/** Codex's own "this turn is parked" marker. The one literal we depend on. */
const AWAITING_MARKER = /awaiting approval/i

/**
 * Read the consent panel of the MOUNTED thread, or null when none is showing.
 *
 * Only ever reflects the conversation Codex currently has open — a renderer
 * mounts exactly one. Blocked-ness across ALL threads comes from the rollout.
 */
export async function readPendingConsent(cdp: CodexCdp): Promise<CodexConsent | null> {
  const raw = await cdp.evaluate<string>(`(() => {
    const norm = (s) => (s || '').replace(/[\\u200e\\u200f\\u2066-\\u2069]/g, '').replace(/\\s+/g, ' ').trim();
    const awaiting = [...document.querySelectorAll('*')]
      .some((e) => e.children.length === 0 && /awaiting approval/i.test(e.textContent || ''));
    if (!awaiting) return '';
    // Anchor on the QUESTION, then take the nearest ancestor that owns its
    // answer buttons.
    //
    // Two heuristics were tried live and both failed, which is why this one is
    // written the way it is: "container with the MOST buttons" finds the
    // sidebar (dozens of thread rows), and "tightest container with >=2
    // buttons" finds a two-item nav with no question in it. The question is the
    // only reliable anchor, and '?' is the only thing assumed about it — no
    // phrase, no selector, no option count.
    const leaves = [...document.querySelectorAll('*')].filter((e) => e.children.length === 0);
    const asks = leaves.filter((e) => {
      const t = norm(e.textContent);
      return t.endsWith('?') && t.length >= 8 && t.length <= 300;
    });
    let best = null, question = '';
    for (const ask of asks) {
      for (let p = ask.parentElement, hops = 0; p && hops < 8; p = p.parentElement, hops++) {
        const own = [...p.querySelectorAll('button')].filter((x) => norm(x.innerText));
        if (own.length >= 2 && own.length <= 6) { best = p; question = norm(ask.textContent); break; }
      }
      if (best) break;
    }
    if (!best) return '';
    const opts = [...best.querySelectorAll('button')].map((b) => norm(b.innerText)).filter(Boolean);
    return JSON.stringify({ question, options: opts });
  })()`)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as CodexConsent
    return parsed.options?.length ? parsed : null
  } catch { return null }
}

/** True when the mounted thread shows Codex's parked marker at all. */
export async function isAwaitingConsent(cdp: CodexCdp): Promise<boolean> {
  const t = await cdp.evaluate<string>(
    `(() => [...document.querySelectorAll('*')].some((e) => e.children.length === 0 && /awaiting approval/i.test(e.textContent || '')) ? '1' : '')()`,
  )
  return !!t
}

/**
 * Answer a consent by the option's own label. False when that option is not on
 * screen — the caller must NOT retry with a guess, because the options differ
 * per consent ("Allow this conversation" exists here and nowhere else).
 */
export async function answerConsent(cdp: CodexCdp, option: string): Promise<boolean> {
  const consent = await readPendingConsent(cdp)
  if (!consent) return false
  const match = consent.options.find((o) => o.toLowerCase() === option.toLowerCase())
    ?? consent.options.find((o) => o.toLowerCase().startsWith(option.toLowerCase()))
  if (!match) return false
  return cdp.clickText(match)
}

// ── Blocked threads, read from the SIDEBAR (no thread switching) ────────────
//
// The consent panel only exists for the MOUNTED thread, so reading it per task
// would mean switching Codex's view once per task — with several blocked tasks
// that thrashes the window the user is looking at. The sidebar solves it: every
// thread's row is in the DOM at once.
//
// VERIFIED LIVE 2026-07-30, and the non-mounted case is the one that matters:
//   activeRow     : "Build the requested feature"        active=true   chip=null
//   rowsWithChips : "Open the WhatsApp desktop app on m…" active=FALSE  chip="Awaiting approval"
// One CDP call, 24 rows, ~300ms, and the blocked thread was NOT the one on
// screen. That is what makes confident cross-task detection possible at all.
//
// NOTE this supersedes the finding recorded in hooks.ts (2026-07-25, "the
// sidebar DOM exposes no status"). It exposes no status ATTRIBUTE — still true,
// the row attributes are id/title/active/kind/pinned/host-id — but the status
// is rendered as TEXT inside the row.
//
// NOTHING IS STRING-MATCHED. A chip is defined structurally: whatever text a row
// carries BEYOND its own title. Every idle row's innerText equals its title
// exactly; only a row with a status has more. That survives rewording, new
// statuses and localisation, and it means we can show Codex's own word instead
// of inventing a label. The cost is that a chip alone does not mean "your move"
// — Codex also chips drafts and errors — so callers MUST corroborate with the
// disk signal (rollout.pendingToolCalls on a frozen file) before acting.

export interface CodexThreadChip {
  /** Thread id as the sidebar carries it (may be host-prefixed). */
  id: string
  title: string
  /** Is this the conversation currently mounted? */
  active: boolean
  /** Codex's own status word for this row, or null when it has none. */
  chip: string | null
}

/**
 * Every thread's status chip in ONE call. Never mounts, never switches view.
 * Empty array when not armed or the sidebar is not rendered — callers must read
 * that as "unknown", never as "nothing is blocked".
 */
export async function readThreadChips(cdp: CodexCdp): Promise<CodexThreadChip[]> {
  const raw = await cdp.evaluate<string>(`(() => {
    const norm = (s) => (s || '').replace(/[\\u200e\\u200f\\u2066-\\u2069]/g, '').replace(/\\s+/g, ' ').trim();
    const rows = [...document.querySelectorAll('[data-app-action-sidebar-thread-id]')];
    return JSON.stringify(rows.map((r) => {
      const title = norm(r.getAttribute('data-app-action-sidebar-thread-title'));
      const text = norm(r.innerText);
      // The row renders the title (often ELLIPSISED) followed by any chip. So
      // strip a leading run that matches the title's head, then the ellipsis.
      let chip = text;
      const head = title.slice(0, 20);
      const at = head ? text.indexOf(head) : -1;
      if (at >= 0) chip = norm(text.slice(at).replace(/^.*?…/, '').replace(title, ''));
      if (chip === title) chip = '';
      return {
        id: r.getAttribute('data-app-action-sidebar-thread-id') || '',
        title,
        active: r.getAttribute('data-app-action-sidebar-thread-active') === 'true',
        chip: chip || null,
      };
    }));
  })()`)
  if (!raw) return []
  try {
    const rows = JSON.parse(raw) as CodexThreadChip[]
    return Array.isArray(rows) ? rows.filter((r) => r.id) : []
  } catch { return [] }
}
