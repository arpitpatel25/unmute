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
