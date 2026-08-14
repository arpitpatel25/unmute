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
//      image A and then asked the child whether the pasteboard served a PNG.
//      Without the clear, A could satisfy B's readiness check and be pasted
//      twice. Emptying the slot first makes the next non-empty PNG necessarily
//      the representation produced by our B write.
//   3. VERIFY FROM ANOTHER PROCESS. An own-process read reflects our own write
//      immediately and proves nothing about what the target app can see. A
//      child asks the SYSTEM pasteboard. Bounded, never a hang: on timeout we
//      fail closed and retain the draft instead of posting a paste event whose
//      payload has not been proven readable. [adb845f]
//   4. PASTE, then settle again before the next one. [adb845f]
//   5. RESTORE THE TEXT at the end, so the user's clipboard holds what they
//      dictated rather than the last screenshot — and so the next dictation
//      does not re-discover the image. [adb845f]
//
// The pre-clear is also why step 2's decode must happen BEFORE it. See
// `prepareImage`.
//
// WHICH KEY step 4 posts is the one thing that varies by destination, and it
// varies for images only — see `imagePasteModifier`. Everything above holds
// identically either way; the modifier does not change the order, the count,
// or the pasteboard writes.
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

/** Which modifier the V keystroke is posted with. */
export type PasteModifier = 'command' | 'control'

/** TERMINAL EMULATORS, BEST EFFORT. An app that is not on this list gets ⌘V,
 *  which is what every destination has always got — so being wrong here can
 *  only mean "an unlisted terminal keeps today's behaviour", never "a normal
 *  app gets a keystroke it did not expect".
 *
 *  Kept as bundle identifiers rather than names because a name is localised
 *  and a bundle id is not. Add to it freely; it is not load-bearing for
 *  anything except which modifier an IMAGE paste uses. */
export const TERMINAL_BUNDLE_IDS: readonly string[] = [
  'com.apple.Terminal',
  'com.googlecode.iterm2',
  'com.mitchellh.ghostty',
  'com.github.wez.wezterm',
  'dev.warp.Warp-Stable',
  'dev.warp.Warp-Preview',
  'net.kovidgoyal.kitty',
  // Alacritty ships under BOTH ids depending on how it was built/installed;
  // listing only one silently leaves half its users on the ⌘V that does nothing.
  'io.alacritty',
  'org.alacritty',
]

/** THE ONE DECISION THIS FIX IS.
 *
 *  A coding-agent CLI (Claude Code, Codex — any TUI) does not receive images
 *  THROUGH the terminal. ⌘V is intercepted by the terminal emulator, which
 *  asks the pasteboard for TEXT and writes that to the TUI's stdin; an image
 *  has no text, so nothing arrives at all. Ctrl-V is not a terminal shortcut —
 *  it passes through as the control character, the TUI's own key handler
 *  catches it, reads the macOS pasteboard directly (it is a Node process) and
 *  ingests the image.
 *
 *  TEXT IS NOT AFFECTED, in a terminal or anywhere else: text already pastes
 *  into a terminal with ⌘V and that path is untouched. This governs the IMAGE
 *  steps only. An unknown or unreadable destination gets ⌘V. */
export function imagePasteModifier(bundleId: string | null): PasteModifier {
  return bundleId != null && TERMINAL_BUNDLE_IDS.includes(bundleId) ? 'control' : 'command'
}

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
  /** Ask ANOTHER process whether the system pasteboard serves a non-empty PNG.
   *  No source bytes are accepted here by design: macOS may legitimately
   *  transcode the representation, so byte equality is not its contract. */
  verifyServesPNG: () => Promise<boolean>
  /** Bundle identifier of the app about to receive the paste, or null when it
   *  cannot be read. Read ONCE per hand-off, and only when there are images —
   *  see `imagePasteModifier`. */
  frontmostBundleId: () => string | null
  /** Post V with this modifier held. Resolves when the event is posted — NOT
   *  when it is served. */
  paste: (modifier: PasteModifier) => Promise<void>
  /** Let the target app catch up. */
  settle: (ms: number) => Promise<void>
  /** Never throws out of the hand-off; a failed image must not cost the text. */
  warn: (message: string, err?: unknown) => void
  /** Optional dev diagnostics. It is observational only: a broken logger must
   * never interfere with clipboard delivery. */
  observe?: (stage: string, fields: Record<string, unknown>) => void
}

/** Long enough for a target app to have served a posted ⌘V. The pre-branch
 *  delivery used 180ms between images and never reported a dropped one; the
 *  same number guards the text's paste, which is the same race. */
export const SETTLE_MS = 180

/** The verify is a poll against a child process. Bounded so a wedged osascript
 *  can never hold a dictation open. */
