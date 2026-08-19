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

/** A clean tap: pressed and released with no other key in between. */
export interface TapResult {
  state: GestureState
  /** True on release of a press that nothing spoiled. */
  tap: boolean
}

export interface GestureState {
  /** The modifier is currently held. */
  held: boolean
  /** Another key arrived during this hold, so it can no longer be a tap. */
  spoiled: boolean
}

export function freshGestureState(): GestureState {
  return { held: false, spoiled: false }
}

/**
 * WHAT THIS DELIBERATELY DOES NOT KNOW: whether a capture is running.
 *
 * It used to take a `capturing` flag and decide start-vs-submit itself. That
 * moved the question "am I already recording?" out of the handler that owns the
 * flag — and on the lane that works, right-Option, answering that question
 * FIRST is the property that makes a live capture always stoppable. Losing it
 * produced five starts against one stop.
 *
 * So: this reports taps. The handler decides what a tap means, in the same
 * order right-Option uses.
 */
export function recogniseTap(state: GestureState, event: GestureEvent): TapResult {
  switch (event.kind) {
    case 'down':
      return { state: { held: true, spoiled: false }, tap: false }
    case 'other':
      // A shortcut. This hold can never be a tap.
      return { state: { ...state, spoiled: true }, tap: false }
    case 'up': {
      const clean = state.held && !state.spoiled
      return { state: freshGestureState(), tap: clean }
    }
  }
}
