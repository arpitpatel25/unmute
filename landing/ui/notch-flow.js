// HERO FLOW — what you say, transcribed, handed to your agent.
//
// Raw speech (grey, lowercase, with the ums) enters on the left, circles,
// spirals in and runs toward the middle. Partway along it becomes the clean
// request, white on a black ribbon, which rises into Claude Code and Codex
// above the headline. One path carries both texts at the same offset; each
// phrase starts at the same distance along it in both, so what reaches the
// agents is the clean version of what was said. Stroke masks show raw text
// before the switch and the ribbon after it. Scrolling pushes it along.
;(() => {
  const svg = document.querySelector('.notch-flow')
  if (!svg) return
  const NS = 'http://www.w3.org/2000/svg'
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
  const SPEED = 44 // px per second
  const H = 420, RUN = 232, AGENTS_Y = 70

  const PHRASES = [
    ['um so can you build a first version of the uh new onboarding flow', 'Build a first version of the new onboarding flow.'],
    ['fix the save button it like does nothing on settings', 'Fix the Save button on Settings. It does nothing.'],
    ['and uh add tests for the signup form', 'Add tests for the signup form.'],
    ['can you pick up the pricing work from yesterday', 'Pick up the pricing work from yesterday.'],
    ['why is the checkout test flaky like again', 'Why is the checkout test flaky again?'],
    ['ok move it after the first project i think', 'Move it after the first project.'],
  ]

  const path = svg.querySelector('#nf-path')
  const tpRaw = svg.querySelector('.nf-raw textPath'), tpClean = svg.querySelector('.nf-clean textPath')
  const ribbon = svg.querySelector('.nf-ribbon'), mRaw = svg.querySelector('#nf-m-raw path'), mClean = svg.querySelector('#nf-m-clean path')
  const probe = document.createElementNS(NS, 'path'); svg.querySelector('defs').append(probe)
  let unit = 1, pos = 260

  function layout() {
    const W = innerWidth, c = W / 2
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`)
    svg.style.top = document.querySelector('nav.top').offsetHeight + 'px'
    // IN: a circle, a smaller turn inside it, then the run to the notch and
    // straight up into its floor, to the bar's middle.
    // Raw speech: a circle, a turn inside it, then a run toward the middle.
    const inD = `M -40 110 C 60 92, 150 88, 210 90 C 290 92, 316 150, 314 205 C 312 270, 250 310, 190 308 `
      + `C 120 306, 86 250, 92 200 C 98 150, 150 128, 200 134 C 250 140, 262 190, 240 222 `
      + `C 220 252, 236 ${RUN}, 330 ${RUN} L ${c - 330} ${RUN}`
    // Transcribed: the same line carries on as a ribbon and rises into the
    // agents' badge, centred above the headline.
    const outD = ` L ${c - 140} ${RUN} C ${c - 60} ${RUN}, ${c} ${RUN - 40}, ${c} ${RUN - 110} L ${c} ${AGENTS_Y}`
    svg.querySelector('.nf-agents').setAttribute('transform', `translate(${c} ${AGENTS_Y})`)
    const d = inD + outD
    for (const p of [path, mRaw, mClean]) p.setAttribute('d', d)
    probe.setAttribute('d', inD)
    const total = path.getTotalLength(), at = probe.getTotalLength()
    mRaw.setAttribute('stroke-dasharray', `${at} ${total * 2}`)
    for (const el of [mClean, ribbon]) el.setAttribute('stroke-dasharray', `0 ${at} ${total * 2}`)

    const measure = (tp, s) => { tp.textContent = s; return tp.getComputedTextLength() }
    const seg = PHRASES.map(([r, cl]) => ({ r, c: cl, rw: measure(tpRaw, r), cw: measure(tpClean, cl) }))
    for (const s of seg) s.w = Math.max(s.rw, s.cw) + 44
    unit = seg.reduce((a, s) => a + s.w, 0)
    const reps = Math.ceil(total / unit) + 2
    for (const [tp, key, wk] of [[tpRaw, 'r', 'rw'], [tpClean, 'c', 'cw']]) {
      tp.textContent = ''
      let start = 0, prevEnd = 0
      for (let k = 0; k < reps; k++) for (const s of seg) {
        const t = document.createElementNS(NS, 'tspan')
        t.setAttribute('dx', start - prevEnd); t.textContent = s[key]; tp.append(t)
        prevEnd = start + s[wk]; start += s.w
      }
    }
    place()
  }
  const place = () => {
    const o = (pos % unit) - unit
    tpRaw.setAttribute('startOffset', o); tpClean.setAttribute('startOffset', o)
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
