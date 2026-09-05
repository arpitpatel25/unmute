import test from 'node:test'
import assert from 'node:assert/strict'
import { TaskDraftStore } from './task-draft'
import { deliverAddressedCapture } from './addressed-capture'
import { TaskFollowupCoordinator, type FollowupGate } from './task-followup'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('distinct capture waits for the prior snapshot acknowledgement and preserves later typing', async () => {
  for (const mode of ['queue', 'edited', 'unavailable']) {
    const laterTyping = mode === 'edited'
    const drafts = new TaskDraftStore(); drafts.setText('t', 'original message')
    const root = mkdtempSync(join(tmpdir(), 'capture-distinct-')), image = join(root, 'capture.png'); writeFileSync(image, 'image')
    let gate: FollowupGate = { kind: 'idle', sessionId: 's', generation: 1, blocked: false }
    let acknowledge!: () => void, started!: () => void
    const began = new Promise<void>(resolve => { started = resolve })
    const providerMessages: string[] = []
    const queue = new TaskFollowupCoordinator({ store: drafts, assetsRoot: root,
      scope: () => ({ provider: 'claude', sessionId: 's' }), gate: () => gate, changed: () => {},
      deliver: async () => { throw new Error('No completion yet') },
      immediate: async (_id, onSnapshot) => {
        const snapshot = drafts.snapshot('t')!; onSnapshot?.(snapshot)
        providerMessages.push(snapshot.text); started()
        await new Promise<void>(resolve => { acknowledge = resolve })
        drafts.acceptSnapshot('t', snapshot)
        gate = mode === 'unavailable' ? { kind: 'unavailable', reason: 'Connection changed' }
          : { kind: 'active', fence: { sessionId: 's', generation: 1, turnId: 'original-turn' }, blocked: false }
        return { kind: 'accepted' }
      },
    })
    const first = queue.submit('t'); await began
    let captureSubmitted!: () => void
    const submitted = new Promise<void>(resolve => { captureSubmitted = resolve })
    const capture = deliverAddressedCapture({ taskId: 't', text: 'new capture', attachments: [image], drafts,
      persistAttachment: async () => ({ id: 'capture-image', path: image, mimeType: 'image/png', name: 'Capture' }),
      submitDraft: (id, request) => { const result = queue.submit(id, request); captureSubmitted(); return result },
    })
    await submitted
    if (laterTyping) drafts.appendText('t', ' plus newer typing')
    acknowledge(); assert.equal((await first).kind, 'accepted')
    const result = await capture
    assert.equal(result.kind, mode === 'queue' ? 'queued' : 'retained')
    assert.deepEqual(providerMessages, ['original message'])
    if (mode !== 'queue') {
      assert.equal(drafts.get('t').text, '\nnew capture' + (laterTyping ? ' plus newer typing' : ''))
      assert.equal(drafts.get('t').attachments[0].path, image)
      assert.equal(drafts.getFollowup('t'), undefined)
    } else {
      assert.equal(drafts.getFollowup('t')?.draft.text, '\nnew capture')
      assert.equal(drafts.getFollowup('t')?.draft.attachments.length, 1)
      assert.equal(drafts.get('t').text, '')
    }
  }
})

test('addressed busy capture queues once without double-clear and later capture cannot overtake it', async () => {
  class ObservedDrafts extends TaskDraftStore {
    clears = 0
    override clearIfUnchanged(id: string, snapshot: import('./task-draft').TaskDraft): boolean { this.clears++; return super.clearIfUnchanged(id, snapshot) }
  }
  const drafts = new ObservedDrafts(), root = mkdtempSync(join(tmpdir(), 'capture-queue-')), path = join(root, 'image.png')
  writeFileSync(path, 'image')
  let gate: FollowupGate = { kind: 'active', fence: { sessionId: 's', generation: 1, turnId: 'turn1' }, blocked: false }
  const sent: string[] = []
  const queue = new TaskFollowupCoordinator({ store: drafts, assetsRoot: root, scope: () => ({ provider: 'claude', sessionId: 's' }), gate: () => gate,
    deliver: async (_id, r) => { sent.push(r.draft.text); return { kind: 'accepted', submissionId: 'next' } }, immediate: async () => { throw new Error('Capture bypassed queue') }, changed: () => {} })
  const input = { taskId: 't', drafts, persistAttachment: async () => ({ id: 'image', path, mimeType: 'image/png', name: 'Image' }), submitDraft: (id: string, request: import('./task-followup').DraftSubmissionRequest) => queue.submit(id, request) }
  assert.equal((await deliverAddressedCapture({ ...input, text: 'captured', attachments: [path] })).kind, 'queued')
  assert.equal(drafts.clears, 0); assert.equal(drafts.get('t').text, '')
  assert.equal(drafts.getFollowup('t')?.draft.attachments.length, 1)
  assert.equal((await deliverAddressedCapture({ ...input, text: 'later capture', attachments: [] })).kind, 'retained')
  assert.equal(drafts.get('t').text, 'later capture')
  gate = { kind: 'idle', sessionId: 's', generation: 1, blocked: false }
  assert.equal((await deliverAddressedCapture({ ...input, text: 'at completion', attachments: [] })).kind, 'retained')
  assert.deepEqual(sent, [])
  queue.turnEnded({ taskId: 't', fence: { sessionId: 's', generation: 1, turnId: 'turn1' }, outcome: 'completed' }); await queue.settled('t')
  assert.deepEqual(sent, ['captured']); assert.equal(drafts.get('t').text, 'later capture\nat completion'); assert.equal(drafts.clears, 0)
})

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