export const VERIFY_TIMEOUT_MS = 900

/** True when macOS exposes a non-empty PNG representation to other processes.
 *
 * NSPasteboard is allowed to transcode an image after `writeImage`, so the PNG
 * bytes served here need not match `NativeImage.toPNG()`. The pre-clear/write
 * sequence proves ownership of the slot; this boundary proves readability. */
/**
 * ASK FOR ONE REPRESENTATION, NOT ALL OF THEM.
 *
 * The readiness check used a bare `clipboard info`, on the assumption that it
 * was "a tiny metadata listing". It is not: it enumerates every representation
 * and makes macOS GENERATE them — PNG, AVIF, 8BPS, GIF, JP2, JPEG, TIFF, BMP,
 * TPIC — and on a 1920x1080 screenshot that measures ~900ms. Each attempt is
 * capped at 400ms, so the child was killed every single time, the pasteboard
 * was declared unreadable, and the paste was skipped: a screenshot reply failed
 * with `cli-image-paste-not-accepted` while the image sat correctly on the
 * pasteboard the whole time. (The stray "Error creating a JP2 color space"
 * in those logs is macOS materialising a representation nobody asked for.)
 *
 * Scoping the query to the one representation this module parses measures
 * ~90ms — an order of magnitude inside the budget — and returns exactly the
 * same `«class PNGf», <bytes>` line.
 */
export const CLIPBOARD_PNG_INFO_SCRIPT = 'clipboard info for «class PNGf»'

export function pasteboardServesReadablePNG(info: string): boolean {
  const match = /«class PNGf»,\s*(\d+)/.exec(info)
  return !!match && Number(match[1]) > 0
}

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
  const observe = (stage: string, fields: Record<string, unknown> = {}) => {
    try { deps.observe?.(stage, fields) } catch { /* diagnostics never alter delivery */ }
  }

  // WHO IS RECEIVING THIS — read once, here, and never on a path that has no
  // images to hand over (the early return above is above this line on purpose).
  // The destination cannot change between images without the user switching
  // apps mid-delivery, which would break far more than the modifier.
  //
  // Fail to ⌘V on ANY trouble: an unreadable destination is an unknown one.
  let modifier: PasteModifier = 'command'
  try {
    modifier = imagePasteModifier(deps.frontmostBundleId())
  } catch (err) {
    deps.warn('[clipboard] could not read the frontmost app — pasting images with ⌘V', err)
  }
  observe('handoff-started', { images: images.length, modifier })

  // The text's ⌘V has been POSTED, not necessarily served. Nothing may touch
  // the pasteboard until the target app has had it.
  await deps.settle(SETTLE_MS)

  let pasted = 0
  for (const [index, path] of images.entries()) {
    // OUTSIDE the try that touches the pasteboard, and outside the clear→write
    // window by construction: the decode happens here, once, and the write
    // below is handed the result.
    let prepared: { image: Prepared; bytes: number } | null = null
    observe('image-prepare-started', { index, path })
    try {
      prepared = deps.prepareImage(path)
    } catch (err) {
      observe('image-prepare-failed', { index, path, error: err instanceof Error ? err.message : String(err) })
      deps.warn(`[clipboard] image unreadable, skipped: ${path}`, err)
      continue
    }
    if (!prepared || !prepared.bytes) {
      observe('image-prepare-failed', { index, path, error: 'unreadable-or-empty' })
      deps.warn(`[clipboard] image unreadable, skipped: ${path}`)
      continue
    }
    observe('image-prepared', { index, path, bytes: prepared.bytes })
    try {
      deps.clearAndRecord()
      deps.writeImageAndRecord(prepared.image)
      observe('pasteboard-written', { index, path, bytes: prepared.bytes })
      const verified = await deps.verifyServesPNG()
      observe('pasteboard-verified', { index, path, bytes: prepared.bytes, verified })
      if (!verified) {
        deps.warn(`[clipboard] system pasteboard did not expose a readable image: ${path}`)
        continue
      }
      await deps.paste(modifier)
      observe('paste-posted', { index, path, modifier })
      pasted++
      await deps.settle(SETTLE_MS)
      observe('image-settled', { index, path, settleMs: SETTLE_MS })
    } catch (err) {
      observe('image-paste-failed', { index, path, error: err instanceof Error ? err.message : String(err) })
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
    observe('clipboard-restored', { textChars: restoreText.length })
  } catch (err) {
    observe('clipboard-restore-failed', { error: err instanceof Error ? err.message : String(err) })
    deps.warn('[clipboard] restoring the delivered text failed', err)
  }
  observe('handoff-finished', { requested: images.length, pasted })
  return pasted
}
