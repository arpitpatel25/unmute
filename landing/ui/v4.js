// UNMUTE v4 — the playable hero. The same kit as the live page, but driven by
// the visitor: pick a task, pick Claude Code or Codex and a model, then press
// right ⌥ (the real key works too). The session comes back in the notch, and
// its buttons are real.
import { Screen, panel, MARK, runScene, setSound, sound, reduced, WPS } from './kit.js'
import { apps, stages, parallel, film, filmStill, stopNarration } from './scenes.js'
import { slack, skMsg, skReact } from './apps.js'

const $ = (s, r = document) => r.querySelector(s)
const $$ = (s, r = document) => [...r.querySelectorAll(s)]
const add = (root, html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); const n = t.content.firstElementChild; root.append(n); return n }

// Nav border once the page scrolls.
const nav = $('.nav')
addEventListener('scroll', () => nav.classList.toggle('scrolled', scrollY > 8), { passive: true })

// The closing wall: rows of things people say, drifting.
{
  const lines = [['claude', 'Fix the flaky checkout test'], ['codex', 'Draft replies to these refunds'], ['claude', 'Merge it'], ['codex', 'Turn this thread into tickets'], ['claude', 'Build this pricing page'], ['claude', 'Why did the deploy fail?'], ['codex', 'Add CSV export for invoices'], ['claude', 'Continue the onboarding session'], ['codex', 'Rebase on main and fix the conflicts'], ['claude', 'Summarize this call for Priya'], ['codex', 'Rate limit the public API'], ['claude', 'Yes, 20% off for annual']]
  const wall = $('.wall')
  for (let r = 0; r < 6; r++) {
    const row = document.createElement('div'); row.className = 'row'
    const seq = [...lines.slice(r * 2), ...lines.slice(0, r * 2)]
    row.innerHTML = [...seq, ...seq].map(([a, t]) => `<span><img src="${MARK[a]}" alt="">${t}</span>`).join('')
    wall.append(row)
  }
}

// ── The playable hero ────────────────────────────────────────────────────────
const MODELS = { claude: ['Opus 5.5', 'Sonnet 5.5', 'Haiku 5.5'], codex: ['GPT-6.1 Sol', 'GPT-6 Astra', 'GPT-6.1 Luna'] }
const TASKS = {
  bug: {
    say: 'Find what broke EU checkout since this morning’s release, fix it, and open a PR.',
    title: 'EU checkout bug',
    asks: 'Found it: VAT rounding in <code>convertCurrency()</code>, changed in #802. Fixed it, <span class="ok">41 tests pass</span>, and opened <b>PR #812</b>.<br><b>Merge it?</b>',
    yes: 'Merge', no: 'Not yet', answer: 'Merge it and reply in the thread.',
    done: '<span class="step"><i></i>Merged <b>PR #812</b> into <code>main</code> · deploying</span><span class="step"><i></i>Replied in <b>#bugs</b></span>',
    after: (msgs) => add(msgs, skMsg('you', '9:51 AM', 'Fixed in <b>#812</b>: VAT rounding in currency conversion. Deploying now ✅', skReact([['🙌', 4]]))),
  },
  sum: {
    say: 'Summarize this thread for Priya, with what’s still open.',
    title: 'Bugs summary',
    asks: '<b>3 issues today.</b> EU checkout is the big one: 40+ tickets, cause unknown. Staging restarts at noon. The invoice PDF bug is fixed.<br><b>Send it to Priya?</b>',
    yes: 'Send', no: 'Edit first', answer: 'Send it to Priya.',
    done: '<span class="step"><i></i>Sent the summary to <b>Priya Nair</b> in a DM</span>',
  },
  reply: {
    say: 'Draft a reply to Maya saying we’re on it and will update within the hour.',
    title: 'Reply to Maya',
    asks: '<span class="quote">“On it, Maya. We’re looking at the EU checkout failures now and will post an update here within the hour.”</span><b>Post it in the thread?</b>',
    yes: 'Post', no: 'Change it', answer: 'Post it.',
    done: '<span class="step"><i></i>Posted in the <b>#bugs</b> thread</span>',
    after: (msgs) => add(msgs, skMsg('you', '9:44 AM', 'On it, Maya. We’re looking at the EU checkout failures now and will post an update here within the hour.')),
  },
}

