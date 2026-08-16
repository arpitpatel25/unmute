// Capture REAL app-server notification payloads for one short Codex CLI turn.
// Bounded on every axis: 90s wall clock, 8MB of capture, server killed in a
// finally block. Writes one JSONL line per notification.
import { spawn } from 'node:child_process'
import { writeFileSync, appendFileSync, statSync } from 'node:fs'

const OUT = process.env.HOME + '/.claude/jobs/1e337dec/tmp/notifications.jsonl'
const PORT = 49731
const MAX_BYTES = 8 * 1024 * 1024
const MAX_MS = 90_000

writeFileSync(OUT, '')
let bytes = 0, done = false

const proc = spawn('codex', ['app-server', '--listen', `ws://127.0.0.1:${PORT}`], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, CODEX_MANAGED_BY: 'unmute-capture' },
})
proc.stdout.on('data', d => process.stderr.write('[srv] ' + String(d).slice(0, 200)))
proc.stderr.on('data', d => process.stderr.write('[srv!] ' + String(d).slice(0, 200)))

const finish = (why) => {
  if (done) return; done = true
  console.log(`\nDONE (${why}) — ${bytes} bytes captured → ${OUT}`)
  try { proc.kill('SIGKILL') } catch {}
  setTimeout(() => process.exit(0), 200)
}
const killer = setTimeout(() => finish('timeout'), MAX_MS)
process.on('SIGINT', () => finish('interrupt'))

const sleep = ms => new Promise(r => setTimeout(r, ms))

;(async () => {
  try {
    // wait for readiness
    for (let i = 0; i < 60; i++) {
      try { const r = await fetch(`http://127.0.0.1:${PORT}/readyz`); if (r.ok) break } catch {}
      await sleep(500)
    }
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`)
    let id = 0
    const pending = new Map()
    const req = (method, params) => new Promise((res, rej) => {
      const n = ++id
      pending.set(n, { res, rej })
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }))
    })

    ws.onopen = async () => {
      console.log('connected')
      await req('initialize', { clientInfo: { name: 'unmute-capture', version: '1' } })
      ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} }))
      const t = await req('thread/start', {
        cwd: process.env.HOME + '/.claude/jobs/1e337dec/tmp',
        approvalPolicy: 'never',
        sandbox: 'workspace-write',
      })
      const threadId = t.threadId ?? t.thread?.id ?? t.id
      console.log('thread', threadId)
      // A prompt that forces reasoning + a command + a file edit, so we see
      // every delta family in one turn.
      await req('turn/start', {
        threadId,
        input: [{ type: 'text', text: 'Run `echo hello` with a shell command, then create a file named capture-probe.txt containing the word ok. Then reply DONE.' }],
      })
      console.log('turn started — capturing…')
    }

    ws.onmessage = (ev) => {
      const raw = String(ev.data)
      let m; try { m = JSON.parse(raw) } catch { return }
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id); pending.delete(m.id)
        appendFileSync(OUT, JSON.stringify({ _kind: 'response', method: null, body: m }) + '\n')
        m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result ?? {})
        return
      }
      if (m.method) {
        const line = JSON.stringify({ _kind: m.id ? 'server-request' : 'notification', method: m.method, params: m.params }) + '\n'
        bytes += line.length
        if (bytes < MAX_BYTES) appendFileSync(OUT, line)
        else finish('size cap')
        if (m.method === 'turn/completed' || m.method === 'thread/status/changed' && m.params?.status?.type === 'idle') {
          setTimeout(() => finish('turn complete'), 2500)
        }
      }
    }
    process.on('uncaughtException', (e) => { console.error('caught:', e.message); finish('exception') })
    ws.onerror = (e) => { console.error('ws error', e.message ?? e); finish('ws error') }
    ws.onclose = () => finish('ws closed')
  } catch (e) {
    console.error('FAILED:', e.message)
    finish('error')
  }
})()
