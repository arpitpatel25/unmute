// HERO FLOW — what you say, transcribed, handed to your agent.
//
// One stream of speech. It starts low on the left, rises up the margin,
// makes one heavy, uneven turn over the top, comes back down beside the
// hero's words and sweeps under the buttons into Claude Code and Codex. As it
// reaches them it changes from raw speech (grey, lowercase, with the ums) to
// the clean request (ink): the speech fades out and the request fades in just
// after, along the line, so no two sentences overlap.
//
// Each phrase starts at the same distance along the line in both texts, so
// what reaches the agents is the clean version of what was said. Scrolling
// pushes it along. Paused off screen; still under reduced motion.
;(() => {
  const svg = document.querySelector('.notch-flow')
  if (!svg) return
  const NS = 'http://www.w3.org/2000/svg'
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
  const SPEED = 40 // px per second
  const H = 680, FADE = 60, SWITCH = 190 // the switch sits this far along the line from the badge, and fades over FADE

  const SAID = [
    ['um so can you build a first version of the uh new onboarding flow', 'Build a first version of the new onboarding flow.'],
    ['and uh add tests for the signup form', 'Add tests for the signup form.'],
    ['fix the save button it like does nothing on settings', 'Fix the Save button on Settings. It does nothing.'],
    ['so like refactor the auth middleware', 'Refactor the auth middleware.'],
    ['can you pick up the pricing work from yesterday', 'Pick up the pricing work from yesterday.'],
    ['why is the checkout test flaky like again', 'Why is the checkout test flaky again?'],
  ]

  const el = (tag, attrs = {}, parent) => {
    const e = document.createElementNS(NS, tag)
    for (const k in attrs) e.setAttribute(k, attrs[k])
    if (parent) parent.append(e)
    return e
  }
  const defs = svg.querySelector('defs'), layer = svg.querySelector('.nf-streams')

  // The line, as cubic segments in hero coordinates. Deliberately uneven:
  // the rise leans in, the turn is wider on the way down than the way up.
  // `k` narrows it to the room beside the text, so it never crosses a word.
  const curve = (c, RUN, dy, k) => {
    const y = (v) => v + dy, x = (v) => Math.round(v * k), mid = (x(490) + c) / 2
    return [
      [-40, RUN + 80],
      [[x(60), RUN + 50], [x(104), y(430)], [x(116), y(310)]],
      [[x(126), y(196)], [x(168), y(108)], [x(246), y(110)]],
      [[x(332), y(112)], [x(362), y(196)], [x(344), y(300)]],
      [[x(330), y(388)], [x(316), RUN - 150], [x(330), RUN - 84]],
      [[x(346), RUN - 20], [x(404), RUN], [x(490), RUN]],
      [[mid, RUN], [mid, RUN], [c - 66, RUN]],
    ]
  }
  const toD = (pts) => `M ${pts[0][0]} ${pts[0][1]} ` + pts.slice(1).map((s) => 'C ' + s.map((p) => p.join(' ')).join(', ')).join(' ')

  const streams = []
  let pos = 300
  const hero = svg.parentElement
  function layout() {
    const W = innerWidth, c = W / 2
    const top = (e) => e.getBoundingClientRect().top - hero.getBoundingClientRect().top
    const h1 = hero.querySelector('h1'), ctas = hero.querySelector('.ctas')
    const RUN = Math.round(top(ctas) + ctas.offsetHeight + 46)
    const dy = top(h1) - 120
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`)
    svg.querySelector('.nf-agents').setAttribute('transform', `translate(${c} ${RUN})`)
    defs.textContent = ''; layer.textContent = ''; streams.length = 0

    for (const side of ['left']) {
      // The text column's left edge, less breathing room: the line's widest
      // point (362 at full size) has to stay left of it.
      const textLeft = Math.min(...[h1, hero.querySelector('.sub')].map((e) => {
        const r = document.createRange(); r.selectNodeContents(e); return r.getBoundingClientRect().left }))
      const k = Math.min(1, Math.max(0.6, (textLeft - 36) / 362))
      const pts = curve(c, RUN, dy, k)
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
      const seg = SAID.map(([r, cl]) => ({ r, c: cl, rw: measure(tpRaw, r), cw: measure(tpClean, cl) }))
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
