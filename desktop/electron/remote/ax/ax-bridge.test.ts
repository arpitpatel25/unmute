// ax-bridge tests — the readiness/fallback WIRING, not the native engine.
//
// The native AX engine itself is exercised on-device (real apps + permission).
// What we regression-test here is the bridge's degrade behavior — the thing
// that broke in production: when the addon can't load inside the eval-worker,
// the bridge must NOT route calls into a dead worker (which used to return
// "native-ax addon not loaded" forever and force callers back to focus-stealing
// AppleScript). It must ping the worker at startup, notice the addon is absent,
// and either use the main-thread handle or reject promptly with a clear error —
// never hang on the 12s call timeout.
//
// This runs a REAL WorkerBridge. In this source worktree `unmute-native-ax` is
// not installed (it's wired into work/oss-engine at build time), so the addon is
// unavailable and we assert the clean-degrade path. On a machine where the addon
// IS built, health() reports 'worker'/'main-thread' and we simply assert it's a
// valid mode — the point is that startup resolves fast and calls never hang.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getAxBridge, axBridgeHealth, __setAxBridge } from './ax-bridge'

test('bridge health resolves quickly to a valid mode (no hang on startup)', async () => {
  __setAxBridge(null) // force construction of a fresh real WorkerBridge
  const health = await axBridgeHealth()
  assert.ok(health, 'WorkerBridge reports health')
  assert.ok(['worker', 'main-thread', 'unavailable'].includes(health.mode), `valid mode, got ${health!.mode}`)
  getAxBridge().dispose()
  __setAxBridge(null)
})

test('when the addon cannot load, a call rejects promptly with a clear error — it does NOT hang', async () => {
  __setAxBridge(null)
  const health = await axBridgeHealth()
  if (health?.mode !== 'unavailable') {
    // Addon actually loaded on this machine — the degrade path isn't reachable
    // here; the on-device suite covers the working path.
    getAxBridge().dispose()
    __setAxBridge(null)
    return
  }
  const bridge = getAxBridge()
  const started = process.hrtime.bigint()
  await assert.rejects(
    () => bridge.call('isTrusted', []),
    /native-ax unavailable/,
    'unavailable addon yields a clear error, not a hang',
  )
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6
  assert.ok(elapsedMs < 6000, `rejected fast (well under the 12s call timeout), took ${elapsedMs.toFixed(0)}ms`)
  bridge.dispose()
  __setAxBridge(null)
})

test('trusted() returns false (never throws) when the addon is unavailable', async () => {
  __setAxBridge(null)
  const health = await axBridgeHealth()
  if (health?.mode !== 'unavailable') {
    getAxBridge().dispose()
    __setAxBridge(null)
    return
  }
  const bridge = getAxBridge()
  assert.equal(await bridge.trusted(), false)
  bridge.dispose()
  __setAxBridge(null)
})
