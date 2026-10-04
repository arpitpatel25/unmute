import { Film, SHOT, ready } from './ui/film.js?v=20261004-mac3'

const $ = (s, r = document) => r.querySelector(s)
const $$ = (s, r = document) => [...r.querySelectorAll(s)]
const motionPreference = matchMedia('(prefers-reduced-motion: reduce)')
const reduce = motionPreference.matches
let motionPaused = reduce
const films = []
function syncMotion() {
  document.body.classList.toggle('motion-paused', motionPaused)
  for (const item of films) {
    item.film.stage.paused = motionPaused
    if (!motionPaused && item.inView && !document.hidden) item.film.tl.play()
    else item.film.tl.pause()
  }
  const button = $('.rot-pause')
  if (!button) return
  button.textContent = motionPaused ? 'Play demos' : 'Pause demos'
  button.setAttribute('aria-label', motionPaused ? 'Play all demos' : 'Pause all demos')
}

// ── The user's own apps: plain stand-ins, never unmute UI ─────────────────────
// Each one shows the reason you're about to speak: the request comes from what's
// on screen, so a visitor can follow the thought without reading the copy.
const W = (app, title, body, style = '', cls = '') =>
  `<div class="app ${cls}" data-app="${app}" data-title="${title.split(' — ')[0]}" style="${style}"><div class="bar"><i></i><i></i><i></i><span>${title}</span></div><div class="win">${body}</div></div>`
const msg = (who, text, av = '', when = '') => `<div class="msg"><div class="av ${av}">${who[0]}</div><div><b>${who}</b><small>${when}</small><br/>${text}</div></div>`
const APPS = {
  slack: (s) => W('slack', 'Slack — #launch', `<div class="slack"><aside><b>Acme</b><p># general</p><p class="on"># launch</p><p># design</p><p># eng</p><p>● Priya</p><p>● Sam</p></aside><main><header># launch</header>${msg('Priya', 'Can we get a first version of the <mark>new onboarding flow</mark> by Friday? Designs are in Figma.', 'p', '9:32 AM')}${msg('Sam', '+1, the current one loses half our signups 😬', '', '9:35 AM')}<div class="compose" data-ph="Message #launch"></div></main></div>`, s),
  figma: (s) => W('figma', 'Figma — Onboarding', `<div class="figma"><div class="tools"><i></i><i></i><i></i><span>Onboarding / v3</span></div><div class="body"><aside>Layers<p>Welcome</p><p class="on">Set up your team</p><p>Your first project</p></aside><div class="canvas"><div class="frame"><small>1</small><b>Welcome</b><i></i><i></i></div><div class="frame"><small>2</small><b>Set up your team</b><i></i><i></i></div><div class="frame"><small>3</small><b>Your first project</b><i></i><i></i></div></div></div></div>`, s),
  docs: (s) => W('docs', 'Docs — Pricing launch brief', `<div class="doc"><div class="page"><b>Pricing launch — brief</b><p class="doc-line">Launch the new team plan on the 14th.</p><p class="doc-line"><mark>Still needed: a landing page for the launch.</mark></p><div class="skel" style="width:80%;margin-top:18px"></div><div class="skel" style="width:60%"></div></div></div>`, s),
  settings: (s) => W('settings', 'Chrome — Profile settings', `<div class="chrome"><div class="url"><span>localhost:3000/settings</span></div><div class="page"><b>Profile settings</b><div class="field"><span>Name</span><div>Arpit Patel</div></div><div class="field"><span>Email</span><div>arpit@acme.dev</div></div><div class="savebtn">Save changes</div><div class="toast">Nothing happened. Changes not saved.</div></div></div>`, s),
  mail: (s) => W('mail', 'Mail — Re: launch date', `<div class="mail"><aside><p class="on">Inbox</p><p>VIP</p><p>Drafts</p><p>Sent</p></aside><main><div class="hdr">To: Priya &nbsp;·&nbsp; Re: launch date</div><div class="typed"></div><div class="quote">Priya: Does Thursday still work for the launch?</div></main></div>`, s),
  inbox: (s) => W('inbox', 'Mail — Inbox', `<div class="mail"><aside><p class="on">Inbox</p><p>VIP</p><p>Drafts</p><p>Sent</p></aside><main><div class="row on"><b>Priya</b><span>Morning! Where did we land on onboarding yesterday? Can we keep going today?</span></div><div class="row"><b>Sam</b><span>QA notes for the pricing page</span></div><div class="row"><b>Stripe</b><span>Your payout is on its way</span></div></main></div>`, s),
  call: (s) => W('call', 'Meet — Product sync', `<div class="grid"><div>AP</div><div>SM</div><div>PR</div><div>JL</div></div>`, s, 'dark'),
}
// A window further back on every screen, for depth.
const BACK = W('back', 'Notes — Ideas', `<div class="notes"><b>Ideas</b><div class="skel" style="width:85%"></div><div class="skel" style="width:70%"></div><div class="skel" style="width:78%"></div><div class="skel" style="width:52%"></div></div>`, '', 'back')
const apps = (...list) => BACK + list.map(([k, s]) => APPS[k](s || '')).join('')

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

