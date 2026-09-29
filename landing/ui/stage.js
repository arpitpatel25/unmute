// THE STAGE — a 1440×900 Mac screen holding the app's REAL surfaces.
//
// Every notch/pill image is a capture of unmute-notch (unmute-cloud db2a2016)
// placed at the exact window position the helper used (assets/ui/manifest.json).
// The only thing drawn here is what MOVES: the waveform bars, from the app's own
// math (LevelMeterSupport/LevelMeter.swift + DotWave.swift), laid exactly over
// the resting dots in the capture — which are those same bars at floor height.
const SCREEN_W = 1440, SCREEN_H = 900

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
    case 'pocket-aimed.pill': return { ...PILL, ...capsule(a.w, a.h, plain) }
    case 'pocket-aimed.notch': return { ...AIMED, x: 286, cy: 123 }
    default:
      if (/^pad-\d\.pill$/.test(name)) return { ...PILL, x: 38, cy: a.h - 18 }
      return null
  }
}

let manifest = null
const ready = fetch(new URL('../assets/ui/manifest.json', import.meta.url)).then((r) => r.json()).then((m) => {
  manifest = m
  for (const k of Object.keys(m)) { const i = new Image(); i.src = assetUrl(k) }   // warm the cache
})
const assetUrl = (k) => new URL(`../assets/ui/${k}.png`, import.meta.url).href

export class Stage {
  constructor(host, opts = {}) {
    const apps = opts.apps || ''
    this.host = host
    host.classList.add('stage')
    host.innerHTML = `
      <div class="screen"><div class="cam wallpaper">
        <div class="menubar"><span class="mb-left"><b class="mb-app">Finder</b><span>File</span><span>Edit</span><span>View</span><span>Window</span></span><span class="mb-right">Tue 9:41</span></div>
        <div class="apps">${apps}</div>
        <div class="hw-notch"></div>
        <div class="slot" data-role="notch"><img alt=""><img alt=""></div>
        <div class="slot" data-role="pill"><img alt=""><img alt=""></div>
        <canvas class="live" width="${SCREEN_W * 2}" height="${SCREEN_H * 2}"></canvas>
        <div class="extra"></div>
      </div></div>`
    this.screen = host.querySelector('.screen')
    this.cam = host.querySelector('.cam')
    this.camera = opts.camera !== false
    this.strength = opts.zoom ?? 1
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
    this.view = this.mobile ? { w: 640, h: 800 } : { w: SCREEN_W, h: SCREEN_H }
    this.host.style.aspectRatio = `${this.view.w} / ${this.view.h}`
    Object.assign(this.screen.style, { width: this.view.w + 'px', height: this.view.h + 'px',
      transform: `scale(${this.host.clientWidth / this.view.w})` })
    this.focus()
  }
  extra() { return this.host.querySelector('.extra') }
  app(name) { this.host.querySelectorAll('.app').forEach((a) => a.classList.toggle('on', a.dataset.app === name)); const t = this.host.querySelector(`.app[data-app="${name}"]`); if (t) this.host.querySelector('.mb-app').textContent = t.dataset.title || name }

  // Swap a surface. Same motion vocabulary as the app (Theme.swift): the old
  // content leaves in 90ms (easeIn), the new arrives in 140ms (easeOut) after 80ms.
  set(role, name) {
    if (this.current[role] === name) return
    this.current[role] = name
    const [a, b] = this.host.querySelectorAll(`.slot[data-role="${role}"] img`)
    const [live, next] = a.classList.contains('on') ? [a, b] : [b, a]
    live.classList.remove('on')
    const key = name && `${name}.${role}`
    if (!name || !manifest?.[key]) { next.removeAttribute('src'); next.classList.remove('on'); return }
    const m = manifest[key]
    Object.assign(next.style, { left: m.x + 'px', top: m.y + 'px', width: m.w + 'px', height: m.h + 'px' })
    next.src = assetUrl(key)
    next.dataset.key = key
    next.classList.add('on')
  }
  speak(on) { this.speaking = on }

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
    else if (/^(pad-|pill-paused)/.test(p)) f = M ? { x: 895, y: 640, z: 1.15, ay: 0.6 } : { x: 900, y: 640, z: 1.55, ay: 0.55 }
    else if (p) f = M ? { x: 720, y: 779, z: 1.75, ay: 0.72 } : { x: 720, y: 779, z: 1.9, ay: 0.72 }
    else if (/^(task-|agent-)/.test(n)) f = M ? { x: 720, y: 0, z: 0.96, ay: 0 } : { x: 720, y: 0, z: 1.3, ay: 0 }
    else if (/^pocket-/.test(n)) f = M ? { x: 720, y: 0, z: 1.7, ay: 0 } : { x: 720, y: 0, z: 1.9, ay: 0 }
    else if (n) f = M ? { x: 720, y: 0, z: 1.45, ay: 0 } : { x: 720, y: 0, z: 2.1, ay: 0 }
    if (!f) f = { x: 720, y: 450, z: M ? 0.9 : 1, ay: 0.5 }
    const { w: VW, h: VH } = this.view
    const minZ = Math.max(VW / SCREEN_W, VH / SCREEN_H)
    // Desktop zoom is softened per stage (`zoom` option); a phone needs all of it.
    const z = Math.max(minZ, M ? f.z : 1 + (f.z - 1) * this.strength)
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
    const tx = clamp(VW / 2 - f.x * z, VW - SCREEN_W * z, 0)
    const ty = clamp(VH * f.ay - f.y * z, VH - SCREEN_H * z, 0)
    this.cam.style.transform = `translate(${tx}px, ${ty}px) scale(${z})`
  }


  frame(t) {
    if (!this.visible) return
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
    for (const img of this.host.querySelectorAll('.slot img.on')) {
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
export { ready }
