// Drives the REAL unmute-notch helper (built from unmute-cloud HEAD) with a
// fixture of JSONL commands, then captures each of its windows by id.
//
//   node native-capture.mjs <fixture.json> [outDir]
//
// fixture: { "fakeNotch": "200x34", "steps": [ { "send": [ {cmd}, ... ], "wait": 900, "shot": "name" }, ... ] }
// Every capture is the helper's own pixels (screencapture -l <windowId> -o), so
// nothing in the result is drawn by us.
import { spawn, execFileSync } from 'node:child_process'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, basename } from 'node:path'

const BIN = process.env.NOTCH_BIN || '/tmp/notch-src/desktop/native-notch/.build/release/unmute-notch'
const [fixturePath, outArg] = process.argv.slice(2)
// "$NOW" / "$NOW-42000" → epoch ms at run time, so turn timers read like a live session.
const fx = JSON.parse(readFileSync(fixturePath, 'utf8').replace(/"\$NOW(-?\d+)?"/g, (_, o) => String(Date.now() + Number(o || 0))))
const out = outArg || join(new URL('../captures', import.meta.url).pathname, basename(fixturePath, '.json'))
mkdirSync(out, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// BACKDROP: a borderless full-screen window showing the page's own wallpaper,
// above the menu bar and below the helper (tools/backdrop.swift), so glass
// panels blur exactly the pixels the visitor will see behind them.
let backdrop = null
if (fx.backdrop !== false) {
  backdrop = spawn('/tmp/backdrop', [new URL('./wallpaper@2x.png', import.meta.url).pathname], { stdio: 'ignore' })
  await sleep(1200)
}
const child = spawn(BIN, [], { env: { ...process.env, UNMUTE_FAKE_NOTCH: fx.fakeNotch ?? '200x34', CFFIXED_USER_HOME: '/tmp/notch-home' }, stdio: ['pipe', 'pipe', 'pipe'] })
const events = []
let ready
const isReady = new Promise((r) => (ready = r))
let buf = ''
child.stdout.on('data', (d) => {
  buf += d
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    try { const e = JSON.parse(line); events.push(e); if (e.type === 'ready') ready() } catch {}
  }
})
child.stderr.on('data', () => {})
const send = (cmd) => child.stdin.write(JSON.stringify(cmd) + '\n')

const bootstrap = { type: 'bootstrap', appearance: 'solid', surfaceTone: 'glass', surfaceFill: 0.8,
  showInScreenCapture: true, terminalAutoExpand: false, autoPresent: true }

await Promise.race([isReady, sleep(8000)])
send(fx.bootstrap ?? bootstrap)
send({ type: 'present' })
if (fx.fill) send({ type: 'surfaceFill', fill: fx.fill })
await sleep(800)
const manifest = []
for (const step of fx.steps) {
  for (const c of step.send ?? []) send(c)
  await sleep(step.wait ?? 900)
  if (!step.shot) continue
  const wins = JSON.parse(execFileSync('/tmp/listwin', [String(child.pid)]).toString())
  wins.forEach((w, k) => {
    const file = join(out, `${step.shot}--w${k}-${w.w}x${w.h}.png`)
    execFileSync('screencapture', ['-x', '-o', '-l', String(w.id), file])
    manifest.push({ shot: step.shot, file: basename(file), ...w })
    // ON-SCREEN COMPOSITE of the same rect: includes the live behind-window blur
    // that a window-only capture cannot contain.
    if (fx.region) {
      const rf = join(out, `${step.shot}--r${k}-${w.w}x${w.h}.png`)
      execFileSync('screencapture', ['-x', '-R', `${w.x},${w.y},${w.w},${w.h}`, rf])
      manifest.push({ shot: step.shot, file: basename(rf), region: true, ...w })
    }
  })
}
writeFileSync(join(out, 'manifest.json'), JSON.stringify({ fixture: basename(fixturePath), events, captures: manifest }, null, 1))
send({ type: 'quit' })
await sleep(300)
child.kill()
if (backdrop) backdrop.kill()
console.log(`${manifest.length} captures → ${out}`)
