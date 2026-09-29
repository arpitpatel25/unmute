import { Stage, track, ready } from './ui/stage.js'

gsap.registerPlugin(ScrollTrigger)
const $ = (s, r = document) => r.querySelector(s)
const $$ = (s, r = document) => [...r.querySelectorAll(s)]
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches

if (!reduce) {
  const lenis = new Lenis({ lerp: 0.09 })
  lenis.on('scroll', ScrollTrigger.update)
  gsap.ticker.add((t) => lenis.raf(t * 1000))
  gsap.ticker.lagSmoothing(0)
}
ScrollTrigger.create({ start: 40, onToggle: (s) => $('nav.top').classList.toggle('scrolled', s.isActive) })
const splitWords = (el) => { el.innerHTML = el.textContent.split(' ').map((w) => `<span class="w">${w}</span>`).join(' ') ; return $$('.w', el) }

// ── The user's own apps: plain stand-ins, never unmute UI ─────────────────────
const W = (app, title, body, style = '', cls = '') =>
  `<div class="app ${cls}" data-app="${app}" data-title="${title.split(' — ')[0]}" style="${style}"><div class="bar"><i></i><i></i><i></i><span>${title}</span></div>${body}</div>`
const APPS = {
  slack: (s) => W('slack', 'Slack — #launch', `<div class="body"><div class="msg"><div class="av p"></div><div><b>Priya</b><br/>Design's done. Are we still good for Tuesday?</div></div><div class="msg"><div class="av"></div><div><b>Sam</b><br/>QA found two blockers 😬</div></div></div><div class="compose" data-ph="Message #launch"></div>`, s),
  slackThread: (s) => W('slackThread', 'Slack — #launch', `<div class="body"><div class="msg"><div class="av p"></div><div><b>Priya</b><br/>Can you go through this thread and turn it into tasks? Need owners by Friday.</div></div><div class="msg"><div class="av"></div><div><b>Sam</b><br/>+1, eight messages of chaos above 😅</div></div></div>`, s),
  docs: (s) => W('docs', 'Docs — Pricing launch brief', `<div class="body"><b style="font-size:26px">Pricing launch — brief</b><div class="skel" style="width:92%;margin-top:26px"></div><div class="skel" style="width:80%"></div><div class="skel" style="width:86%"></div><div class="skel" style="width:60%"></div><div class="skel" style="width:74%"></div></div>`, s),
  youtube: (s) => W('youtube', 'YouTube — Onboarding teardown', `<div class="video"><div class="play">▶</div><div class="ttl">Onboarding teardown</div><div class="prog"><i></i></div></div>`, s),
  finder: (s) => W('finder', 'Finder — Downloads', `<div class="files">${[12, 14, 2, 21, 7, 18, 11, 25].map((d) => `<div><i></i><span>Screenshot 2026-09-${String(d).padStart(2, '0')}…</span></div>`).join('')}</div>`, s),
  mail: (s) => W('mail', 'Mail — Re: launch date', `<div class="body"><div style="color:#888">To: Priya &nbsp;·&nbsp; Re: launch date</div><div class="typed" style="margin-top:22px"></div></div>`, s),
  figma: (s) => W('figma', 'Figma — Pricing', `<div style="position:absolute;inset:44px 0 0 0;background:#e9e9ec;display:grid;place-items:center"><div style="width:44%;height:58%;background:#fff;border:3px solid #a259ff;border-radius:8px;padding:22px;font-size:20px"><b>Team</b><br/>$8.99/mo<br/><br/>▢ ▢ ▢</div></div>`, s),
  hn: (s) => W('hn', 'Chrome — news.ycombinator.com', `<div class="body"><b style="font-size:24px">Show HN: how we price team plans</b><div class="skel" style="width:90%;margin-top:24px"></div><div class="skel" style="width:76%"></div><div class="skel" style="width:84%"></div><div class="skel" style="width:58%"></div></div>`, s),
  code: (s) => W('code', 'Code — auth/refresh.ts', `<div class="body code"><span style="color:#8250df">export async function</span> refreshToken(t) {<br/>&nbsp;&nbsp;<span style="color:#8250df">const</span> res = <span style="color:#8250df">await</span> api.post(<span style="color:#0a7c3e">'/refresh'</span>, t)<br/>&nbsp;&nbsp;<span style="color:#8250df">return</span> res.token<br/>}</div>`, s),
  settings: (s) => W('settings', 'Chrome — acme.app/settings', `<div class="body"><b style="font-size:24px">Profile settings</b><div class="skel" style="width:60%;margin-top:24px"></div><div class="skel" style="width:45%"></div><div class="savebtn">Save changes</div></div>`, s),
  call: (s) => W('call', 'Meet — Onboarding redesign', `<div class="grid"><div>AP</div><div>SM</div><div>PR</div><div>JL</div></div>`, s, 'dark'),
  inbox: (s) => W('inbox', 'Mail — Inbox', `<div class="body"><b>Inbox</b><div class="skel" style="width:88%;margin-top:22px"></div><div class="skel" style="width:70%"></div><div class="skel" style="width:80%"></div><div class="skel" style="width:52%"></div></div>`, s),
  notes: (s) => W('notes', 'Notes', `<div class="body"><div class="typed"></div></div>`, s),
  terminal: (s) => W('terminal', 'Terminal — zsh', `<div class="body code">~/acme % <span class="typed"></span></div>`, s, 'dark'),
}
// Where an expanded surface (≤ 648×405 at the top) or the pocket card will
// appear, windows sit clear of it: the glass in those captures sampled the
// wallpaper, and must be shown over the wallpaper.
const LOW = 'top:440px;left:120px;width:1200px;height:400px'
const apps = (...list) => list.map(([k, s]) => APPS[k](s || '')).join('')

