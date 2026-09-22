import assert from 'node:assert/strict'
import test from 'node:test'

import * as chapters from './chapters'
import { PresenterWindow, presenterBounds } from './presenter-window'

const { presenterSnapshot } = chapters

test('presenter is a compact transparent utility surface, not a full-screen page', () => {
  const created: Record<string, unknown>[] = []
  const presenter = new PresenterWindow({
    create: (options) => {
      created.push(options)
      return fakeWindow()
    },
    routeUrl: () => 'file:///app/index.html#/onboarding-presenter',
    displayWorkArea: () => ({ x: 0, y: 0, width: 1440, height: 900 }),
  })

  presenter.show()

  assert.equal(created[0].transparent, true)
  assert.equal(created[0].frame, false)
  assert.ok(Number(created[0].width) < 600)
  assert.ok(Number(created[0].height) < 760)
})

test('presenter leaves enough vertical room for task recovery controls', () => {
  const created: Record<string, unknown>[] = []
  const presenter = new PresenterWindow({
    create: options => { created.push(options); return fakeWindow() },
    routeUrl: () => 'file:///app/index.html#/onboarding-presenter',
    displayWorkArea: () => ({ x: 0, y: 0, width: 1440, height: 900 }),
  })

  presenter.show()

  assert.ok(Number(created[0].height) >= 740)
})

test('presenter placement stays clear of the physical notch', () => {
  const bounds = presenterBounds({ x: 0, y: 0, width: 1512, height: 982 }, { width: 432, height: 650 })
  assert.ok(bounds.y >= 76)
  assert.ok(bounds.x > 0)
})

test('presenter snapshots describe progress through the visible journey', () => {
  const first = presenterSnapshot('welcome') as unknown as { step: number; totalSteps: number }
  const task = presenterSnapshot('orchestrator-task') as unknown as { step: number; totalSteps: number }

  assert.deepEqual(first, { ...first, step: 1, totalSteps: 16 })
  assert.equal(task.step, 11)
  assert.equal(task.totalSteps, 16)
})

test('Skip section advances every visible section without pretending its capability succeeded', () => {
  const skipEventFor = (chapters as unknown as {
    skipEventFor(command: ReturnType<typeof presenterSnapshot>): unknown
  }).skipEventFor

  assert.deepEqual(skipEventFor(presenterSnapshot('notes-dictation')), {
    type: 'section-skipped', action: 'notes-dictation',
  })
  assert.deepEqual(skipEventFor(presenterSnapshot('microphone')), {
    type: 'section-skipped', action: 'microphone',
  })
  assert.deepEqual(skipEventFor(presenterSnapshot('provider-choice')), {
    type: 'section-skipped', action: 'provider-choice',
  })
  assert.deepEqual(skipEventFor(presenterSnapshot('orchestrator-task', { started: true, stopped: true })), {
    type: 'section-skipped', action: 'orchestrator-task',
  })
  const recording = (presenterSnapshot as unknown as (
    action: 'notetaker-save', gesture: undefined, notetakerActive: boolean,
  ) => ReturnType<typeof presenterSnapshot>)('notetaker-save', undefined, true)
  assert.deepEqual(skipEventFor(recording), {
    type: 'section-skipped', action: 'notetaker-save',
  })
  assert.equal(skipEventFor(presenterSnapshot('complete')), null)
})

test('processing task copy says what was sent and that waiting is optional', () => {
  const orchestrator = presenterSnapshot('orchestrator-task', { started: true, stopped: true })
  const agent = presenterSnapshot('agent-task-link', { started: true, stopped: true })

  assert.equal(orchestrator.card?.detail, 'Request sent to Unmute. Your task is being processed. You can wait for it to finish or skip this section.')
  assert.equal(agent.card?.detail, 'Request sent to Unmute Agent. Your task is being processed. You can wait for it to finish or skip this section.')
})

