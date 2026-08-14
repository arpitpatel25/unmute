// "Have we already accounted for this?" — asked two ways.
//
// THIS MODULE IS THE POINT OF THE REWRITE. The old ledger tried to RECOGNISE
// our own clipboard writes by hashing image bytes, and to reject stale content
// by snapshotting the pasteboard before a capture. Both are inference, both are
// fragile, and both are why the shipped feature misfires.
//
// Here neither question is inferred:
//
//   * OUR OWN WRITES. Every Unmute pasteboard write records the changeCount it
//     produced. A recorded value is skipped. Not "probably ours" — ours, by
//     construction.
//
//   * DUPLICATES. A screenshot tool configured to write a file AND copy fires
//     both detectors for one user action. Content is claimed once within a
//     short window, so one action yields one insert.
//
// Staleness is not handled here because it cannot occur: provenance is a
// changeCount TRANSITION observed inside a consented window, so an image that
// was already on the pasteboard produces no transition and is never a
// candidate.

/** One physical action can reach both detectors; 2s comfortably covers the gap
 *  between a file write and the pasteboard write, without merging two
 *  deliberate copies of the same thing.
 *
 *  THIS NUMBER IS FOR THE IMAGE CASE and is sized by it: a screenshot tool
 *  writes a PNG to disk and then writes the pasteboard, and those two can be
 *  most of a second apart on a slow disk with a large capture. */
export const DEDUP_WINDOW_MS = 2000

/** TEXT IS A DIFFERENT RACE AND GETS A DIFFERENT WINDOW.
 *
 *  What text dedup guards is one application writing several pasteboard
 *  flavours for a single ⌘C — plain, HTML, public.url — and that is a
 *  synchronous burst inside one event loop turn on the source side: sub-100ms,
 *  observed at 60ms and 310ms apart through a 250ms poll. Nothing about it
 *  needs two seconds.
 *
 *  Sharing the image window made the cost real in the other direction: copy a
 *  string, paste it, copy the SAME string again a second later because you
 *  moved the cursor — a completely ordinary thing to do — and the second copy
 *  vanished. 500ms covers the multi-flavour burst several times over while
 *  leaving a deliberate re-copy alone. */
export const TEXT_DEDUP_WINDOW_MS = 500

/** THE DEDUP HALF, ON ITS OWN.
 *
 *  The own-write skip set belongs to the clipboard watcher: it is the only
 *  thing that writes it (noteOwnWrite, immediately after an Unmute pasteboard
 *  write) and the only thing that reads it (shouldObserve). The dedup half is
 *  claimed somewhere else entirely — capture/index's recordInsert, the one
 *  point the two detectors converge — and handing THAT call site a whole
 *  Ledger gave it an `ownWrites` set nothing could ever write: dead state that
 *  reads as a second, silently-empty skip set. A caller that only dedups takes
 *  this instead. */
export interface Claims {
  /** When this content was claimed, and by which detector — see claimContent. */
  claims: Map<string, { atMs: number; detector?: string }>
  dedupWindowMs: number
}

export function createClaims(dedupWindowMs: number = DEDUP_WINDOW_MS): Claims {
  return { claims: new Map(), dedupWindowMs }
}

export interface Ledger extends Claims {
  ownWrites: Set<number>
}

export function createLedger(dedupWindowMs: number = DEDUP_WINDOW_MS): Ledger {
  return { ownWrites: new Set(), ...createClaims(dedupWindowMs) }
}

/** Called immediately after any Unmute write to the pasteboard, with the
 *  changeCount that write produced. */
export function noteOwnWrite(l: Ledger, changeCount: number): void {
  l.ownWrites.add(changeCount)
}

/** The default is to capture: anything we did not cause is the user's. */
export function shouldObserve(l: Ledger, changeCount: number): boolean {
  return !l.ownWrites.has(changeCount)
}

/** True if this content is new enough to become an insert. False means another
 *  detector — or another flavour of the same copy — already claimed the same
 *  user action.
 *
 *  `windowMs` overrides the map's default for THIS claim, because the two
 *  things being deduped are different races with different timescales (see
 *  DEDUP_WINDOW_MS and TEXT_DEDUP_WINDOW_MS). The map stays one map: it is
 *  keyed on content, and the window is a property of the question being asked,
 *  not of the storage. */
export function claimContent(
  l: Claims,
  hash: string,
  atMs: number,
  windowMs?: number,
  /**
   * WHICH DETECTOR SAW IT — the only thing that separates one action from two.
   *
   * Keyed on content alone, this could not tell a screenshot tool's file-write
   * and pasteboard-write apart from the user capturing the same thing twice.
   * Screenshot an unchanged region twice and the PNG bytes are identical, so
   * the second capture was silently dropped — reported from the field as
   * "I tried attaching multiple images but it did not do that", with exactly
   * one image in the buffer.
   *
   * Two detectors on one action is a duplicate. One detector twice is two
   * captures, and every capture the user made has to arrive: an extra
   * thumbnail they can remove beats a silent loss, which is the same rule this
   * module already applies to an unreadable image.
   *
   * Omitted, the claim behaves exactly as before.
   */
  detector?: string,
): boolean {
  const within = windowMs ?? l.dedupWindowMs
  const prev = l.claims.get(hash)
  if (prev !== undefined && atMs - prev.atMs <= within) {
    // Same detector twice = the user did it twice. Refresh the claim so the
    // window keeps tracking the latest capture, and let it through.
    if (!(detector && prev.detector === detector)) return false
  }
  l.claims.set(hash, { atMs, detector })
  return true
}

/** Between capture windows. Keeps the sets from growing without bound and
 *  guarantees a fresh window shares no state with the last one. */
export function resetLedger(l: Ledger): void {
  l.ownWrites.clear()
  l.claims.clear()
}
