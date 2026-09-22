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
  assert.equal(h.runtime.snapshot().action, 'welcome')
  assert.equal(h.shown, 1)
})

test('signed-in startup never shows an unfinished tour, but explicit replay still works', async () => {
  const h = harness(initialProgress({ action: 'notes-dictation' }))
  await h.runtime.boot({ signedIn: true })
  assert.equal(h.shown, 0)
  assert.equal(h.runtime.snapshot().action, 'complete')
  await h.runtime.reset()
  assert.equal(h.shown, 1)
  assert.equal(h.runtime.snapshot().action, 'welcome')
  await h.runtime.finishAfterSignIn(true)
  assert.equal(h.runtime.snapshot().action, 'welcome')
})

test('orchestrator completion advances only after output verification', async () => {
  const h = harness(initialProgress({ action: 'orchestrator-task', taskIds: { orchestrator: 't1' } }))
  await h.runtime.boot()
  await h.runtime.accept({ type: 'shortcut-started', lane: 'orchestrator' })
  await h.runtime.accept({ type: 'shortcut-stopped', lane: 'orchestrator' })
  h.runtime.setVerifyOrchestratorTask(async () => false)
  await h.runtime.accept({ type: 'task-completed', taskId: 't1' })
  assert.equal(h.runtime.snapshot().action, 'orchestrator-task')
  h.runtime.setVerifyOrchestratorTask(async () => true)
  await h.runtime.accept({ type: 'task-completed', taskId: 't1' })
  assert.equal(h.runtime.snapshot().action, 'agent-task-link')
})

test('orchestrator verification receives the current attempt timestamp', async () => {
  const h = harness(initialProgress({ action: 'orchestrator-task', taskIds: { orchestrator: 't1' } }))
  await h.runtime.boot()
  await h.runtime.accept({ type: 'shortcut-started', lane: 'orchestrator' })
  await h.runtime.accept({ type: 'shortcut-stopped', lane: 'orchestrator' })
  let verified: { taskId: string; notBeforeMs: number } | undefined
  h.runtime.setVerifyOrchestratorTask(async (taskId, notBeforeMs) => {
    verified = { taskId, notBeforeMs }
    return false
  })

  await h.runtime.accept({ type: 'task-completed', taskId: 't1' })

  assert.deepEqual(verified, { taskId: 't1', notBeforeMs: 10 })
})
