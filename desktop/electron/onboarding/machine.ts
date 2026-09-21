import { ACTION_ORDER, PERMISSION_ACTIONS } from './chapters'
import type { ActionId, OnboardingEvent, OnboardingProgress } from './types'

const NOTES_BUNDLE_ID = 'com.apple.Notes'

export function initialProgress(overrides: Partial<OnboardingProgress> = {}): OnboardingProgress {
  return {
    schema: 1,
    action: 'welcome',
    completed: [],
    skipped: [],
    observedCaptureItemIds: [],
    taskIds: {},
    notetakerActive: false,
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
    gesture: undefined,
    notetakerActive: false,
  }
}

function expectedLane(action: ActionId) {
  if (action === 'notes-dictation' || action === 'clipboard-capture' || action === 'screenshot-capture') return 'dictation'
  if (action === 'orchestrator-task') return 'orchestrator'
  if (action === 'agent-task-link') return 'agent'
  return null
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
  if (event.type === 'retry-requested') {
    if (progress.action !== 'orchestrator-task' && progress.action !== 'agent-task-link') return progress
    const taskIds = { ...progress.taskIds }
    if (progress.action === 'orchestrator-task') delete taskIds.orchestrator
    if (progress.action === 'agent-task-link') delete taskIds.agent
    return {
      ...progress,
      captureId: undefined,
      observedCaptureItemIds: [],
      gesture: undefined,
      taskIds,
    }
  }
  if (event.type === 'reset-requested') return initialProgress({ updatedAt: progress.updatedAt })

  if (event.type === 'boot-revalidated') {
    const permissionSet = new Set(event.satisfied)
    const skippedSet = new Set(progress.skipped)
    const retained = progress.completed.filter(action => !PERMISSION_ACTIONS.includes(action) || permissionSet.has(action) || skippedSet.has(action))
    for (const action of PERMISSION_ACTIONS) {
      if ((permissionSet.has(action) || skippedSet.has(action)) && !retained.includes(action)) retained.push(action)
    }
    const firstGap = PERMISSION_ACTIONS.find(action => !permissionSet.has(action) && !skippedSet.has(action))
    const currentIsPermission = PERMISSION_ACTIONS.includes(progress.action)
    return {
      ...progress,
      completed: retained,
      action: firstGap ?? (currentIsPermission ? 'provider-choice' : progress.action),
    }
  }

  if (event.type === 'section-skipped' && event.action === progress.action && progress.action !== 'complete') {
    return completeCurrent(progress, {
      skipped: progress.skipped.includes(progress.action)
        ? progress.skipped
        : [...progress.skipped, progress.action],
    })
  }

  if (event.type === 'capability-satisfied' && event.action === progress.action) {
    return completeCurrent(progress)
  }

  if (progress.action === 'function-key' && event.type === 'function-key-observed') return completeCurrent(progress)

  const lane = expectedLane(progress.action)
  if (event.type === 'shortcut-started' && event.lane === lane && !progress.gesture?.started) {
    return { ...progress, gesture: { lane: event.lane, started: true, stopped: false } }
  }
  if (event.type === 'shortcut-stopped' && event.lane === lane && progress.gesture?.started && !progress.gesture.stopped) {
    return { ...progress, gesture: { ...progress.gesture, stopped: true } }
  }

  if (progress.action === 'provider-choice' && event.type === 'provider-selected') {
    return completeCurrent(progress, { provider: event.provider })
  }

  if (progress.action === 'notes-dictation' && event.type === 'dictation-delivered'
    && event.target === NOTES_BUNDLE_ID && progress.gesture?.started && progress.gesture.stopped) {
    return completeCurrent(progress)
  }

  if (event.type === 'capture-observed') return observeCapture(progress, event)

  if ((progress.action === 'clipboard-capture' || progress.action === 'screenshot-capture')
    && event.type === 'capture-delivered'
    && progress.gesture?.started && progress.gesture.stopped
    && progress.captureId === event.captureId
    && progress.observedCaptureItemIds.some(itemId => event.includedItemIds.includes(itemId))) {
    return completeCurrent(progress)
  }

  if (progress.action === 'orchestrator-task') {
    if (event.type === 'task-created' && event.source === 'orchestrator') {
      return { ...progress, taskIds: { ...progress.taskIds, orchestrator: event.taskId } }
    }
    if (event.type === 'task-completed' && event.taskId === progress.taskIds.orchestrator
      && progress.gesture?.started && progress.gesture.stopped) {
      return completeCurrent(progress)
    }
  }

  if (progress.action === 'agent-task-link') {
    if (event.type === 'agent-task-linked' && event.href.length > 0) {
      return { ...progress, taskIds: { ...progress.taskIds, agent: event.taskId } }
    }
    if (event.type === 'task-link-opened' && event.taskId === progress.taskIds.agent
      && progress.gesture?.started && progress.gesture.stopped) {
      return completeCurrent(progress)
    }
  }

  if (progress.action === 'notetaker-save') {
    if (event.type === 'notetaker-started') return { ...progress, meetingId: event.meetingId, notetakerActive: true }
    if (event.type === 'notetaker-stopped' && progress.meetingId === event.meetingId) {
      return { ...progress, notetakerActive: false }
    }
    if (event.type === 'notetaker-saved' && (!progress.meetingId || progress.meetingId === event.meetingId)) {
      return completeCurrent(progress, { meetingId: event.meetingId })
    }
  }

  return progress
}
