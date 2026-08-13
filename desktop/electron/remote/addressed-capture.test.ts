import test from 'node:test'
import assert from 'node:assert/strict'
import { TaskDraftStore } from './task-draft'
import { deliverAddressedCapture } from './addressed-capture'

test('an addressed Right Option capture stages text and images, then submits that exact task draft', async () => {
  const drafts = new TaskDraftStore()
  const delivered: Array<{ id: string; text: string; paths: string[] }> = []
  let visibleWhileSending = false

  const accepted = await deliverAddressedCapture({
    taskId: 'task-1',
    text: 'Please compare these',
    attachments: ['/tmp/one.png', '/tmp/two.png'],
    drafts,
    onStaged: () => { visibleWhileSending = drafts.get('task-1').attachments.length === 2 },
    deliver: async (id, draft) => {
      delivered.push({ id, text: draft.text, paths: draft.attachments.map((item) => item.path) })
      return true
    },
  })

  assert.equal(accepted, true)
  assert.equal(visibleWhileSending, true, 'the composer is refreshed before provider delivery starts')
  assert.deepEqual(delivered, [{
    id: 'task-1',
    text: 'Please compare these',
    paths: ['/tmp/one.png', '/tmp/two.png'],
  }])
  assert.deepEqual(drafts.get('task-1'), { text: '', attachments: [] }, 'successful delivery clears the visible draft')
})

test('a rejected addressed capture stays visible for manual retry', async () => {
  const drafts = new TaskDraftStore()
  const accepted = await deliverAddressedCapture({
    taskId: 'task-1', text: 'Do not lose me', attachments: ['/tmp/one.png'], drafts,
    deliver: async () => false,
  })

  assert.equal(accepted, false)
  assert.equal(drafts.get('task-1').text, 'Do not lose me')
  assert.equal(drafts.get('task-1').attachments.length, 1)
})
