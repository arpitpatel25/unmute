import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, statSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskDraftStore } from './task-draft'
import { TaskFollowupCoordinator, type FollowupGate, type FollowupRecord, type NewTurnOutcome } from './task-followup'

const record = (store: TaskDraftStore) => ({ id: 'q', taskId: 't', owner: 'unmute' as const, provider: 'claude' as const,
  sessionId: 's', createdAt: '2026-09-05T00:00:00Z', phase: 'queued' as const,
  after: { sessionId: 's', generation: 1, turnId: 'turn1' }, draft: store.get('t'), input: [{ type: 'text' as const, text: 'next' }], files: [] })

test('queue transfer refuses concurrent edits and persists cancellation without touching newer typing', () => {
  const store = new TaskDraftStore()
  store.setText('t', 'A😀B', 1)
  const version = store.version('t'), snapshot = record(store)
  store.setText('t', 'A😀BC', 2)
  assert.equal(store.transferToFollowup('t', version, snapshot), false)
  assert.equal(store.get('t').text, 'A😀BC')
  assert.equal(store.transferToFollowup('t', store.version('t'), record(store)), true)
  assert.equal(store.get('t').text, '')
  store.setText('t', 'new typing', 3)
  assert.equal(store.updateFollowup('t', 'q', r => ({ ...r, phase: 'saved' })), true)
  assert.equal(store.restoreFollowup('t', 'q', store.version('t')), false)
  assert.equal(store.get('t').text, 'new typing')
  assert.equal(store.getFollowup('t')?.draft.text, 'A😀BC')
})

test('restart disarms queued and submitting records; legacy drafts migrate atomically', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'followup-')), 'drafts.json')
  writeFileSync(path, JSON.stringify([['t', { text: 'next', attachments: [] }]]))
  const store = new TaskDraftStore(); store.connectFile(path, assert.fail)
  assert.equal(store.transferToFollowup('t', store.version('t'), record(store)), true)
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).version, 2)
  const restored = new TaskDraftStore(); restored.connectFile(path, assert.fail)
  assert.equal(restored.getFollowup('t')?.phase, 'saved')
  store.updateFollowup('t', 'q', r => ({ ...r, phase: 'submitting', attemptId: 'attempt' }))
  const uncertain = new TaskDraftStore(); uncertain.connectFile(path, assert.fail)
  assert.equal(uncertain.getFollowup('t')?.phase, 'uncertain')
  assert.equal(uncertain.restoreFollowup('t', 'q', uncertain.version('t')), false)
})

test('failed durable transfer cannot clear draft or publish a queue', () => {
  const root = mkdtempSync(join(tmpdir(), 'followup-'))
  const blocker = join(root, 'file'); writeFileSync(blocker, 'not a directory')
  const store = new TaskDraftStore(); store.connectFile(join(blocker, 'drafts'), () => {})
  store.setText('t', 'next')
  assert.equal(store.transferToFollowup('t', store.version('t'), record(store)), false)
  assert.equal(store.get('t').text, 'next')
  assert.equal(store.getFollowup('t'), undefined)
})

function setup(onPrepare: () => void = () => {}) {
  const store = new TaskDraftStore(); store.setText('t', 'next')
  let gate: FollowupGate = { kind: 'active', fence: { sessionId: 's', generation: 1, turnId: 'turn1' }, blocked: false }
  const calls: FollowupRecord[] = []
  const outcomes: any[] = []
  let outcome: NewTurnOutcome = { kind: 'accepted', submissionId: 'next-turn' }
  const root = mkdtempSync(join(tmpdir(), 'followup-assets-'))
  let delivery: (() => Promise<NewTurnOutcome>) | undefined
  const queue = new TaskFollowupCoordinator({ store, assetsRoot: () => { onPrepare(); return root },
    scope: id => id === 't' ? { provider: 'claude', sessionId: 's' } : undefined,
    gate: () => gate, deliver: async (_id, r) => { calls.push(r); return delivery ? delivery() : outcome },
    immediate: async () => ({ kind: 'accepted' }), changed: () => {}, onOutcome: e => outcomes.push(e) })
  return { store, queue, calls, outcomes, setGate: (next: FollowupGate) => { gate = next }, setOutcome: (next: NewTurnOutcome) => { outcome = next }, setDelivery: (fn: () => Promise<NewTurnOutcome>) => { delivery = fn } }
}
const ended = { taskId: 't', fence: { sessionId: 's', generation: 1, turnId: 'turn1' }, outcome: 'completed' as const }

