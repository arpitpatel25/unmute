import { Stage, track, ready } from './ui/stage.js?v=20261003-v17'

const $ = (s, r = document) => r.querySelector(s)
const $$ = (s, r = document) => [...r.querySelectorAll(s)]
const motionPreference = matchMedia('(prefers-reduced-motion: reduce)')
const reduce = motionPreference.matches
let motionPaused = reduce
const scenes = []
function syncMotion() {
  document.body.classList.toggle('motion-paused', motionPaused)
  for (const item of scenes) {
    item.stage.paused = motionPaused
    if (!motionPaused && item.inView && !document.hidden) item.loop.play()
    else item.loop.pause()
  }
  const button = $('.rot-pause')
  button.textContent = motionPaused ? 'Play demos' : 'Pause demos'
  button.setAttribute('aria-label', motionPaused ? 'Play all demos' : 'Pause all demos')
}

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

const apps = (...list) => list.map(([k, s]) => APPS[k](s || '')).join('')

const NT_HTML = `<div class="nt rec">
    <span class="row rec"><span class="wave">${'<div></div>'.repeat(11)}</span></span>
    <span class="row dis"><span style="width:30px;display:grid;place-items:center;color:rgba(255,255,255,.55)"><svg width="10" height="10" viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg></span>
      <span style="display:flex;gap:6px;align-items:center;padding-right:12px"><span style="width:9px;height:9px;border-radius:2px;background:#6fbf9a;box-shadow:0 0 0 1px rgba(255,255,255,.18)"></span>End</span>
      <span style="width:1px;height:16px;background:rgba(255,255,255,.16)"></span>
      <span style="display:flex;gap:6px;align-items:center;padding:0 13px 0 12px;color:#c4482e"><svg width="11" height="11" viewBox="0 0 24 24" fill="none"><path d="M5 7h14M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m-8 0 1 12a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1l1-12" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>Discard</span></span>
    <span class="row ok" style="gap:7px"><span style="display:flex;gap:2px;align-items:center"><span style="width:2px;height:7px;border-radius:9px;background:#6fbf9a;opacity:.55"></span><span style="width:2px;height:13px;border-radius:9px;background:#6fbf9a"></span><span style="width:2px;height:9px;border-radius:9px;background:#6fbf9a;opacity:.75"></span></span><svg width="13" height="13" viewBox="0 0 24 24" fill="none" style="color:#6fbf9a"><path d="M5 12.5l4.2 4.1L19.5 6.8" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>Saved — preparing notes</span>
  </div>`

// The Notetaker pill (NotetakerWidget.tsx, ported as-is): recording → End/Discard → saved.
function ntApply(s, st) {
  const el = $('.nt', st.host); if (!el) return
  el.className = 'nt ' + (s.nt || 'rec')
  el.style.opacity = s.nt ? 1 : 0
  st.ntLive = s.nt === 'rec'
}
function ntBars(stage) {
  const bars = $$('.nt .wave div', stage.host)
  gsap.ticker.add((t) => {
    if (stage.paused || !stage.visible || !stage.ntLive) return bars.forEach((b) => (b.style.height = '3px'))
    bars.forEach((b, i) => { const v = Math.max(0, Math.sin(t * 6 + i * 1.7) * 0.5 + Math.sin(t * 11 + i) * 0.3) * (0.5 + 0.5 * Math.sin(t * 1.3)); b.style.height = 3 + Math.round(v * 13) + 'px' })
  })
}

// ── Scenes ────────────────────────────────────────────────────────────────────
// A scene's keys are in SECONDS; the loop length is the last key + a rest.
// Each section shows ONE idea (one or two beats). The hero is the only
// multi-beat loop, and its rotating headline follows the beat on screen.
const NOTCH = [720, 17], SLACK = [720, 661], MAIL = [560, 285], NOTES = [520, 235]
const PANEL = [720, 200], PANEL_L = [720, 426], POCKET = [720, 58], POCKET_L = [720, 128]
const NT = { x: 150, y: 779, z: 1.7, ay: 0.72 }
const PILL_HOME = { x: 720, y: 640, z: 1.35, ay: 0.62 }   // framed on where the pill will appear
const TOP_HOME = { x: 720, y: 0, z: 1.25, ay: 0 }

