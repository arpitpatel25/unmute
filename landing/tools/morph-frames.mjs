// Film a surface morph frame by frame: node morph-frames.mjs <out-prefix> <from> <to> [role]
import { chromium } from 'playwright'
const [out, from, to, role = 'notch'] = process.argv.slice(2)
const b = await chromium.launch({ channel: 'chrome' })
const p = await b.newPage({ viewport: { width: 1440, height: 1000 } })
p.on('pageerror', (e) => console.log('pageerror', e.message))
await p.goto('http://127.0.0.1:4194/landing/?m=' + Date.now()); await p.waitForTimeout(1200)
await p.click('.rot-pause')
await p.evaluate(() => document.querySelector('.hero-demo').scrollIntoView({ block: 'start', behavior: 'instant' }))
await p.waitForTimeout(300)
// Grab the hero stage, park the camera wide, and drive the swap by hand.
await p.evaluate(([from, role]) => {
  const st = window.__heroStage; st.instant = true; st.set('notch', null); st.set('pill', null); st.set(role, from === 'null' ? null : from); st.instant = false
  const cam = document.querySelector('[data-stage="hero"] .cam'); gsap.killTweensOf(cam); gsap.set(cam, { x: role === 'notch' ? -720 * 0.6 : -720 * 0.6, y: role === 'notch' ? 0 : -900 * 0.6 * 0.9, scale: 1.6 })
}, [from, role])
await p.waitForTimeout(400)
await p.evaluate(([to, role]) => window.__heroStage.set(role, to === 'null' ? null : to), [to, role])
const t0 = Date.now()
for (let i = 0; i < 9; i++) {
  await p.locator('[data-stage="hero"]').screenshot({ path: `${out}-${i}.png` })
  console.log(i, Date.now() - t0, 'ms')
}
await b.close()
