import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PersistentClaudeTaskSession } from './claude-client'
import type { RuntimeRpcClient } from './rpc'
import type { ClaudeTaskEvent } from '../claude/task-session'

function session(busy: boolean) {
  const events: ClaudeTaskEvent[] = []
  let opens = 0
  const rpc = Object.assign(new EventEmitter(), {
    call: async (method: string) => {
      if (method !== 'claude.open') throw new Error(`Unexpected RPC: ${method}`)
      opens++
      return { alive: true, busy, followupBlocked: false, followupUnavailable: busy, models: [], sequence: 0 }
    },
  }) as unknown as RuntimeRpcClient
  const driver = new PersistentClaudeTaskSession(rpc, {
    binary: 'claude', cwd: '/tmp', onEvent: event => events.push(event),
  })
  return { driver, rpc, events, opens: () => opens }
}

test('an idle Claude conversation survives runtime replacement without a false failure', async () => {
  const fixture = session(false)
  await fixture.driver.start()
  fixture.rpc.emit('disconnected')
  assert.deepEqual(fixture.events, [])
  assert.equal(fixture.driver.alive, false)
  await fixture.driver.start()
  assert.equal(fixture.opens(), 2)
  assert.equal(fixture.driver.alive, true)
  fixture.driver.detach()
})

test('a disconnect during an active Claude turn remains an actionable error', async () => {
  const fixture = session(true)
  await fixture.driver.start()
  fixture.rpc.emit('disconnected')
  assert.equal(fixture.events.at(-1)?.type, 'error')
  assert.match((fixture.events.at(-1) as Extract<ClaudeTaskEvent, { type: 'error' }>).message, /connection lost/i)
  fixture.driver.detach()
})
