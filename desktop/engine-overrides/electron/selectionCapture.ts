// GRABBING THE TEXT THE USER MEANT TO SEND, WITHOUT KEEPING THEIR PASTEBOARD.
//
// The sequence is fixed: save the slot, clear it, ask the frontmost app to copy
// its selection, read what landed, put the user's slot back. The clear is what
// makes "nothing arrived" distinguishable from "the same thing is still there";
// the restore is what makes the whole thing invisible to the user.
//
// WHY THIS IS ITS OWN MODULE. The fallback below used to live inside the
// `catch` of the real implementation, so it ran ONLY when the synthetic ⌘C
// threw — i.e. only when Accessibility was missing. On the far more common
// path, where ⌘C runs fine and simply finds nothing selected, the function
// returned null without ever consulting it. A user who had copied a paragraph
// and then spoke got their words alone: the paragraph was read, cleared,
// restored, and discarded. The two outcomes are the same outcome — no
// selection — and they now share one exit rather than one being a branch of
// error handling.
//
// Pure orchestration: no electron, no clock. clipboard.ts supplies the real
// effects; selectionCapture.test.ts supplies fakes and asserts the ORDER,
// because the order is the part that can silently eat a user's pasteboard.

/** How long to let the target app serve the synthetic ⌘C before reading. The
 *  keystroke API returns when the event is POSTED, not when it is served. */
export const COPY_SETTLE_MS = 150

export interface SelectionCaptureDeps {
  readClipboardText: () => string
  /** Write and record as ONE step. A write that skips its record is
   *  indistinguishable from a user copy to the clipboard watcher, and becomes
   *  an insert in the transcript. */
  writeTextAndRecord: (text: string) => void
  simulateCopy: () => Promise<void>
  settle: (ms: number) => Promise<void>
}

export interface SelectionCaptureResult {
  text: string | null
  /** Which channel produced it — carried out so the caller can label the text
   *  honestly (a quote the user highlighted is not the same claim as whatever
   *  happened to be on their pasteboard) and so the log says which one ran. */
  source: 'selection' | 'clipboard' | 'none'
}

function hasContent(s: string | null | undefined): s is string {
  return !!s && s.trim() !== ''
}

/** Copy the frontmost selection, restoring the user's pasteboard either way.
 *
 *  A selection is read; the pasteboard is never used as a stand-in for one.
 *  See the note at the return below. */
export async function captureSelection(
  deps: SelectionCaptureDeps,
): Promise<SelectionCaptureResult> {
  const saved = deps.readClipboardText()

  // Clear first, so anything read afterwards is necessarily what the copy
  // produced rather than what was already sitting there.
  deps.writeTextAndRecord('')

  let selected = ''
  try {
    await deps.simulateCopy()
    await deps.settle(COPY_SETTLE_MS)
    selected = deps.readClipboardText()
  } catch {
    // Accessibility not granted, or the helper died. Indistinguishable from an
    // empty selection as far as the caller is concerned — both mean we have no
    // selection and must decide whether the pasteboard stands in for one.
    selected = ''
  }

  // The user's slot goes back before any decision, on every path. Returning
  // early from a branch that had not yet restored is how the pasteboard gets
  // eaten.
  deps.writeTextAndRecord(saved)

  if (hasContent(selected)) return { text: selected, source: 'selection' }
  // NOTHING FROM BEFORE THE TRIGGER. A capture is the window between the key
  // going down and the utterance being submitted, and only what happens inside
  // it is intent.
  //
  // The pasteboard used to stand in for an absent selection, guarded by "is
  // this our own residue?". The guard could not hold: it compared strings, and
  // delivery pads, polishes and chunks its output, so any of those made our own
  // last dictation look like the user's material. On 19 August a dictation to
  // one lane was silently prepended to the next Agent request, which acted on
  // it and dispatched a task the user never asked for.
  //
  // Ours-versus-theirs was the wrong question anyway. Text copied an hour ago
  // and already used is exactly as irrelevant as our own leftovers, and no
  // amount of ownership detection rejects it. Recency cannot separate them
  // either — our residue is seconds old too.
  //
  // So the pasteboard is no longer consulted at all. A copy made DURING the
  // capture is seen by clipboardWatch and placed where it happened; a copy made
  // before it belongs to whatever the user was doing then. The cost is having
  // to trigger first and copy second, which is visible and recoverable — where
  // the silent prepend was neither.
  return { text: null, source: 'none' }
}
