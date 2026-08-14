import test from 'node:test'
import assert from 'node:assert/strict'
import { TaskDraftStore } from './task-draft'
import { deliverAddressedCapture } from './addressed-capture'

test('an addressed Right Option capture stages text and images, then submits that exact task draft', async () => {
  const drafts = new TaskDraftStore()
  const delivered: Array<{ id: string; text: string; paths: string[] }> = []
  const persisted: string[] = []
  let visibleWhileSending = false

  const accepted = await deliverAddressedCapture({
    taskId: 'task-1',
    text: 'Please compare these',
    attachments: ['/tmp/one.png', '/tmp/two.png'],
    drafts,
    persistAttachment: async (_taskId, sourcePath) => {
      persisted.push(sourcePath)
      return {
        id: `owned-${persisted.length}`,
        path: `/task/attachments/${persisted.length}.png`,
        mimeType: 'image/png',
        name: `image-${persisted.length}.png`,
      }
    },
    onStaged: () => { visibleWhileSending = drafts.get('task-1').attachments.length === 2 },
    deliver: async (id, draft) => {
      delivered.push({ id, text: draft.text, paths: draft.attachments.map((item) => item.path) })
      return true
    },
  })

  assert.equal(accepted, true)
  assert.deepEqual(persisted, ['/tmp/one.png', '/tmp/two.png'])
  assert.equal(visibleWhileSending, true, 'the composer is refreshed before provider delivery starts')
  assert.deepEqual(delivered, [{
    id: 'task-1',
    text: 'Please compare these',
    paths: ['/task/attachments/1.png', '/task/attachments/2.png'],
  }])
  assert.deepEqual(drafts.get('task-1'), { text: '', attachments: [] }, 'successful delivery clears the visible draft')
})

test('a rejected addressed capture stays visible for manual retry', async () => {
  const drafts = new TaskDraftStore()
  const accepted = await deliverAddressedCapture({
    taskId: 'task-1', text: 'Do not lose me', attachments: ['/tmp/one.png'], drafts,
    persistAttachment: async () => ({
      id: 'owned-1', path: '/task/attachments/one.png', mimeType: 'image/png', name: 'one.png',
    }),
    deliver: async () => false,
  })

  assert.equal(accepted, false)
  assert.equal(drafts.get('task-1').text, 'Do not lose me')
  assert.equal(drafts.get('task-1').attachments.length, 1)
  assert.equal(drafts.get('task-1').attachments[0]?.path, '/task/attachments/one.png')
})

test('an image-only addressed capture is a deliverable draft', async () => {
  const drafts = new TaskDraftStore()
  let delivered = false
  const accepted = await deliverAddressedCapture({
    taskId: 'task-1', text: '', attachments: ['/tmp/one.png'], drafts,
    persistAttachment: async () => ({
      id: 'owned-1', path: '/task/attachments/one.png', mimeType: 'image/png', name: 'one.png',
    }),
    deliver: async (_id, draft) => {
      delivered = draft.text === '' && draft.attachments.length === 1
      return delivered
    },
  })
  assert.equal(accepted, true)
  assert.equal(delivered, true)
})

test('an addressed capture never calls a provider with an attachment it failed to own', async () => {
  const drafts = new TaskDraftStore()
  let delivered = false
  let stagedText = ''
  const failures: Array<{ path: string; error: string }> = []

  const accepted = await deliverAddressedCapture({
    taskId: 'task-1',
    text: 'Keep this retryable',
    attachments: ['/scratchpad/already-removed.png'],
    drafts,
    persistAttachment: async () => { throw new Error('ENOENT') },
    onStaged: (_id, draft) => { stagedText = draft.text },
    onAttachmentStageFailed: (_id, path, error) => failures.push({ path, error: error.message }),
    deliver: async () => { delivered = true; return true },
  })

  assert.equal(accepted, false)
  assert.equal(delivered, false)
  assert.equal(stagedText, 'Keep this retryable')
  assert.deepEqual(failures, [{ path: '/scratchpad/already-removed.png', error: 'ENOENT' }])
  assert.deepEqual(drafts.get('task-1'), { text: 'Keep this retryable', attachments: [] })
})
