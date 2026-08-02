// HANDING IMAGES OVER A SINGLE-SLOT PASTEBOARD, ONE AT A TIME, WITHOUT LOSING
// THE TEXT THAT WENT FIRST.
//
// Delivery already writes text and synthesises ⌘V. Adding images means writing
// the pasteboard again and posting ⌘V again, and the pasteboard is ONE SLOT:
// two writes and two pastes in sequence interleave in three ways, all of them
// observed on this codebase before:
//
//   * TEXT LOST — the image write lands before the target app has served the
//     text's ⌘V, so the ⌘V pastes the image and the words never appear.
//   * IMAGE PASTED TWICE — the second image's ⌘V is served while the first
//     image is still what the system pasteboard holds.
//   * NOTHING PASTED — ⌘V posted before the write has propagated to the target
//     app's pasteboard view at all.
//
// The discipline is not new and is not invented here — it is the one
// `injectOutput` and the screenshot delivery it replaced already used
// (adb845f, "deterministic pastes — instant text, child-verified images"):
//
//   1. SETTLE after the text's ⌘V before touching the pasteboard again. The
//      keystroke API returns when the event is POSTED, not when the target app
//      has served it; nothing may overwrite the text inside that gap.
//   2. PRE-CLEAR before each image. This is what makes step 3 sound: with the
//      slot emptied first, a PNG of the right size can only be OURS. Without
//      it, a second image the same byte-size as the first would "verify"
//      instantly against the first — the double-paste, exactly.
//   3. VERIFY FROM ANOTHER PROCESS. An own-process read reflects our own write
//      immediately and proves nothing about what the target app can see. A
//      child asks the SYSTEM pasteboard. Bounded, never a hang: on timeout we
//      paste anyway, because a late image beats no image.
//   4. PASTE, then settle again before the next one.
//   5. RESTORE THE TEXT at the end, so the user's clipboard holds what they
//      dictated rather than the last screenshot — and so the next dictation
//      does not re-discover the image.
//
// EVERY PASTEBOARD WRITE ANNOUNCES ITSELF, SYNCHRONOUSLY. `noteOwnWrite` reads
// the change counter AT CALL TIME; the clipboard watcher polls every 250ms, so
// an `await` between a write and its record lets a poll observe OUR OWN write
// as a user copy — which becomes an insert in the transcript. That has already
// been a Critical on this branch. Hence the deps below expose write-and-record
// as ONE step: there is no way to call one without the other, and the ordering
// is a property of the type rather than of anyone's memory.
//
// Pure orchestration: no electron, no clock, no child process. clipboard.ts
// supplies the real effects; pasteboardHandoff.test.ts supplies fakes and
// asserts the ORDER, which is the whole contract.

export interface HandoffDeps {
  /** Byte length of the PNG encoding, or null if the file is not an image we
   *  can read. Read BEFORE the pasteboard is touched — encoding a Retina PNG
   *  takes milliseconds, and doing it between the clear and the write would
   *  widen the window this module exists to close. */
  pngBytes: (path: string) => number | null
  /** Empty the pasteboard AND record that the change was ours, in that order,
   *  with nothing in between. */
  clearAndRecord: () => void
  /** Write the image AND record that the change was ours, likewise. */
  writeImageAndRecord: (path: string) => void
  /** Write the text AND record that the change was ours, likewise. */
  writeTextAndRecord: (text: string) => void
  /** Ask ANOTHER process whether the system pasteboard serves a PNG of exactly
   *  this size. Resolves false on timeout; the caller pastes regardless. */
  verifyServesPNG: (bytes: number) => Promise<boolean>
  /** Post ⌘V. Resolves when the event is posted — NOT when it is served. */
  paste: () => Promise<void>
  /** Let the target app catch up. */
  settle: (ms: number) => Promise<void>
  /** Never throws out of the hand-off; a failed image must not cost the text. */
  warn: (message: string, err?: unknown) => void
}

/** Long enough for a target app to have served a posted ⌘V. The pre-branch
 *  delivery used 180ms between images and never reported a dropped one; the
 *  same number guards the text's paste, which is the same race. */
export const SETTLE_MS = 180

/** The verify is a poll against a child process. Bounded so a wedged osascript
 *  can never hold a dictation open — on expiry we paste anyway. */
export const VERIFY_TIMEOUT_MS = 900

/** Deliver `images` at the cursor, in order, after the text has been pasted.
 *
 *  `restoreText` is what the pasteboard is left holding — the delivered text,
 *  padded exactly as it was written, so the user's clipboard ends up with what
 *  they dictated. Returns how many images were actually pasted.
 *
 *  CALLED ONLY AFTER THE TEXT'S ⌘V HAS BEEN POSTED. It opens with a settle for
 *  precisely that reason, and does nothing at all when there is nothing to
 *  hand over — an ordinary dictation pays not one millisecond for this. */
export async function handOffImages(
  deps: HandoffDeps,
  images: readonly string[],
  restoreText: string,
): Promise<number> {
  if (!images.length) return 0

  // The text's ⌘V has been POSTED, not necessarily served. Nothing may touch
  // the pasteboard until the target app has had it.
  await deps.settle(SETTLE_MS)

  let pasted = 0
  for (const path of images) {
    let bytes: number | null = null
    try {
      bytes = deps.pngBytes(path)
    } catch (err) {
      deps.warn(`[clipboard] image unreadable, skipped: ${path}`, err)
      continue
    }
    if (!bytes) {
      deps.warn(`[clipboard] image unreadable, skipped: ${path}`)
      continue
    }
    try {
      deps.clearAndRecord()
      deps.writeImageAndRecord(path)
      await deps.verifyServesPNG(bytes)
      await deps.paste()
      pasted++
      await deps.settle(SETTLE_MS)
    } catch (err) {
      // One image failing must not abandon the rest, and must never reach the
      // dictation path. The text is already delivered.
      deps.warn(`[clipboard] image paste failed: ${path}`, err)
    }
  }

  // Leave the TEXT on the pasteboard, not the last screenshot — the clipboard
  // after a dictation holds what was dictated, and nothing lingers for the next
  // one to re-discover.
  try {
    deps.writeTextAndRecord(restoreText)
  } catch (err) {
    deps.warn('[clipboard] restoring the delivered text failed', err)
  }
  return pasted
}
