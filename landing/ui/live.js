// THE LIVE PAGE — wires the scenes to the page: the hero with its steps and
// controls, the app tabs, the scroll-driven walk-through, several sessions at
// once, the use-case cards, and the real recording.
import { Screen, runScene, setSound, sound, reduced, WPS } from './kit.js'
import { hero, heroStill, apps, stages, parallel, film, filmStill, stopNarration } from './scenes.js'

const $ = (s, r = document) => r.querySelector(s)
const $$ = (s, r = document) => [...r.querySelectorAll(s)]
const saidText = (t) => `You say: “${t}”`

// ── Hero ──────────────────────────────────────────────────────────────────────
{
  const fig = $('.hero-scene'), steps = $$('.steps li', fig), said = $('.said', fig)
  const s = new Screen($('#hero-stage'))
  const paint = (i) => steps.forEach((li, k) => { li.classList.toggle('on', k === i); li.classList.toggle('done', i >= 0 && k < i) })
  s.host.addEventListener('kit:say', (e) => { said.textContent = saidText(e.detail) })
  const ctl = runScene(s, hero, { onStep: (i) => { paint(i); if (i === 0 || i === 2) said.textContent = '' }, still: heroStill })
  const pause = $('.c-pause', fig), snd = $('.c-sound', fig)
  pause.addEventListener('click', () => { const p = ctl.pause(); pause.setAttribute('aria-pressed', String(p)); pause.textContent = p ? 'Play' : 'Pause' })
  $('.c-replay', fig).addEventListener('click', () => { pause.setAttribute('aria-pressed', 'false'); pause.textContent = 'Pause'; ctl.replay() })
  snd.addEventListener('click', () => { setSound(!sound.on) })
  sound.listeners.add((on) => { snd.setAttribute('aria-pressed', String(on)); snd.textContent = on ? 'Sound on' : 'Sound off' })
  if (reduced) { pause.hidden = true; $('.c-replay', fig).hidden = true }
}

// ── Where it works: one scene per app ─────────────────────────────────────────
{
  const order = ['slack', 'linear', 'figma', 'github', 'gmail', 'docs']
  const notes = {
    slack: 'In Slack: a long planning thread becomes Linear issues.',
    linear: 'In Linear: take a ticket, and it starts on it.',
    figma: 'In Figma: grab the design, and it builds it.',
    github: 'In GitHub: send a follow-up to a session that’s already running.',
    gmail: 'In Gmail: hand over the replies.',
    docs: 'In Chrome: the page you’re reading goes along.',
  }
  // Rough lengths, for the progress bar only.
  const len = { slack: 17, linear: 14, figma: 16, github: 21, gmail: 17, docs: 13 }
  const sec = $('#apps'), tabs = $$('.tab', sec), note = $('.tab-note', sec), said = $('.said', sec), bar = $('.tbar i', sec)
  const s = new Screen($('#apps-stage'))
  s.host.addEventListener('kit:say', (e) => { said.textContent = saidText(e.detail) })
  let cur = 0, auto = true, visible = false, started = false, t0 = 0, run = 0
  const select = (i) => { cur = i; tabs.forEach((t, k) => t.setAttribute('aria-selected', String(k === i))); note.textContent = notes[order[i]]; said.textContent = '' }
  const play = async (i) => {
    const me = ++run
    s.clock.reset(); select(i); t0 = performance.now()
    try { await apps[order[i]](s) } catch (e) { if (e.message !== 'reset') console.error(e); return }
    if (me !== run) return
    await new Promise((r) => setTimeout(r, 600))
    if (me === run) play(auto ? (i + 1) % order.length : i)
  }
  // The progress bar follows the scene's own clock, so it pauses with it.
  let shown = 0, last = performance.now()
  ;(function tick(now) {
    if (!s.clock.paused) shown += now - last
    last = now
    bar.style.transform = `scaleX(${Math.min(1, shown / 1000 / len[order[cur]])})`
    requestAnimationFrame(tick)
  })(performance.now())
  const restartBar = () => { shown = 0 }
  tabs.forEach((t, i) => t.addEventListener('click', () => { auto = false; restartBar(); play(i) }))
  const origPlay = play
  new IntersectionObserver(([e]) => {
    visible = e.intersectionRatio >= 0.3
    s.clock.paused = !visible || document.hidden
    if (visible && !started) { started = true; restartBar(); origPlay(0) }
  }, { threshold: [0, 0.3] }).observe(s.host)
  // Restart the bar whenever a new scene starts.
  const obs = new MutationObserver(restartBar); obs.observe(note, { childList: true, characterData: true, subtree: true })
  select(0)
  if (reduced) { started = true; apps.slack(s).catch(() => {}) }
}

