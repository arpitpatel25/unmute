// HERO FLOW — what you say, transcribed, handed to your agent.
//
// One strip of words. It enters on the left as raw speech (grey, lowercase,
// with the ums), loops once, and passes through an Unmute pill. Out the other
// side it is clean, punctuated text on a black ribbon that sweeps right along
// the bottom of the hero into Claude Code and Codex.
//
// Both texts ride the same path at the same offset. Each phrase starts at the
// same distance along it in both, so a phrase leaves the pill as the clean
// version of what went in. Stroke masks show the raw text only before the
// pill and the clean text only after it. Scrolling pushes the strip along.
;(() => {
  const svg = document.querySelector('.hero-flow')
  if (!svg) return
  const NS = 'http://www.w3.org/2000/svg'
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
  const SPEED = 46 // points per second along the path

  // What people actually say → what reaches the agent.
  const PHRASES = [
    ['um so can you build a first version of the uh new onboarding flow', 'Build a first version of the new onboarding flow.'],
    ['fix the save button it like does nothing on settings', 'Fix the Save button on Settings. It does nothing.'],
    ['and uh add tests for the signup form', 'Add tests for the signup form.'],
    ['can you pick up the pricing work from yesterday', 'Pick up the pricing work from yesterday.'],
    ['why is the checkout test flaky like again', 'Why is the checkout test flaky again?'],
    ['ok move it after the first project i think', 'Move it after the first project.'],
  ]

  const raw = svg.querySelector('#hf-raw'), ribbon = svg.querySelector('#hf-ribbon')
  const d = raw.getAttribute('d') + ' ' + ribbon.getAttribute('d').replace(/^M[^A-Za-z]+/, '')
  const path = svg.querySelector('#hf-path')
  path.setAttribute('d', d)
  for (const m of svg.querySelectorAll('mask path')) m.setAttribute('d', d)
  const total = path.getTotalLength(), at = raw.getTotalLength()

  // Masks and the ribbon: dashes along the one path. Before the pill → raw;
  // after it → clean, on black.
  svg.querySelector('#hf-mask-raw path').setAttribute('stroke-dasharray', `${at} ${total * 2}`)
  for (const el of svg.querySelectorAll('#hf-mask-clean path, .hf-ribbon'))
    el.setAttribute('stroke-dasharray', `0 ${at} ${total * 2}`)

  // The pill sits on the path where the two meet, turned to follow it.
  const p = path.getPointAtLength(at), q = path.getPointAtLength(at + 1)
  svg.querySelector('.hf-pill').setAttribute('transform',
    `translate(${p.x} ${p.y}) rotate(${Math.atan2(q.y - p.y, q.x - p.x) * 180 / Math.PI})`)

  // Lay the phrases out so each starts at the same distance in both texts.
  const tpRaw = svg.querySelector('.hf-raw textPath'), tpClean = svg.querySelector('.hf-clean textPath')
  const measure = (tp, s) => { tp.textContent = s; return tp.getComputedTextLength() }
  const GAP = 34
  const seg = PHRASES.map(([r, c]) => ({ r, c, rw: measure(tpRaw, r), cw: measure(tpClean, c) }))
  for (const s of seg) s.w = Math.max(s.rw, s.cw) + GAP
  const unit = seg.reduce((a, s) => a + s.w, 0)
  const reps = Math.ceil((total + unit) / unit) + 1
  const fill = (tp, key, wkey) => {
    tp.textContent = ''
    let prevEnd = 0, start = 0
    for (let k = 0; k < reps; k++) for (const s of seg) {
      const t = document.createElementNS(NS, 'tspan')
      t.setAttribute('dx', start - prevEnd)
      t.textContent = s[key]
      tp.append(t)
      prevEnd = start + s[wkey]; start += s.w
    }
  }
  fill(tpRaw, 'r', 'rw'); fill(tpClean, 'c', 'cw')

  let pos = 220
  const place = () => {
    const o = (pos % unit) - unit
    tpRaw.setAttribute('startOffset', o); tpClean.setAttribute('startOffset', o)
  }
  place()
  svg.classList.add('ready')
  if (reduce) { svg.classList.add('still'); return }

  // Waveform in the pill: the app's own idea of a speaking voice, simplified.
  const bars = [...svg.querySelectorAll('.hf-pill .bar')]
  let on = false, last = 0, boost = 0, lastY = scrollY
  addEventListener('scroll', () => { boost = Math.min(boost + Math.abs(scrollY - lastY) * 1.6, 900); lastY = scrollY }, { passive: true })
  const loop = (now) => {
    if (!on) return
    const dt = Math.min(0.05, (now - last) / 1000 || 0); last = now
    pos += (SPEED + boost) * dt
    boost *= Math.pow(0.04, dt)
    place()
    const t = now / 1000
    bars.forEach((b, i) => {
      const v = 0.35 + 0.65 * Math.abs(Math.sin(t * 6.1 + i * 0.9) * Math.sin(t * 2.3 + i * 0.37))
      b.setAttribute('height', 4 + v * 14); b.setAttribute('y', -(2 + v * 7))
    })
    requestAnimationFrame(loop)
  }
  const start = () => { if (!on) { on = true; last = performance.now(); requestAnimationFrame(loop) } }
  new IntersectionObserver(([e]) => { if (e.isIntersecting && !document.hidden) start(); else on = false }).observe(svg)
  document.addEventListener('visibilitychange', () => { if (document.hidden) on = false; else start() })
})()
