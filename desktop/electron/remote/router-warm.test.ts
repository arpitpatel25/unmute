// warm() MUST WARM THE THING THAT ACTUALLY ROUTES.
//
// routeOnce() checks `this.engine` first and returns before ever touching the
// PTY — but warm() went straight to ensureSession() and spawned one anyway. So
// an engine-backed router spawned a REPL it would never use, and left the
// engine cold.
//
// Two costs, both seen in the installed 1.5.7-dev.17 build:
//   * TWO stray `claude` PTY processes at startup, one per router slot. This is
//     the "two routers spawned, both running claude" oddity noticed on 28 Aug
//     and wrongly filed as harmless: the Codex router has been doing it for as
//     long as it has existed.
//   * the engine never primed, so the first real utterance paid cold start AND
//     the deferred-tool ToolSearch hop — the exact latency warm() exists to
//     move off the user's path (9.1s first turn vs 2.0s once primed).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Router, type AgentExecutor } from './router.ts'

function countingFactory() {
  let spawns = 0
  const factory = () => {
    spawns++
    const ex: AgentExecutor = {
      get alive() { return true },
      async spawn() {}, async isReady() {},
      writeStdin() {}, write() {}, resize() {}, onData() {}, kill() {},
    }
    return ex
  }
  return { factory, spawns: () => spawns }
}

function fakeEngine() {
  let warmed = 0
  return {
    warmed: () => warmed,
    engine: {
      label: 'fake',
      answerTool: 'mcp__x__route_decision',
      async warm() { warmed++ },
      async decide() { return null },
      dispose() {},
    },
  }
}

test('an engine-backed router warms the ENGINE and spawns no PTY', async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-warm-'))
  const { factory, spawns } = countingFactory()
  const { engine, warmed } = fakeEngine()
  const router = new Router({ executorFactory: factory, engine, baseDir, readyGraceMs: 0 })

  await router.warm()

  assert.equal(warmed(), 1, 'the engine was never warmed — the first route pays cold start')
  assert.equal(spawns(), 0, 'a PTY was spawned for a router that will never use one')
  router.dispose()
})

test('warming twice does not spawn twice', async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-warm2-'))
  const { factory, spawns } = countingFactory()
  const { engine } = fakeEngine()
  const router = new Router({ executorFactory: factory, engine, baseDir, readyGraceMs: 0 })
  await router.warm()
  await router.warm()
  assert.equal(spawns(), 0)
  router.dispose()
})

test('the PTY router still warms its PTY — the fallback is untouched', async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-warm3-'))
  const { factory, spawns } = countingFactory()
  const router = new Router({ executorFactory: factory, baseDir, readyGraceMs: 0 })
  await router.warm()
  assert.equal(spawns(), 1)
  router.dispose()
})

test('disposing an engine-backed router disposes the engine', async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-warm4-'))
  const { factory } = countingFactory()
  let disposed = 0
  const engine = {
    label: 'fake', async warm() {}, async decide() { return null },
    dispose() { disposed++ },
  }
  const router = new Router({ executorFactory: factory, engine, baseDir, readyGraceMs: 0 })
  await router.warm()
  router.dispose()
  assert.equal(disposed, 1, 'the engine process outlives the app otherwise')
})