// Framings specific to one demo.
const NT_SHOT = { x: 300, y: 420, z: 1.4, ay: 0.5 }
const WINDOW_LOW = { x: 470, y: 610, z: 1.5, ay: 0.93 }     // a window's lower half plus the pill
const MAIL_TOP = { x: 470, y: 230, z: 1.4, ay: 0.4 }

// Build one demo. `still` is the shot shown, unmoving, under reduced motion.
function film(name, appHtml, shots, opts = {}) {
  const host = $(`[data-stage="${name}"]`)
  const f = new Film(host, { apps: appHtml, html: opts.html, sub: $(`[data-said="${name}"]`), shots })
  if (opts.nt) { f.on((i, s) => ntApply(s, f.stage)); ntApply(f.shots[0], f.stage); ntBars(f.stage) }
  const item = { film: f, inView: false }
  films.push(item)
  if (reduce) f.seek(opts.still ?? 0)
  new IntersectionObserver(([entry]) => {
    item.inView = entry.isIntersecting
    syncMotion()
  }, { threshold: 0.25 }).observe(host)
  return f
}

await ready
const updateNav = () => $('nav.top').classList.toggle('scrolled', scrollY > 48)
addEventListener('scroll', updateNav, { passive: true })
updateNav()

// ── HERO: the whole loop, once, in three chapters ────────────────────────────
// 1. a request arrives in Slack → you say it → a Claude Code session starts
// 2. it works in the notch while you move on to Figma
// 3. it needs a decision → the notch opens where you are → you answer out loud
{
  const hero = film('hero', apps(['slack'], ['figma']), [
    { t: 0, chapter: 0, app: 'slack', cam: SHOT.wide, line: 'Priya needs the onboarding flow by Friday.' },
    { t: 2.2, key: 'hold right ⌥', say: 'build a first version of the new onboarding flow', sayDur: 2.4, pill: 'pill-ropt-rec', speak: true, cam: SHOT.pill },
    { t: 5.2, key: 'hold right ⌥', say: 'build a first version of the new onboarding flow', pill: 'pill-ropt-proc' },
    { t: 5.7, pill: null, notch: 'bar-sending', cam: SHOT.bar, line: 'Sending it to Claude Code…' },
    { t: 6.6, notch: 'onb-1', cam: SHOT.panel, done: 'A new Claude Code session, with your words as the prompt.' },
    { t: 9.8, chapter: 1, notch: 'bar-working1', cam: SHOT.bar, line: 'It works in the notch.' },
    { t: 11.6, app: 'figma', cam: SHOT.wide, line: 'You move on to the designs.' },
    { t: 14.4, chapter: 2, notch: 'onb-ask', cam: SHOT.panel, line: 'It needs a decision, so the notch opens. Right where you are.' },
    { t: 18.0, key: 'hold right ⌥', say: 'move it after the first project', sayDur: 1.6, notch: 'onb-ask-aimed', pill: 'onb-ask-aimed', speak: true },
    { t: 20.4, notch: 'onb-continue', pill: null, done: 'Answered by voice. Claude carries on.' },
    { t: 23.6, notch: 'bar-working1', cam: SHOT.wide, line: 'You never left Figma.', end: 26.5 },
  ], { still: 4 })

  window.__heroStage = hero.stage   // for tools/morph-frames.mjs

  // Chapter buttons: each one shows where the loop is, and jumps there.
  const chapters = $$('.chapters button')
  const starts = [0, 9.8, 14.4], ends = [9.8, 14.4, hero.total]
  chapters.forEach((b, i) => {
    b.onclick = () => {
      hero.seek(hero.shots.findIndex((s) => s.t === starts[i]))
      syncMotion()
    }
  })
  const paint = () => {
    const t = hero.tl.time()
    chapters.forEach((b, i) => {
      const p = Math.min(1, Math.max(0, (t - starts[i]) / (ends[i] - starts[i])))
      b.style.setProperty('--p', t >= ends[i] ? 1 : p)
      b.classList.toggle('on', t >= starts[i] && t < ends[i])
    })
  }
  hero.tl.eventCallback('onUpdate', paint)
  hero.on(paint)
  paint()
  $('.rot-pause').onclick = () => { motionPaused = !motionPaused; syncMotion() }
}

