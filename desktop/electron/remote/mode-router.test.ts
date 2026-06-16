import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveRemoteKey, CaptureLock } from './mode-router.ts'

test('remote key is the one not chosen for dictation (PRD §2.4.4)', () => {
  assert.equal(deriveRemoteKey('fn'), 'right-option') // default out-of-box
  assert.equal(deriveRemoteKey('right-option'), 'fn')
})

test('mutual exclusion: only one capture may start at a time', () => {
  const lock = new CaptureLock()
  assert.equal(lock.tryStart('dictation'), true)
  assert.equal(lock.tryStart('remote'), false) // blocked while dictation active
  assert.equal(lock.current, 'dictation')
  lock.end('dictation')
  assert.equal(lock.current, null)
  assert.equal(lock.tryStart('remote'), true) // free again
})

test('remote capture blocks a new dictation capture', () => {
  const lock = new CaptureLock()
  assert.equal(lock.tryStart('remote'), true)
  assert.equal(lock.tryStart('dictation'), false)
})

test('ending a non-active mode is a safe no-op', () => {
  const lock = new CaptureLock()
  lock.tryStart('remote')
  lock.end('dictation') // wrong mode — must not release remote's lock
  assert.equal(lock.current, 'remote')
})