function said(el, key, text) {
  if (!el) return
  el.innerHTML = text ? `${key ? `<kbd>${key}</kbd> ` : ''}${text}` : ''
}
function typed(stage, text) { $$('.compose, .typed', stage.host).forEach((e) => { e.textContent = text || '' }) }

function scene(name, appHtml, secKeys, opts = {}) {
  const host = $(`[data-stage="${name}"]`)
  const stage = new Stage(host, { apps: appHtml, zoom: opts.zoom, home: opts.home, desktopView: opts.desktopView, mobileZoom: opts.mobileZoom, camera: false, fullScreen: true })
  if (opts.html) stage.extra().innerHTML = opts.html
  const total = opts.length ?? secKeys[secKeys.length - 1][0] + 2.2
  const keys = secKeys.map(([t, k]) => [t / total, k])
  const sayEl = $(`[data-said="${name}"]`)
  let lastNote = null, lastLand = -1
  const fn = track(stage, keys, {
    apply(s, idx) {
      stage.voice(s.key, s.say, !!s.speak)
      const note = `${s.noteKey || ''}|${s.note || ''}`
      if (note !== lastNote) { said(sayEl, s.noteKey, s.note); lastNote = note }
      const d = keys[idx]?.[1].done
      if (d && idx !== lastLand) stage.land(...d)
      lastLand = d ? idx : (idx < lastLand ? -1 : lastLand)
      typed(stage, s.typed)
      opts.apply?.(s, idx, stage)
    },
  })
  // Loops while on screen, pauses off screen. Reduced motion: hold the
  // scene's clearest frame (opts.still) instead of playing.
  const loop = gsap.to({}, { duration: total, repeat: -1, ease: 'none', paused: true, onUpdate() { fn(this.progress()) } })
  const initial = reduce ? (opts.still ?? total * 0.6) / total : 0
  loop.progress(initial).pause()
  fn(initial)
  const item = { stage, loop, fn, total, keys, inView: false }
  scenes.push(item)
  new IntersectionObserver(([entry]) => {
    item.inView = entry.isIntersecting
    syncMotion()
  }, { threshold: 0.05 }).observe(host)
  syncMotion()
  return item
}

await ready
const updateNav = () => $('nav.top').classList.toggle('scrolled', scrollY > 48)
addEventListener('scroll', updateNav, { passive: true })
updateNav()

