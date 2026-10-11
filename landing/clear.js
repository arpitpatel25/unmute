// The plain page's only script: play each clip while it's on screen (and only
// then load it), respect reduced motion, sound toggles, and the callouts that
// explain each real recording as it plays.
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

  // Sound: one clip at a time. Turning it on restarts that clip from the top,
  // so the sentence is heard from its first word.
  const buttons = [...document.querySelectorAll('.film .sound')]
  const setSound = (btn, on) => {
    const v = btn.closest('.frame').querySelector('video')
    btn.setAttribute('aria-pressed', String(on))
    btn.querySelector('.on-off').textContent = on ? 'Sound off' : 'Sound on'
    v.muted = !on
    if (on) { v.currentTime = 0; v.play().catch(() => {}) }
  }
  for (const btn of buttons) btn.addEventListener('click', () => {
    const on = btn.getAttribute('aria-pressed') !== 'true'
    if (on) for (const other of buttons) if (other !== btn && other.getAttribute('aria-pressed') === 'true') setSound(other, false)
    setSound(btn, on)
  })

  // Callouts. Each clip is a real recording; these only point at what's in it.
  // steps: the sequence under the clip, each lit from `at` seconds.
  // rings: a box around a spot in the footage (percent of the 16:9 frame),
  // shown from `from` to `to` seconds, with a short label above or below it.
  const CUES = {
    hero: {
      steps: [
        { at: 0, k: 'On screen', t: 'Rishi’s bug report in Slack' },
        { at: 2.5, k: 'You say', t: 'Tap right ⌥: “Investigate this issue reported by Rishi”' },
        { at: 9.4, k: 'Unmute adds', t: 'A link to the Slack message you were looking at' },
        { at: 12.4, k: 'Claude Code', t: 'A new session starts on it. Slack never lost focus.' },
      ],
      rings: [
        { from: 2.6, to: 9.3, x: 50.4, y: 49.6, w: 48.6, h: 11, n: 1, label: 'On screen: the bug report', at: 'below' },
        { from: 12.8, to: 99, x: 39.4, y: 20.4, w: 35.8, h: 5.4, n: 3, label: 'Added by Unmute: the Slack link', at: 'below' },
      ],
    },
    'step-say': {
      steps: [
        { at: 0, k: 'On screen', t: 'A “Subscription inactive” banner while signed in' },
        { at: 0.8, k: 'You say', t: 'Tap right ⌥: “Why is the subscription inactive? We need to check that.”' },
        { at: 9.2, k: 'Unmute adds', t: 'A screenshot of what you were looking at' },
        { at: 10.2, k: 'Claude Code', t: 'A new session starts fixing it' },
      ],
      rings: [
        { from: 0.4, to: 9, x: 29.4, y: 16, w: 41.4, h: 9, n: 1, label: 'On screen: the bug', at: 'below' },
        { from: 9.5, to: 12.2, x: 16.6, y: 32.2, w: 11.4, h: 15.4, n: 3, label: 'Added by Unmute: a screenshot', at: 'below' },
      ],
    },
    'step-works': {
      steps: [
        { at: 0, k: 'At the top', t: 'Your session’s status: “Rishi reported issue · Working”' },
        { at: 2.4, k: 'Look in', t: 'Click it to see what the session is doing' },
        { at: 5.4, k: 'Carry on', t: 'Close it and keep working in Slack' },
      ],
      rings: [
        { from: 1.4, to: 2.4, x: 41.2, y: 0.4, w: 17.6, h: 6.6, n: 1, label: '', at: 'below' },
      ],
      // The status is tiny in the recording, so a frame of that corner (from
      // 1.8 s of the same clip) is shown enlarged while it's being pointed at.
      zooms: [
        { from: 0.2, to: 2.4, img: 'assets/video/step-works-status.jpg', box: [5, 26, 50], label: 'Enlarged: the status at the top of your screen' },
      ],
    },
    'step-answer': {
      steps: [
        { at: 0, k: 'It asks', t: 'Claude Code: “Want me to put them on a branch and commit?”' },
        { at: 3.9, k: 'You answer', t: 'Tap right ⌥: “Commit those changes in a new separate branch.”' },
        { at: 10.8, k: 'Done', t: 'Committed on a new branch, without opening a terminal' },
      ],
      rings: [
        { from: 1.2, to: 3.8, x: 13.2, y: 89, w: 73, h: 9.4, n: 1, label: 'The question', at: 'above' },
        { from: 11, to: 99, x: 11.8, y: 37.2, w: 71.4, h: 5.8, n: 3, label: 'The result', at: 'below' },
      ],
    },
    'step-research': {
      steps: [
        { at: 0, k: 'On screen', t: 'A video on X about Wispr Flow’s paid ads program' },
        { at: 0.8, k: 'You say', t: 'Tap right ⌥: “Let’s see how this fits for Unmute. Can we replicate it?”' },
        { at: 14.4, k: 'Unmute adds', t: 'A link to the post you were watching' },
        { at: 15.2, k: 'Claude Code', t: 'A research session starts on it' },
      ],
      rings: [
        { from: 3, to: 13.8, x: 32, y: 25, w: 30.2, h: 30.4, n: 1, label: 'On screen: the video', at: 'below' },
        { from: 14.8, to: 99, x: 27, y: 21, w: 30.6, h: 5, n: 3, label: 'Added by Unmute: the post’s link', at: 'below' },
      ],
    },
  }

  for (const v of videos) {
    const cues = CUES[v.dataset.cues]
    if (!cues) continue
    const fig = v.closest('.film'), frame = v.closest('.frame')

    const layer = document.createElement('div')
    layer.className = 'marks'
    layer.setAttribute('aria-hidden', 'true')
    const rings = cues.rings.map((r) => {
      const el = document.createElement('div')
      el.className = `ring ${r.at}${r.low ? ' low' : ''}`
      el.style.cssText = `left:${r.x}%;top:${r.y}%;width:${r.w}%;height:${r.h}%`
      el.innerHTML = `<i>${r.n}</i>${r.label ? `<span>${r.label}</span>` : ''}`
      layer.append(el)
      return el
    })
    const zooms = (cues.zooms || []).map((z) => {
      const el = document.createElement('figure')
      el.className = 'zoom'
      el.style.cssText = `left:${z.box[0]}%;top:${z.box[1]}%;width:${z.box[2]}%`
      el.innerHTML = `<img src="${z.img}" alt="" /><figcaption>${z.label}</figcaption>`
      layer.append(el)
      return { el, z }
    })
    frame.append(layer)

    const ol = document.createElement('ol')
    ol.className = cues.steps.length === 4 ? 'beats four' : 'beats'
    ol.style.setProperty('--n', cues.steps.length)
    ol.innerHTML = cues.steps.map((s, i) => `<li><b><i>${i + 1}</i>${s.k}</b><span>${s.t}</span></li>`).join('')
    frame.after(ol)
    const lis = [...ol.children]
    fig.classList.add('cued')

    let last = -1
    const paint = () => {
      const t = v.currentTime
      let cur = 0
      cues.steps.forEach((s, i) => { if (t >= s.at) cur = i })
      if (cur !== last) {
        lis.forEach((li, i) => { li.classList.toggle('on', i === cur); li.classList.toggle('done', i < cur) })
        last = cur
      }
      cues.rings.forEach((r, i) => rings[i].classList.toggle('show', t >= r.from && t < r.to))
      for (const { el, z } of zooms) el.classList.toggle('show', t >= z.from && t < z.to)
    }
    // rAF while playing keeps the boxes on the beat; timeupdate alone fires ~4×/s.
    let raf = 0
    const loop = () => { paint(); raf = requestAnimationFrame(loop) }
    v.addEventListener('play', () => { cancelAnimationFrame(raf); loop() })
    v.addEventListener('pause', () => { cancelAnimationFrame(raf); paint() })
    v.addEventListener('seeked', paint)
    v.addEventListener('timeupdate', () => { if (v.paused) paint() })
    paint()
  }
})()
