import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildRoutingPrompt, parseDecision, failsafeDecision, Router, type RoutableTask } from './router.ts'
import type { AgentExecutor } from './executor.ts'

const TASKS: RoutableTask[] = [{ id: 't1', intent: 'find latest tweet', state: 'done', category: 'info', ageSec: 5, surfaced: true }]
const ONE: RoutableTask[] = [{ id: 't1', intent: 'messi 2019 stats', state: 'done', category: 'info', ageSec: 30, surfaced: true }]
const TWO: RoutableTask[] = [
  { id: 't1', intent: 'messi 2019 stats', state: 'done', category: 'info', ageSec: 30, surfaced: true },
  { id: 't2', intent: 'open downloads', state: 'done', category: 'navigate', ageSec: 60, surfaced: false },
]

test('buildRoutingPrompt includes the utterance, task line, and decision path', () => {
  const p = buildRoutingPrompt('reply to it', TASKS, '/d/decision.json')
  assert.ok(p.includes('reply to it'))
  assert.ok(p.includes('[t1] "find latest tweet"'))
  assert.ok(p.includes('ON SCREEN'))
  assert.ok(p.includes('/d/decision.json'))
})

test('failsafeDecision: one recent task continues it; multiple or stale or none ⇒ new', () => {
  assert.deepEqual(failsafeDecision(ONE, 'and 2015?'), { action: 'continue', targetTaskId: 't1', intent: 'and 2015?' })
  assert.equal(failsafeDecision(TWO, 'x').action, 'new')               // ambiguous ⇒ new
  assert.equal(failsafeDecision([], 'x').action, 'new')                // nothing to continue
  const stale: RoutableTask[] = [{ ...ONE[0], ageSec: 99999 }]
  assert.equal(failsafeDecision(stale, 'x').action, 'new')             // too old ⇒ new
})

test('parseDecision: explicit decisions honored; failures use failsafe', () => {
  // explicit "new" is honored even with one open task
  assert.equal(parseDecision('{"action":"new","intent":"fresh"}', 'raw', ONE).action, 'new')
  // explicit continue to a known id
  assert.deepEqual(parseDecision('{"action":"continue","targetTaskId":"t1","intent":"reply"}', 'raw', ONE),
    { action: 'continue', targetTaskId: 't1', intent: 'reply' })
  // timeout (null) with one recent task ⇒ continue it (the flip)
  assert.deepEqual(parseDecision(null, 'and 2015?', ONE), { action: 'continue', targetTaskId: 't1', intent: 'and 2015?' })
  // malformed with one recent task ⇒ continue it
  assert.equal(parseDecision('not json', 'x', ONE).action, 'continue')
  // null with multiple tasks ⇒ new (can't guess)
  assert.equal(parseDecision(null, 'x', TWO).action, 'new')
  // unknown id ⇒ failsafe (single ⇒ continue latest)
  assert.equal(parseDecision('{"action":"continue","targetTaskId":"zzz","intent":"x"}', 'x', ONE).targetTaskId, 't1')
})

// A fake classifier session: when it receives the routing prompt, it writes the
// given decision to the router's decision file (mimicking the real REPL).
function fakeRouterExecutor(decisionPath: string, decision: object | null) {
  let alive = true
  const ex: AgentExecutor = {
    get alive() { return alive },
    async spawn() {},
    async isReady() {},
    writeStdin(t: string) {
      if (decision && t.includes('[Unmute router]')) {
        void fs.mkdir(path.dirname(decisionPath), { recursive: true })
          .then(() => fs.writeFile(decisionPath, JSON.stringify(decision)))
      }
    },
    write() {},
    resize() {},
    onData() {},
    kill() { alive = false },
  }
  return ex
}

test('Router.route returns continue when the session decides so', async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-'))
  const decisionPath = path.join(baseDir, 'router', 'decision.json')
  const ex = fakeRouterExecutor(decisionPath, { action: 'continue', targetTaskId: 't1', intent: 'reply to it' })
  const router = new Router({ executorFactory: () => ex, baseDir, readyGraceMs: 0, decisionTimeoutMs: 2000, pollMs: 20 })
  const d = await router.route('reply to it', TASKS)
  assert.equal(d.action, 'continue')
  assert.equal(d.targetTaskId, 't1')
  assert.equal(d.intent, 'reply to it')
  router.dispose()
})

test('Router.route fails safe on timeout: ambiguous (2+ tasks) ⇒ NEW', async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-'))
  const decisionPath = path.join(baseDir, 'router', 'decision.json')
  const ex = fakeRouterExecutor(decisionPath, null) // never writes
  const router = new Router({ executorFactory: () => ex, baseDir, readyGraceMs: 0, decisionTimeoutMs: 250, pollMs: 20 })
  const d = await router.route('open my downloads folder', TWO)
  assert.equal(d.action, 'new')
  assert.equal(d.intent, 'open my downloads folder')
  router.dispose()
})

test('Router.route fails safe on timeout: ONE recent task ⇒ CONTINUE it (the flip)', async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-'))
  const decisionPath = path.join(baseDir, 'router', 'decision.json')
  const ex = fakeRouterExecutor(decisionPath, null) // never writes (cold-timeout)
  const router = new Router({ executorFactory: () => ex, baseDir, readyGraceMs: 0, decisionTimeoutMs: 250, pollMs: 20 })
  const d = await router.route('and what about 2015?', ONE)
  assert.equal(d.action, 'continue')
  assert.equal(d.targetTaskId, 't1')
  router.dispose()
})
