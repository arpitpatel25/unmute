import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { KeyboardManager } from './keyboard'
import type { KeyEvent } from './keyListener'

// The native chord events aren't in keyListener's exported KeyEvent union
// yet (see the NotesChordKeyEvent comment in keyboard.ts) — this cast is
// the test-side mirror of that same, deliberately-scoped workaround: the
// values are exactly what native-fn-listener emits at runtime.
type ChordEvent = 'left-control-down' | 'left-control-up' | 'left-option-down' | 'left-option-up'
const tap = (km: KeyboardManager, event: ChordEvent) => km.handleKey(event as unknown as KeyEvent)

/** One full press-and-release of both chord keys, control first. */
function pressReleaseChord(km: KeyboardManager): void {
  tap(km, 'left-control-down')
  tap(km, 'left-option-down')
  tap(km, 'left-control-up')
  tap(km, 'left-option-up')
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

describe('notes chord (left-Control + left-Option double-tap) — independent of the lock group', () => {
  test('double-tapping the chord starts notes; dictation/instruction/agent/remote stay false', () => {
    const km = new KeyboardManager()
    let startRequested = 0
    km.on('notes-start-requested', () => startRequested++)
    const state = captureKeyState(km)

    // First tap: press + release does nothing yet — just records the tap.
    pressReleaseChord(km)
    assert.equal(startRequested, 0)

    // Second tap within the double-tap window: this starts notes.
    tap(km, 'left-control-down')
    tap(km, 'left-option-down')

    assert.equal(startRequested, 1)

    // The key-state snapshot from that very engaging event shows every
    // other lane exactly as a fresh instance would report it — the notes
    // chord never touched them.
    const snap = state.last()
    assert.ok(snap)
    assert.equal(snap!.dictationActive, false)
    assert.equal(snap!.instructionActive, false)
    assert.equal(snap!.agentActive, false)
    assert.equal(snap!.remoteActive, false)
  })

  test('a second double-tap while notes is active requests a confirm, not a direct stop', () => {
    const km = new KeyboardManager()
    let startRequested = 0
    let stopConfirmRequested = 0
    let stopped = 0
    km.on('notes-start-requested', () => startRequested++)
    km.on('notes-stop-confirm-requested', () => stopConfirmRequested++)
    km.on('notes-stopped', () => stopped++)

    // Double-tap #1: start.
    pressReleaseChord(km)
    tap(km, 'left-control-down')
    tap(km, 'left-option-down')
    tap(km, 'left-control-up')
    tap(km, 'left-option-up')

    assert.equal(startRequested, 1)
    assert.equal(stopConfirmRequested, 0)

    // Double-tap #2 (its own fresh press/release pair, then the pair that
    // triggers it): requests a confirm instead of stopping directly.
    pressReleaseChord(km)
    tap(km, 'left-control-down')
    tap(km, 'left-option-down')

    assert.equal(startRequested, 1) // unchanged — this is a stop request, not a restart
    assert.equal(stopConfirmRequested, 1)
    assert.equal(stopped, 0) // confirmNotesStop() was never called — nothing stopped directly

    // The owning confirm-dialog flow (out of scope for this task) is what
    // actually stops it.
    km.confirmNotesStop()
    assert.equal(stopped, 1)
  })

  test('the notes chord fires while dictation is genuinely active, and leaves it active', () => {
    const km = new KeyboardManager()
    let startRequested = 0
    km.on('notes-start-requested', () => startRequested++)
    const state = captureKeyState(km)

    // Start a REAL dictation capture via the existing fn-key path
    // (default activationMode is tap-toggle, default dictationKey is fn).
    km.handleKey('fn-down' as KeyEvent)
    assert.equal(state.last()!.dictationActive, true)

    // Double-tap the notes chord while dictation is live.
    pressReleaseChord(km)
    tap(km, 'left-control-down')
    tap(km, 'left-option-down')

    assert.equal(startRequested, 1) // notes started
    // Dictation is untouched — still active, exactly as it was before the
    // chord. This is the independence guarantee: notes neither blocked on
    // dictation nor cleared it.
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
