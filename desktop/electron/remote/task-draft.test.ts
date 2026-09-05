import test from 'node:test'
import assert from 'node:assert/strict'
import { TaskDraftStore } from './task-draft'

test('dictation inserts at its captured selection without overwriting subsequent edits', () => {
  const drafts = new TaskDraftStore()
  drafts.setText('t', 'before after', 1)
  drafts.insertText('t', 'spoken ', { insertionOffset: 7, insertionText: 'before after' })
  assert.equal(drafts.get('t').text, 'before spoken after')
  drafts.setText('t', 'NEW before spoken after', 2)
  drafts.insertText('t', 'second ', { insertionOffset: 7, selectedLength: 6, insertionText: 'before spoken after' })
  assert.equal(drafts.get('t').text, 'NEW before second spoken after')
})

test('undo and redo a collapsed paste restore its selection and retain other input', () => {
  const drafts = new TaskDraftStore()
  drafts.setText('t', 'before SELECT after', 1)
  drafts.addAttachment('t', { id: 'p', path: '/paste', name: 'Paste', mimeType: 'text/x-unmute-paste' }, { insertionOffset: 7, selectedLength: 6, insertionText: 'before SELECT after' })
  assert.equal(drafts.get('t').text, 'before  after')
  drafts.undoAttachment('t', 'p')
  assert.equal(drafts.get('t').text, 'before SELECT after')
  drafts.redoAttachment('t', 'p')
  assert.equal(drafts.get('t').text, 'before  after')
  assert.equal(drafts.get('t').attachments[0].path, '/paste')
})

test('removing a task while an attachment stages cannot resurrect its draft', async () => {
  const drafts = new TaskDraftStore()
  let release!: () => void
  const gate = new Promise<void>(r => { release = r })
  const staging = drafts.stageAttachment('t', async () => { await gate; return { id: 'p', path: '/paste', name: 'Paste', mimeType: 'text/plain' } })
  drafts.forget('t')
  release(); await staging
  assert.deepEqual(drafts.get('t'), { text: '', attachments: [] })
})

test('paste anchors retain mixed text order through typing and atomic edit', () => {
  const drafts = new TaskDraftStore()
  drafts.setText('t', 'beforeafter', 1)
  drafts.addAttachment('t', { id: 'p', path: '/paste', mimeType: 'text/x-unmute-paste', name: 'Paste' }, { insertionOffset: 6, insertionText: 'beforeafter' })
  drafts.setText('t', 'beforeNEWafter', 2)
  assert.equal(drafts.get('t').attachments[0].offset, 6)
  drafts.restoreAttachment('t', 'p', ' PASTED ')
  assert.equal(drafts.get('t').text, 'before PASTED NEWafter')
  assert.equal(drafts.get('t').attachments.length, 0)
})

test('late paste staging never deletes a selection edited while staging', () => {
  const drafts = new TaskDraftStore()
  drafts.setText('t', 'new value', 2)
  drafts.addAttachment('t', { id: 'p', path: '/p', mimeType: 'text/plain', name: 'p' }, { insertionOffset: 0, selectedLength: 3, insertionText: 'old value', clientRevision: 1 })
  assert.equal(drafts.get('t').text, 'new value')
})

test('accepted snapshot consumes only submitted content while retaining new typing and attachments', () => {
  const drafts = new TaskDraftStore()
  drafts.setText('task', 'first', 1)
  drafts.addAttachment('task', { id: 'one', path: '/one', name: 'one', mimeType: 'image/png' })
  const submitted = drafts.snapshot('task')!
  drafts.setText('task', 'first and next', 2)
  drafts.addAttachment('task', { id: 'two', path: '/two', name: 'two', mimeType: 'image/png' })
  drafts.acceptSnapshot('task', submitted)
  assert.equal(drafts.get('task').text, ' and next')
  assert.deepEqual(drafts.get('task').attachments.map((a) => a.id), ['two'])
  assert.equal(drafts.get('task').clientRevision, 2)
})

test('stale editor revisions cannot overwrite newer typing and acknowledgment survives send', () => {
  const drafts = new TaskDraftStore()
  drafts.setText('task', 'hey WhatsApp', 12)
  drafts.setText('task', 'hey W', 5)
  assert.equal(drafts.get('task').text, 'hey WhatsApp')
  assert.equal(drafts.get('task').clientRevision, 12)
  assert.equal(drafts.clearIfUnchanged('task', drafts.snapshot('task')!), true)
  assert.equal(drafts.get('task').clientRevision, 12)
  drafts.setText('task', 'hey Wh', 6)
  assert.equal(drafts.get('task').text, '')
  drafts.setText('task', 'next', 13)
  assert.equal(drafts.get('task').text, 'next')
})

test('task drafts retain text and ordered attachments until a successful clear', () => {
  const drafts = new TaskDraftStore()

  drafts.appendText('task-1', 'Look at this')
  const draftId = drafts.traceId('task-1')
  drafts.addAttachment('task-1', { id: 'image-1', path: '/tmp/one.png', mimeType: 'image/png', name: 'one.png' })
  drafts.appendText('task-1', '\nand compare it')

  assert.deepEqual(drafts.get('task-1'), {
    text: 'Look at this\nand compare it',
    attachments: [{ id: 'image-1', path: '/tmp/one.png', mimeType: 'image/png', name: 'one.png', offset: 12 }],
  })

  const sending = drafts.snapshot('task-1')
  assert.deepEqual(sending, drafts.get('task-1'), 'a send snapshot does not clear the visible draft')
  assert.equal(drafts.clearIfUnchanged('task-1', sending!), true)
  assert.deepEqual(drafts.get('task-1'), { text: '', attachments: [] })
  assert.notEqual(drafts.traceId('task-1'), draftId, 'the next draft gets a new diagnostic identity')
})

test('task draft survives a failed send and later edits prevent clearing an old snapshot', () => {
  const drafts = new TaskDraftStore()
  drafts.setText('task-1', 'Keep this')
  const sending = drafts.snapshot('task-1')
  drafts.addAttachment('task-1', { id: 'image-2', path: '/tmp/two.png', mimeType: 'image/png', name: 'two.png' })

  assert.equal(drafts.clearIfUnchanged('task-1', sending!), false)
  assert.deepEqual(drafts.get('task-1'), {
    text: 'Keep this',
    attachments: [{ id: 'image-2', path: '/tmp/two.png', mimeType: 'image/png', name: 'two.png', offset: 9 }],
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
    attachments: [{ id: 'image-1', path: '/owned/image.png', mimeType: 'image/png', name: 'image.png', offset: 12 }],
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
