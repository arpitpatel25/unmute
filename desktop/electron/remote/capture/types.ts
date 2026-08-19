// Shared shapes for the capture buffer. No behaviour, no imports — every
// other capture module depends on this and nothing else.

/** How an insert is rendered. Decided by regex only (insertClassify). */
export type InsertKind = 'url' | 'path' | 'line' | 'block' | 'image'

/** Where a pad is delivered. Set as a default by the trigger key that opened
 *  the capture; overridable on the pad. */
/**
 * Where a capture is headed.
 *
 * 'agent' was missing for months, and its absence was not neutral: the Agent
 * lane reuses the Remote pipeline, so a pad it filled resolved to 'cursor' and
 * the panel offered "New task / Paste at cursor". On 19 August an utterance
 * spoken to the Agent was pasted at the cursor instead, and the Agent turn it
 * belonged to never happened at all.
 */
export type Destination = 'cursor' | 'task' | 'agent'

// THE PAD'S CLOCK IS THE PAD'S OWN. Every `startMs`, `endMs` and `atMs` below
// is milliseconds since `Pad.createdAt` — NOT since the capture the entry
// happened in.
//
// It has to be. A pad accumulates across captures (that is the scratchpad), and
// a per-capture origin gives each capture its own coordinate system: two
// captures' segments both sit at 0 while their inserts carry offsets into
// different zeroes, so nothing composes. Measured, before the fix: a pad with
// speech and one copy in each of two captures rendered ALL the speech first and
// then both inserts in the wrong order relative to each other — an insert two
// seconds into capture 2 came out after one ten seconds into capture 1.
//
// One origin per pad makes ordering a plain numeric sort again, which is what
// `ordered` has always assumed and what §2.1 says carries almost all the value.

/** One press-to-pause stretch of speech. `text` is '' until transcription
 *  lands — the segment exists from the moment recording starts so inserts can
 *  be positioned against it. Both times are pad-relative (see above); `endMs`
 *  is 0 until the mic goes cold. */
export interface Segment {
  type: 'segment'
  id: string
  text: string
  startMs: number
  endMs: number
}

/** Something the user copied or captured during a hot mic. `content` is the
 *  text for url/path/line/block, and an absolute file path for image. `atMs` is
 *  pad-relative (see above). */
export interface Insert {
  type: 'insert'
  id: string
  kind: InsertKind
  content: string
  atMs: number
}

export type Entry = Segment | Insert

/** The one buffer. Exactly one exists at a time — same cardinality as the
 *  clipboard. */
export interface Pad {
  id: string
  origin: Destination
  createdAt: number
  updatedAt: number
  entries: Entry[]
}

/** Sort key: a segment is positioned by where it started, an insert by when
 *  it happened. Exported because ordering is the buffer's whole contract. */
export function timeOf(e: Entry): number {
  return e.type === 'segment' ? e.startMs : e.atMs
}
