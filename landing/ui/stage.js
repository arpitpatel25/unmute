// THE STAGE — a Mac screen holding the app's REAL surfaces.
//
// Every notch/pill image is a capture of unmute-notch (unmute-cloud db2a2016)
// placed at the exact window position the helper used (assets/ui/manifest.json).
// The only thing drawn here is what MOVES: the waveform bars, from the app's own
// math (LevelMeterSupport/LevelMeter.swift + DotWave.swift), laid exactly over
// the resting dots in the capture — which are those same bars at floor height.
// The screen is drawn at real size, 1120×700pt, so the notch and pill read
// as they do on a laptop without a camera move. The captures were placed on a
// 1440×900 screen; on load they're moved to the same spot on this one: the
// notch stays centred at the top, the pill keeps its distance from the bottom.
const SCREEN_W = 1120, SCREEN_H = 700
const CAPTURED_W = 1440, CAPTURED_H = 900

// ── LevelMeter.swift + DotWave.swift, ported line for line ────────────────────
const LevelMeter = {
  gate: 0.018, ceiling: 0.32, attack: 0.42, release: 0.22,
  target(raw) { const v = Math.min(1, Math.max(0, raw)); if (v <= this.gate) return 0; return Math.pow(Math.min(1, (v - this.gate) / (this.ceiling - this.gate)), 0.62) },
  advance(env, t) { const n = env + (t - env) * (t > env ? this.attack : this.release); return n < 0.004 ? 0 : n },
}
const DotWave = {
  shape: (mode, i, n) => Math.sin(Math.PI * mode * (i + 1) / (n + 1)),
  barHeight(i, n, time, amp) {
    if (amp <= 0) return 0
    const arch = Math.sin(Math.PI * (i + 1) / (n + 1))
    const a = this.shape(2, i, n) * Math.sin(2 * Math.PI * 3.1 * time)
    const b = this.shape(3, i, n) * Math.sin(2 * Math.PI * 5.3 * time)
    const wobble = 0.5 + 0.5 * ((a + 0.5 * b) / 1.5)
    return Math.max(0, Math.min(1, amp * (0.45 + 0.55 * arch) * (0.25 + 0.75 * wobble)))
  },
}

// WHERE THE BARS ARE, derived from the source layout (PillView.swift):
// recording capsule = pad 7 · ✕ 22 · 9 · wave 58 · [9 · ⌨ 22] · 9 · ✓ 22 · pad 7,
// height 36, bottom-aligned in its asset. Cross-checked against a pixel scan of
// every capture (tools/find-live.mjs). Waveform(): 11 bars, 3 wide, 2.5 apart,
// 16 tall. AimedChip compact: 7 bars, 2 wide, 1.5 apart, 9 tall.
const PILL = { count: 11, w: 3, gap: 2.5, h: 16 }
const AIMED = { count: 7, w: 2, gap: 1.5, h: 9 }
const capsule = (assetW, assetH, capsuleW, fromRight = true) =>
  ({ x: (fromRight ? assetW - capsuleW : 0) + 38, cy: assetH - 18 })
function liveFor(name, a) {
  const withType = 165, plain = 134
  switch (name) {
    case 'pill-fn-rec.pill': return { ...PILL, ...capsule(a.w, a.h, plain, false) }
    case 'pill-scratch-rec.pill': return { ...PILL, ...capsule(a.w, a.h, plain, false) }
    case 'pill-ropt-rec.pill': case 'pill-agent-rec.pill': case 'pill-flash.pill':
      return { ...PILL, ...capsule(a.w, a.h, withType) }
    case 'pocket-aimed.pill': case 'pocket-onb-aimed.pill': case 'onb-ask-aimed.pill':
      return { ...PILL, ...capsule(a.w, a.h, plain) }
    case 'pill-codex-rec.pill': return { ...PILL, ...capsule(a.w, a.h, withType) }
    case 'pocket-aimed.notch': return { ...AIMED, x: 286, cy: 123 }
    case 'pocket-onb-aimed.notch': return { ...AIMED, x: 286, cy: 84.75 }
    // The task panel's footer carries the full-size AimedChip: 9 × 2.5pt bars,
    // 2pt apart, 11pt tall — measured from the capture.
    case 'onb-ask-aimed.notch': return { count: 9, w: 2.5, gap: 2, h: 11, x: 313, cy: 372.75 }
    default:
      if (/^pad-\d\.pill$/.test(name)) return { ...PILL, x: 38, cy: a.h - 18 }
      return null
  }
}