const s = new Screen($('#try-stage'))
const hint = $('.try-hint'), status = $('.try-status'), talk = $('#talk'), modelSel = $('#model')
let task = 'bug', agent = 'claude', state = 'idle', msgs, lastPanel = null

const say = (t) => { status.textContent = t }
const setModels = () => { modelSel.innerHTML = MODELS[agent].map((m) => `<option>${m}</option>`).join('') }
setModels()

function scene() {
  s.clock.reset() // old waits stop
  s.menu('Slack'); s.time('Tue 9:41 AM'); s.notch(); s.hideCursor()
  const w = s.window(slack({ channel: 'bugs' }))
  msgs = $('.sk-msgs', w)
  add(msgs, skMsg('dev', '9:12 AM', 'Release <b>2026.10.17</b> is out 🚀 checkout, invoices and the new onboarding.', skReact([['🚀', 6]])))
  add(msgs, skMsg('jon', '9:20 AM', 'Heads up: staging DB restarts at noon, ~5 min of downtime.', skReact([['👍', 4]])))
  add(msgs, skMsg('maya', '9:41 AM', '<span class="men">@here</span> Checkout is failing for EU customers since this morning’s release 😬 40+ tickets so far. Can someone take a look?', skReact([['👀', 3]]))).classList.add('hl')
  state = 'idle'; lastPanel = null; hint.hidden = false; talk.disabled = false
  talk.querySelector('span').textContent = 'Press right Option'
}
scene()

const model = () => `${agent === 'codex' ? 'Codex' : 'Claude Code'} · ${modelSel.value}`
const P = (status, body, actions) => panel({ agent, title: TASKS[task].title, status, body, actions })

async function start() {
  if (state === 'needs') return answer(true)
  if (state !== 'idle' && state !== 'done') return
  if (state === 'done') scene()
  const t = TASKS[task]
  state = 'busy'; hint.hidden = true; talk.disabled = true
  try {
    say('You’re talking. Unmute writes down what you say.')
    document.dispatchEvent(new CustomEvent('try:start', { detail: task }))
    await s.tap()
    await s.speak(t.say, { agent, model: model() })
    s.notch({ right: { text: 'Sending' }, width: 340 }); say('Sent to a new ' + (agent === 'codex' ? 'Codex' : 'Claude Code') + ' session.')
    await s.wait(1000)
    s.notch({ right: { text: 'Working', n: 1 }, width: 380 }); say('It works in the background. You could keep working in Slack.')
    await s.wait(2600)
    lastPanel = { size: [640, 300], panel: P('needs', `<span class="you">${t.say}</span>${t.asks}`, `<span class="primary" data-a="yes">${t.yes}</span><span data-a="no">${t.no}</span>`) }
    s.notch(lastPanel)
    state = 'needs'; talk.disabled = false; talk.querySelector('span').textContent = 'Press right Option to answer'
    say('It needs you. Click a button in the notch, or press right ⌥ and answer.')
  } catch (e) { if (e.message !== 'reset') console.error(e) }
}

async function answer(yes) {
  if (state !== 'needs') return
  const t = TASKS[task]
  state = 'busy'; talk.disabled = true
  try {
    if (!yes) {
      s.notch({ right: { text: 'Needs you', dot: 'orange', n: 1 }, width: 380 }); lastPanel && (lastPanel.later = true)
      state = 'needs'; talk.disabled = false
      say('It waits. Click the notch to open it again.')
      return
    }
    await s.tap()
    await s.speak(t.answer, { agent, model: model() })
    lastPanel = { size: [640, 220], panel: P('done', `<span class="you">${t.answer}</span>${t.done}`) }
    s.notch(lastPanel)
    t.after && t.after(msgs).classList.add('new')
    say('Done. Click the notch to open it again, or pick another task.')
    document.dispatchEvent(new CustomEvent('try:done', { detail: task }))
    await s.wait(2600)
    s.notch({ right: { text: 'Done', dot: 'grey' }, width: 330 })
    state = 'done'; talk.disabled = false; talk.querySelector('span').textContent = 'Press right Option'
  } catch (e) { if (e.message !== 'reset') console.error(e) }
}

