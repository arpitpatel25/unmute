import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NotchClient, type NotchEvent, type NotchCommand } from './notch-client'

const FAKE = join(fileURLToPath(new URL('.', import.meta.url)), 'fake-notch.mjs')

function makeClient(): NotchClient {
  return new NotchClient({ binPath: process.execPath, binArgs: [FAKE] })
}

function makeSupervisedClient(): NotchClient {
  return new NotchClient({
    binPath: process.execPath,
    binArgs: [FAKE],
    bootstrap: () => ({
      type: 'bootstrap', appearance: 'solid', surfaceTone: 'glass', surfaceFill: 0.8,
      showInScreenCapture: false, terminalAutoExpand: false, autoPresent: true,
    }),
    restartDelayMs: 10,
  })
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
    { type: 'setState', state: 'attention', attention: 2, working: 1 },
    { type: 'showTask', task: { id: 't1', title: 'RCA', status: 'needs-user', kind: 'oneoff', alive: true } },
  ]
  for (const c of cmds) client.send(c)

  // Ask the fake to dump what it received.
  const dump = waitFor(client, '__calls' as NotchEvent['type'])
  client.send({ type: '__dump' } as unknown as NotchCommand)
  const received = (await dump) as unknown as { commands: NotchCommand[] }

  assert.deepEqual(received.commands, cmds)
  client.dispose()
})

test('commands sent before ready are restored only after helper bootstrap', async () => {
  const client = makeSupervisedClient()
  client.send({ type: 'setState', state: 'active', attention: 0, working: 1 })
  await waitFor(client, 'ready')
  const dump = waitFor(client, '__calls' as NotchEvent['type'])
  client.send({ type: '__dump' } as unknown as NotchCommand)
  const commands = ((await dump) as unknown as { commands: NotchCommand[] }).commands
  assert.deepEqual(commands[0], {
    type: 'bootstrap', appearance: 'solid', surfaceTone: 'glass', surfaceFill: 0.8,
    showInScreenCapture: false, terminalAutoExpand: false, autoPresent: true,
  })
  assert.deepEqual(commands[1], { type: 'setState', state: 'active', attention: 0, working: 1 })
  assert.equal(commands[2]?.type, 'present')
  client.dispose()
})

test('the compact help guide is replayed before visual state', async () => {
  const client = makeSupervisedClient()
  const guide = {
    title: 'How to use Unmute',
    sections: [{ id: 'dictation' as const, title: 'Dictation', intro: 'Talk instead of type.', entries: [{ id: 'dictation-talk', title: 'Talk', summary: 'Voice into text.', shortcut: 'Hold Right Option while you talk. Let go to finish.' }] }],
  }
  client.send({ type: 'helpGuide', guide })
  client.send({ type: 'setState', state: 'active', attention: 0, working: 1 })
  await waitFor(client, 'ready')
  const dump = waitFor(client, '__calls' as NotchEvent['type'])
  client.send({ type: '__dump' } as unknown as NotchCommand)
  const commands = ((await dump) as unknown as { commands: NotchCommand[] }).commands
  assert.equal(commands[0]?.type, 'bootstrap')
  assert.deepEqual(commands[1], { type: 'helpGuide', guide })
  assert.equal(commands[2]?.type, 'setState')
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
  assert.doesNotThrow(() => client.send({ type: 'setState', state: 'active', attention: 0, working: 1 }))
})

test('bootstraps before replaying state after an unexpected helper exit', async () => {
  const client = makeSupervisedClient()
  await waitFor(client, 'ready')
  client.send({ type: 'setState', state: 'attention', attention: 2, working: 1 })
  client.send({ type: 'showTask', task: { id: 't1', title: 'RCA', status: 'needs-user', kind: 'oneoff', alive: true } })

  const restarted = waitFor(client, 'ready')
  client.send({ type: '__crash' } as unknown as NotchCommand)
  await restarted

  const dump = waitFor(client, '__calls' as NotchEvent['type'])
  client.send({ type: '__dump' } as unknown as NotchCommand)
  const commands = ((await dump) as unknown as { commands: NotchCommand[] }).commands
  assert.equal(commands[0]?.type, 'bootstrap')
  assert.equal(commands[1]?.type, 'showTask')
  assert.deepEqual(commands[2], { type: 'setState', state: 'attention', attention: 2, working: 1 })
  assert.equal(commands[3]?.type, 'present')
  client.dispose()
})

test('dispose does not restart the helper', async () => {
  let exits = 0
  const client = new NotchClient({
    binPath: process.execPath, binArgs: [FAKE], restartDelayMs: 10,
    onExit: () => { exits += 1 },
  })
  await waitFor(client, 'ready')
  client.dispose()
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(exits, 1)
  assert.equal(client.alive, false)
})

test('dispose during a pending restart cancels the restart', async () => {
  let readyCount = 0
  let exited!: () => void
  const exit = new Promise<void>((resolve) => { exited = resolve })
  const client = new NotchClient({
    binPath: process.execPath, binArgs: [FAKE], restartDelayMs: 80,
    onExit: () => exited(),
  })
  client.on('ready', () => { readyCount += 1 })
  await waitFor(client, 'ready')
  client.send({ type: '__crash' } as unknown as NotchCommand)
  await exit
  client.dispose()
  await new Promise((resolve) => setTimeout(resolve, 130))
  assert.equal(readyCount, 1)
  assert.equal(client.alive, false)
})
