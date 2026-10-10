// The plain page's only script: play each clip while it's on screen (and only
// then load it), respect reduced motion, and the hero's sound toggle.
;(() => {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
  const videos = [...document.querySelectorAll('.film video')]

  for (const v of videos) {
    v.muted = true
    if (reduce) { v.removeAttribute('autoplay'); v.pause(); v.controls = true }
  }
  if (!reduce) {
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const v = e.target
        if (e.isIntersecting) { if (v.preload === 'none') v.preload = 'auto'; v.play().catch(() => {}) }
        else v.pause()
      }
    }, { threshold: 0.35 })
    videos.forEach((v) => io.observe(v))
  }

  // Sound: turning it on restarts the hero from the top, so the sentence is
  // heard from its first word.
  const hero = document.querySelector('video[data-sound]'), btn = document.querySelector('.sound')
  if (hero && btn) btn.addEventListener('click', () => {
    const on = btn.getAttribute('aria-pressed') !== 'true'
    btn.setAttribute('aria-pressed', String(on))
    btn.querySelector('.on-off').textContent = on ? 'Sound off' : 'Sound on'
    hero.muted = !on
    if (on) { hero.currentTime = 0; hero.play().catch(() => {}) }
  })
})()
