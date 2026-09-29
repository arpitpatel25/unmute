// Locates the LIVE elements inside each captured asset, so the page can animate
// them in place over the helper's own pixels:
//   * waveform rows — the 11 (pill) or 7 (aimed chip) resting dots, which are
//     exactly the bars at their floor height (Waveform.swift: floor = barWidth)
//   * status dots on the bar — to breathe them (Dot: 1.2s, opacity → 0.42)
// Writes ../assets/ui/live.json: { asset: { wave?: {x, y, count, barW, gap, h}, dots?: [{x,y,r}] } } in points.
import { chromium } from '@playwright/test'
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'

const dir = new URL('../assets/ui/', import.meta.url).pathname
const files = readdirSync(dir).filter((f) => f.endsWith('.png'))
const b = await chromium.launch({ channel: 'chrome' })
const p = await b.newPage()
await p.setContent('<canvas id=c></canvas>')
const out = {}
for (const f of files) {
  const r = await p.evaluate(async (src) => {
    const i = await new Promise((res) => { const im = new Image(); im.onload = () => res(im); im.src = 'data:image/png;base64,' + src })
    const c = document.getElementById('c'); c.width = i.width; c.height = i.height
    const x = c.getContext('2d'); x.drawImage(i, 0, 0)
    const { data, width: W, height: H } = x.getImageData(0, 0, i.width, i.height)
    const px = (xx, yy) => { const k = (yy * W + xx) * 4; return [data[k], data[k + 1], data[k + 2], data[k + 3]] }
    const white = (v) => v[3] > 200 && v[0] > 200 && v[1] > 200 && v[2] > 200
    // WAVEFORM: scan every row for a run of 7 or 11 white blobs of equal width
    // at equal pitch, bounded by black. Keep the best-matching row.
    let wave = null
    for (let y = 0; y < H && !wave; y++) {
      if (y % 1) continue
      const runs = []
      let s = -1
      for (let xx = 0; xx <= W; xx++) {
        const w = xx < W && white(px(xx, y))
        if (w && s < 0) s = xx
        if (!w && s >= 0) { runs.push([s, xx - 1]); s = -1 }
      }
      for (const n of [11, 7]) {
        for (let k = 0; k + n <= runs.length; k++) {
          const g = runs.slice(k, k + n)
          const widths = g.map(([a, z]) => z - a + 1)
          const pitch = g.slice(1).map(([a], j) => a - g[j][0])
          // EXACT source geometry only (2x px): pill 11 × 3pt @ 5.5pt pitch;
          // AimedChip compact 7 × 2pt @ 3.5pt pitch. Anything else is text.
          const want = n === 11 ? { w: 6, p: 11 } : { w: 4, p: 7 }
          const ok = widths.every((v) => Math.abs(v - want.w) <= 1) &&
            pitch.every((v) => Math.abs(v - want.p) <= 1)
          if (ok) {
            // Vertical extent of the first dot, from this row down.
            let y2 = y; while (y2 + 1 < H && white(px(g[0][0] + 1, y2 + 1))) y2++
            wave = { x0: g[0][0], x1: g[n - 1][1], y0: y, y1: y2, count: n, pitch: (g[n - 1][0] - g[0][0]) / (n - 1) }
            break
          }
        }
        if (wave) break
      }
    }
    // STATUS DOTS: systemGreen (processing) blobs, for breathing.
    const green = (v) => v[3] > 200 && v[1] > 150 && v[0] < 110 && v[2] < 140
    let gx = 0, gy = 0, gn = 0, minx = 1e9, maxx = -1
    for (let y = 0; y < H; y++) for (let xx = 0; xx < Math.min(W, 4000); xx++) if (green(px(xx, y))) { gx += xx; gy += y; gn++; minx = Math.min(minx, xx); maxx = Math.max(maxx, xx) }
    return { W, H, wave, green: gn > 60 && gn < 400 && maxx - minx >= 12 && maxx - minx <= 16 ? { cx: gx / gn, cy: gy / gn, d: maxx - minx + 1 } : null }
  }, readFileSync(dir + f).toString('base64'))
  const e = {}
  if (r.wave) {
    const w = r.wave
    e.wave = { x: w.x0 / 2, cy: (w.y0 + w.y1 + 1) / 4, count: w.count, pitch: w.pitch / 2, barW: (w.y1 - w.y0 + 1) / 2 }
  }
  if (r.green) e.dot = { cx: (r.green.cx + 0.5) / 2, cy: (r.green.cy + 0.5) / 2, d: r.green.d / 2 }
  if (e.wave || e.dot) out[f.replace(/\.png$/, '')] = e
}
writeFileSync(dir + 'live.json', JSON.stringify(out, null, 1))
await b.close()
for (const [k, v] of Object.entries(out)) console.log(k.padEnd(28), JSON.stringify(v))
