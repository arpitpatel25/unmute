import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Router, promptPointer, type RoutableTask } from './router.ts'
import type { AgentExecutor } from './executor.ts'

const ONE: RoutableTask[] = [
  { id: 't1', intent: 'messi stats', state: 'done', ageSec: 30, agent: 'claude' },
]

test('the pointer is short enough that dropped characters cannot hide in it', () => {
  const p = promptPointer('/tmp/r/prompt.txt', '/tmp/r/decision.json')
  assert.ok(p.length < 400, `pointer should be tiny, was ${p.length}`)
  assert.match(p, /\/tmp\/r\/prompt\.txt/)
  assert.match(p, /\/tmp\/r\/decision\.json/)
})

test('the REPL is handed a pointer, not 8,500 characters of prompt', async () => {
  // THE FIELD BUG (2026-08-28 06:47). The whole prompt was typed into the TUI
  // with `writeStdin`. That channel drops characters — the logs show Unmute's
  // own words echoed back mangled ("a grup that swallows everythng isn group").
  // Usually cosmetic; that morning enough was lost that only the TAIL arrived,
  // the model replied "your message got cut off", never wrote the decision
  // file, and the route timed out after 60s.
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-delivery-'))
  const typed: string[] = []
  let alive = true
  const ex: AgentExecutor = {
    get alive() { return alive },
    async spawn() {}, async isReady() {},
    writeStdin(t: string) {
      typed.push(t)
      // Answer the way the real REPL would, once it has been told where to look.
      if (t.includes('prompt.txt')) {
        const m = /(\S+decision\.json)/.exec(t)
        if (m) void fs.mkdir(path.dirname(m[1]), { recursive: true })
          .then(() => fs.writeFile(m[1], JSON.stringify({ action: 'new', intent: 'x', name: 'X thing', kind: 'oneoff' })))
      }
    },
    write() {}, resize() {}, onData() {}, kill() { alive = false },
  }
  const router = new Router({
    executorFactory: () => ex, baseDir, slot: 'delivery',
    readyGraceMs: 0, submitConfirmMs: 0, decisionTimeoutMs: 3000, pollMs: 20,
  })

  const d = await router.route('reply to it', ONE)

  const payload = typed.find((t) => t.includes('prompt.txt')) ?? ''
  assert.ok(payload, 'the REPL must be told where the prompt is')
  // The invariant is the RATIO, not an absolute: what matters is how little of
  // the payload rides the lossy channel. (Absolute length varies with the
  // temp-directory path, which is long on macOS and says nothing about risk.)
  const staged = await fs.readFile(payload.match(/(\S+prompt\.txt)/)![1], 'utf8')
  assert.ok(
    payload.length < staged.length / 10,
    `typed ${payload.length} chars of a ${staged.length}-char prompt — should be a small fraction`,
  )
  assert.equal(d.action, 'new')
  router.dispose()
})

test('the full prompt is written to disk, intact, where the pointer says', async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-delivery-'))
  let alive = true
  let seen = ''
  const ex: AgentExecutor = {
    get alive() { return alive },
    async spawn() {}, async isReady() {},
    writeStdin(t: string) { if (t.includes('prompt.txt')) seen = t },
    write() {}, resize() {}, onData() {}, kill() { alive = false },
  }
  const router = new Router({
    executorFactory: () => ex, baseDir, slot: 'delivery2',
    readyGraceMs: 0, submitConfirmMs: 0, decisionTimeoutMs: 300, pollMs: 20,
  })
  await router.route('reply to it', ONE)

  const m = /(\S+prompt\.txt)/.exec(seen)
  assert.ok(m, `expected a prompt path in: ${seen}`)
  const written = await fs.readFile(m[1], 'utf8')
  // A file write cannot be half-delivered the way typing can.
  assert.ok(written.length > 1000, `the real prompt should be on disk, got ${written.length} chars`)
  assert.match(written, /\[Unmute router\]/)
  assert.match(written, /reply to it/, 'and it must contain the utterance being routed')
  router.dispose()
})
