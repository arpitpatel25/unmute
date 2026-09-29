// Turns raw helper captures into page assets.
//
// For every shot and window:
//   * GLASS-CORRECT PIXELS: the on-screen region capture (which includes the live
//     behind-window blur of the page's wallpaper) is cut out with the window
//     capture's own alpha, so the result is exact inside the shape and
//     transparent outside it.
//   * CROPPED to the inked bounds, and its position recorded in SCREEN POINTS
//     on the 1440×900 stage, so the page places it exactly where the helper did.
// Output: ../assets/ui/<shot>.<notch|pill>.png + ../assets/ui/manifest.json
import { chromium } from '@playwright/test'
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const capRoot = new URL('../captures/', import.meta.url).pathname
const outDir = new URL('../assets/ui/', import.meta.url).pathname
mkdirSync(outDir, { recursive: true })
const manifestPath = join(outDir, 'manifest.json')
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {}

const runs = process.argv.slice(2)
const b = await chromium.launch({ channel: 'chrome' })
const page = await b.newPage()
await page.setContent('<canvas id=c></canvas>')

for (const run of runs) {
  const dir = join(capRoot, run)
  const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
  const windows = m.captures.filter((c) => !c.region)
  for (const w of windows) {
    const region = m.captures.find((c) => c.region && c.shot === w.shot && c.id === w.id)
    const role = w.y === 0 ? 'notch' : 'pill'
    const b64 = (f) => readFileSync(join(dir, f)).toString('base64')
    const res = await page.evaluate(async ({ win, reg, bottomAnchored }) => {
      const load = (s) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = 'data:image/png;base64,' + s })
      const wi = await load(win)
      const W = wi.width, H = wi.height
      const c = document.getElementById('c'); c.width = W; c.height = H
      const x = c.getContext('2d')
      x.clearRect(0, 0, W, H)
      if (reg) {
        const ri = await load(reg)
        x.drawImage(ri, 0, 0, W, H)
        x.globalCompositeOperation = 'destination-in'
        x.drawImage(wi, 0, 0)
        x.globalCompositeOperation = 'source-over'
      } else {
        x.drawImage(wi, 0, 0)
      }
      const d = x.getImageData(0, 0, W, H).data
      let minX = W, minY = H, maxX = -1, maxY = -1
      for (let y = 0; y < H; y++) for (let xx = 0; xx < W; xx++) {
        if (d[(y * W + xx) * 4 + 3] > 2) { if (xx < minX) minX = xx; if (xx > maxX) maxX = xx; if (y < minY) minY = y; if (y > maxY) maxY = y }
      }
      if (maxX < 0) return null
      // Even pixel bounds so 2x → points stays integral.
      minX -= minX % 2; minY -= minY % 2; maxX += (maxX % 2 ? 0 : 1); maxY += (maxY % 2 ? 0 : 1)
      const cw = maxX - minX + 1, ch = maxY - minY + 1
      const o = document.createElement('canvas'); o.width = cw; o.height = ch
      o.getContext('2d').drawImage(c, minX, minY, cw, ch, 0, 0, cw, ch)
      return { png: o.toDataURL('image/png').split(',')[1], minX, minY, cw, ch, W, H }
    }, { win: b64(w.file), reg: region && role === 'notch' ? b64(region.file) : null })
    if (!res) continue
    const name = `${w.shot}.${role}`
    writeFileSync(join(outDir, `${name}.png`), Buffer.from(res.png, 'base64'))
    manifest[name] = { x: w.x + res.minX / 2, y: w.y + res.minY / 2, w: res.cw / 2, h: res.ch / 2, run, source: 'unmute-notch @ unmute-cloud db2a2016' }
  }
}
writeFileSync(manifestPath, JSON.stringify(manifest, null, 1))
await b.close()
console.log(Object.keys(manifest).length, 'assets in manifest')