// ── HERO: a calm overview, with a fixed view of the entire Mac screen. ──────
{
  const starts = [0, 5.5, 11, 16.5, 21.5, 27, 32.5, 37.5]
  const examples = [
    'Start a Claude Code session from the app you’re using.',
    'Start a Codex session with a spoken instruction.',
    'Attach a screenshot while you explain the problem.',
    'Dictate a reply directly into Mail.',
    'Send a follow-up to an existing agent session.',
    'Find a session from last week with Unmute Agent.',
    'Capture a meeting and turn it into notes.',
    'Dictate directly into Notes.'
  ]
  const hero = scene('hero', apps(['slack'], ['docs'], ['code'], ['settings'], ['mail'], ['figma'], ['finder'], ['call'], ['notes']), [
    [0.0, { app: 'docs', w: 0, key: 'right ⌥', say: 'build a first version of the new onboarding flow', pill: 'pill-ropt-rec', speak: true }],
    [2.9, { pill: 'pill-ropt-proc', speak: false }],
    [3.3, { pill: null, notch: 'bar-sending' }],
    [3.7, { notch: 'bar-working1', done: ['Claude Code session started', NOTCH] }],
    [5.5, { app: 'code', w: 2 }],
    [5.7, { key: 'right ⌥', say: 'add tests for the signup form', pill: 'pill-codex-rec', speak: true }],
    [7.9, { pill: 'pill-codex-proc', speak: false }],
    [8.3, { pill: null, notch: 'bar-sending' }],
    [8.7, { notch: 'bar-working2', done: ['Codex session started', NOTCH] }],
    [11.0, { app: 'settings', w: 3 }],
    [11.2, { key: 'right ⌥', say: 'fix this — the save button does nothing', pill: 'pill-ropt-rec', speak: true }],
    [12.9, { pill: 'pill-flash', noteKey: 'left ⌘', note: 'a screenshot, mid-sentence' }],
    [13.2, { pill: 'pill-ropt-rec' }],
    [13.9, { pill: 'pill-ropt-proc', speak: false, note: '' }],
    [14.3, { pill: null, notch: 'bar-sending' }],
    [14.7, { notch: 'bar-working3', done: ['session started, screenshot attached', NOTCH] }],
    [16.5, { app: 'mail', w: 4 }],
    [16.7, { key: 'fn', say: "Thanks Priya — Thursday works. I'll send the final copy tonight.", pill: 'pill-fn-rec', speak: true }],
    [19.3, { pill: 'pill-fn-proc', speak: false }],
    [19.7, { pill: 'pill-fn-out', typed: "Thanks Priya — Thursday works. I'll send the final copy tonight.", done: ['typed into Mail', MAIL] }],
    [20.4, { pill: null }],
    [21.5, { app: 'figma', w: 5, typed: '', notch: 'pocket-onb-open' }],
    [22.3, { key: 'fn', say: 'make the signup step shorter', notch: 'pocket-onb-aimed', pill: 'pocket-onb-aimed', speak: true }],
    [24.4, { pill: null, speak: false, notch: 'pocket-onb-sent', done: ['sent to Onboarding flow', POCKET, POCKET_L] }],
    [26.0, { notch: 'bar-working3' }],
    [27.0, { app: 'finder', w: 6 }],
    [27.2, { key: 'right ⌘ ×2', say: 'find the pricing session from last week', pill: 'pill-agent-rec', speak: true, notch: 'bar-agent-listening' }],
    [29.5, { pill: 'pill-agent-proc', speak: false, notch: 'bar-agent-searching' }],
    [30.1, { pill: null, notch: 'bar-inpocket-pricing', done: ['found it, back in your pocket', NOTCH] }],
    [32.5, { app: 'call', w: 7, notch: 'bar-working3', nt: 'rec', noteKey: '', note: 'the notetaker is listening', cam: NT }],
    [34.3, { nt: 'discard', noteKey: 'click', note: 'End' }],
    [35.0, { nt: 'done', noteKey: '', note: '', done: ['notes written by your own Claude', [150, 761], [260, 700]] }],
    [37.0, { nt: null, cam: null }],
    [37.5, { app: 'notes', w: 8 }],
    [37.7, { key: 'fn', say: 'pricing: test annual-first on the team plan', pill: 'pill-fn-rec', speak: true }],
    [39.9, { pill: 'pill-fn-proc', speak: false }],
    [40.3, { pill: 'pill-fn-out', typed: 'pricing: test annual-first on the team plan', done: ['typed into Notes', NOTES] }],
    [41.0, { pill: null }],
  ], { length: 42.5, still: 1.2, html: NT_HTML, apply(s, idx, st) { const label = $('.hero-example')
    const example = Math.max(0, (s.w ?? 1) - 1)
    if (label.dataset.example !== String(example)) {
      label.dataset.example = example
      label.textContent = examples[example]
      clearTimeout(st.resultT); clearTimeout(st.resultRevealT)
      $('.result', st.host).classList.remove('on')
    }
    ntApply(s, st) } })
  // Each example gets about 6–7 seconds, with time to read the request and result.
  hero.loop.timeScale(0.8)
  hero.stage.playbackRate = 0.8
  ntBars(hero.stage)
  // Pause and next controls remain available for the product demonstration.
  const pause = $('.rot-pause'), next = $('.rot-next')
  pause.onclick = () => { motionPaused = !motionPaused; syncMotion() }
  next.onclick = () => {
    const now = hero.loop.progress() * hero.total
    const t = starts.find((s) => s > now + 0.05) ?? 0
    hero.loop.progress(t / hero.total); hero.fn(t / hero.total)
    if (motionPaused) { hero.loop.progress((t + 1) / hero.total); hero.fn((t + 1) / hero.total) }
    syncMotion()
  }
  syncMotion()
}