function said(el, key, text) {
  if (!el) return
  if (!key && !text) { el.innerHTML = ''; return }
  el.innerHTML = `<kbd class="on">${key}</kbd><span class="q">${(text || '').split(' ').map((w, i) => `<span class="w" style="animation-delay:${i * 55}ms">${w}</span>`).join(' ')}</span>`
}
function typed(stage, text) { $$('.compose, .typed', stage.host).forEach((e) => { e.textContent = text || '' }) }

// A scene = stage + track + standard hook for captions/typed text/extras.
function scene(name, appHtml, keys, extra = {}) {
  const host = $(`[data-stage="${name}"]`)
  const stage = new Stage(host, { apps: appHtml, zoom: extra.zoom })
  if (extra.html) stage.extra().innerHTML = extra.html
  const sayEl = $(`[data-said="${name}"]`)
  let lastSay = null
  const fn = track(stage, keys, {
    apply(s, idx) {
      const sig = `${s.key}|${s.say}`
      if (sig !== lastSay) { said(sayEl, s.key, s.say); lastSay = sig }
      typed(stage, s.typed)
      extra.apply?.(s, idx, stage)
    },
  })
  return { stage, fn }
}

await ready

// ── 1 · HERO — loops by time ─────────────────────────────────────────────────
{
  const outs = $$('.outcomes span')
  const { fn } = scene('hero', apps(['slack'], ['docs'], ['youtube'], ['finder']), [
    [0.00, { app: 'slack', notch: null, pill: null, key: '', say: '', typed: '', o: -1 }],
    [0.03, { key: 'fn', say: 'can we push the launch to Thursday?', pill: 'pill-fn-rec', speak: true, o: 0 }],
    [0.15, { pill: 'pill-fn-proc', speak: false }],
    [0.18, { pill: 'pill-fn-out', typed: 'can we push the launch to Thursday?' }],
    [0.22, { pill: null }],
    [0.26, { app: 'docs', typed: '', key: 'right ⌥', say: 'build a landing page for the pricing launch', pill: 'pill-ropt-rec', speak: true, o: 1 }],
    [0.39, { pill: 'pill-ropt-proc', speak: false }],
    [0.43, { pill: null, notch: 'bar-sending' }],
    [0.47, { notch: 'bar-working1' }],
    [0.52, { app: 'youtube', key: 'right ⌘ ×2', say: 'save this — good example of onboarding, for the redesign', pill: 'pill-agent-rec', speak: true, notch: 'bar-agent-listening', o: 2 }],
    [0.65, { pill: 'pill-agent-proc', speak: false, notch: 'bar-agent-thinking' }],
    [0.69, { pill: null, notch: 'bar-agent-done' }],
    [0.76, { app: 'finder', key: 'right ⌘ ×2', say: 'continue the landing page from Monday', pill: 'pill-agent-rec', speak: true, notch: 'bar-agent-listening', o: 3 }],
    [0.87, { pill: 'pill-agent-proc', speak: false, notch: 'bar-agent-searching' }],
    [0.91, { pill: null, notch: 'bar-inpocket' }],
  ], { zoom: 0.55, apply: (s) => outs.forEach((o, i) => o.classList.toggle('on', i === s.o)) })
  gsap.from(splitWords($('#heroH1')), { y: 60, opacity: 0, rotate: 3, stagger: 0.08, duration: 0.9, ease: 'power4.out', delay: 0.1 })
  gsap.from(['.hero .philo', '.hero .sub', '.hero .ctas', '.works', '.hero .stagebox'], { y: 24, opacity: 0, stagger: 0.1, duration: 0.8, ease: 'power3.out', delay: 0.4 })
  const loop = gsap.to({}, { duration: 22, repeat: -1, ease: 'none', delay: 1, onUpdate() { fn(this.progress()) } })
  ScrollTrigger.create({ trigger: '#hero', start: 'top bottom', end: 'bottom top', onToggle: (s) => (s.isActive ? loop.play() : loop.pause()) })
}