let manifest = null
const ready = fetch(new URL('../assets/ui/manifest.json', import.meta.url)).then((r) => r.json()).then((m) => {
  manifest = m
  for (const [k, v] of Object.entries(m)) {
    v.x -= (CAPTURED_W - SCREEN_W) / 2
    if (k.endsWith('.pill')) v.y -= CAPTURED_H - SCREEN_H
  }
})
const rawUrl = (k) => new URL(`../assets/ui/${k}.png`, import.meta.url).href

// CAPTURE CLEANUP: every expanded panel was captured while scrolled up, so
// the helper's transient "Jump to latest" chip is baked in. Paint it out, row
// by row, with the panel colours just outside it. Regions are in capture
// pixels (2×). The source files stay untouched.
const CHIP = [350, 494, 890, 588]
const PATCH = {
  'onb-ask.notch': [160, 286, 1136, 376], 'onb-ask-aimed.notch': [160, 286, 1136, 376],
}
for (const k of ['onb-1', 'onb-2', 'onb-3', 'onb-continue', 'agent-recall-1', 'agent-recall-2', 'agent-meetonb-2',
  'task-1', 'task-2', 'task-3', 'task-4', 'agent-save-1', 'agent-save-2', 'agent-ask-1', 'agent-ask-2', 'agent-meet-1', 'agent-meet-2', 'agent-meet-3'])
  PATCH[k + '.notch'] ??= CHIP
// GLASS: the helper's panels and pocket cards are translucent glass, but a
// screenshot bakes whatever was behind them in as solid colour. Give it back:
// the dark panel tone becomes a partly transparent tint (GLASS_TINT), while
// anything brighter than the tone — text, chips, icons — stays solid. The page
// then blurs what's really behind the panel (.slot .pane.glass in mac.css).
// The notch bar and the pill are solid black in the app, so they stay opaque.
const GLASS_TINT = 0.7
const isGlass = (k) => k.endsWith('.notch') && manifest?.[k]?.h > 60
const cleaned = {}
const OUTLINE = {}
// Where a surface sits on screen. A glass panel's box is its outline (so a
// rounded box can clip the blur behind it); its capture sits inside, offset.
function placed(k) {
  const m = manifest[k], o = isGlass(k) && OUTLINE[k]
  return o ? { x: m.x + o.l, y: m.y, w: m.w - o.l - o.r, h: m.h - o.b, ox: o.l } : { x: m.x, y: m.y, w: m.w, h: m.h, ox: 0 }
}
function placePane(pane, k) {
  const r = placed(k), m = manifest[k]
  Object.assign(pane.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' })
  Object.assign(pane.querySelector('img').style, { left: -r.ox + 'px', width: m.w + 'px', height: m.h + 'px' })
}
function clean(k) {
  return new Promise((done) => {
  const img = new Image()
  img.onerror = done
  img.onload = () => {
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height
    const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0)
    if (PATCH[k]) {
      const [x0, y0, x1, y1] = PATCH[k]
      const px = (x, y) => g.getImageData(x, y, 1, 1).data
      for (let y = y0; y < y1; y++) {
        const a = px(x0 - 2, y), b = px(x1 + 2, y)
        const grad = g.createLinearGradient(x0, 0, x1, 0)
        grad.addColorStop(0, `rgba(${a[0]},${a[1]},${a[2]},${a[3] / 255})`)
        grad.addColorStop(1, `rgba(${b[0]},${b[1]},${b[2]},${b[3] / 255})`)
        g.fillStyle = grad; g.fillRect(x0, y, x1 - x0, 1)
      }
    }
    if (isGlass(k)) {
      const d = g.getImageData(0, 0, c.width, c.height), p = d.data
      // The panel's outline inside its capture, in points: the blur behind it
      // is clipped to this (Chrome doesn't clip backdrop blur to a mask).
      const A = (x, y) => p[(y * c.width + x) * 4 + 3], mid = c.height >> 1, cx = c.width >> 1
      let l = 0, r = c.width - 1, btm = c.height - 1
      while (l < cx && A(l, mid) < 250) l++
      while (r > cx && A(r, mid) < 250) r--
      while (btm > mid && A(cx, btm) < 250) btm--
      OUTLINE[k] = { l: l / 2, r: (c.width - 1 - r) / 2, b: (c.height - 1 - btm) / 2 }
      document.querySelectorAll(`.stage .slot .pane[data-key="${k}"]`).forEach((el) => placePane(el, k))
      for (let i = 0; i < p.length; i += 4) {
        const L = 0.2126 * p[i] + 0.7152 * p[i + 1] + 0.0722 * p[i + 2]
        const t = Math.min(1, Math.max(0, (L - 62) / 58)), lift = t * t * (3 - 2 * t)
        p[i + 3] = Math.round(p[i + 3] * (GLASS_TINT + (1 - GLASS_TINT) * lift))
      }
      g.putImageData(d, 0, 0)
    }
    c.toBlob((blob) => {
      cleaned[k] = URL.createObjectURL(blob)
      document.querySelectorAll(`.stage .slot .pane[data-key="${k}"] img`).forEach((el) => { el.src = cleaned[k] })
      done()
    })
  }
  img.src = rawUrl(k)
  })
}
const assetUrl = (k) => cleaned[k] || rawUrl(k)