// The notch: its buttons answer; the bar opens the last session.
s.notchEl.addEventListener('click', (e) => {
  const a = e.target.closest('[data-a]')
  if (a) { a.classList.add('pressed'); return answer(a.dataset.a === 'yes') }
  if (s.notchEl.classList.contains('bar') && lastPanel) {
    s.notch(lastPanel)
    if (state === 'done') setTimeout(() => state === 'done' && s.notch({ right: { text: 'Done', dot: 'grey' }, width: 330 }), 4000)
  }
})

hint.addEventListener('click', start)
talk.addEventListener('click', start)
$$('.chip').forEach((c) => c.addEventListener('click', () => {
  $$('.chip').forEach((x) => x.classList.toggle('on', x === c)); task = c.dataset.task
  if (state !== 'busy') { scene(); say('Press right ⌥ to ask: “' + TASKS[task].say + '”') }
}))
$$('.seg button').forEach((b) => b.addEventListener('click', () => {
  $$('.seg button').forEach((x) => x.classList.toggle('on', x === b)); agent = b.dataset.agent; setModels()
  if (state !== 'busy') scene()
}))

// The real key: right Option, while the hero is on screen.
let onScreen = true
new IntersectionObserver(([e]) => { onScreen = e.isIntersecting }, { threshold: 0.3 }).observe($('#try-stage'))
addEventListener('keydown', (e) => {
  if (e.code !== 'AltRight' || !onScreen || e.repeat) return
  e.preventDefault(); talk.classList.add('down'); start()
})
addEventListener('keyup', (e) => { if (e.code === 'AltRight') talk.classList.remove('down') })

// ── The motion sections, same as the live page ──────────────────────────────
const saidText = (t) => `You say: “${t}”`
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
  const big = $('.film-snd', fig)
  const s = new Screen($('#film-stage'))
  s.host.append(big) // Screen() cleared the stage; keep the button on top of it.
  let target = 0, cur = 0, userOff = false
  const paint = (i) => chs.forEach((b, k) => { b.classList.toggle('on', k === i); b.classList.toggle('done', i >= 0 && k < i) })
  s.host.addEventListener('kit:narrate', (e) => { if (!s.clock.fast) cap.textContent = e.detail })
  const ctl = runScene(s, film, { threshold: 0.5, still: filmStill, onStep: (i) => {
    // Jumping to a chapter plays everything before it instantly.
    if (i >= target) { s.clock.fast = false; target = 0 }
    cur = i; paint(i)
  } })
  const pause = $('.c-pause', fig), snd = $('.c-sound', fig)
  const playing = () => { pause.setAttribute('aria-pressed', 'false'); pause.textContent = 'Pause' }
  const jump = (k) => {
    stopNarration(); cap.textContent = ''; playing(); ctl.replay()
    target = k; setTimeout(() => { s.clock.fast = k > 0 }, 0)
  }
  chs.forEach((b, k) => b.addEventListener('click', () => jump(k)))
  pause.addEventListener('click', () => { const p = ctl.pause(); if (p) stopNarration(); pause.setAttribute('aria-pressed', String(p)); pause.textContent = p ? 'Play' : 'Pause' })
  $('.c-replay', fig).addEventListener('click', () => jump(0))
  // Turning sound on restarts the current chapter, so its narration is heard
  // from the top of the line instead of from the next one.
  snd.addEventListener('click', () => { const on = !sound.on; userOff = !on; setSound(on); if (on) jump(cur); else stopNarration() })
  big.addEventListener('click', () => { userOff = false; setSound(true); jump(0) })
  sound.listeners.add((on) => { snd.setAttribute('aria-pressed', String(on)); snd.textContent = on ? 'Sound on' : 'Sound off'; big.hidden = on })
  // Browsers only allow sound after the visitor has clicked something on the
  // page. If they have, the film starts with its narration.
  let first = true
  new IntersectionObserver(([e]) => {
    if (!first || e.intersectionRatio < 0.5) return
    first = false
    if (navigator.userActivation?.hasBeenActive && !userOff && !sound.on) { setSound(true); jump(0) }
  }, { threshold: [0, 0.5] }).observe(s.host)
  if (reduced) { pause.hidden = true; $('.c-replay', fig).hidden = true }
}

