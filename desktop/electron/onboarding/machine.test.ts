import assert from 'node:assert/strict'
import test from 'node:test'

import { initialProgress, reduceOnboarding } from './machine'
import type { ActionId, OnboardingProgress } from './types'

function atAction(action: ActionId, overrides: Partial<OnboardingProgress> = {}): OnboardingProgress {
  return initialProgress({ action, ...overrides })
}

test('delivery, not transcription, completes Notes dictation', () => {
  let progress = atAction('notes-dictation')

  progress = reduceOnboarding(progress, { type: 'transcription-ready', captureId: 'c1' })
  assert.equal(progress.action, 'notes-dictation')

  progress = reduceOnboarding(progress, { type: 'shortcut-started', lane: 'dictation' })
  progress = reduceOnboarding(progress, { type: 'shortcut-stopped', lane: 'dictation' })

  progress = reduceOnboarding(progress, {
    type: 'dictation-delivered',
    captureId: 'c1',
    target: 'com.apple.Notes',
  })
  assert.equal(progress.action, 'clipboard-capture')
})

test('Function readiness and dictation require real ordered shortcut receipts', () => {
  let progress = atAction('function-key')
  progress = reduceOnboarding(progress, { type: 'shortcut-started', lane: 'dictation' })
  assert.equal(progress.action, 'function-key')
  progress = reduceOnboarding(progress, { type: 'function-key-observed' })
  assert.equal(progress.action, 'system-audio')

  progress = atAction('notes-dictation')
  progress = reduceOnboarding(progress, { type: 'dictation-delivered', captureId: 'c1', target: 'com.apple.Notes' })
  assert.equal(progress.action, 'notes-dictation')
  progress = reduceOnboarding(progress, { type: 'shortcut-stopped', lane: 'dictation' })
  assert.equal(progress.action, 'notes-dictation')
  progress = reduceOnboarding(progress, { type: 'shortcut-started', lane: 'dictation' })
  progress = reduceOnboarding(progress, { type: 'shortcut-stopped', lane: 'dictation' })
  progress = reduceOnboarding(progress, { type: 'dictation-delivered', captureId: 'c1', target: 'com.apple.Notes' })
  assert.equal(progress.action, 'clipboard-capture')
})

test('dictation delivery must target Apple Notes', () => {
  const progress = reduceOnboarding(atAction('notes-dictation'), {
    type: 'dictation-delivered',
    captureId: 'c1',
    target: 'com.apple.TextEdit',
  })

  assert.equal(progress.action, 'notes-dictation')
})

test('restart resumes the first incomplete capability', () => {
  const progress = initialProgress({
    completed: ['welcome', 'privacy', 'microphone'],
    action: 'accessibility',
  })

  assert.equal(
    reduceOnboarding(progress, {
      type: 'boot-revalidated',
      satisfied: ['welcome', 'privacy', 'microphone'],
    }).action,
    'accessibility',
  )
})

test('boot revalidation removes revoked capabilities and returns to the first gap', () => {
  const progress = initialProgress({
    completed: ['welcome', 'privacy', 'microphone', 'accessibility', 'system-audio'],
    action: 'provider-choice',
  })

  const next = reduceOnboarding(progress, {
    type: 'boot-revalidated',
    satisfied: ['welcome', 'privacy', 'microphone', 'system-audio'],
  })

  assert.equal(next.action, 'accessibility')
  assert.equal(next.completed.includes('accessibility'), false)
})

test('boot revalidation advances when every permission is now satisfied', () => {
  const progress = atAction('system-audio')
  const next = reduceOnboarding(progress, {
    type: 'boot-revalidated',
    satisfied: ['welcome', 'privacy', 'microphone', 'accessibility', 'function-key', 'system-audio'],
  })

  assert.equal(next.action, 'provider-choice')
})

test('unrelated authoritative events cannot skip the current action', () => {
  const progress = reduceOnboarding(atAction('orchestrator-task'), {
    type: 'notetaker-saved',
    meetingId: 'm1',
  })

  assert.equal(progress.action, 'orchestrator-task')
})

test('orchestrator requires its created task to complete', () => {
  let progress = atAction('orchestrator-task')
  progress = reduceOnboarding(progress, { type: 'shortcut-started', lane: 'orchestrator' })
  progress = reduceOnboarding(progress, { type: 'shortcut-stopped', lane: 'orchestrator' })
  progress = reduceOnboarding(progress, {
    type: 'task-created',
    source: 'orchestrator',
    taskId: 'task-1',
  })
  assert.equal(progress.action, 'orchestrator-task')
  assert.equal(progress.taskIds.orchestrator, 'task-1')

  progress = reduceOnboarding(progress, { type: 'task-completed', taskId: 'another-task' })
  assert.equal(progress.action, 'orchestrator-task')

  progress = reduceOnboarding(progress, { type: 'task-completed', taskId: 'task-1' })
  assert.equal(progress.action, 'agent-task-link')
})

test('agent prose is not proof; its structured task link must be opened', () => {
  let progress = atAction('agent-task-link')
  progress = reduceOnboarding(progress, { type: 'shortcut-started', lane: 'agent' })
  progress = reduceOnboarding(progress, { type: 'shortcut-stopped', lane: 'agent' })
  progress = reduceOnboarding(progress, { type: 'agent-text', text: 'I created the task.' })
  assert.equal(progress.action, 'agent-task-link')

  progress = reduceOnboarding(progress, {
    type: 'agent-task-linked',
    taskId: 'task-2',
    href: 'unmute://task/task-2',
  })
  assert.equal(progress.action, 'agent-task-link')

  progress = reduceOnboarding(progress, { type: 'task-link-opened', taskId: 'task-2' })
  assert.equal(progress.action, 'notetaker-save')
})

test('notetaker save, not start or stop, completes the chapter', () => {
  let progress = atAction('notetaker-save')
  progress = reduceOnboarding(progress, { type: 'notetaker-started', meetingId: 'm1' })
  assert.equal((progress as OnboardingProgress & { notetakerActive?: boolean }).notetakerActive, true)
  progress = reduceOnboarding(progress, { type: 'notetaker-stopped', meetingId: 'm1' })
  assert.equal((progress as OnboardingProgress & { notetakerActive?: boolean }).notetakerActive, false)
  assert.equal(progress.action, 'notetaker-save')

  progress = reduceOnboarding(progress, { type: 'notetaker-saved', meetingId: 'm1' })
  assert.equal(progress.action, 'agent-notes')
})

test('the recorded notes lesson precedes product orientation', () => {
  let progress = atAction('agent-notes')
  progress = reduceOnboarding(progress, { type: 'capability-satisfied', action: 'agent-notes' })
  assert.equal(progress.action, 'product-orientation')
})

test('retry preserves progress and reset creates a fresh journey', () => {
  const progress = atAction('clipboard-capture', {
    completed: ['welcome', 'privacy', 'microphone'],
    captureId: 'c1',
  })

  assert.deepEqual(reduceOnboarding(progress, { type: 'retry-requested' }), progress)
  assert.deepEqual(
    reduceOnboarding(progress, { type: 'reset-requested' }),
    initialProgress({ updatedAt: progress.updatedAt }),
  )
})
