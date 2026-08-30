import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { acceptsRecordingStop, endsOnRemoteDispatch, type WidgetState } from './stopGuard'

// THE SEQUENCE THIS FILE EXISTS TO PREVENT, taken verbatim from
// console-2026-08-30.log on a live machine:
//
//   15:30:17.650  recording:stop  (state was dictation-active)   real capture ends
//   15:30:18.915  recording:stop  (state was processing)         main's reset-state, 1.3s later
//   15:33:29.620  push {"state":"processing"}                    no keypress
//   15:34:13.074  push {"state":"processing"}                    no keypress
//   15:37:24.622  recording:start (state was processing)         7 min on, STILL processing
//
// Counted over that one day: 78 stops from a real recording, 56 duplicates
// arriving when the state was ALREADY processing, and 56 subsequent starts
// that found the state still stuck. 56 = 56 — every duplicate stuck, none
// recovered on its own. It is not a race; it is the ordinary path.
//
// onRecordingStop called setState('processing') unconditionally, so the second
// stop re-armed processing AFTER the first stop's flow had already resolved to
// output/hidden — and nothing further was coming to clear it. The pill then
// reappeared minutes later whenever an unrelated field changed and the whole
// state object was re-pushed.

describe('a second recording:stop is an echo, not a new capture', () => {
  it('accepts the stop that ends a real dictation', () => {
    assert.equal(acceptsRecordingStop('dictation-active'), true)
  })

  it('accepts the stop that ends an instruction capture', () => {
    assert.equal(acceptsRecordingStop('instruction-active'), true)
  })

  it('accepts the stop that ends a chained capture', () => {
    assert.equal(acceptsRecordingStop('chained'), true)
  })

  // The bug, directly.
  it('ignores a stop that arrives when the capture has already stopped', () => {
    assert.equal(acceptsRecordingStop('processing'), false)
  })

  // Everything downstream of processing is a settled outcome. A late echo must
  // not drag any of them back to a spinner.
  it('never drags a settled outcome back into processing', () => {
    for (const settled of ['output', 'output-fallback', 'too-short', 'cancelled', 'error'] as const) {
      assert.equal(acceptsRecordingStop(settled), false, `${settled} must not re-enter processing`)
    }
  })

  it('ignores a stop with nothing on screen at all', () => {
    assert.equal(acceptsRecordingStop('hidden'), false)
  })

  /**
   * A state this build has never seen must not silently swallow a real stop —
   * leaving a capture spinning forever is worse than one redundant transition.
   */
  it('lets an unrecognised state through rather than swallowing a real stop', () => {
    assert.equal(acceptsRecordingStop('some-future-state' as WidgetState), true)
  })
})

// A REMOTE CAPTURE HAS NO OUTPUT EVENT, and that is the other half of the
// phantom. The widget's terminal events — output:ready, output-fallback,
// output-error, cancelled, too-short — are all DICTATION outcomes, i.e. "text
// was pasted". A right-Option capture dispatches to a task instead, so none of
// them ever fire and the state sits at `processing` forever. Main hides the
// native pill on its own timer, which makes it LOOK finished, but the widget
// never agrees — so any later change to the state object re-pushes
// `processing` and the pill comes back.
//
// Field record, dev.4 (2026-08-30T16:22:10Z): the stop guard correctly ignored
// the echo, and the capture still never resolved. Last widget event of the day.
describe('a dispatched remote capture is finished', () => {
  it('ends a capture that is waiting on an outcome', () => {
    assert.equal(endsOnRemoteDispatch('processing'), true)
  })

  // The dispatch confirmation can land while the mic is still open on the NEXT
  // capture. Ending that one would hide a live recording.
  it('never ends a recording that is still running', () => {
    for (const live of ['dictation-active', 'instruction-active', 'chained'] as const) {
      assert.equal(endsOnRemoteDispatch(live), false, `${live} is still capturing`)
    }
  })

  // A settled outcome already said something truer than "done".
  it('does not overwrite an outcome the user has already been shown', () => {
    for (const settled of ['output', 'output-fallback', 'too-short', 'cancelled', 'error', 'hidden'] as const) {
      assert.equal(endsOnRemoteDispatch(settled), false, `${settled} is already settled`)
    }
  })
})