// ── WHY: the thought you'd have put off, said on the spot ────────────────────
film('why', apps(['docs']), [
  { t: 0, app: 'docs', cam: SHOT.wide, line: 'Reading the launch brief. Something’s missing.' },
  { t: 2.0, key: 'hold right ⌥', say: 'build a landing page for the pricing launch', sayDur: 2.2, pill: 'pill-ropt-rec', speak: true, cam: SHOT.pill },
  { t: 4.8, key: 'hold right ⌥', say: 'build a landing page for the pricing launch', pill: 'pill-ropt-proc' },
  { t: 5.3, pill: null, notch: 'bar-sending', cam: SHOT.bar, line: 'Sending it to Claude Code…' },
  { t: 6.2, notch: 'task-2', cam: SHOT.panel, done: 'Started. You’re still reading the brief.' },
  { t: 9.6, notch: 'bar-working1', cam: SHOT.wide, line: '', end: 11.5 },
], { still: 4 })

// ── START OR CONTINUE: talk to a running session without opening it ─────────
film('start', apps(['figma']), [
  { t: 0, app: 'figma', notch: 'bar-working3', cam: SHOT.wide, line: 'Three sessions are running. You’re looking at the designs.' },
  { t: 2.2, notch: 'pocket-onb-open', cam: SHOT.pocket, line: 'Your sessions live in the notch. Flip to Onboarding flow.' },
  { t: 4.4, key: 'hold fn', say: 'make the signup step shorter', sayDur: 1.5, notch: 'pocket-onb-aimed', pill: 'pocket-onb-aimed', speak: true },
  { t: 6.6, notch: 'pocket-onb-sent', pill: null, done: 'Follow-up sent. Nothing opened.' },
  { t: 9.0, notch: 'bar-working3', cam: SHOT.wide, line: '', end: 10.5 },
], { still: 3 })

// ── CAPTURE CONTEXT: words and a screenshot arrive together ──────────────────
{
  const box = (st, on) => {
    const b = $('.selbox', st.host), btn = $('.app[data-app="settings"] .savebtn', st.host)
    const cam = $('.cam', st.host).getBoundingClientRect(), r = btn.getBoundingClientRect(), k = cam.width / 1120
    const x = (r.left - cam.left) / k - 10, y = (r.top - cam.top) / k - 10
    const w = r.width / k + 300, h = r.height / k + 20
    gsap.set(b, { left: x, top: y })
    gsap.to(b, { width: on ? w : 0, height: on ? h : 0, opacity: on === 1 ? 1 : 0, duration: on === 1 ? 0.7 : 0.25, ease: 'power2.inOut' })
  }
  film('capture', apps(['settings']), [
    { t: 0, app: 'settings', cam: SHOT.wide, line: 'You click Save. Nothing happens.', do: (st) => box(st, 0) },
    { t: 2.0, key: 'hold right ⌥', say: 'fix this, the save button does nothing', sayDur: 1.8, pill: 'pill-ropt-rec', speak: true, cam: WINDOW_LOW },
    { t: 4.2, key: 'hold left ⌘ + drag', line: 'Still talking, drag over the problem.', pill: 'pill-ropt-rec', speak: true, do: (st) => box(st, 1) },
    { t: 5.6, pill: 'pill-flash', speak: true, done: 'Screenshot added to what you’re saying.', do: (st) => box(st, 2) },
    { t: 6.6, pill: 'pill-ropt-proc', speak: false, done: 'Screenshot added to what you’re saying.' },
    { t: 7.1, pill: null, notch: 'bar-sending', cam: SHOT.bar, line: 'Sending your words and the screenshot…' },
    { t: 8.0, notch: 'bar-working1', done: 'Claude Code has both. You never opened a terminal.' },
    { t: 10.2, cam: SHOT.wide, line: '', end: 11.5 },
  ], { html: '<div class="selbox"></div>', still: 3 })
}

