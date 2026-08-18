import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  recogniseAgentGesture,
  freshGestureState,
  DOUBLE_TAP_WINDOW_MS,
  type GestureAction,
  type GestureState,
} from './agentGesture'

/** Feed a sequence and collect what fired. `capturing` may change mid-run. */
function play(
  events: Array<[kind: 'down' | 'up' | 'other', at: number, capturing?: boolean]>,
): GestureAction[] {
  let state: GestureState = freshGestureState()
  const fired: GestureAction[] = []
  let capturing = false
  for (const [kind, at, cap] of events) {
    if (cap !== undefined) capturing = cap
    const result = recogniseAgentGesture(state, { kind, at }, capturing)
    state = result.state
    if (result.action) fired.push(result.action)
  }
  return fired
}

test('two clean taps inside the window start a capture', () => {
  assert.deepEqual(play([['down', 0], ['up', 60], ['down', 200], ['up', 260]]), ['start'])
})

// The window is the GAP BETWEEN TAPS — first release to second press — so
// this measures from the release at 60, not from the first press at 0.
test('two taps too far apart start nothing', () => {
  const secondPress = 60 + DOUBLE_TAP_WINDOW_MS + 50
  assert.deepEqual(play([['down', 0], ['up', 60], ['down', secondPress], ['up', secondPress + 60]]), [])
})

test('a tap followed by a press-and-hold still pairs', () => {
  const secondPress = 60 + DOUBLE_TAP_WINDOW_MS - 50
  assert.deepEqual(play([['down', 0], ['up', 60], ['down', secondPress], ['up', secondPress + 5_000]]), ['start'],
    'double-tap-and-hold is an ordinary way to start talking')
})

// SYMMETRIC: two taps to start, two to submit. A single tap while capturing
// does nothing, which is what stops a habitual double-tap-to-stop from opening
// a capture nobody asked for.
// Asymmetric on purpose: starting must not happen by accident, ending must not
// be hard.
test('a single tap while capturing submits', () => {
  assert.deepEqual(play([['down', 0, true], ['up', 60]]), ['submit'])
})

// THE RULE THAT MAKES THIS KEY USABLE AT ALL. Command is always held WITH
// another key — ⌘C, ⌘V, ⌘T. A press with any other key following it is a
// shortcut, not a tap, so the user's entire shortcut vocabulary is untouched
// and nothing is ever started speculatively.
test('a shortcut is not a tap', () => {
  assert.deepEqual(play([['down', 0], ['other', 20], ['up', 40], ['down', 120], ['other', 140], ['up', 160]]), [])
})

// The scratchpad must keep working mid-capture: copying during a recording is
// how material gets attached. If ⌘C submitted the turn, that would be lost.
test('copying during a capture does not submit it', () => {
  assert.deepEqual(play([['down', 0, true], ['other', 20], ['up', 40]]), [])
})

test('a shortcut between two taps breaks the pair', () => {
  assert.deepEqual(
    play([['down', 0], ['up', 40], ['down', 100], ['other', 110], ['up', 120], ['down', 180], ['up', 200]]),
    [],
    'the shortcut resets the sequence; the tap after it is only the first of a new pair',
  )
})

test('start then submit is the whole round trip', () => {
  assert.deepEqual(
    play([
      ['down', 0], ['up', 50], ['down', 150], ['up', 200],
      ['down', 3_000, true], ['up', 3_050],
    ]),
    ['start', 'submit'],
  )
})

// THE HANG. Double-tapping to stop, because that is how you started, must not
// leave a capture running behind you.
// A stray tap after submitting is only the FIRST of a pair, so it cannot start
// anything on its own.
test('a stray tap after submitting starts nothing', () => {
  assert.deepEqual(
    play([
      ['down', 0], ['up', 50], ['down', 150], ['up', 200],   // start
      ['down', 3_000, true], ['up', 3_050],                  // submit
      ['down', 3_300, false], ['up', 3_350],                 // stray
    ]),
    ['start', 'submit'],
  )
})

// A tap is a press released with nothing in between; how long it was held is
// not information the user is trying to convey.
test('a long press alone is still a tap', () => {
  assert.deepEqual(play([['down', 0], ['up', 2_000], ['down', 2_100], ['up', 4_000]]), ['start'])
})

// Three taps must not start twice — the second pair has to begin from a clean
// slate, or a nervous double-tap becomes start-then-immediately-something-else.
test('a third tap does not start a second capture', () => {
  assert.deepEqual(
    play([['down', 0], ['up', 40], ['down', 120], ['up', 160], ['down', 240], ['up', 280]]),
    ['start'],
  )
})

test('a lone tap on its own never starts anything', () => {
  assert.deepEqual(play([['down', 0], ['up', 60]]), [])
})