// Fetch only what the demos use, in the order they ask for it (the hero is
// built first, so its captures come first). Cleaning runs in the background so
// a demo never waits on it; a panel already on screen swaps to its clean copy.
const fetched = new Set()
function preload(keys) {
  for (const k of keys) {
    if (fetched.has(k) || !manifest?.[k]) continue
    fetched.add(k)
    if (PATCH[k] || isGlass(k)) clean(k); else { const i = new Image(); i.src = rawUrl(k) }
  }
}

// Menu bar glyphs, drawn rather than shipped as images.
const APPLE = `<svg class="mb-apple" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M17.3 12.6c0-2.4 2-3.6 2.1-3.7-1.1-1.7-2.9-1.9-3.5-1.9-1.5-.2-2.9.9-3.7.9-.8 0-1.9-.9-3.2-.8-1.6 0-3.1 1-4 2.4-1.7 3-.4 7.4 1.2 9.8.8 1.2 1.8 2.5 3 2.4 1.2-.1 1.7-.8 3.1-.8 1.5 0 1.9.8 3.2.8 1.3 0 2.1-1.2 2.9-2.4.9-1.3 1.3-2.6 1.3-2.7-.1 0-2.5-1-2.4-4ZM14.9 5.5c.7-.8 1.1-1.9 1-3-1 0-2.1.7-2.8 1.5-.6.7-1.2 1.8-1 2.9 1 .1 2.1-.5 2.8-1.4Z"/></svg>`
const STATUS = `<svg viewBox="0 0 28 14" class="mb-ico" aria-hidden="true"><rect x="1" y="2" width="22" height="10" rx="3" fill="none" stroke="currentColor" stroke-opacity=".55"/><rect x="3" y="4" width="15" height="6" rx="1.5" fill="currentColor"/><rect x="24.5" y="5.5" width="1.6" height="3" rx=".8" fill="currentColor" fill-opacity=".55"/></svg>`
  + `<svg viewBox="0 0 18 14" class="mb-ico" aria-hidden="true"><path d="M9 12.6 6.6 10a3.4 3.4 0 0 1 4.8 0L9 12.6Zm-4.3-4.5-1.5-1.6a8.2 8.2 0 0 1 11.6 0l-1.5 1.6a6 6 0 0 0-8.6 0ZM1.5 4.8 0 3.2a12.8 12.8 0 0 1 18 0l-1.5 1.6a10.6 10.6 0 0 0-15 0Z" fill="currentColor"/></svg>`
  + `<svg viewBox="0 0 16 14" class="mb-ico" aria-hidden="true"><circle cx="6.5" cy="6" r="4.6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="m10 9.5 4 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`
  + `<svg viewBox="0 0 16 14" class="mb-ico" aria-hidden="true"><rect x="1" y="1.5" width="14" height="4.5" rx="2.25" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="12.6" cy="3.75" r="1.4" fill="currentColor"/><rect x="1" y="8" width="14" height="4.5" rx="2.25" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="3.4" cy="10.25" r="1.4" fill="currentColor"/></svg>`

