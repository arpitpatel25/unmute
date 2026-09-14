import { test } from 'node:test'
import assert from 'node:assert/strict'
import { emitNotesReady, onNotesReady } from './notetakerEvents'

const event = { meetingId: 'm1', title: 'Standup', notesPath: '/tmp/meetings/m1/notes.json' }

test('a throwing listener does not stop the others', () => {
  const seen: string[] = []
  const errors: unknown[] = []
  const offA = onNotesReady(() => { throw new Error('boom') })
  const offB = onNotesReady(e => { seen.push(e.meetingId) })
  emitNotesReady(event, error => errors.push(error))
  offA(); offB()
  assert.deepEqual(seen, ['m1'])
  assert.equal((errors[0] as Error).message, 'boom')
})

test('unsubscribed listeners are not called', () => {
  let calls = 0
  const off = onNotesReady(() => { calls += 1 })
  off()
  emitNotesReady(event)
  assert.equal(calls, 0)
})
