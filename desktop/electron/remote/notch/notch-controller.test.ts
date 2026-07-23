import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import {
  NotchController, classify,
  type TaskLite, type NotchClientLike, type NotchControllerDeps,
} from './notch-controller'
import type { NotchCommand, NotchEvent } from './notch-client'

// A client double: records sent commands, and lets the test fire helper events.
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

function setup(): Harness {
  const events = new EventEmitter()
  const client = new FakeClient()
  const tasks = new Map<string, TaskLite>()
  const calls = { answer: [] as Array<[string, string?]>, focus: [] as string[], cockpit: 0 }
  const working = { n: 0 }
  const deps: NotchControllerDeps = {
    answer: (id, text) => calls.answer.push([id, text]),
    focus: (id) => calls.focus.push(id),
    showCockpit: () => { calls.cockpit++ },
    countWorking: () => working.n,
    getTask: (id) => tasks.get(id),
  }
  const controller = new NotchController(client, events, deps)
  return { events, client, controller, tasks, calls, working }
}

function put(h: Harness, t: TaskLite): void { h.tasks.set(t.id, t); h.events.emit(t.state === 'needs-user' ? 'needs-user' : t.state, t) }

test('classify maps only your-move states', () => {
  assert.equal(classify('needs-user'), 'needs-user')
  assert.equal(classify('stuck'), 'stuck')
  assert.equal(classify('failed'), 'errored')
  assert.equal(classify('ready'), 'ready')
  assert.equal(classify('processing'), null)
  assert.equal(classify('done'), null)
})

test('a your-move task peeks with its payload', () => {
  const h = setup()
  put(h, { id: 't1', intent: 'run the RCA on prod', state: 'needs-user', question: 'which service?' })

  const show = h.client.last('showTask') as Extract<NotchCommand, { type: 'showTask' }>
  const set = h.client.last('setState') as Extract<NotchCommand, { type: 'setState' }>
  assert.equal(show.task.id, 't1')
  assert.equal(show.task.state, 'needs-user')
  assert.equal(show.task.summary, 'which service?')
  assert.equal(set.state, 'peek')
  assert.equal(set.attention, 1)
})

test('tap opens the panel and focuses the front task', () => {
  const h = setup()
  put(h, { id: 't1', intent: 'a', state: 'ready' })
  h.client.fire({ type: 'tap' })

  assert.deepEqual(h.calls.focus, ['t1'])
  assert.equal((h.client.last('setState') as { state: string }).state, 'panel')
})

test('next requeues the front task to the back (skip)', () => {
  const h = setup()
  put(h, { id: 'a', intent: 'a', state: 'ready' })
  put(h, { id: 'b', intent: 'b', state: 'needs-user' })
  h.client.fire({ type: 'tap' }) // front = a
  assert.equal((h.client.last('showTask') as { task: { id: string } }).task.id, 'a')

  h.client.fire({ type: 'next' })
  assert.equal((h.client.last('showTask') as { task: { id: string } }).task.id, 'b')

  h.client.fire({ type: 'next' })
  assert.equal((h.client.last('showTask') as { task: { id: string } }).task.id, 'a') // came back around
})

test('chooseOption answers the front task with the option label', () => {
  const h = setup()
  put(h, { id: 't1', intent: 'a', state: 'needs-user', options: ['Yes', 'No'] })
  h.client.fire({ type: 'tap' })
  h.client.fire({ type: 'chooseOption', index: 1 })
  assert.deepEqual(h.calls.answer, [['t1', 'No']])
})

test('a task leaving your-move (→ processing) drops from the queue; empty ⇒ idle', () => {
  const h = setup()
  put(h, { id: 't1', intent: 'a', state: 'needs-user' })
  // The task is answered and starts working again:
  h.tasks.set('t1', { id: 't1', intent: 'a', state: 'processing' })
  h.events.emit('updated', h.tasks.get('t1'))

  const set = h.client.last('setState') as { state: string; attention: number }
  assert.equal(set.state, 'idle')
  assert.equal(set.attention, 0)
})

test('done removes from the queue (done is not your-move)', () => {
  const h = setup()
  put(h, { id: 't1', intent: 'a', state: 'ready' })
  h.tasks.set('t1', { id: 't1', intent: 'a', state: 'done' })
  h.events.emit('done', h.tasks.get('t1'))
  assert.equal((h.client.last('setState') as { state: string }).state, 'idle')
})

test('openDashboard asks Electron to show the cockpit', () => {
  const h = setup()
  h.client.fire({ type: 'openDashboard' })
  assert.equal(h.calls.cockpit, 1)
})

test('collapsed returns to peek while items remain', () => {
  const h = setup()
  put(h, { id: 't1', intent: 'a', state: 'ready' })
  h.client.fire({ type: 'tap' })
  assert.equal((h.client.last('setState') as { state: string }).state, 'panel')
  h.client.fire({ type: 'collapsed' })
  assert.equal((h.client.last('setState') as { state: string }).state, 'peek')
})

test('idle glow reflects the working count', () => {
  const h = setup()
  h.working.n = 3
  // No your-move tasks yet → a transition of a processing task keeps us idle.
  h.tasks.set('w', { id: 'w', intent: 'x', state: 'processing' })
  h.events.emit('updated', h.tasks.get('w'))
  const set = h.client.last('setState') as { state: string; working: number }
  assert.equal(set.state, 'idle')
  assert.equal(set.working, 3)
})
