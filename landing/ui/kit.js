// THE KIT — a Mac screen, built in HTML, for every demo on the live page.
//
// Everything that moves is real DOM, not video: the apps, the menu bar, the
// dock, a cursor, the key you tap, and Unmute's own surfaces (the pill at the
// bottom and the notch at the top). It stays sharp at any size, loads with the
// page, and can be paused, replayed or driven by scroll.
//
// The Unmute surfaces copy the app's real states (pill: listening → done;
// notch: idle mark → "Sending" → "Working N" → an expanded session that
// "Needs you" → "Done"), so nothing here shows something the app can't do.

export const W = 1280, H = 800
export const MARK = { claude: 'assets/mark-claude.png', codex: 'assets/mark-codex.png', un: 'assets/unmark.png' }
export const LOGO = {
  slack: 'assets/logos/slack-color.svg', linear: 'assets/logos/linear.svg', figma: 'assets/logos/figma-color.svg',
  github: 'assets/logos/github.svg', gmail: 'assets/logos/gmail-color.svg', chrome: 'assets/logos/chrome-color.svg',
}
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
export const reduced = reduce

// ── Pacing ───────────────────────────────────────────────────────────────────
// Words appear at about speaking speed; anything to read is held for long
// enough to read it once at a relaxed pace (~4 words a second), never less
// than 1.8 s.
export const WPS = 3.4
export const readMs = (text) => Math.max(1800, Math.round(text.split(/\s+/).length * 250 + 900))

// ── Sound (optional) ─────────────────────────────────────────────────────────
// The spoken lines exist as recordings. They only play after the visitor
// turns sound on, which is also what browsers require.
export const sound = { on: false, lines: {}, listeners: new Set() }
export function setSound(on) { sound.on = on; for (const f of sound.listeners) f(on) }
fetch('assets/voice/lines.json').then((r) => r.json()).then((j) => { sound.lines = j }).catch(() => {})

