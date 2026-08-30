import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  mediaActionOnCaptureStart,
  mediaActionOnCaptureEnd,
  mediaActionOnHold,
  mediaActionOnRelease,
  parseNowPlaying,
  MR_PLAY,
  MR_PAUSE,
} from './mediaPause'

// Background audio bleeds from the speakers into the microphone and lands in
// the transcript. Pausing it for the length of a dictation removes that, but
// only if the pause is exactly reversible: the machine must end up in the state
// the user left it in, never a state Unmute invented.
//
// The reason this is a decision table rather than "just send pause" is that
// macOS gives no public way to pause another app, and the private MediaRemote
// framework has been entitlement-gated since 15.4. The adapter we bundle
// restores real state and real commands — but a caller that ignored state and
// sent a toggle would start Apple Music when nothing was playing, which is the
// documented failure of every naive implementation.
describe('deciding whether to pause background media', () => {
  test('pauses when the setting is on and something is playing', () => {
    assert.equal(mediaActionOnCaptureStart({ enabled: true, audioPlaying: true }), 'pause')
  })

  test('does nothing when nothing is playing', () => {
    assert.equal(mediaActionOnCaptureStart({ enabled: true, audioPlaying: false }), 'none')
  })

  test('does nothing when the user has not enabled the setting', () => {
    assert.equal(mediaActionOnCaptureStart({ enabled: false, audioPlaying: true }), 'none')
  })

  test('resumes on submit what it paused', () => {
    assert.equal(mediaActionOnCaptureEnd({ wePaused: true, audioPlaying: false }), 'resume')
  })

  test('never resumes what it did not pause', () => {
    assert.equal(mediaActionOnCaptureEnd({ wePaused: false, audioPlaying: false }), 'none')
  })

  test('leaves audio alone if the user started something during the dictation', () => {
    // We paused their podcast; they hit play on something else mid-sentence.
    // Resuming now would be a second player, not a restoration.
    assert.equal(mediaActionOnCaptureEnd({ wePaused: true, audioPlaying: true }), 'none')
  })
})

// The adapter prints one JSON object per query. It is a child process reading a
// private framework through perl, so every field is treated as untrusted: a
// malformed line, a missing key, or no session at all must read as "nothing is
// playing" and never throw on the capture path.
describe('reading what the adapter reports', () => {
  test('reads a playing session', () => {
    const np = parseNowPlaying('{"bundleIdentifier":"com.google.Chrome","playing":true,"title":"x"}')
    assert.deepEqual(np, { playing: true, bundleIdentifier: 'com.google.Chrome' })
  })

  test('reads a paused session as not playing', () => {
    assert.equal(parseNowPlaying('{"bundleIdentifier":"com.spotify.client","playing":false}')?.playing, false)
  })

  test('treats no session as nothing playing', () => {
    assert.equal(parseNowPlaying(''), null)
  })

  test('treats malformed output as nothing playing rather than throwing', () => {
    assert.equal(parseNowPlaying('not json at all'), null)
  })

  test('a session with no playing field is not assumed to be playing', () => {
    assert.equal(parseNowPlaying('{"bundleIdentifier":"com.apple.Music"}')?.playing, false)
  })
})

describe('the command codes sent to MediaRemote', () => {
  test('are the explicit play and pause commands, never the toggle', () => {
    // kMRPlay = 0, kMRPause = 1, kMRTogglePlayPause = 2. The toggle is the one
    // that starts music when nothing is playing; it must never appear here.
    assert.equal(MR_PLAY, 0)
    assert.equal(MR_PAUSE, 1)
  })
})

// A HOLD IS NOT A CAPTURE PAUSE. Dictation borrows your audio for a few
// seconds and hands it straight back; a hold is a choice the user made and
// keeps until they take it back or close the surface they made it on. The two
// share one adapter and must not undo each other — a dictation ending while a
// hold is in force is the case that would otherwise un-mute the user.
describe('holding background audio on demand', () => {
  test('pauses what is playing when the user asks for quiet', () => {
    assert.equal(mediaActionOnHold({ heldByUser: false, audioPlaying: true }), 'pause')
  })

  test('sends nothing into silence, so a hold cannot start playback', () => {
    assert.equal(mediaActionOnHold({ heldByUser: false, audioPlaying: false }), 'none')
  })

  test('a second hold is not a second pause', () => {
    assert.equal(mediaActionOnHold({ heldByUser: true, audioPlaying: true }), 'none')
  })

  test('releasing gives back exactly what the hold took', () => {
    assert.equal(mediaActionOnRelease({ heldByUser: true, audioPlaying: false }), 'resume')
  })

  test('releasing a hold nobody placed does nothing', () => {
    assert.equal(mediaActionOnRelease({ heldByUser: false, audioPlaying: false }), 'none')
  })

  test('does not resume when the user started something themselves', () => {
    assert.equal(mediaActionOnRelease({ heldByUser: true, audioPlaying: true }), 'none')
  })

  // THE INTERACTION THAT MATTERS. Mute the room, then dictate: the capture
  // ends and its resume would hand back the audio the user just silenced.
  test('a dictation ending never lifts a hold the user placed', () => {
    assert.equal(
      mediaActionOnCaptureEnd({ wePaused: true, audioPlaying: false, heldByUser: true }),
      'none',
    )
  })

  test('a dictation ending still resumes when no hold is in force', () => {
    assert.equal(
      mediaActionOnCaptureEnd({ wePaused: true, audioPlaying: false, heldByUser: false }),
      'resume',
    )
  })
})