// ── WHY: the ceremony fades out; one spoken sentence replaces it ─────────────
{
  const ceremonyObserver = new IntersectionObserver(([entry]) => {
    if (!entry.isIntersecting) return
    if (!reduce) setTimeout(() => $('.ceremony').classList.add('faded'), 900)
    ceremonyObserver.disconnect()
  }, { threshold: 0.3 })
  ceremonyObserver.observe($('.ceremony'))
  scene('why', apps(['docs']), [
    [0.0, { app: 'docs' }],
    [0.6, { key: 'right ⌥', say: 'build a first version of the new onboarding flow', pill: 'pill-ropt-rec', speak: true }],
    [3.3, { pill: 'pill-ropt-proc', speak: false }],
    [3.7, { pill: null, notch: 'bar-sending' }],
    [4.2, { notch: 'onb-1', done: ['Claude Code session started', PANEL, PANEL_L] }],
    [6.0, { notch: 'onb-2' }],
    [7.4, { notch: 'onb-3' }],
  ], { home: PILL_HOME, still: 5 })
}

// ── START OR CONTINUE: a new session, then a follow-up without opening it ────
scene('start', apps(['hn'], ['figma']), [
  [0.0, { app: 'hn' }],
  [0.5, { key: 'right ⌥', say: 'build a first version of the new onboarding flow', pill: 'pill-ropt-rec', speak: true }],
  [3.2, { pill: 'pill-ropt-proc', speak: false }],
  [3.6, { pill: null, notch: 'bar-sending' }],
  [4.0, { notch: 'onb-1', done: ['new agent session started', PANEL, PANEL_L] }],
  [5.6, { notch: 'onb-3' }],
  [7.6, { notch: 'bar-working1', app: 'figma', noteKey: '', note: 'later, in another app' }],
  [8.8, { notch: 'pocket-onb-open', note: 'flip to the session in the notch' }],
  [9.8, { key: 'fn', say: 'make the signup step shorter', notch: 'pocket-onb-aimed', pill: 'pocket-onb-aimed', speak: true, note: '' }],
  [12.0, { pill: null, speak: false, notch: 'pocket-onb-sent', done: ['follow-up sent, nothing opened', POCKET, POCKET_L] }],
], { home: PILL_HOME, still: 4.6 })

// ── CAPTURE CONTEXT: words and a screenshot arrive together ──────────────────
scene('capture', apps(['settings', 'top:120px']), [
  [0.0, { app: 'settings', box: 0 }],
  [0.5, { key: 'right ⌥', say: "fix this error — here's what I was trying to do", pill: 'pill-ropt-rec', speak: true }],
  [2.0, { noteKey: 'left ⌘ (hold)', note: 'drag a box around it', box: 1 }],
  [3.1, { pill: 'pill-flash', box: 2 }],
  [3.4, { pill: 'pill-ropt-rec', noteKey: '', note: 'the screenshot rides along with your words' }],
  [4.6, { pill: 'pill-ropt-proc', speak: false }],
  [5.0, { pill: null, notch: 'bar-sending', note: '' }],
  [5.4, { notch: 'bar-working1', done: ['session started, screenshot attached', NOTCH] }],
], {
  home: { x: 640, y: 560, z: 1.25, ay: 0.55 }, still: 3.2,
  html: '<div class="selbox" style="left:312px;top:392px;width:0;height:0"></div>',
  apply(s, idx, st) {
    const b = $('.selbox', st.host)
    gsap.to(b, { opacity: s.box === 1 ? 1 : 0, width: s.box >= 1 ? 250 : 0, height: s.box >= 1 ? 76 : 0, duration: s.box === 1 ? 0.5 : 0.2, ease: 'power1.inOut' })
  },
})

