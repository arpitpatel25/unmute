import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { isOwnedOnboardingTask, prepareOnboardingWorkspace, verifyHelloTask } from './orchestrator-exercise'

test('only the armed onboarding task with expected output verifies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'unmute-onboarding-task-'))
  await prepareOnboardingWorkspace(root)
  await writeFile(join(root, 'hello-unmute.txt'), 'My first Unmute task')
  assert.equal(isOwnedOnboardingTask({ id: 't1', cwd: root }, 't1', root), true)
  assert.equal(isOwnedOnboardingTask({ id: 'other', cwd: root }, 't1', root), false)
  assert.equal(await verifyHelloTask(root), true)
})
