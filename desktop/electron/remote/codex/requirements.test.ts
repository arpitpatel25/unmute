import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appliedPosture, clampPosture, learnFromRejection, mergeRequirements, requirementsFrom } from './requirements.ts'

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

test('a refusal names the allowed set, and it is learned (measured error text)', () => {
  const sandbox = learnFromRejection('-32600: invalid thread settings override: invalid value for `sandbox_mode`: `DangerFullAccess` is not in the allowed set [ReadOnly, WorkspaceWrite] (set by MDM com.openai.codex:requirements_toml_base64)', null)
  assert.deepEqual(sandbox?.allowedSandboxModes, ['read-only', 'workspace-write'])
  const both = learnFromRejection('invalid value for `approval_policy`: `Never` is not in the allowed set [UnlessTrusted, OnRequest]', sandbox)
  assert.deepEqual(both, { allowedSandboxModes: ['read-only', 'workspace-write'], allowedApprovalPolicies: ['untrusted', 'on-request'] })
  assert.deepEqual(clampPosture(full, both), { approvalPolicy: 'on-request', sandbox: 'workspace-write' })
})

test('the thread-start refusal forbids the sandbox it names', () => {
  const learned = learnFromRejection('failed to load configuration: `approval_policy = "never"` cannot be used because requirements do not allow `sandbox_mode = "danger-full-access"`; Codex would fall back', null)
  assert.deepEqual(learned?.allowedSandboxModes, ['read-only', 'workspace-write'])
})

test('an unrelated error teaches nothing', () => {
  assert.equal(learnFromRejection('no rollout found for thread id x', null), null)
})

test('learned limits narrow what the query said', () => {
  assert.deepEqual(mergeRequirements({ allowedSandboxModes: ['read-only', 'workspace-write', 'danger-full-access'] }, { allowedSandboxModes: ['read-only', 'workspace-write'] })?.allowedSandboxModes, ['read-only', 'workspace-write'])
  assert.deepEqual(mergeRequirements(null, { allowedApprovalPolicies: ['on-request'] }), { allowedApprovalPolicies: ['on-request'] })
  assert.equal(mergeRequirements(null, null), null)
})

test('the applied posture is read from the response in either spelling', () => {
  assert.deepEqual(appliedPosture({ approvalPolicy: 'untrusted', sandbox: { type: 'readOnly' } }, full), { approvalPolicy: 'untrusted', sandbox: 'read-only' })
  assert.deepEqual(appliedPosture({}, full), full)
})