// ── What happens after you speak: driven by scroll ────────────────────────────
{
  const wrap = $('.scrolly'), items = $$('.stages li')
  const s = new Screen($('#how-stage'), { box: { x: 290, y: 0, w: 700, h: 440 }, cls: 'closeup' })
  const set = stages(s)
  let cur = -1
  const go = (i) => {
    if (i === cur) return
    cur = i; set[i]()
    items.forEach((li, k) => { li.classList.toggle('on', k === i); li.classList.toggle('done', k < i) })
  }
  const onScroll = () => {
    const r = wrap.getBoundingClientRect(), total = r.height - innerHeight * 0.75
    const p = Math.min(0.999, Math.max(0, (-r.top + innerHeight * 0.25) / total))
    go(Math.floor(p * set.length))
  }
  addEventListener('scroll', onScroll, { passive: true }); addEventListener('resize', onScroll)
  go(0); onScroll()
  if (reduced) go(3)
}

// ── Several at once ───────────────────────────────────────────────────────────
{
  const s = new Screen($('#many-stage'), { box: { x: 290, y: 0, w: 700, h: 440 }, cls: 'closeup' })
  runScene(s, parallel, { still: (sc) => sc.notch({ right: { text: 'Working', n: 3 }, width: 380 }) })
}

// ── Use cases: each card says it, works on it, and shows what came back ───────
{
  const cards = $$('.task')
  for (const c of cards) {
    const q = $('.tk-q', c), text = q.textContent
    q.innerHTML = text.split(' ').map((w) => `<span class="w">${w} </span>`).join('')
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, reduced ? 0 : ms))
  const play = async (c, delay) => {
    if (c.dataset.busy) return
    c.dataset.busy = '1'
    c.classList.remove('working', 'done')
    const ws = $$('.tk-q .w', c)
    ws.forEach((w) => w.classList.remove('in'))
    await sleep(delay)
    for (const w of ws) { w.classList.add('in'); await sleep(1000 / WPS) }
    await sleep(350); c.classList.add('working'); $('.tk-s b', c).textContent = 'Working'
    await sleep(1600); c.classList.remove('working'); c.classList.add('done'); $('.tk-s b', c).textContent = c.dataset.agent === 'codex' ? 'Ready' : 'Done'
    delete c.dataset.busy
  }
  const io = new IntersectionObserver((es) => {
    es.forEach((e) => { if (e.isIntersecting) { const list = e.target.parentElement; const i = [...list.children].indexOf(e.target); play(e.target, i * 450); io.unobserve(e.target) } })
  }, { threshold: 0.6 })
  cards.forEach((c) => io.observe(c))
  cards.forEach((c) => c.addEventListener('mouseenter', () => play(c, 0)))
}

// ── The full flow: the real recording, rebuilt, with chapters ────────────────
{
  const fig = $('.film-scene'), chs = $$('.chapters button', fig), cap = $('.film-cap', fig)
  const s = new Screen($('#film-stage'))
  let target = 0
  const paint = (i) => chs.forEach((b, k) => { b.classList.toggle('on', k === i); b.classList.toggle('done', i >= 0 && k < i) })
  s.host.addEventListener('kit:narrate', (e) => { if (!s.clock.fast) cap.textContent = e.detail })
  const ctl = runScene(s, film, { threshold: 0.5, still: filmStill, onStep: (i) => {
    // Jumping to a chapter plays everything before it instantly.
    if (i >= target) { s.clock.fast = false; target = 0 }
    paint(i)
  } })
  const pause = $('.c-pause', fig), snd = $('.c-sound', fig)
  const playing = () => { pause.setAttribute('aria-pressed', 'false'); pause.textContent = 'Pause' }
  chs.forEach((b, k) => b.addEventListener('click', () => {
    stopNarration(); cap.textContent = ''; playing(); ctl.replay()
    target = k; setTimeout(() => { s.clock.fast = k > 0 }, 0)
  }))
  pause.addEventListener('click', () => { const p = ctl.pause(); if (p) stopNarration(); pause.setAttribute('aria-pressed', String(p)); pause.textContent = p ? 'Play' : 'Pause' })
  $('.c-replay', fig).addEventListener('click', () => { stopNarration(); target = 0; s.clock.fast = false; playing(); ctl.replay() })
  snd.addEventListener('click', () => { setSound(!sound.on); if (!sound.on) stopNarration() })
  sound.listeners.add((on) => { snd.setAttribute('aria-pressed', String(on)); snd.textContent = on ? 'Sound on' : 'Sound off' })
  if (reduced) { pause.hidden = true; $('.c-replay', fig).hidden = true }
}

// ── The raw recording: loads only when it's opened ───────────────────────────
{
  const d = $('.real-wrap'), v = $('.real video')
  const small = Math.min(screen.width, innerWidth) < 900
  d.addEventListener('toggle', () => { if (d.open && !v.src) { v.src = `assets/video/hero${small ? '-720' : ''}.mp4?v=l41`; v.play().catch(() => {}) } })
}
