// THE SCENES — each one task, start to finish, told by the UI alone.
//
// Pacing rules (see kit.js): words appear at speaking speed; every result is
// held long enough to read (readMs); nothing on screen changes faster than
// about a second. Each scene resets itself at the top, so loops are clean.
import { panel, readMs, MARK, sound } from './kit.js'
import { slack, skMsg, skReact, skReplies, linear, figma, github, gmail, docs, terminal, av } from './apps.js'

const $ = (root, s) => root.querySelector(s)
const add = (root, html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); const n = t.content.firstElementChild; root.append(n); return n }

// ── HERO · Slack: a bug report becomes a merged fix ──────────────────────────
// 1 A bug comes in · 2 You say it · 3 It works · 4 It asks you · 5 Done
export async function hero(s, step) {
  s.menu('Slack'); s.time('Tue 9:41 AM'); s.notch(); s.hideCursor()
  const w = s.window(slack({ channel: 'bugs' }))
  const msgs = $(w, '.sk-msgs')
  add(msgs, skMsg('dev', '9:12 AM', 'Release <b>2026.10.17</b> is out 🚀 checkout, invoices and the new onboarding.', skReact([['🚀', 6], ['🎉', 3]])))
  add(msgs, skMsg('jon', '9:20 AM', 'Heads up: staging DB restarts at noon, ~5 min of downtime.', skReact([['👍', 4]])))
  step(0)
  await s.wait(900)
  const bug = add(msgs, skMsg('maya', '9:41 AM', '<span class="men">@here</span> Checkout is failing for EU customers since this morning’s release 😬 40+ tickets so far. Can someone take a look?', skReact([['👀', 3], ['🙏', 2]])))
  bug.classList.add('new', 'hl')
  await s.wait(3600)

  step(1)
  await s.tap()
  await s.speak('Find what broke EU checkout since this morning’s release, fix it, and open a PR.')

  step(2)
  s.notch({ right: { text: 'Sending', dot: 'green' }, width: 340 })
  await s.wait(1100)
  s.notch({ right: { text: 'Working', n: 1 }, width: 380 })
  await s.wait(900)
  // You carry on in Slack while it works.
  const comp = $(w, '.sk-comp .ph')
  await s.to(comp, 800, 0.3, 0.5); await s.click()
  comp.classList.add('typing'); comp.textContent = ''
  for (const ch of 'On it, a fix is in progress 👀') { comp.textContent += ch; await s.wait(42) }
  await s.wait(350)
  comp.classList.remove('typing'); comp.textContent = 'Message #bugs'
  const mine = add(msgs, skMsg('you', '9:43 AM', 'On it, a fix is in progress 👀')); mine.classList.add('new')
  bug.classList.remove('hl')
  await s.wait(2200)

  step(3)
  s.hideCursor()
  s.notch({ size: [640, 336], panel: panel({ title: 'EU checkout bug', status: 'needs', body: `
    <span class="you">Find what broke EU checkout since this morning’s release, fix it, and open a PR.</span>
    <span class="step"><i></i>Read 23 files · ran the checkout tests</span>
    Found it: VAT rounding in <code>convertCurrency()</code>, changed in #802. Fixed it, <span class="ok">41 tests pass</span>, and opened <b>PR #812</b>.<br><b>Merge it?</b>`, actions: '<span class="primary">Merge</span><span>View diff</span>' }) })
  await s.wait(4800)
  await s.tap()
  await s.speak('Merge it and reply in the thread.')

  step(4)
  s.notch({ size: [640, 232], panel: panel({ title: 'EU checkout bug', status: 'done', body: `
    <span class="you">Merge it and reply in the thread.</span>
    <span class="step"><i></i>Merged <b>PR #812</b> into <code>main</code> · deploying</span>
    <span class="step"><i></i>Replied in <b>#bugs</b></span>` }) })
  await s.wait(1800)
  s.notch({ right: { text: 'Done', dot: 'grey' }, width: 330 })
  const fix = add(msgs, skMsg('you', '9:51 AM', 'Fixed in <b>#812</b>: VAT rounding in currency conversion. Deploying now ✅', skReact([['🙌', 4], ['🎉', 2]])))
  fix.classList.add('new')
  await s.wait(3800)
}
export function heroStill(s) {
  s.menu('Slack'); s.notch({ size: [640, 336], panel: panel({ title: 'EU checkout bug', status: 'needs', body: '<span class="you">Find what broke EU checkout since this morning’s release, fix it, and open a PR.</span>Found it: VAT rounding in <code>convertCurrency()</code>. Fixed, <span class="ok">41 tests pass</span>, PR #812 is open.<br><b>Merge it?</b>', actions: '<span class="primary">Merge</span><span>View diff</span>' }) })
  const w = s.window(slack({ channel: 'bugs' }))
  add($(w, '.sk-msgs'), skMsg('maya', '9:41 AM', '<span class="men">@here</span> Checkout is failing for EU customers since this morning’s release 😬 40+ tickets so far.'))
}

