import assert from 'node:assert/strict'
import test from 'node:test'

import { PresenterWindow, presenterBounds } from './presenter-window'
import { presenterSnapshot } from './chapters'

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

function fakeWindow(sent: unknown[] = []) {
  let ready: (() => void) | undefined
  return {
    webContents: {
      send: (_channel: string, value: unknown) => { sent.push(value) },
      once: (_event: string, callback: () => void) => { ready = callback },
    },
    loadURL: async () => undefined,
    showInactive: () => undefined,
    setBounds: () => undefined,
    isDestroyed: () => false,
    destroy: () => undefined,
    markReady: () => ready?.(),
  }
}
