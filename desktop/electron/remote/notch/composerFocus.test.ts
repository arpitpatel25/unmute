import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { nextFocusedComposer } from './composerFocus'

const A = 'task-a'
const B = 'task-b'

describe('nextFocusedComposer', () => {
  test('a composer taking focus becomes the focused one', () => {
    assert.equal(nextFocusedComposer(null, { kind: 'focus', taskId: A }), A)
  })

  test('focus moving to another composer replaces it', () => {
    assert.equal(nextFocusedComposer(A, { kind: 'focus', taskId: B }), B)
  })

  test('a blur from the focused composer clears it', () => {
    assert.equal(nextFocusedComposer(A, { kind: 'blur', taskId: A }), null)
  })

  // A late blur from a composer that already lost focus must not clear whoever
  // holds it now — that would silently send the NEXT image to the wrong place.
  test('a blur from a different composer is ignored', () => {
    assert.equal(nextFocusedComposer(B, { kind: 'blur', taskId: A }), B)
  })

  // THE BUG. AppKit only calls resignFirstResponder when focus moves inside the
  // same window, so clicking away to another app never produced a blur. Every
  // way of leaving the surface must therefore clear it on its own.
  test('leaving the surface clears it, with no blur required', () => {
    assert.equal(nextFocusedComposer(A, { kind: 'surface-left' }), null)
  })

  test('showing a different task clears it', () => {
    assert.equal(nextFocusedComposer(A, { kind: 'surface-changed', taskId: B }), null)
  })

  test('showing the cockpit rather than any task clears it', () => {
    assert.equal(nextFocusedComposer(A, { kind: 'surface-changed', taskId: null }), null)
  })

  test('re-showing the SAME task keeps it — that is not leaving', () => {
    assert.equal(nextFocusedComposer(A, { kind: 'surface-changed', taskId: A }), A)
  })

  test('the window losing key clears it', () => {
    assert.equal(nextFocusedComposer(A, { kind: 'window-unfocused' }), null)
  })

  test('the focused task going away clears it', () => {
    assert.equal(nextFocusedComposer(A, { kind: 'task-gone', taskId: A }), null)
  })

  test('another task going away leaves it alone', () => {
    assert.equal(nextFocusedComposer(A, { kind: 'task-gone', taskId: B }), A)
  })

  test('clearing when nothing is focused stays null', () => {
    assert.equal(nextFocusedComposer(null, { kind: 'surface-left' }), null)
  })
})
