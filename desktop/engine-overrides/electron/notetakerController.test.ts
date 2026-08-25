import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { NotetakerController } from './notetakerController'
import { NotetakerSession } from './notetakerSession'

function fakeSession(isActive = false) {
  const startCalls: number[] = []
  const stopCalls: number[] = []
  const session = {
    start: (pid: number) => startCalls.push(pid),
    stop: () => stopCalls.push(1),
    isActive,
  } as unknown as NotetakerSession
  return { session, startCalls, stopCalls }
}

/** Spread into every controller construction that isn't itself testing the
 *  key's undo-window behavior — those three deps are only exercised by the
 *  tests further down, and every other test just needs them to be no-ops. */
const noopStopDeps = {
  stopGraceMs: 10_000, // long enough that no timer in an unrelated test could ever fire
  onStopPendingChanged: () => {},
  onStopFinalized: () => {},
}

describe('NotetakerController', () => {
  test('a detected meeting start surfaces a notification, does not auto-start capture', () => {
    const { session, startCalls } = fakeSession()
    const notifications: string[] = []
    const controller = new NotetakerController({
      session,
      resolveTargetPid: () => 4242,
      showNotification: (opts) => notifications.push(opts.title),
      confirm: async () => true,
      ...noopStopDeps,
    })
    controller.onMeetingDetected()
    assert.deepEqual(notifications, ["Looks like you're in a meeting"])
    assert.equal(startCalls.length, 0) // detection prompts, it never auto-starts
  })

  // ADAPTED from the plan's sketch: onNotesStartRequested is async because
  // the real resolveTargetPid (native-ax over a worker thread) is async — see
  // notetakerController.ts's doc comment on NotetakerControllerDeps.
  test('chord double-tap start requested calls session.start with the resolved target pid', async () => {
    const { session, startCalls } = fakeSession()
    const controller = new NotetakerController({
      session,
      resolveTargetPid: () => 4242,
      showNotification: () => {},
      confirm: async () => true,
      ...noopStopDeps,
    })
    await controller.onNotesStartRequested()
    assert.deepEqual(startCalls, [4242])
  })

  test('resolveTargetPid may resolve asynchronously (matches the real native-ax bridge)', async () => {
    const { session, startCalls } = fakeSession()
    const controller = new NotetakerController({
      session,
      resolveTargetPid: async () => {
        await new Promise((r) => setTimeout(r, 0))
        return 777
      },
      showNotification: () => {},
      confirm: async () => true,
      ...noopStopDeps,
    })
    await controller.onNotesStartRequested()
    assert.deepEqual(startCalls, [777])
  })

  test('start requested with no resolvable target app shows a notification and never starts', async () => {
    const { session, startCalls } = fakeSession()
    const notifications: string[] = []
    const controller = new NotetakerController({
      session,
      resolveTargetPid: () => null,
      showNotification: (opts) => notifications.push(opts.title),
      confirm: async () => true,
      ...noopStopDeps,
    })
    await controller.onNotesStartRequested()
    assert.equal(startCalls.length, 0)
    assert.deepEqual(notifications, ['Notetaker'])
  })

  test('stop-confirm-requested calls confirm() and only stops if the user confirms', async () => {
    const { session, stopCalls } = fakeSession()
    let confirmCalls = 0
    const controller = new NotetakerController({
      session,
      resolveTargetPid: () => 4242,
      showNotification: () => {},
      confirm: async () => {
        confirmCalls++
        return true
      },
      ...noopStopDeps,
    })
    await controller.onNotesStopConfirmRequested()
    assert.equal(confirmCalls, 1)
    assert.deepEqual(stopCalls, [1])
  })

  test('declining the stop confirmation leaves the session running', async () => {
    const { session, stopCalls } = fakeSession()
    const controller = new NotetakerController({
      session,
      resolveTargetPid: () => 4242,
      showNotification: () => {},
      confirm: async () => false,
      ...noopStopDeps,
    })
    await controller.onNotesStopConfirmRequested()
    assert.equal(stopCalls.length, 0)
  })

  test('a detected meeting-ended does nothing while no session is active', async () => {
    const { session, stopCalls } = fakeSession(false)
    let confirmCalls = 0
    const controller = new NotetakerController({
      session,
      resolveTargetPid: () => 4242,
      showNotification: () => {},
      confirm: async () => {
        confirmCalls++
        return true
      },
      ...noopStopDeps,
    })
    await controller.onMeetingEnded()
    assert.equal(confirmCalls, 0)
    assert.equal(stopCalls.length, 0)
  })

  test('a detected meeting-ended drives the same confirm-to-stop prompt as the chord (spec §6)', async () => {
    const { session, stopCalls } = fakeSession(true)
    let confirmCalls = 0
    const controller = new NotetakerController({
      session,
      resolveTargetPid: () => 4242,
      showNotification: () => {},
      confirm: async () => {
        confirmCalls++
        return true
      },
      ...noopStopDeps,
    })
    await controller.onMeetingEnded()
    assert.equal(confirmCalls, 1)
    assert.deepEqual(stopCalls, [1])
  })

  // ─── The key's own single-tap stop: undo-window arm/cancel/finalize ───

  test('a single tap while active arms the undo window instead of stopping immediately', () => {
    const { session, stopCalls } = fakeSession(true)
    const pendingChanges: boolean[] = []
    const controller = new NotetakerController({
      session,
      resolveTargetPid: () => 4242,
      showNotification: () => {},
      confirm: async () => true,
      stopGraceMs: 10_000,
      onStopPendingChanged: (pending) => pendingChanges.push(pending),
      onStopFinalized: () => {},
    })
    controller.onNotesStopRequested()
    assert.deepEqual(pendingChanges, [true])
    assert.equal(stopCalls.length, 0) // not stopped yet — still inside the window
    assert.equal(controller.isStopPending, true)
  })

  test('a second tap before the window elapses cancels the pending stop — session keeps running', () => {
    const { session, stopCalls } = fakeSession(true)
    const pendingChanges: boolean[] = []
    let finalizedCalls = 0
    const controller = new NotetakerController({
      session,
      resolveTargetPid: () => 4242,
      showNotification: () => {},
      confirm: async () => true,
      stopGraceMs: 10_000,
      onStopPendingChanged: (pending) => pendingChanges.push(pending),
      onStopFinalized: () => { finalizedCalls++ },
    })
    controller.onNotesStopRequested() // arm
    controller.onNotesStopRequested() // cancel
    assert.deepEqual(pendingChanges, [true, false])
    assert.equal(stopCalls.length, 0)
    assert.equal(finalizedCalls, 0)
    assert.equal(controller.isStopPending, false)
  })

  test('letting the window elapse with no second tap finalizes the stop', async () => {
    const { session, stopCalls } = fakeSession(true)
    const pendingChanges: boolean[] = []
    let finalizedCalls = 0
    const controller = new NotetakerController({
      session,
      resolveTargetPid: () => 4242,
      showNotification: () => {},
      confirm: async () => true,
      stopGraceMs: 15,
      onStopPendingChanged: (pending) => pendingChanges.push(pending),
      onStopFinalized: () => { finalizedCalls++ },
    })
    controller.onNotesStopRequested()
    assert.equal(controller.isStopPending, true)
    await new Promise((r) => setTimeout(r, 40))
    assert.deepEqual(pendingChanges, [true, false])
    assert.deepEqual(stopCalls, [1])
    assert.equal(finalizedCalls, 1)
    assert.equal(controller.isStopPending, false)
  })

  test('a tap while no session is active does nothing (no timer, no callback)', () => {
    const { session, stopCalls } = fakeSession(false)
    const pendingChanges: boolean[] = []
    const controller = new NotetakerController({
      session,
      resolveTargetPid: () => 4242,
      showNotification: () => {},
      confirm: async () => true,
      stopGraceMs: 10_000,
      onStopPendingChanged: (pending) => pendingChanges.push(pending),
      onStopFinalized: () => {},
    })
    controller.onNotesStopRequested()
    assert.deepEqual(pendingChanges, [])
    assert.equal(stopCalls.length, 0)
    assert.equal(controller.isStopPending, false)
  })

  test('cancelPendingStop() is a no-op when nothing is armed', () => {
    const { session } = fakeSession(true)
    const pendingChanges: boolean[] = []
    const controller = new NotetakerController({
      session,
      resolveTargetPid: () => 4242,
      showNotification: () => {},
      confirm: async () => true,
      stopGraceMs: 10_000,
      onStopPendingChanged: (pending) => pendingChanges.push(pending),
      onStopFinalized: () => {},
    })
    controller.cancelPendingStop()
    assert.deepEqual(pendingChanges, [])
    assert.equal(controller.isStopPending, false)
  })

  test('cancelPendingStop() clears an armed window without stopping, e.g. before a defensive external stop', () => {
    const { session, stopCalls } = fakeSession(true)
    const pendingChanges: boolean[] = []
    let finalizedCalls = 0
    const controller = new NotetakerController({
      session,
      resolveTargetPid: () => 4242,
      showNotification: () => {},
      confirm: async () => true,
      stopGraceMs: 15,
      onStopPendingChanged: (pending) => pendingChanges.push(pending),
      onStopFinalized: () => { finalizedCalls++ },
    })
    controller.onNotesStopRequested() // arm
    controller.cancelPendingStop() // e.g. the widget's own Cancel fired mid-window
    assert.deepEqual(pendingChanges, [true, false])
    assert.equal(controller.isStopPending, false)
    // The cleared timer must never fire later.
    return new Promise((resolve) => {
      setTimeout(() => {
        assert.equal(stopCalls.length, 0)
        assert.equal(finalizedCalls, 0)
        resolve(undefined)
      }, 40)
    })
  })

  test('a detected meeting-ended clears any armed undo window before running its own confirm-to-stop', async () => {
    const { session, stopCalls } = fakeSession(true)
    const pendingChanges: boolean[] = []
    let confirmCalls = 0
    const controller = new NotetakerController({
      session,
      resolveTargetPid: () => 4242,
      showNotification: () => {},
      confirm: async () => {
        confirmCalls++
        return true
      },
      stopGraceMs: 10_000,
      onStopPendingChanged: (pending) => pendingChanges.push(pending),
      onStopFinalized: () => {},
    })
    controller.onNotesStopRequested() // key arms the undo window
    assert.equal(controller.isStopPending, true)
    await controller.onMeetingEnded() // detection fires before the window elapses
    assert.deepEqual(pendingChanges, [true, false]) // cleared, not left dangling
    assert.equal(confirmCalls, 1)
    assert.deepEqual(stopCalls, [1]) // stopped via the confirm path, exactly once
    assert.equal(controller.isStopPending, false)
  })
})