test('rendered question context scopes duplicate acknowledgments and never enters the new-turn queue', async () => {
  const store = new TaskDraftStore(); store.setText('t', 'same text')
  const A = { requestId: 'A', stepId: '0' }, B = { requestId: 'B', stepId: '0' }
  const contexts: unknown[] = []
  let finish!: () => void
  const queue = new TaskFollowupCoordinator({ store, assetsRoot: '/unused', scope: () => ({ provider: 'claude', sessionId: 's' }),
    gate: () => ({ kind: 'active', fence: ended.fence, blocked: true }),
    deliver: async () => { throw new Error('Answers must never use queue delivery') }, changed() {},
    immediate: async (_id, snapshot, context) => {
      contexts.push(context); snapshot?.(store.get('t'))
      if (contexts.length === 1) await new Promise<void>(r => { finish = r })
      return { kind: context?.requestId === 'A' ? 'accepted' : 'retained', reason: 'expired' } as any
    },
  })
  const request = { id: 'capture', snapshot: store.get('t') }
  const a = queue.submit('t', request, A)
  assert.equal(queue.submit('t', request, A), a)
  const b = queue.submit('t', request, B); assert.notEqual(a, b)
  await new Promise(resolve => setImmediate(resolve)); finish()
  assert.equal((await a).kind, 'accepted'); assert.equal((await b).kind, 'retained')
  assert.deepEqual(contexts, [A]); assert.equal(store.getFollowup('t'), undefined)
  assert.equal(store.get('t').text, 'same text')
})

test('a request appearing while a new-turn draft stages cannot absorb its prose', async () => {
  const store = new TaskDraftStore(); store.setText('t', 'unrelated prose')
  let blocked = false, immediate = 0, finish!: (value: any) => void
  const staged = store.stageAttachment('t', () => new Promise(r => { finish = r }))
  const queue = new TaskFollowupCoordinator({ store, assetsRoot: '/unused', scope: () => ({ provider: 'claude', sessionId: 's' }),
    gate: () => ({ kind: 'idle', sessionId: 's', generation: 1, blocked }), deliver: async () => { throw new Error('No queue') }, changed() {},
    immediate: async () => { immediate++; return { kind: 'accepted' } },
  })
  const sending = queue.submit('t', undefined, null)
  await new Promise(resolve => setImmediate(resolve)); blocked = true
  finish({ id: 'image', path: '/unused.png', mimeType: 'image/png', name: 'Image' }); await staged
  assert.equal((await sending).kind, 'retained'); assert.equal(immediate, 0)
  assert.equal(store.get('t').text, 'unrelated prose'); assert.equal(store.get('t').attachments.length, 1)
})

test('live completion drains exactly once and never clears newer composer input', async () => {
  const h = setup()
  const [a, b] = await Promise.all([h.queue.submit('t'), h.queue.submit('t')])
  assert.equal(a.kind, 'queued'); assert.deepEqual(a, b); assert.equal(h.calls.length, 0)
  h.store.setText('t', 'new typing')
  assert.equal((await h.queue.submit('t')).kind, 'retained')
  h.setGate({ kind: 'idle', sessionId: 's', generation: 1, blocked: false })
  h.queue.turnEnded(ended); h.queue.turnEnded(ended)
  await h.queue.settled('t')
  assert.equal(h.calls.length, 1); assert.deepEqual(h.calls[0].input, [{ type: 'text', text: 'next' }])
  assert.equal(h.store.get('t').text, 'new typing'); assert.equal(h.store.getFollowup('t'), undefined)
})

test('duplicate clicks for the same identified capture coalesce one local queue acknowledgement', async () => {
  const h = setup(), request = { id: 'same-capture', snapshot: h.store.get('t') }
  const first = h.queue.submit('t', request), duplicate = h.queue.submit('t', request)
  assert.equal(first, duplicate)
  assert.equal((await first).kind, 'queued')
  assert.equal(h.outcomes.filter(e => e.disposition === 'queued-locally').length, 1)
})

test('cancel retains saved follow-up separately and stale cancellation cannot affect another task', async () => {
  const h = setup(); const result = await h.queue.submit('t'); assert.equal(result.kind, 'queued')
  const id = h.store.getFollowup('t')!.id
  h.store.setText('t', 'later')
  assert.equal(await h.queue.cancel('other', id), false)
  assert.equal(await h.queue.cancel('t', id), true)
  h.setGate({ kind: 'idle', sessionId: 's', generation: 1, blocked: false }); h.queue.turnEnded(ended)
  await h.queue.settled('t')
  assert.equal(h.calls.length, 0); assert.equal(h.store.getFollowup('t')?.phase, 'saved')
  assert.equal(await h.queue.restore('t', id), false); assert.equal(h.store.get('t').text, 'later')
})