// ── WHERE: the same move, in six apps ────────────────────────────────────────
// Each is ~10 s: what's on screen → you say it → it starts (or is sent).
async function startWorking(s, agent, title, n = 1) {
  s.notch({ right: { text: 'Sending' }, width: 340 })
  await s.wait(1000)
  s.notch({ right: { text: 'Working', n }, width: 380 })
  await s.wait(2600)
}

export const apps = {
  async slack(s) {
    s.menu('Slack'); s.time('Tue 11:05 AM'); s.notch(); s.hideCursor()
    const w = s.window(slack({ channel: 'launch' }))
    const msgs = $(w, '.sk-msgs')
    add(msgs, skMsg('sam', '10:48 AM', 'Final pricing designs are in Figma 🎨', skReact([['🔥', 5]])))
    const m = add(msgs, skMsg('priya', '11:02 AM', 'Notes from launch planning are in this thread 👇 Can someone turn them into tickets?', skReplies(14, ['priya', 'dev', 'sam', 'jon'], 'Last reply 2 min ago')))
    m.classList.add('new', 'hl')
    await s.wait(3000)
    await s.tap()
    await s.speak('Turn this thread into Linear issues, with owners and due dates.', { agent: 'codex' })
    await startWorking(s, 'codex')
    s.notch({ size: [520, 236], panel: panel({ agent: 'codex', title: 'Launch tickets', status: 'ready', body: 'Created <b>8 issues</b> in Linear, <code>ORB-431</code> to <code>ORB-438</code>, each with an owner and a due date. Linked them in the thread.' }) })
    await s.wait(readMs('Created 8 issues in Linear, ORB-431 to ORB-438, each with an owner and a due date. Linked them in the thread.'))
  },
  async linear(s) {
    s.menu('Linear'); s.time('Tue 11:20 AM'); s.notch(); s.hideCursor()
    const w = s.window(linear())
    await s.wait(900)
    const row = $(w, '[data-id="ORB-418"]')
    await s.to(row.querySelector('.tt'), 800, 0.35); await s.click(row)
    await s.wait(1200)
    await s.tap()
    await s.speak('Take ORB-418. Limit each API key to 100 requests a minute.')
    await startWorking(s, 'claude')
    row.querySelector('.stc').className = 'stc progress'
    $(w, '.ln-det .kv b').innerHTML = '<span class="stc progress"></span>In Progress'
    await s.wait(2200)
  },
  async figma(s) {
    s.menu('Figma'); s.time('Tue 1:10 PM'); s.notch(); s.hideCursor()
    s.window(figma())
    await s.wait(1600)
    await s.grab(340, 132, 600, 480)
    await s.tap()
    await s.speak('Build this pricing page in our Next.js app. Match the spacing exactly.', { chip: '🖼️ Screenshot of “Pricing — Desktop” attached' })
    await startWorking(s, 'claude')
    await s.wait(1200)
  },
  async github(s) {
    s.menu('Google Chrome'); s.time('Tue 2:35 PM'); s.notch({ right: { text: 'Working', n: 2 }, width: 380 }); s.hideCursor()
    const w = s.window(github())
    await s.wait(1200)
    $(w, '.gh-cm').classList.add('hl')
    await s.wait(2400)
    // Open the pocket: every running session, right in the notch.
    await s.to(s.notchEl, 900, 0.7, 0.5); await s.click()
    const row = (t, a, cls = '') => `<div class="pk-row ${cls}"><img src="${MARK[a]}" alt=""><span class="t">${t}</span><span class="mic">● listening</span><span class="s"><i class="dot green"></i><span class="st working">Working</span></span></div>`
    s.notch({ pocket: true, size: [460, 150], panel: `<div class="pk-h"><span>Sessions</span><span>2 running</span></div>${row('Onboarding flow', 'claude')}${row('CSV export', 'codex')}` })
    await s.wait(1300)
    await s.to(s.notchEl.querySelector('.pk-row'), 600, 0.4); await s.click()
    s.notch({ pocket: true, size: [460, 150], panel: `<div class="pk-h"><span>Sessions</span><span>2 running</span></div>${row('Onboarding flow', 'claude', 'aim')}${row('CSV export', 'codex')}` })
    s.hideCursor()
    await s.wait(900)
    await s.tap('fn', 'hold fn, speak into this session', 1)
    await s.speak('Reuse exchangeAuthCode from lib/auth instead of calling the token endpoint yourself.', { key: 'fn' })
    s.release()
    s.notch({ pocket: true, size: [460, 150], panel: `<div class="pk-h"><span>Sessions</span><span>2 running</span></div><div class="pk-row"><img src="${MARK.claude}" alt=""><span class="t">Onboarding flow</span><span class="s ok-sent">✓ Sent</span></div>${row('CSV export', 'codex')}` })
    await s.wait(2200)
    s.notch({ right: { text: 'Working', n: 2 }, width: 380 })
    await s.wait(1600)
  },
  async gmail(s) {
    s.menu('Google Chrome'); s.time('Tue 3:50 PM'); s.notch(); s.hideCursor()
    const w = s.window(gmail())
    await s.wait(2600)
    await s.tap()
    await s.speak('Draft replies to these three refund requests, using our refund policy.', { agent: 'codex' })
    await startWorking(s, 'codex')
    s.notch({ size: [520, 214], panel: panel({ agent: 'codex', title: 'Refund replies', status: 'ready', body: '<b>3 drafts</b> are waiting in Gmail. Two refunds approved under the 30-day policy, one offered a credit instead.' }) })
    w.querySelectorAll('.gm-r.sel span').forEach((sp) => sp.insertAdjacentHTML('afterbegin', '<span class="draft">Draft</span>'))
    await s.wait(readMs('3 drafts are waiting in Gmail. Two refunds approved under the 30-day policy, one offered a credit instead.'))
  },
  async docs(s) {
    s.menu('Google Chrome'); s.time('Tue 4:30 PM'); s.notch(); s.hideCursor()
    s.window(docs())
    await s.wait(2400)
    await s.tap()
    await s.speak('Add automatic tax to our checkout, following this guide.', { chip: '🔗 docs.payments.dev/tax/calculate added' })
    await startWorking(s, 'claude')
    await s.wait(1000)
  },
}

