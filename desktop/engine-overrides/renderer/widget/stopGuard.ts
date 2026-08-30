// "IS THIS STOP A REAL ONE, OR THE ECHO?"
//
// Main sends `recording:stop` when a capture ends, and again ~1.3s later as
// part of its reset-state. The widget handled both the same way — a bare
// setState('processing') — so the echo re-armed the spinner AFTER the first
// stop's flow had already resolved to output/hidden, and nothing further was
// coming to clear it. The state then sat at `processing` until the next
// recording, and every unrelated change to the state object re-pushed it to
// the pill, which is why "Processing" reappeared minutes later with no
// keypress behind it.
//
// A stop only means something while a capture is actually in flight. This is
// that question, kept out of the component so it can be tested.

/** The widget's own state names. Declared as a plain string union rather than
 *  imported from ../shared/types so this module stays dependency-free and
 *  testable, and so WidgetApp — which already imports the real WidgetState —
 *  does not end up with two bindings of the same name. */
export type WidgetState = string

/**
 * States a stop has already been accounted for in. `processing` is the echo
 * itself; the rest are settled outcomes, and dragging any of them back to a
 * spinner would be the same bug wearing different clothes.
 */
const ALREADY_SETTLED: ReadonlySet<string> = new Set<string>([
  'processing', 'output', 'output-fallback', 'too-short', 'cancelled', 'error', 'hidden',
])

/**
 * Should this `recording:stop` be acted on?
 *
 * FAIL OPEN on a state this build does not recognise. A swallowed real stop
 * leaves a capture spinning forever, which is strictly worse than one
 * redundant transition — so anything not known to be settled is let through.
 */
export function acceptsRecordingStop(state: WidgetState): boolean {
  return !ALREADY_SETTLED.has(state)
}