// ── The raw recording: loads only when it's opened ───────────────────────────
{
  const d = $('.real-wrap'), v = $('.real video')
  const small = Math.min(screen.width, innerWidth) < 900
  d.addEventListener('toggle', () => { if (d.open && !v.src) { v.src = `assets/video/hero${small ? '-720' : ''}.mp4?v=l41`; v.play().catch(() => {}) } })
}

// Touch screens have no right ⌥: say "tap" instead of "press".
if (matchMedia('(hover: none)').matches) {
  const hintBtn = document.querySelector('.try-hint'), talkBtn = document.querySelector('#talk')
  hintBtn.innerHTML = 'Tap here to talk'
  const relabel = () => { const sp = talkBtn.querySelector('span'); if (sp.textContent.includes('Press right Option')) sp.textContent = sp.textContent.replace('Press right Option', 'Tap to talk') }
  relabel(); new MutationObserver(relabel).observe(talkBtn, { subtree: true, characterData: true, childList: true })
  const st = document.querySelector('.try-status')
  const fixStatus = () => { if (/press/i.test(st.textContent)) st.textContent = st.textContent.replace(/press right ⌥|press the key/gi, 'tap the button') }
  fixStatus(); new MutationObserver(fixStatus).observe(st, { childList: true, characterData: true, subtree: true })
}