// ── UNMUTE AGENT: find past work from what you remember ──────────────────────
film('agent', apps(['inbox']), [
  { t: 0, app: 'inbox', cam: SHOT.wide, line: 'Back to yesterday’s work. Which session was it?' },
  { t: 2.0, key: 'right ⌘ ×2', say: 'pick up the onboarding work from yesterday. use what we decided in the meeting', sayDur: 3, pill: 'pill-agent-rec', notch: 'bar-agent-listening', speak: true, cam: SHOT.pill },
  { t: 5.6, key: 'right ⌘ ×2', say: 'pick up the onboarding work from yesterday. use what we decided in the meeting', pill: 'pill-agent-proc', notch: 'bar-agent-searching', cam: SHOT.bar },
  { t: 6.6, pill: null, notch: 'agent-recall-1', cam: SHOT.panel, line: 'Unmute Agent looks through your sessions and meeting notes…' },
  { t: 8.2, notch: 'agent-recall-2', done: 'Found the session and the meeting it needs.' },
  { t: 11.6, notch: 'bar-inpocket-onb', cam: SHOT.bar, done: 'Back in your notch, ready to continue.' },
  { t: 13.6, cam: SHOT.wide, line: '', end: 15 },
], { still: 4 })

// ── THE TASK COMES TO YOU: the notch opens by itself; answer by voice ────────
film('attention', apps(['figma']), [
  { t: 0, app: 'figma', notch: 'bar-working1', cam: SHOT.wide, line: 'You’re in Figma. Claude Code is building the onboarding flow.' },
  { t: 2.4, notch: 'onb-ask', cam: SHOT.panel, line: 'It needs a decision. The notch opens on its own.' },
  { t: 5.8, key: 'hold right ⌥', say: 'move it after the first project', sayDur: 1.6, notch: 'onb-ask-aimed', pill: 'onb-ask-aimed', speak: true },
  { t: 8.2, notch: 'onb-continue', pill: null, done: 'Answered without leaving Figma.' },
  { t: 11.2, notch: 'bar-working1', cam: SHOT.wide, line: 'It carries on. So do you.', end: 13.5 },
], { still: 1 })

// ── MEETING NOTES: notes, then the decisions go where they belong ────────────
film('meet', apps(['call'], ['inbox']), [
  { t: 0, app: 'call', nt: 'rec', cam: NT_SHOT, line: 'In a call. One click and the notetaker listens.' },
  { t: 2.6, nt: 'discard', line: 'Call’s over. Click End.' },
  { t: 3.6, nt: 'done', done: 'Notes written by your own Claude.' },
  { t: 5.8, nt: null, app: 'inbox', cam: SHOT.wide, line: '' },
  { t: 6.4, key: 'right ⌘ ×2', say: 'take the decisions from that call into the onboarding session', sayDur: 2.6, pill: 'pill-agent-rec', speak: true, cam: SHOT.pill },
  { t: 9.4, key: 'right ⌘ ×2', say: 'take the decisions from that call into the onboarding session', pill: 'pill-agent-proc' },
  { t: 9.9, pill: null, notch: 'agent-meetonb-2', cam: SHOT.panel, done: 'The decisions are in the Onboarding flow session.', end: 14 },
], { html: NT_HTML, nt: true, still: 6 })

// ── DICTATION ────────────────────────────────────────────────────────────────
{
  const reply = "Thanks Priya, Thursday works. I'll send the final copy tonight."
  film('dictate', apps(['mail']), [
    { t: 0, app: 'mail', typed: '', cam: SHOT.wide, line: 'Replying to Priya. Cursor in the message.' },
    { t: 1.6, key: 'hold fn', say: reply, sayDur: 2.6, pill: 'pill-fn-rec', speak: true, cam: SHOT.pill },
    { t: 4.6, key: 'hold fn', say: reply, pill: 'pill-fn-proc' },
    { t: 5.0, pill: 'pill-fn-out', typed: reply, cam: MAIL_TOP, done: 'Typed where your cursor was.' },
    { t: 6.0, pill: null },
    { t: 8.2, cam: SHOT.wide, line: '', end: 9.5 },
  ], { still: 3 })
}

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
