// WHICH TEXT BOX IS UNMUTE'S OWN, RIGHT NOW — and, more importantly, when it
// stops being.
//
// Dictation hands captured images straight to a focused Unmute composer instead
// of posting a synthetic ⌘V, because the keystroke did not reach the notch. That
// needs to know which composer has focus, and the first version of it tracked
// that with a single flag set by a `composerFocus` event and cleared only by a
// matching `focused:false`.
//
// That clear NEVER ARRIVED. AppKit calls resignFirstResponder only when focus
// moves to another responder INSIDE THE SAME WINDOW; clicking away to Chrome
// leaves the text view first responder of a window that merely stopped being
// key. So one click into a task composer pinned the flag for the life of the
// process, and from then on every dictated screenshot was handed to that draft
// instead of pasted where the user was actually typing. In the field: 5 focus
// events, 0 blur events, and a day where 7 images were staged and 0 pasted.
//
// The repair is not a better blur. It is to stop treating focus as a latch that
// only its own counterpart can release: EVERY way of leaving that composer
// clears it, and each of those is a signal the controller already has. A stale
// yes here silently eats a user's screenshot, so the bias is to forget.

/** Everything that can change which composer owns the caret. */
export type ComposerFocusEvent =
  /** A composer's text view became first responder. */
  | { kind: 'focus'; taskId: string }
  /** A composer's text view resigned first responder (same-window moves only). */
  | { kind: 'blur'; taskId: string }
  /** The user left the surface entirely — pocket closed, collapsed, walked away. */
  | { kind: 'surface-left' }
  /** The surface now shows this task, or the cockpit when null. */
  | { kind: 'surface-changed'; taskId: string | null }
  /** The notch window is no longer key. The event AppKit would not give us. */
  | { kind: 'window-unfocused' }
  /** The task was closed, killed, or dismissed. */
  | { kind: 'task-gone'; taskId: string }

/** Fold one event into the focused-composer id. Pure, so the whole policy is
 *  one table a test can hold, rather than assignments scattered over handlers. */
export function nextFocusedComposer(
  current: string | null,
  e: ComposerFocusEvent,
): string | null {
  switch (e.kind) {
    case 'focus':
      return e.taskId
    case 'blur':
      // Ignore a late blur from a composer that has already handed focus on —
      // clearing there would send the NEXT image to the wrong place.
      return current === e.taskId ? null : current
    case 'task-gone':
      return current === e.taskId ? null : current
    case 'surface-changed':
      // Re-rendering the same task is not leaving it; anything else is.
      return current !== null && e.taskId === current ? current : null
    case 'surface-left':
    case 'window-unfocused':
      return null
  }
}
