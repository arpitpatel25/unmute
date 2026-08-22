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

describe('NotetakerController', () => {
  test('a detected meeting start surfaces a notification, does not auto-start capture', () => {
    const { session, startCalls } = fakeSession()
    const notifications: string[] = []
    const controller = new NotetakerController({
      session,
      resolveTargetPid: () => 4242,
      showNotification: (opts) => notifications.push(opts.title),
      confirm: async () => true,
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
    })
    await controller.onMeetingEnded()
    assert.equal(confirmCalls, 1)
    assert.deepEqual(stopCalls, [1])
  })
})
