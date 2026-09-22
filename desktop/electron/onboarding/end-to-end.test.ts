import assert from 'node:assert/strict'
import test from 'node:test'

import { initialProgress, reduceOnboarding } from './machine'
import type { OnboardingEvent } from './types'

test('fresh install completes only after every real receipt and sign-in', () => {
  let progress = initialProgress()
  const accept = (event: OnboardingEvent) => { progress = reduceOnboarding(progress, event) }
  for (const action of ['welcome', 'privacy', 'microphone', 'accessibility'] as const) {
    accept({ type: 'capability-satisfied', action })
  }
  accept({ type: 'function-key-observed' })
  accept({ type: 'capability-satisfied', action: 'system-audio' })
  accept({ type: 'provider-selected', provider: 'codex' })
  accept({ type: 'shortcut-started', lane: 'dictation' })
  accept({ type: 'shortcut-stopped', lane: 'dictation' })
  accept({ type: 'dictation-delivered', captureId: 'd1', target: 'com.apple.Notes' })
  accept({ type: 'shortcut-started', lane: 'dictation' })
  accept({ type: 'capture-observed', captureId: 'c1', kind: 'clipboard-text', itemId: 'copy1' })
  accept({ type: 'shortcut-stopped', lane: 'dictation' })
  accept({ type: 'capture-delivered', captureId: 'c1', includedItemIds: ['copy1'] })
  accept({ type: 'shortcut-started', lane: 'dictation' })
  accept({ type: 'capture-observed', captureId: 'c2', kind: 'screenshot', itemId: 'shot1' })
  accept({ type: 'shortcut-stopped', lane: 'dictation' })
  accept({ type: 'capture-delivered', captureId: 'c2', includedItemIds: ['shot1'] })
  accept({ type: 'shortcut-started', lane: 'orchestrator' })
  accept({ type: 'shortcut-stopped', lane: 'orchestrator' })
  accept({ type: 'task-created', source: 'orchestrator', taskId: 'task1', cwd: '/owned' })
  accept({ type: 'task-completed', taskId: 'task1' })
  accept({ type: 'shortcut-started', lane: 'agent' })
  accept({ type: 'shortcut-stopped', lane: 'agent' })
  accept({ type: 'agent-task-linked', taskId: 'task2', href: 'unmute://task/task2', cwd: '/owned' })
  accept({ type: 'task-link-opened', taskId: 'task2' })
  accept({ type: 'notetaker-started', meetingId: 'meeting1' })
  accept({ type: 'notetaker-stopped', meetingId: 'meeting1' })
  assert.equal(progress.action, 'notetaker-save')
  accept({ type: 'notetaker-saved', meetingId: 'meeting1' })
  assert.equal(progress.action, 'agent-notes')
  accept({ type: 'capability-satisfied', action: 'agent-notes' })
  accept({ type: 'capability-satisfied', action: 'product-orientation' })
  assert.equal(progress.action, 'sign-in')
  accept({ type: 'capability-satisfied', action: 'sign-in' })
  assert.equal(progress.action, 'complete')
})