// Desktop: pinned and scroll-scrubbed. Phones get their own treatment per section.
const mm = gsap.matchMedia()
const DESK = '(min-width: 901px) and (prefers-reduced-motion: no-preference)'
const PHONE = '(max-width: 900px), (prefers-reduced-motion: reduce)'
function pinned(sel, length, build) {
  mm.add(DESK, () => {
    const sec = $(sel)
    const tl = gsap.timeline({ scrollTrigger: { trigger: sec, pin: true, start: 'top top', end: '+=' + length, scrub: 0.8, invalidateOnRefresh: true } })
    build(tl, sec)
  })
}
// A stage scene: scrubbed by scroll on desktop, LOOPING while on screen on a
// phone — pinning a tall section on a small screen fights the thumb.
function scenePlay(sel, length, fn, loopSeconds) {
  pinned(sel, length, (tl) => drive(tl, fn, 0, 1))
  mm.add(PHONE, () => {
    const loop = gsap.to({}, { duration: loopSeconds, repeat: -1, ease: 'none', paused: true, onUpdate() { fn(this.progress()) } })
    const st = ScrollTrigger.create({ trigger: sel, start: 'top 80%', end: 'bottom 20%', onToggle: (s) => (s.isActive ? loop.play() : loop.pause()) })
    return () => { loop.kill(); st.kill() }
  })
}
// Drive a track from a span of a timeline: tl.to(proxy) over [at, at+dur].
const drive = (tl, fn, at, dur) => { const o = { p: 0 }; tl.to(o, { p: 1, duration: dur, ease: 'none', onUpdate: () => fn(o.p) }, at) }

