import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import {
  NotchController, classify, relativeAge, headlineFor,
  type TaskLite, type NotchClientLike, type NotchControllerDeps, type ProposalLite,
} from './notch-controller'
import type { NotchCommand, NotchEvent, CockpitPayload } from './notch-client'
import { TaskDraftStore } from '../task-draft'
import { stageTaskDraftAttachment, persistTaskDraftFile } from '../task-draft-attachment'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

class FakeClient extends EventEmitter implements NotchClientLike {
  sent: NotchCommand[] = []
  send(cmd: NotchCommand): void { this.sent.push(cmd) }
  fire(evt: NotchEvent): void { this.emit(evt.type, evt) }
  last<T extends NotchCommand['type']>(type: T): Extract<NotchCommand, { type: T }> | undefined {
    return [...this.sent].reverse().find((c) => c.type === type) as Extract<NotchCommand, { type: T }> | undefined
  }
  ofType<T extends NotchCommand['type']>(type: T): Array<Extract<NotchCommand, { type: T }>> {
    return this.sent.filter((c) => c.type === type) as Array<Extract<NotchCommand, { type: T }>>
  }
}

/** Presence under our control: we decide how much of the user's time has
 *  passed and when they walked back in, because both are load-bearing. */
class FakePresence extends EventEmitter {
  active = true
  private ms = 0
  awakeMs(): number { return this.ms }
  /** Time passes WITH the user here — this is what spends a demand window. */
  spend(ms: number): void { this.ms += ms }
  /** Time passes while they are away — the window must not move. */
  away(): void { this.active = false }
  /** They touched the machine again. The one self-opening trigger. */
  wake(): void { this.active = true; this.emit('wake') }
  stop(): void {}
}

interface Harness {
  events: EventEmitter
  presence: FakePresence
  client: FakeClient
  controller: NotchController
  tasks: Map<string, TaskLite>
  calls: Record<string, unknown[][]>
  /** Make `answer` report a REFUSAL — an open picker Unmute will not drive. */
  refuseAnswers(): void
  flush(): void
}

/**
 * ONE CLOCK READING FOR EVERY DEFAULTED TASK — not `Date.now()` per call.
 *
 * The controller orders the queue by `updatedAt` DESCENDING (`byEngagement`),
 * so two tasks built back to back were a coin flip: land in the same
 * millisecond and the stable sort keeps `put` order, land one millisecond apart
 * and the SECOND one fronts. Every test that puts two tasks and then asserts
 * which one the surface is showing was therefore flaky — measured at roughly
 * 1 in 4 for `a REFUSED chip click keeps the surface on the question too`,
 * which is how it turned up as a single red test in an otherwise green suite.
 *
 * Freezing the default makes every defaulted task tie, and a tie under a stable
 * sort is `put` order — which is what the tests were already assuming. A test
 * that genuinely cares about recency passes its own `updatedAt` and overrides
 * this, so nothing that meant to exercise the ordering stops doing so.
 */
const T0 = Date.now()

function makeTask(partial: Partial<TaskLite> & { id: string }): TaskLite {
  return {
    intent: 'do the thing', state: 'processing', kind: 'oneoff', alive: true,
    createdAt: T0 - 60_000, updatedAt: T0, ...partial,
  }
}

function setup(opts: { proposals?: ProposalLite[]; getOutput?: (id: string) => string; answerAsync?: NotchControllerDeps['answerAsync']; createChat?: NotchControllerDeps['createChat']; deps?: Partial<NotchControllerDeps> } = {}): Harness {
  const events = new EventEmitter()
  const client = new FakeClient()
  const tasks = new Map<string, TaskLite>()
  const calls: Record<string, unknown[][]> = {}
  const rec = (name: string) => (...args: unknown[]) => { (calls[name] ??= []).push(args) }
  let doorbell = true
  let lastSeen = Date.now()
  let answersLand = true
  const deps: NotchControllerDeps = {
    listTasks: () => [...tasks.values()],
    getTask: (id) => tasks.get(id),
    // True = the answer landed. False is a REFUSAL: the task is still blocked on
    // the same question, so the crank must stay on it.
    answer: (id, text) => { rec('answer')(id, text); return answersLand },
    answerAsync: opts.answerAsync,
    createChat: opts.createChat,
    kill: rec('kill'),
    remove: rec('remove'),
    killAll: rec('killAll'),
    resume: (id) => { rec('resume')(id); return true },
    rerun: rec('rerun'),
    setKind: rec('setKind'),
    setName: rec('setName'),
    // Recorded AND applied, like the real TaskManager: the pocket reads the
    // flag back through getTask/listTasks.
    setInPocket: (id, inPocket) => {
      rec('setInPocket')(id, inPocket)
      const t = tasks.get(id)
      if (t) tasks.set(id, { ...t, pocketRemoved: !inPocket })
    },
    setNote: rec('setNote'),
    focus: rec('focus'),
    opened: rec('opened'),
    getOutput: opts.getOutput ?? ((id) => `replay:${id}`),
    sendInput: rec('sendInput'),
    resizeTerm: rec('resizeTerm'),
    openInTerminal: rec('openInTerminal'),
    tmuxAvailable: () => true,
    listSkills: async () => [
      { name: 'gmail-sweep', pinned: true, runs: 4, origin: 'unmute' as const },
      { name: 'pr-test-cases', pinned: false, runs: 12 },
    ],
    listProjects: async () => [{ name: 'unmute-cloud', path: '/tools/unmute-cloud' }],
    pinSkill: rec('pinSkill'),
    tapSkill: rec('tapSkill'),
    openProject: rec('openProject'),
    listProposals: async () => opts.proposals ?? [],
    getProposal: async (id) => (opts.proposals ?? []).find((p) => p.id === id) ?? null,
    acceptProposal: async (id) => { rec('acceptProposal')(id); return { ok: true } },
    rejectProposal: rec('rejectProposal'),
    converseStart: async (id, onData) => { rec('converseStart')(id); onData('hello from cc\n'); return true },
    converseWrite: rec('converseWrite'),
    converseStop: rec('converseStop'),
    openArtifact: rec('openArtifact'),
    acceptRouteOffer: (id) => { rec('acceptRouteOffer')(id); return true },
    getDoorbell: () => doorbell,
    setDoorbell: (on) => { doorbell = on },
    getLastSeen: () => lastSeen,
    setLastSeen: (ms) => { lastSeen = ms },
    scratchpadArm: rec('scratchpadArm'),
    scratchpadRemove: rec('scratchpadRemove'),
    scratchpadDeliver: rec('scratchpadDeliver'),
    scratchpadDiscard: rec('scratchpadDiscard'),
    ...opts.deps,
  }
  const presence = new FakePresence()
  const controller = new NotchController(client, events, deps, presence)
  // AUTO-EXPAND OFF BY DEFAULT IN TESTS.
  //
  // It ships ON, but almost every case below is about the ATTENTION rung — what
  // the bar does when something starts needing you — and auto-expand jumps
  // straight past that to the task surface. Leaving it on here would have every
  // one of those assertions really testing auto-expand instead of the thing it
  // names. The behaviour itself is covered explicitly further down.
  controller.setAutoExpand(false)
  // reconcile is debounced 80ms — tests force it synchronously by re-firing.
  const flush = () => { (controller as unknown as { reconcile(): void }).reconcile() }
  return { events, client, controller, presence, tasks, calls, flush, refuseAnswers: () => { answersLand = false } }
}

function put(h: Harness, t: TaskLite): void {
  h.tasks.set(t.id, t)
  h.events.emit('updated', t)
  h.flush()
}

test('a size chosen on the live notch becomes the persisted expanded size', () => {
  const stored: number[] = []
  const h = setup({ deps: { setSurfaceFill: (fill: number) => { stored.push(fill) } } as unknown as Partial<NotchControllerDeps> })

  h.client.fire({ type: 'surfaceFillChanged', fill: 0.79 } as unknown as NotchEvent)

  assert.deepEqual(stored, [0.79])
})

test('rendered request identity rejects stale chips and composer answers before delivery', async () => {
  const A = { requestId: 'A', stepId: '0' }, B = { requestId: 'B', stepId: '0' }
  const sent: unknown[] = []
  const h = setup({ answerAsync: async (...args) => { sent.push(args); return true }, deps: { sendDraft: async (...args) => { sent.push(args); return true } } })
  put(h, makeTask({ id: 't', state: 'needs-user', question: { text: 'B?', choices: ['Allow'], reference: B } }))
  let addressed = 0; h.controller.addressed = () => { addressed++ }
  h.client.fire({ type: 'chooseOption', id: 't', index: 0, reference: A })
  h.client.fire({ type: 'answerText', id: 't', text: 'old', reference: A })
  h.client.fire({ type: 'sendDraft', id: 't', reference: A })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(sent, []); assert.equal(addressed, 0)
  h.client.fire({ type: 'chooseOption', id: 't', index: 0, reference: B })
  await new Promise(resolve => setImmediate(resolve))
  h.client.fire({ type: 'chooseOption', id: 't', index: 0, reference: B })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(sent, [['t', 'Allow', B]]); assert.equal(addressed, 1)
})

test('pending duplicate cannot clear acknowledgment; rejected answer remains retryable', async () => {
  const reference = { requestId: 'A', stepId: '0' }
  let finish!: (accepted: boolean) => void, deliveries = 0
  const h = setup({ answerAsync: async () => { deliveries++; return new Promise(resolve => { finish = resolve }) } })
  put(h, makeTask({ id: 't', state: 'needs-user', question: { text: 'A?', choices: ['Allow'], reference } }))
  let addressed = 0; h.controller.addressed = () => { addressed++ }
  h.client.fire({ type: 'chooseOption', id: 't', index: 0, reference })
  h.client.fire({ type: 'chooseOption', id: 't', index: 0, reference })
  assert.equal(h.client.last('questionAnswerStatus')?.state, 'pending')
  assert.equal(addressed, 0); assert.equal(deliveries, 1)
  finish(false); await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.client.last('questionAnswerStatus')?.state, 'rejected')
  h.client.fire({ type: 'chooseOption', id: 't', index: 0, reference })
  assert.equal(deliveries, 2)
  finish(true); await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.client.last('questionAnswerStatus')?.state, 'accepted'); assert.equal(addressed, 1)
})

