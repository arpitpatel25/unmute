import { ACTION_ORDER, PERMISSION_ACTIONS } from './chapters'
import type { ActionId, OnboardingEvent, OnboardingProgress } from './types'

const NOTES_BUNDLE_ID = 'com.apple.Notes'

export function initialProgress(overrides: Partial<OnboardingProgress> = {}): OnboardingProgress {
  return {
    schema: 1,
    action: 'privacy',
    completed: [],
    observedCaptureItemIds: [],
    taskIds: {},
    updatedAt: Date.now(),
    ...overrides,
  }
}

function nextAction(action: ActionId): ActionId {
  return ACTION_ORDER[Math.min(ACTION_ORDER.indexOf(action) + 1, ACTION_ORDER.length - 1)]
}

function completeCurrent(progress: OnboardingProgress, patch: Partial<OnboardingProgress> = {}): OnboardingProgress {
  return {
    ...progress,
    ...patch,
    completed: progress.completed.includes(progress.action)
      ? progress.completed
      : [...progress.completed, progress.action],
    action: nextAction(progress.action),
    captureId: undefined,
    observedCaptureItemIds: [],
  }
}

function observeCapture(progress: OnboardingProgress, event: Extract<OnboardingEvent, { type: 'capture-observed' }>): OnboardingProgress {
  const expectedKind = progress.action === 'clipboard-capture' ? 'clipboard-text' : 'screenshot'
  if ((progress.action !== 'clipboard-capture' && progress.action !== 'screenshot-capture') || event.kind !== expectedKind) return progress
  return {
    ...progress,
    captureId: event.captureId,
    observedCaptureItemIds: progress.observedCaptureItemIds.includes(event.itemId)
      ? progress.observedCaptureItemIds
      : [...progress.observedCaptureItemIds, event.itemId],
  }
}

export function reduceOnboarding(progress: OnboardingProgress, event: OnboardingEvent): OnboardingProgress {
  if (event.type === 'retry-requested') return progress
  if (event.type === 'reset-requested') return initialProgress({ updatedAt: progress.updatedAt })

  if (event.type === 'boot-revalidated') {
    const permissionSet = new Set(event.satisfied)
    const retained = progress.completed.filter(action => !PERMISSION_ACTIONS.includes(action) || permissionSet.has(action))
    for (const action of PERMISSION_ACTIONS) {
      if (permissionSet.has(action) && !retained.includes(action)) retained.push(action)
    }
    const firstGap = PERMISSION_ACTIONS.find(action => !permissionSet.has(action))
    const currentIsPermission = PERMISSION_ACTIONS.includes(progress.action)
    return {
      ...progress,
      completed: retained,
      action: firstGap ?? (currentIsPermission ? 'provider-choice' : progress.action),
    }
  }

  if (event.type === 'capability-satisfied' && event.action === progress.action) {
    return completeCurrent(progress)
  }

  if (progress.action === 'provider-choice' && event.type === 'provider-selected') {
    return completeCurrent(progress, { provider: event.provider })
  }

  if (progress.action === 'notes-dictation' && event.type === 'dictation-delivered'
    && event.target === NOTES_BUNDLE_ID) {
    return completeCurrent(progress)
  }

  if (progress.action === 'notes-instruct' && event.type === 'instruction-delivered'
    && event.target === NOTES_BUNDLE_ID && event.changedSelection) {
    return completeCurrent(progress)
  }

  if (event.type === 'capture-observed') return observeCapture(progress, event)

  if ((progress.action === 'clipboard-capture' || progress.action === 'screenshot-capture')
    && event.type === 'capture-delivered'
    && progress.captureId === event.captureId
    && progress.observedCaptureItemIds.some(itemId => event.includedItemIds.includes(itemId))) {
    return completeCurrent(progress)
  }

  if (progress.action === 'orchestrator-task') {
    if (event.type === 'task-created' && event.source === 'orchestrator') {
      return { ...progress, taskIds: { ...progress.taskIds, orchestrator: event.taskId } }
    }
    if (event.type === 'task-completed' && event.taskId === progress.taskIds.orchestrator) {
      return completeCurrent(progress)
    }
  }

  if (progress.action === 'agent-task-link') {
    if (event.type === 'agent-task-linked' && event.href.length > 0) {
      return { ...progress, taskIds: { ...progress.taskIds, agent: event.taskId } }
    }
    if (event.type === 'task-link-opened' && event.taskId === progress.taskIds.agent) {
      return completeCurrent(progress)
    }
  }

  if (progress.action === 'notetaker-save') {
    if (event.type === 'notetaker-started') return { ...progress, meetingId: event.meetingId }
    if (event.type === 'notetaker-saved' && (!progress.meetingId || progress.meetingId === event.meetingId)) {
      return completeCurrent(progress, { meetingId: event.meetingId })
    }
  }

  return progress
}
