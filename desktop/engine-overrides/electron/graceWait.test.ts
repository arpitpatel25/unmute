// Tests for the post-stop grace wait — the window where processSession holds
// the processing lock while it waits for audio IPC that may never arrive.
//
// The bug these pin (field-observed 2026-08-29, console-2026-08-29.log around
// 10:11:39Z): a silent recording is discarded by the RENDERER while the MAIN
// process is still inside this wait. discardSession showed "Didn't catch that"
// and cleared the session, but the wait kept running against a session nobody
// owned any more — holding the lock for the full window. Every keypress in
// those ~4.9s was swallowed with "BLOCKED — Fn pressed during processing", and
// when the window finally expired it fired a SECOND "Didn't catch that" out of
// nowhere. The user could only start again after that phantom pill.
//
// The rule: a wait whose session is gone is ABANDONED — release the lock, stay
// silent (the discard already spoke), and never let the timeout speak for a
// session that ended.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { graceVerdict, GRACE_WINDOW_MS } from './graceWait'

const waiting = { hasAudio: false, stillCurrent: true, elapsedMs: 0, windowMs: GRACE_WINDOW_MS }

describe('graceVerdict', () => {
  it('keeps waiting while the session is live and no audio has landed', () => {
    assert.equal(graceVerdict(waiting), 'keep-waiting')
  })

  it('proceeds as soon as audio arrives', () => {
    assert.equal(graceVerdict({ ...waiting, hasAudio: true }), 'audio-arrived')
  })

  it('gives up once the window is spent', () => {
    assert.equal(graceVerdict({ ...waiting, elapsedMs: GRACE_WINDOW_MS }), 'gave-up')
  })

  it('ABANDONS when the session was discarded under it — the swallowed-keypress bug', () => {
    assert.equal(graceVerdict({ ...waiting, stillCurrent: false }), 'abandoned')
  })

  it('abandonment beats a spent window — the timeout must not speak for a discarded session', () => {
    assert.equal(
      graceVerdict({ ...waiting, stillCurrent: false, elapsedMs: GRACE_WINDOW_MS }),
      'abandoned'
    )
  })

  it('abandonment beats late audio — it belongs to a session that is over', () => {
    assert.equal(
      graceVerdict({ ...waiting, stillCurrent: false, hasAudio: true }),
      'abandoned'
    )
  })

  it('the window is wide enough for the phone path it exists for', () => {
    // 3000ms pipe gate + 300ms tail grace + encoder flush + assembly.
    assert.ok(GRACE_WINDOW_MS >= 3300, `window ${GRACE_WINDOW_MS}ms is too tight for the phone path`)
  })
})
