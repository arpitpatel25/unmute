// Measure the real Codex window over CDP. Read-only: Runtime.evaluate only.
import { readFileSync, writeFileSync } from 'node:fs'

const PORT = process.env.CDP_PORT || '9790'
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = list.find(t => t.type === 'page' && !t.url.includes('avatar-overlay')) || list[0]
if (!page) { console.error('no page'); process.exit(1) }
console.error('target:', page.url)

const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
const send = (method, params) => new Promise((res, rej) => {
  const n = ++id
  pending.set(n, { res, rej })
  ws.send(JSON.stringify({ id: n, method, params }))
})
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300))
  return r.result?.value
}

ws.onmessage = (ev) => {
  const m = JSON.parse(String(ev.data))
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id)
    m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result)
  }
}

await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })

const SCRIPT = readFileSync(process.env.HOME + '/.claude/jobs/1e337dec/tmp/probe.js', 'utf8')
const out = await evaluate(SCRIPT)
writeFileSync(process.env.HOME + '/.claude/jobs/1e337dec/tmp/codex-metrics.json', JSON.stringify(out, null, 2))
console.log(JSON.stringify(out, null, 2))
ws.close()
process.exit(0)
