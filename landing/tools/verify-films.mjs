// Behaviour checks for the demos: start speed, chapters, replay, pause/play,
// restart on return, reduced motion. Run with the preview server on :4194.
//   node landing/tools/verify-films.mjs [url]
import { chromium } from 'playwright'
const URL = process.argv[2] || 'http://127.0.0.1:4194/landing/'
const b = await chromium.launch({ channel: 'chrome' })
const errs = []
let failed = 0
const check = (name, ok, extra = '') => { if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`) }
const open = async (opts = {}) => {
  const p = await b.newPage({ viewport: { width: 1440, height: 900 }, ...opts })
  p.on('pageerror', (e) => errs.push(e.message))
  p.on('console', (m) => m.type() === 'error' && errs.push(m.text()))
  await p.goto(URL + '?v=' + Date.now()); await p.waitForTimeout(1200)
  return p
}
const state = (p, n) => p.evaluate((n) => {
  const h = document.querySelector(`[data-stage="${n}"]`), ctl = h.closest('.demo, .hero-demo').querySelector('.film-ctl')
  return { sub: document.querySelector(`[data-said="${n}"]`).textContent,
    notch: h.querySelector('.slot[data-role="notch"] .pane.on')?.dataset.key || null,
    pill: h.querySelector('.slot[data-role="pill"] .pane.on')?.dataset.key || null,
    toggle: ctl.querySelector('.toggle').textContent, progress: +(ctl.querySelector('.track i').style.transform.match(/[\d.]+/)?.[0] ?? 0) }
}, n)
const scrollTo = (p, sel) => p.evaluate((s) => document.querySelector(s).scrollIntoView({ block: 'center', behavior: 'instant' }), sel)

let p = await open()
// 1. A section demo acts within about a second of coming into view.
await scrollTo(p, '#start .demo')
const t0 = Date.now(); const first = await state(p, 'start')
let acted = 0
while (Date.now() - t0 < 4000) { const s = await state(p, 'start'); if (s.notch !== first.notch || s.pill !== first.pill) { acted = Date.now() - t0; break } await p.waitForTimeout(50) }
check('section demo acts within ~1.3s of scrolling to it', acted > 0 && acted < 1300, `${acted}ms`)
// 2. Pause holds still and the button says Play.
await p.click('#start .film-ctl .toggle'); const a = await state(p, 'start'); await p.waitForTimeout(1500); const a2 = await state(p, 'start')
check('pause holds the demo still', a.progress === a2.progress && a2.toggle === 'Play', `${a.progress} → ${a2.progress}, button "${a2.toggle}"`)
// 3. Replay starts it again from the beginning and plays.
await p.click('#start .film-ctl .replay'); await p.waitForTimeout(300); const r = await state(p, 'start')
check('replay restarts and plays', r.progress < 0.1 && r.toggle === 'Pause', `progress ${r.progress.toFixed(2)}, button "${r.toggle}"`)
// 4. Leaving and coming back starts from the beginning.
await p.waitForTimeout(3000); await scrollTo(p, 'footer'); await p.waitForTimeout(400); await scrollTo(p, '#start .demo'); await p.waitForTimeout(300)
const back = await state(p, 'start')
check('returning to a demo starts it over', back.progress < 0.15, `progress ${back.progress.toFixed(2)}`)
// 5. Hero chapters still jump.
await scrollTo(p, '.hero-demo'); await p.click('.chapters li:nth-child(3) button'); await p.waitForTimeout(400)
const h = await state(p, 'hero')
check('hero chapter 3 shows the question', h.notch === 'onb-ask.notch', h.notch)
await p.close()

// 6. Reduced motion: every demo starts paused on a still; Play runs it.
p = await open({ reducedMotion: 'reduce' })
const names = ['hero', 'why', 'start', 'capture', 'agent', 'attention', 'meet', 'dictate']
const stills = []
for (const n of names) stills.push(await state(p, n))
check('reduced motion: every demo paused with a frame on screen', stills.every((s) => s.toggle === 'Play' && (s.notch || s.pill || s.sub)), stills.map((s) => s.notch || s.pill || '—').join(', '))
await scrollTo(p, '#agent .demo'); await p.click('#agent .film-ctl .toggle'); await p.waitForTimeout(1500)
check('reduced motion: Play still plays', (await state(p, 'agent')).toggle === 'Pause')
await p.close()

check('no console errors', errs.length === 0, errs.join(' | '))
await b.close()
process.exit(failed ? 1 : 0)
