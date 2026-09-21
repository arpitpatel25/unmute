import assert from 'node:assert/strict'
import test from 'node:test'
import { initialProgress, reduceOnboarding } from './machine'
import { notetakerEvent } from './notetaker-exercise'

test('starting and stopping without Save does not complete Notetaker', () => {
  let progress = initialProgress({ action: 'notetaker-save' })
  progress = reduceOnboarding(progress, notetakerEvent('notetaker-started', 'm1'))
  progress = reduceOnboarding(progress, notetakerEvent('notetaker-stopped', 'm1'))
  assert.equal(progress.action, 'notetaker-save')
  progress = reduceOnboarding(progress, notetakerEvent('notetaker-saved', 'm1'))
  assert.equal(progress.action, 'agent-notes')
})
