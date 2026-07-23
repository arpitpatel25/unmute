import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NotchClient, type NotchEvent, type NotchCommand } from './notch-client'

const FAKE = join(fileURLToPath(new URL('.', import.meta.url)), 'fake-notch.mjs')

function makeClient(): NotchClient {
  return new NotchClient({ binPath: process.execPath, binArgs: [FAKE] })
}

/** Resolve on the first event of `type`, or reject after `ms`. */
function waitFor(client: NotchClient, type: NotchEvent['type'], ms = 2000): Promise<NotchEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), ms)
    client.once(type, (e: NotchEvent) => { clearTimeout(timer); resolve(e) })
  })
}

test('surfaces the ready handshake from the helper', async () => {
  const client = makeClient()
  const evt = await waitFor(client, 'ready')
  assert.equal(evt.type, 'ready')
  client.dispose()
})

test('send() delivers commands to the helper in order', async () => {
  const client = makeClient()
  await waitFor(client, 'ready')

  const cmds: NotchCommand[] = [
    { type: 'setState', state: 'peek', attention: 2, working: 1 },
    { type: 'showTask', task: { id: 't1', title: 'RCA', state: 'needs-user' } },
  ]
  for (const c of cmds) client.send(c)

  // Ask the fake to dump what it received.
  const dump = waitFor(client, '__calls' as NotchEvent['type'])
  client.send({ type: '__dump' } as unknown as NotchCommand)
  const received = (await dump) as unknown as { commands: NotchCommand[] }

  assert.deepEqual(received.commands, cmds)
  client.dispose()
})

test('surfaces helper→main events (tap, next, chooseOption)', async () => {
  const client = makeClient()
  await waitFor(client, 'ready')

  const tap = waitFor(client, 'tap')
  client.send({ type: '__emit', event: { type: 'tap' } } as unknown as NotchCommand)
  assert.equal((await tap).type, 'tap')

  const choose = waitFor(client, 'chooseOption')
  client.send({ type: '__emit', event: { type: 'chooseOption', index: 1 } } as unknown as NotchCommand)
  const evt = await choose
  assert.equal(evt.type, 'chooseOption')
  assert.equal((evt as { index: number }).index, 1)

  client.dispose()
})

test('send() is a no-op after dispose (no throw)', async () => {
  const client = makeClient()
  await waitFor(client, 'ready')
  client.dispose()
  // Give the child a tick to exit; send must not throw.
  await new Promise((r) => setTimeout(r, 50))
  assert.doesNotThrow(() => client.send({ type: 'collapse' }))
})