export class Stage {
  constructor(host, opts = {}) {
    const apps = opts.apps || ''
    this.host = host
    host.classList.add('stage')
    host.innerHTML = `
      <div class="screen"><div class="cam wallpaper">
        <div class="menubar"><span class="mb-left">${APPLE}<b class="mb-app">Finder</b><span>File</span><span>Edit</span><span>View</span><span>Window</span><span>Help</span></span><span class="mb-right">${STATUS}<span>Tue Oct 14</span><span>9:41 AM</span></span></div>
        <div class="apps">${apps}</div>
        <div class="hw-notch"></div>
        <div class="slot" data-role="notch"><div class="shell"></div><div class="pane"><img alt=""></div><div class="pane"><img alt=""></div></div>
        <div class="slot" data-role="pill"><div class="shell"></div><div class="pane"><img alt=""></div><div class="pane"><img alt=""></div></div>
        <canvas class="live" width="${SCREEN_W * 2}" height="${SCREEN_H * 2}"></canvas>
        <div class="extra"></div>
        <div class="voice"><div class="bubble"><div class="hd"><span class="you">🎙 you say</span><kbd></kbd></div><q></q></div><div class="result"></div></div>
      </div></div>`
    this.screen = host.querySelector('.screen')
    this.cam = host.querySelector('.cam')
    this.camera = opts.camera !== false
    this.fullScreen = opts.fullScreen ?? false
    this.strength = opts.zoom ?? 1
    this.home = opts.home || null
    this.desktopView = opts.desktopView || { w: SCREEN_W, h: SCREEN_H }
    this.mobileZoom = opts.mobileZoom ?? 1
    this.canvas = host.querySelector('.live')
    this.ctx = this.canvas.getContext('2d')
    this.current = { notch: null, pill: null }
    this.env = 0; this.speaking = false; this.visible = true
    this.fit()
    new ResizeObserver(() => this.fit()).observe(host)
    new IntersectionObserver(([e]) => { this.visible = e.isIntersecting }).observe(host)
    const loop = (t) => { this.frame(t / 1000); requestAnimationFrame(loop) }
    requestAnimationFrame(loop)
  }
  // THE VIEW onto the screen. Desktop sees the whole 1440×900 screen. A phone
  // gets a 4:5 portrait window that pans and zooms to the active surface —
  // a whole Mac squeezed into 350px makes a 36pt pill about 9px tall.
  fit() {
    this.mobile = matchMedia('(max-width: 700px)').matches
    this.host.querySelector('.bubble').style.maxWidth = (this.mobile ? 340 : 560) + 'px'
    this.view = this.fullScreen ? { w: SCREEN_W, h: SCREEN_H } : this.mobile ? { w: 640, h: 800 } : this.desktopView
    this.host.style.aspectRatio = `${this.view.w} / ${this.view.h}`
    Object.assign(this.screen.style, { width: this.view.w + 'px', height: this.view.h + 'px',
      transform: `scale(${this.host.clientWidth / this.view.w})` })
    this.focus()
  }
  extra() { return this.host.querySelector('.extra') }
  app(name) { this.host.querySelectorAll('.app').forEach((a) => a.classList.toggle('on', a.dataset.app === name)); const t = this.host.querySelector(`.app[data-app="${name}"]`); if (t) this.host.querySelector('.mb-app').textContent = t.dataset.title || name }