test('completion token waits for approval and historical idle cannot invent a token', async () => {
  const h = setup(); await h.queue.submit('t')
  h.setGate({ kind: 'idle', sessionId: 's', generation: 1, blocked: true })
  h.queue.readinessChanged('t'); await h.queue.settled('t'); assert.equal(h.calls.length, 0)
  h.queue.turnEnded(ended); await h.queue.settled('t'); assert.equal(h.calls.length, 0)
  h.setGate({ kind: 'idle', sessionId: 's', generation: 1, blocked: false })
  h.queue.readinessChanged('t'); await h.queue.settled('t'); assert.equal(h.calls.length, 1)
})

test('disconnect disarms; uncertainty never retries after completion or reconnection', async () => {
  const h = setup(); await h.queue.submit('t')
  h.queue.disarm('t', 'Disconnected'); await h.queue.settled('t')
  h.setGate({ kind: 'idle', sessionId: 's', generation: 1, blocked: false }); h.queue.turnEnded(ended)
  await h.queue.settled('t'); assert.equal(h.calls.length, 0)
  h.setGate({ kind: 'active', fence: ended.fence, blocked: false })
  await h.queue.queueSaved('t', h.store.getFollowup('t')!.id)
  h.setOutcome({ kind: 'uncertain', reason: 'missing acknowledgement' })
  h.setGate({ kind: 'idle', sessionId: 's', generation: 1, blocked: false }); h.queue.turnEnded(ended)
  await h.queue.settled('t'); assert.equal(h.calls.length, 1); assert.equal(h.store.getFollowup('t')?.phase, 'uncertain')
  h.queue.readinessChanged('t'); h.queue.turnEnded(ended); await h.queue.settled('t'); assert.equal(h.calls.length, 1)
})

test('queued payload freezes mixed paste and image bytes; another idle draft cannot overtake it', async () => {
  const h = setup(), dir = mkdtempSync(join(tmpdir(), 'followup-mixed-'))
  const paste = join(dir, 'paste.txt'), image = join(dir, 'image.png')
  writeFileSync(paste, 'full pasted content'); writeFileSync(image, 'original image')
  h.store.setText('t', 'before after')
  h.store.addAttachment('t', { id: 'paste', path: paste, mimeType: 'text/x-unmute-paste', name: 'Paste', offset: 6 }, { insertionOffset: 6 })
  h.store.addAttachment('t', { id: 'image', path: image, mimeType: 'image/png', name: 'Image' }, { insertionOffset: 6 })
  await h.queue.submit('t')
  const queued = h.store.getFollowup('t')!
  assert.deepEqual(queued.input.map(p => p.type === 'text' ? p.text : 'IMAGE'), ['before', 'full pasted content', 'IMAGE', ' after'])
  assert.equal(h.queue.view('t')?.preview, 'before after')
  assert.equal(statSync(queued.draft.attachments[0].path).mode & 0o777, 0o600)
  writeFileSync(paste, 'changed original'); writeFileSync(image, 'changed original')
  assert.equal(readFileSync(queued.draft.attachments[1].path, 'utf8'), 'original image')
  h.store.setText('t', 'later')
  h.setGate({ kind: 'idle', sessionId: 's', generation: 1, blocked: false })
  assert.equal((await h.queue.submit('t')).kind, 'retained')
  h.queue.turnEnded(ended); await h.queue.settled('t')
  assert.equal(h.calls.length, 1); assert.equal(h.store.get('t').text, 'later')
})

test('damaged frozen attachment pauses without provider submission', async () => {
  const h = setup(), path = join(mkdtempSync(join(tmpdir(), 'followup-damaged-')), 'image.png')
  writeFileSync(path, 'image')
  h.store.addAttachment('t', { id: 'image', path, mimeType: 'image/png', name: 'Image' })
  await h.queue.submit('t')
  writeFileSync(h.store.getFollowup('t')!.files[0].path, 'changed')
  h.setGate({ kind: 'idle', sessionId: 's', generation: 1, blocked: false }); h.queue.turnEnded(ended)
  await h.queue.settled('t')
  assert.equal(h.calls.length, 0); assert.equal(h.store.getFollowup('t')?.phase, 'saved')
})

test('an unrelated turn disarms a queue even before any completion token', async () => {
  const h = setup(); await h.queue.submit('t')
  h.setGate({ kind: 'active', fence: { ...ended.fence, turnId: 'other-turn' }, blocked: false })
  h.queue.readinessChanged('t'); await h.queue.settled('t')
  assert.equal(h.store.getFollowup('t')?.phase, 'saved')
  assert.equal(h.calls.length, 0)
})

