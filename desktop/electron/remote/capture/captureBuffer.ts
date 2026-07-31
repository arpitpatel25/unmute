// The capture buffer — the one timeline every capture composes into.
//
// Pure and immutable on purpose: this is the module that decides what the user
// actually sends, so it must be exhaustively testable without a mic, a
// clipboard, or an Electron window. Every operation returns a new Pad.
//
// ORDER IS THE CONTRACT. Inserts are positioned by wall-clock time against the
// segments around them, because speech refers to artifacts deictically ("go
// through the thread" ⌘C "and compare it with the doc" ⌘C). Order is what makes
// those references resolvable; exact position is a refinement on top of it.

import type { Destination, Entry, Insert, Pad, Segment } from './types'
import { timeOf } from './types'

export function emptyPad(id: string, origin: Destination, now: number): Pad {
  return { id, origin, createdAt: now, updatedAt: now, entries: [] }
}

/** NOTHING DELIVERABLE — not "zero entries".
 *
 *  Every capture opens a segment the instant recording starts, with `text: ''`
 *  until transcription lands 30-45s later. So a pad that holds ONE armed tap on
 *  silence has an entry and no content, and counting entries called it
 *  non-empty: `deliver` rendered it to '', `armScratchpad` settled it, and the
 *  panel pinned itself open on a row reading "Still transcribing…" that nothing
 *  would ever fill. That is the first thing a user trying the feature does.
 *
 *  A blank segment is not content, so a pad made only of blank segments holds
 *  nothing. An insert always counts: an image renders to nothing at the cursor,
 *  but it is real, the user captured it deliberately, and it is deliverable to
 *  a task. */
export function isEmpty(pad: Pad): boolean {
  return !pad.entries.some((e) => e.type === 'insert' || e.text.trim() !== '')
}

/** Time-ordered. Ties put the segment first, so an insert made at the instant a
 *  segment begins reads as belonging to that segment rather than preceding it. */
export function ordered(pad: Pad): Entry[] {
  return [...pad.entries].sort((a, b) => {
    const d = timeOf(a) - timeOf(b)
    if (d !== 0) return d
    if (a.type === b.type) return 0
    return a.type === 'segment' ? -1 : 1
  })
}

function withEntries(pad: Pad, entries: Entry[], now?: number): Pad {
  return { ...pad, entries, updatedAt: now ?? pad.updatedAt }
}

export function addSegment(
  pad: Pad,
  seg: Omit<Segment, 'type'> & { now?: number },
): Pad {
  const { now, ...rest } = seg
  return withEntries(pad, [...pad.entries, { type: 'segment', ...rest }], now)
}

export function addInsert(
  pad: Pad,
  ins: Omit<Insert, 'type'> & { now?: number },
): Pad {
  const { now, ...rest } = ins
  return withEntries(pad, [...pad.entries, { type: 'insert', ...rest }], now)
}

export function removeEntry(pad: Pad, id: string, now?: number): Pad {
  const entries = pad.entries.filter((e) => e.id !== id)
  if (entries.length === pad.entries.length) return pad
  return withEntries(pad, entries, now)
}

/** Transcription arrives long after the segment was created (chunks are 30-45s),
 *  so the segment is born empty and filled in later. */
export function setSegmentText(pad: Pad, id: string, text: string, now?: number): Pad {
  let found = false
  const entries = pad.entries.map((e) => {
    if (e.type !== 'segment' || e.id !== id) return e
    found = true
    return { ...e, text }
  })
  return found ? withEntries(pad, entries, now) : pad
}

/** A segment's speech is over. Stamped when the mic goes cold, on the same
 *  PAD-RELATIVE clock as `startMs`, so `endMs - startMs` is the stretch's real
 *  duration whichever capture in the pad it came from.
 *
 *  Separate from setSegmentText because the two land at completely different
 *  moments: the end is known the instant recording stops, the text 30-45s
 *  later. A silent no-op on an unknown id, like setSegmentText, because the
 *  segment can be gone (Escape cancels it). */
export function setSegmentEnd(pad: Pad, id: string, endMs: number, now?: number): Pad {
  let found = false
  const entries = pad.entries.map((e) => {
    if (e.type !== 'segment' || e.id !== id) return e
    found = true
    return { ...e, endMs }
  })
  return found ? withEntries(pad, entries, now) : pad
}
