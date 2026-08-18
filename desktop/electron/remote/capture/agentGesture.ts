/**
 * The Unmute Agent's invocation gesture: double-tap right-Command to start,
 * a single tap to submit.
 *
 * WHY A GESTURE AND NOT A KEY. No key on a Mac keyboard is free — every one is
 * either load-bearing or stateful. fn and right-Option are taken; right-Control
 * and F13+ do not exist on Apple laptops; Shift is held constantly while
 * typing; Caps Lock is a trap, because a mistaken press starts a capture AND
 * turns caps on, Escape cancels the capture but not the caps, and pressing it
 * again to fix that starts another capture. So the question was never which
 * unused key, only how to share one safely.
 *
 * THE RULE THAT MAKES IT SAFE. Command is always held WITH another key —
 * there is no application anywhere in which Command alone, tapped twice, means
 * something. So: a press followed by any other key is a shortcut, never a tap.
 * The user's whole shortcut vocabulary is untouched, and because nothing starts
 * until the second tap is confirmed, no capture is ever begun speculatively and
 * no pill has to be un-painted.
 *
 * The same rule governs the submit tap, which is what keeps the scratchpad
 * alive: copying with ⌘C during a recording attaches material, and must not be
 * mistaken for "I'm finished".
 */

/** Two taps must land inside this to count as a pair. Tunable. */
export const DOUBLE_TAP_WINDOW_MS = 350

export type GestureEventKind =
  /** The bound modifier went down. */
  | 'down'
  /** The bound modifier came up. */
  | 'up'
  /** Any other key, while the modifier was held — i.e. this is a shortcut. */
  | 'other'

export interface GestureEvent {
  kind: GestureEventKind
  at: number
}

export type GestureAction = 'start' | 'submit'

export interface GestureState {
  /** The modifier is currently held. */
  held: boolean
  /** Another key arrived during this hold, so it can no longer be a tap. */
  spoiled: boolean
  /** When the last clean tap completed, or null if there is no pending one. */
  lastTapAt: number | null
  /** This hold began inside the window, so releasing it completes a pair. */
  pairing: boolean
}

export function freshGestureState(): GestureState {
  return { held: false, spoiled: false, lastTapAt: null, pairing: false }
}

export function recogniseAgentGesture(
  state: GestureState,
  event: GestureEvent,
  capturing: boolean,
  windowMs: number = DOUBLE_TAP_WINDOW_MS,
): { state: GestureState; action: GestureAction | null } {
  switch (event.kind) {
    case 'down': {
      // The window is the GAP BETWEEN TAPS, measured here at the second press
      // — not at its release. Otherwise a tap followed by a press-and-hold
      // fails for being held too long, when double-tap-and-hold is a perfectly
      // ordinary way to start talking.
      const pairing = state.lastTapAt !== null && event.at - state.lastTapAt <= windowMs
      return { state: { ...state, held: true, spoiled: false, pairing }, action: null }
    }

    case 'other':
      // A shortcut. It spoils the current hold AND discards any pending first
      // tap: someone who taps, then uses a shortcut, has moved on.
      return { state: { ...state, spoiled: true, lastTapAt: null, pairing: false }, action: null }

    case 'up': {
      if (!state.held || state.spoiled) {
        return { state: { ...state, held: false, spoiled: false, pairing: false }, action: null }
      }
      // A clean tap.
      if (capturing) {
        return { state: freshGestureState(), action: 'submit' }
      }
      if (state.pairing) {
        // Reset rather than remember: a third tap must begin a new pair, not
        // immediately pair with the second and start again.
        return { state: freshGestureState(), action: 'start' }
      }
      return { state: { held: false, spoiled: false, lastTapAt: event.at, pairing: false }, action: null }
    }
  }
}
