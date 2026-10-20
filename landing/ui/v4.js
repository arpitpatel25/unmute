// UNMUTE v4 — the playable hero. The same kit as the live page, but driven by
// the visitor: pick a task, pick Claude Code or Codex and a model, then press
// right ⌥ (the real key works too). The session comes back in the notch, and
// its buttons are real.
import { Screen, panel, MARK } from './kit.js'
import { slack, skMsg, skReact } from './apps.js'

const $ = (s, r = document) => r.querySelector(s)
const $$ = (s, r = document) => [...r.querySelectorAll(s)]
const add = (root, html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); const n = t.content.firstElementChild; root.append(n); return n }

// The menu-bar notch: a status for wherever you are on the page, like the app.
{
  const n = $('.page-notch'), t = $('.pn-t')
  const states = [['.hero2', 'Listening', 'live'], ['#try', 'Working', 'live'], ['#keys', 'Working', 'live'], ['#price', 'Needs you', 'needs'], ['#compare', 'Working', 'live'], ['#faq', 'Working', 'live'], ['#get', 'Done', 'done']]
  const io = new IntersectionObserver((es) => es.forEach((e) => {
    if (!e.isIntersecting) return
    const st = states.find(([sel]) => e.target.matches(sel)); if (!st) return
    t.textContent = st[1]; n.dataset.s = st[2]
  }), { rootMargin: '-45% 0px -50% 0px' })
  states.forEach(([sel]) => { const el = $(sel); el && io.observe(el) })
  n.addEventListener('click', () => $('#try').scrollIntoView({ behavior: 'smooth' }))
}

// How it works: pick a key, see it; it cycles on its own until you pick one.
{
  const items = $$('.k-list li'), views = $$('.k-view .viz')
  let i = 0, auto = true, timer
  const show = (k) => { i = k; items.forEach((li, j) => li.classList.toggle('on', j === k)); views.forEach((v) => v.classList.toggle('on', v.dataset.v === items[k].dataset.k)) }
  items.forEach((li, k) => li.addEventListener('click', () => { auto = false; show(k) }))
  const tick = () => { if (auto) show((i + 1) % items.length) }
  new IntersectionObserver(([e]) => { clearInterval(timer); if (e.isIntersecting) timer = setInterval(tick, 4200) }, { threshold: 0.3 }).observe($('#keys'))
  show(0)
}

// The finale: the notch drops down and opens when you reach it.
new IntersectionObserver(([e], o) => { if (e.isIntersecting) { e.target.classList.add('in'); o.disconnect() } }, { threshold: 0.4 }).observe($('.finale'))

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
