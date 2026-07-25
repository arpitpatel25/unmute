import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import {
  NotchController, classify, relativeAge,
  type TaskLite, type NotchClientLike, type NotchControllerDeps, type ProposalLite,
} from './notch-controller'
import type { NotchCommand, NotchEvent, CockpitPayload } from './notch-client'

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

interface Harness {
  events: EventEmitter
  client: FakeClient
  controller: NotchController
  tasks: Map<string, TaskLite>
  calls: Record<string, unknown[][]>
  flush(): void
}

function makeTask(partial: Partial<TaskLite> & { id: string }): TaskLite {
  return {
    intent: 'do the thing', state: 'processing', kind: 'oneoff', alive: true,
    createdAt: Date.now() - 60_000, updatedAt: Date.now(), ...partial,
  }
}

function setup(opts: { proposals?: ProposalLite[] } = {}): Harness {
  const events = new EventEmitter()
  const client = new FakeClient()
  const tasks = new Map<string, TaskLite>()
  const calls: Record<string, unknown[][]> = {}
  const rec = (name: string) => (...args: unknown[]) => { (calls[name] ??= []).push(args) }
  let doorbell = true
  let lastSeen = Date.now()
  const deps: NotchControllerDeps = {
    listTasks: () => [...tasks.values()],
    getTask: (id) => tasks.get(id),
    answer: rec('answer'),
    kill: rec('kill'),
    remove: rec('remove'),
    killAll: rec('killAll'),
    resume: (id) => { rec('resume')(id); return true },
    rerun: rec('rerun'),
    setKind: rec('setKind'),
    setName: rec('setName'),
    setShelved: rec('setShelved'),
    setNote: rec('setNote'),
    focus: rec('focus'),
    getOutput: (id) => `replay:${id}`,
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
    getStagedCount: () => 2,
    clearStaged: rec('clearStaged'),
    getLastSeen: () => lastSeen,
    setLastSeen: (ms) => { lastSeen = ms },
  }
  const controller = new NotchController(client, events, deps)
  // reconcile is debounced 80ms — tests force it synchronously by re-firing.
  const flush = () => { (controller as unknown as { reconcile(): void }).reconcile() }
  return { events, client, controller, tasks, calls, flush }
}

function put(h: Harness, t: TaskLite): void {
  h.tasks.set(t.id, t)
  h.events.emit('updated', t)
  h.flush()
}

// ── basics ──────────────────────────────────────────────────────────────────

