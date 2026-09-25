import assert from 'node:assert/strict'
import test from 'node:test'

import { emptyPresenter, reducePresenter, shownProviders } from './presenterState'

test('action change swaps caption and one companion card', () => {
  const next = reducePresenter(emptyPresenter(), {
    type: 'snapshot',
    action: 'notes-dictation',
    clipId: 'dictation-explain-v1',
    caption: 'Put your cursor in Notes.',
    card: { kind: 'speak', phrase: 'My first Unmute dictation.' },
  })

  assert.equal(next.clipId, 'dictation-explain-v1')
  assert.equal(next.card?.kind, 'speak')
  assert.equal(next.videoUnavailable, false)
})

test('a missing clip keeps the script visible and marks video unavailable', () => {
  let state = reducePresenter(emptyPresenter(), {
    type: 'snapshot', action: 'privacy', clipId: 'welcome-v1', caption: 'Welcome.', card: null,
  })
  state = reducePresenter(state, { type: 'video-unavailable' })

  assert.equal(state.caption, 'Welcome.')
  assert.equal(state.videoUnavailable, true)
})

test('a new snapshot clears an old clip failure', () => {
  const failed = { ...emptyPresenter(), videoUnavailable: true }
  const next = reducePresenter(failed, {
    type: 'snapshot', action: 'microphone', clipId: 'mic-v1', caption: 'Allow the microphone.', card: null,
  })

  assert.equal(next.videoUnavailable, false)
})

test('gesture phase follows authoritative onboarding receipts', () => {
  const listening = reducePresenter(emptyPresenter(), {
    type: 'snapshot', action: 'notes-dictation', clipId: 'dictation-explain-v1', caption: 'Tap Function.',
    card: { kind: 'speak', phrase: 'My first Unmute dictation.', detail: 'Listening' }, phase: 'listening',
  })

  assert.equal(listening.phase, 'listening')
  assert.equal(listening.card?.detail, 'Listening')
})

test('Back reviews the previous chapter without replacing the live checkpoint', () => {
  let state = reducePresenter(emptyPresenter(), {
    type: 'snapshot', action: 'welcome', clipId: 'welcome-v1', caption: 'Welcome.', card: null,
  })
  state = reducePresenter(state, { type: 'video-ended' })
  state = reducePresenter(state, {
    type: 'snapshot', action: 'privacy', clipId: 'privacy-v1', caption: 'Privacy.', card: null,
  })
  state = reducePresenter(state, { type: 'back' } as never)

  assert.equal(state.action, 'welcome')
  assert.equal((state as unknown as { checkpoint: { action: string } }).checkpoint.action, 'privacy')
  assert.equal((state as unknown as { reviewing: boolean }).reviewing, true)
})

test('Forward returns from chapter history to the live checkpoint', () => {
  let state = reducePresenter(emptyPresenter(), {
    type: 'snapshot', action: 'welcome', clipId: 'welcome-v1', caption: 'Welcome.', card: null,
  })
  state = reducePresenter(state, { type: 'video-ended' })
  state = reducePresenter(state, {
    type: 'snapshot', action: 'privacy', clipId: 'privacy-v1', caption: 'Privacy.', card: null,
  })
  state = reducePresenter(state, { type: 'back' } as never)
  state = reducePresenter(state, { type: 'forward' } as never)

  assert.equal(state.action, 'privacy')
  assert.equal((state as unknown as { reviewing: boolean }).reviewing, false)
})

test('a real action can finish early without cutting off its current video', () => {
  let state = reducePresenter(emptyPresenter(), {
    type: 'snapshot', action: 'agent-task-link', clipId: 'agent-v2', caption: 'Agent.', card: null,
  })
  state = reducePresenter(state, {
    type: 'snapshot', action: 'notetaker-save', clipId: 'notetaker-v2', caption: 'Notes.', card: null,
  })
  assert.equal(state.action, 'agent-task-link')
  assert.equal(state.pending?.action, 'notetaker-save')
  state = reducePresenter(state, { type: 'video-ended' })
  assert.equal(state.action, 'notetaker-save')
  assert.equal(state.pending, null)
})

test('a live text-only step can advance without waiting for a nonexistent video', () => {
  let state = reducePresenter(emptyPresenter(), {
    type: 'snapshot', action: 'agent-notes', clipId: '', caption: 'Ask about notes.', card: null,
  })
  assert.equal(state.videoFinished, true)
  state = reducePresenter(state, {
    type: 'snapshot', action: 'product-orientation', clipId: 'orientation-v2', caption: 'Explore.', card: null,
  })
  assert.equal(state.action, 'product-orientation')
  assert.equal(state.pending, null)
})

test('the provider card hides an agent that is not on this Mac', () => {
  assert.deepEqual(shownProviders({ claude: { state: 'missing' }, codex: { state: 'ready' } }), ['codex'])
  assert.deepEqual(shownProviders({ claude: { state: 'auth-required' }, codex: { state: 'missing' } }), ['claude'])
  assert.deepEqual(shownProviders({ claude: { state: 'missing' }, codex: { state: 'missing' } }), ['claude', 'codex'])
  assert.deepEqual(shownProviders({ claude: { state: 'checking' }, codex: { state: 'checking' } }), ['claude', 'codex'])
  assert.deepEqual(shownProviders(undefined), ['claude', 'codex'])
})
