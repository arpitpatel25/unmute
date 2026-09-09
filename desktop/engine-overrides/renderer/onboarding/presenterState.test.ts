import assert from 'node:assert/strict'
import test from 'node:test'

import { emptyPresenter, reducePresenter } from './presenterState'

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
