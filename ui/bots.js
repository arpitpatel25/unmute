// BOTS — the faces from the app, drawn for the web.
//
// A straight port of the notch's BotIdentity (WallPresentation.swift) and
// BotAvatar.swift: the same FNV-1a hash of the bot's name picks the same
// colour, silhouette, eyes and glance, so "Checkout" looks here exactly as it
// does in the app. Bodies are the same rounded polygons; eyes wear the same
// moods (needs you, failed, working) and blink on the same rhythm.

export const PALETTE = [
  [0.55, 0.42, 0.96], // violet
  [0.20, 0.74, 0.62], // teal
  [0.96, 0.56, 0.20], // orange
  [0.93, 0.36, 0.62], // pink
  [0.27, 0.55, 0.97], // blue
  [0.42, 0.78, 0.33], // green
  [0.95, 0.74, 0.22], // amber
  [0.94, 0.42, 0.36], // coral
].map(([r, g, b]) => `${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)}`)

// BotIdentity: FNV-1a 64-bit over the lowercased name.
export function identity(name) {
  let h = 0xcbf29ce484222325n
  for (const byte of new TextEncoder().encode(name.trim().toLowerCase())) {
    h ^= BigInt(byte)
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn
  }
  return {
    name,
    hue: Number(h % 8n),
    face: Number((h >> 32n) % 4n),
    shape: Number((h >> 16n) % 6n),
    gaze: Number((h >> 48n) % 3n) - 1,
  }
}

// BotBody: points in a unit square and a corner radius, or a circle.
const OUTLINES = [
  [[], 0],
  [[[0.04, 0.04], [0.96, 0.04], [0.96, 0.96], [0.04, 0.96]], 0.36],
  [[[0.5, 0], [0.95, 0.26], [0.95, 0.74], [0.5, 1], [0.05, 0.74], [0.05, 0.26]], 0.2],
  [[[0, 0.17], [1, 0.17], [1, 0.83], [0, 0.83]], 0.33],
  [[[-0.04, 0.04], [1.04, 0.04], [0.5, 1.04]], 0.46],
  [[[0.08, 0.12], [0.88, 0.02], [0.98, 0.88], [0.04, 0.96]], 0.34],
]
const eyeLift = (shape) => (shape === 4 ? -0.12 : -0.04)

function bodyPath(shape, s) {
  const [unit, rad] = OUTLINES[shape % OUTLINES.length]
  if (!unit.length) return `M${s / 2} 0A${s / 2} ${s / 2} 0 1 1 ${s / 2} ${s}A${s / 2} ${s / 2} 0 1 1 ${s / 2} 0Z`
  const pts = unit.map(([x, y]) => [x * s, y * s]), r = rad * s, n = pts.length
  const toward = (a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.max(1e-4, Math.hypot(dx, dy)), k = Math.min(r, len / 2) / len; return [a[0] + dx * k, a[1] + dy * k] }
  const f = (p) => `${p[0].toFixed(2)} ${p[1].toFixed(2)}`
  let d = `M${f(toward(pts[n - 1], pts[0]))}`
  for (let i = 0; i < n; i++) {
    const v = pts[i], prev = pts[(i + n - 1) % n], next = pts[(i + 1) % n]
    d += `L${f(toward(v, prev))}Q${f(v)} ${f(toward(v, next))}`
  }
  return d + 'Z'
}

