import assert from 'node:assert/strict'
import test from 'node:test'
import { ActionEntry } from './action-entry'

test('repeated snapshots cannot repeat entry effects, including while entry is pending', async () => {
  const entry = new ActionEntry()
  let opened = 0
  let finish!: () => void
  const pending = entry.run('notes-dictation', async () => {
    opened++
    await new Promise<void>(resolve => { finish = resolve })
  })
  await entry.run('notes-dictation', async () => { opened++ })
  assert.equal(opened, 1)
  finish()
  await pending
  await entry.run('notes-dictation', async () => { opened++ })
  assert.equal(opened, 1)
  await entry.run('clipboard-capture', async () => {})
  await entry.run('notes-dictation', async () => { opened++ })
  assert.equal(opened, 2)
})
