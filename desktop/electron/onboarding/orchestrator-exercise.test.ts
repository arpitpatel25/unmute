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

test('accepts the guided task when the user explicitly creates it on the Desktop', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'unmute-onboarding-workspace-'))
  const desktop = await mkdtemp(join(tmpdir(), 'unmute-onboarding-desktop-'))
  await writeFile(join(desktop, 'hello-unmute.txt'), 'My first Unmute task\n')

  assert.equal(await verifyHelloTask(workspace, [desktop]), true)
})

test('accepts dictated task content when transcription changes capitalization', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'unmute-onboarding-workspace-'))
  await writeFile(join(workspace, 'hello-unmute.txt'), 'my first unmute task\n')

  assert.equal(await verifyHelloTask(workspace), true)
})

test('does not accept a matching file left behind by an earlier onboarding attempt', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'unmute-onboarding-workspace-'))
  const desktop = await mkdtemp(join(tmpdir(), 'unmute-onboarding-desktop-'))
  await writeFile(join(desktop, 'hello-unmute.txt'), 'My first Unmute task')

  assert.equal(await verifyHelloTask(workspace, [desktop], Date.now() + 1_000), false)
})
