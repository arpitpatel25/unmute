// HERO FLOW — what you say, transcribed, handed to your agent.
//
// Raw speech (grey, lowercase, with the ums) enters on the left, circles,
// spirals in and runs toward the middle. Partway along it becomes the clean
// request, in ink, which rises into Claude Code and Codex
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
  const H = 640

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
  const mRaw = svg.querySelector('#nf-m-raw path')
  const probe = document.createElementNS(NS, 'path'); svg.querySelector('defs').append(probe)
  let unit = 1, pos = 260

  // Laid out around the hero's own words: the spiral beside the headline,
  // the run below the buttons, into the badge where "Works with" sat.
  const hero = svg.parentElement
  function layout() {
    const W = innerWidth, c = W / 2
    const top = (el) => el.getBoundingClientRect().top - hero.getBoundingClientRect().top
    const h1 = hero.querySelector('h1'), ctas = hero.querySelector('.ctas')
    const dy = top(h1) + h1.offsetHeight / 2 - 200
    const RUN = Math.round(top(ctas) + ctas.offsetHeight + 46)
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`)
    const y = (v) => v + dy
    // Where speech becomes the clean request: halfway along the run, with a
    // soft fade either side so no word is cut in half.
    const X = Math.round((360 + c - 60) / 2), FADE = 70
    // Raw speech: a circle, a turn inside it, then a run toward the middle.
    const inD = `M -40 ${y(110)} C 60 ${y(92)}, 150 ${y(88)}, 210 ${y(90)} C 290 ${y(92)}, 316 ${y(150)}, 314 ${y(205)} `
      + `C 312 ${y(270)}, 250 ${y(310)}, 190 ${y(308)} C 120 ${y(306)}, 86 ${y(250)}, 92 ${y(200)} `
      + `C 98 ${y(150)}, 150 ${y(128)}, 200 ${y(134)} C 250 ${y(140)}, 262 ${y(190)}, 240 ${y(222)} `
      + `C 220 ${y(252)}, 250 ${RUN}, 360 ${RUN} L ${X} ${RUN}`
    // Transcribed: the line carries on as clean text, into the agents' badge.
    const outD = ` L ${c - 40} ${RUN}`
    svg.querySelector('.nf-agents').setAttribute('transform', `translate(${c} ${RUN})`)
    const d = inD + outD
    for (const p of [path, mRaw]) p.setAttribute('d', d)
    probe.setAttribute('d', inD)
    const total = path.getTotalLength(), at = probe.getTotalLength()
    mRaw.setAttribute('stroke-dasharray', `${at - FADE} ${total * 2}`)
    for (const r of svg.querySelectorAll('.nf-x')) { r.setAttribute('y', RUN - 25) }
    // Speech fades out just before the switch; the clean request fades in
    // just after it. They never overlap, so no two sentences sit on top of
    // each other.
    const [rOut, rIn] = svg.querySelectorAll('.nf-x')
    rOut.setAttribute('x', X - FADE); rOut.setAttribute('width', FADE)
    rIn.setAttribute('x', X); rIn.setAttribute('width', c - X + 200)
    for (const [id, a, b] of [['nf-fade-out', X - FADE, X], ['nf-fade-in', X, X + FADE]]) {
      const g = svg.querySelector('#' + id); g.setAttribute('x1', a); g.setAttribute('x2', b); g.setAttribute('y1', 0); g.setAttribute('y2', 0)
    }
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
