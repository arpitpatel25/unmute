// HERO FLOW — what you say, transcribed, handed to your agent.
//
// Two streams of speech, one from each edge. Each enters, makes one loose
// loop in the margin beside the headline, and sweeps in a long curve under
// the buttons into Claude Code and Codex in the middle. As it reaches them it
// changes from raw speech (grey, lowercase, with the ums) to the clean
// request (ink): the speech fades out and the request fades in just after,
// so no two sentences overlap.
//
// Text must read upright, so both paths run left to right: the left one
// from the edge to the badge, the right one from the badge to the edge,
// with its words moving backwards along it, toward the badge.
//
// Each phrase starts at the same distance along its path in both texts, so
// what reaches the agents is the clean version of what was said. Scrolling
// pushes both streams along. Paused off screen; still under reduced motion.
;(() => {
  const svg = document.querySelector('.notch-flow')
  if (!svg) return
  const NS = 'http://www.w3.org/2000/svg'
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
  const SPEED = 40 // px per second
  const H = 680, FADE = 60, SWITCH = 190 // the switch sits this far along the line from the badge, and fades over FADE

  const SAID = {
    left: [
      ['um so can you build a first version of the uh new onboarding flow', 'Build a first version of the new onboarding flow.'],
      ['fix the save button it like does nothing on settings', 'Fix the Save button on Settings. It does nothing.'],
      ['can you pick up the pricing work from yesterday', 'Pick up the pricing work from yesterday.'],
      ['ok move it after the first project i think', 'Move it after the first project.'],
    ],
    right: [
      ['and uh add tests for the signup form', 'Add tests for the signup form.'],
      ['so like refactor the auth middleware', 'Refactor the auth middleware.'],
      ['why is the checkout test flaky like again', 'Why is the checkout test flaky again?'],
      ['um summarize what changed in this pull request', 'Summarize what changed in this pull request.'],
    ],
  }

  const el = (tag, attrs = {}, parent) => {
    const e = document.createElementNS(NS, tag)
    for (const k in attrs) e.setAttribute(k, attrs[k])
    if (parent) parent.append(e)
    return e
  }
  const defs = svg.querySelector('defs'), layer = svg.querySelector('.nf-streams')

  // The left stream's curve, as cubic segments in hero coordinates. It drops
  // in from the top of the margin, makes one loop (crossing its own entry at
  // a right angle, so the words never run over each other), comes down the
  // margin beside the hero's words, and turns in one wide curve into the run
  // under the buttons. The right stream is its mirror, reversed.
  const leftCurve = (c, RUN, dy) => {
    const y = (v) => v + dy, mid = (480 + c) / 2
    return [
      [262, -40],
      [[262, y(60)], [262, y(130)], [250, y(190)]],
      [[240, y(290)], [210, y(335)], [170, y(335)]],
      [[120, y(335)], [85, y(290)], [88, y(240)]],
      [[91, y(185)], [135, y(148)], [190, y(148)]],
      [[250, y(148)], [300, y(170)], [310, y(240)]],
      [[318, y(300)], [312, RUN - 150], [320, RUN - 92]],
      [[330, RUN - 28], [392, RUN], [480, RUN]],
      [[mid, RUN], [mid, RUN], [c - 66, RUN]],
    ]
  }
  const toD = (pts) => `M ${pts[0][0]} ${pts[0][1]} ` + pts.slice(1).map((s) => 'C ' + s.map((p) => p.join(' ')).join(', ')).join(' ')
  const mirrorReversed = (pts, W) => {
    const m = ([x, y]) => [W - x, y]
    const out = [m(pts[pts.length - 1][2])]
    for (let i = pts.length - 1; i >= 1; i--) {
      const [c1, c2] = pts[i], end = i === 1 ? pts[0] : pts[i - 1][2]
      out.push([m(c2), m(c1), m(end)])
    }
    return out
  }
  const streams = []
  let pos = 300
  const hero = svg.parentElement
  function layout() {
    const W = innerWidth, c = W / 2
    const top = (e) => e.getBoundingClientRect().top - hero.getBoundingClientRect().top
    const h1 = hero.querySelector('h1'), ctas = hero.querySelector('.ctas')
    const RUN = Math.round(top(ctas) + ctas.offsetHeight + 46)
    const dyL = top(h1) + h1.offsetHeight / 2 - 260, dyR = dyL + 34
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`)
    svg.querySelector('.nf-agents').setAttribute('transform', `translate(${c} ${RUN})`)
    defs.textContent = ''; layer.textContent = ''; streams.length = 0

    for (const side of ['left', 'right']) {
      const pts = side === 'left' ? leftCurve(c, RUN, dyL) : mirrorReversed(leftCurve(c, RUN, dyR), W)
      const id = 'nf-' + side, d = toD(pts)
      const path = el('path', { id, d }, defs)
      const total = path.getTotalLength()
      // THE SWITCH, measured along the line from the badge end, and faded
      // along the line too, so it works on a curve. A fade is a run of short
      // dashes, each a step dimmer, since a stroke can't carry a gradient
      // along its length. Left runs toward its end; right toward its start.
      const atBadge = side === 'left' ? total : 0, dir = side === 'left' ? -1 : 1
      const sw = atBadge + dir * SWITCH
      const dash = (mask, from, to, opacity) => {
        const a = Math.min(from, to), b = Math.max(from, to)
        el('use', { href: '#' + id, fill: 'none', stroke: '#fff', 'stroke-width': 46, 'stroke-opacity': opacity,
          'stroke-dasharray': `0 ${a} ${b - a} ${total * 2}` }, mask)
      }
      const mask = (mid) => el('mask', { id: id + mid, maskUnits: 'userSpaceOnUse', x: -100, y: -100, width: W + 200, height: H + 200 }, defs)
      const mRaw = mask('-mr'), mClean = mask('-mc')
      const STEPS = 10, step = FADE / STEPS
      // Raw: full from the far end up to the fade, then dimming toward the switch.
      // `dir` points away from the badge, so -dir points toward it.
      const farEnd = side === 'left' ? 0 : total, rawFade = sw + dir * FADE
      dash(mRaw, farEnd, rawFade, 1)
      for (let k = 0; k < STEPS; k++) dash(mRaw, rawFade - dir * k * step, rawFade - dir * ((k + 1) * step + 0.5), 1 - (k + 0.5) / STEPS)
      // Clean: brightening from the switch, then full to the badge.
      for (let k = 0; k < STEPS; k++) dash(mClean, sw - dir * k * step, sw - dir * ((k + 1) * step + 0.5), (k + 0.5) / STEPS)
      dash(mClean, sw - dir * FADE, atBadge, 1)

      const g = el('g', {}, layer)
      const raw = el('text', { class: 'nf-raw', dy: 5, mask: `url(#${id}-mr)` }, g)
      const clean = el('text', { class: 'nf-clean', dy: 5, mask: `url(#${id}-mc)` }, g)
      const tpRaw = el('textPath', { href: '#' + id }, raw), tpClean = el('textPath', { href: '#' + id }, clean)

      const measure = (tp, s) => { tp.textContent = s; return tp.getComputedTextLength() }
      const seg = SAID[side].map(([r, cl]) => ({ r, c: cl, rw: measure(tpRaw, r), cw: measure(tpClean, cl) }))
      for (const s of seg) s.w = Math.max(s.rw, s.cw) + 46
      const unit = seg.reduce((a, s) => a + s.w, 0)
      const reps = Math.ceil(total / unit) + 2
      for (const [tp, key, wk] of [[tpRaw, 'r', 'rw'], [tpClean, 'c', 'cw']]) {
        tp.textContent = ''
        let start = 0, prevEnd = 0
        for (let k = 0; k < reps; k++) for (const s of seg) {
          const t = el('tspan', { dx: start - prevEnd }, tp); t.textContent = s[key]
          prevEnd = start + s[wk]; start += s.w
        }
      }
      streams.push({ side, tpRaw, tpClean, unit })
    }
    place()
  }
  const place = () => {
    for (const s of streams) {
      // Left words move forward along their path; right words move backward.
      const p = s.side === 'left' ? pos : -pos
      const o = ((p % s.unit) + s.unit) % s.unit - s.unit
      s.tpRaw.setAttribute('startOffset', o); s.tpClean.setAttribute('startOffset', o)
    }
  }
  const fonts = document.fonts ? document.fonts.ready : Promise.resolve()
  fonts.then(() => { layout(); svg.classList.add('ready') })
  let rt; addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(layout, 120) })
  if (reduce) return

  let on = false, last = 0, boost = 0, lastY = scrollY
  addEventListener('scroll', () => { boost = Math.min(boost + Math.abs(scrollY - lastY) * 1.4, 700); lastY = scrollY }, { passive: true })
  const loop = (now) => {
    if (!on) return
    const dt = Math.min(0.05, (now - last) / 1000 || 0); last = now
    pos += (SPEED + boost) * dt; boost *= Math.pow(0.04, dt)
    place(); requestAnimationFrame(loop)
  }
  const start = () => { if (!on) { on = true; last = performance.now(); requestAnimationFrame(loop) } }
  new IntersectionObserver(([e]) => { if (e.isIntersecting && !document.hidden) start(); else on = false }).observe(svg)
  document.addEventListener('visibilitychange', () => { if (document.hidden) on = false; else start() })
})()
