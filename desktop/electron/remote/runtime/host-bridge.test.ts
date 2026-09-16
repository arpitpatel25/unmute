import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RuntimeHostBridge } from './host-bridge.ts'

/**
 * FIELD HAZARD: with no UI attached, a host request sat in `pending` with no
 * timer and no rejection. Every Agent tool except memory goes through here, so
 * a detached app meant the turn hung until the token expired half an hour
 * later — and the person was told nothing at all.
 */
test('a request no app ever takes fails with something the person can act on', async () => {
  const bridge = new RuntimeHostBridge(() => {}, 10)
  await assert.rejects(bridge.call('sessions.open', [{}]), /not attached/i)
})

test('an accepted request is never timed out from here', async () => {
  let sent: { id: string } | undefined
  const bridge = new RuntimeHostBridge(request => { sent = request }, 10)
  const pending = bridge.call('sessions.send', [{ taskId: 'task-1' }])
  assert.ok(bridge.accept(sent!.id))
  await new Promise(resolve => setTimeout(resolve, 40))
  // Long actions — waking a cold session and delivering into it runs past 40s —
  // are bounded by the app, not by this.
  bridge.response(sent!.id, { delivered: true })
  assert.deepEqual(await pending, { delivered: true })
})