// ── WHAT HAPPENS AFTER YOU SPEAK · five states, driven by scroll ─────────────
export function stages(s) {
  s.menu('Figma'); s.notch()
  s.window(figma())
  const say = s.sayEl, pill = s.pillEl
  const text = 'Build this pricing page in our Next.js app.'
  const showSay = (on) => {
    const t = say.querySelector('.us-t')
    if (on) { t.innerHTML = text.split(' ').map((w) => `<span>${w} </span>`).join(''); say.querySelector('.us-key').textContent = 'right ⌥'; say.classList.add('on') } else say.classList.remove('on')
  }
  const P = (status, body, actions) => ({ size: [560, 250], panel: panel({ title: 'Pricing page', status, body, actions }) })
  return [
    () => { showSay(true); pill.querySelector('.up-agent img').src = MARK.claude; pill.querySelector('.up-agent b').textContent = 'Claude Code'; pill.className = 'un-pill on listening'; s.keyEl.classList.add('on'); s.notch() },
    () => { showSay(false); s.keyEl.classList.remove('on'); pill.className = 'un-pill on done'; s.notch({ right: { text: 'Sending' }, width: 340 }) },
    () => { pill.className = 'un-pill'; showSay(false); s.notch({ right: { text: 'Working', n: 1 }, width: 380 }) },
    () => { pill.className = 'un-pill'; showSay(false); s.notch(P('needs', '<span class="you">Build this pricing page in our Next.js app.</span>Built <code>app/pricing/page.tsx</code> from the frame. The design has an annual toggle but no annual prices yet.<br><b>Use 20% off for annual?</b>', '<span class="primary">Yes</span><span>Show me</span>')) },
    () => { pill.className = 'un-pill'; showSay(false); s.notch(P('done', '<span class="you">Yes, 20% off.</span><span class="step"><i></i>Added annual prices · matched spacing to the frame</span><span class="step"><i></i>Opened <b>PR #815</b> with screenshots</span>')) },
  ]
}

