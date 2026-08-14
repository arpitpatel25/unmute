import test from 'node:test'
import assert from 'node:assert/strict'
import { TaskDraftStore } from './task-draft'

test('task drafts retain text and ordered attachments until a successful clear', () => {
  const drafts = new TaskDraftStore()

  drafts.appendText('task-1', 'Look at this')
  drafts.addAttachment('task-1', { id: 'image-1', path: '/tmp/one.png', mimeType: 'image/png', name: 'one.png' })
  drafts.appendText('task-1', '\nand compare it')

  assert.deepEqual(drafts.get('task-1'), {
    text: 'Look at this\nand compare it',
    attachments: [{ id: 'image-1', path: '/tmp/one.png', mimeType: 'image/png', name: 'one.png' }],
  })

  const sending = drafts.snapshot('task-1')
  assert.deepEqual(sending, drafts.get('task-1'), 'a send snapshot does not clear the visible draft')
  assert.equal(drafts.clearIfUnchanged('task-1', sending!), true)
  assert.deepEqual(drafts.get('task-1'), { text: '', attachments: [] })
})

test('task draft survives a failed send and later edits prevent clearing an old snapshot', () => {
  const drafts = new TaskDraftStore()
  drafts.setText('task-1', 'Keep this')
  const sending = drafts.snapshot('task-1')
  drafts.addAttachment('task-1', { id: 'image-2', path: '/tmp/two.png', mimeType: 'image/png', name: 'two.png' })

  assert.equal(drafts.clearIfUnchanged('task-1', sending!), false)
  assert.deepEqual(drafts.get('task-1'), {
    text: 'Keep this',
    attachments: [{ id: 'image-2', path: '/tmp/two.png', mimeType: 'image/png', name: 'two.png' }],
  })
})

test('removing an attachment affects only that attachment', () => {
  const drafts = new TaskDraftStore()
  drafts.addAttachment('task-1', { id: 'a', path: '/tmp/a.png', mimeType: 'image/png', name: 'a.png' })
  drafts.addAttachment('task-1', { id: 'b', path: '/tmp/b.png', mimeType: 'image/png', name: 'b.png' })

  assert.equal(drafts.removeAttachment('task-1', 'a')?.path, '/tmp/a.png')
  assert.deepEqual(drafts.get('task-1').attachments.map((attachment) => attachment.id), ['b'])
})

test('submission waits for an image paste that is still being persisted', async () => {
  const drafts = new TaskDraftStore()
  let release!: () => void
  const persisted = new Promise<void>((resolve) => { release = resolve })

  const staging = drafts.stageAttachment('task-1', async () => {
    await persisted
    return { id: 'image-1', path: '/owned/image.png', mimeType: 'image/png', name: 'image.png' }
  })
  drafts.setText('task-1', 'look at this')

  let settled = false
  const waiting = drafts.whenSettled('task-1').then(() => { settled = true })
  await Promise.resolve()
  assert.equal(settled, false, 'Enter must not overtake an in-flight image paste')

  release()
  await Promise.all([staging, waiting])
  assert.deepEqual(drafts.snapshot('task-1'), {
    text: 'look at this',
    attachments: [{ id: 'image-1', path: '/owned/image.png', mimeType: 'image/png', name: 'image.png' }],
  })
})

test('a failed image persistence blocks submission until the user retries the paste', async () => {
  const drafts = new TaskDraftStore()
  drafts.setText('task-1', 'do not send this alone')

  await assert.rejects(
    drafts.stageAttachment('task-1', async () => { throw new Error('disk unavailable') }),
    /disk unavailable/,
  )
  assert.equal(await drafts.whenSettled('task-1'), false)

  await drafts.stageAttachment('task-1', async () => ({
    id: 'image-1', path: '/owned/image.png', mimeType: 'image/png', name: 'image.png',
  }))
  assert.equal(await drafts.whenSettled('task-1'), true, 'a fresh successful paste clears the staging failure')
})
