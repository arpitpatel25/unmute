import test from 'node:test'
import assert from 'node:assert/strict'
import { ComposerDictationCoordinator, applyComposerDictation, dispatchCaptureWithLifecycle, startComposerDictation } from './composer-dictation'
import { TaskDraftStore } from './task-draft'

test('a queued capture keeps its original task and selection after a new capture starts', () => {
  const dictation = new ComposerDictationCoordinator()
  const first = dictation.begin('task-a', {
    insertionOffset: 7,
    selectedLength: 6,
    clientRevision: 3,
    insertionText: 'before SELECT after',
    operationId: 'first-operation',
  }, 'first-token')

  dictation.markTranscribing(first.token)
  assert.equal(dictation.markQueued(first.token), true)
  assert.equal(dictation.abandonActive(), null, 'session-ended cleanup must not revoke queued work')

  const second = dictation.begin('task-b', {
    insertionOffset: 2,
    insertionText: 'xy',
    operationId: 'second-operation',
  }, 'second-token')

  assert.equal(dictation.abandon(first.token), false, 'a late A finalizer cannot abandon active B')
  assert.equal(dictation.stateFor('task-b'), 'recording')
  assert.deepEqual(dictation.claim(first), {
    kind: 'deliver',
    taskId: 'task-a',
    insertion: {
      insertionOffset: 7,
      selectedLength: 6,
      clientRevision: 3,
      insertionText: 'before SELECT after',
      operationId: 'first-operation',
    },
  })
  assert.equal(dictation.stateFor('task-b'), 'recording', 'late delivery cannot clear the new mic')
  assert.deepEqual(dictation.activeDelivery, second)
})

test('a delayed composer delivery bypasses generic phase, busy, focus, and voice effects', async () => {
  let releaseDelivery!: () => void
  const delayedDelivery = new Promise<void>(resolve => { releaseDelivery = resolve })
  const effects: string[] = []
  const replacement = { processing: true, taskId: 'task-b', focusTaskId: 'task-b' }

  const dispatchA = dispatchCaptureWithLifecycle({
    composer: async () => {
      await delayedDelivery
      return 'task-a'
    },
    routed: async () => {
      effects.push('routed')
      return 'wrong-task'
    },
    initialResult: null,
    onRouting: () => {
      effects.push('phase:routing', 'busy:set', 'focus:changed')
      replacement.processing = false
      replacement.focusTaskId = 'wrong-task'
    },
    onIdle: () => {
      effects.push('phase:idle', 'busy:cleared')
      replacement.processing = false
    },
    onAcknowledge: () => effects.push('voice:acknowledged'),
  })

  releaseDelivery()
  assert.equal(await dispatchA, 'task-a')
  assert.deepEqual(replacement, { processing: true, taskId: 'task-b', focusTaskId: 'task-b' })
  assert.deepEqual(effects, [])
})

test('a cancelled capture is dropped instead of falling through or reaching a replacement capture', () => {
  const dictation = new ComposerDictationCoordinator()
  const stale = dictation.begin('same-task', {
    insertionOffset: 1,
    insertionText: 'old',
    operationId: 'old-operation',
  }, 'cancelled-token')

  assert.equal(dictation.abandon(stale.token), true)
  const fresh = dictation.begin('same-task', {
    insertionOffset: 3,
    insertionText: 'new',
    operationId: 'new-operation',
  }, 'fresh-token')

  assert.deepEqual(dictation.claim(stale), { kind: 'drop' })
  assert.deepEqual(dictation.activeDelivery, fresh)
  assert.equal(dictation.markQueued(fresh.token), true)
  assert.deepEqual(dictation.claim(fresh), {
    kind: 'deliver',
    taskId: 'same-task',
    insertion: {
      insertionOffset: 3,
      insertionText: 'new',
      operationId: 'new-operation',
    },
  })
})

