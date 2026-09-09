import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import { probeProvider, probeProviders, type ProviderProbeDeps } from './provider-probe'
import type { ProviderId } from './types'

test('a valid response marks a provider ready and removes the workspace', async () => {
  const harness = probeHarness({ stdout: '{"type":"result","result":"READY"}\n', exitCode: 0 })

  assert.deepEqual(await probeProvider('codex', harness.deps), { provider: 'codex', state: 'ready' })
  assert.equal(harness.workspaceRemoved, true)
  assert.equal(harness.processKilled, true)
})

test('a missing binary is reported without spawning', async () => {
  const harness = probeHarness({ binary: null })

  const result = await probeProvider('claude', harness.deps)

  assert.equal(result.state, 'missing')
  assert.equal(harness.spawned, false)
  assert.equal(harness.workspaceRemoved, true)
})

test('a CLI login failure is distinguished from an execution failure', async () => {
  const harness = probeHarness({ stderr: 'Please login to continue', exitCode: 1 })

  assert.equal((await probeProvider('claude', harness.deps)).state, 'auth-required')
})

test('a hung CLI is killed and classified as timed out', async () => {
  const harness = probeHarness({ neverClose: true })

  assert.equal((await probeProvider('codex', harness.deps, 5)).state, 'timed-out')
  assert.equal(harness.processKilled, true)
  assert.equal(harness.workspaceRemoved, true)
})

test('Claude and Codex are probed independently', async () => {
  const requested: ProviderId[] = []
  const result = await probeProviders(async (provider) => {
    requested.push(provider)
    return provider === 'claude'
      ? { provider, state: 'ready' }
      : { provider, state: 'missing', detail: 'not installed' }
  })

  assert.deepEqual(new Set(requested), new Set<ProviderId>(['claude', 'codex']))
  assert.equal(result.claude.state, 'ready')
  assert.equal(result.codex.state, 'missing')
})

function probeHarness(options: {
  binary?: string | null
  stdout?: string
  stderr?: string
  exitCode?: number
  neverClose?: boolean
}) {
  let workspaceRemoved = false
  let processKilled = false
  let spawned = false

  const deps: ProviderProbeDeps = {
    resolveBinary: async () => options.binary === undefined ? '/usr/local/bin/agent' : options.binary,
    makeWorkspace: async () => '/tmp/unmute-provider-probe-test',
    removeWorkspace: async () => { workspaceRemoved = true },
    spawn: () => {
      spawned = true
      const emitter = new EventEmitter()
      const stdout = new EventEmitter()
      const stderr = new EventEmitter()
      const child = Object.assign(emitter, {
        stdout,
        stderr,
        stdin: { end: () => undefined },
        kill: () => { processKilled = true; return true },
      })
      queueMicrotask(() => {
        if (options.stdout) stdout.emit('data', Buffer.from(options.stdout))
        if (options.stderr) stderr.emit('data', Buffer.from(options.stderr))
        if (!options.neverClose) emitter.emit('close', options.exitCode ?? 0)
      })
      return child as ReturnType<ProviderProbeDeps['spawn']>
    },
  }

  return {
    deps,
    get workspaceRemoved() { return workspaceRemoved },
    get processKilled() { return processKilled },
    get spawned() { return spawned },
  }
}
