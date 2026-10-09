// HERO FLOW — what people say, flowing into their agents.
//
// Spoken requests stream along curves on either side of the headline, the way
// dictated words arrive, and disappear into a Claude Code or a Codex badge:
// the words are handed to the agent. Plain SVG text on paths, moved with
// requestAnimationFrame; no library, so it runs before the demos load.
// Paused off screen; still under reduced motion.
;(() => {
  const svg = document.querySelector('.hero-flow')
  if (!svg) return
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
  const SPEED = 34 // px per second along the path

  const streams = [...svg.querySelectorAll('textPath')].map((tp) => {
    const path = svg.querySelector(tp.getAttribute('href'))
    const len = path.getTotalLength()
    // One cycle of the phrases, then repeat it until the text covers the
    // path twice over, so the loop never shows a gap.
    const unit = tp.dataset.phrases.split('|').join('   ·   ') + '   ·   '
    tp.textContent = unit
    const u = tp.getComputedTextLength() || 1
    tp.textContent = unit.repeat(Math.ceil((len + u) / u) + 1)
    return { tp, u, speed: SPEED * (+tp.dataset.speed || 1) }
  })

  const place = (t) => {
    for (const s of streams) s.tp.setAttribute('startOffset', ((t * s.speed) % s.u) - s.u)
  }
  place(4)
  if (reduce) return

  let on = false, t0 = performance.now() - 4000
  const loop = (now) => {
    if (!on) return
    place((now - t0) / 1000)
    requestAnimationFrame(loop)
  }
  new IntersectionObserver(([e]) => {
    const was = on
    on = e.isIntersecting && !document.hidden
    if (on && !was) requestAnimationFrame(loop)
  }).observe(svg)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) on = false
    else if (!on) { on = true; requestAnimationFrame(loop) }
  })
})()
