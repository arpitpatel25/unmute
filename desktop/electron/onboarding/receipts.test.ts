import assert from 'node:assert/strict'
import test from 'node:test'

import * as receipts from './receipts'

test('structured Agent continuations without a cwd remain valid onboarding receipts', () => {
  const acceptsAgentTaskLink = (receipts as unknown as {
    acceptsAgentTaskLink(event: { cwd?: string; taskId: string }, workspace: string, owned: ReadonlySet<string>): boolean
  }).acceptsAgentTaskLink
  const workspace = '/onboarding/workspace'

  assert.equal(acceptsAgentTaskLink({ taskId: 'continued-task' }, workspace, new Set()), true)
  assert.equal(acceptsAgentTaskLink({ taskId: 'guided-task', cwd: workspace }, workspace, new Set()), true)
  assert.equal(acceptsAgentTaskLink({ taskId: 'owned-task', cwd: '/elsewhere' }, workspace, new Set(['owned-task'])), true)
  assert.equal(acceptsAgentTaskLink({ taskId: 'unrelated-task', cwd: '/elsewhere' }, workspace, new Set()), false)
})
