import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import {
  NotchController, classify,
  type TaskLite, type NotchClientLike, type NotchControllerDeps,
} from './notch-controller'
import type { NotchCommand, NotchEvent, CockpitPayload } from './notch-client'

class FakeClient extends EventEmitter implements NotchClientLike {
  sent: NotchCommand[] = []
  send(cmd: NotchCommand): void { this.sent.push(cmd) }
  fire(evt: NotchEvent): void { this.emit(evt.type, evt) }
  last(type: NotchCommand['type']): NotchCommand | undefined {
    return [...this.sent].reverse().find((c) => c.type === type)
  }
}

interface Harness {
  events: EventEmitter
  client: FakeClient
  controller: NotchController
  tasks: Map<string, TaskLite>
  calls: { answer: Array<[string, string?]>; focus: string[]; cockpit: number }
  working: { n: number }
}

const EMPTY_COCKPIT: CockpitPayload = { tasks: [], queue: [], projects: [], suggestions: [] }

function setup(): Harness {
  const events = new EventEmitter()
  const client = new FakeClient()
  const tasks = new Map<string, TaskLite>()
  const calls = { answer: [] as Array<[string, string?]>, focus: [] as string[], cockpit: 0 }
  const working = { n: 0 }
  const deps: NotchControllerDeps = {
    answer: (id, text) => calls.answer.push([id, text]),
    focus: (id) => calls.focus.push(id),
    countWorking: () => working.n,
    getTask: (id) => tasks.get(id),
    buildCockpit: () => { calls.cockpit++; return EMPTY_COCKPIT },
  }
  const controller = new NotchController(client, events, deps)
  return { events, client, controller, tasks, calls, working }
}

function put(h: Harness, t: TaskLite): void {
  h.tasks.set(t.id, t)
  h.events.emit(t.state === 'needs-user' ? 'needs-user' : t.state, t)
}
const setState = (c: FakeClient) => c.last('setState') as Extract<NotchCommand, { type: 'setState' }>
const showTask = (c: FakeClient) => c.last('showTask') as Extract<NotchCommand, { type: 'showTask' }>

test('classify maps only your-move states', () => {
  assert.equal(classify('needs-user'), 'needs-user')
  assert.equal(classify('stuck'), 'stuck')
  assert.equal(classify('failed'), 'errored')
  assert.equal(classify('ready'), 'ready')
  assert.equal(classify('processing'), null)
  assert.equal(classify('done'), null)
})

test('a your-move task surfaces as attention with its payload', () => {
  const h = setup()
  put(h, { id: 't1', intent: 'run the RCA on prod', state: 'needs-user', question: 'which service?' })
  assert.equal(showTask(h.client).task.id, 't1')
  assert.equal(showTask(h.client).task.summary, 'which service?')
  assert.equal(setState(h.client).state, 'attention')
  assert.equal(setState(h.client).attention, 1)
})

test('tapping attention opens the task surface and focuses the front task', () => {
  const h = setup()
  put(h, { id: 't1', intent: 'a', state: 'ready' })
  h.client.fire({ type: 'tap' })
  assert.deepEqual(h.calls.focus, ['t1'])
  assert.equal(setState(h.client).state, 'task')
})

test('tapping with nothing to attend opens the cockpit', () => {
  const h = setup()
  h.working.n = 1
  h.tasks.set('w', { id: 'w', intent: 'x', state: 'processing' })
  h.events.emit('updated', h.tasks.get('w')) // baseline = active
  h.client.fire({ type: 'tap' })
  assert.equal(setState(h.client).state, 'cockpit')
  assert.ok(h.calls.cockpit >= 1)
})

test('next requeues the front task to the back (skip)', () => {
  const h = setup()
  put(h, { id: 'a', intent: 'a', state: 'ready' })
  put(h, { id: 'b', intent: 'b', state: 'needs-user' })
  h.client.fire({ type: 'tap' })
  assert.equal(showTask(h.client).task.id, 'a')
  h.client.fire({ type: 'next' })
  assert.equal(showTask(h.client).task.id, 'b')
  h.client.fire({ type: 'next' })
  assert.equal(showTask(h.client).task.id, 'a')
})

test('chooseOption answers the front task with the option label', () => {
  const h = setup()
  put(h, { id: 't1', intent: 'a', state: 'needs-user', options: ['Yes', 'No'] })
  h.client.fire({ type: 'tap' })
  h.client.fire({ type: 'chooseOption', index: 1 })
  assert.deepEqual(h.calls.answer, [['t1', 'No']])
})

test('a task leaving your-move drops it; empty + idle ⇒ dormant', () => {
  const h = setup()
  put(h, { id: 't1', intent: 'a', state: 'needs-user' })
  h.tasks.set('t1', { id: 't1', intent: 'a', state: 'processing' })
  h.events.emit('updated', h.tasks.get('t1'))
  assert.equal(setState(h.client).state, 'dormant')
})

test('done removes from the queue (done is not your-move)', () => {
  const h = setup()
  put(h, { id: 't1', intent: 'a', state: 'ready' })
  h.tasks.set('t1', { id: 't1', intent: 'a', state: 'done' })
  h.events.emit('done', h.tasks.get('t1'))
  assert.equal(setState(h.client).state, 'dormant')
})

test('openDashboard shows the cockpit with a dataset', () => {
  const h = setup()
  h.client.fire({ type: 'openDashboard' })
  assert.equal(setState(h.client).state, 'cockpit')
  assert.ok(h.client.last('setCockpit'))
  assert.ok(h.calls.cockpit >= 1)
})

test('collapsed returns to attention while items remain', () => {
  const h = setup()
  put(h, { id: 't1', intent: 'a', state: 'ready' })
  h.client.fire({ type: 'tap' })
  assert.equal(setState(h.client).state, 'task')
  h.client.fire({ type: 'collapsed' })
  assert.equal(setState(h.client).state, 'attention')
})

test('active reflects the working count when nothing needs you', () => {
  const h = setup()
  h.working.n = 3
  h.tasks.set('w', { id: 'w', intent: 'x', state: 'processing' })
  h.events.emit('updated', h.tasks.get('w'))
  const s = setState(h.client)
  assert.equal(s.state, 'active')
  assert.equal(s.working, 3)
})
