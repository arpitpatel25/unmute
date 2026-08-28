// The router's post-decision /clear has to actually RUN.
//
// Claude's TUI captures written text as a paste that sits one Enter short of
// submitting — the dispatch path has always known this and sends an explicit
// confirm Enter after the prompt. Housekeeping did not, so `/clear` was typed
// into the input line and left there: the context was never wiped, and the
// stale command was still in the buffer when the NEXT prompt was pasted in
// behind it.
//
// Two costs, both observed in the field on 28 Aug:
//   * routing latency grew with session age (15.9s -> 24.0s on turn two)
//   * the next turn submitted "/clear" glued to the routing prompt, which is
//     the likeliest cause of the router answering in chat instead of writing
//     the decision file.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Router, type AgentExecutor } from './router.ts'

const ONE = [{ id: 't1', intent: 'a', state: 'processing' as const, ageSec: 5 }]

/** Records the ORDER of stdin text and raw key writes, so a write that never
 *  got its confirming Enter is visible rather than merely absent. */
function recordingExecutor(decisionPath: string) {
  const io: Array<{ kind: 'stdin' | 'key'; text: string }> = []
  let alive = true
  const ex: AgentExecutor = {
    get alive() { return alive },
    async spawn() {}, async isReady() {},
    writeStdin(t: string) {
      io.push({ kind: 'stdin', text: t })
      if (t.includes('[Unmute router]')) {
        void fs.mkdir(path.dirname(decisionPath), { recursive: true })
          .then(() => fs.writeFile(decisionPath, JSON.stringify({ action: 'new', intent: 'x' })))
      }
    },
    write(t: string) { io.push({ kind: 'key', text: t }) },
    resize() {}, onData() {}, kill() { alive = false },
  }
  return { ex, io }
}

test('/clear is submitted with a confirming Enter, not left in the input line', async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-clear-'))
  const decisionPath = path.join(baseDir, 'router', 'decision.json')
  const { ex, io } = recordingExecutor(decisionPath)
  const router = new Router({ executorFactory: () => ex, baseDir, readyGraceMs: 0, submitConfirmMs: 0, decisionTimeoutMs: 1000, pollMs: 20 })

  await router.warm()
  await router.route('plan reddit marketing', ONE)
  await router.settleHousekeeping()

  const clearAt = io.findIndex((e) => e.kind === 'stdin' && e.text.trim() === '/clear')
  assert.ok(clearAt >= 0, '/clear was never written')
  const next = io[clearAt + 1]
  assert.ok(next, '/clear was the last thing written — nothing submitted it')
  assert.equal(next.kind, 'key')
  assert.equal(next.text, '\r', '/clear must be followed by a confirming Enter')

  router.dispose()
})

test('a second route does not carry an unsubmitted /clear into its prompt', async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-clear2-'))
  const decisionPath = path.join(baseDir, 'router', 'decision.json')
  const { ex, io } = recordingExecutor(decisionPath)
  const router = new Router({ executorFactory: () => ex, baseDir, readyGraceMs: 0, submitConfirmMs: 0, decisionTimeoutMs: 1000, pollMs: 20, recycleEvery: 99 })

  await router.warm()
  await router.route('plan reddit marketing', ONE)
  await router.settleHousekeeping()
  await router.route('draft linkedin posts', ONE)
  await router.settleHousekeeping()

  // Every /clear in the session must have been confirmed by the time the next
  // prompt goes in — otherwise it is still sitting in the buffer.
  const clears = io.map((e, i) => ({ e, i })).filter(({ e }) => e.kind === 'stdin' && e.text.trim() === '/clear')
  assert.ok(clears.length >= 1)
  for (const { i } of clears) {
    assert.equal(io[i + 1]?.text, '\r', `the /clear at index ${i} was never submitted`)
  }

  router.dispose()
})
