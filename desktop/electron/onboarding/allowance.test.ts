import assert from 'node:assert/strict'
import test from 'node:test'

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AllowanceGrantStore, OnboardingAllowanceSession } from './allowance'

test('headers exist only for the currently armed transcription action', () => {
  const session = new OnboardingAllowanceSession('installation_123456789', () => 100)
  session.acceptGrant({ grant: 'signed-token', expiresAt: 1_000 })
  session.arm('notes-dictation')

  assert.deepEqual(session.headers(), {
    'X-Unmute-Onboarding-Grant': 'signed-token',
    'X-Unmute-Installation': 'installation_123456789',
    'X-Unmute-Onboarding-Action': 'notes-dictation',
  })
  session.arm('notetaker-save')
  assert.equal(session.headers(), null)
})

test('expired and completed sessions fail closed', () => {
  let now = 100
  const session = new OnboardingAllowanceSession('installation_123456789', () => now)
  session.acceptGrant({ grant: 'signed-token', expiresAt: 200 })
  session.arm('notes-instruct')
  now = 200
  assert.equal(session.headers(), null)

  now = 100
  session.complete()
  assert.equal(session.headers(), null)
})

test('grant acquisition sends only the installation identifier', async () => {
  const requests: Array<{ url: string; init: RequestInit }> = []
  const session = new OnboardingAllowanceSession('installation_123456789', () => 100, async (url, init) => {
    requests.push({ url: String(url), init: init ?? {} })
    return new Response(JSON.stringify({ ok: true, grant: 'signed-token', expires_at: 1_000 }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })
  })

  assert.equal(await session.acquire('https://pipeline.example'), true)
  assert.deepEqual(JSON.parse(String(requests[0].init.body)), { installationId: 'installation_123456789' })
  assert.equal(requests[0].init.headers && 'Authorization' in requests[0].init.headers, false)
})

test('grant survives an app relaunch without requesting a duplicate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'unmute-allowance-'))
  try {
    const store = new AllowanceGrantStore(join(root, 'grant.json'))
    await store.save({ grant: 'signed-token', expiresAt: 500 })
    assert.deepEqual(await store.load(), { grant: 'signed-token', expiresAt: 500 })
    assert.equal((await readFile(join(root, 'grant.json'))).length > 0, true)
  } finally { await rm(root, { recursive: true, force: true }) }
})
