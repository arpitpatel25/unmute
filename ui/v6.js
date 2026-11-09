// UNMUTE v6 — one design system. The playable demo and the app tabs are the
// same code as v4; everything around them is new. Bot faces are the app's own
// (ui/bots.js), given soft 3D shading here.
import { Screen, panel, reduced, MARK } from './kit.js'
import { apps } from './scenes.js'
import { slack, skMsg, skReact } from './apps.js'
import { face, stack, liven, celebrate } from './bots.js'

const $ = (s, r = document) => r.querySelector(s)
const $$ = (s, r = document) => [...r.querySelectorAll(s)]
const add = (root, html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); const n = t.content.firstElementChild; root.append(n); return n }
for (const a of ['muse', 'opencode', 'pi', 'grok', 'cursor']) MARK[a] = `assets/mark-${a}.png`
const NAMES = { claude: 'Claude Code', codex: 'Codex', muse: 'Muse', opencode: 'OpenCode', pi: 'Pi', grok: 'Grok', cursor: 'Cursor' }
const saidText = (t) => `You say: “${t}”`

// The replica apps carry a placeholder company name; keep it neutral here.
function neutral(root) {
  const fix = (n) => { const w = document.createTreeWalker(n, NodeFilter.SHOW_TEXT); let t; while ((t = w.nextNode())) { const v = t.nodeValue.replace(/\bOrbit\b/g, 'Your team').replace(/\borbit\b/g, 'yourapp'); if (v !== t.nodeValue) t.nodeValue = v } n.querySelectorAll?.('.sk-rail .ws').forEach((e) => { if (e.textContent !== 'Y') e.textContent = 'Y' }) }
  new MutationObserver(() => fix(root)).observe(root, { childList: true, subtree: true })
  fix(root)
}
neutral($('#try-stage')); neutral($('#apps-stage'))

addEventListener('scroll', () => $('.nav').classList.toggle('scrolled', scrollY > 8), { passive: true })

// ── Soft 3D: the same body and eyes, with a soft light on top ────────────────
$('#puffs').insertAdjacentHTML('beforeend', `
  <radialGradient id="shade" cx=".36" cy=".26" r=".92"><stop offset="0" stop-color="#fff" stop-opacity=".34"/><stop offset=".42" stop-color="#fff" stop-opacity=".04"/><stop offset=".62" stop-color="#2a1a3a" stop-opacity="0"/><stop offset="1" stop-color="#2a1a3a" stop-opacity=".3"/></radialGradient>
  <radialGradient id="spec"><stop offset="0" stop-color="#fff" stop-opacity=".78"/><stop offset=".55" stop-color="#fff" stop-opacity=".16"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
  <linearGradient id="bounce" x1="0" y1="1" x2="0" y2=".6"><stop offset="0" stop-color="#fff" stop-opacity=".22"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>`)