test('classify maps only your-move states', () => {
  assert.equal(classify('needs-user'), 'needs-user')
  assert.equal(classify('stuck'), 'stuck')
  assert.equal(classify('failed'), 'errored')
  assert.equal(classify('ready'), 'ready')
  assert.equal(classify('processing'), null)
  assert.equal(classify('done'), null)
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

// ── gestures ────────────────────────────────────────────────────────────────

test('tap with a front task → task surface + focus; tap idle → cockpit', () => {
  const h = setup()
  put(h, makeTask({ id: 't1', state: 'ready' }))
  h.client.fire({ type: 'tap' })
  assert.equal(h.client.last('setState')!.state, 'task')
  assert.deepEqual(h.calls.focus?.at(-1), ['t1'])

  const h2 = setup()
  h2.client.fire({ type: 'tap' })
  assert.equal(h2.client.last('setState')!.state, 'cockpit')
  assert.ok(h2.client.last('setCockpit'))
})

test('next = skip requeues front to the back', () => {
  const h = setup()
  put(h, makeTask({ id: 'a', state: 'ready', name: 'A' }))
  put(h, makeTask({ id: 'b', state: 'needs-user', name: 'B', question: { text: 'q' } }))
  h.client.fire({ type: 'tap' })
  const first = h.client.last('showTask')!.task.id
  h.client.fire({ type: 'next' })
  const second = h.client.last('showTask')!.task.id
  assert.notEqual(first, second)
  h.client.fire({ type: 'next' })
  assert.equal(h.client.last('showTask')!.task.id, first) // came back around
})

test('prev cranks backward (reverse rotation of next)', () => {
  const h = setup()
  put(h, makeTask({ id: 'a', state: 'ready', name: 'A' }))
  put(h, makeTask({ id: 'b', state: 'needs-user', name: 'B', question: { text: 'q' } }))
  put(h, makeTask({ id: 'c', state: 'ready', name: 'C' }))
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
  h.client.fire({ type: 'shelve', id: 't1', shelved: true })
  h.client.fire({ type: 'rename', id: 't1', name: 'better name' })
  h.client.fire({ type: 'setNote', id: 't1', note: 'JIRA-42' })
  assert.deepEqual(h.calls.kill?.[0], ['t1'])
  assert.deepEqual(h.calls.resume?.[0], ['t1'])
  assert.deepEqual(h.calls.rerun?.[0], ['orig intent'])
  assert.deepEqual(h.calls.remove?.[0], ['t1'])
  assert.equal(h.calls.killAll?.length, 1)
  assert.deepEqual(h.calls.setKind?.[0], ['t1', 'session'])
  assert.deepEqual(h.calls.setShelved?.[0], ['t1', true])
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

test('termInput decodes base64 to PTY stdin; termResize passes through', () => {
  const h = setup()
  h.client.fire({ type: 'termInput', id: 't1', data: Buffer.from('ls\r').toString('base64') })
  assert.deepEqual(h.calls.sendInput?.[0], ['t1', 'ls\r'])
  h.client.fire({ type: 'termResize', id: 't1', cols: 120, rows: 34 })
  assert.deepEqual(h.calls.resizeTerm?.[0], ['t1', 120, 34])
})

// ── skills / rails ──────────────────────────────────────────────────────────

test('tapSkill without a focused live task → toast guard; with one → types', () => {
  const h = setup()
  h.client.fire({ type: 'tapSkill', name: 'gmail-sweep' })
  assert.ok(h.client.last('toast')!.text.includes('focus a live task'))
  put(h, makeTask({ id: 't1', state: 'needs-user', alive: true, question: { text: 'q' } }))
  h.client.fire({ type: 'focusTask', id: 't1' })
  h.client.fire({ type: 'tapSkill', name: 'gmail-sweep' })
  assert.deepEqual(h.calls.tapSkill?.[0], ['t1', 'gmail-sweep'])
})

test('openDashboard builds the full cockpit payload', async () => {
  const h = setup()
  const old = Date.now() - 30 * 60 * 1000
  put(h, makeTask({ id: 's1', state: 'processing', kind: 'session', name: 'Notch UI', group: 'unmute', cwd: `${process.env.HOME}/tools/x` }))
  put(h, makeTask({ id: 'o1', state: 'done', kind: 'oneoff', name: 'Old done', updatedAt: old, alive: false }))
  put(h, makeTask({ id: 'sh1', state: 'ready', kind: 'session', name: 'Shelved thing', shelved: true }))
  h.client.fire({ type: 'openDashboard' })
  await new Promise((r) => setTimeout(r, 10)) // rails are async
  h.flush()
  const cp: CockpitPayload = h.client.last('setCockpit')!.data
  // groups: named first, shelved excluded, faded done excluded
  assert.ok(cp.groups.some((g) => g.name === 'unmute' && g.cards.some((c) => c.id === 's1')))
  assert.ok(!cp.groups.flatMap((g) => g.cards).some((c) => c.id === 'o1')) // done >15m → faded
  assert.ok(!cp.groups.flatMap((g) => g.cards).some((c) => c.id === 'sh1'))
  assert.deepEqual(cp.shelf, [{ id: 'sh1', name: 'Shelved thing' }])
  // rails
  assert.equal(cp.skills.length, 1)
  assert.equal(cp.unmuteSkills.length, 1)
  assert.equal(cp.projects[0].name, 'unmute-cloud')
  assert.equal(cp.stagedCount, 2)
  assert.equal(cp.doorbell, true)
  assert.equal(cp.tmuxAvailable, true)
  // queue: only your-move, unshelved
  assert.ok(!cp.queue.some((q) => q.id === 'sh1'))
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

test('a ready task older than 6h leaves the crank (cockpit only); blocked never ages out', async () => {
  const h = setup()
  const old = Date.now() - 7 * 60 * 60 * 1000
  put(h, makeTask({ id: 'stale', state: 'ready', kind: 'session', name: 'Old ready', updatedAt: old }))
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

test('a fresh ready task IS in the crank', () => {
  const h = setup()
  put(h, makeTask({ id: 'fresh', state: 'ready', updatedAt: Date.now() - 60_000 }))
  assert.equal(h.client.last('setState')!.state, 'attention')
})

test('mute drops a task from attention until its state changes', () => {
  const h = setup()
  put(h, makeTask({ id: 't1', state: 'ready', name: 'Parked' }))
  assert.equal(h.client.last('setState')!.state, 'attention')
  h.client.fire({ type: 'mute', id: 't1' })
  assert.equal(h.client.last('setState')!.state, 'dormant') // nothing else waiting
  // still muted on a same-state update
  h.events.emit('updated', h.tasks.get('t1')); h.flush()
  assert.equal(h.client.last('setState')!.state, 'dormant')
  // state CHANGE ends the episode: back to work, then ready again → re-enters
  h.tasks.set('t1', makeTask({ id: 't1', state: 'processing', name: 'Parked' }))
  h.events.emit('updated', h.tasks.get('t1')); h.flush()
  h.tasks.set('t1', makeTask({ id: 't1', state: 'ready', name: 'Parked' }))
  h.events.emit('ready', h.tasks.get('t1')); h.flush()
  assert.equal(h.client.last('setState')!.state, 'attention')
})

test('interacting with a muted task (focus) ends its mute episode', () => {
  const h = setup()
  put(h, makeTask({ id: 't1', state: 'ready', name: 'Parked' }))
  h.client.fire({ type: 'mute', id: 't1' })
  assert.equal(h.client.last('setState')!.state, 'dormant')
  h.client.fire({ type: 'focusTask', id: 't1' }) // user opened it in the cockpit
  h.flush()
  assert.equal(h.client.last('setState')!.state, 'cockpit')
  h.client.fire({ type: 'collapsed' }) // back to baseline → it queues again
  assert.equal(h.client.last('setState')!.state, 'attention')
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