test('queued composer acknowledgement leaves pending attention unaddressed and Agent queue actions inert', async () => {
  let canceled = 0
  const h = setup({ deps: { sendDraft: async () => ({ kind: 'queued', queueId: 'q' }), cancelTaskFollowup: () => { canceled++; return true } } })
  put(h, makeTask({ id: 't', state: 'needs-user', question: { text: 'Approve?' } }))
  let addressed = 0
  h.controller.addressed = () => { addressed++ }
  h.client.fire({ type: 'sendDraft', id: 't' })
  await new Promise(resolve => setImmediate(resolve)); h.flush()
  assert.equal(addressed, 0)
  h.client.fire({ type: 'cancelTaskFollowup', id: NotchController.AGENT_SLOT, queueId: 'q' })
  h.client.fire({ type: 'cancelTaskFollowup', id: 't', queueId: 'q' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(canceled, 1)
})

test('rejected composer mutations surface readable errors', async () => {
  const rejected = async () => { throw new Error('draft is locked') }
  const h = setup({ deps: {
    addDraftImage: rejected,
    configureChat: rejected,
    restoreDraftAttachment: rejected,
    undoDraftAttachment: rejected,
    redoDraftAttachment: rejected,
  } })
  h.client.fire({ type: 'addDraftImage', id: 'a', path: '/tmp/a', mimeType: 'image/png', name: 'a.png', operationId: 'op-a' })
  h.client.fire({ type: 'configureChat', id: 'a', change: { field: 'model', value: 'x' } })
  h.client.fire({ type: 'restoreDraftAttachment', id: 'a', attachmentId: 'x' })
  h.client.fire({ type: 'undoDraftAttachment', id: 'a', attachmentId: 'x' })
  h.client.fire({ type: 'redoDraftAttachment', id: 'a', attachmentId: 'x' })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(h.client.ofType('toast').map(item => item.text), [
    'Could not attach file: draft is locked',
    'Could not update chat settings: draft is locked',
    'Could not restore attachment: draft is locked',
    'Could not undo attachment: draft is locked',
    'Could not redo attachment: draft is locked',
  ])
  assert.deepEqual(h.client.last('draftAttachmentError'), { type: 'draftAttachmentError', id: 'a', operationId: 'op-a', error: 'draft is locked' })
})

test('production attachment bridge propagates errors and refusal, then removing failures permits send', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'unmute-staging-bridge-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const source = join(dir, 'source'); await writeFile(source, 'not image bytes')
  const drafts = new TaskDraftStore(), logged: string[] = []
  drafts.setText('t', 'remaining text')
  let sent = ''
  const h = setup({ deps: {
    reserveDraftAttachment: (id, operation, name, insertion) => drafts.reserveAttachment(id, operation, name, insertion),
    failDraftAttachment: (id, operation, error) => drafts.failAttachment(id, operation, error),
    addDraftImage: (id, path, mime, name, insertion) => stageTaskDraftAttachment({
      drafts, persist: async () => (await persistTaskDraftFile(drafts, {
        get: () => true,
        attachFile: async (_, bytes) => {
          if (name === 'copy') await writeFile(join(dir, 'missing-directory', 'owned'), bytes)
          return null
        },
      }, id, path, mime, name))?.attachment ?? null,
      cleanup: async () => {}, failed: error => { logged.push(String(error)) },
    }, id, insertion),
    removeDraftAttachment: (id, op) => { drafts.removeAttachment(id, op) },
    getDraft: id => drafts.get(id),
    sendDraft: async id => { if (await drafts.whenSettled(id)) { sent = drafts.get(id).text; return { kind: 'delivered' } }; return { kind: 'refused' } },
  } })
  put(h, makeTask({ id: 't' }))
  for (const op of ['validate', 'copy', 'refuse']) {
    h.client.fire({ type: 'reserveDraftAttachment', id: 't', operationId: op, name: op })
    h.client.fire({ type: 'addDraftImage', id: 't', path: source, mimeType: op === 'validate' ? 'image/png' : 'text/plain', name: op, operationId: op })
    await drafts.whenSettled('t')
    await new Promise(resolve => setImmediate(resolve))
  }
  assert.deepEqual(h.client.ofType('draftAttachmentError').map(e => e.operationId), ['validate', 'copy', 'refuse'])
  assert.equal(logged.length, 3)
  h.client.fire({ type: 'removeDraftAttachment', id: 't', attachmentId: 'validate' })
  h.client.fire({ type: 'removeDraftAttachment', id: 't', attachmentId: 'copy' })
  assert.equal(await drafts.whenSettled('t'), false)
  h.client.fire({ type: 'removeDraftAttachment', id: 't', attachmentId: 'refuse' })
  h.client.fire({ type: 'sendDraft', id: 't' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(sent, 'remaining text')
})

// ── basics ──────────────────────────────────────────────────────────────────

test('classify maps only your-move states', () => {
  assert.equal(classify('needs-user'), 'needs-user')
  assert.equal(classify('stuck'), 'stuck')
  assert.equal(classify('failed'), 'errored')
  assert.equal(classify('processing'), null)
  assert.equal(classify('done'), null)
})

test('compact active state binds its title to the sole processing task', () => {
  const h = setup()
  const finished = makeTask({ id: 'finished', name: 'Counting loop', state: 'needs-user' })
  put(h, finished)
  assert.equal(h.client.last('showTask')?.task.id, 'finished')

  put(h, { ...finished, state: 'done', alive: false })
  put(h, makeTask({ id: 'live', name: 'WhatsApp Rishi message', state: 'processing' }))

  assert.deepEqual(h.client.last('setState'), {
    type: 'setState', state: 'active', attention: 0, working: 1,
  })
  assert.equal(h.client.last('showTask')?.task.id, 'live',
    'Working and the compact title must describe the same task')
})

test('relativeAge formats compactly', () => {
  const now = 1_000_000_000_000
  assert.equal(relativeAge(now - 5_000, now), '5s')
  assert.equal(relativeAge(now - 120_000, now), '2m')
  assert.equal(relativeAge(now - 7_200_000, now), '2h')
})

test('your-move task → attention with full TaskDetail', () => {
  const h = setup()
  put(h, makeTask({ id: 't1', state: 'needs-user', name: 'RCA', question: { text: 'which service?', choices: ['api', 'billing'] } }))
  const show = h.client.last('showTask')!
  assert.equal(show.task.id, 't1')
  assert.equal(show.task.title, 'RCA')
  assert.equal(show.task.question?.text, 'which service?')
  assert.equal(h.client.last('setState')!.state, 'attention')
})

test('working baseline is active; empty is dormant', () => {
  const h = setup()
  put(h, makeTask({ id: 'w', state: 'processing' }))
  assert.equal(h.client.last('setState')!.state, 'active')
  h.tasks.delete('w')
  h.events.emit('removed', { id: 'w' }); h.flush()
  assert.equal(h.client.last('setState')!.state, 'dormant')
})

test('dormant teardown invalidates task detail so the same task can be shown again', () => {
  const h = setup()
  const task = makeTask({ id: 'w', state: 'processing', name: 'Long-running session' })
  put(h, task)
  const first = h.client.ofType('showTask').length
  assert.ok(first > 0)

  h.tasks.delete(task.id)
  h.events.emit('removed', { id: task.id })
  h.flush()
  assert.equal(h.client.last('setState')!.state, 'dormant')

  put(h, task)
  assert.ok(h.client.ofType('showTask').length > first,
    'native cleared model.task on dormant, so unchanged detail must cross the wire again')
})

// ── gestures ────────────────────────────────────────────────────────────────

test('tap with a front task → task surface + focus; tap idle → cockpit', () => {
  const h = setup()
  put(h, makeTask({ id: 't1', state: 'done', kind: 'session' }))
  h.client.fire({ type: 'tap' })
  assert.equal(h.client.last('setState')!.state, 'task')
  assert.deepEqual(h.calls.focus?.at(-1), ['t1'])

  const h2 = setup()
  h2.client.fire({ type: 'tap' })
  assert.equal(h2.client.last('setState')!.state, 'cockpit')
  assert.ok(h2.client.last('setCockpit'))
})

// CHANGED 2026-09-19 (focus-stealing fix). This used to expect the surface to
// jump to 'next' as soon as the open task FINISHED — the task you were reading
// was replaced, and the voice went with it, without you doing anything. An open
// task now stays open until you move; only its REMOVAL advances the surface.
test('an expanded task that finishes stays open and addressed; removing it advances to the next', () => {
  const h = setup()
  h.controller.setAutoExpand(true)
  put(h, makeTask({ id: 'first', name: 'First', state: 'needs-user', updatedAt: T0 + 20 }))
  put(h, makeTask({ id: 'next', name: 'Next', state: 'needs-user', updatedAt: T0 + 10 }))

  put(h, makeTask({ id: 'first', name: 'First', state: 'done', updatedAt: T0 + 30 }))

  assert.equal(h.client.last('showTask')?.task.id, 'first', 'the open task is still the one on screen')
  assert.deepEqual(h.calls.focus?.at(-1), ['first'], 'and still the voice address')

  h.tasks.delete('first')
  h.events.emit('removed', { id: 'first' })
  h.flush()
  assert.equal(h.client.last('showTask')?.task.id, 'next', 'the next waiting task is visibly expanded')
  assert.deepEqual(h.calls.focus?.at(-1), ['next'], 'Right Option must address the task the panel displays')
})

test('next walks the crank and comes back around', () => {
  const h = setup()
  put(h, makeTask({ id: 'a', state: 'done', kind: 'session', name: 'A' }))
  put(h, makeTask({ id: 'b', state: 'needs-user', name: 'B', question: { text: 'q' } }))
  h.client.fire({ type: 'tap' })
  const first = h.client.last('showTask')!.task.id
  h.client.fire({ type: 'next' })
  const second = h.client.last('showTask')!.task.id
  assert.notEqual(first, second)
  // THE AGENT IS ON THE RING TOO, so a two-task pocket is a three-stop crank.
  h.client.fire({ type: 'next' })
  assert.equal(h.client.last('showTask')!.task.id, 'unmute-agent')
  h.client.fire({ type: 'next' })
  assert.deepEqual(h.calls.focus?.at(-1), [first]) // came back around
})

test('expanded next keeps the visible task and voice focus aligned when the Agent is first', () => {
  const h = setup()
  h.controller.agentAnswered('An unread Agent response')
  put(h, makeTask({ id: 'a', state: 'done', kind: 'session', name: 'A' }))
  put(h, makeTask({ id: 'b', state: 'done', kind: 'session', name: 'B' }))
  put(h, makeTask({ id: 'c', state: 'done', kind: 'session', name: 'C' }))

  h.client.fire({ type: 'pocketOpen' })
  h.client.fire({ type: 'pocketMove', delta: 1 }) // Agent → A
  h.client.fire({ type: 'pocketExpand' })
  h.client.fire({ type: 'next' })

  const visible = h.client.last('showTask')!.task.id
  assert.equal(visible, 'b')
  assert.deepEqual(h.calls.focus?.at(-1), [visible],
    'Right Option must address the same task the expanded surface shows')
})

/**
 * FIELD REPORT (2026-09-20). The arrows and the Prev/Next buttons walked every
 * card in the pocket EXCEPT the Agent's — `crankStep` stepped across it on the
 * grounds that the footer arrows are "task navigation". The Agent is the card
 * you talk to most, and the pocket carousel — the same index space — stops on
 * it happily, so the expanded surface was the only place it could not be
 * reached without going back out to the pocket.
 */
test('the crank stops on the Agent card and opens its chat', () => {
  const h = setup()
  h.controller.agentAnswered('An unread Agent response')
  put(h, makeTask({ id: 'a', state: 'done', kind: 'session', name: 'A' }))
  put(h, makeTask({ id: 'b', state: 'done', kind: 'session', name: 'B' }))

  h.client.fire({ type: 'pocketOpen' })
  h.client.fire({ type: 'pocketMove', delta: 1 }) // Agent → A
  h.client.fire({ type: 'pocketExpand' })
  assert.equal(h.client.last('showTask')!.task.id, 'a')

  h.client.fire({ type: 'prev' }) // back onto the Agent, rather than past it
  assert.equal(h.client.last('showTask')!.task.id, 'unmute-agent',
    'the Agent is a card like the others — the crank must land on it')
  assert.deepEqual(h.calls.focus?.at(-1), [null],
    'the Agent is addressed as itself, never as a task id')
})

test('the crank leaves the Agent chat for the task beside it', () => {
  const h = setup()
  h.controller.agentAnswered('An unread Agent response')
  put(h, makeTask({ id: 'a', state: 'done', kind: 'session', name: 'A' }))
  put(h, makeTask({ id: 'b', state: 'done', kind: 'session', name: 'B' }))

  h.client.fire({ type: 'pocketOpen' })
  h.client.fire({ type: 'pocketExpand' })   // the Agent sits first while unread
  assert.equal(h.client.last('showTask')!.task.id, 'unmute-agent')

  // Focus is the assertion, not the payload: the surface only re-sends a
  // detail that CHANGED, and these cards were drawn on the way in.
  h.client.fire({ type: 'next' })
  assert.deepEqual(h.calls.focus?.at(-1), ['a'],
    'cranking out of the chat lands on the card beside it, voice and all')

  // And the crank carried on from THERE — proof the chat let go rather than
  // staying open behind a task.
  h.client.fire({ type: 'next' })
  assert.deepEqual(h.calls.focus?.at(-1), ['b'])

  h.client.fire({ type: 'next' })
  assert.deepEqual(h.calls.focus?.at(-1), [null], 'round again onto the Agent')
})

test('prev cranks backward (reverse rotation of next)', () => {
  const h = setup()
  put(h, makeTask({ id: 'a', state: 'done', kind: 'session', name: 'A' }))
  put(h, makeTask({ id: 'b', state: 'needs-user', name: 'B', question: { text: 'q' } }))
  put(h, makeTask({ id: 'c', state: 'done', kind: 'session', name: 'C' }))
  h.client.fire({ type: 'tap' })
  const first = h.client.last('showTask')!.task.id
  h.client.fire({ type: 'next' })
  const second = h.client.last('showTask')!.task.id
  assert.notEqual(second, first)
  h.client.fire({ type: 'prev' })
  assert.equal(h.client.last('showTask')!.task.id, first) // back where we were
})

test('chooseOption answers with the choice label and advances', () => {
  const h = setup()
  put(h, makeTask({ id: 't1', state: 'needs-user', question: { text: 'q', choices: ['Yes', 'No'] } }))
  h.client.fire({ type: 'chooseOption', id: 't1', index: 1 })
  assert.deepEqual(h.calls.answer?.[0], ['t1', 'No'])
})

test('answerText answers free-text', () => {
  const h = setup()
  put(h, makeTask({ id: 't1', state: 'needs-user', question: { text: 'q', kind: 'free_text' } }))
  h.client.fire({ type: 'answerText', id: 't1', text: 'use the beta env' })
  assert.deepEqual(h.calls.answer?.[0], ['t1', 'use the beta env'])
})

test('per-task actions pass through to the runtime internals', () => {
  const h = setup()
  put(h, makeTask({ id: 't1', state: 'needs-user', question: { text: 'q' }, intent: 'orig intent' }))
  h.client.fire({ type: 'kill', id: 't1' })
  h.client.fire({ type: 'resume', id: 't1' })
  h.client.fire({ type: 'rerun', id: 't1' })
  h.client.fire({ type: 'remove', id: 't1' })
  h.client.fire({ type: 'killAll' })
  h.client.fire({ type: 'setKind', id: 't1', kind: 'session' })
  h.client.fire({ type: 'removeFromPocket', id: 't1' })
  h.client.fire({ type: 'rename', id: 't1', name: 'better name' })
  h.client.fire({ type: 'setNote', id: 't1', note: 'JIRA-42' })
  assert.deepEqual(h.calls.kill?.[0], ['t1'])
  assert.deepEqual(h.calls.resume?.[0], ['t1'])
  assert.deepEqual(h.calls.rerun?.[0], ['orig intent'])
  assert.deepEqual(h.calls.remove?.[0], ['t1'])
  assert.equal(h.calls.killAll?.length, 1)
  assert.deepEqual(h.calls.setKind?.[0], ['t1', 'session'])
  assert.deepEqual(h.calls.setInPocket?.[0], ['t1', false])
  assert.deepEqual(h.calls.setName?.[0], ['t1', 'better name'])
  assert.deepEqual(h.calls.setNote?.[0], ['t1', 'JIRA-42'])
})

// ── terminal streaming ──────────────────────────────────────────────────────

test('termOpen replays buffered output and streams live chunks; close stops', () => {
  const h = setup()
  put(h, makeTask({ id: 't1', state: 'processing' }))
  h.client.fire({ type: 'termOpen', id: 't1' })
  const replay = h.client.ofType('termData')[0]
  assert.equal(Buffer.from(replay.data, 'base64').toString('utf8'), 'replay:t1')

  h.events.emit('output', { taskId: 't1', chunk: 'live!' })
  const live = h.client.ofType('termData').at(-1)!
  assert.equal(Buffer.from(live.data, 'base64').toString('utf8'), 'live!')

  h.events.emit('output', { taskId: 'other', chunk: 'noise' })
  assert.equal(h.client.ofType('termData').length, 2) // filtered by open set

  h.client.fire({ type: 'termClose', id: 't1' })
  h.events.emit('output', { taskId: 't1', chunk: 'after-close' })
  assert.equal(h.client.ofType('termData').length, 2)
})

test('termOpen emits termData even when there is no buffered output — SwiftTerm needs a definitive replay-boundary signal to know when it is safe to start forwarding keystrokes/replies', () => {
  const h = setup({ getOutput: () => '' })
  put(h, makeTask({ id: 't1', state: 'processing' }))
  h.client.fire({ type: 'termOpen', id: 't1' })
  assert.equal(h.client.ofType('termData').length, 1)
  assert.equal(h.client.ofType('termData')[0].data, '')
})

test('termInput decodes base64 to PTY stdin; termResize passes through', () => {
  const h = setup()
  h.client.fire({ type: 'termInput', id: 't1', data: Buffer.from('ls\r').toString('base64') })
  assert.deepEqual(h.calls.sendInput?.[0], ['t1', 'ls\r'])
  h.client.fire({ type: 'termResize', id: 't1', cols: 120, rows: 34 })
  assert.deepEqual(h.calls.resizeTerm?.[0], ['t1', 120, 34])
})

// ── skills / rails ──────────────────────────────────────────────────────────

test('async approval buttons do not duplicate or advance before acceptance', async () => {
  let resolve!: (ok: boolean) => void, count = 0
  const h = setup({ answerAsync: async () => { count++; return new Promise<boolean>(r => { resolve = r }) } })
  put(h, makeTask({ id: 't1', state: 'needs-user', question: { text: 'Allow?', choices: ['Allow once'] } }))
  h.client.fire({ type: 'focusTask', id: 't1' })
  h.client.fire({ type: 'chooseOption', id: 't1', index: 0 })
  h.client.fire({ type: 'chooseOption', id: 't1', index: 0 })
  assert.equal(count, 1)
  assert.equal(h.tasks.get('t1')?.state, 'needs-user')
  resolve(false)
  await new Promise(r => setImmediate(r))
  h.client.fire({ type: 'chooseOption', id: 't1', index: 0 })
  assert.equal(count, 2, 'a rejected answer remains actionable')
  resolve(false)
  await new Promise(r => setImmediate(r))
})

test('native managed creation requires the displayed allocation before creating any project', async () => {
  let creates = 0
  const h = setup({ createChat: async () => { creates++; return 'new' } })
  h.client.fire({ type: 'newChat', provider: 'claude' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(creates, 0)
  assert.match(h.client.last('newChatStatus')?.error ?? '', /preview/i)
})

test('new conversation creation is guarded and opens the accepted empty chat', async () => {
  let resolve!: (id: string) => void, count = 0
  const h = setup({ createChat: async () => { count++; return new Promise<string>(r => { resolve = r }) } })
  h.client.fire({ type: 'newChat', provider: 'claude', cwd: '/Project' })
  h.client.fire({ type: 'newChat', provider: 'claude', cwd: '/Project' })
  assert.equal(count, 1)
  assert.equal(h.client.last('newChatStatus')?.pending, true)
  put(h, makeTask({ id: 'new', state: 'done', alive: false, chatWritable: true }))
  resolve('new')
  await new Promise(r => setImmediate(r))
  assert.equal(h.client.last('newChatStatus')?.pending, false)
  assert.deepEqual(h.calls.focus?.at(-1), ['new'])
})

test('tapSkill reports success only when the owned-task guard accepts it', async () => {
  let accepted = false
  const h = setup({ deps: { tapSkill: async () => accepted } })
  h.client.fire({ type: 'tapSkill', name: 'gmail-sweep' })
  assert.ok(h.client.last('toast')!.text.includes('Open a task first'))
  put(h, makeTask({ id: 't1', state: 'needs-user', alive: true, question: { text: 'q' } }))
  h.client.fire({ type: 'focusTask', id: 't1' })
  h.client.fire({ type: 'tapSkill', name: 'gmail-sweep' })
  await new Promise(resolve => setImmediate(resolve))
  assert.match(h.client.last('toast')!.text, /can't add|cannot add/i)
  accepted = true
  h.client.fire({ type: 'tapSkill', name: 'gmail-sweep' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.client.last('toast')!.text, 'Added /gmail-sweep to draft')
})

test('openDashboard builds the full cockpit payload', async () => {
  const h = setup()
  const old = Date.now() - 30 * 60 * 1000
  put(h, makeTask({ id: 's1', state: 'processing', kind: 'session', name: 'Notch UI', group: 'unmute', cwd: `${process.env.HOME}/tools/x` }))
  put(h, makeTask({ id: 'o1', state: 'done', kind: 'oneoff', name: 'Old done', updatedAt: old, alive: false }))
  put(h, makeTask({ id: 'pr1', state: 'done', kind: 'session', name: 'Out of the pocket', pocketRemoved: true }))
  h.client.fire({ type: 'openDashboard' })
  await new Promise((r) => setTimeout(r, 10)) // rails are async
  h.flush()
  const cp: CockpitPayload = h.client.last('setCockpit')!.data
  // groups: named first, faded done excluded
  assert.ok(cp.groups.some((g) => g.name === 'unmute' && g.cards.some((c) => c.id === 's1')))
  assert.ok(!cp.groups.flatMap((g) => g.cards).some((c) => c.id === 'o1')) // done >15m → faded
  // NO SHELF: a task out of the pocket is an ordinary card on the wall.
  assert.ok(cp.groups.flatMap((g) => g.cards).some((c) => c.id === 'pr1'))
  assert.equal((cp as Record<string, unknown>).shelf, undefined)
  // rails
  assert.equal(cp.skills.length, 1)
  assert.equal(cp.unmuteSkills.length, 1)
  // Projects now feed the actionable new-conversation folder picker.
  assert.deepEqual((cp as Record<string, unknown>).projects, [{ name: 'unmute-cloud', path: '/tools/unmute-cloud' }])
  assert.equal((cp as Record<string, unknown>).suggestions, undefined)
  assert.equal(cp.doorbell, true)
  assert.equal(cp.tmuxAvailable, true)
  // queue: only your-move
  assert.ok(!cp.queue.some((q) => q.id === 'pr1'))
})

test('moving between expanded tasks silently opens each selected task', () => {
  const h = setup()
  put(h, makeTask({ id: 'a', state: 'done', kind: 'session', alive: false }))
  put(h, makeTask({ id: 'b', state: 'done', kind: 'session', alive: false }))
  h.client.fire({ type: 'focusTask', id: 'a' })
  // Two stops, because the Agent's own card sits on the ring between them and
  // opening a chat is not opening a task.
  h.client.fire({ type: 'next' })
  h.client.fire({ type: 'next' })
  assert.deepEqual(h.calls.opened, [['a'], ['b']])
})

test('clearFinished hides settled one-offs from the rail', async () => {
  const h = setup()
  put(h, makeTask({ id: 'o1', state: 'done', kind: 'oneoff', name: 'Done thing', alive: false }))
  h.client.fire({ type: 'openDashboard' })
  await new Promise((r) => setTimeout(r, 10)); h.flush()
  assert.ok(h.client.last('setCockpit')!.data.oneoffs.some((o) => o.id === 'o1'))
  h.client.fire({ type: 'clearFinished' })
  assert.ok(!h.client.last('setCockpit')!.data.oneoffs.some((o) => o.id === 'o1'))
})

test('bellToggle flips the doorbell in the payload', async () => {
  const h = setup()
  h.client.fire({ type: 'openDashboard' })
  await new Promise((r) => setTimeout(r, 10)); h.flush()
  assert.equal(h.client.last('setCockpit')!.data.doorbell, true)
  h.client.fire({ type: 'bellToggle' })
  assert.equal(h.client.last('setCockpit')!.data.doorbell, false)
})

// ── curator popup ───────────────────────────────────────────────────────────

const PROPOSAL: ProposalLite = {
  id: 'p1', kind: 'create',
  draft: { name: 'morning-inbox-sweep', description: 'd', body: '---\nname: x\n---\nbody' },
  evidence: { occurrences: 3, sessions: [{}, {}, {}], struggle: { wallClockMin: 12 } },
  rationale: 'You sweep your inboxes every morning.',
}

test('suggestionOpen maps the proposal; accept calls through + toasts', async () => {
  const h = setup({ proposals: [PROPOSAL] })
  h.client.fire({ type: 'suggestionOpen', id: 'p1' })
  await new Promise((r) => setTimeout(r, 10))
  const p = h.client.last('proposal')!.data
  assert.equal(p.kind, 'new')
  assert.equal(p.name, 'morning-inbox-sweep')
  assert.ok(p.evidence.includes('seen 3×'))
  assert.ok(p.evidence.includes('3 sessions'))

  h.client.fire({ type: 'suggestionAccept', id: 'p1' })
  await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(h.calls.acceptProposal?.[0], ['p1'])
  assert.equal(h.client.last('toast')!.text, 'skill saved')
})

test('converseWrite lazily starts the review session and streams output', async () => {
  const h = setup({ proposals: [PROPOSAL] })
  h.client.fire({ type: 'converseWrite', id: 'p1', text: 'only the work account' })
  await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(h.calls.converseStart?.[0], ['p1'])
  assert.deepEqual(h.calls.converseWrite?.[0], ['p1', 'only the work account\r'])
  assert.equal(h.client.last('convData')!.text, 'hello from cc\n')
  // second write reuses the session
  h.client.fire({ type: 'converseWrite', id: 'p1', text: 'thanks' })
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(h.calls.converseStart?.length, 1)
})

// ── attention policy: staleness + mute (decided 2026-07-24) ─────────────────

test('a checkpoint older than the demand window leaves the crank (cockpit only); blocked never ages out', async () => {
  const h = setup()
  const old = Date.now() - 7 * 60 * 60 * 1000
  put(h, makeTask({ id: 'stale', state: 'done', kind: 'session', name: 'Old ready', updatedAt: old }))
  put(h, makeTask({ id: 'oldblocked', state: 'needs-user', name: 'Old blocked', updatedAt: old, question: { text: 'q' } }))
  // stale ready is NOT fronted; the old blocked one is (blocked never ages out)
  assert.equal(h.client.last('setState')!.state, 'attention')
  assert.equal(h.client.last('showTask')!.task.id, 'oldblocked')
  assert.equal(h.client.last('setState')!.attention, 1)
  // …but the stale ready is still a cockpit card
  h.client.fire({ type: 'openDashboard' })
  await new Promise((r) => setTimeout(r, 10)); h.flush()
  const cp = h.client.last('setCockpit')!.data
  assert.ok(cp.groups.flatMap((g) => g.cards).some((c) => c.id === 'stale'))
  assert.ok(!cp.queue.some((q) => q.id === 'stale'))
})

test('a fresh checkpoint IS in the crank', () => {
  const h = setup()
  put(h, makeTask({ id: 'fresh', state: 'done', kind: 'session', updatedAt: Date.now() - 60_000 }))
  assert.equal(h.client.last('setState')!.state, 'attention')
})

test('mute drops a task from attention until its state changes', () => {
  const h = setup()
  put(h, makeTask({ id: 't1', state: 'done', kind: 'session', name: 'Parked' }))
  assert.equal(h.client.last('setState')!.state, 'attention')
  h.client.fire({ type: 'mute', id: 't1' })
  assert.equal(h.client.last('setState')!.state, 'dormant') // nothing else waiting
  // still muted on a same-state update
  h.events.emit('updated', h.tasks.get('t1')); h.flush()
  assert.equal(h.client.last('setState')!.state, 'dormant')
  // state CHANGE ends the episode: back to work, then ready again → re-enters
  h.tasks.set('t1', makeTask({ id: 't1', state: 'processing', name: 'Parked' }))
  h.events.emit('updated', h.tasks.get('t1')); h.flush()
  h.tasks.set('t1', makeTask({ id: 't1', state: 'done', kind: 'session', name: 'Parked' }))
  h.events.emit('done', h.tasks.get('t1')); h.flush()
  assert.equal(h.client.last('setState')!.state, 'attention')
})

test('interacting with a muted task (focus) ends its mute episode', () => {
  const h = setup()
  put(h, makeTask({ id: 't1', state: 'done', kind: 'session', name: 'Parked' }))
  h.client.fire({ type: 'mute', id: 't1' })
  assert.equal(h.client.last('setState')!.state, 'dormant')
  h.client.fire({ type: 'focusTask', id: 't1' }) // user opened it in the cockpit
  h.flush()
  assert.equal(h.client.last('setState')!.state, 'cockpit')
  // ...and CLOSING it counts as having seen it, so a finished task does not
  // come straight back to nag. Seen-is-enough applies to `ready` only.
  h.client.fire({ type: 'collapsed' })
  assert.equal(h.client.last('setState')!.state, 'dormant')
})

test('opening a dashboard card announces it to the runtime so a sleeping session can relaunch', () => {
  const h = setup()
  put(h, makeTask({ id: 'sleeping', state: 'done', kind: 'session', alive: false }))

  h.client.fire({ type: 'focusTask', id: 'sleeping' })

  assert.deepEqual(h.calls.opened?.at(-1), ['sleeping'])
})

test('opening then closing a BLOCKED task acknowledges the episode without resolving it', () => {
  const h = setup()
  put(h, makeTask({ id: 'b1', state: 'needs-user', alive: true, question: { text: 'q' } }))
  h.client.fire({ type: 'focusTask', id: 'b1' })
  h.flush()
  h.client.fire({ type: 'collapsed' })
  assert.equal(h.client.last('setState')!.state, 'dormant')
  h.client.fire({ type: 'pocketOpen' })
  assert.ok(pocketOf(h)!.slots.some((sl) => sl.id === 'b1'), 'acknowledged is still reachable')
})

test('a blocked task CAN still be hidden, but only by asking for it', () => {
  // "even for blocked tasks there should be a way for users to hide it — even
  // from the next queue as well."
  const h = setup()
  put(h, makeTask({ id: 'b1', state: 'needs-user', alive: true, question: { text: 'q' } }))
  h.client.fire({ type: 'mute', id: 'b1' })
  assert.equal(h.client.last('setState')!.state, 'dormant')
  // The crank must skip it too. It can still land on the Agent's own card —
  // that one is always reachable — so the assertion is about the hidden task,
  // not about whether anything at all is on screen.
  h.client.fire({ type: 'next' })
  assert.notEqual(h.client.last('showTask')?.task.id, 'b1')
  assert.deepEqual(h.calls.focus?.at(-1), [null], 'nothing but the Agent is left to crank to')
})

// ── forwarded notifications ─────────────────────────────────────────────────

test('capture phase forwards with the target task name', () => {
  const h = setup()
  put(h, makeTask({ id: 't1', state: 'processing', name: 'RCA' }))
  h.controller.notifyCapturePhase('listening', 't1')
  const c = h.client.last('capturePhase')!
  assert.equal(c.phase, 'listening')
  assert.equal(c.target, 'RCA')
})

test('route offer lands in the cockpit payload; accept calls through', async () => {
  const h = setup()
  h.client.fire({ type: 'openDashboard' })
  await new Promise((r) => setTimeout(r, 10))
  h.controller.notifyRouteOffer({ newTaskId: 'n1', altTaskId: 'a1', altName: 'Pager' })
  assert.equal(h.client.last('setCockpit')!.data.routeOffer?.altName, 'Pager')
  h.client.fire({ type: 'offerAccept', newTaskId: 'n1' })
  assert.deepEqual(h.calls.acceptRouteOffer?.[0], ['n1'])
})

// ── tapping the notch ───────────────────────────────────────────────────────

test('tapping a WORKING task opens that task, not the whole cockpit', () => {
  // Reported 2026-07-25: "when you tap it, it just directly opens the cockpit".
  // A merely-processing task is never in the attention queue, so the old tap
  // handler found no front task and fell through to the wall — even though the
  // notch was, at that moment, showing exactly one task.
  const h = setup()
  put(h, makeTask({ id: 'w1', state: 'processing', alive: true }))
  h.client.fire({ type: 'tap' })
  assert.equal(h.client.last('setState')!.state, 'task')
  assert.equal(h.client.last('showTask')!.task.id, 'w1')
})

test('tapping with SEVERAL working tasks opens the wall — the notch shows a count, not a task', () => {
  const h = setup()
  put(h, makeTask({ id: 'w1', state: 'processing', alive: true }))
  put(h, makeTask({ id: 'w2', state: 'processing', alive: true }))
  h.client.fire({ type: 'tap' })
  assert.equal(h.client.last('setState')!.state, 'cockpit')
})

test('an attention task still wins over a working one', () => {
  const h = setup()
  put(h, makeTask({ id: 'w1', state: 'processing', alive: true }))
  put(h, makeTask({ id: 'b1', state: 'needs-user', alive: true, question: { text: 'q' } }))
  h.client.fire({ type: 'tap' })
  assert.equal(h.client.last('setState')!.state, 'task')
  assert.equal(h.client.last('showTask')!.task.id, 'b1')
})

// ── Codex tasks on every surface ────────────────────────────────────────────

test('a Codex task is never reported dead — its thread outlives every turn', () => {
  // `alive` is read everywhere as "can you still talk to this?". Reporting
  // false put a finished Codex chat behind "resume — continue with full
  // context" / "re-run fresh", offering to revive something never stopped.
  const h = setup()
  put(h, makeTask({ id: 'c1', state: 'done', kind: 'session', agent: 'codex-desktop', codexThreadId: 'th', alive: false }))
  h.client.fire({ type: 'focusTask', id: 'c1' })
  h.flush()
  const detail = h.client.last('stageDetail')!.task
  assert.equal(detail.alive, true)
  assert.equal(detail.backend, 'codex-desktop')
})

test('a pocket slot names its backend too — the surface you live in', () => {
  // The pocket showed nothing about which backend a task ran on: you had to
  // expand it to find out. It draws a mark now, which needs the same two facts
  // every other surface gets.
  const h = setup()
  put(h, makeTask({ id: 'x1', state: 'needs-user', kind: 'session', agent: 'codex',
    question: { text: 'ok?' } }))
  const pocket = h.client.last('pocket')!.data as { slots: Array<Record<string, unknown>> }
  const slot = pocket.slots.find((s) => s.id === 'x1')!
  assert.equal(slot.backend, 'codex')
  assert.equal(slot.terminal, false)
})

test('EVERY card names its backend — absent must not mean "the default one"', () => {
  // This asserted `undefined` for a Claude card, because `backend` was sent for
  // driver backends only. That is what put "Claude Code CLI" on Codex CLI
  // cards: the card arrived with no backend and the wall's label fell through
  // to its default. Now the surface draws a MARK from this field, so an absent
  // value would silently mark a Codex task as Claude.
  const h = setup()
  put(h, makeTask({ id: 'c1', state: 'done', kind: 'session', agent: 'codex-desktop', codexThreadId: 'th' }))
  put(h, makeTask({ id: 'x1', state: 'done', kind: 'session', agent: 'codex' }))
  put(h, makeTask({ id: 'k1', state: 'done', kind: 'session' }))
  h.client.fire({ type: 'openDashboard' })
  const cards = h.client.last('setCockpit')!.data.groups.flatMap((g) => g.cards)
  const card = (id: string) => cards.find((c) => c.id === id)!
  assert.equal(card('c1').backend, 'codex-desktop')
  assert.equal(card('x1').backend, 'codex')
  assert.equal(card('k1').backend, 'claude')
  // …and whether it owns a terminal, so the mark's glyph is a capability
  // rather than a list of backend names the view has to keep up with.
  assert.equal(card('c1').terminal, false)
  assert.equal(card('x1').terminal, false)
  assert.equal(card('k1').terminal, false)
})

test('Agent origin is provenance only and never suppresses provider capabilities', () => {
  const h = setup()
  put(h, makeTask({
    id: 'agent-codex', state: 'done', kind: 'session', agent: 'codex', alive: true,
    origin: 'unmute-agent', agentRunId: 'agent-run-1',
  }))
  h.client.fire({ type: 'openDashboard' })
  const cards = h.client.last('setCockpit')!.data.groups.flatMap((g) => g.cards)
  const card = cards.find((candidate) => candidate.id === 'agent-codex')!
  assert.equal(card.origin, 'unmute-agent')
  assert.equal(card.backend, 'codex')
  assert.equal(card.terminal, false)

  h.client.fire({ type: 'focusTask', id: 'agent-codex' })
  h.flush()
  const detail = h.client.last('stageDetail')!.task
  assert.equal(detail.terminal, false)
  assert.equal(detail.resumable, true)
  assert.equal(detail.owned, true)
  assert.equal(detail.alive, true)
})

test('the transcript reaches the surface as items, not one flattened blob', () => {
  const h = setup()
  put(h, makeTask({
    id: 'c1', state: 'done', kind: 'session', agent: 'codex-desktop', codexThreadId: 'th',
    conversation: [
      { role: 'user', text: 'open the video' },
      { role: 'tool', text: '', title: 'Search YouTube', code: 'await tab.goto(x)', output: 'found', durationMs: 99_100 },
      { role: 'assistant', text: 'Opened it.' },
    ],
  }))
  h.client.fire({ type: 'focusTask', id: 'c1' })
  h.flush()
  const conv = h.client.last('stageDetail')!.task.conversation!
  assert.deepEqual(conv.map((c) => c.role), ['user', 'tool', 'assistant'])
  assert.equal(conv[1].title, 'Search YouTube')
  assert.equal(conv[1].durationMs, 99_100)
})

test('replying to a Codex chat does NOT fling you onto an unrelated blocked task', () => {
  // The composer is always available, so a plain reply is not an answer to the
  // crank's question — advancing on it would move the user somewhere they never
  // asked to go.
  const h = setup()
  put(h, makeTask({ id: 'c1', state: 'done', kind: 'session', agent: 'codex-desktop', codexThreadId: 'th' }))
  put(h, makeTask({ id: 'b1', state: 'needs-user', alive: true, question: { text: 'q' } }))
  h.client.fire({ type: 'focusTask', id: 'c1' })
  h.flush()
  h.client.fire({ type: 'answerText', id: 'c1', text: 'also check the description' })
  h.flush()
  assert.deepEqual(h.calls.answer?.[0], ['c1', 'also check the description'])
  assert.equal(h.client.last('stageDetail')!.task.id, 'c1', 'still on the task you were talking to')
})

test('answering the BLOCKING question still advances the crank', () => {
  const h = setup()
  put(h, makeTask({ id: 'b1', state: 'needs-user', alive: true, question: { text: 'q' } }))
  put(h, makeTask({ id: 'b2', state: 'needs-user', alive: true, question: { text: 'q2' } }))
  h.client.fire({ type: 'tap' })
  h.client.fire({ type: 'answerText', id: 'b1', text: 'yes' })
  h.flush()
  assert.equal(h.client.last('showTask')!.task.id, 'b2', 'moved on to the next blocked task')
})

test('a REFUSED answer does not advance the crank — the task is still blocked', () => {
  // When a picker we cannot drive is open, `answer` sends nothing. Cranking on
  // would carry the user away from the question they still have to answer and
  // away from the card that explains where to answer it.
  const h = setup()
  h.refuseAnswers()
  put(h, makeTask({ id: 'b1', state: 'needs-user', alive: true, question: { text: 'q', kind: 'terminal_only' } }))
  put(h, makeTask({ id: 'b2', state: 'needs-user', alive: true, question: { text: 'q2' } }))
  h.client.fire({ type: 'tap' })
  h.client.fire({ type: 'answerText', id: 'b1', text: 'blue' })
  h.flush()
  assert.deepEqual(h.calls.answer?.[0], ['b1', 'blue'], 'it still tried')
  assert.equal(h.client.last('showTask')!.task.id, 'b1', 'and stayed on the blocked task')
})

test('a REFUSED chip click keeps the surface on the question too', () => {
  const h = setup()
  h.refuseAnswers()
  put(h, makeTask({ id: 'b1', state: 'needs-user', alive: true, question: { text: 'q', choices: ['Yes', 'No'] } }))
  put(h, makeTask({ id: 'b2', state: 'needs-user', alive: true, question: { text: 'q2' } }))
  h.client.fire({ type: 'tap' })
  h.client.fire({ type: 'chooseOption', id: 'b1', index: 1 })
  h.flush()
  assert.deepEqual(h.calls.answer?.[0], ['b1', 'No'])
  assert.equal(h.client.last('showTask')!.task.id, 'b1')
})

test('an errored task eventually stops occupying the notch', () => {
  // Nothing ever aged out a failure: only `ready` had a cut-off. One error and
  // the notch was held indefinitely (observed for hours in the field). It stays
  // a card on the wall — it just stops being in your face.
  const h = setup()
  const old = Date.now() - 4 * 60 * 60 * 1000
  put(h, makeTask({ id: 'e1', state: 'failed', updatedAt: old, error: { reason: 'boom' } }))
  h.flush()
  assert.equal(h.client.last('setState')!.state, 'dormant')
})

test('a FRESH error still demands attention', () => {
  const h = setup()
  put(h, makeTask({ id: 'e1', state: 'failed', error: { reason: 'boom' } }))
  h.flush()
  assert.equal(h.client.last('setState')!.state, 'attention')
})

test('a delivery error reaches the surface without settling the task', () => {
  const h = setup()
  put(h, makeTask({
    id: 'c1', state: 'done', kind: 'session', agent: 'codex-desktop', codexThreadId: 'th',
    deliveryError: 'Could not find that chat in Codex',
  }))
  h.client.fire({ type: 'focusTask', id: 'c1' })
  h.flush()
  const d = h.client.last('stageDetail')!.task
  assert.equal(d.deliveryError, 'Could not find that chat in Codex')
  assert.equal(d.status, 'done', 'the task itself is untouched')
})

test('the native stage receives relaunch progress instead of inferring it from liveness', () => {
  const h = setup()
  put(h, makeTask({ id: 'waking', state: 'done', kind: 'session', alive: false,
    resuming: true, resumeError: 'previous attempt failed' }))

  h.client.fire({ type: 'focusTask', id: 'waking' })

  const detail = h.client.last('stageDetail')!.task
  assert.equal(detail.resuming, true)
  assert.equal(detail.resumeError, 'previous attempt failed')
})

test('the conversation initially sends only the latest ten messages', () => {
  // The parse layer used to cut to 6 items and the windows here were all
  // downstream of that, so widening them did nothing. A 40-item thread must
  // arrive whole — without the user's own messages there is no alternation and
  // the panel does not read as a chat at all.
  const conversation = Array.from({ length: 40 }, (_, i) => ({
    role: i % 2 === 0 ? 'user' as const : 'assistant' as const, text: `m${i}`,
  }))
  const h = setup()
  put(h, makeTask({ id: 'c1', state: 'done', kind: 'session', agent: 'codex-desktop', codexThreadId: 'th', conversation }))
  h.client.fire({ type: 'focusTask', id: 'c1' })
  h.flush()
  const conv = h.client.last('stageDetail')!.task.conversation!
  assert.equal(conv.length, 10)
  assert.equal(conv[0].text, 'm30')
})

test('an unchanged transcript is not re-sent on every poll', () => {
  // A full transcript is ~32KB and reconcile fires on each poll; re-sending an
  // identical payload put that on the wire over and over for a thread that had
  // not moved.
  const h = setup()
  put(h, makeTask({
    id: 'c1', state: 'done', kind: 'session', agent: 'codex-desktop', codexThreadId: 'th',
    conversation: [{ role: 'assistant', text: 'done' }],
  }))
  h.client.fire({ type: 'focusTask', id: 'c1' })
  h.flush()
  const sent = () => h.client.ofType('stageDetail').length
  const first = sent()
  h.flush(); h.flush()
  assert.equal(sent(), first, 'nothing changed → nothing sent')

  put(h, makeTask({
    id: 'c1', state: 'done', kind: 'session', agent: 'codex-desktop', codexThreadId: 'th',
    conversation: [{ role: 'assistant', text: 'done' }, { role: 'user', text: 'and now this' }],
  }))
  h.flush()
  assert.ok(sent() > first, 'a real change still goes out')
})

test('handing off to Codex collapses the notch instead of sitting on top of it', () => {
  // "open in Codex" used to call dismissOverlay(), which is the RETIRED overlay
  // window — a different surface. The notch was never told anything, so it
  // stayed pinned above the Codex window the user had just been sent to.
  const h = setup()
  put(h, makeTask({ id: 'c1', state: 'done', kind: 'session', agent: 'codex-desktop', codexThreadId: 'th' }))
  h.client.fire({ type: 'openDashboard' })
  assert.equal(h.client.last('setState')!.state, 'cockpit')
  h.controller.collapse()
  assert.ok(h.client.last('collapse'), 'the surface is told to step down')
})

// ── the wall: order and pile-up ─────────────────────────────────────────────

test('cards inside a group sort by LAST ACTIVITY, the same key as the groups', () => {
  // The mismatch was the whole problem: groups ranked on updatedAt, cards on
  // createdAt. A task touched five minutes ago but created weeks ago promoted
  // its group to the top and then sat at the bottom of it.
  const h = setup()
  const hour = 60 * 60 * 1000
  put(h, makeTask({ id: 'old-made-fresh-touch', state: 'processing', group: 'g',
    createdAt: Date.now() - 500 * hour, updatedAt: Date.now() - 1 }))
  put(h, makeTask({ id: 'new-made-stale-touch', state: 'processing', group: 'g',
    createdAt: Date.now() - 1, updatedAt: Date.now() - 5 * hour }))
  h.client.fire({ type: 'openDashboard' })
  const cards = h.client.last('setCockpit')!.data.groups[0].cards
  assert.equal(cards[0].id, 'old-made-fresh-touch', 'most recently touched first')
})

test('settled cards older than 48h fold away, and the group SAYS so', () => {
  // Sessions never faded at all, so a wall accumulated every session ever
  // created — DONE cards from weeks ago beside this morning's work.
  const h = setup()
  const day = 24 * 60 * 60 * 1000
  put(h, makeTask({ id: 'fresh', state: 'done', kind: 'session', group: 'g', updatedAt: Date.now() }))
  put(h, makeTask({ id: 'ancient', state: 'done', kind: 'session', group: 'g', updatedAt: Date.now() - 5 * day }))
  h.client.fire({ type: 'openDashboard' })
  const g = h.client.last('setCockpit')!.data.groups[0]
  assert.deepEqual(g.cards.map((c) => c.id), ['fresh'])
  assert.equal(g.hidden, 1, 'a group silently missing cards reads as one that lost them')
})

test('an UNSETTLED task is never folded away, however old', () => {
  // Hiding a blocked task behind a disclosure means work silently waiting on
  // you that you cannot see — the exact failure the cockpit exists to prevent.
  const h = setup()
  const day = 24 * 60 * 60 * 1000
  put(h, makeTask({ id: 'blocked', state: 'needs-user', kind: 'session', group: 'g',
    alive: true, question: { text: 'q' }, updatedAt: Date.now() - 30 * day }))
  put(h, makeTask({ id: 'busy', state: 'processing', kind: 'session', group: 'g', updatedAt: Date.now() - 30 * day }))
  h.client.fire({ type: 'openDashboard' })
  const g = h.client.last('setCockpit')!.data.groups[0]
  assert.deepEqual(g.cards.map((c) => c.id).sort(), ['blocked', 'busy'])
  assert.equal(g.hidden, 0)
})

test('show all reveals the folded cards, and reopening the cockpit forgets it', () => {
  const h = setup()
  const day = 24 * 60 * 60 * 1000
  put(h, makeTask({ id: 'ancient', state: 'done', kind: 'session', group: 'g', updatedAt: Date.now() - 5 * day }))
  h.client.fire({ type: 'openDashboard' })
  assert.equal(h.client.last('setCockpit')!.data.groups[0].cards.length, 0)

  h.client.fire({ type: 'showAll', on: true })
  assert.equal(h.client.last('setCockpit')!.data.groups[0].cards.length, 1)

  // Each visit starts on the live view — the wall is about now.
  h.client.fire({ type: 'collapsed' })
  h.client.fire({ type: 'openDashboard' })
  assert.equal(h.client.last('setCockpit')!.data.groups[0].cards.length, 0)
})

test('a group whose cards ALL fold still reports itself, and is never lost', () => {
  // THE FAILURE FROM THE FIELD. Folding removed every card in a group; the wall
  // then skipped the group entirely, taking its "show all" with it, so those
  // tasks were unreachable by any gesture. A folded group must still say it is
  // there and how much it is holding.
  const h = setup()
  const day = 24 * 60 * 60 * 1000
  put(h, makeTask({ id: 'a', state: 'done', kind: 'session', group: 'Unmute', updatedAt: Date.now() - 10 * day }))
  put(h, makeTask({ id: 'b', state: 'done', kind: 'session', group: 'Unmute', updatedAt: Date.now() - 20 * day }))
  h.client.fire({ type: 'openDashboard' })
  const data = h.client.last('setCockpit')!.data
  const g = data.groups.find((x) => x.name === 'Unmute')!
  assert.equal(g.cards.length, 0)
  assert.equal(g.hidden, 2, 'the group is still in the payload, holding its count')
  assert.equal(data.hiddenTotal, 2, 'and the wall carries a total of its own')
})

test('the wall-level total exists so the way back never depends on one group', () => {
  const h = setup()
  const day = 24 * 60 * 60 * 1000
  put(h, makeTask({ id: 'a', state: 'done', kind: 'session', group: 'One', updatedAt: Date.now() - 9 * day }))
  put(h, makeTask({ id: 'b', state: 'done', kind: 'session', group: 'Two', updatedAt: Date.now() - 9 * day }))
  h.client.fire({ type: 'openDashboard' })
  assert.equal(h.client.last('setCockpit')!.data.hiddenTotal, 2)
  h.client.fire({ type: 'showAll', on: true })
  const after = h.client.last('setCockpit')!.data
  assert.equal(after.hiddenTotal, 0)
  assert.equal(after.showingAll, true)
  assert.equal(after.groups.flatMap((g) => g.cards).length, 2, 'everything comes back')
})

test('a stale READY task folds like any other finished step', () => {
  // `ready` was exempt because classify() counts it as attention — so a group
  // of two-week-old ready cards never folded while its neighbours vanished
  // completely. The wall showed 15-day-old work and hid last week's.
  const h = setup()
  const day = 24 * 60 * 60 * 1000
  put(h, makeTask({ id: 'stale-ready', state: 'done', kind: 'session', group: 'g', updatedAt: Date.now() - 15 * day }))
  h.client.fire({ type: 'openDashboard' })
  const g = h.client.last('setCockpit')!.data.groups[0]
  assert.equal(g.cards.length, 0)
  assert.equal(g.hidden, 1)
})

test('needs-user, stuck, failed and processing never fold, at any age', () => {
  // SESSIONS, deliberately: an errored ONE-OFF is already removed earlier by
  // visibleOnWall's present-tense fade (60m), which is a different mechanism
  // from folding and not what this pins.
  const h = setup()
  const day = 24 * 60 * 60 * 1000
  const old = Date.now() - 60 * day
  const base = { kind: 'session' as const, group: 'g', updatedAt: old }
  put(h, makeTask({ ...base, id: 'q', state: 'needs-user', alive: true, question: { text: 'q' } }))
  put(h, makeTask({ ...base, id: 's', state: 'stuck' }))
  put(h, makeTask({ ...base, id: 'f', state: 'failed', error: { reason: 'x' } }))
  put(h, makeTask({ ...base, id: 'p', state: 'processing' }))
  h.client.fire({ type: 'openDashboard' })
  const g = h.client.last('setCockpit')!.data.groups[0]
  assert.deepEqual(g.cards.map((c) => c.id).sort(), ['f', 'p', 'q', 's'])
  assert.equal(g.hidden, 0)
})

test('show all expands ONLY the group whose button was pressed', () => {
  // A control in a group header that expanded the whole wall — and then left no
  // way to collapse — was the complaint. One group at a time.
  const h = setup()
  const day = 24 * 60 * 60 * 1000
  const old = Date.now() - 9 * day
  put(h, makeTask({ id: 'a', state: 'done', kind: 'session', group: 'One', updatedAt: old }))
  put(h, makeTask({ id: 'b', state: 'done', kind: 'session', group: 'Two', updatedAt: old }))
  h.client.fire({ type: 'openDashboard' })

  h.client.fire({ type: 'showAll', group: 'One', on: true })
  const g = (name: string) => h.client.last('setCockpit')!.data.groups.find((x) => x.name === name)!
  assert.equal(g('One').cards.length, 1)
  assert.equal(g('Two').cards.length, 0, 'the other group is untouched')

  // ...and it collapses again from the same place.
  h.client.fire({ type: 'showAll', group: 'One', on: false })
  assert.equal(g('One').cards.length, 0)
  assert.equal(g('One').hidden, 1)
})

test('the wall-level control still expands and collapses everything', () => {
  const h = setup()
  const old = Date.now() - 9 * 24 * 60 * 60 * 1000
  put(h, makeTask({ id: 'a', state: 'done', kind: 'session', group: 'One', updatedAt: old }))
  put(h, makeTask({ id: 'b', state: 'done', kind: 'session', group: 'Two', updatedAt: old }))
  h.client.fire({ type: 'openDashboard' })
  h.client.fire({ type: 'showAll', on: true })
  assert.equal(h.client.last('setCockpit')!.data.groups.flatMap((x) => x.cards).length, 2)
  assert.equal(h.client.last('setCockpit')!.data.showingAll, true)
  h.client.fire({ type: 'showAll', on: false })
  assert.equal(h.client.last('setCockpit')!.data.groups.flatMap((x) => x.cards).length, 0)
})

test('the UNGROUPED bucket ranks by recency like any other group', () => {
  // It used to be appended last whatever it held, and it renders without a
  // heading — so the newest task on the wall sat at the bottom under someone
  // else's group title, and a correctly-sorted wall looked scrambled.
  const h = setup()
  const hour = 60 * 60 * 1000
  put(h, makeTask({ id: 'grouped', state: 'done', kind: 'session', group: 'Unmute', updatedAt: Date.now() - 40 * hour }))
  put(h, makeTask({ id: 'loose', state: 'done', kind: 'session', updatedAt: Date.now() - 1 * hour }))
  h.client.fire({ type: 'openDashboard' })
  const groups = h.client.last('setCockpit')!.data.groups
  assert.equal(groups[0].name, '', 'the ungrouped bucket holds the newest task, so it leads')
  assert.equal(groups[1].name, 'Unmute')
})

test('reopening a task RE-SENDS its detail, even when nothing changed', () => {
  // THE SPINNER. The surface discards its staged task on leaving cockpit
  // (AppController drops stageTask whenever state != cockpit), but the dedupe
  // cache still said "already sent" — so on reopen nothing arrived and the
  // panel drew a spinner until some unrelated change altered the payload.
  // Measured at 25 SECONDS in the field log.
  const h = setup()
  put(h, makeTask({
    id: 'c1', state: 'done', kind: 'session', agent: 'codex-desktop', codexThreadId: 'th',
    conversation: [{ role: 'assistant', text: 'done' }],
  }))
  h.client.fire({ type: 'focusTask', id: 'c1' })
  h.flush()
  const first = h.client.ofType('stageDetail').length
  assert.ok(first > 0)

  // Leave, come back — with the task completely unchanged.
  h.client.fire({ type: 'collapsed' })
  h.flush()
  h.client.fire({ type: 'focusTask', id: 'c1' })
  h.flush()
  assert.ok(h.client.ofType('stageDetail').length > first, 'the surface needs it again')
})

test('a programmatic collapse also invalidates what the surface holds', () => {
  const h = setup()
  put(h, makeTask({ id: 'c1', state: 'done', kind: 'session', agent: 'codex-desktop', codexThreadId: 'th' }))
  h.client.fire({ type: 'focusTask', id: 'c1' })
  h.flush()
  const before = h.client.ofType('stageDetail').length
  h.controller.collapse()            // e.g. handing off to Codex
  h.client.fire({ type: 'focusTask', id: 'c1' })
  h.flush()
  assert.ok(h.client.ofType('stageDetail').length > before)
})

test('the dedupe still holds while the surface keeps showing the same task', () => {
  // The optimisation itself is right — 32KB per poll for a thread that has not
  // moved is real. It just must not outlive the receiver's copy.
  const h = setup()
  put(h, makeTask({
    id: 'c1', state: 'done', kind: 'session', agent: 'codex-desktop', codexThreadId: 'th',
    conversation: [{ role: 'assistant', text: 'done' }],
  }))
  h.client.fire({ type: 'focusTask', id: 'c1' })
  h.flush()
  const n = h.client.ofType('stageDetail').length
  h.flush(); h.flush()
  assert.equal(h.client.ofType('stageDetail').length, n)
})

test('a Claude desktop card carries its conversation, exactly like a Codex one', () => {
  // This is why Claude Desktop cards rendered EMPTY: `external` was
  // `agent === 'codex-desktop'`, so the branch that sends the conversation
  // never ran and the card had nothing to draw. The registry decides now.
  const h = setup()
  put(h, makeTask({
    id: 'cd1', state: 'done', kind: 'session', agent: 'claude-code-desktop',
    conversation: [
      { role: 'user', text: 'which season?' },
      { role: 'tool', text: '', title: 'AskUserQuestion', code: '{}', output: 'Summer' },
      { role: 'assistant', text: 'You prefer Summer.' },
    ],
  }))
  h.client.fire({ type: 'focusTask', id: 'cd1' })
  h.flush()
  const d = h.client.last('stageDetail')!.task
  assert.equal(d.backend, 'claude-code-desktop', 'the backend must be named, not left undefined')
  assert.deepEqual(d.conversation!.map((c) => c.role), ['user', 'tool', 'assistant'])
})

test('a driven backend is never reported dead — its chat lives in the other app', () => {
  const h = setup()
  put(h, makeTask({ id: 'cd2', state: 'done', kind: 'session', agent: 'claude-code-desktop', alive: false }))
  h.client.fire({ type: 'focusTask', id: 'cd2' })
  h.flush()
  assert.equal(h.client.last('stageDetail')!.task.alive, true)
})

test('EVERY task names its backend in the detail, keeps its real liveness, and carries a conversation', () => {
  // CHANGED 2026-08-11. This asserted `backend === undefined` for a PTY task,
  // because the detail sent it for driver backends only. The expansion draws a
  // provider MARK from that field now, so absent meant "Claude" — and a Codex
  // CLI task showed Codex in the pocket and Claude the moment you opened it.
  const h = setup()
  put(h, makeTask({ id: 'p1', state: 'done', kind: 'session', agent: 'claude', alive: false }))
  put(h, makeTask({ id: 'x1', state: 'done', kind: 'session', agent: 'codex', alive: false }))
  h.client.fire({ type: 'focusTask', id: 'x1' })
  h.flush()
  assert.equal(h.client.last('stageDetail')!.task.backend, 'codex')
  h.client.fire({ type: 'focusTask', id: 'p1' })
  h.flush()
  const d = h.client.last('stageDetail')!.task
  assert.equal(d.backend, 'claude', 'absent must never stand in for the default backend')
  assert.equal(d.alive, false)
  // CHANGED 2026-08-06. `conversation` used to be gated on `external`, which
  // made the stage an either/or: a Claude task showed a terminal and no
  // messages at all. It now ships for every backend — empty here because this
  // task has no turns yet — so the stage can render the latest exchange ABOVE
  // the terminal. `terminal` below still says whether there is a PTY to draw.
  assert.deepEqual(d.conversation, [], 'a PTY task carries a (here empty) conversation')
  assert.equal(d.terminal, false, 'conversation is the only task interaction surface')
})

test('a PTY task with turns sends them, so the stage can show the exchange', () => {
  const h = setup()
  put(h, makeTask({
    id: 'p2', state: 'done', kind: 'session', agent: 'claude', alive: true,
    conversation: [
      { role: 'user', text: 'summarize the pricing thread' },
      { role: 'assistant', text: 'Three tiers, and the middle one is new.' },
    ],
  }))
  h.client.fire({ type: 'focusTask', id: 'p2' })
  h.flush()
  const d = h.client.last('stageDetail')!.task
  assert.equal(d.conversation?.length, 2)
  assert.equal(d.conversation?.[1].text, 'Three tiers, and the middle one is new.')
  assert.equal(d.terminal, false)
})

// ── the scratchpad ──────────────────────────────────────────────────────────
//
// Pure relay: each event must reach the SAME internal the scratchpad:* IPC
// handler calls, with nothing invented in between and no state kept here.

test('arm relays the boolean, both ways', () => {
  const h = setup()
  h.client.fire({ type: 'scratchpadArm', on: true })
  h.client.fire({ type: 'scratchpadArm', on: false })
  assert.deepEqual(h.calls.scratchpadArm, [[true], [false]])
})

test('a malformed arm is read as disarm, never as arm', () => {
  // Arming HOLDS work; a garbled line must not be what starts holding it.
  const h = setup()
  h.client.fire({ type: 'scratchpadArm' } as unknown as NotchEvent)
  assert.deepEqual(h.calls.scratchpadArm, [[false]])
})

test('remove carries the entry id, and an idless remove is dropped', () => {
  const h = setup()
  h.client.fire({ type: 'scratchpadRemove', id: 'e7' })
  h.client.fire({ type: 'scratchpadRemove' } as unknown as NotchEvent)
  assert.deepEqual(h.calls.scratchpadRemove, [['e7']])
})

test('deliver passes the three real destinations through', () => {
  const h = setup()
  h.client.fire({ type: 'scratchpadDeliver', dest: 'cursor' })
  h.client.fire({ type: 'scratchpadDeliver', dest: 'newTask' })
  h.client.fire({ type: 'scratchpadDeliver', dest: 'openTask' })
  assert.deepEqual(h.calls.scratchpadDeliver, [['cursor'], ['newTask'], ['openTask']])
})

test('an unrecognised destination is DROPPED, not defaulted', () => {
  // Defaulting would let a malformed line send held work somewhere the user
  // never chose — the one failure this whole feature exists to prevent.
  const h = setup()
  h.client.fire({ type: 'scratchpadDeliver', dest: 'somewhere-else' } as unknown as NotchEvent)
  assert.equal(h.calls.scratchpadDeliver, undefined)
})

test('discard is its own verb — it never reaches deliver', () => {
  const h = setup()
  h.client.fire({ type: 'scratchpadDiscard' })
  assert.equal(h.calls.scratchpadDiscard?.length, 1)
  assert.equal(h.calls.scratchpadDeliver, undefined)
})

test('notifyScratchpad pushes the payload verbatim', () => {
  const h = setup()
  h.controller.notifyScratchpad({
    enabled: true,
    armed: true,
    delivering: false,
    pad: { id: 'p1', origin: 'cursor', entries: [{ id: 'e1', type: 'segment', text: 'hi' }] },
    destinations: { cursor: true, newTask: true, openTask: null },
  })
  const sent = h.client.last('scratchpad')!
  assert.equal(sent.data.armed, true)
  assert.equal(sent.data.pad?.entries[0].id, 'e1')
  assert.equal(sent.data.destinations.openTask, null)
})


// ── AUTO-EXPAND (ships ON; setup() turns it off — see the harness) ───────────

test('auto-expand opens the task surface instead of only tinting the bar', () => {
  const h = setup()
  h.controller.setAutoExpand(true)
  put(h, makeTask({ id: 't1', state: 'needs-user', name: 'RCA' }))
  assert.equal(h.client.last('setState')!.state, 'task')
})

test('auto-expand NEVER interrupts something already open', () => {
  const h = setup()
  h.controller.setAutoExpand(true)
  // The user is in the Orchestrator. A second task starting to need them must
  // not yank the surface away — that is worse than never expanding at all.
  ;(h.controller as unknown as { engaged: string }).engaged = 'cockpit'
  put(h, makeTask({ id: 't2', state: 'needs-user', name: 'second' }))
  assert.equal(h.client.last('setState')!.state, 'cockpit')
})

test('a newly demanding task cannot replace the open pocket voice address', () => {
  const h = setup()
  h.controller.setAutoExpand(true)
  put(h, makeTask({ id: 'a', state: 'processing', kind: 'session', name: 'Reply here' }))
  h.client.fire({ type: 'pocketOpen' })
  h.flush()
  assert.deepEqual(h.calls.focus?.at(-1), ['a'])

  put(h, makeTask({ id: 'b', state: 'needs-user', kind: 'session', name: 'New attention', question: { text: 'Which option?' } }))

  assert.deepEqual(h.calls.focus?.at(-1), ['a'], 'the explicit pocket address stays pinned')
  assert.equal(h.client.last('pocket')!.data.mode, 'open')
})

test('with auto-expand off the bar still only reaches attention', () => {
  const h = setup()
  h.controller.setAutoExpand(false)
  put(h, makeTask({ id: 't3', state: 'needs-user', name: 'quiet' }))
  assert.equal(h.client.last('setState')!.state, 'attention')
})

test('a running task says what it is doing, not "working"', () => {
  // The whole reason the activity layer exists: "Working" is true of every busy
  // task and useful about none of them.
  assert.equal(
    headlineFor({ id: 'x', intent: 'i', state: 'processing', codexActivity: { kind: 'running', label: 'npm test' } }),
    'running npm test')
  // A RESULT STILL WINS. Once there is something to show, the activity is the
  // worse sentence — the same ordering rule that put result above step.
  assert.equal(
    headlineFor({ id: 'x', intent: 'i', state: 'done', result: { summary: 'all green' },
      codexActivity: { kind: 'running', label: 'npm test' } }),
    'all green')
  // And a stale activity on a finished task can never speak, even with no
  // result to displace it — one leftover field must not make a done card claim
  // it is still running a command.
  assert.equal(
    headlineFor({ id: 'x', intent: 'i', state: 'done', codexActivity: { kind: 'running', label: 'npm test' } }),
    undefined)
})

test('the headline never carries the card body — one field, two slots', () => {
  // `activity` was `question.text` outright, and the surface draws it as a
  // headline. The moment the card's text became more than a sentence, the whole
  // ask printed twice: once above the user's own message, once in the card.
  const ask = { text: '1. Colour?\n2. Languages?', kind: 'terminal_only' }
  assert.equal(headlineFor({ id: 'x', intent: 'i', state: 'needs-user', question: ask, step: '2 questions waiting' }),
    '2 questions waiting', 'a terminal-only card owns the ask; the headline owns the state')
  // No step is still not an excuse to print the card body.
  assert.equal(headlineFor({ id: 'x', intent: 'i', state: 'needs-user', question: ask }),
    'waiting for you in the terminal')
  // A drivable ask keeps the question in the headline — that card is one line
  // plus chips, so there is nothing to duplicate.
  assert.equal(headlineFor({ id: 'x', intent: 'i', state: 'needs-user', step: 'waiting for you',
    question: { text: 'Tabs or spaces?', kind: 'choice', choices: ['Tabs', 'Spaces'] } }), 'Tabs or spaces?')
  // And with no question at all, the old chain is untouched.
  assert.equal(headlineFor({ id: 'x', intent: 'i', state: 'processing', step: 'reading the router' }), 'reading the router')
  assert.equal(headlineFor({ id: 'x', intent: 'i', state: 'failed', error: { reason: 'boom' } }), 'boom')
})

test('Open dashboard lands on the WALL, not the task you just left', () => {
  // The cockpit draws the focused task's stage whenever focusedId is set, so
  // arriving from an auto-expanded task delivered that single task — the one
  // thing the button's label promises it is not. Reaching the actual dashboard
  // meant closing the stage first.
  const h = setup()
  put(h, makeTask({ id: 'a', state: 'needs-user', alive: true, question: { text: 'q' } }))
  put(h, makeTask({ id: 'b', state: 'done', kind: 'session', alive: true }))
  h.client.fire({ type: 'tap' })                       // auto-expanded onto 'a'
  assert.equal(h.client.last('showTask')!.task.id, 'a')

  h.client.fire({ type: 'openDashboard' })
  h.flush()
  assert.equal(h.client.last('setState')!.state, 'cockpit')
  assert.deepEqual(h.calls.focus?.at(-1), [null], 'focus is released on arrival')
  const after = h.client.ofType('stageDetail').length
  h.flush()
  assert.equal(h.client.ofType('stageDetail').length, after, 'and no stage is pushed for it')
})

// ── the pocket ──────────────────────────────────────────────────────────────

function pocketOf(h: Harness) { return h.client.last('pocket')?.data }
/**
 * THE TASK HALF OF THE POCKET.
 *
 * The pocket is a container of element KINDS now: the task queue, plus the
 * Agent, which is always present and is never in that queue. A test about the
 * task ORDER is asking about the task half, so it says so — rather than
 * counting an element it is not talking about and calling the difference a
 * failure. The Agent's own position has its own tests.
 */
function taskSlots(h: Harness) {
  return (pocketOf(h)?.slots ?? []).filter((sl) => sl.kind !== 'agent')
}

test('leaving pockets the expanded task — not muted, not dequeued', () => {
  // Changing window IS the signal: you went to look at something in order to
  // answer. Closing was the only escape before, and closing says "done".
  const h = setup()
  put(h, makeTask({ id: 'a', state: 'needs-user', alive: true, question: { text: 'which one?' } }))
  h.client.fire({ type: 'tap' })
  assert.equal(h.client.last('setState')!.state, 'task')

  h.client.fire({ type: 'userLeft', reason: 'blur' })
  h.flush()
  const p = pocketOf(h)!
  assert.equal(p.mode, 'closed', 'it goes to the notch, not to a floating card')
  // Tasks and nothing else: "let the router decide" is not a member of a list
  // of tasks, it is what happens when the list is not on screen.
  assert.equal(taskSlots(h).length, 1)
  assert.equal(taskSlots(h)[0].id, 'a')
  // Still your move: in the crank, unmuted, and still announced.
  assert.equal(h.client.last('setState')!.attention, 1, 'still in the queue')
  assert.deepEqual(h.calls.focus?.at(-1), [null], 'and no longer the voice address')
})

test('coming straight back re-opens it; coming back later does not', () => {
  const h = setup()
  put(h, makeTask({ id: 'a', state: 'needs-user', alive: true, question: { text: 'q' } }))
  h.client.fire({ type: 'tap' })
  h.client.fire({ type: 'userLeft', reason: 'blur' })
  h.flush()
  h.client.fire({ type: 'userReturned' })
  h.flush()
  assert.equal(h.client.last('setState')!.state, 'task', 'a ⌘-Tab and back does not cost you the panel')
  assert.deepEqual(h.calls.focus?.at(-1), ['a'])

  // …and outside the window it stays put.
  const h2 = setup()
  put(h2, makeTask({ id: 'b', state: 'needs-user', alive: true, question: { text: 'q' } }))
  h2.client.fire({ type: 'tap' })
  h2.client.fire({ type: 'userLeft', reason: 'blur' })
  h2.flush()
  ;(h2.controller as unknown as { returnGraceUntil: number }).returnGraceUntil = Date.now() - 1
  h2.client.fire({ type: 'userReturned' })
  h2.flush()
  assert.notEqual(h2.client.last('setState')!.state, 'task')
})

test('tapping it open IS the aim — the forefront becomes the address', () => {
  const h = setup()
  put(h, makeTask({ id: 'a', state: 'needs-user', alive: true, question: { text: 'q' } }))
  h.client.fire({ type: 'tap' })
  h.client.fire({ type: 'userLeft', reason: 'blur' })
  h.flush()
  h.client.fire({ type: 'pocketOpen' })
  h.flush()
  const p = pocketOf(h)!
  assert.equal(p.mode, 'open')
  assert.equal(p.slots[p.at].id, 'a', 'opening lands on the newest')
  assert.deepEqual(h.calls.focus?.at(-1), ['a'], 'and focus IS the voice address')
})

test('a dead pocketed task cannot stay as an address', () => {
  const h = setup()
  put(h, makeTask({ id: 'a', state: 'needs-user', alive: true, question: { text: 'q' } }))
  h.client.fire({ type: 'tap' })
  h.client.fire({ type: 'userLeft', reason: 'blur' })
  h.flush()
  assert.equal(taskSlots(h).length, 1)
  h.tasks.delete('a')
  h.events.emit('removed', { id: 'a' })
  h.flush()
  assert.equal(taskSlots(h).length, 0, 'the carousel drops it')
})

test('closing a blocked task pockets and acknowledges it; closing a READY one also quiets it', () => {
  const h = setup()
  put(h, makeTask({ id: 'a', state: 'needs-user', alive: true, question: { text: 'q' } }))
  h.client.fire({ type: 'tap' })
  h.client.fire({ type: 'closeStage' })
  h.flush()
  assert.equal(taskSlots(h).length, 1, 'blocked → pocketed')
  assert.equal(h.client.last('setState')!.attention, 0, 'the unchanged attention episode is acknowledged')

  const h2 = setup()
  put(h2, makeTask({ id: 'r', state: 'done', kind: 'session', alive: true }))
  h2.client.fire({ type: 'tap' })
  h2.client.fire({ type: 'closeStage' })
  h2.flush()
  assert.equal(h2.client.last('setState')!.attention, 0, 'seen-on-close still applies to ready')
})

test('the pocket is a GLANCE — you can always get the full task back', () => {
  // Without this it was a one-way door: set something aside and the only route
  // back was the dashboard, which is the trip the pocket exists to save.
  const h = setup()
  put(h, makeTask({ id: 'a', state: 'needs-user', alive: true, question: { text: 'q' } }))
  h.client.fire({ type: 'tap' })
  h.client.fire({ type: 'userLeft', reason: 'blur' })
  h.flush()
  h.client.fire({ type: 'pocketOpen' })
  h.flush()

  h.client.fire({ type: 'pocketExpand' })
  h.flush()
  assert.equal(h.client.last('setState')!.state, 'task', 'back to the full panel')
  assert.deepEqual(h.calls.focus?.at(-1), ['a'])
  assert.equal(pocketOf(h)!.mode, 'closed', 'it is open in front of you, not set aside')
  // EXPANDING NO LONGER EMPTIES ANYTHING. The pocket used to be a hand-managed
  // list you were removed from on the way out; it is a window onto the crank
  // now, and the crank always holds everything you can still reach. What
  // changes when you open something is the MODE, not the membership.
  assert.ok(pocketOf(h)!.slots.some((sl) => sl.id === 'a'))
})

test('pocket expansion presents the task before closing the pocket', () => {
  const h = setup()
  put(h, makeTask({ id: 'a', state: 'needs-user', alive: true, question: { text: 'q' } }))
  h.client.fire({ type: 'pocketOpen' })
  h.client.sent = []

  h.client.fire({ type: 'pocketExpand' })

  const taskAt = h.client.sent.findIndex((command) => command.type === 'setState' && command.state === 'task')
  const closedAt = h.client.sent.findIndex((command) => command.type === 'pocket' && command.data.mode === 'closed')
  assert.ok(taskAt >= 0, 'the task presentation is emitted')
  assert.ok(closedAt < 0 || taskAt < closedAt, 'the native surface never receives a closed-bar target first')
})


test('THE RULE: open is aimed, closed is the router', () => {
  // One concept, two sizes. A task expanded and the pocket open are the same
  // thing — something is in front of you — and the aim follows what you can see.
  const h = setup()
  put(h, makeTask({ id: 'a', state: 'needs-user', alive: true, question: { text: 'q' } }))
  h.client.fire({ type: 'tap' })
  assert.deepEqual(h.calls.focus?.at(-1), ['a'], 'expanded → that task')

  h.client.fire({ type: 'userLeft', reason: 'blur' })
  h.flush()
  assert.equal(pocketOf(h)!.mode, 'closed')
  assert.deepEqual(h.calls.focus?.at(-1), [null], 'closed → the router, even with a full pocket')

  h.client.fire({ type: 'pocketOpen' })
  h.flush()
  assert.equal(pocketOf(h)!.mode, 'open')
  assert.deepEqual(h.calls.focus?.at(-1), ['a'], 'open → the task on the card')

  h.client.fire({ type: 'pocketRelease' })
  h.flush()
  assert.deepEqual(h.calls.focus?.at(-1), [null], 'closing IS the aim control')
})

test('the pocket NEVER opens itself — no controller path can do it', () => {
  // This is what makes the rule true rather than a slogan. The card used to
  // bloom the moment the mic went hot, which under "open is aimed" would aim
  // every single utterance at a pocketed task.
  const h = setup()
  put(h, makeTask({ id: 'a', state: 'needs-user', alive: true, question: { text: 'q' } }))
  put(h, makeTask({ id: 'b', state: 'needs-user', alive: true, question: { text: 'q2' } }))
  h.client.fire({ type: 'tap' })
  h.client.fire({ type: 'userLeft', reason: 'blur' })
  h.flush()
  assert.equal(pocketOf(h)!.mode, 'closed')

  // Everything that is NOT the user opening it must leave it shut.
  h.events.emit('updated', h.tasks.get('b')!); h.flush()
  h.client.fire({ type: 'pocketMove', delta: 1 })
  h.flush()
  assert.equal(pocketOf(h)!.mode, 'closed', 'task churn and carousel moves do not open it')
  assert.deepEqual(h.calls.focus?.at(-1), [null], 'so the address is still the router')

  // The controller exposes no capture hook at all any more — the only way in
  // is the user's own gesture.
  assert.equal(typeof (h.controller as unknown as { notifyCapturing?: unknown }).notifyCapturing,
    'undefined', 'no capture-driven open survives')
})

test('leaving collapses the WALL too, not just a task', () => {
  // The wall is the surface most likely to be covering the screen, and it was
  // the one exempted: keying on focusedId meant a focusless cockpit rode along
  // to whatever you switched to.
  const h = setup()
  put(h, makeTask({ id: 'a', state: 'done', kind: 'session', alive: true }))
  h.client.fire({ type: 'openDashboard' })
  h.flush()
  assert.equal(h.client.last('setState')!.state, 'cockpit')

  h.client.fire({ type: 'userLeft', reason: 'space' })
  h.flush()
  assert.notEqual(h.client.last('setState')!.state, 'cockpit', 'it gets out of the way')
  assert.equal(pocketOf(h)!.mode, 'closed', 'and it does not aim your voice anywhere on the way out')
})

test('a quick return restores the surface you were actually on', () => {
  const h = setup()
  put(h, makeTask({ id: 'a', state: 'done', kind: 'session', alive: true }))
  h.client.fire({ type: 'openDashboard' })
  h.client.fire({ type: 'userLeft', reason: 'space' })
  h.flush()
  h.client.fire({ type: 'userReturned' })
  h.flush()
  assert.equal(h.client.last('setState')!.state, 'cockpit', 'the wall comes back as the wall')

  // …and a task comes back as that task, not as the wall.
  const h2 = setup()
  put(h2, makeTask({ id: 'b', state: 'needs-user', alive: true, question: { text: 'q' } }))
  h2.client.fire({ type: 'tap' })
  h2.client.fire({ type: 'userLeft', reason: 'blur' })
  h2.flush()
  h2.client.fire({ type: 'userReturned' })
  h2.flush()
  assert.equal(h2.client.last('setState')!.state, 'task')
  assert.deepEqual(h2.calls.focus?.at(-1), ['b'])
  assert.equal(pocketOf(h2)!.mode, 'closed', 'the carousel is not left aimed at anything')
})

test('leaving with nothing expanded does nothing at all', () => {
  const h = setup()
  put(h, makeTask({ id: 'a', state: 'processing', alive: true }))
  h.flush()
  const before = h.client.last('setState')!.state
  h.client.fire({ type: 'userLeft', reason: 'space' })
  h.flush()
  assert.equal(h.client.last('setState')!.state, before)
})

test('the pocket keeps what you worked in, and marks what wants you', () => {
  // THIS ONCE ASSERTED THE OPPOSITE — the pocket held demanding tasks only, so
  // anything else you looked at became unreachable the moment you left it. But
  // the rule it was reaching for was about AUTO-FILL, not capacity. Capacity is
  // what you have worked in; `demanding` says which of those is waiting.
  const h = setup()
  put(h, makeTask({ id: 'live', state: 'processing', alive: true, name: 'Live' }))
  put(h, makeTask({ id: 'old', state: 'done', kind: 'oneoff', alive: true, name: 'Old errand' }))
  put(h, makeTask({ id: 'ask', state: 'needs-user', alive: true, name: 'Ask', question: { text: 'q' } }))
  for (const id of ['live', 'old']) {
    h.client.fire({ type: 'focusTask', id })
    h.client.fire({ type: 'closeStage' })
  }
  h.client.fire({ type: 'pocketOpen' })
  const slots = pocketOf(h)!.slots
  for (const id of ['live', 'old', 'ask']) {
    assert.ok(slots.some((sl) => sl.id === id), `${id} must stay reachable`)
  }
  assert.equal(slots.find((sl) => sl.id === 'ask')!.demanding, true)
  assert.equal(slots.find((sl) => sl.id === 'old')!.demanding, false)
  assert.equal(h.client.last('setState')!.attention, 1)
})

test('closing quiets the current attention episode without removing its task', () => {
  const h = setup()
  put(h, makeTask({ id: 'c', state: 'done', kind: 'session', alive: true, name: 'Checkpoint' }))
  assert.equal(h.client.last('setState')!.attention, 1)
  h.client.fire({ type: 'tap' })
  h.client.fire({ type: 'closeStage' })
  h.flush()
  assert.equal(h.client.last('setState')!.attention, 0, 'you looked at it; it stops asking')
  h.client.fire({ type: 'pocketOpen' })
  assert.ok(pocketOf(h)!.slots.some((sl) => sl.id === 'c'), 'quieted is not removed')

  const h2 = setup()
  put(h2, makeTask({ id: 'q', state: 'needs-user', alive: true, question: { text: 'q' } }))
  h2.client.fire({ type: 'tap' })
  h2.client.fire({ type: 'closeStage' })
  h2.flush()
  assert.equal(h2.client.last('setState')!.attention, 0, 'looking then dismissing acknowledges this question episode')
  h2.client.fire({ type: 'pocketOpen' })
  assert.ok(pocketOf(h2)!.slots.some((sl) => sl.id === 'q'), 'the unresolved question stays reachable')
})

test('a session done on its own scheduled continuation does not demand attention', () => {
  // An autonomous multi-task session flips done->processing on every turn
  // boundary its own loop drives — Task.checkpoint marks the ones that are a
  // scheduled pause, not a real stop. Without this, a busy session pops the
  // notch open dozens of times an hour: exactly the "it just keeps popping up
  // again and again" field report this guards against.
  const h = setup()
  put(h, makeTask({
    id: 'loop', state: 'done', kind: 'session', alive: true, name: 'Autonomous plan',
    checkpoint: true, checkpointExpiresAt: Date.now() + 5 * 60_000, // wakeup due in 5 min
  }))
  assert.equal(h.client.last('setState')!.attention, 0, 'a scheduled pause is not news')
  h.client.fire({ type: 'pocketOpen' })
  assert.ok(pocketOf(h)!.slots.some((sl) => sl.id === 'loop'), 'still reachable — just not demanding')
  assert.equal(pocketOf(h)!.slots.find((sl) => sl.id === 'loop')!.demanding, false)

  // The very next turn genuinely finishing (checkpoint cleared) must demand
  // attention exactly as an ordinary session-done already does — this flag
  // must never leak forward and silence a real finish.
  const h2 = setup()
  put(h2, makeTask({ id: 'real', state: 'done', kind: 'session', alive: true, checkpoint: false, name: 'Real finish' }))
  assert.equal(h2.client.last('setState')!.attention, 1, 'a real stop still demands attention as before')
})

test('a checkpoint past its own promised wakeup re-demands — an abandoned loop must not go silent forever', () => {
  // The loop said "wake me in N seconds" and never did — app quit, crashed,
  // whatever. Task.checkpointExpiresAt is that promise plus grace; past it,
  // this is exactly as stuck as any other abandoned session-done, and must
  // eventually surface again rather than staying invisible because it once,
  // correctly, suppressed itself for a turn that never actually resumed.
  const h = setup()
  put(h, makeTask({
    id: 'stuck', state: 'done', kind: 'session', alive: true, name: 'Never came back',
    checkpoint: true, checkpointExpiresAt: Date.now() - 1000, // its own promised wakeup already passed
  }))
  assert.equal(h.client.last('setState')!.attention, 1, 'the expired checkpoint no longer suppresses attention')
  h.client.fire({ type: 'pocketOpen' })
  assert.equal(pocketOf(h)!.slots.find((sl) => sl.id === 'stuck')!.demanding, true)
})


// ── the state collapse: what wants you, and why ────────────────────────────
//
// These are the rules the whole redesign rests on. Each one replaces a
// behaviour that shipped and was wrong in the field.

test('a finished ERRAND does not demand; a finished THREAD does', () => {
  const h = setup()
  put(h, makeTask({ id: 'errand', state: 'done', kind: 'oneoff', name: 'play the video' }))
  assert.equal(h.client.last('setState')!.attention, 0, 'the video is playing; nothing is owed')

  put(h, makeTask({ id: 'thread', state: 'done', kind: 'session', name: 'the refactor' }))
  assert.equal(h.client.last('setState')!.attention, 1, 'the ball came back to you')
  assert.equal(h.client.last('showTask')?.task.id, 'thread')
})

test('the demand window is spent in YOUR time — being away costs nothing', () => {
  const h = setup()
  put(h, makeTask({ id: 'thread', state: 'done', kind: 'session', name: 'the refactor' }))
  assert.equal(h.client.last('setState')!.attention, 1)

  // Four hours at lunch. The wall clock has moved; yours has not.
  h.presence.away()
  h.flush()
  assert.equal(h.client.last('setState')!.attention, 1, 'it must still be waiting when you get back')

  // Now four hours WITH you at the machine — you had every chance to look.
  h.presence.wake()
  h.presence.spend(4 * 60 * 60 * 1000)
  h.flush()
  assert.equal(h.client.last('setState')!.attention, 0, 'seen your chance; it steps down to reach')
})

test('a blocked task never ages out, however long you sit there', () => {
  const h = setup()
  put(h, makeTask({ id: 'q', state: 'needs-user', name: 'asked you', question: { text: 'which?' } }))
  h.presence.spend(24 * 60 * 60 * 1000)
  h.flush()
  assert.equal(h.client.last('setState')!.attention, 1, 'a live question has one exit: answering it')
})

test('nothing that ages out ever leaves the pocket — it just goes quiet', () => {
  const h = setup()
  put(h, makeTask({ id: 'thread', state: 'done', kind: 'session', name: 'the refactor' }))
  h.client.fire({ type: 'focusTask', id: 'thread' })   // worked in it
  h.client.fire({ type: 'closeStage' })
  h.presence.spend(4 * 60 * 60 * 1000)
  h.flush()
  h.client.fire({ type: 'pocketOpen' })
  const slots = pocketOf(h)!.slots
  assert.ok(slots.some((sl) => sl.id === 'thread'), 'still reachable without the dashboard')
  assert.equal(slots.find((sl) => sl.id === 'thread')!.demanding, false, 'but quiet')
  assert.equal(pocketOf(h)!.waiting, 0)
})

// ── the crank: demanding, then the seam, then today ────────────────────────




test('the pocket runs demanding first, then what you have worked in', () => {
  const h = setup()
  put(h, makeTask({ id: 'errand', state: 'done', kind: 'oneoff', name: 'Errand' }))
  h.client.fire({ type: 'focusTask', id: 'errand' })    // you worked in it
  h.client.fire({ type: 'closeStage' })
  put(h, makeTask({ id: 'blocked', state: 'needs-user', name: 'Blocked', question: { text: 'q' } }))
  h.client.fire({ type: 'pocketOpen' })
  const slots = taskSlots(h)
  assert.deepEqual(slots.map((sl) => sl.id), ['blocked', 'errand'],
    'waiting on you first, then the rest — and no divider between them')
  assert.equal(slots[0].demanding, true)
  assert.equal(slots[1].demanding, false)
  assert.equal(pocketOf(h)!.waiting, 1, 'only the demanding one is ever counted at you')
})

test('opening an old task relaunches it without putting it in Today or the pocket', () => {
  // THE FIELD REPORT: open an old finished task just to read it, and it landed
  // in the pocket. Relaunch is now allowed because opening a persistent thread
  // means using it, but TaskManager.opened preserves its activity clock: making
  // a process reachable is not new work and must not reorder the wall.
  const h = setup()
  const old = Date.now() - 5 * 24 * 60 * 60 * 1000
  put(h, makeTask({ id: 'ancient', state: 'done', kind: 'session', name: 'Five days ago', createdAt: old, updatedAt: old }))
  h.client.fire({ type: 'focusTask', id: 'ancient' })
  h.client.fire({ type: 'closeStage' })
  h.client.fire({ type: 'pocketOpen' })
  assert.ok(!(pocketOf(h)?.slots ?? []).some((sl) => sl.id === 'ancient'), 'not in the pocket')
  assert.equal(h.tasks.get('ancient')!.updatedAt, old, 'and its clock was not touched')
  assert.deepEqual(h.calls.opened, [['ancient']], 'the sleeping session is made reachable')
})

// ── ordering: what YOU touched, not what happened ──────────────────────────

// The pocket used to sort on `updatedAt`, which a task stamps on a message sent
// OR RECEIVED — so a background agent printing a line climbed to card 1 ahead of
// the task the user was mid-sentence with, and re-aimed the voice at itself. The
// order reads as random precisely because the thing reordering it is invisible.
// It sorts on the USER's clock now: only your own moves change it.
test('the pocket orders by when YOU last talked to a task', () => {
  const h = setup()
  const t0 = Date.now()
  put(h, makeTask({ id: 'a', state: 'done', kind: 'session', name: 'A',
                    createdAt: t0 - 5 * 60_000, updatedAt: t0 - 5 * 60_000 }))
  put(h, makeTask({ id: 'b', state: 'done', kind: 'session', name: 'B',
                    createdAt: t0 - 60_000, updatedAt: t0 - 60_000 }))
  h.client.fire({ type: 'pocketOpen' })
  assert.deepEqual(taskSlots(h).map((sl) => sl.id), ['b', 'a'],
    'never talked to since dispatch: most recently dispatched leads')

  // THE AGENT MOVING IS NOT YOU MOVING.
  h.client.fire({ type: 'pocketRelease' })
  h.tasks.get('a')!.updatedAt = Date.now()
  h.events.emit('updated', h.tasks.get('a')); h.flush()
  h.client.fire({ type: 'pocketOpen' })
  assert.deepEqual(taskSlots(h).map((sl) => sl.id), ['b', 'a'],
    'output arriving on its own must not reorder your pocket')

  // You answer A. Now it is the one you last talked to, so it is card 1.
  h.client.fire({ type: 'pocketRelease' })
  h.client.fire({ type: 'answerText', id: 'a', text: 'carry on' })
  h.flush()
  h.client.fire({ type: 'pocketOpen' })
  assert.deepEqual(taskSlots(h).map((sl) => sl.id), ['a', 'b'])
})

test('opening a card does not count as sending a message', () => {
  const h = setup()
  const t0 = Date.now()
  put(h, makeTask({ id: 'a', state: 'done', kind: 'session', name: 'A', createdAt: t0 - 5 * 60_000 }))
  put(h, makeTask({ id: 'b', state: 'done', kind: 'session', name: 'B', createdAt: t0 - 60_000 }))
  h.client.fire({ type: 'pocketOpen' })
  h.client.fire({ type: 'pocketMove', delta: 1 })   // onto A
  h.client.fire({ type: 'pocketExpand' })           // and into it
  h.flush()
  // The expand deliberately HOLDS the order so escaping returns you to your
  // place (see setPocketMode). Let it go, the way closing the pocket does, and
  // the next fresh visit re-sorts.
  h.client.fire({ type: 'pocketRelease' })
  h.client.fire({ type: 'pocketOpen' })
  assert.deepEqual(taskSlots(h).map((sl) => sl.id), ['b', 'a'],
    'reading leaves user-message recency unchanged')
})

// ── the Agent: an ELEMENT of the pocket, never a task in its queue ─────────

test('the Agent is always in the pocket, even with no tasks at all', () => {
  const h = setup()
  h.client.fire({ type: 'pocketOpen' })
  const slots = pocketOf(h)!.slots
  assert.equal(slots.length, 1, 'an empty desk still has the Agent on it')
  assert.equal(slots[0].kind, 'agent')
  assert.equal(slots[0].title, 'Unmute')
})

test('it sits BEHIND the tasks until it has something to say', () => {
  const h = setup()
  put(h, makeTask({ id: 'a', state: 'done', kind: 'session', name: 'A' }))
  put(h, makeTask({ id: 'b', state: 'done', kind: 'session', name: 'B' }))
  h.client.fire({ type: 'pocketOpen' })
  assert.deepEqual(pocketOf(h)!.slots.map((sl) => sl.kind), ['task', 'task', 'agent'])
})

test('answering brings it in FRONT of everything, and reading puts it back', () => {
  const h = setup()
  put(h, makeTask({ id: 'a', state: 'done', kind: 'session', name: 'A' }))
  h.controller.agentAsked('what is on my plate?')
  h.controller.agentAnswered('Eleven open, four blocked on you.')
  h.flush()
  h.client.fire({ type: 'pocketOpen' })
  assert.deepEqual(pocketOf(h)!.slots.map((sl) => sl.kind), ['agent', 'task'],
    'an unread answer is the one thing that puts it in front')

  // Reading it is opening the card. Passing it on the carousel is not.
  h.client.fire({ type: 'pocketMove', delta: 1 })
  h.flush()
  assert.equal(pocketOf(h)!.slots[0].kind, 'agent', 'a glance is not reading')

  h.client.fire({ type: 'pocketMove', delta: -1 })   // back onto the Agent
  h.client.fire({ type: 'pocketExpand' })            // and into it
  h.flush()
  h.client.fire({ type: 'pocketRelease' })
  h.client.fire({ type: 'pocketOpen' })
  assert.deepEqual(pocketOf(h)!.slots.map((sl) => sl.kind), ['task', 'agent'],
    'read once, it is not a priority any more')
})

test('the Agent never counts toward the attention badge', () => {
  // It is always present, so counting it would be a permanent +1 on a number
  // whose whole meaning is "things waiting on you".
  const h = setup()
  h.controller.agentAsked('anything?')
  h.controller.agentAnswered('Two things.')
  h.flush()
  assert.equal(h.client.last('setState')!.attention, 0)
  assert.equal(pocketOf(h)!.waiting, 0)
})

test('expanding the Agent shows the conversation, not a task', () => {
  const h = setup()
  h.controller.agentAsked('list the repos')
  h.controller.agentAnswered('Three: unmute-cloud, monitor, BoloAI.')
  h.flush()
  h.client.fire({ type: 'pocketOpen' })
  h.client.fire({ type: 'pocketExpand' })
  h.flush()
  const shown = h.client.last('showTask')!.task
  assert.equal(shown.id, 'unmute-agent')
  assert.equal(shown.origin, 'unmute-agent')
  assert.equal(shown.terminal, false, 'there is no process behind it to open')
  assert.deepEqual(shown.blocks!.map((b: { kind: string }) => b.kind), ['message', 'message'])
  assert.equal((shown.blocks![1] as { text: string }).text,
    'Three: unmute-cloud, monitor, BoloAI.', 'the WHOLE answer, not the card line')
})

test('the card shows the concise line; the chat holds the whole answer', () => {
  const h = setup()
  const long = `Here is the first line of it.\n\n${'and more detail. '.repeat(40)}`
  h.controller.agentAsked('summarise')
  h.controller.agentAnswered(long)
  h.flush()
  h.client.fire({ type: 'pocketOpen' })
  const card = pocketOf(h)!.slots.find((sl) => sl.kind === 'agent')!
  assert.equal(card.ask, 'Here is the first line of it.')
  h.client.fire({ type: 'pocketExpand' })
  h.flush()
  const shown = h.client.last('showTask')!.task
  assert.equal((shown.blocks![1] as { text: string }).text, long.trim())
})

test('the voice aims at the Agent when its card is the one in front', () => {
  const h = setup()
  put(h, makeTask({ id: 'a', state: 'done', kind: 'session', name: 'A' }))
  h.client.fire({ type: 'pocketOpen' })
  assert.equal(h.controller.agentAddressed(), false, 'a task is in front')
  h.client.fire({ type: 'pocketMove', delta: 1 })   // onto the Agent
  assert.equal(h.controller.agentAddressed(), true)
})

test('opening a task after aiming at the Agent hands the voice to the task', () => {
  // Field log 2026-09-13: the pocket rested on the Agent, a session was then
  // opened, and right Option still submitted to the Agent — the Agent flag was
  // never lowered, and at submit it outranks the focused task.
  let addressed = false
  const h = setup({ deps: { addressAgent: (on) => { addressed = on } } })
  put(h, makeTask({ id: 'a', state: 'done', kind: 'session', name: 'A' }))
  h.client.fire({ type: 'pocketOpen' })
  h.client.fire({ type: 'pocketMove', delta: 1 })   // onto the Agent
  assert.equal(addressed, true)
  h.client.fire({ type: 'focusTask', id: 'a' })
  h.flush()
  assert.equal(addressed, false, 'the task you opened is what you are talking to')
})

test('escaping the chat returns to the pocket and releases the voice', () => {
  // Without this the controller goes on believing the Agent is the expanded
  // surface: the voice stays pointed at it after you have left, and a later
  // answer never marks itself unread because it thinks you are looking at it.
  const h = setup()
  put(h, makeTask({ id: 'a', state: 'done', kind: 'session', name: 'A' }))
  h.controller.agentAnswered('Two things.')
  h.flush()
  h.client.fire({ type: 'pocketOpen' })      // the Agent is in front, unread
  h.client.fire({ type: 'pocketExpand' })    // into the chat
  h.flush()
  assert.equal(h.controller.agentAddressed(), true, 'the chat is open; you are talking to it')

  h.client.fire({ type: 'collapsed' })
  h.flush()
  assert.equal(pocketOf(h)!.mode, 'open', 'back to the pocket you came from')
  h.client.fire({ type: 'pocketMove', delta: 1 })   // onto the task
  assert.equal(h.controller.agentAddressed(), false, 'the aim came back with you')

  // And a later answer can mark itself unread again.
  h.controller.agentAnswered('One more.')
  h.flush()
  assert.equal(pocketOf(h)!.slots[0].kind, 'agent')
})

test('the chat stays open while you read it', () => {
  // THE FIELD BUG, in one test. reconcile runs on every task event and did not
  // know the chat existed: `focusedId` is deliberately null for the Agent, so
  // `shown` fell through to whatever task was at the front of the queue. The
  // chat lived 0.8 seconds.
  const h = setup()
  put(h, makeTask({ id: 'noisy', state: 'needs-user', name: 'Noisy', question: { text: 'q' } }))
  h.controller.agentAnswered('Here is a long answer you are still reading.')
  h.flush()
  h.client.fire({ type: 'pocketOpen' })
  h.client.fire({ type: 'pocketExpand' })
  h.flush()
  assert.equal(h.client.last('showTask')!.task.id, 'unmute-agent')

  // Anything at all happens in the task runtime — the tick that used to kill it.
  put(h, makeTask({ id: 'other', state: 'done', kind: 'session', name: 'Other' }))
  h.events.emit('updated', h.tasks.get('noisy')); h.flush()
  assert.equal(h.client.last('showTask')!.task.id, 'unmute-agent', 'still the chat')
  assert.equal(h.client.last('setState')!.state, 'task', 'still expanded')
})

test('durable Agent restore shows actual provider/full chat and preserves newer draft while enqueue awaits', async () => {
  let acknowledge!: () => void
  const switched: string[] = []
  const h = setup({ deps: {
    agentSend: async () => new Promise<void>(resolve => { acknowledge = resolve }),
    agentSwitchProvider: async (provider) => { switched.push(provider) },
    agentInstalledProviders: async () => ['claude', 'codex'],
  } })
  const long = '🙂 full answer '.repeat(3000)
  h.controller.restoreAgentConversation({ selectedProvider: 'claude', record: { generation: 2, phase: 'ready', provider: 'codex', pendingProvider: 'claude', model: 'observed-model', runId: 'r', effort: 'medium', ceiling: 20, accepted: [], snapshotId: 's' }, snapshot: { generation: 2, chat: { runId: 'r', turns: [{ role: 'agent', text: long, at: 1 }] }, draft: { text: 'first', revision: 1 }, queued: [] } })
  h.client.fire({ type: 'pocketOpen' }); h.client.fire({ type: 'pocketExpand' }); h.flush()
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(h.client.last('showTask')!.task.title, 'Unmute (Sessions manager)')
  assert.equal(h.client.last('showTask')!.task.backend, 'codex')
  assert.equal(h.client.last('showTask')!.task.modelLabel, 'observed-model · medium')
  assert.deepEqual(h.client.last('showTask')!.task.chatConfig, {
    provider: 'claude', providerLabel: 'Claude', model: 'opus', modelLabel: 'Opus 5',
    providers: [{ id: 'claude', label: 'Claude', description: 'Opus 5' }, { id: 'codex', label: 'Codex', description: 'GPT-5.6 Sol' }],
    models: [], efforts: [], permissions: [], cwd: '', mutable: true, busy: false,
    error: 'Claude selected. The next message starts a new conversation.',
  })
  assert.equal((h.client.last('showTask')!.task.blocks![0] as { text: string }).text, long)
  h.client.fire({ type: 'agentSwitchProvider', provider: 'claude' } as never)
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.deepEqual(switched, ['claude'])
  h.client.fire({ type: 'sendDraft', id: 'unmute-agent' })
  h.client.fire({ type: 'setDraftText', id: 'unmute-agent', text: 'new edit', clientRevision: 2 })
  acknowledge(); await new Promise<void>(resolve => setImmediate(resolve)); h.flush()
  assert.equal(h.client.last('showTask')!.task.draft?.text, 'new edit')
})

test('the Agent offers only installed providers and refuses a switch to one that is not', async () => {
  const switched: string[] = []
  const h = setup({ deps: {
    agentSwitchProvider: async (provider) => { switched.push(provider) },
    agentInstalledProviders: async () => ['codex'],
  } })
  h.controller.restoreAgentConversation({ selectedProvider: 'codex', record: { generation: 1, phase: 'ready', provider: 'codex', model: 'gpt-5.6-sol', runId: 'r', effort: 'medium', ceiling: 20, accepted: [], snapshotId: 's' }, snapshot: { generation: 1, chat: { runId: 'r', turns: [{ role: 'agent', text: 'hi', at: 1 }] }, draft: { text: '', revision: 0 }, queued: [] } })
  h.client.fire({ type: 'pocketOpen' }); h.client.fire({ type: 'pocketExpand' }); h.flush()
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.deepEqual(h.client.last('showTask')!.task.chatConfig!.providers, [{ id: 'codex', label: 'Codex', description: 'GPT-5.6 Sol' }])
  h.client.fire({ type: 'agentSwitchProvider', provider: 'claude' } as never)
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.deepEqual(switched, [])
})

test('the Agent picker offers every model of every installed provider, and a model change is sent back', async () => {
  const set: string[] = []
  const h = setup({ deps: {
    agentInstalledProviders: async () => ['codex'],
    agentModelsFor: () => ({ models: [{ id: 'gpt-6-astra', label: 'GPT-6-Astra' }, { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' }, { id: 'gpt-5.6-luna', label: 'GPT-5.6-Luna' }], selected: 'gpt-5.6-sol' }),
    agentSetModel: async (provider, model) => { set.push(`${provider}:${model}`) },
  } })
  h.controller.restoreAgentConversation({ selectedProvider: 'codex', record: { generation: 1, phase: 'ready', provider: 'codex', model: 'gpt-5.6-sol', runId: 'r', effort: 'medium', ceiling: 20, accepted: [], snapshotId: 's' }, snapshot: { generation: 1, chat: { runId: 'r', turns: [{ role: 'agent', text: 'hi', at: 1 }] }, draft: { text: '', revision: 0 }, queued: [] } })
  h.client.fire({ type: 'pocketOpen' }); h.client.fire({ type: 'pocketExpand' }); h.flush()
  await new Promise<void>(resolve => setImmediate(resolve))
  const [codex] = h.client.last('showTask')!.task.chatConfig!.providers
  assert.deepEqual(codex.models?.map(m => m.id), ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-luna'])
  assert.equal(codex.selected, 'gpt-5.6-sol')
  h.client.fire({ type: 'agentSetModel', provider: 'codex', model: 'gpt-5.6-luna' } as never)
  h.client.fire({ type: 'agentSetModel', provider: 'claude', model: 'opus' } as never)
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.deepEqual(set, ['codex:gpt-5.6-luna'], 'never for a provider that is not installed')
})

test('opening a task takes the surface from the chat, and keeps it', () => {
  // The other half: a stale agentOpen must not bring the chat back over the
  // task you switched to, nor when you then close that task.
  const h = setup()
  put(h, makeTask({ id: 'a', state: 'done', kind: 'session', name: 'A' }))
  h.controller.agentAnswered('Something.')
  h.flush()
  h.client.fire({ type: 'pocketOpen' })
  h.client.fire({ type: 'pocketExpand' })      // into the chat
  h.flush()
  assert.equal(h.client.last('showTask')!.task.id, 'unmute-agent')

  // Opening a card from the wall goes to the COCKPIT with that task staged —
  // a different surface again, and the one a stale agentOpen would fight.
  h.client.fire({ type: 'focusTask', id: 'a' })
  h.flush()
  assert.equal(h.client.last('setState')!.state, 'cockpit', 'the wall took the front')
  assert.equal(h.client.last('stageDetail')!.task.id, 'a')
  h.events.emit('updated', h.tasks.get('a')); h.flush()
  assert.equal(h.client.last('setState')!.state, 'cockpit', 'and kept it')
})

test('leaving for another app gets the chat out of the way too', () => {
  const h = setup()
  h.controller.agentAnswered('Something.')
  h.flush()
  h.client.fire({ type: 'pocketOpen' })
  h.client.fire({ type: 'pocketExpand' })
  h.flush()
  h.client.fire({ type: 'userLeft', reason: 'blur' })
  h.flush()
  assert.notEqual(h.client.last('setState')!.state, 'task',
    'a chat left open over the app you switched to is the complaint this answers')
})

test('purging clears the chat and leaves the card', () => {
  const h = setup()
  h.controller.agentAsked('anything?')
  h.controller.agentAnswered('Two things.')
  h.controller.agentPurged()
  h.flush()
  h.client.fire({ type: 'pocketOpen' })
  const card = pocketOf(h)!.slots.find((sl) => sl.kind === 'agent')!
  assert.equal(card.ask, 'Ask me anything', 'the card stays; it just has nothing to say')
  assert.equal(card.demanding, false)
})

// ── the pocket chord — one gesture, one rung deeper each press ─────────────

test('the chord opens the pocket, then expands the card it is on', () => {
  const h = setup()
  const t0 = Date.now()
  put(h, makeTask({ id: 'a', state: 'done', kind: 'session', name: 'A', createdAt: t0 - 5 * 60_000 }))
  put(h, makeTask({ id: 'b', state: 'done', kind: 'session', name: 'B', createdAt: t0 - 60_000 }))

  h.controller.pocketChord()
  h.flush()
  assert.equal(pocketOf(h)!.mode, 'open', 'rung one')
  assert.equal(pocketOf(h)!.at, 0, 'a fresh visit lands on card 1')

  h.client.fire({ type: 'pocketMove', delta: 1 })   // walk to A
  h.controller.pocketChord()
  h.flush()
  assert.equal(h.client.last('showTask')!.task.id, 'a', 'rung two expands the card you are on')
})

/// AN OPEN POCKET IS NOT AN EMPTY SURFACE.
///
/// reconcile's fall-through sends `dormant` whenever no task is processing —
/// and it said that with the pocket standing open. On a notched Mac dormant IS
/// the cutout (dormantFrame() is the hole itself), so the card the chord just
/// opened was drawn behind the camera housing, where there is no screen: press
/// the chord, nothing appears. The click path hit the same line; it only looked
/// different because a click has to reveal the bar first.
test('the chord never lands the pocket in the cutout', () => {
  // NOTHING DEMANDING, which is the ordinary case for this gesture: you press
  // the chord to go and look, not because something called you. reconcile then
  // falls through to its "nothing is running" line — and used to say `dormant`
  // with the pocket standing open.
  const h = setup()
  h.controller.pocketChord()
  h.flush()
  assert.equal(pocketOf(h)!.mode, 'open')
  assert.notEqual(h.client.last('setState')!.state, 'dormant',
    'dormant is the notch cutout — the card would open where there is no screen')
})

test('tapping the pocket open does not command dormant either', () => {
  const h = setup()
  h.client.fire({ type: 'pocketOpen' })
  h.flush()
  assert.notEqual(h.client.last('setState')!.state, 'dormant')
})

/// The other half, so the rule above cannot be satisfied by never resting at
/// all: close the pocket and the quiet surface goes back down.
test('closing the pocket lets the surface rest again', () => {
  const h = setup()
  h.controller.pocketChord()
  h.flush()
  assert.notEqual(h.client.last('setState')!.state, 'dormant', 'open')
  h.client.fire({ type: 'pocketRelease' })
  h.flush()
  assert.equal(h.client.last('setState')!.state, 'dormant', 'closed again')
})

/// A working task still outranks the pocket: `active` carries the count, and
/// the pocket rides on it exactly as it rides on the quiet rung.
test('a working task still reports active with the pocket open', () => {
  const h = setup()
  put(h, makeTask({ id: 'w', state: 'processing' }))
  h.controller.pocketChord()
  h.flush()
  assert.equal(h.client.last('setState')!.state, 'active')
})

test('the chord does nothing once you are already expanded', () => {
  // Going deeper again would mean guessing, and the way out is Escape.
  const h = setup()
  put(h, makeTask({ id: 'a', state: 'done', kind: 'session', name: 'A' }))
  h.controller.pocketChord()
  h.controller.pocketChord()
  h.flush()
  const before = h.client.ofType('pocket').length
  h.controller.pocketChord()
  h.flush()
  assert.equal(h.client.ofType('pocket').length, before, 'nothing moved')
})

test('finishing a capture without an accepted message does not change recency', () => {
  const h = setup()
  const t0 = Date.now()
  put(h, makeTask({ id: 'a', state: 'done', kind: 'session', name: 'A',
                    createdAt: t0 - 5 * 60_000, updatedAt: t0 - 5 * 60_000 }))
  put(h, makeTask({ id: 'b', state: 'done', kind: 'session', name: 'B',
                    createdAt: t0 - 60_000, updatedAt: t0 - 60_000 }))
  h.client.fire({ type: 'pocketOpen' })
  h.client.fire({ type: 'pocketMove', delta: 1 })     // walking — order now held
  h.controller.notifyCapturePhase('idle', 'a')        // you speak to A underneath you
  h.flush()
  assert.deepEqual(taskSlots(h).map((sl) => sl.id), ['b', 'a'],
    'the list you are reading must not reshuffle under your thumb')
  h.client.fire({ type: 'pocketRelease' })
  h.client.fire({ type: 'pocketOpen' })
  assert.deepEqual(taskSlots(h).map((sl) => sl.id), ['b', 'a'], 'capture completion is not a sent message')
})

// ── presence: the one thing allowed to open the surface ────────────────────

test('work finishing while you are AT the machine never takes your screen', () => {
  const h = setup()
  h.controller.setAutoExpand(true)
  put(h, makeTask({ id: 'thread', state: 'done', kind: 'session', name: 'the refactor' }))
  assert.equal(h.client.last('setState')!.attention, 1, 'the badge ticks')
  // (auto-expand is the legacy path and stays; what must never happen is the
  //  wake path firing while you are already here.)
  assert.ok(!h.client.ofType('pocket').some((c) => c.data.mode === 'open'),
    'the pocket must not open itself')
})

test('coming back with a backlog stays compact and does not open a task', () => {
  const h = setup()
  h.presence.away()
  put(h, makeTask({ id: 'thread', state: 'done', kind: 'session', name: 'the refactor',
                    createdAt: Date.now() - 90_000, updatedAt: Date.now() - 90_000 }))
  put(h, makeTask({ id: 'q', state: 'needs-user', name: 'Blocked',
                    createdAt: Date.now() - 30_000, updatedAt: Date.now() - 30_000, question: { text: 'which?' } }))
  h.presence.wake()
  h.flush()
  assert.equal(h.client.last('showTask')!.task.id, 'q', 'newest touch first')
  assert.equal(h.client.last('setState')!.state, 'attention', 'returning may refresh attention but must not interrupt')
})

test('closing an expanded blocked task acknowledges only its current attention episode', () => {
  const h = setup()
  h.controller.setAutoExpand(true)
  const task = makeTask({ id: 'q', state: 'needs-user', name: 'Blocked', question: { text: 'which?' } })
  put(h, task)
  assert.equal(h.client.last('setState')!.state, 'task')

  h.client.fire({ type: 'collapsed' })
  h.flush()
  assert.equal(h.client.last('setState')!.attention, 0, 'dismissed unchanged demand stays quiet')

  h.events.emit('updated', task)
  h.flush()
  assert.equal(h.client.last('setState')!.attention, 0, 'polling the same state must not resurrect it')
  h.presence.away()
  h.presence.wake()
  h.flush()
  assert.equal(h.client.last('setState')!.attention, 0, 'returning to the Mac must not resurrect it either')

  task.state = 'processing'
  h.events.emit('updated', task)
  h.flush()
  task.state = 'needs-user'
  h.events.emit('updated', task)
  h.flush()
  assert.equal(h.client.last('setState')!.attention, 1, 'a genuine new blocking episode demands attention again')
})

test('coming back to a clean desk shows a clean desk', () => {
  const h = setup()
  h.presence.away()
  put(h, makeTask({ id: 'errand', state: 'done', kind: 'oneoff', name: 'played the video' }))
  h.presence.wake()
  h.flush()
  assert.equal(h.client.last('setState')!.attention, 0)
  assert.notEqual(h.client.last('setState')!.state, 'attention')
})

test('coming back does not yank away something you left open', () => {
  const h = setup()
  put(h, makeTask({ id: 'reading', state: 'processing', name: 'Reading this' }))
  h.client.fire({ type: 'focusTask', id: 'reading' })
  h.presence.away()
  put(h, makeTask({ id: 'q', state: 'needs-user', name: 'Blocked', question: { text: 'which?' } }))
  h.presence.wake()
  h.flush()
  assert.equal(h.client.last('stageDetail')?.task.id ?? h.client.last('showTask')?.task.id, 'reading')
})

// ── the field report, 2026-08-08 ────────────────────────────────────────────
//
// Every one of these reproduces something seen in use on 1.4.22-dev.1.

test('browsing never re-ranks — the list you are reading holds still', () => {
  // THE FIELD BUG: `→ →` showed the same task twice and expanding opened a
  // different one than the card on screen. setFocus() stamped engagement, so
  // merely cranking past a card re-sorted the list around it — and the slot
  // under the index changed between choosing it and drawing it.
  const h = setup()
  for (const id of ['a', 'b', 'c']) {
    put(h, makeTask({ id, state: 'done', kind: 'oneoff', name: id.toUpperCase() }))
    h.client.fire({ type: 'focusTask', id })
    h.client.fire({ type: 'closeStage' })
  }
  h.client.fire({ type: 'pocketOpen' })
  const before = pocketOf(h)!.slots.map((s) => s.id)
  for (let i = 0; i < 3; i++) h.client.fire({ type: 'pocketMove', delta: 1 })
  assert.deepEqual(pocketOf(h)!.slots.map((s) => s.id), before, 'order unmoved after a full lap')
})

test('what you expand is what was on the card', () => {
  const h = setup()
  for (const id of ['a', 'b']) {
    put(h, makeTask({ id, state: 'done', kind: 'oneoff', name: id.toUpperCase() }))
    h.client.fire({ type: 'focusTask', id })
    h.client.fire({ type: 'closeStage' })
  }
  h.client.fire({ type: 'pocketOpen' })
  h.client.fire({ type: 'pocketMove', delta: 1 })
  const p = pocketOf(h)!
  const showing = p.slots[p.at].id
  h.client.fire({ type: 'pocketExpand' })
  assert.equal(h.calls.focus!.at(-1)![0], showing, 'expanded the card you were looking at')
})

test('escape from a card you opened out of the pocket goes back to the pocket', () => {
  const h = setup()
  put(h, makeTask({ id: 'q', state: 'needs-user', name: 'Blocked', question: { text: 'q' } }))
  h.client.fire({ type: 'pocketOpen' })
  h.client.fire({ type: 'pocketExpand' })
  assert.equal(pocketOf(h)!.mode, 'closed', 'expanded: the pocket steps aside')
  h.client.fire({ type: 'closeStage' })
  assert.equal(pocketOf(h)!.mode, 'open', 'and comes straight back when you leave')
})

test('a task you never opened from the pocket still just closes', () => {
  const h = setup()
  put(h, makeTask({ id: 'q', state: 'needs-user', name: 'Blocked', question: { text: 'q' } }))
  h.client.fire({ type: 'tap' })            // straight to the task, no pocket
  h.client.fire({ type: 'closeStage' })
  assert.equal(pocketOf(h)!.mode, 'closed')
})

test('the closed surface counts only what is waiting', () => {
  const h = setup()
  put(h, makeTask({ id: 'seen', state: 'done', kind: 'session', name: 'Seen' }))
  h.client.fire({ type: 'tap' })
  h.client.fire({ type: 'closeStage' })     // seen → leaves the interruption queue
  const p = pocketOf(h)!
  assert.ok(p.slots.some((s) => s.id === 'seen'), 'still in the pocket')
  assert.equal(p.waiting, 0, 'but the closed surface has nothing to say about it')
})

test('a demand window that expires re-renders on its own', () => {
  // The predicate is time-dependent; nothing used to re-run it, so a task went
  // quiet only when something unrelated happened to trigger a render.
  const h = setup()
  put(h, makeTask({ id: 'thread', state: 'done', kind: 'session', name: 'Thread' }))
  assert.equal(h.client.last('setState')!.attention, 1)
  h.presence.spend(3 * 60 * 60 * 1000)
  const ctl = h.controller as unknown as { demandingChanged(t: TaskLite): boolean }
  assert.equal(ctl.demandingChanged(h.tasks.get('thread')!), true,
    'the tick can see the window has closed without a task event')
})

test('a finished task headlines what it produced, not what it was doing', () => {
  const t = makeTask({ id: 'x', state: 'done', step: 'reading the repository',
                       result: { summary: 'Read the README and the design docs.' } })
  assert.equal(headlineFor(t), 'Read the README and the design docs.')
})

// ── the dashboard's Today filter ────────────────────────────────────────────

test('Today hides what has not moved in 24h, and keeps grouping intact', async () => {
  const h = setup()
  const old = Date.now() - 30 * 60 * 60 * 1000
  put(h, makeTask({ id: 'fresh', state: 'done', kind: 'session', group: 'A', name: 'Fresh', updatedAt: Date.now() }))
  put(h, makeTask({ id: 'stale', state: 'done', kind: 'session', group: 'A', name: 'Stale', updatedAt: old, createdAt: old }))
  h.client.fire({ type: 'openDashboard' })
  await new Promise((r) => setTimeout(r, 10)); h.flush()
  const all = h.client.last('setCockpit')!.data.groups.flatMap((g) => g.cards).map((c) => c.id)
  assert.ok(all.includes('stale'), 'off by default — the wall still shows everything')

  h.client.fire({ type: 'today', on: true })
  h.flush()
  const cp = h.client.last('setCockpit')!.data
  const ids = cp.groups.flatMap((g) => g.cards).map((c) => c.id)
  assert.ok(ids.includes('fresh'))
  assert.ok(!ids.includes('stale'), 'older than 24h is gone, not folded')
  assert.equal(cp.todayOnly, true)
})

test('Today never hides something waiting on you', () => {
  const h = setup()
  const old = Date.now() - 30 * 60 * 60 * 1000
  put(h, makeTask({ id: 'oldask', state: 'needs-user', name: 'Old blocked', updatedAt: old, createdAt: old, question: { text: 'q' } }))
  h.client.fire({ type: 'openDashboard' })
  h.client.fire({ type: 'today', on: true })
  h.flush()
  const ids = h.client.last('setCockpit')!.data.groups.flatMap((g) => g.cards).map((c) => c.id)
  assert.ok(ids.includes('oldask'), 'a filter that can hide a blocked task is a way to lose work')
})

test('a group emptied by Today disappears rather than leaving a bare heading', () => {
  const h = setup()
  const old = Date.now() - 30 * 60 * 60 * 1000
  put(h, makeTask({ id: 'a', state: 'done', kind: 'session', group: 'Gone', name: 'A', updatedAt: old, createdAt: old }))
  put(h, makeTask({ id: 'b', state: 'done', kind: 'session', group: 'Here', name: 'B', updatedAt: Date.now() }))
  h.client.fire({ type: 'openDashboard' })
  h.client.fire({ type: 'today', on: true })
  h.flush()
  const names = h.client.last('setCockpit')!.data.groups.map((g) => g.name)
  assert.ok(!names.includes('Gone'))
  assert.ok(names.includes('Here'))
})

test('a Codex task can be in the pocket — it has no PTY and that is not death', async () => {
  // THE FIELD REPORT: three tasks running, two in the pocket. The missing one
  // was Codex. `alive` is the PTY map, and a driver-backed task has no PTY by
  // design, so the pocket could never hold one — while the bar counted it and
  // the dashboard listed it.
  const h = setup()
  put(h, makeTask({ id: 'cc', state: 'processing', name: 'Claude', alive: true }))
  put(h, makeTask({ id: 'cx', state: 'processing', name: 'Codex', agent: 'codex-desktop', codexThreadId: 'th', alive: false }))
  h.client.fire({ type: 'pocketOpen' })
  const ids = pocketOf(h)!.slots.map((s) => s.id)
  assert.ok(ids.includes('cx'), 'the Codex thread is addressable and belongs in the pocket')
  assert.ok(ids.includes('cc'))
})

test('a finished one-off with no process stays out — it is genuinely over', () => {
  // The distinction is thread vs errand, not running vs not. An errand that
  // finished has no thread to continue and nothing to say to it; a session
  // that finished is asleep, and one message wakes it.
  const h = setup()
  put(h, makeTask({ id: 'errand', state: 'done', kind: 'oneoff', name: 'Errand', alive: false }))
  put(h, makeTask({ id: 'thread', state: 'done', kind: 'session', name: 'Thread', alive: false }))
  h.client.fire({ type: 'pocketOpen' })
  const ids = (pocketOf(h)?.slots ?? []).map((s) => s.id)
  assert.ok(!ids.includes('errand'))
  assert.ok(ids.includes('thread'))
})

test('a finished CODEX one-off with no process STAYS IN — it always has a rollout to resume', () => {
  // "Genuinely over" was written for the case where a dead one-off truly has
  // nothing left — true for a plain PTY errand, but never true for Codex: it
  // mints a rollout on disk for every thread, one-off or not, so resume()
  // brings it straight back (findRollout(codexRolloutId)). A quick Codex Q&A
  // whose process died (its App Server connection didn't survive the app
  // quit — see task-manager.ts) still has a "Resume" button that works; the
  // pocket dropping it anyway is the bug, not the process being dead.
  const h = setup()
  put(h, makeTask({ id: 'codex-errand', state: 'done', kind: 'oneoff', name: 'Codex errand', agent: 'codex', alive: false }))
  put(h, makeTask({ id: 'claude-errand', state: 'done', kind: 'oneoff', name: 'Claude errand', agent: 'claude', alive: false }))
  h.client.fire({ type: 'pocketOpen' })
  const ids = (pocketOf(h)?.slots ?? []).map((s) => s.id)
  assert.ok(ids.includes('codex-errand'), 'Codex always has a thread to resume, dead process or not')
  assert.ok(!ids.includes('claude-errand'), 'unrelated to the Codex fix — still genuinely over for a plain PTY errand')
})

test('the wall holds its order while you are reading it', async () => {
  // Cards are keyed by id, so a re-sort MOVES them on screen. Three tasks
  // polling once a second re-sorted the wall several times a second — the
  // "bouncing cards" report.
  const h = setup()
  const t0 = Date.now()
  put(h, makeTask({ id: 'a', state: 'processing', name: 'A', updatedAt: t0 - 2000 }))
  put(h, makeTask({ id: 'b', state: 'processing', name: 'B', updatedAt: t0 - 1000 }))
  h.client.fire({ type: 'openDashboard' })
  await new Promise((r) => setTimeout(r, 10)); h.flush()
  const first = h.client.last('setCockpit')!.data.groups.flatMap((g) => g.cards).map((c) => c.id)
  assert.deepEqual(first, ['b', 'a'])

  // A polls and bumps its clock. The wall must not rearrange under the reader.
  h.tasks.get('a')!.updatedAt = Date.now()
  h.events.emit('updated', h.tasks.get('a')); h.flush()
  const after = h.client.last('setCockpit')!.data.groups.flatMap((g) => g.cards).map((c) => c.id)
  assert.deepEqual(after, ['b', 'a'], 'held while open')

  // Leaving and coming back re-sorts to what actually moved.
  h.client.fire({ type: 'closeStage' })
  h.client.fire({ type: 'openDashboard' })
  h.flush()
  const reopened = h.client.last('setCockpit')!.data.groups.flatMap((g) => g.cards).map((c) => c.id)
  assert.deepEqual(reopened, ['a', 'b'], 'released on the next visit')
})

test('a sleeping session is still in the pocket — quitting the app is not death', () => {
  // AFTER A RELAUNCH every local session has `alive: false`: the quit killed
  // them all and nothing has resumed one yet. The pocket used to drop them, so
  // it came back holding only the Codex thread while the surface still reported
  // three waiting and `→` sat on a list of one. Sending revives (see
  // TaskManager.answer), so sleeping is one message from awake, not gone.
  const h = setup()
  put(h, makeTask({ id: 'cc1', state: 'done', kind: 'session', name: 'Claude one', alive: false }))
  put(h, makeTask({ id: 'cc2', state: 'done', kind: 'session', name: 'Claude two', alive: false }))
  put(h, makeTask({ id: 'cx', state: 'processing', name: 'Codex', agent: 'codex-desktop', codexThreadId: 'th', alive: false }))
  h.client.fire({ type: 'pocketOpen' })
  const ids = pocketOf(h)!.slots.map((s) => s.id)
  for (const id of ['cc1', 'cc2', 'cx']) assert.ok(ids.includes(id), `${id} must be reachable`)
})

test('the count and the crank can never disagree', () => {
  const h = setup()
  // Demanding but unreachable: a finished one-off with no process behind it.
  put(h, makeTask({ id: 'ghost', state: 'failed', kind: 'oneoff', name: 'Ghost', alive: false }))
  put(h, makeTask({ id: 'real', state: 'needs-user', name: 'Real', question: { text: 'q' } }))
  h.client.fire({ type: 'pocketOpen' })
  const p = pocketOf(h)!
  assert.equal(h.client.last('setState')!.attention, p.waiting,
    'the number on the bar is the number of cards you can actually reach')
  assert.ok(!p.slots.some((s) => s.id === 'ghost'))
})

test('coming back from an expanded card returns to the slot you left from', () => {
  const h = setup()
  for (const id of ['a', 'b', 'c']) {
    put(h, makeTask({ id, state: 'needs-user', name: id.toUpperCase(), question: { text: 'q' } }))
  }
  h.client.fire({ type: 'pocketOpen' })
  h.client.fire({ type: 'pocketMove', delta: 2 })          // stand on slot 3
  const standingOn = pocketOf(h)!.slots[pocketOf(h)!.at].id
  h.client.fire({ type: 'pocketExpand' })
  h.client.fire({ type: 'closeStage' })
  const p = pocketOf(h)!
  assert.equal(p.mode, 'open')
  assert.equal(p.slots[p.at].id, standingOn, 'it used to land on slot 1 every time')
})

test('next with the pocket open moves the carousel, it does not open the task', () => {
  const h = setup()
  put(h, makeTask({ id: 'a', state: 'needs-user', name: 'A', question: { text: 'q' } }))
  put(h, makeTask({ id: 'b', state: 'needs-user', name: 'B', question: { text: 'q' } }))
  h.client.fire({ type: 'pocketOpen' })
  h.client.fire({ type: 'next' })
  assert.equal(pocketOf(h)!.mode, 'open', 'still the card, not the full panel')
  assert.equal(pocketOf(h)!.at, 1, 'and it moved')
})

test('a finished thread you closed stays quiet — returning to the pocket must not un-mute it', () => {
  // The count kept saying three after all three had been read and closed:
  // closing muted the task, then the return to the pocket ran setFocus, which
  // cleared the mute, and it went straight back to demanding.
  const h = setup()
  put(h, makeTask({ id: 'x', state: 'done', kind: 'session', name: 'Seen' }))
  h.client.fire({ type: 'pocketOpen' })
  h.client.fire({ type: 'pocketExpand' })
  h.client.fire({ type: 'closeStage' })
  assert.equal(pocketOf(h)!.waiting, 0, 'nothing is waiting on you any more')
  assert.ok(pocketOf(h)!.slots.some((s) => s.id === 'x'), 'but it is still reachable')
  assert.equal(h.client.last('setState')!.attention, 0)
})

// ── THE INVARIANT ───────────────────────────────────────────────────────────
//
// Nearly every bug in this surface this week was one question answered twice.
// "Is it addressable" had three implementations and one was wrong. "Is it
// demanding" was applied by the queue and again by the pocket, so the bar could
// say three while the crank held one and `→` did nothing. This asserts the
// property those bugs violated, under conditions designed to break it — so the
// next divergence fails here instead of on someone's screen.

test('INVARIANT: everything demanding is reachable, and the count matches', () => {
  const h = setup()
  // Checked against the TASK LIST, not against the payload. Asserting the
  // payload agrees with itself proves nothing once they share a derivation —
  // the first version of this test did exactly that and survived having the
  // original defect pasted back in. The question is whether the surface has
  // dropped something that is genuinely waiting on you.
  const ctl = h.controller as unknown as { demanding(t: TaskLite): boolean }
  const mixed: Array<Partial<TaskLite> & { id: string }> = [
    { id: 'blocked', state: 'needs-user', question: { text: 'q' } },
    { id: 'thread', state: 'done', kind: 'session' },
    { id: 'errand', state: 'done', kind: 'oneoff' },
    { id: 'running', state: 'processing' },
    { id: 'broke', state: 'failed' },
    { id: 'codex', state: 'processing', agent: 'codex-desktop', codexThreadId: 'th', alive: false },
    { id: 'deadErrand', state: 'done', kind: 'oneoff', alive: false },
    { id: 'removed', state: 'needs-user', pocketRemoved: true, question: { text: 'q' } },
    { id: 'sleeping', state: 'done', kind: 'session', alive: false },
  ]
  for (const t of mixed) put(h, makeTask(t))

  const check = (why: string) => {
    const p = pocketOf(h)!
    const owed = [...h.tasks.values()].filter((t) => ctl.demanding(t))
    for (const t of owed) {
      assert.ok(p.slots.some((sl) => sl.id === t.id),
        `${t.id} is waiting on you but has no slot — ${why}`)
    }
    assert.equal(p.waiting, owed.length, `waiting vs what is owed — ${why}`)
    assert.equal(h.client.last('setState')!.attention, owed.length, `attention — ${why}`)
    assert.equal(h.controller.attentionCount, owed.length, `attentionCount — ${why}`)
    assert.equal(new Set(p.slots.map((sl) => sl.id)).size, p.slots.length, `no duplicates — ${why}`)
    assert.ok(p.at < Math.max(1, p.slots.length), `index inside the ring — ${why}`)
  }

  check('at rest')
  h.client.fire({ type: 'pocketOpen' }); check('pocket open')
  for (let i = 0; i < 12; i++) { h.client.fire({ type: 'pocketMove', delta: 1 }); check(`after ${i + 1} moves`) }
  h.presence.spend(3 * 60 * 60 * 1000); h.flush(); check('after every window expired')
  h.client.fire({ type: 'pocketExpand' }); h.client.fire({ type: 'closeStage' }); check('after expand and close')
  h.tasks.delete('blocked'); h.events.emit('removed', { id: 'blocked' }); h.flush(); check('after a task vanished')
})

test('INVARIANT: every TASK slot resolves to a task the voice can actually reach', () => {
  // Scoped to the task half deliberately. The Agent is the pocket's other
  // element kind and has no task behind it by construction — that is what
  // makes it an element rather than a task — so the invariant that matters for
  // it is a different one, asserted directly below.
  const h = setup()
  put(h, makeTask({ id: 'a', state: 'needs-user', question: { text: 'q' } }))
  put(h, makeTask({ id: 'b', state: 'done', kind: 'session', alive: false }))
  put(h, makeTask({ id: 'gone', state: 'done', kind: 'oneoff', alive: false }))
  h.client.fire({ type: 'pocketOpen' })
  for (const sl of taskSlots(h)) {
    const t = h.tasks.get(sl.id)
    assert.ok(t, `slot ${sl.id} has no task behind it`)
    assert.ok(!t!.pocketRemoved, `slot ${sl.id} was removed from the pocket`)
  }
})

test('INVARIANT: there is exactly one Agent element, whatever else happens', () => {
  const h = setup()
  const agents = () => (pocketOf(h)?.slots ?? []).filter((sl) => sl.kind === 'agent')
  const check = (when: string) => assert.equal(agents().length, 1, `two Agents ${when}`)
  h.client.fire({ type: 'pocketOpen' })
  check('on an empty desk')
  put(h, makeTask({ id: 'a', state: 'needs-user', question: { text: 'q' } }))
  h.flush(); check('with a task waiting')
  h.controller.agentAnswered('Something.'); h.flush(); check('after it answered')
  h.controller.agentAnswered('Again.'); h.flush(); check('after it answered twice')
  h.controller.agentPurged(); h.flush(); check('after a purge')
  for (let i = 0; i < 8; i++) h.client.fire({ type: 'pocketMove', delta: 1 })
  h.flush(); check('after walking the whole ring')
})

test('closing the pocket AFTER expanding a task still releases the voice', () => {
  // THE PATH THE EXISTING TEST MISSES. `applyVoiceTarget` early-returns while
  // `engaged === 'task'`, so closing the pocket cleared the aim only when you
  // had opened the pocket directly. Arrive by expanding a task — which is how
  // you get there when something demands you — and the aim survived the close.
  //
  // Focus is not a highlight: `orchestrateFocusId` sends the next utterance
  // straight to that task and never consults the router. So a brand-new request
  // spoken at a CLOSED pocket was delivered as a follow-up to whichever card
  // had been on screen, with nothing to explain where the words went.
  const h = setup()
  put(h, makeTask({ id: 'a', state: 'needs-user', kind: 'session', question: { text: 'ok?' } }))
  h.flush()

  h.client.fire({ type: 'pocketOpen' })
  h.flush()
  h.client.fire({ type: 'pocketExpand' })      // engaged becomes 'task'
  h.flush()
  assert.deepEqual(h.calls.focus?.at(-1), ['a'], 'expanded → aimed at that task')

  h.client.fire({ type: 'pocketRelease' })
  h.flush()
  assert.deepEqual(h.calls.focus?.at(-1), [null],
    'a closed pocket must hand the voice back to the router')
})

/**
 * FIELD REPORT (2026-09-07). The Agent's `unmute://task/<id>` link reused
 * `focusTask`, which sets `engaged = 'cockpit'` — correct for its own caller,
 * a card clicked on the wall, and wrong for a link: it opened the DASHBOARD,
 * a different surface with different chrome, rather than the pocket where the
 * conversation lives.
 */
test('a session link expands that card from the pocket, not the cockpit', () => {
  const h = setup()
  put(h, makeTask({ id: 'a', state: 'needs-user', alive: true }))
  put(h, makeTask({ id: 'b', state: 'needs-user', alive: true }))
  h.client.sent = []

  h.client.fire({ type: 'pocketFocusTask', id: 'b' })

  // The link opens the conversation itself, expanded — not just its pocket row.
  assert.equal(h.client.last('showTask')?.task.id, 'b', 'the linked task is shown expanded')
  assert.deepEqual(h.calls.focus?.at(-1), ['b'], 'voice follows the card the link named')
  assert.equal(h.client.last('stageDetail'), undefined, 'never the cockpit')

  // Escape from the expanded card returns to the pocket, on that card.
  h.client.fire({ type: 'collapsed' })
  h.flush()
  assert.equal(h.client.last('pocket')?.data.mode, 'open', 'coming back lands in the pocket')
})

test('a link to a card that cannot be pocketed still lands somewhere correct', () => {
  const h = setup()
  put(h, makeTask({ id: 'a', state: 'done', kind: 'oneoff', alive: false }))
  h.client.sent = []

  h.client.fire({ type: 'pocketFocusTask', id: 'a' })

  // A finished errand with no process: not pocketable. The cockpit is a
  // correct place to land, and is what focusTask would have done — a
  // fallback, never an error.
  assert.deepEqual(h.calls.focus?.at(-1), ['a'])
})

test('load earlier retries unavailable history instead of only expanding a failed cache', async () => {
  const loads: Array<[string, boolean | undefined]> = []
  const h = setup({ deps: { loadBlocks: async (id, retry) => { loads.push([id, retry]) } } })
  put(h, makeTask({ id: 'broken-history', kind: 'session', history: { phase: 'failed', canRetry: true },
    blocks: Array.from({ length: 30 }, (_, i) => ({ kind: 'message', role: i % 2 ? 'assistant' : 'user', text: `Cached message ${i}` })) }))
  h.client.fire({ type: 'focusTask', id: 'broken-history' }); h.flush()
  loads.length = 0
  h.client.fire({ type: 'loadOlderMessages', id: 'broken-history' }); h.flush()
  await Promise.resolve()
  assert.deepEqual(loads, [['broken-history', true]])
})

test('history pages grow by ten and reset after switching tasks', () => {
  const h = setup()
  const blocks = Array.from({ length: 30 }, (_, i) => ({ kind: 'message' as const, role: i % 2 ? 'assistant' as const : 'user' as const, text: `message-${i}` }))
  put(h, makeTask({ id: 'paged', kind: 'session', blocks }))
  put(h, makeTask({ id: 'other', kind: 'session' }))
  h.client.fire({ type: 'focusTask', id: 'paged' }); h.flush()
  assert.equal(h.client.last('stageDetail')!.task.blocks!.length, 10)
  assert.equal(h.client.last('stageDetail')!.task.olderMessages, 20)
  h.client.fire({ type: 'loadOlderMessages', id: 'paged' }); h.flush()
  assert.equal(h.client.last('stageDetail')!.task.blocks!.length, 20)
  h.client.fire({ type: 'focusTask', id: 'other' }); h.flush()
  h.client.fire({ type: 'focusTask', id: 'paged' }); h.flush()
  assert.equal(h.client.last('stageDetail')!.task.blocks!.length, 10)
  h.client.fire({ type: 'closeStage' }); h.flush()
  h.client.fire({ type: 'focusTask', id: 'paged' }); h.flush()
  assert.equal(h.client.last('stageDetail')!.task.blocks!.length, 10)
})

test('persisted last user input controls recency after restart', () => {
  const h = setup(); const now = Date.now()
  put(h, makeTask({ id: 'old', kind: 'session', createdAt: now - 100000, lastUserInputAt: now - 1000 }))
  put(h, makeTask({ id: 'new', kind: 'session', createdAt: now - 10000, lastUserInputAt: now - 10000 }))
  h.client.fire({ type: 'pocketOpen' })
  assert.deepEqual(taskSlots(h).map(s => s.id), ['old', 'new'])
})

test('the most recently addressed task leads even when an older task has an unseen error', () => {
 const h = setup(); const now = Date.now()
 put(h, makeTask({ id: 'old-error', kind: 'session', state: 'failed', createdAt: now - 50000, lastUserInputAt: now - 50000 }))
 put(h, makeTask({ id: 'recent', kind: 'session', state: 'done', createdAt: now - 1000, lastUserInputAt: now - 1000 }))
 h.client.fire({ type: 'pocketOpen' })
 assert.deepEqual(taskSlots(h).map(s => s.id), ['recent', 'old-error'])
})

test('fallback conversation pagination is reachable and resets on blur', () => {
  const h = setup()
  const conversation = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' as const : 'user' as const, text: String(i) }))
  put(h, makeTask({ id: 'fallback', kind: 'session', conversation }))
  h.client.fire({ type: 'focusTask', id: 'fallback' }); h.flush()
  assert.equal(h.client.last('stageDetail')!.task.olderMessages, 20)
  h.client.fire({ type: 'loadOlderMessages', id: 'fallback' }); h.flush()
  assert.equal(h.client.last('stageDetail')!.task.conversation!.length, 20)
  h.client.fire({ type: 'userLeft', reason: 'blur' }); h.flush()
  h.client.fire({ type: 'focusTask', id: 'fallback' }); h.flush()
  assert.equal(h.client.last('stageDetail')!.task.conversation!.length, 10)
})

test('accepted input outside the composer releases a held pocket order', () => {
  const h = setup(); const now = Date.now()
  const old = makeTask({ id: 'old', kind: 'session', createdAt: now - 50000, lastUserInputAt: now - 50000 })
  put(h, old)
  put(h, makeTask({ id: 'recent', kind: 'session', createdAt: now - 1000, lastUserInputAt: now - 1000 }))
  h.client.fire({ type: 'pocketOpen' })
  h.client.fire({ type: 'pocketMove', delta: 1 })
  put(h, { ...old, lastUserInputAt: now })
  h.flush()
  assert.deepEqual(taskSlots(h).map(s => s.id), ['old', 'recent'])
})

/**
 * FIELD FAILURE, 2026-09-08. A card flipped done -> processing -> done every
 * few seconds, each `processing` about fifty milliseconds long. Freshness is
 * re-stamped on every state change, so the two-hour demand clock never began
 * counting down: the card announced itself eight times, took the notch surface
 * every four seconds, and swallowed the Enter meant for whichever card the
 * person had actually navigated to.
 *
 * It only became visible when a resume promoted that one-off to a session,
 * because a done ONE-OFF never demands and a done SESSION does — the flapping
 * had been there all along, silently.
 */
test('a momentary processing blip does not reset the demand clock', () => {
  const h = setup()
  const id = 'flapper'
  // A real finish, long ago: demanding has already expired.
  put(h, makeTask({ id, state: 'done', kind: 'session', name: 'Flapper', alive: false }))
  h.client.fire({ type: 'pocketOpen' })
  const before = (pocketOf(h)?.slots ?? []).map((s) => s.id)

  // Now flap: done -> processing -> done inside a few milliseconds.
  put(h, makeTask({ id, state: 'processing', kind: 'session', name: 'Flapper', alive: false }))
  put(h, makeTask({ id, state: 'done', kind: 'session', name: 'Flapper', alive: false }))
  h.client.fire({ type: 'pocketOpen' })
  const after = (pocketOf(h)?.slots ?? []).map((s) => s.id)

  // The blip changed nothing: it is not new activity, so it cannot renew a
  // demand that had already lapsed, nor create one that never existed.
  assert.deepEqual(after, before)
})

/**
 * FIELD FAILURE, 2026-09-08. Auto-expand was guarded on `engaged === 'none'`,
 * which asks "is anyone being shown something", not "is the person busy" — and
 * dequeue() cleared it whenever the attention queue emptied. A card that kept
 * re-entering the queue therefore took the surface every few seconds, which put
 * a card switch between the person typing and pressing send.
 *
 * REWRITTEN 2026-09-19: the old version ran with auto-expand OFF, fired a
 * `pocketClose` event that does not exist and looked for a `surface` message
 * that is never sent — it could not fail. The `userTouchedAt` guard it named
 * was written and never read; it is gone, and the guarantees are tested below.
 */
test('a card that arrives while the pocket is open does not take the surface or the card', () => {
  const h = setup()
  h.controller.setAutoExpand(true)
  put(h, makeTask({ id: 'mine', state: 'processing', kind: 'session', name: 'Mine' }))
  h.client.fire({ type: 'pocketOpen' })
  h.flush()
  const at = pocketOf(h)!.at
  assert.equal(pocketOf(h)!.slots[at].id, 'mine')

  put(h, makeTask({ id: 'arriver', state: 'needs-user', kind: 'session', name: 'Arriver', alive: true,
                    lastUserInputAt: Date.now() + 1000, question: { text: 'which?' } }))

  assert.notEqual(h.client.last('setState')!.state, 'task', 'it does not yank the surface open')
  const p = pocketOf(h)!
  assert.equal(p.slots[p.at].id, 'mine', 'the card on screen is still the one you were on')
  assert.deepEqual(h.calls.focus?.at(-1), ['mine'], 'and it is still the voice address')
})

// ── FOCUS STEALING (2026-09-19) ─────────────────────────────────────────────
//
// When a task is open, nothing but the person may change which task is shown
// or where the voice goes. Every clause below is a path that used to.

function expandX(h: Harness): void {
  put(h, makeTask({ id: 'x', state: 'processing', kind: 'session', name: 'X' }))
  h.client.fire({ type: 'pocketOpen' })
  h.flush()
  h.client.fire({ type: 'pocketExpand', id: 'x' } as unknown as NotchEvent)
  h.flush()
  assert.equal(h.client.last('setState')!.state, 'task')
  assert.equal(h.client.last('showTask')!.task.id, 'x')
}

function assertStillX(h: Harness, why: string): void {
  h.flush()
  assert.equal(h.client.last('setState')!.state, 'task', `${why}: still expanded`)
  assert.equal(h.client.last('showTask')!.task.id, 'x', `${why}: still showing X`)
  assert.deepEqual(h.calls.focus?.at(-1), ['x'], `${why}: voice still on X`)
}

test('an open task stays shown and addressed when another task starts needing you', () => {
  const h = setup()
  h.controller.setAutoExpand(true)
  expandX(h)
  put(h, makeTask({ id: 'y', state: 'needs-user', name: 'Y', question: { text: 'Allow?' } }))
  assertStillX(h, 'needs-user')
})

test('an open task stays shown when the Agent creates or sends to another task', () => {
  const h = setup()
  h.controller.setAutoExpand(true)
  expandX(h)
  // Agent-created / session_send: both stamp the user's clock, which sorts first.
  put(h, makeTask({ id: 'agent-made', state: 'needs-user', kind: 'session', name: 'Made by Agent',
                    createdAt: Date.now(), lastUserInputAt: Date.now() + 5000, question: { text: 'go?' } }))
  h.events.emit('created', h.tasks.get('agent-made'))
  assertStillX(h, 'agent task_create')
  put(h, makeTask({ id: 'agent-made', state: 'done', kind: 'session', name: 'Made by Agent',
                    createdAt: Date.now(), lastUserInputAt: Date.now() + 9000 }))
  assertStillX(h, 'agent session_send wake')
})

test('an open task stays shown when another task fails or gets stuck', () => {
  const h = setup()
  h.controller.setAutoExpand(true)
  expandX(h)
  put(h, makeTask({ id: 'f', state: 'failed', name: 'F', lastUserInputAt: Date.now() + 1000 }))
  assertStillX(h, 'failed')
  put(h, makeTask({ id: 's', state: 'stuck', name: 'S', lastUserInputAt: Date.now() + 2000 }))
  assertStillX(h, 'stuck')
})

test('removing an unrelated task does not collapse the open one', () => {
  const h = setup()
  expandX(h)
  put(h, makeTask({ id: 'gone', state: 'processing', name: 'Gone' }))
  h.tasks.delete('gone')
  h.events.emit('removed', { id: 'gone' })
  assertStillX(h, 'unrelated removal')
})

test('the pocket card stays put when the Agent answers (and jumps to the front)', () => {
  const h = setup()
  put(h, makeTask({ id: 'a', state: 'processing', kind: 'session', name: 'A' }))
  put(h, makeTask({ id: 'b', state: 'processing', kind: 'session', name: 'B' }))
  h.client.fire({ type: 'pocketOpen' })
  h.client.fire({ type: 'pocketMove', to: 1 } as unknown as NotchEvent)
  const before = pocketOf(h)!
  const shown = before.slots[before.at].id
  const focus = h.calls.focus?.at(-1)

  h.controller.agentAnswered('Something for you')

  const after = pocketOf(h)!
  assert.equal(after.slots[0].kind, 'agent', 'unread Agent moved to the front')
  assert.equal(after.slots[after.at].id, shown, 'but the card on screen is the same card')
  assert.deepEqual(h.calls.focus?.at(-1), focus, 'and the voice did not move')
  assert.equal(h.controller.agentAddressed(), false, 'the Agent is not addressed just by jumping forward')
})

test('the pocket card stays put when a new task sorts first', () => {
  const h = setup()
  put(h, makeTask({ id: 'a', state: 'processing', kind: 'session', name: 'A' }))
  h.client.fire({ type: 'pocketOpen' })
  h.flush()
  assert.equal(pocketOf(h)!.slots[pocketOf(h)!.at].id, 'a')

  put(h, makeTask({ id: 'fresh', state: 'processing', kind: 'session', name: 'Fresh',
                    createdAt: Date.now(), lastUserInputAt: Date.now() + 5000 }))

  const p = pocketOf(h)!
  assert.equal(p.slots[0].id, 'fresh', 'the new task does sort first')
  assert.equal(p.slots[p.at].id, 'a', 'the card on screen did not change')
  assert.deepEqual(h.calls.focus?.at(-1), ['a'])
})

test('while a capture is recording nothing auto-expands, and it applies once the capture ends', () => {
  let capturing = true
  const h = setup({ deps: { isCapturing: () => capturing } })
  h.controller.setAutoExpand(true)
  const focusCalls = h.calls.focus?.length ?? 0

  put(h, makeTask({ id: 'q', state: 'needs-user', name: 'Q', question: { text: 'Allow?' } }))

  assert.notEqual(h.client.last('setState')!.state, 'task', 'no auto-expand mid-utterance')
  assert.equal(h.calls.focus?.length ?? 0, focusCalls, 'no focus change mid-utterance')

  capturing = false
  h.controller.notifyCapturePhase('idle', null)
  assert.equal(h.client.last('setState')!.state, 'task', 'the held expand applies after the capture')
  assert.equal(h.client.last('showTask')!.task.id, 'q')
  assert.deepEqual(h.calls.focus?.at(-1), ['q'])
  h.controller.dispose()
})

test('while a capture is recording, removing the open task does not hand the voice to another', () => {
  let capturing = false
  const h = setup({ deps: { isCapturing: () => capturing } })
  expandX(h)
  put(h, makeTask({ id: 'y', state: 'needs-user', name: 'Y', question: { text: 'Allow?' } }))
  capturing = true
  h.tasks.delete('x')
  h.events.emit('removed', { id: 'x' })
  h.flush()
  assert.notEqual(h.client.last('setState')!.state, 'task', 'collapses rather than advancing')
  assert.notDeepEqual(h.calls.focus?.at(-1), ['y'], 'the voice is not handed to Y')
  h.controller.dispose()
})

test('an answer that lands mid-capture does not advance the open task', () => {
  let capturing = false
  const h = setup({ deps: { isCapturing: () => capturing } })
  h.controller.setAutoExpand(true)
  put(h, makeTask({ id: 'q', state: 'needs-user', name: 'Q', question: { text: 'Allow?', choices: ['Yes'] } }))
  put(h, makeTask({ id: 'y', state: 'needs-user', name: 'Y', question: { text: 'Other?' } }))
  assert.equal(h.client.last('showTask')!.task.id, 'q')
  capturing = true
  h.client.fire({ type: 'chooseOption', id: 'q', index: 0 } as unknown as NotchEvent)
  h.flush()
  assert.equal(h.client.last('showTask')!.task.id, 'q', 'still on the answered task')
  assert.deepEqual(h.calls.focus?.at(-1), ['q'], 'the voice did not jump to Y')
  h.controller.dispose()
})

test('leaving the app mid-capture keeps the open task until the capture ends', () => {
  let capturing = false
  const h = setup({ deps: { isCapturing: () => capturing } })
  expandX(h)
  capturing = true
  h.client.fire({ type: 'userLeft', reason: 'blur' } as unknown as NotchEvent)
  assertStillX(h, 'blur mid-capture')
  capturing = false
  h.controller.notifyCapturePhase('transcribing', null)
  assert.notEqual(h.client.last('setState')!.state, 'task', 'the held leave applies afterwards')
  h.controller.dispose()
})

/**
 * THE SCREEN MUST NOT OUTLIVE THE MODEL'S MEMORY WITHOUT SAYING SO. The Agent
 * chat kept every message across fresh provider sessions — a provider switch,
 * a rotation — so 130 messages read as one continuous conversation while the
 * model knew only its current session plus a short handoff (2026-09-16).
 */
test('the Agent chat opens on its current session, under a line saying where its memory begins', async () => {
  const h = setup({ deps: { agentInstalledProviders: async () => ['claude', 'codex'] } })
  const earlier = Array.from({ length: 6 }, (_, i) => ({ role: (i % 2 ? 'agent' : 'user') as 'agent' | 'user', text: `old ${i}`, at: 100 + i }))
  const current = [{ role: 'user' as const, text: 'new question', at: 5000 }, { role: 'agent' as const, text: 'new answer', at: 5001 }]
  h.controller.restoreAgentConversation({ selectedProvider: 'codex', record: { generation: 3, phase: 'ready', provider: 'codex', model: 'm', runId: 'r', effort: 'medium', ceiling: 20, accepted: [{ submissionId: 's', interactionId: 'i', acceptedAt: 5000 }], snapshotId: 's' }, snapshot: { generation: 3, chat: { runId: 'r', turns: [...earlier, ...current] }, draft: { text: '', revision: 0 }, queued: [], notice: 'Switched to Codex — new conversation' } })
  h.client.fire({ type: 'pocketOpen' }); h.client.fire({ type: 'pocketExpand' }); h.flush()
  await new Promise<void>(resolve => setImmediate(resolve))
  const task = h.client.last('showTask')!.task
  assert.deepEqual(task.blocks!.map(b => b.kind), ['sessionBoundary', 'message', 'message'], 'only the session the model remembers, under its divider')
  assert.match((task.blocks![0] as { text: string }).text, /switched to Codex/i)
  assert.match((task.blocks![0] as { text: string }).text, /remembers from here/i)
  assert.equal(task.olderMessages, 6, 'earlier sessions stay reachable')
  h.client.fire({ type: 'loadOlderMessages', id: 'unmute-agent' } as never); h.flush()
  const all = h.client.last('showTask')!.task
  assert.equal(all.olderMessages, 0)
  assert.deepEqual(all.blocks!.map(b => b.kind), [...earlier.map(() => 'message'), 'sessionBoundary', 'message', 'message'])
})

test('an Agent chat with no earlier session shows no divider', async () => {
  const h = setup({ deps: { agentInstalledProviders: async () => ['claude'] } })
  h.controller.restoreAgentConversation({ selectedProvider: 'claude', record: { generation: 1, phase: 'ready', provider: 'claude', model: 'm', runId: 'r', effort: 'medium', ceiling: 20, accepted: [{ submissionId: 's', interactionId: 'i', acceptedAt: 10 }], snapshotId: 's' }, snapshot: { generation: 1, chat: { runId: 'r', turns: [{ role: 'user', text: 'hi', at: 10 }, { role: 'agent', text: 'hello', at: 11 }] }, draft: { text: '', revision: 0 }, queued: [] } })
  h.client.fire({ type: 'pocketOpen' }); h.client.fire({ type: 'pocketExpand' }); h.flush()
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.deepEqual(h.client.last('showTask')!.task.blocks!.map(b => b.kind), ['message', 'message'])
})

// A REATTACHED CHANNEL IS A TAIL, AND THE CARD MUST NOT CALL IT THE WHOLE CHAT.
// After a relaunch the channel replays only the daemon's recent events, so
// `blocks` holds one turn while the durable frame file holds hundreds. The
// window's own count is computed over the loaded blocks, so it says 0 older —
// which hides the one control that could fetch the rest, and the conversation
// is stranded at its last reply with no way back. Unknown-but-more is -1.
test('a non-durable tail reports older messages as unknown rather than none', () => {
  const h = setup()
  put(h, makeTask({ id: 'tail', kind: 'session', history: { phase: 'ready' },
    blocks: [{ kind: 'message', role: 'user', text: 'the only turn the daemon still held' },
             { kind: 'message', role: 'assistant', text: 'the last reply' }] }))
  h.client.fire({ type: 'focusTask', id: 'tail' }); h.flush()
  assert.equal(h.client.last('stageDetail')!.task.olderMessages, -1)
})

test('a durable history under one page reports no older messages', () => {
  const h = setup()
  put(h, makeTask({ id: 'whole', kind: 'session', history: { phase: 'ready' }, blocksDurable: true,
    blocks: [{ kind: 'message', role: 'user', text: 'all of it' },
             { kind: 'message', role: 'assistant', text: 'really all of it' }] }))
  h.client.fire({ type: 'focusTask', id: 'whole' }); h.flush()
  assert.equal(h.client.last('stageDetail')!.task.olderMessages, 0)
})

// The suspended-tail case is `ready` AND incomplete, so gating the fetch on the
// phase alone widened a one-turn array and returned nothing.
test('load earlier fetches durable history for a ready but non-durable card', async () => {
  const loads: Array<[string, boolean | undefined]> = []
  const h = setup({ deps: { loadBlocks: async (id, retry) => { loads.push([id, retry]) } } })
  put(h, makeTask({ id: 'tail-ready', kind: 'session', history: { phase: 'ready' },
    blocks: [{ kind: 'message', role: 'user', text: 'one turn' },
             { kind: 'message', role: 'assistant', text: 'one reply' }] }))
  h.client.fire({ type: 'focusTask', id: 'tail-ready' }); h.flush()
  loads.length = 0
  h.client.fire({ type: 'loadOlderMessages', id: 'tail-ready' }); h.flush()
  await Promise.resolve()
  assert.deepEqual(loads, [['tail-ready', true]])
})

// ── REMOVE FROM POCKET (replaces the Shelf) ────────────────────────────────
//
// Two places: the pocket (what is in front of you) and the orchestrator (all
// of it). Removing a card touches the first only; it comes back when it needs
// you, is opened, or is sent input — and never by stealing the screen.

test('remove from pocket takes the card out of the pocket and leaves it on the wall', async () => {
  const h = setup()
  put(h, makeTask({ id: 'r', state: 'processing', kind: 'session', name: 'Keep going', group: 'unmute' }))
  h.client.fire({ type: 'pocketOpen' }); h.flush()
  assert.ok(taskSlots(h).some((sl) => sl.id === 'r'), 'in the pocket to begin with')

  h.client.fire({ type: 'removeFromPocket', id: 'r' }); h.flush()
  assert.deepEqual(h.calls.setInPocket?.at(-1), ['r', false])
  assert.equal(h.calls.kill, undefined, 'nothing is stopped')
  assert.equal(h.calls.remove, undefined, 'nothing is deleted')
  assert.ok(!taskSlots(h).some((sl) => sl.id === 'r'), 'out of the pocket')

  h.client.fire({ type: 'openDashboard' })
  await new Promise((r) => setTimeout(r, 10))
  h.flush()
  const cp: CockpitPayload = h.client.last('setCockpit')!.data
  assert.ok(cp.groups.flatMap((g) => g.cards).some((c) => c.id === 'r'), 'still an ordinary card on the wall')
})

test('a removed card returns to the pocket when it newly needs you', () => {
  const h = setup()
  put(h, makeTask({ id: 'r', state: 'processing', pocketRemoved: true }))
  h.client.fire({ type: 'pocketOpen' }); h.flush()
  assert.ok(!taskSlots(h).some((sl) => sl.id === 'r'))

  put(h, { ...h.tasks.get('r')!, state: 'needs-user', question: { text: 'Allow?' } })
  assert.deepEqual(h.calls.setInPocket?.at(-1), ['r', true], 'the flag is cleared at the source')
  const slot = taskSlots(h).find((sl) => sl.id === 'r')
  assert.ok(slot, 'back in the pocket')
  assert.equal(slot!.demanding, true)
})

test('a removed card returns on a fresh failure, but not on a stop you made', () => {
  const h = setup()
  put(h, makeTask({ id: 'broke', state: 'processing', pocketRemoved: true }))
  put(h, makeTask({ id: 'stopped', state: 'processing', pocketRemoved: true }))
  put(h, { ...h.tasks.get('broke')!, state: 'failed', error: { reason: 'Claude exited unexpectedly' } })
  put(h, { ...h.tasks.get('stopped')!, state: 'failed', error: { reason: 'Stopped (kill all)' } })
  assert.deepEqual(h.calls.setInPocket, [['broke', true]])
})

test('quiet progress does not bring a removed card back', () => {
  const h = setup()
  put(h, makeTask({ id: 'r', state: 'processing', kind: 'session', pocketRemoved: true }))
  // A thread finishing its turn: demanding for a card in the pocket, but not
  // a reason to undo "remove from pocket".
  put(h, { ...h.tasks.get('r')!, state: 'done', updatedAt: Date.now() + 1000 })
  put(h, { ...h.tasks.get('r')!, state: 'processing', step: 'Reading files' })
  assert.equal(h.calls.setInPocket, undefined)
  h.client.fire({ type: 'pocketOpen' }); h.flush()
  assert.ok(!taskSlots(h).some((sl) => sl.id === 'r'))
  assert.equal(h.client.last('setState')!.attention, 0, 'and it does not count as waiting')
})

test('a card removed while it was waiting stays removed across a restore', () => {
  const h = setup()
  // First sighting (a relaunch): not a transition, so not news.
  put(h, makeTask({ id: 'r', state: 'needs-user', pocketRemoved: true, question: { text: 'q' } }))
  assert.equal(h.calls.setInPocket, undefined)
  h.client.fire({ type: 'pocketOpen' }); h.flush()
  assert.ok(!taskSlots(h).some((sl) => sl.id === 'r'))
})

test('a removed card returning on demand never replaces the task you have open', () => {
  const h = setup()
  h.controller.setAutoExpand(true)
  put(h, makeTask({ id: 'r', state: 'processing', name: 'R', pocketRemoved: true }))
  expandX(h)
  put(h, { ...h.tasks.get('r')!, state: 'needs-user', question: { text: 'Allow?' }, lastUserInputAt: Date.now() + 5000 })
  assertStillX(h, 'removed card returned')
  assert.deepEqual(h.calls.setInPocket?.at(-1), ['r', true], 'it did return — it just joined the list')
})

test('opening a removed card puts it back: wall click, link tap', () => {
  const h = setup()
  put(h, makeTask({ id: 'a', state: 'processing', kind: 'session', pocketRemoved: true }))
  put(h, makeTask({ id: 'b', state: 'processing', kind: 'session', pocketRemoved: true }))
  h.client.fire({ type: 'focusTask', id: 'a' })
  assert.deepEqual(h.calls.setInPocket?.at(-1), ['a', true])
  h.client.fire({ type: 'pocketFocusTask', id: 'b' })
  assert.deepEqual(h.calls.setInPocket?.at(-1), ['b', true])
  assert.equal(h.client.last('showTask')?.task.id, 'b', 'the link lands on the card, in the pocket')
})
