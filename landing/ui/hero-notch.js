// THE LIVE NOTCH — Unmute's notch, drawn the way the app draws it, hanging
// from the top of the page and living through a few real moments.
//
// Every number is the app's (unmute-cloud, desktop/native-notch):
//   NotchShape.swift      one path straight through the cutout: concave top
//                         flares, true circular bottom corners, straight floor
//   NotchGeometry.swift   fillet = bottom radius = round(bar × 0.30); panel
//                         uses Theme.panelFillet 14 / panelRadius 18
//   BarContent.swift      edge inset 21, gap 6, dot 7, mark 13 tall, status
//                         11pt medium, badge 9.5pt semibold + 10; both
//                         shoulders set to the wider of the two; the mark is
//                         centred in a shoulder wider than it needs
//   BarContent.resolve    idle = the mark alone; running work fills the RIGHT
//                         shoulder first; what wants you then takes the left
//   NotchView / Badge     status in the status hue; badge tinted 17% / 26%
//   Theme.swift           morph 0.24s easeInOut; content out 0.09 easeIn, in
//                         0.14 easeOut after 0.08; working dot breathes 1.2s
//   TaskSurfaceView       header: dot 9 · provider mark · 17pt semibold title ·
//                         status; the user's bubble; the composer
// The camera cutout is 200×34, a 14" MacBook Pro (UNMUTE_FAKE_NOTCH=200x34).
;(() => {
  const root = document.querySelector('.live-notch')
  if (!root) return
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches

  const BAR = 34, MIDDLE = 200, FILLET = Math.round(BAR * 0.3), CORNER = Math.round(BAR * 0.3)
  const EDGE = 13 + 8, GAP = 6, DOT = 7, MARK_H = 13, MARK_W = MARK_H * (126 / 78) + 2
  const PANEL = { w: 600, h: 196, fillet: 14, radius: 18 }
  const C = { processing: '#30D158', needsUser: '#FF9230', ready: '#00D2E0', failed: '#FF4245' }
  const LABEL = { processing: 'Working', needsUser: 'Needs you' }
  const SF = '-apple-system, BlinkMacSystemFont, "SF Pro Text", Inter, system-ui, sans-serif'
  const MARKS = { claude: 'assets/mark-claude.png', codex: 'assets/mark-codex.png' }
  const cubic = (t) => { // SwiftUI .easeInOut = cubic-bezier(.42,0,.58,1), solved for y(x)
    let lo = 0, hi = 1
    for (let i = 0; i < 18; i++) { const m = (lo + hi) / 2, x = 3 * m * (1 - m) * (1 - m) * .42 + 3 * m * m * (1 - m) * .58 + m * m * m; if (x < t) lo = m; else hi = m }
    const s = (lo + hi) / 2; return 3 * s * s * (1 - s) + s * s * s
  }

  const ctx = document.createElement('canvas').getContext('2d')
  const textW = (s, size, weight) => { ctx.font = `${weight} ${size}px ${SF}`; return ctx.measureText(s).width }
  const badgeW = (n) => Math.ceil(textW(String(n), 9.5, 600) + 10)

  // ── What a bar says → how wide each shoulder is (BarContent.leftWidth…) ──
  function shoulders(c) {
    const lw = c.left == null ? 0 : Math.ceil(EDGE + (c.left.dot ? DOT + GAP : 0)
      + (c.left.mark ? MARK_W : textW(c.left.text, 11, 500)) + (c.left.badge ? GAP + badgeW(c.left.badge) : 0) + GAP)
    const rw = c.right == null ? 0 : Math.ceil(EDGE + DOT + GAP + textW(c.right.text, 11, 500)
      + (c.right.badge ? GAP + badgeW(c.right.badge) : 0) + GAP)
    const sh = Math.max(lw, rw)
    return { L: lw ? sh : 0, R: rw ? sh : 0, lw }
  }

  // ── The shape (NotchShape.path), around the cutout's centre ──────────────
  // The fill is a div clipped to the path, so it can blur what's behind it.
  // At bar level it is opaque black (the app's rule D5: the bar continues the
  // hardware). Opened, it thins to the glass tone: shell black 25% over a
  // blurred backdrop, with the content plane (black 34%) inset inside it.
  const svg = root.querySelector('svg'), path = svg.querySelector('path')
  const glass = root.querySelector('.ln-glass')
  const shapeD = (p, dx) => {
    const x0 = -(MIDDLE / 2 + p.L + p.f) + dx, x1 = MIDDLE / 2 + p.R + p.f + dx
    const f = Math.max(Math.min(p.f, (x1 - x0) / 2, p.H), 0)
    const a = x0 + f, b = x1 - f
    const r = Math.max(Math.min(p.r, (b - a) / 2, p.H - f), 0)
    return `M ${x0} 0 Q ${a} 0 ${a} ${f} L ${a} ${p.H - r} A ${r} ${r} 0 0 0 ${a + r} ${p.H} `
      + `L ${b - r} ${p.H} A ${r} ${r} 0 0 0 ${b} ${p.H - r} L ${b} ${f} Q ${b} 0 ${x1} 0 Z`
  }
  function draw(p) {
    path.setAttribute('d', shapeD(p, 0))
    glass.style.clipPath = `path('${shapeD(p, 560)}')`
    const k = Math.min(1, Math.max(0, (p.H - BAR) / (PANEL.h - BAR)))
    glass.style.background = `rgba(0,0,0,${(1 - 0.75 * k).toFixed(3)})`
  }
  let cur = { L: 0, R: 0, H: BAR, f: FILLET, r: CORNER }
  function morph(to, ms = 240) {
    const from = { ...cur }
    if (reduce || !ms) { cur = to; draw(cur); return Promise.resolve() }
    return new Promise((done) => {
      const t0 = performance.now()
      const step = (now) => {
        const t = Math.min(1, (now - t0) / ms), k = t >= 1 ? 1 : cubic(t)
        for (const key in to) cur[key] = from[key] + (to[key] - from[key]) * k
        draw(cur)
        if (k < 1) requestAnimationFrame(step); else done()
      }
      requestAnimationFrame(step)
    })
  }

  // ── Bar content (NotchView.barRow) ───────────────────────────────────────
  const bar = root.querySelector('.ln-bar'), panel = root.querySelector('.ln-panel')
  const dot = (s, breathe) => `<i class="ln-dot${breathe ? ' breathe' : ''}" style="background:${C[s]}"></i>`
  const badge = (n, s) => `<b class="ln-badge" style="color:${C[s]};background:${C[s]}2b;box-shadow:inset 0 0 0 .5px ${C[s]}42">${n}</b>`
  function barHTML(c, sh) {
    let left = '', right = ''
    if (c.left) {
      const centred = c.left.mark && sh.L > sh.lw + 1
      left = `<div class="ln-half ln-left${centred ? ' centred' : ''}" style="width:${sh.L}px">`
        + (c.left.dot ? dot(c.left.dot, c.left.dot === 'processing') : '')
        + (c.left.mark ? '<img class="ln-mark" src="assets/unmark.png" alt="">' : `<span style="color:${c.left.alarm ? C[c.left.alarm] : 'rgba(255,255,255,.95)'}">${c.left.text}</span>`)
        + (c.left.badge ? badge(c.left.badge, c.left.alarm || c.left.dot) : '') + '</div>'
    }
    if (c.right) {
      right = `<div class="ln-half ln-right" style="width:${sh.R}px">${dot(c.right.dot, c.right.dot === 'processing')}<span>${c.right.text}</span>`
        + (c.right.badge ? badge(c.right.badge, c.right.dot) : '') + '</div>'
    }
    return `<div class="ln-row" style="--l:${sh.L}px;--r:${sh.R}px">${left}<div class="ln-mid"></div>${right}</div>`
  }
  const fade = (el, on, ms) => el.animate(on ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 1 }, { opacity: 0 }],
    { duration: reduce ? 0 : ms, delay: on && !reduce ? 80 : 0, easing: on ? 'ease-out' : 'ease-in', fill: 'forwards' }).finished
  let state = null
  async function showBar(c) {
    const sh = shoulders(c)
    if (state === 'panel') { await fade(panel, false, 90) ; panel.hidden = true }
    else await fade(bar, false, 90)
    bar.innerHTML = barHTML(c, sh)
    await morph({ L: sh.L, R: sh.R, H: BAR, f: FILLET, r: CORNER })
    bar.hidden = false
    fade(bar, true, 140)
    state = 'bar'
  }

  // ── The expanded session (TaskSurfaceView, compact) ──────────────────────
  const $ = (s) => panel.querySelector(s)
  async function openPanel(t) {
    await fade(bar, false, 90); bar.hidden = true
    const side = (PANEL.w - MIDDLE) / 2 - PANEL.fillet
    panel.hidden = false
    setHeader(t)
    $('.ln-said').innerHTML = ''; $('.ln-said').hidden = true
    $('.ln-ask').hidden = !t.ask; $('.ln-ask').textContent = t.ask || ''
    $('.ln-work').hidden = true
    composer('idle')
    panel.style.opacity = 0
    await morph({ L: side, R: side, H: PANEL.h, f: PANEL.fillet, r: PANEL.radius })
    fade(panel, true, 140)
    state = 'panel'
  }
  function setHeader(t) {
    $('.ln-head').innerHTML = `${dot(t.status, t.status === 'processing').replace('ln-dot', 'ln-dot big')}`
      + `<img class="ln-pmark" src="${MARKS[t.agent]}" alt=""><span class="ln-title">${t.title}</span>`
      + (t.status ? `<span class="ln-status" style="color:${C[t.status]}">${LABEL[t.status]}</span>` : '')
  }
  function composer(mode) {
    $('.ln-composer').classList.toggle('listening', mode === 'listening')
  }
  async function speak(words) {
    const said = $('.ln-said')
    said.hidden = false; said.innerHTML = ''
    composer('listening')
    for (const w of words.split(' ')) {
      const s = document.createElement('span'); s.textContent = w + ' '; said.append(s)
      s.animate([{ opacity: 0 }, { opacity: 1 }], { duration: reduce ? 0 : 160, fill: 'forwards' })
      await sleep(reduce ? 0 : 150)
    }
    await sleep(350)
    composer('idle')
  }

  // ── The live waveform in the aimed chip (DotWave, simplified) ─────────────
  const bars = [...panel.querySelectorAll('.ln-wave i')]
  ;(function wave(t) {
    if (panel.querySelector('.ln-composer.listening')) bars.forEach((b, i) => {
      const v = 0.3 + 0.7 * Math.abs(Math.sin(t / 150 + i * 0.85) * Math.sin(t / 410 + i * 0.3))
      b.style.height = (2.5 + v * 8.5).toFixed(1) + 'px'
    })
    requestAnimationFrame(wave)
  })(0)

  // ── What happens: a few real moments, on a loop ──────────────────────────
  let visible = false, wake = null
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const whenVisible = () => visible ? Promise.resolve() : new Promise((r) => { wake = r })
  new IntersectionObserver(([e]) => { visible = e.isIntersecting && !document.hidden; if (visible && wake) { wake(); wake = null } }).observe(root)
  const hold = async (ms) => { await sleep(ms); await whenVisible() }

  const IDLE = { left: { mark: true } }
  const working = (n) => ({ left: { mark: true }, right: { dot: 'processing', text: 'Working', badge: n } })
  const needs = { left: { dot: 'needsUser', text: 'Needs you', badge: 1, alarm: 'needsUser' }, right: { dot: 'processing', text: 'Working', badge: 1 } }
  const sending = { left: { mark: true }, right: { dot: 'processing', text: 'Sending' } }

  // It hangs from the nav's bottom edge: the nav is the menu bar here. On a
  // phone it is scaled to fit.
  const place = () => {
    root.style.top = document.querySelector('nav.top').offsetHeight + 'px'
    root.style.transform = innerWidth < 760 ? `scale(${Math.min(0.62, (innerWidth - 24) / PANEL.w).toFixed(3)})` : ''
  }
  place(); addEventListener('resize', place)

  async function run() {
    draw(cur)
    if (reduce) { await showBar(working(2)); return }
    await showBar(IDLE)
    for (;;) {
      await hold(1600)
      // 1 · A new Claude Code session, started by voice.
      await openPanel({ agent: 'claude', title: 'New session' })
      await hold(500)
      await speak('Build a first version of the new onboarding flow.')
      setHeader({ agent: 'claude', title: 'Onboarding flow', status: 'processing' })
      $('.ln-work').hidden = false
      await hold(2200)
      await showBar(sending); await hold(900)
      await showBar(working(1)); await hold(2200)
      // 2 · A Codex session, while the first one works.
      await openPanel({ agent: 'codex', title: 'New session' })
      await hold(400)
      await speak('Add tests for the signup form.')
      setHeader({ agent: 'codex', title: 'Signup tests', status: 'processing' })
      $('.ln-work').hidden = false
      await hold(2000)
      await showBar(working(2)); await hold(2400)
      // 3 · One of them needs you. It says so, and you answer out loud.
      await showBar(needs); await hold(2600)
      await openPanel({ agent: 'claude', title: 'Onboarding flow', status: 'needsUser', ask: 'Should I keep the optional team setup step, or move it later?' })
      await hold(1400)
      await speak('Move it after the first project.')
      setHeader({ agent: 'claude', title: 'Onboarding flow', status: 'processing' })
      await hold(1800)
      await showBar(working(2)); await hold(2600)
      await showBar(IDLE)
    }
  }
  run()
})()
