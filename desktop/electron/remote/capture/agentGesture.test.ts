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

// TAKING A SCREENSHOT MID-UTTERANCE MUST NOT SUBMIT IT.
//
// ⌘⌃⇧4 begins as right Command plus two modifiers. Those arrive through
// flagsChanged and never reach keyDown, so for a while nothing spoiled the
// gesture and the release read as a clean tap — which submitted the Agent
// capture the user was still speaking into. The native listener now emits a
// chord when a modifier JOINS a held right Command; this is the receiving end.
test('a modifier joining right Command spoils the tap, so a screenshot cannot submit', () => {
  let state = freshGestureState()
  state = recogniseTap(state, { kind: 'down', at: 0 }).state        // right Command
  state = recogniseTap(state, { kind: 'other', at: 10 }).state      // Shift joins
  state = recogniseTap(state, { kind: 'other', at: 20 }).state      // Control joins
  const released = recogniseTap(state, { kind: 'up', at: 400 })

  assert.equal(released.tap, false, 'a chord is a shortcut, never a tap')
})

test('the spoil does not outlive its own gesture', () => {
  let state = freshGestureState()
  state = recogniseTap(state, { kind: 'down', at: 0 }).state
  state = recogniseTap(state, { kind: 'other', at: 10 }).state
  state = recogniseTap(state, { kind: 'up', at: 100 }).state

  // The very next press is a clean one and must be honoured, or a single
  // screenshot would disable the Agent until relaunch.
  state = recogniseTap(state, { kind: 'down', at: 500 }).state
  assert.equal(recogniseTap(state, { kind: 'up', at: 560 }).tap, true)
})