// ── 2 · THE TRIP ──────────────────────────────────────────────────────────────
{
  const { fn } = scene('trip', apps(['docs', LOW]), [
    [0.00, { app: 'docs' }],
    [0.05, { key: 'right ⌥', say: 'build a landing page for the pricing launch', pill: 'pill-ropt-rec', speak: true }],
    [0.30, { pill: 'pill-ropt-proc', speak: false }],
    [0.38, { pill: null, notch: 'bar-sending' }],
    [0.46, { notch: 'task-1' }],
    [0.62, { notch: 'task-2' }],
    [0.76, { notch: 'task-3' }],
    [0.88, { notch: 'task-4' }],
  ])
  pinned('#trip', 3800, (tl, sec) => {
    const steps = $$('.step', sec), idea = $('.i1', sec), counter = $('.counter', sec)
    const cx = (el) => { const r = el.getBoundingClientRect(), s = sec.getBoundingClientRect(); return r.left - s.left + r.width / 2 - idea.offsetWidth / 2 }
    const secs = [3, 8, 17, 41, 58, 60], c = { s: 0, t: 0 }
    const paint = () => (counter.textContent = `${Math.round(c.s)} steps · ${Math.round(c.t)}s`)
    tl.from($('.ha', sec), { y: 30, opacity: 0, duration: 0.5 })
      .fromTo(idea, { opacity: 0, scale: 0.6, x: () => cx(steps[0]) }, { opacity: 1, scale: 1, duration: 0.4, ease: 'back.out(2)' })
      .to($('.line', sec), { scaleX: 1, duration: 3.6, ease: 'none' }, '+=.1')
    steps.forEach((st, i) => {
      tl.fromTo(st, { opacity: 0, y: 24 }, { opacity: 1, y: 0, duration: 0.35, ease: 'power3.out' }, i === 0 ? '<' : '>+.15')
        .to(idea, { x: () => cx(st), scale: 1 - i * 0.09, opacity: 1 - i * 0.13, filter: `blur(${i * 0.9}px)`, duration: 0.45 }, '<')
        .to(c, { s: i + 1, t: secs[i], duration: 0.35, ease: 'none', onUpdate: paint }, '<')
    })
    tl.set(idea, { textContent: '…what was it again?' }, '+=.2')
      .to(idea, { opacity: 0.25, duration: 0.3 })
      .fromTo($('.again', sec), { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: 0.4 })
      .to({}, { duration: 0.9 })
      .to($('.again', sec), { opacity: 0, duration: 0.25 })
      .to([...steps, $('.line', sec)], { opacity: 0, y: 30, stagger: 0.04, duration: 0.4 })
      .to(idea, { opacity: 0, duration: 0.2 }, '<')
      .to($('.ha', sec), { opacity: 0, y: -20, duration: 0.3 }, '<')
      .fromTo($('.hb', sec), { opacity: 0, y: 20 }, { opacity: 1, y: 0, duration: 0.35 })
      .to(counter, { opacity: 0, duration: 0.2 }, '<')
      .fromTo($('.tripstage', sec), { opacity: 0, y: 30 }, { opacity: 1, y: 0, duration: 0.4 })
    drive(tl, fn, '>', 3.2)
    tl.set(counter, { textContent: '1 sentence · 2s', color: '#1d7a3a', top: 'calc(11vh + 96px)' }, '-=.4')
      .to(counter, { opacity: 1, duration: 0.2 }, '<')
      .to({}, { duration: 0.6 })
  })
  mm.add(PHONE, () => {
    const sec = $('#trip'), steps = $$('.step', sec), counter = $('.counter', sec)
    const secs = [3, 8, 17, 41, 58, 60], c = { s: 0, t: 0 }
    const tl = gsap.timeline({ scrollTrigger: { trigger: '#trip .path', start: 'top 75%' } })
    steps.forEach((st, i) => {
      tl.fromTo(st, { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.18, ease: 'power3.out' }, i ? '>+.04' : 0)
        .to(c, { s: i + 1, t: secs[i], duration: 0.18, ease: 'none', onUpdate: () => (counter.textContent = `${Math.round(c.s)} steps · ${Math.round(c.t)}s`) }, '<')
    })
    tl.fromTo($('.again', sec), { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.4 })
    const loop = gsap.to({}, { duration: 12, repeat: -1, ease: 'none', paused: true, onUpdate() { fn(this.progress()) } })
    const st = ScrollTrigger.create({ trigger: '#trip .tripstage', start: 'top 85%', end: 'bottom 15%', onToggle: (s) => (s.isActive ? loop.play() : loop.pause()) })
    return () => { loop.kill(); st.kill(); tl.kill() }
  })
}

