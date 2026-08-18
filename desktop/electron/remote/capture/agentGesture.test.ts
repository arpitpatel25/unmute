import { test } from 'node:test'
import assert from 'node:assert/strict'
import { recogniseTap, freshGestureState, type GestureState } from './agentGesture'

/** Feed a sequence, collect which releases counted as clean taps. */
function taps(events: Array<['down' | 'up' | 'other', number]>): boolean[] {
  let state: GestureState = freshGestureState()
  const out: boolean[] = []
  for (const [kind, at] of events) {
    const r = recogniseTap(state, { kind, at })
    state = r.state
    if (kind === 'up') out.push(r.tap)
  }
  return out
}

test('press and release with nothing between is a tap', () => {
  assert.deepEqual(taps([['down', 0], ['up', 60]]), [true])
})

// THE RULE THAT MAKES RIGHT-COMMAND USABLE. It is always held WITH another key
// — ⌘C, ⌘V, ⌘T — so a press followed by anything else is a shortcut, never a
// tap. The user's whole shortcut vocabulary is untouched.
test('a shortcut is not a tap', () => {
  assert.deepEqual(taps([['down', 0], ['other', 20], ['up', 40]]), [false])
})

test('the next press is clean again', () => {
  assert.deepEqual(taps([['down', 0], ['other', 10], ['up', 20], ['down', 100], ['up', 140]]), [false, true])
})

test('a release with no press is not a tap', () => {
  assert.deepEqual(taps([['up', 0]]), [false])
})

// Duration carries no meaning: a tap is a press released with nothing in
// between, however long it was held.
test('a long press alone is still a tap', () => {
  assert.deepEqual(taps([['down', 0], ['up', 5_000]]), [true])
})

// WHAT THIS MUST NOT KNOW: whether a capture is running. It used to take a
// `capturing` flag and decide start-versus-submit, which moved "am I already
// recording?" away from the handler that owns the flag — and answering that
// FIRST is the property that keeps a live capture stoppable. Five starts
// against one stop is what losing it looked like.
test('it reports taps and holds no opinion about recording', () => {
  const signature = recogniseTap.length
  assert.equal(signature, 2, 'state and event only — no capturing flag')
})
