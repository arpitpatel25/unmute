import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clampPosture, requirementsFrom } from './requirements.ts'

const full = { approvalPolicy: 'never', sandbox: 'danger-full-access' }

test('an unmanaged machine keeps what was asked', () => {
  assert.equal(clampPosture(full, requirementsFrom({ requirements: null })), full)
  assert.equal(clampPosture(full, requirementsFrom({})), full)
})

test('a sandbox cap lowers full access to workspace-write and keeps never', () => {
  const req = requirementsFrom({ requirements: { allowedSandboxModes: ['read-only', 'workspace-write'], allowedApprovalPolicies: null } })
  assert.deepEqual(clampPosture(full, req), { approvalPolicy: 'never', sandbox: 'workspace-write' })
})

test('an approval cap lowers never to on-request, never below it', () => {
  const req = requirementsFrom({ requirements: { allowedSandboxModes: ['read-only', 'workspace-write'], allowedApprovalPolicies: ['untrusted', 'on-request'] } })
  assert.deepEqual(clampPosture(full, req), { approvalPolicy: 'on-request', sandbox: 'workspace-write' })
  assert.deepEqual(clampPosture({ approvalPolicy: 'untrusted', sandbox: 'read-only' }, req), { approvalPolicy: 'untrusted', sandbox: 'read-only' })
})

test('when everything allowed is stricter-than-asked the other way, the least permissive allowed wins', () => {
  const req = requirementsFrom({ requirements: { allowedSandboxModes: ['workspace-write'], allowedApprovalPolicies: ['on-request'] } })
  assert.deepEqual(clampPosture({ approvalPolicy: 'untrusted', sandbox: 'read-only' }, req), { approvalPolicy: 'on-request', sandbox: 'workspace-write' })
})

test('other fields survive the clamp', () => {
  const req = requirementsFrom({ requirements: { allowedSandboxModes: ['read-only', 'workspace-write'] } })
  assert.deepEqual(clampPosture({ ...full, cwd: '/p', model: 'm' }, req), { cwd: '/p', model: 'm', approvalPolicy: 'never', sandbox: 'workspace-write' })
})
