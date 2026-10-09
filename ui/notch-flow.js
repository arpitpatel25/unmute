// HERO FLOW — what you say, transcribed, handed to your agent.
//
// One line of speech sweeps in from the top left behind the headline, curves
// down, makes a small loop beside the buttons, and runs into Claude Code and
// Codex. Most of the way it is raw speech (grey, lowercase, with the ums); on
// the last stretch it fades into the clean request, in ink. From the badge it
// fans out into three live sessions, always both Claude Code and Codex: each
// request that arrives runs down a branch and becomes that session's task.
//
// Each text is packed with its own sentences back to back, so the line is
// never empty. Scrolling pushes it along. Paused off screen; still under
// reduced motion.
;(() => {
  const svg = document.querySelector('.notch-flow')
  if (!svg) return
  const NS = 'http://www.w3.org/2000/svg'
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
  const SPEED = 42, FADE = 80, CLEAN = 230, GAP = 34, H = 680

  // What was said · what the agent gets · the session it becomes · which agent.
  const SAID = [
    ['um so can you build a first version of the uh new onboarding flow', 'Build a first version of the new onboarding flow.', 'Onboarding flow', 'claude'],
    ['and uh add tests for the signup form', 'Add tests for the signup form.', 'Signup tests', 'codex'],
    ['fix the save button it like does nothing on settings', 'Fix the Save button on Settings. It does nothing.', 'Settings bug', 'claude'],
    ['so like refactor the auth middleware', 'Refactor the auth middleware.', 'Auth middleware', 'codex'],
    ['can you pick up the pricing work from yesterday', 'Pick up the pricing work from yesterday.', 'Pricing page', 'claude'],
    ['why is the checkout test flaky like again', 'Why is the checkout test flaky again?', 'Checkout test', 'codex'],
  ]
  const MARK = { claude: 'assets/mark-claude.png', codex: 'assets/mark-codex.png' }
  const after = svg.parentElement.querySelector('.nf-after')
  const el = (tag, attrs = {}, parent) => {
    const e = document.createElementNS(NS, tag)
    for (const k in attrs) e.setAttribute(k, attrs[k])
    if (parent) parent.append(e)
    return e
  }
  const defs = svg.querySelector('defs'), layer = svg.querySelector('.nf-streams'), hero = svg.parentElement
  let place = null, pos = 200

  // THE FAN: three branches from the badge, each ending in a session.
  function fan(bx, by, W) {
    if (W < 1200) return () => {}
    const x0 = bx + 58, cx = bx + 112, ys = [by - 62, by, by + 62], shown = [0, 1, 2], chips = [], paths = []
    const g = el('g', {}, layer)
    const chip = (i, st) => {
      const c = document.createElement('div')
      c.className = 'nf-chip ' + st
      c.innerHTML = `<img src="${MARK[SAID[i][3]]}" alt=""><span>${SAID[i][2]}</span><i></i>`
      return c
    }
    ys.forEach((y, k) => {
      paths.push(el('path', { class: 'nf-branch', d: `M ${x0} ${by} C ${x0 + 50} ${by}, ${cx - 50} ${y}, ${cx} ${y}` }, g))
      const c = chip(shown[k], k === 2 ? 'needs' : 'working'); c.style.left = cx + 'px'; c.style.top = y - 20 + 'px'; after.append(c); chips.push(c)
    })
    const mixed = (list) => new Set(list.map((j) => SAID[j][3])).size > 1
    let next = 0
    return (i) => {
      // Both agents stay on show: a new task takes the next branch whose
      // replacement keeps Claude Code and Codex both there.
      let k = shown.indexOf(i)
      const fresh = k < 0
      if (fresh) for (let n = 0; n < 3; n++) { const c = (next + n) % 3, t = shown.slice(); t[c] = i; if (mixed(t)) { k = c; next = c + 1; break } }
      if (k < 0) return
      const p = paths[k], L = p.getTotalLength(), dot = el('circle', { class: 'nf-pulse', r: 4 }, g), t0 = performance.now()
      ;(function run(now) { const f = Math.min(1, (now - t0) / 650), pt = p.getPointAtLength(f * L); dot.setAttribute('cx', pt.x); dot.setAttribute('cy', pt.y); if (f < 1) requestAnimationFrame(run); else dot.remove() })(t0)
      setTimeout(() => {
        if (fresh) { const n = chip(i, 'working'); n.style.cssText = chips[k].style.cssText; chips[k].replaceWith(n); chips[k] = n; shown[k] = i }
        chips[k].classList.add('flash'); setTimeout(() => chips[k].classList.remove('flash'), 300)
      }, 620)
    }
  }

  function layout() {
    defs.textContent = ''; layer.textContent = ''; after.textContent = ''
    const W = innerWidth
    const rel = (e) => { const r = e.getBoundingClientRect(), h = hero.getBoundingClientRect(); return { top: r.top - h.top, bottom: r.bottom - h.top } }
    const top = rel(hero.querySelector('h1')).top, by = Math.round(rel(hero.querySelector('.ctas')).bottom + 80)
    // The badge sits past the loop, so the line never doubles back on itself.
    // On narrower screens the loop moves left so the fan still fits.
    const cx = Math.min(W * 0.6, W - 540), bx = Math.round(cx + 240)
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`)
    svg.querySelector('.nf-agents').setAttribute('transform', `translate(${bx} ${by})`)

    // In from the top left, down past the headline, one small loop, then on
    // into the agents.
    const d = `M -80 ${top + 30} C ${W * .28} ${top - 70}, ${W * .5} ${top + 60}, ${cx} ${top + 210} `
      + `C ${cx + 15} ${top + 300}, ${cx + 130} ${top + 310}, ${cx + 135} ${top + 235} `
      + `C ${cx + 140} ${top + 160}, ${cx + 30} ${top + 150}, ${cx + 10} ${top + 215} `
      + `C ${cx - 10} ${top + 290}, ${cx + 40} ${by}, ${cx + 160} ${by} L ${bx - 64} ${by}`
    const path = el('path', { id: 'nf-path', d }, defs), total = path.getTotalLength()
    const sw = total - CLEAN

    // Masks, faded along the line: speech up to the switch, the request after.
    const mask = (id) => el('mask', { id, maskUnits: 'userSpaceOnUse', x: -200, y: -200, width: W + 400, height: H + 400 }, defs)
    const dash = (m, a, b, o) => el('use', { href: '#nf-path', fill: 'none', stroke: '#fff', 'stroke-width': 60, 'stroke-opacity': o,
      'stroke-dasharray': `0 ${a} ${b - a} ${total * 3}` }, m)
    const mr = mask('nf-mr'), mc = mask('nf-mc'), N = 12, st = FADE / N
    dash(mr, 0, sw - FADE, 1)
    for (let k = 0; k < N; k++) dash(mr, sw - FADE + k * st, sw - FADE + (k + 1) * st + .5, 1 - (k + .5) / N)
    for (let k = 0; k < N; k++) dash(mc, sw + k * st, sw + (k + 1) * st + .5, (k + .5) / N)
    dash(mc, sw + FADE, total, 1)

    const tr = el('textPath', { href: '#nf-path' }, el('text', { class: 'nf-raw', dy: 7, mask: 'url(#nf-mr)' }, layer))
    const tc = el('textPath', { href: '#nf-path' }, el('text', { class: 'nf-clean', dy: 7, mask: 'url(#nf-mc)' }, layer))
    const fill = (tp, list) => {
      const ws = list.map((t) => { tp.textContent = t; return tp.getComputedTextLength() + GAP })
      const unit = ws.reduce((a, w) => a + w, 0), reps = Math.ceil(total / unit) + 2
      tp.textContent = ''
      for (let k = 0; k < reps; k++) list.forEach((t, i) => { const e = el('tspan', { dx: i || k ? GAP : 0 }, tp); e.textContent = t })
      return { unit, ws }
    }
    const R = fill(tr, SAID.map((x) => x[0])), C = fill(tc, SAID.map((x) => x[1]))
    const starts = C.ws.map((_, i) => C.ws.slice(0, i).reduce((a, w) => a + w, 0)), seen = starts.map(() => null)
    const arrive = fan(bx, by, W)
    place = () => {
      tr.setAttribute('startOffset', (pos % R.unit) - R.unit)
      tc.setAttribute('startOffset', (pos % C.unit) - C.unit)
      // A sentence arrives when its end reaches the end of the line.
      starts.forEach((st0, i) => {
        const n = Math.floor((pos + st0 + C.ws[i] - GAP - C.unit - total) / C.unit)
        if (seen[i] !== null && n > seen[i]) arrive(i)
        seen[i] = n
      })
    }
    place()
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
    place && place(); requestAnimationFrame(loop)
  }
  const start = () => { if (!on) { on = true; last = performance.now(); requestAnimationFrame(loop) } }
  new IntersectionObserver(([e]) => { if (e.isIntersecting && !document.hidden) start(); else on = false }).observe(svg)
  document.addEventListener('visibilitychange', () => { if (document.hidden) on = false; else start() })
})()
