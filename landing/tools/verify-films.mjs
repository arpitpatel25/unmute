import { chromium } from 'playwright'
const b = await chromium.launch({ channel: 'chrome' })
const errs = []
const run = async (opts) => {
  const p = await b.newPage({ viewport: { width: 1440, height: 900 }, ...opts })
  p.on('pageerror', (e) => errs.push(e.message))
  p.on('console', (m) => m.type() === 'error' && errs.push(m.text()))
  await p.goto('http://127.0.0.1:4194/landing/?v=' + Date.now()); await p.waitForTimeout(1000)
  await p.evaluate(() => document.querySelector('.hero-demo').scrollIntoView({ block: 'center', behavior: 'instant' }))
  return p
}
const state = (p, sel = 'hero') => p.evaluate((n) => {
  const h = document.querySelector(`[data-stage="${n}"]`)
  return { sub: document.querySelector(`[data-said="${n}"]`).textContent, notch: h.querySelector('.slot[data-role="notch"] .pane.on')?.dataset.key || null,
    pill: h.querySelector('.slot[data-role="pill"] .pane.on')?.dataset.key || null, on: [...document.querySelectorAll('.chapters button')].findIndex((x) => x.classList.contains('on')) }
}, sel)
let p = await run()
await p.click('.chapters li:nth-child(3) button'); await p.waitForTimeout(400)
console.log('after ch3 click', await state(p))
await p.waitForTimeout(12500)
console.log('after wrap', await state(p))
await p.click('.rot-pause'); const a = await state(p); await p.waitForTimeout(3000); console.log('paused stable', JSON.stringify(a) === JSON.stringify(await state(p)), await p.textContent('.rot-pause'))
await p.click('.chapters li:nth-child(2) button'); await p.waitForTimeout(300); console.log('ch2 while paused', await state(p))
await p.close()
p = await run({ reducedMotion: 'reduce' })
await p.waitForTimeout(2000)
for (const n of ['hero', 'why', 'start', 'capture', 'agent', 'attention', 'meet', 'dictate']) console.log('reduced', n, await state(p, n))
console.log('errors', errs)
await b.close()