let uid = 0
// A face as SVG. Size is in CSS pixels; everything scales from it like the app.
export function face(name, { size = 28, mood = 'idle', cls = '' } = {}) {
  const id = identity(name), s = size, e = Math.max(1.6, s * 0.15), gap = s * 0.2
  const eyeRect = (w, h, x, cy) => `<rect x="${(x).toFixed(2)}" y="${(cy - h / 2).toFixed(2)}" width="${w.toFixed(2)}" height="${h.toFixed(2)}" rx="${(Math.min(w, h) / 2).toFixed(2)}"/>`
  // Eye sizes per face: round, tall, content, wink.
  const sizes = [[[e, e], [e, e]], [[e * 0.85, e * 1.7], [e * 0.85, e * 1.7]], [[e * 1.3, e * 0.6], [e * 1.3, e * 0.6]], [[e, e], [e * 1.3, e * 0.55]]][id.face]
  const total = sizes[0][0] + gap + sizes[1][0]
  const cx = s / 2 + id.gaze * s * 0.07, cy = s / 2 + s * eyeLift(id.shape)
  const x0 = cx - total / 2
  const eyes = eyeRect(sizes[0][0], sizes[0][1], x0, cy) + eyeRect(sizes[1][0], sizes[1][1], x0 + sizes[0][0] + gap, cy)
  // ^ ^ for the moment work finishes.
  const hw = e * 1.35, hh = e, hx0 = cx - (hw * 2 + gap) / 2
  const arc = (x) => `<path d="M${x} ${cy + hh / 2}Q${x + hw / 2} ${cy - hh / 2 - hh * 0.4} ${x + hw} ${cy + hh / 2}"/>`
  const g = `bg${++uid}`, col = PALETTE[id.hue]
  return `<svg class="bot ${cls}" data-mood="${mood}" data-name="${name}" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}" aria-hidden="true" style="--bot:rgb(${col});--s:${s}px;overflow:visible">
    <defs><clipPath id="${g}c"><path d="${bodyPath(id.shape, s)}"/></clipPath><linearGradient id="${g}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="rgba(${col},.92)"/><stop offset="1" stop-color="rgb(${col})"/></linearGradient></defs>
    <g class="bot-body"><path d="${bodyPath(id.shape, s)}" fill="url(#${g})"/>
    <g clip-path="url(#${g}c)"><g class="bot-look"><g class="bot-eyes" fill="rgba(0,0,0,.72)" style="transform-origin:${cx}px ${cy}px">${eyes}</g></g></g>
    <g class="bot-happy" clip-path="url(#${g}c)" fill="none" stroke="rgba(0,0,0,.72)" stroke-width="${Math.max(1, e * 0.42).toFixed(2)}" stroke-linecap="round">${arc(hx0)}${arc(hx0 + hw + gap)}</g></g>
  </svg>`
}

// "All bots": up to three faces overlapping.
export function stack(names, size = 18, ring = '#fff') {
  return `<span class="bot-stack" style="--s:${size}px;--ring:${ring}">${names.slice(0, 3).map((n, i) => `<span style="z-index:${3 - i}">${face(n, { size })}</span>`).join('')}</span>`
}

// Lively faces: their own blink clock with the odd double blink, a glance
// while working, ^ ^ when work finishes, and eyes that watch a nearby pointer.
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
export function liven(root = document) {
  if (reduce) return
  for (const svg of root.querySelectorAll('svg.bot.lively:not([data-alive])')) {
    svg.dataset.alive = '1'
    const eyes = svg.querySelector('.bot-eyes')
    const blink = () => {
      if (!svg.isConnected) return
      setTimeout(() => {
        eyes.classList.add('blink'); setTimeout(() => eyes.classList.remove('blink'), 120)
        if (Math.random() < 0.15) setTimeout(() => { eyes.classList.add('blink'); setTimeout(() => eyes.classList.remove('blink'), 110) }, 280)
        blink()
      }, 2500 + Math.random() * 3500)
    }
    blink()
  }
}
export function celebrate(svg) {
  svg.classList.add('happy'); setTimeout(() => svg.classList.remove('happy'), 1400)
}
// Pointer: faces within 260px look at it.
if (!reduce) addEventListener('pointermove', (ev) => {
  for (const svg of document.querySelectorAll('svg.bot.lively')) {
    const r = svg.getBoundingClientRect(), s = r.width
    const dx = ev.clientX - (r.left + s / 2), dy = ev.clientY - (r.top + s / 2), dist = Math.max(0.001, Math.hypot(dx, dy))
    const look = svg.querySelector('.bot-look')
    if (dist < Math.max(260, s * 5)) { const k = Math.min(1, dist / (s * 2.2)); look.style.transform = `translate(${(dx / dist * k * s * 0.11).toFixed(2)}px,${(dy / dist * k * s * 0.08).toFixed(2)}px)` }
    else look.style.transform = ''
  }
}, { passive: true })
