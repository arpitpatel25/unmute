import assert from 'node:assert/strict'
import test from 'node:test'
import { validAgentTaskReceipt } from './agent-exercise'

test('prose is not a structured task receipt', () => {
  assert.equal(validAgentTaskReceipt('Created unmute://task/t1', '/workspace'), false)
  assert.equal(validAgentTaskReceipt({ source: 'unmute-agent', taskId: 't1', href: 'unmute://task/t1', cwd: '/workspace' }, '/workspace'), true)
  assert.equal(validAgentTaskReceipt({ source: 'unmute-agent', taskId: 't1', href: 'unmute://task/t2', cwd: '/workspace' }, '/workspace'), false)
})