// ── UNMUTE AGENT: find past work from what you remember ──────────────────────
scene('agent', apps(['inbox', 'top:440px;left:120px;width:1200px;height:400px']), [
  [0.0, { app: 'inbox' }],
  [0.5, { key: 'right ⌘ ×2', say: 'pick up the onboarding work from yesterday. use what we decided in the meeting', pill: 'pill-agent-rec', speak: true }],
  [3.6, { pill: 'pill-agent-proc', speak: false }],
  [4.0, { pill: null, notch: 'agent-recall-1' }],
  [5.4, { notch: 'agent-recall-2', done: ['found the session and the meeting notes', PANEL, PANEL_L] }],
  [9.0, { notch: 'bar-inpocket-onb', done: ['back in your pocket, ready to continue', NOTCH] }],
], { home: PILL_HOME, still: 6.5 })

// ── THE TASK COMES TO YOU: the notch opens by itself; answer by voice ────────
scene('attention', apps(['figma', 'top:440px;left:120px;width:1200px;height:400px']), [
  [0.0, { app: 'figma', notch: 'bar-working1', noteKey: '', note: "you're in Figma; the session runs" }],
  [1.8, { notch: 'onb-ask', note: 'it needs you — the notch opens on its own' }],
  [3.6, { key: 'right ⌥', say: 'move it after the first project', notch: 'onb-ask-aimed', pill: 'onb-ask-aimed', speak: true, note: '' }],
  [5.8, { pill: null, speak: false, notch: 'onb-continue', done: ['answered — the agent carries on', PANEL, PANEL_L] }],
  [8.4, { notch: 'bar-working1', note: 'and you carry on too' }],
], { home: TOP_HOME, still: 2.6 })

// ── MEETING NOTES: notes, then the decisions go where they belong ────────────
{
  const m = scene('meet', apps(['call', 'top:440px;left:120px;width:1200px;height:400px'], ['inbox', 'top:440px;left:120px;width:1200px;height:400px']), [
    [0.0, { app: 'call', nt: 'rec', noteKey: '', note: 'the notetaker is listening', cam: NT }],
    [1.8, { nt: 'discard', noteKey: 'click', note: 'End' }],
    [2.5, { nt: 'done', noteKey: '', note: '', done: ['notes written by your own Claude', [150, 761], [260, 700]] }],
    [4.3, { nt: null, cam: null, app: 'inbox' }],
    [4.6, { key: 'right ⌘ ×2', say: 'take the decisions from that call into the onboarding session', pill: 'pill-agent-rec', speak: true }],
    [7.4, { pill: 'pill-agent-proc', speak: false }],
    [7.8, { pill: null, notch: 'agent-meetonb-2', done: ['decisions added to Onboarding flow', PANEL, PANEL_L] }],
  ], { html: NT_HTML, home: PILL_HOME, still: 8.6, apply: (s, idx, st) => ntApply(s, st) })
  ntBars(m.stage)
}

// ── DICTATION ────────────────────────────────────────────────────────────────
scene('dictate', apps(['slack']), [
  [0.0, { app: 'slack', typed: '' }],
  [0.5, { key: 'fn', say: "I've reviewed the plan. Let's start with the simpler onboarding flow.", pill: 'pill-fn-rec', speak: true }],
  [3.4, { pill: 'pill-fn-proc', speak: false }],
  [3.8, { pill: 'pill-fn-out', typed: "I've reviewed the plan. Let's start with the simpler onboarding flow.", done: ['your words, at your cursor', SLACK] }],
  [4.6, { pill: null }],
], { home: PILL_HOME, still: 4.2 })

// Pause every demo together, including when a section re-enters the viewport.
document.addEventListener('visibilitychange', syncMotion)
motionPreference.addEventListener('change', (event) => { motionPaused = event.matches; syncMotion() })
syncMotion()

// Stage dimensions become known after the manifest loads. Restore a requested
// section anchor after that layout, so deep links land on the correct section.
requestAnimationFrame(() => {
  const target = location.hash && document.getElementById(location.hash.slice(1))
  if (target) target.scrollIntoView({ behavior: 'instant', block: 'start' })
})
