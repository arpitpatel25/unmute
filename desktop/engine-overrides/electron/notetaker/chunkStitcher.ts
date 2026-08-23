export type StitchableChunk = { chunkIndex: number; text: string; startTimestampMs: number }

/**
 * Known Whisper hallucination/sentinel outputs on silent or near-silent
 * audio — mirrors dictation's cleanChunk() list (sessionManager.ts).
 */
const HALLUCINATION_SENTINELS = [/^\[BLANK_AUDIO\]$/i, /^\[MUSIC\]$/i]

function cleanChunkText(text: string): string {
  const trimmed = text.trim()
  if (HALLUCINATION_SENTINELS.some((re) => re.test(trimmed))) return ''
  return trimmed
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