test('completion during preparation delivers only with its live token; edits during preparation retain everything', async () => {
  for (const changed of [false, true]) {
    const h = setup(() => {
      if (changed) h.store.setText('t', 'newer edited draft')
      h.setGate({ kind: 'idle', sessionId: 's', generation: 1, blocked: false }); h.queue.turnEnded(ended)
    })
    const path = join(mkdtempSync(join(tmpdir(), 'followup-preparing-')), 'paste.txt'); writeFileSync(path, 'large paste')
    h.store.addAttachment('t', { id: 'paste', path, mimeType: 'text/x-unmute-paste', name: 'Paste' })
    assert.equal((await h.queue.submit('t')).kind, changed ? 'retained' : 'queued')
    await h.queue.settled('t')
    assert.equal(h.calls.length, changed ? 0 : 1)
    if (changed) { assert.equal(h.store.get('t').text, 'newer edited draft'); assert.equal(h.store.get('t').attachments.length, 1) }
  }
})

test('cancel after the durable submitting boundary cannot claim retraction; uncertainty needs informed recovery', async () => {
  const h = setup(); await h.queue.submit('t')
  const id = h.store.getFollowup('t')!.id
  let finish!: (outcome: NewTurnOutcome) => void, started!: () => void
  const began = new Promise<void>(resolve => { started = resolve })
  h.setDelivery(() => { started(); return new Promise(resolve => { finish = resolve }) })
  h.setGate({ kind: 'idle', sessionId: 's', generation: 1, blocked: false }); h.queue.turnEnded(ended)
  await began
  assert.equal(await h.queue.cancel('t', id), false)
  finish({ kind: 'uncertain', reason: 'write lost' }); await h.queue.settled('t')
  assert.equal(await h.queue.restore('t', id), false)
  assert.equal(await h.queue.restore('t', id, true), true)
  assert.equal(h.store.get('t').text, 'next'); assert.equal(h.calls.length, 1)
})

test('automatic drain traces correlate attempts and dispositions without input or provider error text', async () => {
  for (const kind of ['accepted', 'not-sent', 'uncertain'] as const) {
    const h = setup(); h.store.setText('t', 'private user content')
    h.setOutcome(kind === 'accepted' ? { kind, submissionId: 'provider-turn' } : { kind, reason: 'private provider error' })
    await h.queue.submit('t')
    h.setGate({ kind: 'idle', sessionId: 's', generation: 1, blocked: false }); h.queue.turnEnded(ended); await h.queue.settled('t')
    assert.deepEqual(h.outcomes.map(e => e.disposition), ['queued-locally', 'submitting', kind === 'accepted' ? 'provider-accepted' : kind === 'not-sent' ? 'retained' : 'uncertain'])
    assert.equal(h.outcomes[1].attemptId, h.calls[0].attemptId)
    assert.equal(h.outcomes[2].attemptId, h.calls[0].attemptId)
    assert.equal(h.outcomes[0].queueId, h.outcomes[2].queueId)
    assert.equal(h.outcomes[2].persistence, 'saved')
    assert.doesNotMatch(JSON.stringify(h.outcomes), /private|content|reason|input/)
  }
})

test('provider acceptance plus local removal failure cannot replay and restart recovers uncertainty', async () => {
  const h = setup(), directory = mkdtempSync(join(tmpdir(), 'followup-save-failure-')), path = join(directory, 'drafts.json')
  h.store.connectFile(path, () => {})
  await h.queue.submit('t')
  h.setDelivery(async () => {
    renameSync(directory, directory + '-preserved')
    writeFileSync(directory, 'block future directory writes')
    return { kind: 'accepted', submissionId: 'accepted-turn' }
  })
  h.setGate({ kind: 'idle', sessionId: 's', generation: 1, blocked: false }); h.queue.turnEnded(ended); await h.queue.settled('t')
  assert.equal(h.calls.length, 1)
  assert.equal(h.outcomes.at(-1).disposition, 'provider-accepted')
  assert.equal(h.outcomes.at(-1).persistence, 'failed')
  assert.equal(h.queue.view('t')?.canQueueAgain, false)
  assert.equal(h.queue.view('t')?.canRestore, false)
  h.queue.turnEnded(ended); h.queue.readinessChanged('t'); await h.queue.settled('t'); assert.equal(h.calls.length, 1)
  const recovered = new TaskDraftStore(); recovered.connectFile(join(directory + '-preserved', 'drafts.json'), assert.fail)
  assert.equal(recovered.getFollowup('t')?.phase, 'uncertain')
  assert.equal(recovered.getFollowup('t')?.draft.text, 'next')
})
