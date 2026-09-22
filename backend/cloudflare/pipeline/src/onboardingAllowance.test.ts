import assert from 'node:assert/strict'
import test from 'node:test'

import { consumeGrantRecord, signGrant, verifyGrant, type OnboardingGrantClaims } from './onboardingAllowance'

const now = 2_000_000
const claims: OnboardingGrantClaims = {
  version: 1,
  installationId: 'installation_123456789',
  actions: ['notes-dictation'],
  maxRequests: 8,
  maxAudioSeconds: 180,
  expiresAt: now + 60_000,
  nonce: '0123456789abcdef0123456789abcdef',
}

test('signed grants verify and tampering fails closed', async () => {
  const grant = await signGrant(claims, 'test-secret-long-enough')
  assert.deepEqual(await verifyGrant(grant, 'test-secret-long-enough'), claims)
  assert.equal(await verifyGrant(`${grant}x`, 'test-secret-long-enough'), null)
  assert.equal(await verifyGrant(grant, 'another-secret'), null)
})

test('a grant cannot be replayed for an unlisted action', () => {
  const result = consumeGrantRecord({ ...claims, requests: 0, audioSeconds: 0, revoked: false }, {
    action: 'orchestrator-task', audioSeconds: 2, now,
  })
  assert.deepEqual(result, { ok: false, reason: 'denied' })
})

test('request and cumulative audio ceilings are enforced atomically', () => {
  let record = { ...claims, requests: 0, audioSeconds: 0, revoked: false }
  for (let index = 0; index < 8; index++) {
    const result = consumeGrantRecord(record, { action: 'notes-dictation', audioSeconds: 20, now })
    assert.equal(result.ok, true)
    if (result.ok) record = result.record
  }
  assert.deepEqual(
    consumeGrantRecord(record, { action: 'notes-dictation', audioSeconds: 1, now }),
    { ok: false, reason: 'exhausted' },
  )
  assert.deepEqual(
    consumeGrantRecord({ ...claims, requests: 1, audioSeconds: 179, revoked: false }, { action: 'notes-dictation', audioSeconds: 2, now }),
    { ok: false, reason: 'exhausted' },
  )
})

test('expired and revoked grants are rejected', () => {
  const record = { ...claims, requests: 0, audioSeconds: 0, revoked: false }
  assert.equal(consumeGrantRecord(record, { action: 'notes-dictation', audioSeconds: 1, now: claims.expiresAt }).ok, false)
  assert.equal(consumeGrantRecord({ ...record, revoked: true }, { action: 'notes-dictation', audioSeconds: 1, now }).ok, false)
})
