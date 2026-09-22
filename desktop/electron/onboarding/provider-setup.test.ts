import assert from 'node:assert/strict'
import test from 'node:test'

import { installProvider, launchProviderLogin, type ProviderInstallDeps } from './provider-setup'

test('Codex setup downloads the official installer and runs it locally without sudo', async () => {
  const events: string[] = []
  const deps: ProviderInstallDeps = {
    makeTempDir: async () => '/tmp/unmute-provider-install-test',
    download: async (url, destination) => { events.push(`download ${url} ${destination}`) },
    run: async (command, args) => {
      events.push(`run ${command} ${args.join(' ')}`)
      return { code: 0, stdout: '', stderr: '' }
    },
    removeTempDir: async path => { events.push(`remove ${path}`) },
  }

  assert.deepEqual(await installProvider('codex', deps), { provider: 'codex', state: 'installed' })
  assert.deepEqual(events, [
    'download https://chatgpt.com/codex/install.sh /tmp/unmute-provider-install-test/install.sh',
    'run /bin/sh /tmp/unmute-provider-install-test/install.sh',
    'remove /tmp/unmute-provider-install-test',
  ])
})

test('Claude setup uses Anthropic installer and reports a failed install while cleaning up', async () => {
  const events: string[] = []
  const deps: ProviderInstallDeps = {
    makeTempDir: async () => '/tmp/unmute-provider-install-test',
    download: async url => { events.push(`download ${url}`) },
    run: async () => ({ code: 1, stdout: '', stderr: 'network unavailable' }),
    removeTempDir: async path => { events.push(`remove ${path}`) },
  }

  assert.deepEqual(await installProvider('claude', deps), {
    provider: 'claude',
    state: 'failed',
    detail: 'network unavailable',
  })
  assert.deepEqual(events, [
    'download https://claude.ai/install.sh',
    'remove /tmp/unmute-provider-install-test',
  ])
})

test('a download failure is surfaced and still removes temporary files', async () => {
  let cleaned = false
  const deps: ProviderInstallDeps = {
    makeTempDir: async () => '/tmp/unmute-provider-install-test',
    download: async () => { throw new Error('download failed') },
    run: async () => { throw new Error('must not run') },
    removeTempDir: async () => { cleaned = true },
  }

  assert.deepEqual(await installProvider('codex', deps), {
    provider: 'codex',
    state: 'failed',
    detail: 'download failed',
  })
  assert.equal(cleaned, true)
})

test('provider authentication launches the provider login flow without a Terminal window', async () => {
  const launches: Array<{ command: string; args: string[] }> = []
  const launch = (command: string, args: string[]) => { launches.push({ command, args }) }

  launchProviderLogin('claude', '/Users/tester/.local/bin/claude', launch)
  launchProviderLogin('codex', '/Users/tester/.local/bin/codex', launch)

  assert.deepEqual(launches, [
    { command: '/Users/tester/.local/bin/claude', args: ['auth', 'login'] },
    { command: '/Users/tester/.local/bin/codex', args: ['login'] },
  ])
})
