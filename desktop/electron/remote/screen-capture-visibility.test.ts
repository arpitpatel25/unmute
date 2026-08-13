import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { screenCaptureVisibility } from './screen-capture-visibility'

describe('screenCaptureVisibility', () => {
  test('a missing preference keeps every Unmute surface visible in captures', () => {
    assert.deepEqual(screenCaptureVisibility(undefined), {
      show: true,
      command: { type: 'screenCaptureVisibility', show: true },
    })
  })

  test('only an explicit false hides Unmute surfaces from captures', () => {
    assert.deepEqual(screenCaptureVisibility(false), {
      show: false,
      command: { type: 'screenCaptureVisibility', show: false },
    })
    assert.equal(screenCaptureVisibility(true).show, true)
  })
})