// ── 2b · EVERYWHERE ───────────────────────────────────────────────────────────
{
  const names = $$('.applist span')
  const { fn } = scene('everywhere', apps(['mail'], ['figma'], ['hn'], ['slackThread'], ['finder']), [
    [0.00, { app: 'mail', i: 0 }],
    [0.02, { key: 'fn', say: "Thursday works, I'll send the final copy tonight.", pill: 'pill-fn-rec', speak: true }],
    [0.12, { pill: 'pill-fn-proc', speak: false }],
    [0.15, { pill: 'pill-fn-out', typed: "Thursday works, I'll send the final copy tonight." }],
    [0.19, { pill: null, app: 'figma', i: 1, key: 'right ⌥', say: 'turn this frame into a React component', typed: '' }],
    [0.21, { pill: 'pill-ropt-rec', speak: true }],
    [0.31, { pill: 'pill-ropt-proc', speak: false }],
    [0.34, { pill: null, notch: 'bar-working1' }],
    [0.40, { app: 'hn', i: 2, key: 'right ⌘ ×2', say: 'save this — useful for our team plan pricing', pill: 'pill-agent-rec', speak: true, notch: 'bar-agent-listening' }],
    [0.50, { pill: 'pill-agent-proc', speak: false, notch: 'bar-agent-thinking' }],
    [0.54, { pill: null, notch: 'bar-agent-done' }],
    [0.60, { app: 'slackThread', i: 3, key: 'right ⌥', say: 'go through this thread and turn it into tasks', pill: 'pill-ropt-rec', speak: true, notch: 'bar-working1' }],
    [0.70, { pill: 'pill-ropt-proc', speak: false }],
    [0.74, { pill: null, notch: 'bar-working4' }],
    [0.80, { app: 'finder', i: 4, key: 'right ⌥', say: 'rename these screenshots by date', pill: 'pill-ropt-rec', speak: true }],
    [0.90, { pill: 'pill-ropt-proc', speak: false }],
    [0.94, { pill: null, notch: 'bar-working4' }],
  ], { zoom: 0.6, apply: (s) => names.forEach((n, j) => n.classList.toggle('on', j === s.i)) })
  scenePlay('#everywhere', 3600, fn, 18)
}

// ── 3 · KEYS ─────────────────────────────────────────────────────────────────
pinned('#keys', 2200, (tl, sec) => {
  const keys = $$('.bigkey', sec), ds = $$('.keydesc p', sec)
  tl.from(keys, { y: 30, opacity: 0, stagger: 0.1, duration: 0.4 })
  keys.forEach((k, i) => {
    tl.to(keys, { opacity: (j) => (j === i ? 1 : 0.45), duration: 0.2 })
      .to(k, { y: 5, boxShadow: '0 1px 0 #d2d2d8', backgroundColor: '#111113', color: '#fff', duration: 0.25 }, '<')
      .fromTo(ds[i], { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: 0.3 }, '<')
      .to({}, { duration: 0.5 })
      .to(k, { y: 0, boxShadow: '0 6px 0 #d2d2d8', backgroundColor: '#fff', color: '#aaa', duration: 0.25 })
      .to(ds[i], { opacity: 0, y: -14, duration: 0.25 }, '<')
  })
  tl.to(keys, { opacity: 1, duration: 0.2 })
})

