// WORDS THROUGH THE NOTCH — what you say goes in one side and comes out the
// other as what your agent gets.
//
// One line of text sweeps down from the left, runs level through the notch
// at bar height, and sweeps back down on the right. Left of centre it is raw
// speech: grey, lowercase, with the ums. Right of centre it is the clean
// request, in ink. The switch happens under the notch, which hides it at bar
// level and frosts it when the notch is open. Each phrase starts at the same
// distance along the line in both texts, so what comes out is the clean
// version of what went in. Scrolling pushes the words along.
;(() => {
  const svg = document.querySelector('.notch-flow')
  if (!svg) return
  const NS = 'http://www.w3.org/2000/svg'
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
  const SPEED = 42 // px per second
  const BAR_MID = 18 // the bar is 34 tall; text rides its middle

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
  const [maskRaw, maskClean] = svg.querySelectorAll('.nf-mask rect')
  let unit = 1, pos = 300

  function layout() {
    const W = innerWidth, c = W / 2, low = 150
    svg.setAttribute('viewBox', `0 0 ${W} 260`)
    svg.style.top = document.querySelector('nav.top').offsetHeight + 'px'
    // Level through the notch (±230 covers the bar at any width it takes),
    // then easing down to either edge.
    path.setAttribute('d', `M -40 ${low} C ${c * 0.42} ${low}, ${c - 380} ${BAR_MID}, ${c - 230} ${BAR_MID} `
      + `L ${c + 230} ${BAR_MID} C ${c + 380} ${BAR_MID}, ${W - c * 0.42} ${low}, ${W + 40} ${low}`)
    maskRaw.setAttribute('width', c); maskClean.setAttribute('x', c); maskClean.setAttribute('width', c)

    const total = path.getTotalLength()
    const measure = (tp, s) => { tp.textContent = s; return tp.getComputedTextLength() }
    const seg = PHRASES.map(([r, cl]) => ({ r, c: cl, rw: measure(tpRaw, r), cw: measure(tpClean, cl) }))
    for (const s of seg) s.w = Math.max(s.rw, s.cw) + 48
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
