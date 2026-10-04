// A FILM — one demo as a single eased GSAP timeline over a Stage.
//
// The Stage still owns the real captures and the waveform; the film owns the
// story: where the camera looks, what the subtitle says, and when each surface
// changes. Every shot is a full STATE (not a delta), so seeking to any shot —
// a chapter button, a reduced-motion still — lands on an exact frame.
//
// Grammar, the same in every demo:
//   1. a wide shot of the screen: which app you're in, and what prompted you
//   2. push in on the surface that's acting (pill, notch, panel) — big enough
//      to read, because a whole 14" screen in 1000px makes the pill ~10px tall
//   3. the subtitle under the screen carries the key you pressed and your words,
//      then what happened (✓). It never covers the product.
import { Stage, ready, preload } from './stage.js?v=20261004-black1'
export { ready }

const SCREEN_W = 1120, SCREEN_H = 700

// Named framings, in screen points. z is the zoom; ay is where y sits in the
// view. A big stage shows the whole screen at real size and never zooms; only
// a small one (a side-by-side section, a phone) pushes in on these.
export const SHOT = {
  wide: { x: 560, y: 350, z: 1, ay: 0.5 },
  pill: { x: 560, y: 610, z: 1.5, ay: 0.93 },     // the pill, with the window you're speaking from
  bar: { x: 560, y: 0, z: 2.4, ay: 0 },           // the notch bar (34pt tall)
  pocket: { x: 560, y: 0, z: 2.4, ay: 0 },        // the pocket card (348×114)
  panel: { x: 560, y: 0, z: 1.65, ay: 0 },        // an expanded session (648×405)
}

export class Film {
  constructor(host, { apps = '', html = '', sub, shots }) {
    // The device: the stage is the screen; a bezel wraps it.
    const mac = document.createElement('div')
    mac.className = 'mac'
    host.before(mac); mac.append(host)
    this.stage = new Stage(host, { apps, camera: false, fullScreen: true })
    if (html) this.stage.extra().innerHTML = html
    this.cam = host.querySelector('.cam')
    this.cam.style.transition = 'none'
    this.sub = sub
    // Shots are written as changes; what's on screen (app, surfaces, camera,
    // chapter) carries forward, while words and actions belong to one shot.
    const KEEP = ['app', 'notch', 'pill', 'cam', 'chapter', 'nt', 'typed']
    let carry = {}
    this.shots = shots.map((s) => {
      for (const k of KEEP) if (k in s) carry[k] = s[k]
      return { ...carry, ...s }
    })
    shots = this.shots
    preload(shots.flatMap((s) => [s.notch && `${s.notch}.notch`, s.pill && `${s.pill}.pill`]).filter(Boolean))
    this.listeners = []
    this.state = {}
    this.tl = gsap.timeline({ paused: true, repeat: -1 })
    for (let i = 0; i < shots.length; i++) {
      this.tl.call(() => this.show(i), null, shots[i].t)
    }
    this.tl.to({}, { duration: 0.001 }, shots[shots.length - 1].end ?? shots[shots.length - 1].t + 2.5)
    this.total = this.tl.duration()
    this.show(0, true)
    new ResizeObserver(() => this.frame(this.shots[this.current()].cam || SHOT.wide, 0)).observe(host)
  }
  on(fn) { this.listeners.push(fn) }

  // Jump to a shot without playing the shots in between.
  seek(i) {
    this.tl.time(this.shots[i].t + 0.001, true)
    this.show(i, true)
  }
  current() {
    const t = this.tl.time()
    let i = 0
    for (let k = 0; k < this.shots.length; k++) if (this.shots[k].t <= t) i = k
    return i
  }

  show(i, instant = false) {
    const s = this.shots[i], st = this.stage
    if (s.app) st.app(s.app)
    st.instant = instant
    st.set('notch', s.notch ?? null)
    st.set('pill', s.pill ?? null)
    st.instant = false
    st.speak(!!s.speak)
    st.host.querySelectorAll('.typed, .compose').forEach((e) => { e.textContent = s.typed ?? '' })
    this.frame(s.cam || SHOT.wide, instant ? 0 : s.camDur ?? 1.1)
    this.subtitle(s, instant)
    s.do?.(st, instant)
    for (const fn of this.listeners) fn(i, s)
  }

  // Ease the camera to a framing; clamp so the view never leaves the screen.
  frame(f, dur) {
    const host = this.stage.host
    const narrow = host.clientWidth < 800
    const z = narrow ? Math.max(1, f.z) : 1
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
    const x = clamp(SCREEN_W / 2 - f.x * z, SCREEN_W - SCREEN_W * z, 0)
    const y = clamp(SCREEN_H * f.ay - f.y * z, SCREEN_H - SCREEN_H * z, 0)
    gsap.killTweensOf(this.cam)
    if (!dur) gsap.set(this.cam, { x, y, scale: z, transformOrigin: '0 0' })
    else gsap.to(this.cam, { x, y, scale: z, transformOrigin: '0 0', duration: dur, ease: 'power3.inOut' })
    host.dataset.shot = z > 1 ? 'close' : 'wide'
  }

  // The subtitle: [key] “words…”  — or a plain line — or ✓ what happened.
  subtitle(s, instant) {
    const el = this.sub
    if (!el) return
    const sig = JSON.stringify([s.key, s.say, s.line, s.done])
    if (el.dataset.sig === sig) return
    el.dataset.sig = sig
    const kind = s.say ? 'say' : s.done ? 'done' : s.line ? 'line' : 'none'
    el.className = 'film-sub ' + kind
    if (kind === 'none') { el.innerHTML = ''; return }
    if (kind === 'say') {
      const words = s.say.split(' ')
      const step = Math.min(220, (s.sayDur ?? 2.2) * 1000 / words.length)
      el.innerHTML = `${s.key ? `<kbd>${s.key}</kbd>` : ''}<q>${words.map((w, n) =>
        `<span class="w" style="animation-delay:${instant ? 0 : Math.round(n * step)}ms">${n === 0 ? '“' : ''}${w}${n === words.length - 1 ? '”' : ''}</span>`).join(' ')}</q>`
      return
    }
    if (kind === 'done') { el.innerHTML = `<span class="ok">✓</span><span>${s.done}</span>`; return }
    el.innerHTML = `${s.key ? `<kbd>${s.key}</kbd>` : ''}<span>${s.line}</span>`
  }
}