// ── SEVERAL AT ONCE ──────────────────────────────────────────────────────────
export async function parallel(s) {
  s.menu('Linear'); s.notch(); s.window(linear())
  const asks = [
    ['Fix the EU checkout bug.', 'claude', 'EU checkout bug'],
    ['Add CSV export for invoices.', 'codex', 'CSV export'],
    ['Rate limit the public API.', 'claude', 'API rate limits'],
  ]
  const rows = []
  for (let i = 0; i < asks.length; i++) {
    const [text, agent] = asks[i]
    await s.tap()
    await s.speak(text, { agent })
    s.notch({ right: { text: 'Working', n: i + 1 }, width: 380 })
    await s.wait(900)
  }
  const row = ([, a, t], extra = '') => `<div class="pk-row enter"><img src="${MARK[a]}" alt=""><span class="t">${t}</span><span class="s">${extra || '<i class="dot green"></i><span class="st working">Working</span>'}</span></div>`
  s.notch({ pocket: true, size: [470, 196], panel: `<div class="pk-h"><span>Sessions</span><span>3 running</span></div>${asks.map((a) => row(a)).join('')}` })
  await s.wait(3600)
  s.notch({ pocket: true, size: [470, 196], panel: `<div class="pk-h"><span>Sessions</span><span>2 running · 1 ready</span></div>${row(asks[0], '<i class="dot teal"></i><span class="st ready">Ready</span>')}${row(asks[1])}${row(asks[2])}` })
  await s.wait(2600)
  s.notch()
  await s.wait(800)
}

// ── THE FULL FLOW · the real recording, rebuilt ──────────────────────────────
// One request start to finish, about a minute, with a narrator. The narration
// is also the caption under the film, so it works with the sound off.
// 0 A bug comes in · 1 The usual way · 2 You say it · 3 It works · 4 It asks you · 5 Done
export const FILM_LINES = [
  'A bug report comes in on Slack.',
  'Normally, you’d switch to Claude Code, find the session, and type it all out.',
  'With Unmute, you tap one key and say it.',
  'Unmute sends it to Claude Code.',
  'A new session starts in the notch and gets to work. You keep going in Slack.',
  'When it’s finished, it opens right where you are, and asks what’s next.',
  'You answer the same way.',
  'Done. Committed on a new branch. And you never left Slack.',
]
const ASK = 'Hey, can you investigate the checkout issue Maya just reported?'
const ANSWER = 'Yeah, can you please commit those changes in a new separate branch?'
let narration = null
function narrate(s, i) {
  const text = FILM_LINES[i]
  s.host.dispatchEvent(new CustomEvent('kit:narrate', { detail: text }))
  const line = sound.on && !s.clock.fast && sound.lines[text]
  if (line) { narration?.pause(); narration = new Audio(line.src); narration.play().catch(() => {}) }
  return s.wait(Math.max(readMs(text), line ? line.dur * 1000 + 450 : 0))
}
export function stopNarration() { narration?.pause() }

