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
  const a = new Arming({ launch: () => {}, quit: async () => {}, probe: async () => false })
  await assert.rejects(() => a.arm('Notion'), /could not arm/)
}) // implementation must cap retries fast in tests (inject a small retry budget via portBase-independent constant or a test hook)
