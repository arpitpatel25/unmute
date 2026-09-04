// The three capture lanes, and what happens when you press one while another
// is recording.
//
// THE INPUT LAYER HAS NEVER HAD A TEST. keyboard.ts could not be imported in
// this repo at all until wired-tree-setup.mjs (see its header), so every lane
// transition in the app people actually type through was covered by nothing.
// That is the gap this file closes, and it is the reason it is worth more than
// the feature it was written for: the failures it guards against are the ones
// that have actually shipped — a lane that latches with no capture behind it,
// so the NEXT press does nothing and says nothing; two lanes live at once, with
// ownership of an utterance decided a minute later by whichever flag survived;
// a stop that reaches a capture which no longer exists.
//
// Run with `npm run test:keyboard`.

import test, { describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { KeyboardManager } from './keyboard'
import type { KeyEvent } from './keyListener'
import { setRemoteTriggerEntitled, setRemoteTriggerUserPref } from './remoteTriggerGate'

interface Emitted { type: string; [k: string]: unknown }

/** A manager with both gates open and every lane idle. */
function fresh(): { km: KeyboardManager; events: Emitted[] } {
  setRemoteTriggerEntitled(true)
  setRemoteTriggerUserPref(true)
  const km = new KeyboardManager()
  km.setActivationMode('tap-toggle')
  km.setUnmuteAgentAvailable(true)
  const events: Emitted[] = []
  km.on('keyboard', (e: Emitted) => events.push(e))
  return { km, events }
}

const key = (km: KeyboardManager, e: string) => km.handleKey(e as unknown as KeyEvent)

/** fn, one tap. */
function fn(km: KeyboardManager): void { key(km, 'fn-down'); key(km, 'fn-up') }
/** right-Option, one tap. */
function opt(km: KeyboardManager): void { key(km, 'right-option-down'); key(km, 'right-option-up') }
/** right-Command, one clean tap (down then up with nothing in between). */
function cmdTap(km: KeyboardManager): void { key(km, 'right-command-down'); key(km, 'right-command-up') }
/** The Agent's start gesture: two clean taps inside the pairing window. */
function cmdDouble(km: KeyboardManager): void { cmdTap(km); cmdTap(km) }

/** Lane flags as emitKeyState reports them — what the NEXT press will see. */
function state(events: Emitted[]): Emitted {
  const last = [...events].reverse().find((e) => e.type === 'key-state')
  assert.ok(last, 'no key-state was emitted')
  return last
}
const liveLanes = (events: Emitted[]): string[] => {
  const s = state(events)
  return [
    s.dictationActive ? 'cursor' : null,
    s.remoteActive ? 'task' : null,
    s.agentActive ? 'agent' : null,
  ].filter(Boolean) as string[]
}
const lifecycle = (events: Emitted[]): string[] =>
  events.map((e) => e.type).filter((t) => t !== 'key-state')

describe('the pocket chord — right Command held, right Option tapped', () => {
  // The native listener decides this, not keyboard.ts: it sees right Command
  // already down when right Option arrives, so it emits `pocket-chord` and
  // withholds the Remote key's own down/up entirely. What this file can prove
  // is the half that matters here — that the chord disturbs neither lane.
  test('opens no capture and latches nothing', () => {
    const { km, events } = fresh()
    key(km, 'right-command-down')
    key(km, 'right-command-chord')   // right Option joining is itself a chord
    key(km, 'pocket-chord')
    key(km, 'right-command-up')
    assert.deepEqual(liveLanes(events), [], 'no lane may go live')
    assert.deepEqual(lifecycle(events), ['pocket-chord'],
      'not a capture: no start, no stop, no route change')
  })

  test('the Agent stands down rather than submitting', () => {
    const { km, events } = fresh()
    cmdDouble(km)
    assert.deepEqual(liveLanes(events), ['agent'], 'an Agent capture is running')
    // Now chord into the pocket while it is still recording. The release must
    // NOT read as the clean single tap that submits — the same failure the
    // screenshot chord caused, and the reason right-command-chord exists.
    key(km, 'right-command-down')
    key(km, 'right-command-chord')
    key(km, 'pocket-chord')
    key(km, 'right-command-up')
    assert.deepEqual(liveLanes(events), ['agent'], 'still recording, not submitted')
  })

  test('right Option ALONE is still an ordinary task capture', () => {
    // The whole reason the chord is Command-FIRST: Option keeps its zero-
    // latency key-down start, so nothing here may change.
    const { km, events } = fresh()
    opt(km)
    assert.deepEqual(liveLanes(events), ['task'])
    opt(km)
    assert.deepEqual(lifecycle(events), ['remote-start', 'remote-stop'])
  })
})

describe('starting and submitting one lane — unchanged behaviour', () => {
  test('fn opens and closes a cursor capture', () => {
    const { km, events } = fresh()
    fn(km)
    assert.deepEqual(liveLanes(events), ['cursor'])
    fn(km)
    assert.deepEqual(liveLanes(events), [])
    assert.deepEqual(lifecycle(events), ['session-start', 'session-stop', 'chain-expired'])
  })

  test('right-Option opens and closes a task capture', () => {
    const { km, events } = fresh()
    opt(km)
    assert.deepEqual(liveLanes(events), ['task'])
    opt(km)
    assert.deepEqual(liveLanes(events), [])
    assert.deepEqual(lifecycle(events), ['remote-start', 'remote-stop'])
  })

  test('the Agent needs two taps to start and one to stop', () => {
    const { km, events } = fresh()
    cmdTap(km)
    assert.deepEqual(liveLanes(events), [], 'a lone tap arms nothing')
    cmdTap(km)
    assert.deepEqual(liveLanes(events), ['agent'])
    cmdTap(km)
    assert.deepEqual(liveLanes(events), [])
    assert.deepEqual(lifecycle(events), ['agent-start', 'agent-stop'])
  })
})

describe('switching lanes while the mic is hot', () => {
  test('every pair of lanes hands the capture over, and only one is ever live', () => {
    const { km, events } = fresh()
    fn(km)
    assert.deepEqual(liveLanes(events), ['cursor'])
    opt(km)
    assert.deepEqual(liveLanes(events), ['task'], 'cursor → task')
    cmdDouble(km)
    assert.deepEqual(liveLanes(events), ['agent'], 'task → agent')
    fn(km)
    assert.deepEqual(liveLanes(events), ['cursor'], 'agent → cursor')
    cmdDouble(km)
    assert.deepEqual(liveLanes(events), ['agent'], 'cursor → agent')
    opt(km)
    assert.deepEqual(liveLanes(events), ['task'], 'agent → task')
  })

  test('a switch emits capture-route and NOTHING that starts or stops a session', () => {
    const { km, events } = fresh()
    fn(km)
    events.length = 0
    opt(km)
    assert.deepEqual(lifecycle(events), ['capture-route'])
    assert.equal(events.find((e) => e.type === 'capture-route')?.route, 'task')
  })

  test('many switches then one submit produce exactly one stop, for the final lane', () => {
    const { km, events } = fresh()
    fn(km)
    for (let i = 0; i < 25; i++) { opt(km); cmdDouble(km); fn(km) }
    // Land on the task lane, then submit there.
    opt(km)
    events.length = 0
    opt(km)
    const stops = lifecycle(events).filter((t) => t.endsWith('-stop') || t === 'session-stop')
    assert.deepEqual(stops, ['remote-stop'], 'one stop, addressed to the lane it ended on')
    assert.deepEqual(liveLanes(events), [], 'and nothing is left live')
  })

  test('a capture opened by a HELD key keeps the held-key stop after switching to fn', () => {
    // right-Option is physically down for its capture, so its stop has to
    // release the modifier and settle before synthesising the selection grab.
    // Submitting on fn must not lose that: Cmd+C landing while Option is still
    // down becomes Cmd+Opt+C, and Chrome answers with DevTools.
    const { km, events } = fresh()
    opt(km)
    fn(km)                       // switch to the cursor
    events.length = 0
    fn(km)                       // submit
    assert.deepEqual(lifecycle(events), ['remote-stop'],
      'the held-key stop shape, not session-stop/chain-expired')
  })

  test('a capture opened on fn and submitted on fn still takes the plain path', () => {
    const { km, events } = fresh()
    fn(km)
    opt(km)
    fn(km)                       // back to the cursor
    events.length = 0
    fn(km)
    assert.deepEqual(lifecycle(events), ['session-stop', 'chain-expired'])
  })
})

describe('the locks always come back — the failure that makes the NEXT press dead', () => {
  test('after any switch sequence, the next capture starts clean', () => {
    const { km, events } = fresh()
    fn(km); opt(km); cmdDouble(km); fn(km); opt(km)
    opt(km)                      // submit
    km.resetState()              // what onSessionEnded does
    events.length = 0
    fn(km)
    assert.deepEqual(liveLanes(events), ['cursor'])
    assert.deepEqual(lifecycle(events), ['session-start'])
  })

  test('resetState clears every lane however many switches preceded it', () => {
    const { km, events } = fresh()
    fn(km); opt(km); cmdDouble(km)
    km.resetState()
    assert.deepEqual(liveLanes(events), [])
    events.length = 0
    // And the Agent's pending-tap state went with it: one tap must not now
    // pair with a tap from before the reset and start something unasked.
    cmdTap(km)
    assert.deepEqual(liveLanes(events), [])
  })

  test('onCaptureEnded clears task and agent, and leaves dictation alone', () => {
    // Dictation is deliberately the way out when another lane is wedged.
    const { km, events } = fresh()
    opt(km)
    km.onCaptureEnded()
    assert.deepEqual(liveLanes(events), [])
    const second = fresh()
    fn(second.km)
    second.km.onCaptureEnded()
    assert.deepEqual(liveLanes(second.events), ['cursor'])
  })

  test('an unavailable Agent never latches its lane', () => {
    // THE PRE-EXISTING BUG. The availability check lived downstream, so the
    // lane locked with no capture behind it and no session whose ending could
    // clear it — right-Option then refused until some unrelated dictation ran.
    const { km, events } = fresh()
    km.setUnmuteAgentAvailable(false)
    cmdDouble(km)
    assert.deepEqual(liveLanes(events), [], 'nothing latched')
    assert.ok(events.some((e) => e.type === 'agent-ignored' && e.reason === 'not-available'))
    events.length = 0
    opt(km)
    assert.deepEqual(liveLanes(events), ['task'], 'and the other lane still works')
  })

  test('a task capture can always be stopped, even after its gate goes off', () => {
    const { km, events } = fresh()
    opt(km)
    setRemoteTriggerUserPref(false)   // the user turns Remote off mid-capture
    events.length = 0
    opt(km)
    assert.deepEqual(lifecycle(events), ['remote-stop'], 'submit outranks the gate')
    assert.deepEqual(liveLanes(events), [])
  })

  test('a gated-off task lane refuses to start without latching', () => {
    const { km, events } = fresh()
    setRemoteTriggerUserPref(false)
    opt(km)
    assert.deepEqual(liveLanes(events), [])
    assert.deepEqual(lifecycle(events), [])
  })
})

describe('the modes that deliberately do not switch', () => {
  for (const mode of ['push-to-talk', 'double-tap-push'] as const) {
    test(`${mode}: a live task capture refuses the fn key, exactly as before`, () => {
      const { km, events } = fresh()
      km.setActivationMode(mode)
      opt(km)
      events.length = 0
      key(km, 'fn-down')
      assert.deepEqual(liveLanes(events), ['task'], 'still the task lane')
      assert.deepEqual(lifecycle(events), [], 'and nothing was emitted')
    })
  }

  test('Caps Lock owns the mic: no lane may start or switch under it', () => {
    const { km, events } = fresh()
    key(km, 'caps-down')            // Instruct begins
    assert.equal(state(events).instructionActive, true)
    events.length = 0
    opt(km)
    cmdDouble(km)
    assert.deepEqual(liveLanes(events), [], 'neither lane took the mic')
    assert.ok(!lifecycle(events).includes('remote-start'))
    assert.ok(!lifecycle(events).includes('agent-start'))
  })
})
