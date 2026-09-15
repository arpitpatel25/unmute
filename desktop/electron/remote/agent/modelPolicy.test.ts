import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agentModel, agentModelLabel } from './modelPolicy'

test('each Unmute Agent provider has one explicit model and user-facing label', () => {
  assert.equal(agentModel('codex'), 'gpt-5.6-sol')
  assert.equal(agentModelLabel('codex'), 'GPT-5.6 Sol')
  assert.equal(agentModel('claude'), 'opus')
  assert.equal(agentModelLabel('claude'), 'Opus 5')
})
