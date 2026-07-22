import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Arming } from './arming'

test('arm launches with a port and returns it once the endpoint answers', async () => {
  let launched: any = null; let up = false
  const a = new Arming({
    launch: (app, port) => { launched = { app, port }; up = true },
    quit: async () => {}, probe: async () => up, portBase: 9222,
  })
  const r = await a.arm('Notion')
  assert.equal(r.app, 'Notion'); assert.ok(r.port >= 9222); assert.equal(r.alreadyArmed, false)
  assert.equal(launched.app, 'Notion'); assert.equal(a.portFor('Notion'), r.port)
})

test('arm is idempotent when the port is already answering', async () => {
  let launches = 0
  const a = new Arming({ launch: () => { launches++ }, quit: async () => {}, probe: async () => true })
  await a.arm('Notion'); const second = await a.arm('Notion')
  assert.equal(second.alreadyArmed, true); assert.equal(launches, 1)
})

test('arm throws if the endpoint never comes up', async () => {
  // small retry budget so this runs instantly instead of the 20×500ms default
  const a = new Arming({ launch: () => {}, quit: async () => {}, probe: async () => false, retries: 2, intervalMs: 1 })
  await assert.rejects(() => a.arm('Notion'), /could not arm/)
})

test('assignPort never gives two tracked apps the same port on a hash collision', async () => {
  // Mirror arming.ts's djb2 hash so we can brute-force two app names that
  // collide mod 1000 — the exact scenario I2 describes: app B hashes to a
  // port app A already holds.
  const djb2 = (s: string): number => {
    let h = 5381
    for (let i = 0; i < s.length; i++) h = (h * 33) ^ s.charCodeAt(i)
    return Math.abs(h)
  }
  const appA = 'App-A'
  const targetSlot = djb2(appA) % 1000
  let appB: string | undefined
  for (let i = 0; i < 100000; i++) {
    const candidate = `App-${i}`
    if (candidate === appA) continue
    if (djb2(candidate) % 1000 === targetSlot) { appB = candidate; break }
  }
  assert.ok(appB, 'expected to find a colliding app name within 100000 tries')

  const a = new Arming({ launch: () => {}, quit: async () => {}, probe: async () => true, portBase: 9222 })
  const rA = await a.arm(appA)
  const rB = await a.arm(appB!)
  assert.notEqual(rB.port, rA.port, 'colliding apps must never share a port')
  assert.equal(a.portFor(appA), rA.port)
  assert.equal(a.portFor(appB!), rB.port)
})