  // Swap a surface the way the notch does it: the SHAPE moves first, and the
  // content follows. The old content fades out, a solid shell grows (or
  // shrinks) from the old outline to the new one on a soft spring, and the new
  // capture fades in as the shell settles. Surfaces of the same outline (a
  // panel whose text changed) just crossfade, as the app's content swap does.
  set(role, name) {
    if (this.current[role] === name) return
    const prevKey = this.current[role] && `${this.current[role]}.${role}`
    this.current[role] = name
    const slot = this.host.querySelector(`.slot[data-role="${role}"]`)
    const [a, b] = slot.querySelectorAll('.pane')
    const [live, next] = a.classList.contains('on') ? [a, b] : [b, a]
    const key = name && `${name}.${role}`
    const to = key && manifest?.[key] ? placed(key) : null
    const from = live.querySelector('img').getAttribute('src') && prevKey && manifest?.[prevKey] ? placed(prevKey) : null
    for (const el of [a, b, slot.querySelector('.shell')]) el.getAnimations().forEach((x) => x.cancel())
    live.classList.remove('on')
    const img = next.querySelector('img')
    if (to) {
      next.dataset.key = key
      next.classList.toggle('glass', isGlass(key))
      placePane(next, key)
      img.src = assetUrl(key)
      next.classList.add('on')
    } else { img.removeAttribute('src'); next.classList.remove('on'); delete next.dataset.key }
    if (this.instant) return
    this.morph(role, slot, live, to ? next : null, from, to)
  }