// ── 4 · START ANYTHING ───────────────────────────────────────────────────────
{
  const { fn } = scene('start', apps(['finder', LOW], ['hn', LOW], ['docs', LOW]), [
    [0.00, { app: 'finder' }], [0.10, { app: 'hn' }], [0.20, { app: 'docs' }],
    [0.26, { key: 'right ⌥', say: 'build a landing page for the pricing launch', pill: 'pill-ropt-rec', speak: true }],
    [0.42, { pill: 'pill-ropt-proc', speak: false }],
    [0.48, { pill: null, notch: 'bar-sending' }],
    [0.54, { notch: 'task-1' }], [0.66, { notch: 'task-2' }], [0.78, { notch: 'task-3' }], [0.88, { notch: 'task-4' }],
  ])
  scenePlay('#chStart', 2600, fn, 14)
}

// ── 5 · POCKET ───────────────────────────────────────────────────────────────
{
  const { fn } = scene('pocket', apps(['code', 'top:200px']), [
    [0.00, { app: 'code', notch: 'bar-working1' }],
    [0.10, { notch: 'pocket-closed' }],
    [0.22, { notch: 'pocket-open-landing' }],
    [0.34, { notch: 'pocket-open-auth' }],
    [0.46, { key: 'fn', say: 'no — retry once, then surface the error', notch: 'pocket-aimed', pill: 'pocket-aimed', speak: true }],
    [0.70, { pill: null, speak: false, notch: 'pocket-sent' }],
    [0.84, { notch: 'pocket-open-csv' }],
  ])
  scenePlay('#chPocket', 2600, fn, 14)
}

// ── 6 · CAPTURE + SCRATCHPAD ──────────────────────────────────────────────────
{
  const { stage, fn } = scene('capture', apps(['settings', 'top:120px']), [
    [0.00, { app: 'settings' }],
    [0.04, { key: 'right ⌥', say: 'this button is supposed to save. nothing happens —', pill: 'pill-ropt-rec', speak: true, box: 0 }],
    [0.13, { key: 'left ⌘ (hold)', say: 'drag a box around it…', box: 1 }],
    [0.19, { pill: 'pill-flash', box: 2 }],
    [0.21, { pill: 'pill-ropt-rec', say: '— see the greyed-out state.' }],
    [0.28, { pill: 'pill-ropt-proc', speak: false }],
    [0.31, { pill: null, notch: 'bar-working1', key: '', say: '' }],
    [0.37, { notch: null, pill: 'pill-scratch-rec', key: 'fn', say: 'arm the scratchpad', speak: true }],
    [0.43, { pill: 'pad-1', say: 'no null check here before the token is refreshed' }],
    [0.51, { pill: 'pad-2', speak: false, key: '', say: '(keep reading…)' }],
    [0.57, { pill: 'pad-3', key: 'fn', say: "also, where's the retry limit?", speak: true }],
    [0.64, { pill: 'pad-4', speak: false, key: 'left ⌘ ×2', say: 'screenshot joins the pad' }],
    [0.71, { pill: 'pad-5', key: 'fn', say: 'and the error path swallows the 401', speak: true }],
    [0.79, { pill: 'pill-paused', speak: false, key: '', say: 'pause as long as you want' }],
    [0.86, { pill: 'pad-sending', say: 'Add to auth service' }],
    [0.93, { pill: null, notch: 'bar-sending', say: '' }],
    [0.97, { notch: 'bar-working1' }],
  ], {
    html: '<div class="selbox" style="left:312px;top:392px;width:0;height:0"></div>',
    apply(s, idx, st) {
      const b = $('.selbox', st.host)
      gsap.to(b, { opacity: s.box === 1 ? 1 : 0, width: s.box >= 1 ? 250 : 0, height: s.box >= 1 ? 76 : 0, duration: s.box === 1 ? 0.5 : 0.2, ease: 'power1.inOut' })
    },
  })
  scenePlay('#chCapture', 4200, fn, 22)
}

