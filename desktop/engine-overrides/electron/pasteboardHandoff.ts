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
// MOST of the discipline is not new: steps 1, 3, 4 and 5 are what
// `injectOutput`'s screenshot delivery used before this branch deleted it
// (adb845f, "deterministic pastes — instant text, child-verified images").
// STEP 2 IS NEW, and it is called out as new on purpose — a reviewer who
// believes an unproven step is field-proven skips the smoke test it needs.
//
//   1. SETTLE after the text's ⌘V before touching the pasteboard again. The
//      keystroke API returns when the event is POSTED, not when the target app
//      has served it; nothing may overwrite the text inside that gap. [adb845f]
//   2. PRE-CLEAR before each image. NEW HERE — adb845f had no clear in its
//      image loop, and that left a real hole: it wrote image B straight over
//      image A and then asked the child whether the pasteboard served a PNG of
//      B's byte size. Two screenshots of the SAME byte size (trivially
//      possible — same display, same window, near-identical content) verify
//      instantly against A, and A is pasted twice. Emptying the slot first
//      makes a PNG of the right size necessarily ours.
//   3. VERIFY FROM ANOTHER PROCESS. An own-process read reflects our own write
//      immediately and proves nothing about what the target app can see. A
//      child asks the SYSTEM pasteboard. Bounded, never a hang: on timeout we
//      paste anyway, because a late image beats no image. [adb845f]
//   4. PASTE, then settle again before the next one. [adb845f]
//   5. RESTORE THE TEXT at the end, so the user's clipboard holds what they
//      dictated rather than the last screenshot — and so the next dictation
//      does not re-discover the image. [adb845f]
//
// The pre-clear is also why step 2's decode must happen BEFORE it. See
// `prepareImage`.
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

export interface HandoffDeps<Prepared = unknown> {
  /** DECODE ONCE, BEFORE THE PASTEBOARD IS TOUCHED. Returns the decoded image
   *  and the byte length of its PNG encoding, or null when the file is not an
   *  image we can read.
   *
   *  The handle is opaque here and is handed straight back to
   *  `writeImageAndRecord`, which is what makes the "once" structural rather
   *  than remembered. Decoding a second time inside the clear→write window
   *  would break this module twice over: a 5MB Retina screenshot takes tens of
   *  milliseconds to decode, all of it with the system pasteboard EMPTY; and if
   *  the second decode's PNG encoding differed from the first by a single byte,
   *  `verifySer­vesPNG` could never match, so every image would burn the full
   *  timeout and then paste anyway — silently, and slowly. */
  prepareImage: (path: string) => { image: Prepared; bytes: number } | null
  /** Empty the pasteboard AND record that the change was ours, in that order,
   *  with nothing in between. */
  clearAndRecord: () => void
  /** Write the ALREADY-DECODED image AND record that the change was ours,
   *  likewise. Takes the handle `prepareImage` produced — never a path, so
   *  there is nothing here that could decode again. */
  writeImageAndRecord: (image: Prepared) => void
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
export async function handOffImages<Prepared>(
  deps: HandoffDeps<Prepared>,
  images: readonly string[],
  restoreText: string,
): Promise<number> {
  if (!images.length) return 0

  // The text's ⌘V has been POSTED, not necessarily served. Nothing may touch
  // the pasteboard until the target app has had it.
  await deps.settle(SETTLE_MS)

  let pasted = 0
  for (const path of images) {
    // OUTSIDE the try that touches the pasteboard, and outside the clear→write
    // window by construction: the decode happens here, once, and the write
    // below is handed the result.
    let prepared: { image: Prepared; bytes: number } | null = null
    try {
      prepared = deps.prepareImage(path)
    } catch (err) {
      deps.warn(`[clipboard] image unreadable, skipped: ${path}`, err)
      continue
    }
    if (!prepared || !prepared.bytes) {
      deps.warn(`[clipboard] image unreadable, skipped: ${path}`)
      continue
    }
    try {
      deps.clearAndRecord()
      deps.writeImageAndRecord(prepared.image)
      await deps.verifyServesPNG(prepared.bytes)
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
