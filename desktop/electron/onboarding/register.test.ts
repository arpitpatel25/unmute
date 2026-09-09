import assert from 'node:assert/strict'
import test from 'node:test'

import { OnboardingCoordinator } from './coordinator'
import { initialProgress } from './machine'
import { OnboardingRuntime, type OnboardingRuntimeDeps } from './register'
import type { OnboardingProgress, PresenterCommand } from './types'

function harness(progress: OnboardingProgress) {
  let saved = progress
  let shown = 0
  let closed = 0
  const commands: PresenterCommand[] = []
  const coordinator = new OnboardingCoordinator({
    load: async () => saved,
    save: async value => { saved = value },
    reset: async () => { saved = initialProgress() },
  } as never, () => 10)
  const deps: OnboardingRuntimeDeps = {
    coordinator,
    presenter: { show: () => { shown += 1 }, send: c => { commands.push(c) }, close: () => { closed += 1 } },
    allowance: { arm() {}, complete() {} },
    onReceipt: () => () => {},
    verifyOrchestratorTask: async () => true,
    onNavigate: () => {},
  }
  return { runtime: new OnboardingRuntime(deps), get shown() { return shown }, get closed() { return closed }, commands }
}

test('first launch shows presenter before sign-in and completion waits for sign-in', async () => {
  const h = harness(initialProgress({ action: 'sign-in', completed: ['privacy'] }))
  await h.runtime.boot()
  assert.equal(h.shown, 1)
  assert.equal(h.runtime.snapshot().action, 'sign-in')
  await h.runtime.finishAfterSignIn(false)
  assert.equal(h.runtime.snapshot().action, 'sign-in')
  await h.runtime.finishAfterSignIn(true)
  assert.equal(h.runtime.snapshot().action, 'complete')
  assert.equal(h.closed, 1)
})

test('replay resets durable progress and opens the presenter', async () => {
  const h = harness(initialProgress({ action: 'complete', completed: ['complete'] }))
  await h.runtime.boot()
  assert.equal(h.shown, 0)
  await h.runtime.reset()
  assert.equal(h.runtime.snapshot().action, 'privacy')
  assert.equal(h.shown, 1)
})

test('orchestrator completion advances only after output verification', async () => {
  const h = harness(initialProgress({ action: 'orchestrator-task', taskIds: { orchestrator: 't1' } }))
  await h.runtime.boot()
  h.runtime.setVerifyOrchestratorTask(async () => false)
  await h.runtime.accept({ type: 'task-completed', taskId: 't1' })
  assert.equal(h.runtime.snapshot().action, 'orchestrator-task')
  h.runtime.setVerifyOrchestratorTask(async () => true)
  await h.runtime.accept({ type: 'task-completed', taskId: 't1' })
  assert.equal(h.runtime.snapshot().action, 'agent-task-link')
})
