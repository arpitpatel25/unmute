import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeSessionLifecycleFields, SESSION_LIFECYCLE_DEV_LOG } from './session-lifecycle-devlog.ts'

test('session lifecycle diagnostics are disabled in product and redact free-form or secret fields', () => {
  assert.equal(SESSION_LIFECYCLE_DEV_LOG, false)
  assert.deepEqual(sanitizeSessionLifecycleFields({
    taskId: 'task', sessionId: 'thread', phase: 'reconcile', attempt: 2,
    prompt: 'private words', text: 'private words', token: 'secret', authorization: 'secret',
  }), { taskId: 'task', sessionId: 'thread', phase: 'reconcile', attempt: 2 })
})
