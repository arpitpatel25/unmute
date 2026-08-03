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
    getLastSeen: () => lastSeen,
    setLastSeen: (ms) => { lastSeen = ms },
    scratchpadArm: rec('scratchpadArm'),
    scratchpadRemove: rec('scratchpadRemove'),
    scratchpadDeliver: rec('scratchpadDeliver'),
    scratchpadDiscard: rec('scratchpadDiscard'),
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
  // projects + suggestions are GONE from the payload. Projects listed
  // directories with no action attached; Suggestions was the curator's review
  // inbox and the curator is parked, so it can never fill again. Asserted as
  // absent rather than deleted, so re-adding either is a test failure and not
  // a quiet regression.
  assert.equal((cp as Record<string, unknown>).projects, undefined)
  assert.equal((cp as Record<string, unknown>).suggestions, undefined)
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
  // ...and CLOSING it counts as having seen it, so a finished task does not
  // come straight back to nag. Seen-is-enough applies to `ready` only.
  h.client.fire({ type: 'collapsed' })
  assert.equal(h.client.last('setState')!.state, 'dormant')
})

test('opening then closing a BLOCKED task leaves it in attention — it still needs you', () => {
  // Seen-is-enough must not silently drop a task that is genuinely waiting on
  // an answer; only an explicit mute does that.
  const h = setup()
  put(h, makeTask({ id: 'b1', state: 'needs-user', alive: true, question: { text: 'q' } }))
  h.client.fire({ type: 'focusTask', id: 'b1' })
  h.flush()
  h.client.fire({ type: 'collapsed' })
  assert.equal(h.client.last('setState')!.state, 'attention')
})

test('a blocked task CAN still be hidden, but only by asking for it', () => {
  // "even for blocked tasks there should be a way for users to hide it — even
  // from the next queue as well."
  const h = setup()
  put(h, makeTask({ id: 'b1', state: 'needs-user', alive: true, question: { text: 'q' } }))
  h.client.fire({ type: 'mute', id: 'b1' })
  assert.equal(h.client.last('setState')!.state, 'dormant')
  h.client.fire({ type: 'next' })   // the crank must skip it too
  assert.notEqual(h.client.last('setState')!.state, 'task')
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
  put(h, makeTask({ id: 'c1', state: 'ready', agent: 'codex-desktop', codexThreadId: 'th', alive: false }))
  h.client.fire({ type: 'focusTask', id: 'c1' })
  h.flush()
  const detail = h.client.last('stageDetail')!.task
  assert.equal(detail.alive, true)
  assert.equal(detail.backend, 'codex-desktop')
})

test('the wall carries the backend, so a card can offer "open in Codex"', () => {
  const h = setup()
  put(h, makeTask({ id: 'c1', state: 'ready', agent: 'codex-desktop', codexThreadId: 'th' }))
  put(h, makeTask({ id: 'k1', state: 'ready' }))
  h.client.fire({ type: 'openDashboard' })
  const cards = h.client.last('setCockpit')!.data.groups.flatMap((g) => g.cards)
  assert.equal(cards.find((c) => c.id === 'c1')!.backend, 'codex-desktop')
  assert.equal(cards.find((c) => c.id === 'k1')!.backend, undefined)
})

test('the transcript reaches the surface as items, not one flattened blob', () => {
  const h = setup()
  put(h, makeTask({
    id: 'c1', state: 'ready', agent: 'codex-desktop', codexThreadId: 'th',
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
  put(h, makeTask({ id: 'c1', state: 'ready', agent: 'codex-desktop', codexThreadId: 'th' }))
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
    id: 'c1', state: 'ready', agent: 'codex-desktop', codexThreadId: 'th',
    deliveryError: 'Could not find that chat in Codex',
  }))
  h.client.fire({ type: 'focusTask', id: 'c1' })
  h.flush()
  const d = h.client.last('stageDetail')!.task
  assert.equal(d.deliveryError, 'Could not find that chat in Codex')
  assert.equal(d.status, 'ready', 'the task itself is untouched')
})

test('the WHOLE conversation reaches the surface, not a tail', () => {
  // The parse layer used to cut to 6 items and the windows here were all
  // downstream of that, so widening them did nothing. A 40-item thread must
  // arrive whole — without the user's own messages there is no alternation and
  // the panel does not read as a chat at all.
  const conversation = Array.from({ length: 40 }, (_, i) => ({
    role: i % 2 === 0 ? 'user' as const : 'assistant' as const, text: `m${i}`,
  }))
  const h = setup()
  put(h, makeTask({ id: 'c1', state: 'ready', agent: 'codex-desktop', codexThreadId: 'th', conversation }))
  h.client.fire({ type: 'focusTask', id: 'c1' })
  h.flush()
  const conv = h.client.last('stageDetail')!.task.conversation!
  assert.equal(conv.length, 40)
  assert.equal(conv[0].text, 'm0', 'the FIRST message survives, not just the tail')
})

test('an unchanged transcript is not re-sent on every poll', () => {
  // A full transcript is ~32KB and reconcile fires on each poll; re-sending an
  // identical payload put that on the wire over and over for a thread that had
  // not moved.
  const h = setup()
  put(h, makeTask({
    id: 'c1', state: 'ready', agent: 'codex-desktop', codexThreadId: 'th',
    conversation: [{ role: 'assistant', text: 'done' }],
  }))
  h.client.fire({ type: 'focusTask', id: 'c1' })
  h.flush()
  const sent = () => h.client.ofType('stageDetail').length
  const first = sent()
  h.flush(); h.flush()
  assert.equal(sent(), first, 'nothing changed → nothing sent')

  put(h, makeTask({
    id: 'c1', state: 'ready', agent: 'codex-desktop', codexThreadId: 'th',
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
  put(h, makeTask({ id: 'c1', state: 'ready', agent: 'codex-desktop', codexThreadId: 'th' }))
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
  put(h, makeTask({ id: 'stale-ready', state: 'ready', kind: 'session', group: 'g', updatedAt: Date.now() - 15 * day }))
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
  put(h, makeTask({ id: 'grouped', state: 'ready', kind: 'session', group: 'Unmute', updatedAt: Date.now() - 40 * hour }))
  put(h, makeTask({ id: 'loose', state: 'ready', kind: 'session', updatedAt: Date.now() - 1 * hour }))
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
    id: 'c1', state: 'ready', agent: 'codex-desktop', codexThreadId: 'th',
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
  put(h, makeTask({ id: 'c1', state: 'ready', agent: 'codex-desktop', codexThreadId: 'th' }))
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
    id: 'c1', state: 'ready', agent: 'codex-desktop', codexThreadId: 'th',
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
    id: 'cd1', state: 'ready', agent: 'claude-code-desktop',
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
  put(h, makeTask({ id: 'cd2', state: 'ready', agent: 'claude-code-desktop', alive: false }))
  h.client.fire({ type: 'focusTask', id: 'cd2' })
  h.flush()
  assert.equal(h.client.last('stageDetail')!.task.alive, true)
})

test('a PTY task is unaffected by the generalisation', () => {
  const h = setup()
  put(h, makeTask({ id: 'p1', state: 'ready', agent: 'claude', alive: false }))
  h.client.fire({ type: 'focusTask', id: 'p1' })
  h.flush()
  const d = h.client.last('stageDetail')!.task
  assert.equal(d.backend, undefined, 'a PTY backend names no backend')
  assert.equal(d.alive, false)
  assert.equal(d.conversation, undefined, 'and renders a terminal, not a conversation')
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