// ── 7 · AGENT ────────────────────────────────────────────────────────────────
{
  const { fn } = scene('agent', apps(['youtube', LOW], ['inbox', LOW], ['finder', LOW]), [
    [0.00, { app: 'youtube' }],
    [0.05, { key: 'right ⌘ ×2', say: 'save this — good example of onboarding, for the redesign', pill: 'pill-agent-rec', speak: true }],
    [0.17, { pill: 'pill-agent-proc', speak: false }],
    [0.21, { pill: null, notch: 'agent-save-1' }],
    [0.27, { notch: 'agent-save-2' }],
    [0.36, { notch: null, later: true, key: '', say: '' }],
    [0.43, { later: false, app: 'inbox' }],
    [0.46, { key: 'right ⌘ ×2', say: 'what was that onboarding video I saved?', pill: 'pill-agent-rec', speak: true }],
    [0.56, { pill: 'pill-agent-proc', speak: false }],
    [0.60, { pill: null, notch: 'agent-ask-1' }],
    [0.66, { notch: 'agent-ask-2' }],
    [0.76, { notch: null, app: 'finder', key: 'right ⌘ ×2', say: 'continue the landing page from Monday', pill: 'pill-agent-rec', speak: true }],
    [0.86, { pill: 'pill-agent-proc', speak: false, notch: 'bar-agent-searching' }],
    [0.91, { pill: null, notch: 'bar-inpocket' }],
  ], {
    html: '<div class="later">Two weeks later</div>',
    apply(s, idx, st) { gsap.to($('.later', st.host), { opacity: s.later ? 1 : 0, duration: 0.3 }) },
  })
  scenePlay('#chAgent', 3600, fn, 20)
}

// ── 8 · MEETINGS ─────────────────────────────────────────────────────────────
{
  const nt = `<div class="nt rec">
    <span class="row rec"><span class="wave">${'<div></div>'.repeat(11)}</span></span>
    <span class="row dis"><span style="width:30px;display:grid;place-items:center;color:rgba(255,255,255,.55)"><svg width="10" height="10" viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg></span>
      <span style="display:flex;gap:6px;align-items:center;padding-right:12px"><span style="width:9px;height:9px;border-radius:2px;background:#6fbf9a;box-shadow:0 0 0 1px rgba(255,255,255,.18)"></span>End</span>
      <span style="width:1px;height:16px;background:rgba(255,255,255,.16)"></span>
      <span style="display:flex;gap:6px;align-items:center;padding:0 13px 0 12px;color:#c4482e"><svg width="11" height="11" viewBox="0 0 24 24" fill="none"><path d="M5 7h14M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m-8 0 1 12a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1l1-12" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>Discard</span></span>
    <span class="row ok" style="gap:7px"><span style="display:flex;gap:2px;align-items:center"><span style="width:2px;height:7px;border-radius:9px;background:#6fbf9a;opacity:.55"></span><span style="width:2px;height:13px;border-radius:9px;background:#6fbf9a"></span><span style="width:2px;height:9px;border-radius:9px;background:#6fbf9a;opacity:.75"></span></span><svg width="13" height="13" viewBox="0 0 24 24" fill="none" style="color:#6fbf9a"><path d="M5 12.5l4.2 4.1L19.5 6.8" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>Saved — preparing notes</span>
  </div>`
  const { stage, fn } = scene('meet', apps(['call', LOW], ['inbox', LOW]), [
    [0.00, { app: 'call', nt: 'rec', say: '', key: '', cam: { x: 150, y: 779, z: 1.7, ay: 0.72 } }],
    [0.16, { nt: 'discard', key: 'click', say: 'the call wraps up — End' }],
    [0.24, { nt: 'done', say: '' , key: ''}],
    [0.31, { nt: null, app: 'inbox', cam: null }],
    [0.35, { key: 'right ⌘ ×2', say: 'any follow-ups for me from that call?', pill: 'pill-agent-rec', speak: true }],
    [0.46, { pill: 'pill-agent-proc', speak: false }],
    [0.50, { pill: null, notch: 'agent-meet-1' }],
    [0.58, { notch: 'agent-meet-2' }],
    [0.70, { key: 'right ⌘ ×2', say: 'start a task for the first one', pill: 'pill-agent-rec', speak: true }],
    [0.79, { pill: 'pill-agent-proc', speak: false }],
    [0.83, { pill: null, notch: 'agent-meet-3' }],
    [0.93, { notch: 'bar-working1' }],
  ], {
    html: nt,
    apply(s, idx, st) {
      const el = $('.nt', st.host)
      el.className = 'nt ' + (s.nt || 'rec')
      el.style.opacity = s.nt ? 1 : 0
      st.ntLive = s.nt === 'rec'
    },
  })
  // The widget's bars: same instrument as the dictation pill (NotetakerWidget.tsx).
  const bars = $$('.nt .wave div', stage.host)
  gsap.ticker.add((t) => {
    if (!stage.ntLive) return bars.forEach((b) => (b.style.height = '3px'))
    bars.forEach((b, i) => { const v = Math.max(0, Math.sin(t * 6 + i * 1.7) * 0.5 + Math.sin(t * 11 + i) * 0.3) * (0.5 + 0.5 * Math.sin(t * 1.3)); b.style.height = 3 + Math.round(v * 13) + 'px' })
  })
  scenePlay('#chMeet', 3400, fn, 20)
}

