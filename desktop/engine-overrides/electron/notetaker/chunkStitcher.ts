export type StitchableChunk = { chunkIndex: number; text: string; startTimestampMs: number }

/**
 * Whisper's own non-speech sentinel tags — mirrors dictation's
 * WHISPER_SENTINELS_RE (sessionManager.ts). Previously this only matched two
 * of them ([BLANK_AUDIO], [MUSIC]) as a whole-string check; broadened to the
 * same set dictation strips, anywhere in the text, not just when the tag is
 * the entire chunk.
 */
const WHISPER_SENTINELS_RE = /\[\s*(?:BLANK_AUDIO|SILENCE|\*SILENCE\*|MUSIC|INAUDIBLE|NO\s*SPEECH|NOISE|SOUND|APPLAUSE|LAUGHTER)\s*\]/gi

/**
 * Whisper large-v3(-turbo) was trained on a lot of podcast/YouTube content
 * and, fed silence or near-silence, deterministically hallucinates one of
 * these high-probability closing lines instead of returning nothing —
 * mirrors dictation's WHISPER_HALLUCINATION_RE (sessionManager.ts). A
 * meeting where nobody was speaking yet (or the room was quiet) previously
 * came back with a literal "Thank you." on both channels because this file
 * only ever stripped the bracketed sentinels above, never this.
 *
 * Trailing-anchored per chunk (not per whole transcript) so a hallucination
 * on one chunk is caught before it lands mid-string once chunks are joined —
 * same reasoning as dictation's cleanChunk().
 */
const WHISPER_HALLUCINATION_RE = /\s*(?:thanks? for watching[.!]?|please subscribe[.!]?|thank you[.!]?|bye[.!]?|see you next time[.!]?|subtitles? by\s+[^.!]+[.!]?)\s*$/i

export function cleanChunkText(text: string): string {
  let t = text.replace(WHISPER_SENTINELS_RE, ' ').trim()
  if (!t) return ''
  t = t.replace(WHISPER_HALLUCINATION_RE, '').trim()
  return t
}

/**
 * Ordered, code-only join of a channel's per-chunk transcripts — no LLM
 * merge pass. Safe because chunks are cut on silence (never mid-word,
 * except the rare hard-cap), the same assumption dictation's stitchChunks
 * already relies on.
 */
export function stitchChannelChunks(chunks: StitchableChunk[]): string {
  const ordered = [...chunks].sort((a, b) => a.chunkIndex - b.chunkIndex)
  return ordered
    .map((c) => cleanChunkText(c.text))
    .filter((t) => t.length > 0)
    .join(' ')
}
