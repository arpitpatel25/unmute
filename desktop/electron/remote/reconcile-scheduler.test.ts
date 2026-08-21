import test from 'node:test'
import assert from 'node:assert/strict'
import { ReconcileScheduler } from './reconcile-scheduler'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {}
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

test('uses one heartbeat regardless of registered task count', () => {
  let intervalStarts = 0
  let intervalStops = 0
  const scheduler = new ReconcileScheduler({
    tickMs: 10,
    setInterval: () => { intervalStarts++; return 7 as unknown as ReturnType<typeof setInterval> },
    clearInterval: () => { intervalStops++ },
  })

  scheduler.register('a', async () => {}, () => 100)
  scheduler.register('b', async () => {}, () => 100)
  scheduler.register('c', async () => {}, () => 100)
  assert.equal(intervalStarts, 1)
  assert.deepEqual([...scheduler.keys()], ['a', 'b', 'c'])

  scheduler.unregister('a')
  scheduler.unregister('b')
  assert.equal(intervalStops, 0)
  scheduler.unregister('c')
  assert.equal(intervalStops, 1)
})

test('new jobs are due on the first heartbeat instead of waiting for the fallback interval', async () => {
  let heartbeat: (() => void) | undefined
  let calls = 0
  const scheduler = new ReconcileScheduler({
    tickMs: 1_000,
    setInterval: (fn) => { heartbeat = fn; return 8 as unknown as ReturnType<typeof setInterval> },
    clearInterval: () => {},
  })
  scheduler.register('a', () => { calls++ }, () => 300_000)
  heartbeat?.()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls, 1)
  scheduler.shutdown()
})

test('serializes a task and coalesces repeated triggers into one follow-up', async () => {
  const first = deferred()
  let calls = 0
  const scheduler = new ReconcileScheduler({ tickMs: 60_000 })
  scheduler.register('a', async () => {
    calls++
    if (calls === 1) await first.promise
  }, () => 100)

  scheduler.trigger('a')
  scheduler.trigger('a')
  scheduler.trigger('a')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls, 1)

  first.resolve()
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls, 2)
  scheduler.shutdown()
})

test('re-registering an in-flight task preserves serialization', async () => {
  const first = deferred()
  let active = 0
  let maxActive = 0
  let calls = 0
  const scheduler = new ReconcileScheduler({ tickMs: 60_000 })
  const job = async () => {
    calls++
    active++
    maxActive = Math.max(maxActive, active)
    if (calls === 1) await first.promise
    active--
  }
  scheduler.register('a', job, () => 100)
  scheduler.trigger('a')
  scheduler.register('a', job, () => 100)
  scheduler.trigger('a')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls, 1)
  first.resolve()
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls, 2)
  assert.equal(maxActive, 1)
  scheduler.shutdown()
})

test('re-evaluates the adaptive interval after every run', async () => {
  let now = 1_000
  let heartbeat: (() => void) | undefined
  let interval = 100
  let calls = 0
  const scheduler = new ReconcileScheduler({
    tickMs: 10,
    now: () => now,
    setInterval: (fn) => { heartbeat = fn; return 9 as unknown as ReturnType<typeof setInterval> },
    clearInterval: () => {},
  })
  scheduler.register('a', async () => {
    calls++
    if (calls === 1) interval = 500
  }, () => interval)

  now = 1_100
  heartbeat?.()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls, 1)

  now = 1_599
  heartbeat?.()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls, 1)
  now = 1_600
  heartbeat?.()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls, 2)
  scheduler.shutdown()
})