export async function film(s, step) {
  s.menu('Slack'); s.time('Wed 5:17 PM'); s.notch(); s.hideCursor()
  s.host.dispatchEvent(new CustomEvent('kit:narrate', { detail: '' }))
  const w = s.window(slack({ channel: 'bugs' }))
  const msgs = $(w, '.sk-msgs')
  add(msgs, skMsg('dev', '4:02 PM', 'Release <b>2026.10.14</b> is out: new billing page and Pro plan checkout 🚀', skReact([['🚀', 5]])))
  add(msgs, skMsg('jon', '4:40 PM', 'Reminder: design review moved to Thursday.', skReact([['👍', 3]])))

  step(0)
  await s.wait(700)
  const bug = add(msgs, skMsg('maya', '5:17 PM', '<span class="men">@here</span> A customer can’t buy the Pro plan. The app says <b>“Subscription inactive”</b> even though they’re signed in. Can someone take a look?', skReact([['👀', 2]])))
  bug.classList.add('new', 'hl')
  await narrate(s, 0)
  await s.wait(600)

  step(1)
  const usual = (async () => {
    await s.to($(s.screen, '.dk-term'), 900); await s.click($(s.screen, '.dk-term'))
    s.menu('Terminal')
    const t = document.createElement('div'); t.className = 'kit-win tm-win'; t.innerHTML = terminal(); s.windows.append(t)
    s.hideCursor()
    await s.wait(500)
    const tx = $(t, '.tx')
    for (const ch of 'there’s a bug in checkout, a customer can’t buy pro, the app says subscription inactive even though they’re signed in. maya posted it in #bugs, can you') { tx.textContent += ch; await s.wait(34) }
    return t
  })()
  const [, term] = await Promise.all([narrate(s, 1), usual])
  await s.wait(400)
  term.classList.add('out'); s.menu('Slack')
  await s.wait(500); term.remove()

  step(2)
  await narrate(s, 2)
  await s.tap()
  await s.speak(ASK)
  s.notch({ right: { text: 'Sending', dot: 'green' }, width: 340 })
  await narrate(s, 3)

  step(3)
  s.notch({ right: { text: 'Working', n: 1 }, width: 380 })
  const reply = (async () => {
    await s.wait(1200)
    const comp = $(w, '.sk-comp .ph')
    await s.to(comp, 800, 0.3, 0.5); await s.click()
    comp.classList.add('typing'); comp.textContent = ''
    for (const ch of 'Looking into it 👀') { comp.textContent += ch; await s.wait(45) }
    await s.wait(300)
    comp.classList.remove('typing'); comp.textContent = 'Message #bugs'
    add(msgs, skMsg('you', '5:18 PM', 'Looking into it 👀')).classList.add('new')
    bug.classList.remove('hl'); s.hideCursor()
  })()
  await Promise.all([narrate(s, 4), reply])
  await s.wait(1600)

  step(4)
  const found = `<span class="you">${ASK}</span>
    <span class="step"><i></i>Read 31 files · checked the billing logs · ran the checkout tests</span>
    <b>The bug:</b> when the billing check timed out, the app fell back to a cached plan, and that path always said “inactive”. Signed-in Pro customers saw the banner and couldn’t buy.<br>
    <b>What I changed:</b> <code>billing/status.ts</code> and <code>checkout/guard.ts</code>. <span class="ok">38 tests pass</span>.<br>
    <b>Want me to put them on a branch and commit?</b>`
  s.notch({ size: [720, 404], panel: panel({ title: 'Subscription inactive while signed in', status: 'needs', body: found, actions: '<span class="primary">Commit</span><span>View diff</span>' }) })
  await narrate(s, 5)
  await s.wait(3200)
  await narrate(s, 6)
  await s.tap()
  await s.speak(ANSWER)

  step(5)
  s.notch({ size: [720, 248], panel: panel({ title: 'Subscription inactive while signed in', status: 'done', body: `<span class="you">${ANSWER}</span>
    <span class="step"><i></i>Created branch <code>fix/subscription-inactive-banner</code></span>
    <span class="step"><i></i>Committed 2 files as <code>a41c9e2</code> · <code>main</code> untouched</span>` }) })
  await narrate(s, 7)
  s.notch({ right: { text: 'Done', dot: 'grey' }, width: 330 })
  await s.wait(3000)
}
export function filmStill(s) {
  s.menu('Slack')
  const w = s.window(slack({ channel: 'bugs' }))
  add($(w, '.sk-msgs'), skMsg('maya', '5:17 PM', '<span class="men">@here</span> A customer can’t buy the Pro plan. The app says <b>“Subscription inactive”</b> even though they’re signed in.'))
  s.notch({ size: [720, 248], panel: panel({ title: 'Subscription inactive while signed in', status: 'done', body: `<span class="you">${ANSWER}</span><span class="step"><i></i>Committed 2 files on <code>fix/subscription-inactive-banner</code></span>` }) })
}