  // Where a surface grows from, or shrinks back into, when there's no other
  // surface: the hardware notch for the notch, a dot at the pill's centre.
  rest(role, near) {
    if (role === 'notch') return { x: SCREEN_W / 2 - 100, y: 0, w: 200, h: 34 }
    const r = near || { x: SCREEN_W / 2 - 18, y: SCREEN_H - 139, w: 36, h: 36 }
    return { x: r.x + r.w / 2 - 18, y: r.y + r.h - 36, w: 36, h: 36 }
  }
  morph(role, slot, out, inn, from, to) {
    const shell = slot.querySelector('.shell')
    const a = from || this.rest(role, to), b = to || this.rest(role, from)
    const same = from && to && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h
    if (same) {
      // Content swap only (Theme.swift): out 90ms easeIn, in 140ms easeOut after 80ms.
      out.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 90, easing: 'ease-in', fill: 'forwards' })
      inn?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 140, delay: 80, easing: 'ease-out', fill: 'backwards' })
      return
    }
    const grow = b.w * b.h >= a.w * a.h
    const R = (r) => role === 'pill' ? Math.min(r.h, r.w) / 2 + 'px' : `0 0 ${r.h > 60 ? 22 : 10}px ${r.h > 60 ? 22 : 10}px`
    const box = (r) => ({ left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px', borderRadius: R(r) })
    const dur = grow ? 560 : 420
    // A spring with a little give on the way out; a firm ease on the way back in.
    const easing = grow ? 'cubic-bezier(.32,1.14,.5,1)' : 'cubic-bezier(.5,0,.2,1)'
    const tint = role === 'notch' && b.h > 60 ? 'rgba(33,28,56,.72)' : '#000'
    shell.classList.toggle('glass', role === 'notch' && b.h > 60)
    shell.animate([box(a), box(b)], { duration: dur, easing, fill: 'forwards' })
    shell.animate([{ opacity: 1, background: '#000' }, { opacity: 1, background: tint, offset: 0.8 }, { opacity: 0, background: tint }],
      { duration: dur + 180, fill: 'forwards' })
    if (from) out.animate([{ opacity: 1 }, { opacity: 0 }], { duration: grow ? 120 : 140, easing: 'ease-in', fill: 'forwards' })
    if (inn) inn.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, delay: dur * (grow ? 0.55 : 0.75), easing: 'ease-out', fill: 'backwards' })
    // The incoming capture rides the shell: it opens out from the old outline.
    if (inn && grow) {
      const inset = (r) => `inset(${r.y - b.y}px ${b.x + b.w - (r.x + r.w)}px ${b.y + b.h - (r.y + r.h)}px ${r.x - b.x}px round ${R(r)})`
      inn.animate([{ clipPath: inset(a) }, { clipPath: inset(b) }], { duration: dur, easing })
    }
  }
  speak(on) { this.speaking = on }

  // ── WHAT YOU SAID, AND WHAT IT DID ─────────────────────────────────────────
  // An annotation, not product UI: a quote bubble grows out of the pill while
  // you speak (words land in time with the waveform), folds back into the pill
  // on ✓, and its words fly to where the work happened, which gets a label.
  pillAnchor() {
    const p = this.current.pill, m = p && manifest?.[`${p}.pill`]
    if (!m) return { x: SCREEN_W / 2, y: SCREEN_H - 140 }
    // Cluster assets are bottom-aligned; pad assets carry the pad to the right
    // of a 178pt cluster, so anchor on the cluster itself.
    const w = /^(pad-|pill-paused)/.test(p) ? 178 : m.w
    return { x: m.x + w / 2, y: m.y + m.h - 36 }
  }
  voice(key, text, speaking) {
    const b = this.host.querySelector('.bubble'), q = b.querySelector('q')
    if (speaking && text) {
      const sig = key + '|' + text
      if (b.dataset.sig !== sig) {
        b.dataset.sig = sig
        b.querySelector('kbd').textContent = key || ''
        b.querySelector('kbd').style.display = key ? '' : 'none'
        const words = text.split(' '), step = Math.min(300, 2300 / words.length) / (this.playbackRate || 1)
        // The quote marks ride INSIDE the first and last word, so a closing ”
        // can never wrap onto a line of its own.
        const last = words.length - 1
        q.innerHTML = words.map((w, i) => `<span class="w" style="animation-delay:${Math.round(i * step)}ms">${i === 0 ? '<i>“</i>' : ''}${w}${i === last ? '<i>”</i>' : ''}</span>`).join(' ')
      }
      const a = this.pillAnchor()
      Object.assign(b.style, { left: a.x + 'px', top: a.y - 16 + 'px', maxWidth: (this.mobile ? 340 : 560) + 'px' })
      b.classList.remove('sent'); b.classList.add('on')
      this.lastSaid = text
    } else if (b.classList.contains('on')) {
      b.classList.remove('on'); b.classList.add('sent')
    }
  }
  land(label, at, labelAt) {
    const r = this.host.querySelector('.result')
    if (!label || !at) { r.classList.remove('on'); return }
    const [x, y] = at, from = this.pillAnchor()
    // The words travel from the pill to the place they landed.
    const f = document.createElement('div')
    f.className = 'flight'
    f.textContent = '“' + (this.lastSaid || '') + '”'
    f.style.left = from.x + 'px'; f.style.top = from.y - 20 + 'px'
    this.host.querySelector('.voice').append(f)
    f.animate([{ transform: 'translate(-50%,-50%) scale(1)', opacity: 1 },
      { transform: `translate(calc(-50% + ${x - from.x}px), calc(-50% + ${y - from.y + 20}px)) scale(.55)`, opacity: 0 }],
      { duration: 700, easing: 'cubic-bezier(.42,0,.58,1)' }).onfinish = () => f.remove()
    r.textContent = label
    const [lx, ly] = labelAt || [x, y < 200 ? y + 24 : y - 64]
    r.style.left = lx + 'px'
    r.style.top = ly + 'px'
    r.classList.remove('on'); void r.offsetWidth
    clearTimeout(this.resultRevealT)
    this.resultRevealT = setTimeout(() => r.classList.add('on'), 450)
    clearTimeout(this.resultT)
    this.resultT = setTimeout(() => r.classList.remove('on'), 3200)
  }

  // THE CAMERA — the production bible's "punch in on the active area". Real
  // proportions are kept (a 36pt pill IS small on a 14" screen); the view
  // moves to it instead. Target follows what is on screen.
  focus() {
    if (!this.camera || !this.view) return
    const n = this.current.notch || '', p = this.current.pill || ''
    const M = this.mobile
    let f = null
    if (this.target) f = this.target                                          // a scene named its own subject
    else if (/^pocket-/.test(n) && p) f = M ? { x: 720, y: 400, z: 0.95, ay: 0.5 } : { x: 720, y: 330, z: 1.15, ay: 0.4 }   // card AND pill both matter
    else if (/^(task-|agent-|onb-)/.test(n) && p) f = M ? { x: 720, y: 400, z: 0.96, ay: 0.5 } : { x: 720, y: 400, z: 1.1, ay: 0.5 }
    else if (/^(pad-|pill-paused)/.test(p)) f = M ? { x: 895, y: 640, z: 1.15, ay: 0.6 } : { x: 900, y: 640, z: 1.55, ay: 0.55 }
    else if (p) f = M ? { x: 720, y: 779, z: 1.75, ay: 0.72 } : { x: 720, y: 779, z: 1.9, ay: 0.72 }
    else if (/^(task-|agent-|onb-)/.test(n)) f = M ? { x: 720, y: 0, z: 0.96, ay: 0 } : { x: 720, y: 0, z: 1.3, ay: 0 }
    else if (/^pocket-/.test(n)) f = M ? { x: 720, y: 0, z: 1.7, ay: 0 } : { x: 720, y: 0, z: 1.9, ay: 0 }
    else if (n) f = M ? { x: 720, y: 0, z: 1.45, ay: 0 } : { x: 720, y: 0, z: 2.1, ay: 0 }
    // Idle framing: the scene's own HOME shot if it has one (framed on where
    // the action will happen), else the whole screen.
    if (!f) f = this.home || { x: 720, y: 450, z: M ? 0.9 : 1, ay: 0.5 }
    const { w: VW, h: VH } = this.view
    const minZ = Math.max(VW / SCREEN_W, VH / SCREEN_H)
    // Desktop zoom is softened per stage (`zoom` option); a phone needs all of it.
    const z = Math.max(minZ, M ? f.z * this.mobileZoom : 1 + (f.z - 1) * this.strength)
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
    const tx = clamp(VW / 2 - f.x * z, VW - SCREEN_W * z, 0)
    const ty = clamp(VH * f.ay - f.y * z, VH - SCREEN_H * z, 0)
    this.cam.style.transform = `translate(${tx}px, ${ty}px) scale(${z})`
  }


  frame(t) {
    if (!this.visible || this.paused) return
    // A SPEAKING VOICE for the meter: syllable-rate bursts under a slow phrase
    // envelope, fed through the app's own gate/attack/release.
    const raw = this.speaking
      ? 0.14 + 0.18 * (0.5 + 0.5 * Math.sin(t * 7.3)) * (0.65 + 0.35 * Math.sin(t * 13.1 + 1.3)) * (0.75 + 0.25 * Math.sin(t * 1.7))
      : 0
    this.env = LevelMeter.advance(this.env, LevelMeter.target(raw))
    const amp = this.env <= 0 ? 0 : Math.pow(this.env, 0.62)
    const c = this.ctx
    c.setTransform(2, 0, 0, 2, 0, 0)
    c.clearRect(0, 0, SCREEN_W, SCREEN_H)
    for (const img of this.host.querySelectorAll('.slot .pane.on')) {
      const key = img.dataset.key, m = manifest?.[key]
      const L = m && liveFor(key, m)
      if (!L || amp <= 0) continue
      c.globalAlpha = Math.min(1, +getComputedStyle(img).opacity || 0)
      c.fillStyle = '#fff'
      for (let i = 0; i < L.count; i++) {
        const h = L.w + DotWave.barHeight(i, L.count, t, amp) * (L.h - L.w)
        const x = m.x + L.x + i * (L.w + L.gap), y = m.y + L.cy - h / 2
        c.beginPath(); c.roundRect(x, y, L.w, h, L.w / 2); c.fill()
      }
    }
    c.globalAlpha = 1
  }
}

// A TRACK: keyframes of whole-stage state, applied idempotently, so a
// scroll-scrubbed timeline can run forwards and backwards through them.
//   keys: [[progress, { notch, pill, app, speak, say, key, run }], …]
export function track(stage, keys, hooks = {}) {
  let last = -2
  return (p) => {
    let idx = -1
    for (let i = 0; i < keys.length; i++) if (keys[i][0] <= p) idx = i
    if (idx === last) return
    last = idx
    // Rebuild cumulative state up to idx so jumping (scrub/reverse) is exact.
    const s = { notch: null, pill: null, speak: false }
    for (let i = 0; i <= idx; i++) Object.assign(s, keys[i][1])
    stage.target = s.cam || null
    stage.set('notch', s.notch); stage.set('pill', s.pill); stage.speak(!!s.speak); stage.focus()
    if (s.app) stage.app(s.app)
    hooks.apply?.(s, idx)
  }
}
export { ready, preload }
