// Part of the default `npm test` run.
//
// IT WAS NOT, AND COULD NOT BE, UNTIL NOW. keyboard.ts imports its POST-WIRE
// path './paywall/remote/capture/agentGesture', which does not exist in this
// repo — engine-overrides/electron/ and electron/remote/ are sibling trees, and
// only build/wire-into-engine.sh's copy puts one inside the other. So this file
// failed to load before a single test ran, was excluded from the default glob,
// and its dedicated `test:notetaker-keyboard` script had never passed either.
//
// wired-tree-setup.mjs maps those post-wire prefixes back for test runs, so
// keyboard.ts loads and these tests execute. See that file's header.

import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { KeyboardManager } from './keyboard'
import type { KeyEvent } from './keyListener'

// The native trigger events aren't in keyListener's exported KeyEvent union
// yet (see the NotesChordKeyEvent comment in keyboard.ts) — this cast is
// the test-side mirror of that same, deliberately-scoped workaround: the
// values are exactly what native-fn-listener emits at runtime.
type NotesEvent = 'left-control-down' | 'left-control-up' | 'notes-chord-spoil'
const tap = (km: KeyboardManager, event: NotesEvent) => km.handleKey(event as unknown as KeyEvent)

/** One full press-and-release of the notes key — a single clean tap. */
function pressRelease(km: KeyboardManager): void {
  tap(km, 'left-control-down')
  tap(km, 'left-control-up')
}

/** Reads the fields emitKeyState() puts on every 'keyboard' event —
 *  the exact snapshot the existing mutual-exclusion guards would see. */
interface KeyStateSnapshot {
  type: string
  dictationActive: boolean
  instructionActive: boolean
  remoteActive: boolean
  agentActive: boolean
}
function captureKeyState(km: KeyboardManager): { last(): KeyStateSnapshot | undefined } {
  let last: KeyStateSnapshot | undefined
  km.on('keyboard', (e: unknown) => {
    const snap = e as KeyStateSnapshot
    if (snap.type === 'key-state') last = snap
  })
  return { last: () => last }
}

