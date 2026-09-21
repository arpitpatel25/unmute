import assert from 'node:assert/strict'
import test from 'node:test'

import * as presenterActions from './presenterActions'

const { successButtonForAction } = presenterActions

test('passive lessons continue while orientation and sign-in keep their dedicated actions', () => {
  assert.deepEqual(successButtonForAction('welcome'), { label: 'Continue', type: 'continue' })
  assert.deepEqual(successButtonForAction('agent-notes'), { label: 'Continue', type: 'continue' })
  assert.deepEqual(successButtonForAction('product-orientation'), { label: 'Explore Unmute', type: 'complete-orientation' })
  assert.deepEqual(successButtonForAction('sign-in'), { label: 'Sign in', type: 'open-sign-in' })
})

test('finished passive clips advance while exercises wait for proof', () => {
  const clipEndActionFor = (presenterActions as unknown as { clipEndActionFor(action: string): string | null }).clipEndActionFor
  assert.equal(clipEndActionFor('welcome'), 'continue')
  assert.equal(clipEndActionFor('privacy'), 'continue')
  assert.equal(clipEndActionFor('agent-notes'), 'continue')
  assert.equal(clipEndActionFor('product-orientation'), 'complete-orientation')
  assert.equal(clipEndActionFor('notes-dictation'), null)
  assert.equal(clipEndActionFor('microphone'), null)
})

test('every visible section can be skipped one at a time, including while processing', () => {
  const canSkipAction = (presenterActions as unknown as { canSkipAction(action: string, phase?: string): boolean }).canSkipAction
  assert.equal(canSkipAction('welcome'), true)
  assert.equal(canSkipAction('microphone'), true)
  assert.equal(canSkipAction('provider-choice'), true)
  assert.equal(canSkipAction('notes-dictation'), true)
  assert.equal(canSkipAction('orchestrator-task'), true)
  assert.equal(canSkipAction('notetaker-save'), true)
  assert.equal(canSkipAction('notes-dictation', 'listening'), true)
  assert.equal(canSkipAction('orchestrator-task', 'processing'), true)
  assert.equal(canSkipAction('complete'), false)
})

test('only processing task exercises offer a bounded escape', () => {
  const processingEscapeDelayMs = (presenterActions as unknown as {
    processingEscapeDelayMs(action: string, phase?: string): number | null
  }).processingEscapeDelayMs

  assert.equal(processingEscapeDelayMs('orchestrator-task', 'processing'), 10_000)
  assert.equal(processingEscapeDelayMs('agent-task-link', 'processing'), 10_000)
  assert.equal(processingEscapeDelayMs('notes-dictation', 'processing'), null)
  assert.equal(processingEscapeDelayMs('orchestrator-task', 'listening'), null)
  assert.equal(processingEscapeDelayMs('microphone', 'processing'), null)
})