// ── A clock that can pause ───────────────────────────────────────────────────
// Scenes are async scripts. Every wait goes through the clock, so pausing (or
// scrolling the scene out of view) freezes the script exactly where it is.
export class Clock {
  constructor() { this.paused = false; this.gen = 0; this.waiters = [] }
  wait(ms) {
    const gen = this.gen
    return new Promise((res, rej) => {
      let left = reduce ? 0 : ms, last = performance.now()
      const tick = (now) => {
        if (gen !== this.gen) return rej(new Error('reset'))
        if (!this.paused) left -= now - last
        last = now
        if (left <= 0) res(); else requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
  }
  reset() { this.gen++ }
}

const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild }
const icons = {
  apple: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M17.3 12.6c0-2.4 2-3.6 2.1-3.7-1.1-1.7-2.9-1.9-3.5-1.9-1.5-.2-2.9.9-3.7.9-.8 0-1.9-.9-3.2-.8-1.6 0-3.1 1-4 2.4-1.7 3-.4 7.4 1.2 9.8.8 1.2 1.8 2.5 3 2.4 1.2-.1 1.7-.8 3.1-.8 1.5 0 1.9.8 3.2.8 1.3 0 2.1-1.2 2.9-2.4.9-1.3 1.3-2.6 1.3-2.7-.1 0-2.5-1-2.4-4ZM14.9 5.5c.7-.8 1.1-1.9 1-3-1 0-2.1.7-2.8 1.5-.6.7-1.2 1.8-1 2.9 1 .1 2.1-.5 2.8-1.4Z"/></svg>',
  wifi: '<svg viewBox="0 0 18 14"><path fill="currentColor" d="M9 12.6 6.6 10a3.4 3.4 0 0 1 4.8 0L9 12.6Zm-4.3-4.5-1.5-1.6a8.2 8.2 0 0 1 11.6 0l-1.5 1.6a6 6 0 0 0-8.6 0ZM1.5 4.8 0 3.2a12.8 12.8 0 0 1 18 0l-1.5 1.6a10.6 10.6 0 0 0-15 0Z"/></svg>',
  batt: '<svg viewBox="0 0 28 14"><rect x="1" y="2" width="22" height="10" rx="3" fill="none" stroke="currentColor" stroke-opacity=".5"/><rect x="3" y="4" width="16" height="6" rx="1.5" fill="currentColor"/><rect x="24.5" y="5.5" width="1.6" height="3" rx=".8" fill="currentColor" fill-opacity=".5"/></svg>',
  search: '<svg viewBox="0 0 16 16"><circle cx="6.8" cy="6.8" r="4.8" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="m10.4 10.4 4 4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  cursor: '<svg viewBox="0 0 24 24"><path d="M5 2.5v17.2l4.4-4.2 2.9 6.6 3-1.3-2.9-6.5h6.1z" fill="#000" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>',
  x: '<svg viewBox="0 0 12 12"><path d="M3 3l6 6M9 3 3 9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  check: '<svg viewBox="0 0 12 12"><path d="M2.6 6.3 5 8.6l4.4-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  term: '<svg viewBox="0 0 40 40"><rect width="40" height="40" rx="9" fill="#1d1d1f"/><path d="M10 13l6 5-6 5" fill="none" stroke="#e5e5e7" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M19 25h10" stroke="#e5e5e7" stroke-width="2.6" stroke-linecap="round"/></svg>',
  finder: '<svg viewBox="0 0 40 40"><rect width="40" height="40" rx="9" fill="#1e88e5"/><path d="M20 0h11a9 9 0 0 1 9 9v22a9 9 0 0 1-9 9H20z" fill="#e3f2fd"/><circle cx="13" cy="15" r="1.8" fill="#0d2b52"/><circle cx="27" cy="15" r="1.8" fill="#0d2b52"/><path d="M12 26c4.5 3 11.5 3 16 0" fill="none" stroke="#0d2b52" stroke-width="2" stroke-linecap="round"/></svg>',
}
export { icons }

// ── The screen ───────────────────────────────────────────────────────────────
export class Screen {
  constructor(host, { crop = true, box = null, cls = '' } = {}) {
    this.box = box
    this.host = host
    this.clock = new Clock()
    host.classList.add('kit-host'); if (cls) host.classList.add(cls)
    host.innerHTML = ''
    this.frame = el(`<div class="kit-bezel"><div class="kit-view"><div class="kit-screen">
      <div class="kit-wall"></div>
      <div class="kit-menubar"><span class="mb-l"><i class="mb-apple">${icons.apple}</i><b class="mb-app">Slack</b><span>File</span><span>Edit</span><span>View</span><span>Window</span><span>Help</span></span><span class="mb-r"><i>${icons.batt}</i><i>${icons.wifi}</i><i>${icons.search}</i><span class="mb-time">Tue 10:42 AM</span></span></div>
      <div class="kit-windows"></div>
      <div class="kit-dock"></div>
      <div class="un-notch"><i class="fil l"></i><i class="fil r"></i><div class="nb"><span class="nb-l"><img src="${MARK.un}" alt=""></span><span class="nb-r"></span></div><div class="np"></div></div>
      <div class="un-pill"><span class="up-agent"><img alt=""><b></b></span><span class="up-cap"><i class="up-x">${icons.x}</i><span class="up-wave">${'<i></i>'.repeat(11)}</span><i class="up-ok">${icons.check}</i></span></div>
      <div class="un-say"><div class="us-h"><span class="us-key">right ⌥</span><span>You say</span></div><p class="us-t"></p></div>
      <div class="un-key"><span class="cap">⌥</span><span class="lbl">tap right option</span></div>
      <i class="kit-cursor">${icons.cursor}</i>
    </div></div></div>`)
    host.append(this.frame)
    this.view = this.frame.querySelector('.kit-view')
    this.screen = this.frame.querySelector('.kit-screen')
    this.$ = (s) => this.screen.querySelector(s)
    this.windows = this.$('.kit-windows')
    this.notchEl = this.$('.un-notch'); this.pillEl = this.$('.un-pill'); this.sayEl = this.$('.un-say'); this.keyEl = this.$('.un-key'); this.cursorEl = this.$('.kit-cursor')
    this.crop = crop
    this.fit()
    new ResizeObserver(() => this.fit()).observe(host)
    requestAnimationFrame(() => this.fit())
    this.dock(['finder', 'slack', 'linear', 'figma', 'chrome', 'gmail', 'term', 'un'])
    this.cursor = { x: 900, y: 600 }
    this.place(this.cursorEl, 900, 600)
    // The waveform: a speaking voice, roughly the app's DotWave.
    const bars = [...this.pillEl.querySelectorAll('.up-wave i')]
    const wave = (t) => {
      if (this.pillEl.classList.contains('listening') && !this.clock.paused) bars.forEach((b, i) => {
        const arch = Math.sin(Math.PI * (i + 1) / 12), v = 0.25 + 0.75 * Math.abs(Math.sin(t / 140 + i * 0.9) * Math.sin(t / 390 + i * 0.35))
        b.style.height = (3 + arch * v * 13).toFixed(1) + 'px'
      })
      requestAnimationFrame(wave)
    }
    requestAnimationFrame(wave)
  }
  // Fit the 1280×800 screen into the host. Narrow hosts (phones) see the
  // middle of the screen, where the notch, the pill and the work are.
  fit() {
    const w = this.view.clientWidth || this.host.clientWidth
    const narrow = this.crop && !this.box && w < 640
    // A close-up shows one region of the screen (box); phones see the middle.
    const b = this.box || (narrow ? { x: 230, y: 0, w: 820, h: H } : { x: 0, y: 0, w: W, h: H })
    const s = w / b.w
    this.view.style.height = b.h * s + 'px'
    this.screen.style.transform = `translate(${-b.x * s}px,${-b.y * s}px) scale(${s})`
    this.host.classList.toggle('narrow', narrow)
  }
  place(n, x, y) { n.style.left = x + 'px'; n.style.top = y + 'px' }
  wait(ms) { return this.clock.wait(ms) }
  menu(app) { this.$('.mb-app').textContent = app }
  time(t) { this.$('.mb-time').textContent = t }
  dock(apps) {
    const d = this.$('.kit-dock')
    d.innerHTML = apps.map((a) => {
      const src = a === 'un' ? MARK.un : LOGO[a]
      const inner = icons[a] ? icons[a] : `<img src="${src}" alt="">`
      return `<span class="dk dk-${a}">${inner}</span>`
    }).join('')
  }
  window(html, cls = '') {
    this.windows.innerHTML = ''
    const w = el(`<div class="kit-win ${cls}">${html}</div>`)
    this.windows.append(w)
    return w
  }

  // Where an element is, in screen points (for aiming the cursor).
  at(node, fx = 0.5, fy = 0.5) {
    const r = node.getBoundingClientRect(), sr = this.screen.getBoundingClientRect(), k = sr.width / W
    return [(r.left - sr.left + r.width * fx) / k, (r.top - sr.top + r.height * fy) / k]
  }
  async to(node, ms, fx, fy) { const [x, y] = this.at(node, fx, fy); await this.move(x, y, ms) }

  // ── Cursor ──
  async move(x, y, ms = 700) {
    const from = { ...this.cursor }, t0 = performance.now(), c = this.cursorEl
    this.cursorEl.classList.add('on')
    if (reduce) { this.cursor = { x, y }; this.place(c, x, y); return }
    await new Promise((res) => {
      const step = (now) => {
        const k = Math.min(1, (now - t0) / ms), e = k < .5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2
        this.place(c, from.x + (x - from.x) * e, from.y + (y - from.y) * e)
        if (k < 1) requestAnimationFrame(step); else res()
      }
      requestAnimationFrame(step)
    })
    this.cursor = { x, y }
  }
  async click(target) {
    this.cursorEl.classList.add('down'); await this.wait(140); this.cursorEl.classList.remove('down')
    if (target) { target.classList.add('pressed'); setTimeout(() => target.classList.remove('pressed'), 220) }
    await this.wait(160)
  }
  hideCursor() { this.cursorEl.classList.remove('on') }

  // ── The key, the pill and the words ──
  // The key badge. Default: tap right Option (start or answer a session).
  async tap(cap = '⌥', label = 'tap right option', hold = 0) {
    const k = this.keyEl
    k.querySelector('.cap').textContent = cap; k.querySelector('.lbl').textContent = label
    k.classList.add('on'); await this.wait(220); k.classList.add('down'); await this.wait(hold || 180)
    if (!hold) k.classList.remove('down')
    if (!hold) setTimeout(() => k.classList.remove('on'), 1300)
  }
  release() { this.keyEl.classList.remove('down'); setTimeout(() => this.keyEl.classList.remove('on'), 900) }
  async speak(text, { agent = 'claude', model, key = 'right ⌥', chip } = {}) {
    model = model || (agent === 'codex' ? 'Codex' : 'Claude Code')
    const p = this.pillEl, say = this.sayEl, t = say.querySelector('.us-t')
    p.querySelector('.up-agent img').src = MARK[agent]
    p.querySelector('.up-agent b').textContent = model
    p.className = 'un-pill on listening'
    t.innerHTML = ''
    say.querySelector('.us-key').textContent = key
    say.querySelector('.chip')?.remove()
    say.classList.add('on')
    this.host.dispatchEvent(new CustomEvent('kit:say', { detail: text }))
    const words = text.split(' ')
    const line = sound.on && sound.lines[text]
    let audio = null
    if (line) { audio = new Audio(line.src); audio.play().catch(() => {}) }
    const per = line ? (line.dur * 1000) / words.length : 1000 / WPS
    for (const w of words) {
      const s = document.createElement('span'); s.textContent = w + ' '; t.append(s)
      await this.wait(per)
    }
    if (chip) { say.insertAdjacentHTML('beforeend', `<span class="chip">${chip}</span>`); await this.wait(900) }
    await this.wait(line ? 250 : 650)
    p.classList.remove('listening'); p.classList.add('done')
    await this.wait(450)
    p.className = 'un-pill'
    say.classList.remove('on')
    await this.wait(250)
  }

  // Hold left ⌘ and drag: a region screenshot, attached to what you say.
  async grab(x, y, w, h) {
    await this.move(x, y, 650)
    await this.tap('⌘', 'hold left command, drag', 1)
    const sel = document.createElement('div'); sel.className = 'kit-sel'; this.screen.append(sel)
    const t0 = performance.now(), ms = 900
    await new Promise((res) => { const f = (now) => { const k = reduce ? 1 : Math.min(1, (now - t0) / ms), e = 1 - Math.pow(1 - k, 3)
      Object.assign(sel.style, { left: x + 'px', top: y + 'px', width: w * e + 'px', height: h * e + 'px' }); this.place(this.cursorEl, x + w * e, y + h * e); if (k < 1) requestAnimationFrame(f); else res() }; requestAnimationFrame(f) })
    this.cursor = { x: x + w, y: y + h }
    await this.wait(250)
    this.release(); sel.remove()
    const fl = document.createElement('div'); fl.className = 'kit-flash'; Object.assign(fl.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' }); this.screen.append(fl)
    setTimeout(() => fl.remove(), 600)
    await this.wait(400)
  }

  // ── The notch ──
  // state: { right: {dot:'green'|'orange'|'grey', text, n} } for the bar, or
  // { panel: html, size: [w,h] } for an expanded session, or {} for idle.
  notch(state = {}) {
    const n = this.notchEl, r = n.querySelector('.nb-r'), np = n.querySelector('.np')
    n.classList.remove('bar', 'open', 'pocket')
    if (state.panel) {
      n.classList.add(state.pocket ? 'pocket' : 'open')
      const [w, h] = state.size || [560, 250]
      n.style.width = w + 'px'; n.style.height = h + 'px'
      np.innerHTML = state.panel
    } else if (state.right) {
      n.classList.add('bar')
      const { dot = 'green', text, n: count } = state.right
      r.innerHTML = `<i class="dot ${dot}"></i><span>${text}</span>${count ? `<b class="badge ${dot}">${count}</b>` : ''}`
      n.style.width = (state.width || 360) + 'px'; n.style.height = '32px'
    } else {
      r.innerHTML = ''
      n.style.width = '220px'; n.style.height = '32px'
    }
  }
}

// A session panel, as the app draws it (TaskSurfaceView, compact).
export function panel({ agent = 'claude', title, status = 'working', body = '', actions = '' }) {
  const label = { working: 'Working', needs: 'Needs you', done: 'Done', ready: 'Ready' }[status]
  return `<div class="pn-h"><i class="dot ${status === 'needs' ? 'orange' : status === 'done' ? 'grey' : status === 'ready' ? 'teal' : 'green'}"></i><img src="${MARK[agent]}" alt=""><b>${title}</b><span class="st ${status}">${label}</span></div>
    <div class="pn-b">${body}</div>${actions ? `<div class="pn-a">${actions}</div>` : ''}
    <div class="pn-c"><span>Reply…</span><i></i></div>`
}

// ── Running a scene ──────────────────────────────────────────────────────────
// Plays while at least a third of it is on screen, pauses otherwise, loops.
// Returns controls for the page: pause, replay, and a progress callback.
export function runScene(screen, script, { onStep, loop = true, threshold = 0.33, still } = {}) {
  let visible = false, userPaused = false, run = 0, active = 0
  const sync = () => { screen.clock.paused = userPaused || !visible || document.hidden }
  // Each start gets an id; a replay bumps it, so an old run that is still
  // unwinding can never restart itself next to the new one.
  const start = async () => {
    if (active === run && run) return
    const me = ++run; active = me
    while (me === run) {
      try { await script(screen, (i) => onStep && onStep(i)) } catch (e) { if (e.message !== 'reset') console.error(e); return }
      if (!loop) { active = 0; return }
    }
  }
  if (reduce && still) { still(screen); onStep && onStep(-1); return { pause() {}, replay() {}, get paused() { return true } } }
  new IntersectionObserver(([e]) => { visible = e.intersectionRatio >= threshold; sync(); if (visible && active !== run) start(); else if (visible && !run) start() }, { threshold: [0, threshold, 1] }).observe(screen.host)
  document.addEventListener('visibilitychange', sync)
  return {
    pause(v) { userPaused = v ?? !userPaused; sync(); return userPaused },
    replay() { screen.clock.reset(); active = 0; userPaused = false; sync(); setTimeout(start, 40) },
    get paused() { return userPaused },
  }
}
