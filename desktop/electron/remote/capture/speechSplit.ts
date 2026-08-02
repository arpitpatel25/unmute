// WHERE THE SEAM GOES — the one thing the buffer could not answer.
//
// A capture produces exactly ONE segment: beginSegment opens it, and the
// transcript lands 30-45s later as a single string. So the buffer held
// [segment(the whole speech), insert] and `ordered` — correctly, given what it
// had been told — put every insert after every word. A link copied mid-sentence
// came out at the END of the paste, every time. That is the bug.
//
// THE SEAM IS MADE IN THE TRANSCRIPT, NOT IN THE AUDIO. The obvious alternative
// is to cut the recording where the copy happened so the STT returns two
// pieces, and that is what the branch tried and deleted (see vadPolicy.ts's
// tombstone). It is the wrong lever three times over:
//
//   * It is unreachable as written. Chunk splitting is gated on
//     `vadActivatedRef`, which is set by a timer at `chunkMinMs` (30s) — and
//     the insert branch only fired BELOW minChunkMs. The two conditions cannot
//     both hold.
//   * Reaching it means activating the VAD early, i.e. moving a real STT
//     boundary on the dictation fast path. The 2026-07-14 accuracy
//     investigation named bad cutting as the primary source of garbled
//     transcripts.
//   * Even then it would only work for a copy made past a ~9s floor, inside
//     sustained silence, with chunked transcription enabled. Every other copy
//     still lands at the end.
//
// Splitting the finished transcript costs nothing on the audio path, works for
// every copy in every dictation, and — this matters — leaves the cleanup
// pipeline exactly where it is. cleanTranscript / stitchChunks /
// maybeCleanupDictation / formatOutputForUser all still run over the WHOLE
// transcript, once, before anything here is asked a question. The split is the
// last step, so output quality is bit-for-bit what it is today.
//
// SENTENCE-ACCURATE, AND NO FINER. Word-exact placement would need word-level
// STT timestamps, which the pipeline deliberately does not request. A cut is
// only ever taken at a sentence boundary; the boundary chosen is the one
// nearest to where the copy fell in the recording, measured as a fraction of
// the stretch's elapsed time. Speaking rate is near enough constant over one
// utterance for that to land on the right sentence, and snapping to a boundary
// absorbs the error that is left.
//
// LOSSLESS BY CONSTRUCTION. A cut is only taken immediately after a
// sentence-ending run followed by a single space, so every piece trims to
// exactly the sentence text and re-joining the pieces with one space
// reproduces the original string character for character. `render` joins
// non-block pieces with one space, so a transcript with nothing copied in the
// middle of it reads exactly as it always did.
//
// Pure module: no clock, no pad, no I/O — unit-tested by speechSplit.test.ts.

export interface SpeechPiece {
  text: string
  startMs: number
  endMs: number
}

/** A sentence-ending run, its closing quotes/brackets, and the ONE space that
 *  follows. The trailing space is part of the match on purpose: the boundary is
 *  the index just past it, which is what makes the split lossless under a
 *  trim-and-rejoin-with-one-space. A run followed by a newline is deliberately
 *  NOT a boundary — rejoining would eat the line break. */
const SENTENCE_END = /[.!?…]+["'”’)\]]* /g

/** Every index at which the text may be cut, in order.
 *
 *  Never 0, and never past the last non-space character: an empty piece is not
 *  a sentence, and a piece made only of whitespace is worse than empty — it
 *  becomes a segment whose text trims to '', i.e. a blank row in the pad that
 *  renders nothing. `'beta.  '` (terminator, then two spaces) is the whole
 *  repro: the boundary at 6 is inside the text but past everything that is not
 *  whitespace. Bounding on `trimEnd().length` rather than `length` is what
 *  makes "no piece is blank" a property of this function instead of a thing
 *  every caller has to remember to check. */
export function sentenceBoundaries(text: string): number[] {
  const out: number[] = []
  const lastContent = text.trimEnd().length
  SENTENCE_END.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = SENTENCE_END.exec(text)) !== null) {
    const at = m.index + m[0].length
    if (at > 0 && at < lastContent) out.push(at)
  }
  return out
}

/** The boundary closest to `target` that is strictly past `after`. Null when
 *  there is none left — the caller then stops cutting, and everything from
 *  there on appends to the tail exactly as it does today. */
function nearestBoundaryAfter(bounds: number[], target: number, after: number): number | null {
  let best: number | null = null
  let bestDistance = Infinity
  for (const b of bounds) {
    if (b <= after) continue
    const d = Math.abs(b - target)
    if (d < bestDistance) { bestDistance = d; best = b }
  }
  return best
}

/** Split one stretch of speech so the things captured DURING it can sit inside
 *  it rather than after it.
 *
 *  `insertTimes` are on the same clock as `startMs`/`endMs` (the pad's — see
 *  types.ts). Only times strictly INSIDE the stretch can open a seam: one at or
 *  before the start belongs to whatever came before, and one at or after the
 *  end already sorts after the whole thing without any help.
 *
 *  RETURNS ONE PIECE WHENEVER IT CANNOT DO BETTER — no insert inside, no
 *  sentence boundary to cut at, no measurable duration. That single piece
 *  carries the text UNCHANGED (not trimmed, not normalised), so the caller's
 *  no-copy path is the same object graph it was before this existed.
 *
 *  EACH PIECE AFTER A CUT STARTS ONE MILLISECOND PAST THE INSERT IT FOLLOWS.
 *  `ordered` puts a segment first on a tie, so a piece stamped with the
 *  insert's own time would sort in FRONT of it and undo the whole exercise.
 *  Two inserts closer together than that cannot be separated by speech, so the
 *  second one takes no cut and the two land side by side — which is the truth
 *  about what happened. */
export function splitSpeech(
  text: string,
  startMs: number,
  endMs: number,
  insertTimes: readonly number[],
): SpeechPiece[] {
  const whole: SpeechPiece[] = [{ text, startMs, endMs }]
  const span = endMs - startMs
  if (!text || span <= 0) return whole

  const inside = [...new Set(insertTimes)]
    .filter((t) => t > startMs && t < endMs)
    .sort((a, b) => a - b)
  if (!inside.length) return whole

  const bounds = sentenceBoundaries(text)
  if (!bounds.length) return whole

  const cuts: { at: number; startMs: number }[] = []
  let lastAt = 0
  let lastStart = startMs
  for (const t of inside) {
    const pieceStart = t + 1
    if (pieceStart <= lastStart) continue
    const target = Math.round(((t - startMs) / span) * text.length)
    const at = nearestBoundaryAfter(bounds, target, lastAt)
    if (at === null) break
    cuts.push({ at, startMs: pieceStart })
    lastAt = at
    lastStart = pieceStart
  }
  if (!cuts.length) return whole

  const pieces: SpeechPiece[] = []
  let from = 0
  let pieceStart = startMs
  for (const c of cuts) {
    pieces.push({ text: text.slice(from, c.at), startMs: pieceStart, endMs: c.startMs })
    from = c.at
    pieceStart = c.startMs
  }
  pieces.push({ text: text.slice(from), startMs: pieceStart, endMs })
  return pieces
}
