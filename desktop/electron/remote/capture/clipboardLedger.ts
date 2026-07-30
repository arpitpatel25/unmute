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
 *  deliberate copies of the same thing. */
export const DEDUP_WINDOW_MS = 2000

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
  claims: Map<string, number>
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
 *  detector already claimed the same user action. */
export function claimContent(l: Claims, hash: string, atMs: number): boolean {
  const prev = l.claims.get(hash)
  if (prev !== undefined && atMs - prev <= l.dedupWindowMs) return false
  l.claims.set(hash, atMs)
  return true
}

/** Between capture windows. Keeps the sets from growing without bound and
 *  guarantees a fresh window shares no state with the last one. */
export function resetLedger(l: Ledger): void {
  l.ownWrites.clear()
  l.claims.clear()
}