const puff = (html, s) => html.replace(/<path d="([^"]+)" fill="url\(#(bg\d+)\)"\/>/g, (m, d, id) => `${m}<path d="${d}" fill="url(#shade)"/><path d="${d}" fill="url(#bounce)"/><ellipse cx="${(s * .34).toFixed(1)}" cy="${(s * .25).toFixed(1)}" rx="${(s * .19).toFixed(1)}" ry="${(s * .12).toFixed(1)}" fill="url(#spec)" transform="rotate(-20 ${(s * .34).toFixed(1)} ${(s * .25).toFixed(1)})" clip-path="url(#${id}c)"/>`)
const bot = (name, size, cls = 'lively', mood) => puff(face(name, { size, cls, mood }), size)

// ── Hero: the waveform skyline, and the bots on it ───────────────────────────
function skyline() {
  const sky = $('.sky'); sky.querySelectorAll('.bars').forEach((b) => b.remove())
  const k = Math.min(1, innerWidth / 1280)
  const row = (cls, w, gap, base, amp, seed) => {
    const n = Math.ceil(innerWidth * 1.08 / (w + gap)) | 1
    const b = document.createElement('div'); b.className = 'bars ' + cls
    b.innerHTML = Array.from({ length: n }, (_, i) => {
      const t = (i - (n - 1) / 2) / ((n - 1) / 2)
      const h = 80 + base + amp * Math.pow(Math.abs(t), 2.3) + 26 * Math.abs(Math.sin(i * 1.7 + seed)) + 18 * Math.abs(Math.sin(i * .63 + seed * 2))
      return `<i style="height:${Math.round(h)}px;--t:${(2.6 + (i * 7 % 13) / 8).toFixed(2)}s;--d:-${((i * 11) % 17) / 6}s"></i>`
    }).join('')
    sky.prepend(b)
  }
  row('front', 54, 16, 60, 250 * (.5 + .5 * k), 1.3)
  row('back', 40, 12, 120, 340 * (.5 + .5 * k), 3.1)
}
skyline(); let rw = innerWidth
addEventListener('resize', () => { if (Math.abs(innerWidth - rw) > 40) { rw = innerWidth; skyline() } })

// The skyline listens: bars rise under the cursor and dance when you press ⌥.
{
  const hero = $('.hero'); let px = -9999, inside = false, seen = true, danceUntil = 0
  hero.addEventListener('pointermove', (e) => { px = e.clientX; inside = true }, { passive: true })
  hero.addEventListener('pointerleave', () => { inside = false })
  new IntersectionObserver(([e]) => { seen = e.isIntersecting }).observe(hero)
  const dance = () => { danceUntil = performance.now() + 2600 }
  addEventListener('keydown', (e) => { if (e.code === 'AltRight' && !e.repeat) dance() })
  document.addEventListener('try:start', dance)
  const tick = (now) => {
    if (seen && !reduced) $$('.bars').forEach((row) => {
      const back = row.classList.contains('back'), kids = row.children, n = kids.length, step = back ? 52 : 70, g = back ? .55 : 1
      for (let i = 0; i < n; i++) {
        const x = innerWidth / 2 + (i - (n - 1) / 2) * step, d = x - px
        let t = inside ? Math.exp(-(d * d) / 16000) * 78 * g : 0
        if (now < danceUntil) t = Math.max(t, (Math.sin(now / 120 + i * .9) * .5 + .5) * Math.abs(Math.sin(now / 410 + i * .37)) * 92 * g)
        const el = kids[i]; el._v = (el._v || 0) + (t - (el._v || 0)) * .14
        el.style.translate = `0 ${(-el._v).toFixed(1)}px`
      }
    })
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

const WORK = {
  'Billing': ['Fix VAT rounding on EU orders', 'Move to Stripe Tax', 'Ship usage-based pricing'],
  'Instagram growth': ['Plan next week’s 6 Reels', 'Reply to creator DMs', 'Caption the launch carousel'],
  'Fundraising': ['Add Q3 numbers to the investor memo', 'Follow up with 12 VCs', 'Clean up the data room'],
  'iOS app': ['Fix the TestFlight crash on login', 'Answer App Store reviews'],
}
const SPOTS = [['Billing', 148, 'left:calc(50% - 628px);top:262px', 0, ''], ['Instagram growth', 128, 'left:calc(50% + 498px);top:286px', 1.2, 'rtl'], ['Fundraising', 70, 'left:calc(50% - 330px);top:566px', 2.1, 'far'], ['iOS app', 62, 'left:calc(50% + 268px);top:574px', .6, 'far rtl']]
SPOTS.forEach(([name, size, pos, d, cls], i) => {
  const el = document.createElement('div'); el.className = `deco d${i} ${cls}`; el.style.cssText = pos + `;--d:${d}s`
  const w = WORK[name]
  el.innerHTML = `<span class="bob">${bot(name, size)}</span><div class="tip"><div class="tip-h">${bot(name, 20, '')}${name} bot<em>${w.length} tasks</em></div><ul>${w.map((t) => `<li>${t}</li>`).join('')}</ul><small>Created by Unmute. You never set it up.</small></div>`
  $('.hero').append(el)
})

// Bots on the frame: they hop when you talk; the owner of the task smiles.
const left = ['Billing', 'Instagram growth', 'iOS app'], right = ['Fundraising', 'Support inbox', 'SEO']
$('.perch.l').innerHTML = left.map((n) => bot(n, 46)).join(''); $('.perch.r').innerHTML = right.map((n) => bot(n, 46)).join('')
const OWNER = { bug: 'Billing', sum: 'Support inbox', reply: 'Support inbox' }
document.addEventListener('try:start', () => $$('.perch svg.bot').forEach((b, i) => setTimeout(() => { b.classList.remove('hop'); void b.getBBox(); b.classList.add('hop') }, i * 60)))
document.addEventListener('try:done', (e) => { const b = $(`.perch svg.bot[data-name="${OWNER[e.detail]}"]`); if (b) { b.classList.add('hop'); celebrate(b); setTimeout(() => b.classList.remove('hop'), 900) } })

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
const setModels = () => { const ms = MODELS[agent] || []; modelSel.innerHTML = ms.map((m) => `<option>${m}</option>`).join(''); modelSel.parentElement.classList.toggle('none', !ms.length) }
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

const model = () => NAMES[agent] + (modelSel.value ? ` · ${modelSel.value}` : '')
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
    s.notch({ right: { text: 'Sending' }, width: 340 }); say('Sent to a new ' + NAMES[agent] + ' session.')
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


new MutationObserver(() => $('.narr').classList.toggle('gone', s.notchEl.classList.contains('open') || s.notchEl.classList.contains('pocket'))).observe(s.notchEl, { attributes: true, attributeFilter: ['class'] })

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


// ── Bots: tasks find their bot, and new bots appear ──────────────────────────
{
  const card = $('.bcard'), list = $('.rail-list', card), words = $('.bs-words', card), cells = $$('.steps article')
  const fb = $('.bf-bot', card), fn = $('.bf-name', card), ft = $('.bf-tasks', card)
  const big = () => (innerWidth < 620 ? 100 : 150)
  const RUNS = { Billing: 'claude', 'Instagram growth': 'grok', 'iOS app': 'cursor', Fundraising: 'pi', 'Support inbox': 'codex', 'Chrome extension': 'opencode' }
  const START = [['Billing', 4], ['Instagram growth', 3], ['iOS app', 2], ['Fundraising', 1], ['Support inbox', 0]]
  const row = (n, c) => `<div class="rl" data-name="${n}">${bot(n, 30)}<span class="n">${n}</span><img class="rm" src="${MARK[RUNS[n]]}" alt=""><span class="c">${c}</span></div>`
  const total = () => $$('.rl[data-name] .c', list).reduce((a, c) => a + +c.textContent, 0)
  const paint = () => {
    list.innerHTML = `<div class="rl on">${puff(stack(START.map((r) => r[0]), 22), 22)}<span class="n">All bots</span><span class="c tot"></span></div>` + START.map(([n, c]) => row(n, c)).join('') + '<div class="rl un"><i class="dash"></i><span class="n">Unassigned</span><span class="c">0</span></div>'
    $('.tot', list).textContent = total(); liven(list)
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, reduced ? 0 : ms))
  const step = (i) => cells.forEach((c, k) => { c.classList.toggle('on', k === i); c.classList.toggle('done', k < i) })
  const focus = (name, tasks, { pop = false } = {}) => {
    fb.innerHTML = name ? bot(name, big(), 'lively' + (pop ? ' pop' : '')) : '<i class="bf-empty"></i>'
    fn.innerHTML = name ? `${name}<small class="bf-on"><img src="${MARK[RUNS[name]]}" alt="">${NAMES[RUNS[name]]}</small>` : '<span>Finding the right bot…</span>'
    ft.innerHTML = tasks.map((t, i) => `<span class="bf-t${i === 0 && pop ? ' fresh' : ''}">${t}</span>`).join('')
    liven(card); return fb.querySelector('svg.bot')
  }
  const say = async (text) => {
    words.innerHTML = text.split(' ').map((w) => `<span>${w}</span>`).join(' ')
    card.classList.add('talking')
    for (const sp of words.querySelectorAll('span')) { sp.classList.add('in'); await sleep(240) }
    await sleep(500)
  }
  const fly = async (text, target) => {
    const f = words.getBoundingClientRect(), t = target.getBoundingClientRect(), b = card.getBoundingClientRect()
    const c = document.createElement('span'); c.className = 'chipfly'; c.textContent = text
    c.style.left = f.left - b.left + f.width / 2 + 'px'; c.style.top = f.top - b.top + f.height / 2 + 'px'
    card.append(c); card.classList.remove('talking'); await sleep(40)
    c.style.transform = `translate(${t.left - f.left - f.width / 2 + 60}px,${t.top - f.top - f.height / 2 + t.height / 2}px) scale(.35)`; c.style.opacity = '0'
    await sleep(700); c.remove()
  }
  const bump = (r) => { const c = $('.c', r); c.textContent = +c.textContent + 1; r.classList.add('hit'); setTimeout(() => r.classList.remove('hit'), 900); $('.tot', list).textContent = total() }
  let vis = false, on = false
  const BIL = ['Move to Stripe Tax', 'Ship usage-based pricing']
  const loop = async () => {
    if (on) return; on = true
    while (vis) {
      paint(); step(0); words.innerHTML = ''; focus('Billing', BIL); await sleep(1100)
      await say('Fix the VAT rounding bug on EU orders before Friday’s release.')
      step(1); const co = $('.rl[data-name="Billing"]', list)
      focus(null, []); await sleep(500); await fly('Fix VAT rounding on EU orders', co); bump(co)
      $('svg.bot', co).dataset.mood = 'working'
      focus('Billing', ['Fix VAT rounding on EU orders', ...BIL], { pop: true }).dataset.mood = 'working'
      await sleep(2200)
      step(0); await say('Start a Chrome extension that saves tweets to Notion.')
      step(2); focus(null, []); await sleep(700)
      const h = document.createElement('div'); h.innerHTML = row('Chrome extension', 0); const nr = h.firstElementChild; nr.classList.add('new')
      $('.rl.un', list).before(nr); liven(list); await sleep(450)
      await fly('Start the Chrome extension', nr); bump(nr); celebrate($('svg.bot', nr))
      celebrate(focus('Chrome extension', ['Start the Chrome extension'], { pop: true }))
      await sleep(1700)
      const cs = $('svg.bot', co); cs.dataset.mood = 'idle'; celebrate(cs)
      await sleep(1100); celebrate(focus('Billing', ['Fixed VAT rounding on EU orders ✓', ...BIL]))
      await sleep(3000)
    }
    on = false
  }
  new IntersectionObserver(([e]) => { vis = e.isIntersecting; if (vis) loop() }, { threshold: 0.3 }).observe(card)
  paint(); focus('Billing', BIL)
}

// ── One place for all your agents: the pill cycles through them ──────────────
{
  const card = $('.agcard'), who = $('.ag-who', card), words = $('.ag-words', card), btns = $$('.dock button', card)
  const LINE = { claude: 'Fix the failing tests on main.', codex: 'Open a PR for the CSV export.', muse: 'Draft this week’s release notes.', opencode: 'Refactor the auth middleware.', pi: 'Add rate limits to the public API.', grok: 'Find out why staging is slow.', cursor: 'Build this settings page.' }
  let i = 0, auto = true, vis = false, run = 0
  const sl = (ms) => new Promise((r) => setTimeout(r, ms))
  const show = async (k) => {
    const me = ++run; i = k; const a = btns[k].dataset.agent
    btns.forEach((b, n) => b.classList.toggle('on', n === k))
    $('img', who).src = MARK[a]; $('b', who).textContent = NAMES[a]
    words.innerHTML = LINE[a].split(' ').map((w) => `<span>${w}</span>`).join(' ')
    for (const s of $$('span', words)) { if (me !== run) return; s.classList.add('in'); await sl(reduced ? 0 : 150) }
  }
  btns.forEach((b, k) => b.addEventListener('click', () => { auto = false; show(k) }))
  new IntersectionObserver(([e]) => { vis = e.isIntersecting }, { threshold: .3 }).observe(card)
  setInterval(() => { if (vis && auto) show((i + 1) % btns.length) }, 2800)
  show(0)
}

// ── A wall of real requests ──────────────────────────────────────────────────
{
  const L = 'assets/logos/'
  const A = [
    [L + 'slack-color.svg', 'Slack · #bugs', 'Find what broke EU checkout and open a PR.', 'Billing', 'PR #812 opened, 41 tests pass'],
    [L + 'figma-color.svg', 'Figma · Pricing v3', 'Build this pricing page in our Next.js app.', 'Pricing page', 'Built from the screenshot, PR #815'],
    [L + 'gmail-color.svg', 'Gmail · Refunds', 'Draft replies to these three refund requests.', 'Support inbox', '3 drafts ready in Gmail'],
    [L + 'term.svg', 'Terminal', 'Tests are failing on main. Find out why and fix them.', 'Infra', 'Fixed a timezone bug in 2 tests'],
    [L + 'linear.svg', 'Linear · Backlog', 'Take this ticket. Rate limit the public API.', 'Public API', 'Moved to In Progress, branch created'],
    [L + 'notion.svg', 'Notion · Investor memo', 'Add the Q3 numbers to the investor memo.', 'Fundraising', 'Memo updated with 3 charts'],
    [L + 'slack-color.svg', 'Slack · #launch', 'Turn this thread into Linear issues with owners.', 'Product launch', '8 issues created, linked in the thread'],
    [L + 'github.svg', 'GitHub · Pull request', 'Tell the onboarding session to reuse the auth helper.', 'Onboarding', 'Sent to the running session'],
    [L + 'meet.svg', 'Meeting notes', 'Add the decisions from that call to the onboarding session.', 'Onboarding', '4 decisions added'],
    [L + 'chrome-color.svg', 'Chrome · Competitor page', 'Research how competitors price team plans.', 'Pricing page', 'Comparison of 6 competitors'],
    [L + 'notion.svg', 'Notion · Content plan', 'Plan next week’s Reels from this doc.', 'Instagram growth', '6 Reels scripted'],
    [L + 'github.svg', 'Worktrees', 'Start the CSV export in a new worktree off main.', 'Data pipeline', 'New worktree, csv-export branch'],
  ]
  const card = ([src, where, q, b, r], dup) => `<article class="ask${dup ? ' dup' : ''}"><div class="ask-h"><img src="${src}" alt="">${where}</div><q>${q}</q><div class="ask-r">${bot(b, 26, '')}<span><b>${b}</b> · ${r}</span></div></article>`
  $('.wall').innerHTML = [0, 1, 2].map((c) => { const items = A.filter((_, i) => i % 3 === c); return `<div class="col" style="--t:${[46, 58, 52][c]}s">${items.map((x) => card(x)).join('')}${items.map((x) => card(x, true)).join('')}</div>` }).join('')
}

// ── The closing prompt types itself ──────────────────────────────────────────
{
  const t = $('.ask-t'), lines = ['Fix the failing tests on main and open a PR', 'Draft replies to this week’s refund requests', 'Build this pricing page from the Figma frame', 'Turn this Slack thread into Linear issues']
  $('.last-bot').innerHTML = bot('Everything', 84)
  let i = 0
  const sl = (ms) => new Promise((r) => setTimeout(r, ms))
  ;(async () => { if (reduced) { t.textContent = lines[0]; return } for (;;) { const s = lines[i++ % lines.length]; for (let k = 1; k <= s.length; k++) { t.textContent = s.slice(0, k); await sl(38) } await sl(2000); for (let k = s.length; k >= 0; k -= 2) { t.textContent = s.slice(0, k); await sl(14) } await sl(300) } })()
}

// ── The ending: black like the notch, every bot watching the ball ────────────
{
  const stage = $('.g-stage'), ball = $('.ball')
  const size = Math.round(Math.min(216, ball.offsetWidth * .58))
  $('.ball-bot').innerHTML = `<span class="bob">${bot('Everything', size)}</span>`
  const PEEK = [['Billing', 7.5, 92], ['iOS app', 22.5, 82], ['Instagram growth', 35, 96], ['Support inbox', 47, 78], ['SEO', 60, 88], ['Fundraising', 85, 90]]
  $('.g-peek').innerHTML = PEEK.map(([n, x, z]) => `<span class="pk" style="--x:${x}%;--z:min(${z}px,${(z / 13).toFixed(1)}vw)">${bot(n, z)}</span>`).join('')
  const FLOAT = [['Client website', 15, 62, 118, 1, 12, 0], ['Public API', 3.5, 28, 88, 1, 18, 1.1], ['Data pipeline', 75, 63, 124, 1, -14, .5], ['Hiring', 91, 24, 92, 1, 16, 1.6], ['Pricing page', 37, 74, 80, .95, -8, 2], ['Infra', 60, 75, 74, .95, 9, .8], ['Docs', 3, 72, 66, .55, 26, 1.4], ['Onboarding', 93, 67, 62, .55, -24, .3]]
  $('.g-tiles').innerHTML = FLOAT.map(([n, x, y, z, o, p, d]) => `<span class="fl" style="--x:${x}%;--y:${y}%;--z:min(${z}px,${(z / 13).toFixed(1)}vw);--o:${o};--p:${p};--d:${d}s"><span class="bob">${bot(n, z)}</span></span>`).join('')
  liven(stage)
  const watchers = $$('.pk svg.bot,.fl svg.bot', stage)
  let tx = 0, x = 0, seen = false
  addEventListener('pointermove', (e) => {
    const r = stage.getBoundingClientRect(); if (e.clientY < r.top - 100 || e.clientY > r.bottom + 100) return
    const nx = (e.clientX - r.left) / r.width - .5, ny = (e.clientY - r.top) / r.height - .5
    tx = nx * r.width * .52; stage.style.setProperty('--mx', nx.toFixed(3)); stage.style.setProperty('--my', ny.toFixed(3))
  }, { passive: true })
  new IntersectionObserver(([e]) => { seen = e.isIntersecting }).observe(stage)
  const tick = () => {
    if (seen && !reduced) {
      x += (tx - x) * .07; ball.style.transform = `translateX(${x.toFixed(1)}px)`
      const b = ball.getBoundingClientRect(), bx = b.left + b.width / 2, by = b.top + b.height / 2
      for (const w of watchers) {
        const r = w.getBoundingClientRect(), s = r.width, dx = bx - (r.left + s / 2), dy = by - (r.top + s / 2), dist = Math.max(1, Math.hypot(dx, dy))
        w.querySelector('.bot-look').style.transform = `translate(${(dx / dist * s * .11 * 28 / 28).toFixed(2)}px,${(dy / dist * s * .08).toFixed(2)}px)`
        const pk = w.closest('.pk'); if (pk) pk.classList.toggle('near', Math.abs(dx) < b.width * .62)
      }
    }
    requestAnimationFrame(tick)
  }
  tick()
}

// Everything fades up once as it arrives.
{
  const els = $$('.split,.three,.bcard,.tabs,.frame.slim,#uses h2,.wall,.left-sticky,.table,.vs3,.prices,.faqg,.post,.call,.last>*')
  els.forEach((e) => e.classList.add('rv'))
  const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target) } }), { rootMargin: '0px 0px -8% 0px' })
  els.forEach((e) => io.observe(e))
}
liven()
