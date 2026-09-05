import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskDraftStore } from './task-draft'
import { draftInput } from './task-input'

const image = (id: string) => ({ id, path: `/owned/${id}.png`, name: id, mimeType: 'image/png' })
const reserve = (d: TaskDraftStore, id: string, offset = 0, length = 0) => d.reserveAttachment('t', id, id,
  { operationId: id, insertionOffset: offset, selectedLength: length, insertionText: d.get('t').text })

test('cancel during actual persistence excludes late append and releases only that operation', async () => {
  const d = new TaskDraftStore(); d.setText('t', 'keep')
  reserve(d, 'first'); reserve(d, 'other')
  let entered!: () => void, release!: () => void
  const began = new Promise<void>(r => { entered = r }), gate = new Promise<void>(r => { release = r })
  const pending = d.stageAttachment('t', async () => { entered(); await gate; return image('first') }, { operationId: 'first' })
  await began
  d.removeAttachment('t', 'first')
  d.failAttachment('t', 'other', 'other failed')
  assert.equal(await d.whenSettled('t'), false, 'canceled persistence must no longer hold the send fence')
  release(); await pending
  assert.equal(d.get('t').attachments.length, 0)
  assert.equal(d.get('t').text, 'keep')
  assert.equal(await d.whenSettled('t'), false)
  d.removeAttachment('t', 'other')
  assert.equal(await d.whenSettled('t'), true)
  assert.equal(d.get('t').error, undefined)
})

test('cancel before delivery remains canceled when the handoff arrives', async () => {
  const d = new TaskDraftStore(); reserve(d, 'one'); d.removeAttachment('t', 'one')
  let persisted = false
  await d.stageAttachment('t', async () => { persisted = true; return image('one') }, { operationId: 'one' })
  assert.equal(persisted, false)
  assert.equal(d.get('t').attachments.length, 0)
  assert.equal(await d.whenSettled('t'), true)
})

test('null refusal is an operation failure; another success cannot clear it', async () => {
  const d = new TaskDraftStore(); reserve(d, 'one'); reserve(d, 'two')
  await assert.rejects(d.stageAttachment('t', async () => null, { operationId: 'one' }), /refused/i)
  await d.stageAttachment('t', async () => image('two'), { operationId: 'two' })
  assert.equal(await d.whenSettled('t'), false)
  assert.match(d.get('t').operations!.find(o => o.id === 'one')!.error!, /refused/i)
  d.removeAttachment('t', 'one')
  assert.equal(await d.whenSettled('t'), true)
  assert.deepEqual((await draftInput(d.get('t'))).map(p => p.type), ['image'])
})

test('retry restores reservation order in provider input through typing and selected replacement', async () => {
  const d = new TaskDraftStore(); d.setText('t', 'left SELECT right', 1)
  reserve(d, 'one', 5, 6); reserve(d, 'two', 5, 6)
  await assert.rejects(d.stageAttachment('t', async () => { throw Error('bad copy') }, { operationId: 'one' }))
  d.setText('t', 'NEW left SELECT right', 2)
  await d.stageAttachment('t', async () => image('two'), { operationId: 'two' })
  reserve(d, 'one') // retry must not recapture the new caret or reorder
  await d.stageAttachment('t', async () => image('one'), { operationId: 'one' })
  assert.equal(d.get('t').text, 'NEW left  right')
  const parts = await draftInput(d.get('t'))
  assert.deepEqual(parts.map(p => p.type === 'image' ? p.name : p.text), ['NEW left ', 'one', 'two', ' right'])
})

test('persisted orphan reservations recover as visible removable failures', () => {
  const dir = mkdtempSync(join(tmpdir(), 'unmute-stage-test-'))
  try {
    const path = join(dir, 'drafts.json'), first = new TaskDraftStore()
    first.connectFile(path, e => { throw e }); first.setText('t', 'retain text'); reserve(first, 'one'); first.flush()
    const recovered = new TaskDraftStore(); recovered.connectFile(path, e => { throw e })
    assert.equal(recovered.get('t').operations![0].phase, 'failed')
    assert.match(recovered.get('t').operations![0].error!, /interrupted/i)
    recovered.removeAttachment('t', 'one'); recovered.flush()
    assert.equal(recovered.get('t').text, 'retain text')
    assert.equal(recovered.get('t').stagingCount, undefined)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('typing at a reserved selection start cannot become deleted attachment replacement', async () => {
  const d = new TaskDraftStore(); d.setText('t', 'left SELECT right', 1); reserve(d, 'one', 5, 6)
  d.setText('t', 'left NEWSELECT right', 2)
  await d.stageAttachment('t', async () => image('one'), { operationId: 'one' })
  assert.equal(d.get('t').text, 'left NEWSELECT right')
  assert.equal(d.get('t').attachments[0].offset, 5)
})

test('an ordinary later attachment does not jump ahead of a reserved attachment', async () => {
  const d = new TaskDraftStore(); reserve(d, 'native')
  await d.stageAttachment('t', async () => image('native'), { operationId: 'native' })
  d.addAttachment('t', image('ordinary'))
  assert.deepEqual((await draftInput(d.get('t'))).map(p => p.type === 'image' ? p.name : p.text), ['native', 'ordinary'])
})