test('Continue anyway escapes only stalled task exercises', () => {
  const escapeEventFor = (chapters as unknown as {
    escapeEventFor(command: ReturnType<typeof presenterSnapshot>): unknown
  }).escapeEventFor

  assert.deepEqual(escapeEventFor(presenterSnapshot('orchestrator-task', { started: true, stopped: true })), {
    type: 'capability-satisfied', action: 'orchestrator-task',
  })
  assert.deepEqual(escapeEventFor(presenterSnapshot('agent-task-link', { started: true, stopped: true })), {
    type: 'capability-satisfied', action: 'agent-task-link',
  })
  assert.equal(escapeEventFor(presenterSnapshot('notes-dictation', { started: true, stopped: true })), null)
  assert.equal(escapeEventFor(presenterSnapshot('microphone')), null)
})

test('snapshots are sent only after the presenter route is ready', () => {
  const sent: unknown[] = []
  const window = fakeWindow(sent)
  const presenter = new PresenterWindow({
    create: () => window,
    routeUrl: () => 'file:///app/index.html#/onboarding-presenter',
    displayWorkArea: () => ({ x: 0, y: 0, width: 1440, height: 900 }),
  })

  presenter.show()
  presenter.send(presenterSnapshot('privacy'))
  assert.equal(sent.length, 0)
  window.markReady()
  assert.equal(sent.length, 1)
})

test('presenter follows every Space, including full-screen apps', () => {
  const window = fakeWindow()
  const presenter = new PresenterWindow({
    create: () => window,
    routeUrl: () => 'file:///app/index.html#/onboarding-presenter',
    displayWorkArea: () => ({ x: 0, y: 0, width: 1440, height: 900 }),
  })

  presenter.show()

  assert.deepEqual(window.visibleOnAllWorkspaces, [true, { visibleOnFullScreen: true }])
  assert.deepEqual(window.alwaysOnTop, [true, 'screen-saver'])
})

test('hands-on presenter controls do not steal focus from the destination app', () => {
  const window = fakeWindow()
  const presenter = new PresenterWindow({
    create: () => window,
    routeUrl: () => 'file:///app/index.html#/onboarding-presenter',
    displayWorkArea: () => ({ x: 0, y: 0, width: 1440, height: 900 }),
  })

  presenter.show()
  window.markReady()
  presenter.send(presenterSnapshot('notes-dictation'))
  assert.equal(window.focusable.at(-1), false)

  presenter.send(presenterSnapshot('microphone'))
  assert.equal(window.focusable.at(-1), true)
})

test('whole-surface dragging moves the presenter and later shows keep that position', () => {
  const window = fakeWindow()
  const presenter = new PresenterWindow({
    create: () => window,
    routeUrl: () => 'file:///app/index.html#/onboarding-presenter',
    displayWorkArea: () => ({ x: 0, y: 0, width: 1440, height: 900 }),
  })

  presenter.show()
  const moveBy = (presenter as unknown as { moveBy?: (x: number, y: number) => void }).moveBy
  assert.equal(typeof moveBy, 'function')
  moveBy?.call(presenter, 40, 25)
  presenter.show()

  assert.deepEqual(window.bounds.at(-1), { x: 1020, y: 101, width: 432, height: 744 })
})

function fakeWindow(sent: unknown[] = []) {
  let ready: (() => void) | undefined
  const window = {
    visibleOnAllWorkspaces: undefined as unknown,
    alwaysOnTop: undefined as unknown,
    focusable: [] as boolean[],
    webContents: {
      send: (_channel: string, value: unknown) => { sent.push(value) },
      once: (_event: string, callback: () => void) => { ready = callback },
    },
    loadURL: async () => undefined,
    showInactive: () => undefined,
    setVisibleOnAllWorkspaces: (...args: unknown[]) => { window.visibleOnAllWorkspaces = args },
    setAlwaysOnTop: (...args: unknown[]) => { window.alwaysOnTop = args },
    setFocusable: (value: boolean) => { window.focusable.push(value) },
    bounds: [] as Array<{ x: number; y: number; width: number; height: number }>,
    setBounds: (bounds: { x: number; y: number; width: number; height: number }) => { window.bounds.push(bounds) },
    isDestroyed: () => false,
    destroy: () => undefined,
    markReady: () => ready?.(),
  }
  return window
}
