import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildRoutingPrompt, parseDecision, Router, type RoutableTask } from './router.ts'
import type { AgentExecutor } from './executor.ts'

const TASKS: RoutableTask[] = [{ id: 't1', intent: 'find latest tweet', state: 'done', category: 'info', ageSec: 5, surfaced: true }]

test('buildRoutingPrompt includes the utterance, task line, and decision path', () => {
  const p = buildRoutingPrompt('reply to it', TASKS, '/d/decision.json')
  assert.ok(p.includes('reply to it'))
  assert.ok(p.includes('[t1] "find latest tweet"'))
  assert.ok(p.includes('ON SCREEN'))
  assert.ok(p.includes('/d/decision.json'))
})

test('parseDecision: continue only with a known id; else new (fail-safe)', () => {
  const ids = new Set(['t1'])
  assert.deepEqual(parseDecision('{"action":"continue","targetTaskId":"t1","intent":"reply"}', 'raw', ids), { action: 'continue', targetTaskId: 't1', intent: 'reply' })
  // unknown id ⇒ new
  assert.equal(parseDecision('{"action":"continue","targetTaskId":"zzz","intent":"x"}', 'raw', ids).action, 'new')
  // malformed / empty ⇒ new with fallback intent
  assert.deepEqual(parseDecision('not json', 'raw utterance', ids), { action: 'new', intent: 'raw utterance' })
  assert.deepEqual(parseDecision(null, 'raw utterance', ids), { action: 'new', intent: 'raw utterance' })
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

test('Router.route fails safe to NEW when no decision is written (timeout)', async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-'))
  const decisionPath = path.join(baseDir, 'router', 'decision.json')
  const ex = fakeRouterExecutor(decisionPath, null) // never writes
  const router = new Router({ executorFactory: () => ex, baseDir, readyGraceMs: 0, decisionTimeoutMs: 250, pollMs: 20 })
  const d = await router.route('open my downloads folder', TASKS)
  assert.equal(d.action, 'new')
  assert.equal(d.intent, 'open my downloads folder')
  router.dispose()
})