describe('notes key (left-Control, double-tap start / single-tap stop) — independent of the lock group', () => {
  test('double-tapping left Control starts notes; dictation/instruction/agent/remote stay false', () => {
    const km = new KeyboardManager()
    let startRequested = 0
    km.on('notes-start-requested', () => startRequested++)
    const state = captureKeyState(km)

    // First tap: press + release does nothing yet — just records the tap.
    pressRelease(km)
    assert.equal(startRequested, 0)

    // Second tap within the double-tap window: this starts notes.
    pressRelease(km)
    assert.equal(startRequested, 1)

    // The key-state snapshot from that very engaging event shows every
    // other lane exactly as a fresh instance would report it — the notes
    // key never touched them.
    const snap = state.last()
    assert.ok(snap)
    assert.equal(snap!.dictationActive, false)
    assert.equal(snap!.instructionActive, false)
    assert.equal(snap!.agentActive, false)
    assert.equal(snap!.remoteActive, false)
  })

  test('a key pressed while Control is held spoils that hold — it never completes as a tap', () => {
    const km = new KeyboardManager()
    let startRequested = 0
    km.on('notes-start-requested', () => startRequested++)

    // Held while a real Ctrl+<key> shortcut fires — spoiled, releases as
    // no tap at all (recogniseTap: held && !spoiled is false on release).
    tap(km, 'left-control-down')
    tap(km, 'notes-chord-spoil') // e.g. Ctrl+C
    tap(km, 'left-control-up')

    // A single genuinely clean tap after that is only the FIRST of a pair —
    // the spoiled hold contributed nothing to pair against.
    pressRelease(km)
    assert.equal(startRequested, 0)

    // A second clean tap now completes the pair.
    pressRelease(km)
    assert.equal(startRequested, 1)
  })

  test('a single clean tap while notes is active emits notes-stop-requested — not a double-tap, no dialog', () => {
    const km = new KeyboardManager()
    let startRequested = 0
    let stopRequested = 0
    km.on('notes-start-requested', () => startRequested++)
    km.on('notes-stop-requested', () => stopRequested++)

    // Double-tap to start.
    pressRelease(km)
    pressRelease(km)
    assert.equal(startRequested, 1)
    assert.equal(stopRequested, 0)

    // ONE clean tap while active fires the stop event — not a double-tap,
    // no confirm event, nothing else in between. What that event actually
    // DOES (arm an undo window, cancel one, or finalize) is
    // NotetakerController's own state machine, exercised in
    // notetakerController.test.ts, not this key's.
    pressRelease(km)
    assert.equal(stopRequested, 1)
    assert.equal(startRequested, 1) // unchanged — this was a stop, not a restart
  })

  test('the stop tap is never debounced — it always goes through immediately after start', () => {
    const km = new KeyboardManager()
    let stopRequested = 0
    km.on('notes-stop-requested', () => stopRequested++)

    pressRelease(km)
    pressRelease(km) // starts
    pressRelease(km) // stops, in the same tick — DEBOUNCE_MS only gates START

    assert.equal(stopRequested, 1)
  })

  test('confirmNotesStop() is the sole writer that clears notesActive', () => {
    const km = new KeyboardManager()
    let stopRequested = 0
    let stopped = 0
    km.on('notes-stop-requested', () => stopRequested++)
    km.on('notes-stopped', () => stopped++)

    pressRelease(km)
    pressRelease(km) // start
    pressRelease(km) // stop-requested, but notesActive is still true until confirmed
    assert.equal(stopRequested, 1)
    assert.equal(stopped, 0)

    // Owning module (notetakerInit.ts) calls this once session.stop() has
    // actually run. A fresh double-tap after this can start a new session —
    // subject to the same START-only debounce the Agent key already has
    // (DEBOUNCE_MS since the last toggle), not exercised here since it needs
    // real elapsed time rather than a mockable clock.
    km.confirmNotesStop()
    assert.equal(stopped, 1)
  })

  test('the notes key fires while dictation is genuinely active, and leaves it active', () => {
    const km = new KeyboardManager()
    let startRequested = 0
    km.on('notes-start-requested', () => startRequested++)
    const state = captureKeyState(km)

    // Start a REAL dictation capture via the existing fn-key path
    // (default activationMode is tap-toggle, default dictationKey is fn).
    km.handleKey('fn-down' as KeyEvent)
    assert.equal(state.last()!.dictationActive, true)

    // Double-tap the notes key while dictation is live.
    pressRelease(km)
    pressRelease(km)

    assert.equal(startRequested, 1) // notes started
    // Dictation is untouched — still active, exactly as it was before the
    // notes key fired. This is the independence guarantee: notes neither
    // blocked on dictation nor cleared it.
    assert.equal(state.last()!.dictationActive, true)
  })

  test('existing dictation/remote/agent mutual exclusion is unchanged (no regression)', () => {
    const km = new KeyboardManager()
    const state = captureKeyState(km)

    // Start dictation.
    km.handleKey('fn-down' as KeyEvent)
    assert.equal(state.last()!.dictationActive, true)

    // Right Command (Agent) double-tap should still be locked out while
    // dictation is active — mirrors the pre-existing exclusion, untouched
    // by this task.
    let agentIgnored = false
    km.on('keyboard', (e: unknown) => {
      const evt = e as { type?: string }
      if (evt.type === 'agent-ignored') agentIgnored = true
    })
    km.handleKey('right-command-down' as KeyEvent)
    km.handleKey('right-command-up' as KeyEvent)
    km.handleKey('right-command-down' as KeyEvent)
    km.handleKey('right-command-up' as KeyEvent)
    assert.equal(agentIgnored, true)
    assert.equal(state.last()!.agentActive, false)
  })
})