test('an empty, failed, or hardware-cancelled capture releases composer recording state', () => {
  const dictation = new ComposerDictationCoordinator()

  for (const token of ['empty', 'failed', 'hardware-cancel']) {
    dictation.begin('task', undefined, token)
    dictation.markTranscribing(token)
    assert.equal(dictation.abandonActive(), token)
    assert.equal(dictation.stateFor('task'), 'idle')
  }

  assert.equal(dictation.stateFor('task'), 'idle')
  assert.equal(dictation.activeDelivery, null)
})

test('captured insertion metadata is immutable and cannot be redirected by a late caller mutation', () => {
  const dictation = new ComposerDictationCoordinator()
  const insertion = {
    insertionOffset: 4,
    selectedLength: 2,
    insertionText: 'keep selection',
    operationId: 'image-and-text',
  }
  const delivery = dictation.begin('captured-task', insertion, 'immutable-token')

  insertion.insertionOffset = 99
  const tampered = {
    ...delivery,
    taskId: 'focused-later',
    insertion: { ...delivery.insertion, operationId: 'mutated' },
  }

  dictation.markQueued(delivery.token)
  assert.deepEqual(dictation.claim(tampered), {
    kind: 'deliver',
    taskId: 'captured-task',
    insertion: {
      insertionOffset: 4,
      selectedLength: 2,
      insertionText: 'keep selection',
      operationId: 'image-and-text',
    },
  })
})

test('delivery only edits the captured draft and stages images at the same captured selection', async () => {
  const dictation = new ComposerDictationCoordinator()
  const drafts = new TaskDraftStore()
  drafts.setText('captured-task', 'before SELECT after', 4)
  drafts.setText('focused-later', 'leave this alone', 9)
  const delivery = dictation.begin('captured-task', {
    insertionOffset: 7,
    selectedLength: 6,
    clientRevision: 4,
    insertionText: 'before SELECT after',
    operationId: 'dictation-operation',
  }, 'delivery-token')
  dictation.markQueued(delivery.token)

  const landed = await applyComposerDictation(
    dictation.claim(delivery),
    'spoken words',
    ['/capture/one.png', '/capture/two.png'],
    {
      drafts,
      taskExists: id => id === 'captured-task',
      stageImage: async (taskId, path, insertion) => {
        drafts.addAttachment(taskId, { id: `staged-${path}`, path, mimeType: 'image/png', name: path }, insertion)
      },
    },
  )

  assert.equal(landed, 'captured-task')
  assert.equal(drafts.get('captured-task').text, 'before spoken words after')
  assert.deepEqual(drafts.get('captured-task').attachments.map(({ id, path, offset }) => ({ id, path, offset })), [
    { id: 'dictation-operation:image:0', path: '/capture/one.png', offset: 7 },
    { id: 'dictation-operation:image:1', path: '/capture/two.png', offset: 7 },
  ])
  drafts.removeAttachment('captured-task', 'dictation-operation:image:0')
  assert.deepEqual(drafts.get('captured-task').attachments.map(a => a.id), ['dictation-operation:image:1'])
  assert.equal(drafts.get('focused-later').text, 'leave this alone')
})

test('delivery drops when its captured task was deleted without recreating a draft', async () => {
  const dictation = new ComposerDictationCoordinator()
  const drafts = new TaskDraftStore()
  drafts.setText('deleted-task', 'old draft')
  const delivery = dictation.begin('deleted-task', undefined, 'deleted-token')
  dictation.markQueued(delivery.token)
  drafts.forget('deleted-task')

  const landed = await applyComposerDictation(dictation.claim(delivery), 'late words', [], {
    drafts,
    taskExists: () => false,
    stageImage: async () => assert.fail('a deleted task must not stage images'),
  })

  assert.equal(landed, null)
  assert.deepEqual(drafts.get('deleted-task'), { text: '', attachments: [] })
})

test('a synchronous engine start exception abandons only its originating token', () => {
  const dictation = new ComposerDictationCoordinator()
  const result = startComposerDictation(dictation, 'task-a', undefined, () => {
    throw new Error('microphone unavailable')
  })

  assert.equal(result.started, false)
  assert.equal(result.error?.message, 'microphone unavailable')
  assert.equal(dictation.stateFor('task-a'), 'idle')
  assert.deepEqual(dictation.claim(result.delivery), { kind: 'drop' })
})
