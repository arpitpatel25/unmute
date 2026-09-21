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

test('Continue may skip an exercise but cannot fake a permission or provider check', () => {
  const skipEventFor = (chapters as unknown as {
    skipEventFor(command: ReturnType<typeof presenterSnapshot>): unknown
  }).skipEventFor

  assert.deepEqual(skipEventFor(presenterSnapshot('notes-dictation')), {
    type: 'capability-satisfied', action: 'notes-dictation',
  })
  assert.equal(skipEventFor(presenterSnapshot('microphone')), null)
  assert.equal(skipEventFor(presenterSnapshot('provider-choice')), null)
  assert.equal(skipEventFor(presenterSnapshot('notes-dictation', { started: true, stopped: false })), null)
  const recording = (presenterSnapshot as unknown as (
    action: 'notetaker-save', gesture: undefined, notetakerActive: boolean,
  ) => ReturnType<typeof presenterSnapshot>)('notetaker-save', undefined, true)
  assert.equal(recording.phase, 'listening')
  assert.equal(skipEventFor(recording), null)
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
    setBounds: () => undefined,
    isDestroyed: () => false,
    destroy: () => undefined,
    markReady: () => ready?.(),
  }
  return window
}
