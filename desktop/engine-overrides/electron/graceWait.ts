// The post-stop grace wait: what to do while processSession holds the
// processing lock waiting for audio IPC that may never arrive.
//
// WHY THIS IS ITS OWN MODULE. The wait used to ask one question — "has audio
// landed yet?" — and that blind spot cost users a ~5 second dead app. A silent
// recording is discarded by the RENDERER (it owns the speech gate), which
// clears the session and shows "Didn't catch that". MAIN was still inside this
// wait, holding the lock against a session nobody owned any more: every
// keypress in that window was refused, and when the window expired it fired a
// SECOND "Didn't catch that" for a session that had ended seconds earlier.
//
// So the wait has to ask a second question — "is this still my session?" — and
// that question is the whole reason this is a pure, tested function rather
// than another condition buried in a 3000-line class.
//
// Pure module: no electron, no I/O — unit-tested by graceWait.test.ts.

/**
 * How long to wait for audio IPC after the recorder stops.
 *
 * Sized for the phone path's worst case: Continuity pipe gate (≤3000ms) + tail
 * grace (300ms) + encoder flush + blob assembly. Mac audio lands in <100ms and
 * exits on arrival, so the width costs the fast path nothing.
 */
export const GRACE_WINDOW_MS = 4000

export type GraceVerdict =
  /** Audio is here — go process it. */
  | 'audio-arrived'
  /** The session ended under us (discarded/cancelled). Release the lock and say NOTHING. */
  | 'abandoned'
  /** Window spent with no audio — this really was an empty press; tell the user. */
  | 'gave-up'
  /** Still inside the window, still ours. */
  | 'keep-waiting'

export interface GraceState {
  /** Has the audio IPC for this session landed? */
  hasAudio: boolean
  /** Is the session we are waiting on STILL the live one? */
  stillCurrent: boolean
  elapsedMs: number
  windowMs: number
}

/**
 * Decide the next step of the grace wait.
 *
 * `stillCurrent` is checked FIRST and beats everything else: once a session has
 * been discarded or cancelled, neither its late audio nor its expired timer
 * speaks for it. That ordering is the fix — a verdict that let the timeout win
 * is what produced the phantom second "Didn't catch that".
 */
export function graceVerdict(s: GraceState): GraceVerdict {
  if (!s.stillCurrent) return 'abandoned'
  if (s.hasAudio) return 'audio-arrived'
  if (s.elapsedMs >= s.windowMs) return 'gave-up'
  return 'keep-waiting'
}