// ── 9 · DICTATION — autoplay when in view ────────────────────────────────────
{
  const { fn } = scene('dictate', apps(['mail'], ['notes'], ['terminal']), [
    [0.00, { app: 'mail', typed: '' }],
    [0.04, { key: 'fn', say: "Hey Priya, Thursday works. I'll send the final copy tonight.", pill: 'pill-fn-rec', speak: true }],
    [0.22, { pill: 'pill-fn-proc', speak: false }],
    [0.26, { pill: 'pill-fn-out', typed: "Hey Priya, Thursday works. I'll send the final copy tonight." }],
    [0.31, { pill: null, app: 'notes', typed: '' }],
    [0.35, { say: 'pricing: test annual-first on the team plan', pill: 'pill-fn-rec', speak: true }],
    [0.53, { pill: 'pill-fn-proc', speak: false }],
    [0.57, { pill: 'pill-fn-out', typed: 'pricing: test annual-first on the team plan' }],
    [0.62, { pill: null, app: 'terminal', typed: '' }],
    [0.66, { say: 'refactor the auth middleware and keep the public API the same', pill: 'pill-fn-rec', speak: true }],
    [0.84, { pill: 'pill-fn-proc', speak: false }],
    [0.88, { pill: 'pill-fn-out', typed: 'refactor the auth middleware and keep the public API the same' }],
    [0.94, { pill: null }],
  ])
  const loop = gsap.to({}, { duration: 16, repeat: -1, ease: 'none', paused: true, onUpdate() { fn(this.progress()) } })
  ScrollTrigger.create({ trigger: '#dictate', start: 'top 75%', end: 'bottom top', onToggle: (s) => (s.isActive ? loop.play() : loop.pause()) })
}

// ── 10–12 ────────────────────────────────────────────────────────────────────
gsap.timeline({ scrollTrigger: { trigger: '#layer', start: 'top 70%', end: 'center 40%', scrub: 0.8 } })
  .fromTo('.layer.ai', { z: 0 }, { z: 70 })
  .fromTo('.layer.um', { z: 0, opacity: 0.3 }, { z: 150, opacity: 1 }, '<')
  .fromTo('.layers', { rotateZ: -20 }, { rotateZ: -38 }, '<')
gsap.from('.price', { scrollTrigger: { trigger: '.pricing', start: 'top 80%' }, y: 40, opacity: 0, stagger: 0.12, duration: 0.7, ease: 'power3.out' })
gsap.from(splitWords($('#closeH')), { scrollTrigger: { trigger: '#close', start: 'top 80%', end: 'center center', scrub: 0.8 }, y: 120, opacity: 0, stagger: 0.15 })
