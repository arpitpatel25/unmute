// SOUND FOLLOWS FOCUS. The demo that's most on screen plays with its voice;
// every other demo stays muted. When a demo comes into focus it restarts, so
// its narration is heard from the first word. One Mute button under each
// demo turns sound off (or back on) for the whole page.
//
// Browsers only allow sound after the visitor has interacted with the page
// once (a click, tap or key). Until then the focused demo plays muted and
// says "Click anywhere for sound"; the first interaction turns it on.
;(() => {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return
  const films = [...document.querySelectorAll('.film')].filter((f) => f.querySelector('.listen'))
  const items = films.map((fig) => ({ fig, v: fig.querySelector('video'), btn: fig.querySelector('.listen-btn'), hint: fig.querySelector('.listen .hint'), ratio: 0 }))
  let soundOn = true, unlocked = navigator.userActivation?.hasBeenActive || false, focused = null

  const paint = () => {
    for (const it of items) {
      const live = it === focused && soundOn && unlocked
      it.btn.setAttribute('aria-pressed', String(soundOn))
      it.btn.querySelector('.lbl').textContent = soundOn ? 'Mute' : 'Turn sound on'
      it.hint.textContent = !soundOn ? 'Sound is off' : unlocked ? (live ? 'Playing with sound' : 'Plays with sound when you scroll to it') : (matchMedia('(pointer: coarse)').matches ? 'Tap anywhere on the page for sound' : 'Click anywhere on the page for sound')
      it.fig.classList.toggle('needs-click', soundOn && !unlocked && it === focused)
    }
  }
  const apply = (restart) => {
    for (const it of items) {
      const live = it === focused && soundOn && unlocked
      it.v.muted = !live
      if (live && restart) { it.v.currentTime = 0; it.v.play().catch(() => { it.v.muted = true }) }
    }
    paint()
  }
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) { const it = items.find((x) => x.v === e.target); if (it) it.ratio = e.isIntersecting ? e.intersectionRatio : 0 }
    const best = items.reduce((a, b) => (b.ratio > a.ratio ? b : a), { ratio: 0.5 })
    const next = best.ratio > 0.5 ? best : null
    if (next !== focused) { focused = next; apply(true) }
  }, { threshold: [0, 0.25, 0.5, 0.6, 0.75, 0.9, 1] })
  items.forEach((it) => io.observe(it.v))

  const unlock = () => { if (unlocked) return; unlocked = true; apply(true) }
  for (const ev of ['pointerdown', 'keydown', 'touchstart']) addEventListener(ev, unlock, { capture: true, passive: true })

  for (const it of items) it.btn.addEventListener('click', (e) => {
    e.stopPropagation()
    const wasLocked = !unlocked
    unlocked = true
    soundOn = wasLocked ? true : !soundOn
    if (soundOn && it !== focused) focused = it
    apply(soundOn)
  })
  // Muting with the in-frame button would fight this; the bar is the control.
  document.querySelectorAll('.film .frame .sound').forEach((b) => b.remove())
  paint()
})()