// ── Bots ─────────────────────────────────────────────────────────────────────
// The faces are the app's own (ui/bots.js). The hero shows a few; the section
// shows tasks filing themselves into the right bot, and a new one appearing.
import('./bots.js').then(({ face, stack, liven, celebrate }) => {
  const $ = (s, r = document) => r.querySelector(s)
  const CREW = ['Checkout', 'Hiring', 'Marketing', 'Bug fixes', 'Mobile app', 'Personal', 'Inbox']

  // Hero: bots sitting on top of the demo screen, and a small stack by the logos.
  const perch = $('.bot-perch')
  if (perch) { perch.innerHTML = CREW.map((n) => face(n, { size: 46, cls: 'lively' })).join(''); }

  // Giant bots in the empty space beside headings, across the page. They bob
  // on their own beat, blink, and watch the pointer.
  // What each bot holds, for its tooltip.
  const WORK = {
    Checkout: ['Fix the flaky checkout test', 'Ship the new checkout page', 'Fix tax on EU orders'],
    Marketing: ['Draft the launch email', 'Turn the thread into tweets', 'Pricing page copy'],
    Personal: ['Plan Saturday', 'Renew my passport', 'Book a dentist'],
    Inbox: ['Reply to the refund requests', 'Summarize the investor update'],
    'Bug fixes': ['Flaky signup test', 'Crash on empty cart', 'Slow invoices page'],
    'Mobile app': ['Dark mode on settings', 'Push notification copy'],
    Hiring: ['Screen the backend applicants', 'Draft the offer letter'],
    Payments: ['Add Apple Pay', 'Retry failed charges', 'Refund webhook'],
    Design: ['Turn the Figma frame into code', 'Icons for the new menu'],
    Research: ['Compare team plan pricing', 'Summarize the user calls'],
    Growth: ['SEO for the blog', 'Referral program draft', 'Weekly signups report'],
    Docs: ['Update the API reference', 'Write the setup guide'],
    Ops: ['Rotate the API keys', 'Check the backups'],
  }
  const SPOTS = [
    ['.hero', 'Checkout', 150, 'left:calc(50% - 690px);top:150px', 0],
    ['.hero', 'Marketing', 120, 'left:calc(50% + 560px);top:300px', 1.2],
    ['.hero', 'Personal', 84, 'left:calc(50% - 600px);top:430px', 2.1],
    ['.hero', 'Inbox', 70, 'left:calc(50% + 520px);top:120px', .6],
    ['#how', 'Bug fixes', 130, 'right:calc(50% - 560px);top:120px', .4],
    ['#apps', 'Mobile app', 140, 'right:calc(50% - 540px);top:96px', 1.4],
    ['#does', 'Hiring', 150, 'right:calc(50% - 560px);top:110px', .8],
    ['#uses', 'Payments', 120, 'right:calc(50% - 540px);top:96px', 1.8],
    ['#film', 'Design', 130, 'right:calc(50% - 540px);top:100px', .2],
    ['.plans-own', 'Research', 120, 'right:calc(50% - 540px);top:120px', 1],
    ['#compare', 'Growth', 130, 'right:calc(50% - 540px);top:110px', 1.6],
    ['#faq', 'Docs', 110, 'left:calc(50% - 560px);top:320px', .5],
    ['#blog', 'Ops', 120, 'right:calc(50% - 540px);top:110px', 1.3],
  ]
  for (const [sel, name, size, pos, delay] of SPOTS) {
    const host = $(sel); if (!host) continue
    const d = document.createElement('div'); d.className = `bot-deco bd-${host.querySelectorAll(':scope > .bot-deco').length}`; d.setAttribute('aria-hidden', 'true')
    d.style.cssText = pos + `;--d:${delay}s`
    const info = WORK[name] || []
    d.innerHTML = face(name, { size, cls: 'lively' }) + '<i class="bd-shadow"></i>'
      + `<span class="bd-tip" role="tooltip"><span class="bt-h">${face(name, { size: 20 })}<b>${name} bot</b><em>${info.length} tasks</em></span>`
      + info.map((t) => `<span class="bt-t">${t}</span>`).join('') + '<span class="bt-f">Unmute made this bot. You never set it up.</span></span>'
    host.classList.add('has-deco'); host.append(d)
    // The tooltip opens toward the middle of the page, so it never runs off-screen.
    d.addEventListener('pointerenter', () => { const r = d.getBoundingClientRect(); d.classList.toggle('tip-r', r.left + r.width / 2 > innerWidth / 2) })
  }

  // The bots on the Mac watch the demo: they hop when you start talking, and
  // the bot the task belongs to smiles when it's done.
  const OWNER = { bug: 'Checkout', sum: 'Inbox', reply: 'Marketing' }
  document.addEventListener('try:start', () => {
    perch?.querySelectorAll('svg.bot').forEach((b, i) => setTimeout(() => { b.classList.remove('hop'); void b.getBBox(); b.classList.add('hop') }, i * 60))
  })
  document.addEventListener('try:done', (e) => {
    const b = perch?.querySelector(`svg.bot[data-name="${OWNER[e.detail]}"]`); if (!b) return
    b.classList.add('hop'); celebrate(b); setTimeout(() => b.classList.remove('hop'), 900)
  })

  // Feature card: bot faces on the rows.
  document.querySelectorAll('.v-bots .pr').forEach((r) => { r.querySelector('.pf').innerHTML = face(r.dataset.bot, { size: 18 }) })

  // The section: a bot rail like the app's, and tasks that find their bot.
  const stage = $('.bots-stage'); if (!stage) { liven(); return }
  const list = $('.rail-list', stage), words = $('.bs-words', stage), pill = $('.bs-say .v-pill', stage), steps = [...document.querySelectorAll('.bot-steps li')]
  const START = [['Checkout', 4], ['Marketing', 3], ['Mobile app', 2], ['Personal', 1], ['Inbox', 0]]
  const row = (name, n) => `<div class="rl-row" data-name="${name}">${face(name, { size: 28, cls: 'lively' })}<span class="rl-n">${name}</span><span class="rl-c">${n}</span></div>`
  const total = () => [...list.querySelectorAll('.rl-row[data-name] .rl-c')].reduce((a, c) => a + +c.textContent, 0)
  const paint = () => {
    list.innerHTML = `<div class="rl-row all on">${stack(START.map((r) => r[0]), 20, '#2a292e')}<span class="rl-n">All bots</span><span class="rl-c rl-tot"></span></div>`
      + START.map(([n, c]) => row(n, c)).join('') + `<div class="rl-row un"><i class="dash"></i><span class="rl-n">Unassigned</span><span class="rl-c">0</span></div>`
    $('.rl-tot', list).textContent = total(); liven(list)
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const step = (i) => steps.forEach((li, k) => { li.classList.toggle('on', k === i); li.classList.toggle('done', k < i) })
  const say = async (text) => {
    words.innerHTML = text.split(' ').map((w) => `<span>${w}</span>`).join(' ')
    stage.classList.add('talking'); pill.classList.add('on')
    for (const sp of words.querySelectorAll('span')) { sp.classList.add('in'); await sleep(280) }
    await sleep(500); pill.classList.remove('on')
  }
  // A task chip flies from what you said into its bot's row.
  const fly = async (text, target) => {
    const from = words.getBoundingClientRect(), to = target.getBoundingClientRect(), base = stage.getBoundingClientRect()
    const chip = document.createElement('span'); chip.className = 'bs-chip'; chip.textContent = text
    chip.style.left = from.left - base.left + from.width / 2 + 'px'; chip.style.top = from.top - base.top + from.height / 2 + 'px'
    stage.append(chip); stage.classList.remove('talking')
    await sleep(40)
    chip.style.transform = `translate(${to.left - from.left - from.width / 2 + 60}px,${to.top - from.top - from.height / 2 + to.height / 2}px) scale(.35)`
    chip.style.opacity = '0'
    await sleep(700); chip.remove()
  }
  const focusBot = $('.bf-bot', stage), focusName = $('.bf-name', stage), focusTasks = $('.bf-tasks', stage)
  const focus = (name, tasks, { pop = false } = {}) => {
    focusBot.innerHTML = name ? face(name, { size: 150, cls: 'lively' + (pop ? ' pop' : '') }) : '<i class="bf-empty"></i>'
    focusName.innerHTML = name ? `<b>${name}</b>` : '<span>Finding the right bot…</span>'
    focusTasks.innerHTML = tasks.map((t, i) => `<span class="bf-t${i === 0 ? ' fresh' : ''}">${t}</span>`).join('')
    liven(stage); return focusBot.querySelector('svg.bot')
  }
  const bump = (r) => { const c = $('.rl-c', r); c.textContent = +c.textContent + 1; r.classList.add('hit'); setTimeout(() => r.classList.remove('hit'), 900); $('.rl-tot', list).textContent = total() }
  let visible = false, running = false
  const loop = async () => {
    if (running) return; running = true
    while (visible) {
      paint(); step(0); words.innerHTML = ''; focus('Checkout', ['Ship the new checkout page', 'Fix tax on EU orders']); await sleep(1200)
      // 1 · fits an existing bot
      await say('Fix the flaky checkout test before the release.')
      step(1)
      const co = list.querySelector('.rl-row[data-name="Checkout"]')
      focus(null, []); await sleep(500)
      await fly('Fix the flaky checkout test', co); bump(co)
      co.querySelector('svg.bot').dataset.mood = 'working'
      const big = focus('Checkout', ['Fix the flaky checkout test', 'Ship the new checkout page', 'Fix tax on EU orders'], { pop: true }); big.dataset.mood = 'working'
      await sleep(2000)
      // 2 · nothing fits: a new bot appears
      step(0); await say('Book flights and a hotel for the Tokyo offsite.')
      step(2)
      focus(null, []); await sleep(700)
      const fresh = document.createElement('div'); fresh.innerHTML = row('Tokyo trip', 0)
      const nr = fresh.firstElementChild; nr.classList.add('new')
      list.querySelector('.rl-row.un').before(nr); liven(list)
      await sleep(450)
      await fly('Book flights and a hotel', nr); bump(nr)
      celebrate(nr.querySelector('svg.bot'))
      celebrate(focus('Tokyo trip', ['Book flights and a hotel'], { pop: true }))
      await sleep(1600)
      // Checkout's work finishes: a smile.
      const cs = co.querySelector('svg.bot'); cs.dataset.mood = 'idle'; celebrate(cs)
      await sleep(1400); celebrate(focus('Checkout', ['Fixed the flaky checkout test ✓', 'Ship the new checkout page', 'Fix tax on EU orders']))
      await sleep(3200)
    }
    running = false
  }
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; if (visible) loop() }, { threshold: 0.35 }).observe(stage)
  paint(); liven()
})
