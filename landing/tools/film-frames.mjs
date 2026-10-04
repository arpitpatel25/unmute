// Save frames of a demo at given seconds: node film-frames.mjs <url> <out-prefix> '<sel>|<sel>' 1,3.5 [w h]
import { chromium } from 'playwright'
const [url, out, sels, times, vw = '1440', vh = '900'] = process.argv.slice(2)
const b = await chromium.launch({ channel: 'chrome' })
const p = await b.newPage({ viewport: { width: +vw, height: +vh } })
p.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('console:', m.text()) })
p.on('pageerror', (e) => console.log('pageerror:', e.message))
await p.goto(url); await p.waitForTimeout(800)
for (const sel of sels.split('|')) {
  await p.evaluate(([s, block]) => document.querySelector(s).scrollIntoView({ block, behavior: 'instant' }), [sel, process.env.BLOCK || 'center'])
  const t0 = Date.now()
  for (const t of times.split(',').map(Number)) {
    const wait = t * 1000 - (Date.now() - t0); if (wait > 0) await p.waitForTimeout(wait)
    await p.screenshot({ path: `${out}-${sel.replace(/\W/g, '')}-${t}.png` })
  }
}
await b.close()
