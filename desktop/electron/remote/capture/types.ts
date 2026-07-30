// Shared shapes for the capture buffer. No behaviour, no imports — every
// other capture module depends on this and nothing else.

/** How an insert is rendered. Decided by regex only (insertClassify). */
export type InsertKind = 'url' | 'path' | 'line' | 'block' | 'image'

/** Where a pad is delivered. Set as a default by the trigger key that opened
 *  the capture; overridable on the pad. */
export type Destination = 'cursor' | 'task'

/** One press-to-pause stretch of speech. `text` is '' until transcription
 *  lands — the segment exists from the moment recording starts so inserts can
 *  be positioned against it. */
export interface Segment {
  type: 'segment'
  id: string
  text: string
  startMs: number
  endMs: number
}

/** Something the user copied or captured during a hot mic. `content` is the
 *  text for url/path/line/block, and an absolute file path for image. */
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
