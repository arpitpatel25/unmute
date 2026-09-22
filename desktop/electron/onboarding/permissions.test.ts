import assert from 'node:assert/strict'
import test from 'node:test'

import {
  checkpointAndRelaunch,
  preflightSystemAudio,
  probePermissions,
  requestPermission,
  type PermissionAdapters,
  type SystemAudioTapAdapter,
} from './permissions'

test('system audio preflight starts and stops the native tap exactly once', async () => {
  const calls: string[] = []
  const result = await preflightSystemAudio({
    start: async () => { calls.push('start') },
    stop: async () => { calls.push('stop') },
    status: () => 'granted',
  })

  assert.deepEqual(calls, ['start', 'stop'])
  assert.equal(result, 'granted')
})

test('system audio preflight still stops after a denied start', async () => {
  const calls: string[] = []
  const tap: SystemAudioTapAdapter = {
    start: async () => { calls.push('start'); throw new Error('TCC denied') },
    stop: async () => { calls.push('stop') },
    status: () => 'denied',
  }

  assert.equal(await preflightSystemAudio(tap), 'denied')
  assert.deepEqual(calls, ['start', 'stop'])
})

test('permission snapshot exposes only the permissions onboarding asks for', async () => {
  const adapters = permissionHarness({ accessibility: true })
  const snapshot = await probePermissions(adapters)

  assert.deepEqual(snapshot, {
    microphone: 'not-determined',
    accessibility: true,
    systemAudio: 'unknown',
  })
})

test('progress is checkpointed before relaunching', async () => {
  const calls: string[] = []
  await checkpointAndRelaunch(
    async () => { calls.push('checkpoint') },
    { relaunch: () => { calls.push('relaunch') }, exit: () => { calls.push('exit') } },
  )

  assert.deepEqual(calls, ['checkpoint', 'relaunch', 'exit'])
})

function permissionHarness(
  values: Partial<{ accessibility: boolean }> = {},
  calls: string[] = [],
): PermissionAdapters {
  return {
    microphoneStatus: () => 'not-determined',
    requestMicrophone: () => { calls.push('microphone'); return 'granted' },
    accessibilityStatus: async () => values.accessibility ?? false,
    requestAccessibility: async () => { calls.push('accessibility') },
    systemAudio: {
      start: async () => {}, stop: async () => {}, status: () => 'unknown',
    },
  }
}
