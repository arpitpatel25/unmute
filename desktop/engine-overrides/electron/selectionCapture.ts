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

/** Whether an absent selection should fall back to the user's pasteboard.
 *
 *  The question is what the text is FOR, and the mode alone cannot answer it:
 *  a Remote capture reuses the dictation pipeline wholesale and is started as
 *  `startSession('dictation', 'remote')`, so it arrives here calling itself
 *  dictation. That is why this takes the kind too — deriving the answer from
 *  `mode === 'instruction'` alone is what left Remote dispatches unable to see
 *  anything the user had copied.
 *
 *  ON when we are gathering context to hand to something that will read it —
 *  an instruction, or an agent on the other end of a Remote dispatch. The user
 *  copied a paragraph and then spoke about it; the pasteboard is the only place
 *  that paragraph still exists.
 *
 *  OFF for plain dictation, which pastes at a cursor. There, an absent
 *  selection means the user wants their words and nothing else, and quietly
 *  prepending whatever sat on the pasteboard would corrupt every utterance. */
export function shouldUseClipboardFallback(
  mode: 'dictation' | 'instruction',
  kind: 'dictation' | 'remote',
): boolean {
  return mode === 'instruction' || kind === 'remote'
}

/** Copy the frontmost selection, restoring the user's pasteboard either way.
 *
 *  `useClipboardFallback` decides what happens when there is no selection: the
 *  caller is gathering context to send somewhere (an instruction, a Remote
 *  dispatch) and the pasteboard is a reasonable second guess, or it is plain
 *  dictation about to paste at a cursor, where silently prepending the
 *  pasteboard to every utterance is the corruption this whole design exists to
 *  prevent. It is never inferred here. */
export async function captureSelection(
  deps: SelectionCaptureDeps,
  { useClipboardFallback }: { useClipboardFallback: boolean },
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
  if (useClipboardFallback && hasContent(saved)) return { text: saved, source: 'clipboard' }
  return { text: null, source: 'none' }
}
