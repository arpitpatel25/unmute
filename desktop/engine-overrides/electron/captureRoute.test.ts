import { test } from 'node:test'
import assert from 'node:assert/strict'

import { decidePress, routeOfLanes, type PressContext } from './captureRoute'

/** Tap-toggle, nothing gated off, Caps Lock idle — the ordinary world. */
function ctx(over: Partial<PressContext> = {}): PressContext {
  return {
    lane: 'cursor',
    live: null,
    instructionActive: false,
    activationMode: 'tap-toggle',
    laneAvailable: true,
    ...over,
  }
}

// ─── Nothing is recording: today's behaviour, exactly ───

test('an idle lane press starts that lane', () => {
  for (const lane of ['cursor', 'task', 'agent'] as const) {
    assert.equal(decidePress(ctx({ lane, live: null })), 'start')
  }
})

test('an idle press on a gated-off lane is ignored, never started', () => {
  assert.equal(decidePress(ctx({ lane: 'task', live: null, laneAvailable: false })), 'ignore')
  assert.equal(decidePress(ctx({ lane: 'agent', live: null, laneAvailable: false })), 'ignore')
})

// ─── SUBMIT IS UNCONDITIONAL. Nothing may stand between the user and
//     stopping their own capture — this is the property that has kept the
//     right-Option lane from ever wedging, and it must outrank every gate. ───

test('pressing the live lane submits, whatever else is true', () => {
  for (const lane of ['cursor', 'task', 'agent'] as const) {
    assert.equal(decidePress(ctx({ lane, live: lane })), 'submit')
    assert.equal(decidePress(ctx({ lane, live: lane, laneAvailable: false })), 'submit')
    assert.equal(decidePress(ctx({ lane, live: lane, instructionActive: true })), 'submit')
    assert.equal(decidePress(ctx({ lane, live: lane, activationMode: 'push-to-talk' })), 'submit')
  }
})

// ─── Switching ───

test('pressing a different lane switches to it', () => {
  const pairs: Array<[PressContext['live'], PressContext['lane']]> = [
    ['cursor', 'task'], ['cursor', 'agent'],
    ['task', 'cursor'], ['task', 'agent'],
    ['agent', 'cursor'], ['agent', 'task'],
  ]
  for (const [live, lane] of pairs) {
    assert.equal(decidePress(ctx({ live, lane })), 'switch', `${live} → ${lane}`)
  }
})

test('a switch into a gated-off lane is refused, and the capture keeps running', () => {
  assert.equal(decidePress(ctx({ live: 'cursor', lane: 'task', laneAvailable: false })), 'ignore')
  assert.equal(decidePress(ctx({ live: 'cursor', lane: 'agent', laneAvailable: false })), 'ignore')
})

test('a switch OUT of a lane is never gated — only the destination is', () => {
  // The task lane's own gate can go off mid-capture (the user flips the
  // session toggle). Leaving it must stay possible, or the capture is stranded.
  assert.equal(decidePress(ctx({ live: 'task', lane: 'cursor', laneAvailable: true })), 'switch')
  assert.equal(decidePress(ctx({ live: 'agent', lane: 'cursor', laneAvailable: true })), 'switch')
})

// ─── Push-to-talk and double-tap-push keep today's behaviour ───

test('no switch touches the cursor lane outside tap-toggle', () => {
  for (const activationMode of ['push-to-talk', 'double-tap-push'] as const) {
    // …into it
    assert.equal(decidePress(ctx({ live: 'task', lane: 'cursor', activationMode })), 'ignore')
    assert.equal(decidePress(ctx({ live: 'agent', lane: 'cursor', activationMode })), 'ignore')
    // …and out of it
    assert.equal(decidePress(ctx({ live: 'cursor', lane: 'task', activationMode })), 'ignore')
    assert.equal(decidePress(ctx({ live: 'cursor', lane: 'agent', activationMode })), 'ignore')
  }
})

test('task and agent still switch freely regardless of the fn activation mode', () => {
  // fn's mode is a property of the fn key. It has no business deciding whether
  // two other keys may hand a capture between them.
  for (const activationMode of ['push-to-talk', 'double-tap-push'] as const) {
    assert.equal(decidePress(ctx({ live: 'task', lane: 'agent', activationMode })), 'switch')
    assert.equal(decidePress(ctx({ live: 'agent', lane: 'task', activationMode })), 'switch')
  }
})

// ─── Caps Lock owns the mic ───

test('Instruct blocks starting and switching, but not submitting', () => {
  assert.equal(decidePress(ctx({ lane: 'task', live: null, instructionActive: true })), 'ignore')
  assert.equal(decidePress(ctx({ lane: 'agent', live: null, instructionActive: true })), 'ignore')
  assert.equal(decidePress(ctx({ lane: 'task', live: 'cursor', instructionActive: true })), 'ignore')
})

// ─── The derivation the keyboard reads its `live` from ───

test('routeOfLanes is single-valued and maps each lane flag to its route', () => {
  assert.equal(routeOfLanes({ dictation: false, remote: false, agent: false }), null)
  assert.equal(routeOfLanes({ dictation: true, remote: false, agent: false }), 'cursor')
  assert.equal(routeOfLanes({ dictation: false, remote: true, agent: false }), 'task')
  assert.equal(routeOfLanes({ dictation: false, remote: false, agent: true }), 'agent')
})

test('routeOfLanes reports the most restrictive lane if two are somehow set', () => {
  // Should be unreachable — applyRouteSwitch moves all three together. If it
  // ever happens, answering with a live lane keeps SUBMIT reachable, which is
  // the way out. Answering null would make the capture unstoppable.
  assert.notEqual(routeOfLanes({ dictation: true, remote: true, agent: false }), null)
})
