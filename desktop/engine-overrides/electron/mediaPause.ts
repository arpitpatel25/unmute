// Pause whatever is playing for the length of a dictation, and put it back.
//
// WHY: audio from the speakers reaches the microphone and lands in the
// transcript. The user should not have to stop their podcast, dictate, and
// start it again — Unmute can do that, and undo it.
//
// WHY IT NEEDS AN ADAPTER: macOS has no public way to pause another app's
// audio. Apple's own answer is ducking (lower the volume), not pausing, and in
// 15.4 it put the private MediaRemote framework behind an entitlement — the
// symbol still resolves for an ordinary app and the callback answers nil
// (measured on 26.2). The bundled mediaremote-adapter reaches it through
// /usr/bin/perl, a system binary macOS still permits. Same approach VoiceInk,
// FluidVoice and TypeWhisper ship.
//
// WHY NOT THE MEDIA KEY: simulating play/pause is a TOGGLE, and without state
// there is no way to know whether it will pause something or START Apple Music.
// That failure is documented upstream and was reproduced here. Reading state
// first is the whole reason this is safe.
//
// THE RULE THIS ENCODES: end in the state the user left, never one Unmute
// invented. We only ever undo our own pause, and only if the world still looks
// the way we left it.

/** MRCommand ids. The TOGGLE (2) is deliberately absent — see above. */
export const MR_PLAY = 0
export const MR_PAUSE = 1

export type MediaAction = 'pause' | 'resume' | 'none'

export interface NowPlaying {
  playing: boolean
  bundleIdentifier?: string
}

export function mediaActionOnCaptureStart(o: { enabled: boolean; audioPlaying: boolean }): MediaAction {
  if (!o.enabled) return 'none'
  // Nothing playing means nothing to pause — and a command sent into that
  // silence is how other implementations start music nobody asked for.
  return o.audioPlaying ? 'pause' : 'none'
}

export function mediaActionOnCaptureEnd(
  o: { wePaused: boolean; audioPlaying: boolean; heldByUser?: boolean },
): MediaAction {
  // A HOLD OUTRANKS A CAPTURE. The user asked for quiet and has not taken it
  // back; handing their audio to them because a dictation happened to end is
  // Unmute inventing a state, which is the one thing this file forbids. The
  // hold's own release is the only thing that lifts it.
  if (o.heldByUser) return 'none'
  // Never restore something we did not stop: if nothing was playing when the
  // dictation began, there is nothing of the user's to bring back.
  if (!o.wePaused) return 'none'
  // Audio is playing again without us — the user started something mid-sentence.
  // Resuming now would be a second player, not a restoration.
  if (o.audioPlaying) return 'none'
  return 'resume'
}

/**
 * Read one now-playing report from the adapter's stdout.
 *
 * Everything here is untrusted: it is a child process reading a private
 * framework through perl, so a malformed line, a missing field, or no session
 * at all must read as "nothing is playing". This runs on the capture path and
 * must never throw.
 */
export function parseNowPlaying(stdout: string): NowPlaying | null {
  const text = stdout.trim()
  if (!text) return null
  try {
    const d = JSON.parse(text) as Record<string, unknown>
    if (!d || typeof d !== 'object') return null
    return {
      // Absent is NOT playing. Guessing the other way would have us "resume"
      // something that was never running.
      playing: d.playing === true,
      ...(typeof d.bundleIdentifier === 'string' ? { bundleIdentifier: d.bundleIdentifier } : {}),
    }
  } catch {
    return null
  }
}

/**
 * The user asked for quiet, on demand, and will ask for it back.
 *
 * Same rule as a capture pause and for the same reason: a command sent into
 * silence is how a naive implementation starts music nobody asked for. So a
 * hold placed when nothing is playing holds NOTHING — there is no debt to
 * record and nothing to give back later.
 */
export function mediaActionOnHold(o: { heldByUser: boolean; audioPlaying: boolean }): MediaAction {
  if (o.heldByUser) return 'none'
  return o.audioPlaying ? 'pause' : 'none'
}

/**
 * Give the room back.
 *
 * Called both when the user presses the control again and when they close the
 * surface they pressed it on — leaving someone's audio muted because a card
 * went away would be the same broken promise as leaving it paused after a
 * dictation.
 */
export function mediaActionOnRelease(o: { heldByUser: boolean; audioPlaying: boolean }): MediaAction {
  if (!o.heldByUser) return 'none'
  // They started something themselves while it was held. Resuming now would
  // be a second player, not a restoration.
  if (o.audioPlaying) return 'none'
  return 'resume'
}
