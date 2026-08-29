export type StitchableChunk = { chunkIndex: number; text: string; startTimestampMs: number }

/**
 * Whisper's own non-speech sentinel tags — mirrors dictation's
 * WHISPER_SENTINELS_RE (sessionManager.ts). Previously this only matched two
 * of them ([BLANK_AUDIO], [MUSIC]) as a whole-string check; broadened to the
 * same set dictation strips, anywhere in the text, not just when the tag is
 * the entire chunk.
 */
const WHISPER_SENTINELS_RE = /\[\s*(?:BLANK_AUDIO|SILENCE|\*SILENCE\*|MUSIC|INAUDIBLE|NO\s*SPEECH|NOISE|SOUND|APPLAUSE|LAUGHTER)\s*\]/gi
const NON_SPEECH_ONLY_RE = /^[\s.!?,;:'"()\[\]{}*-]*(?:BLANK[ _]AUDIO|SILENCE|MUSIC|INAUDIBLE|NO\s*SPEECH|NOISE|SOUND|APPLAUSE|LAUGHTER)[\s.!?,;:'"()\[\]{}*-]*$/i

/**
 * Whisper large-v3(-turbo) was trained on a lot of podcast/YouTube content
 * and, fed silence or near-silence, deterministically hallucinates one of
 * these high-probability closing lines instead of returning nothing —
 * started life mirroring dictation's WHISPER_HALLUCINATION_RE
 * (sessionManager.ts), now broadened for the notetaker's own failure modes
 * (see JUNK_SENTENCE_RE below for why it diverged).
 *
 * Matched only when it is the WHOLE of a sentence, never as a substring of
 * a longer real one — "So I just wanted to say thank you for coming" must
 * survive untouched. Deliberately narrow beyond that: short genuine replies
 * like "Thanks." or "Okay." alone are left alone; only closing-credits-style
 * lines Whisper is known to invent on silence are listed.
 */
const JUNK_SENTENCE_RE =
  /^(?:thanks? for (?:watching|listening)|thank you(?: (?:very|so) much)?|thank you for (?:watching|listening)|please subscribe(?: to (?:my|the|this) channel)?|don'?t forget to (?:like and )?subscribe|like and subscribe|subscribe(?: to (?:my|the|this) channel)?|bye(?:\s*bye)?|goodbye|see you (?:next time|soon|later|in the next video)|i'?ll see you (?:next time|soon|later|in the next video)|subtitles? by\s+.+|closed captions? by\s+.+|captions? by\s+.+|transcri(?:pt|ption|bed) by\s+.+|translated by\s+.+)[.!?]*$/i

// Exact fragments from the retired imperative decoder prompt. These were
// observed in stored text from sub-second silence, not spoken audio. Keeping
// the match sentence-shaped and exact avoids deleting normal discussion.
const RETIRED_PROMPT_LEAK_RE =
  /^(?:preserve exactly what was spoken|do not translate hindi into english|write hindi phonetically in roman\/latin script(?: \(hinglish\))?|keep already-spoken english unchanged|do not add, omit, summarize, reorder, or correct speech|do not add, omit, or correct speech)[.!?]*$/i

export function cleanChunkText(text: string): string {
  let t = text.replace(WHISPER_SENTINELS_RE, ' ').trim()
  if (!t) return ''
  // Some STT responses omit Whisper's square brackets and return a bare
  // event label. It is metadata about the sound, not spoken transcript.
  if (NON_SPEECH_ONLY_RE.test(t)) return ''
  // Silence can also come back as a punctuation-only token (live observed:
  // a lone "." became both the first transcript row and the meeting title).
  // It carries no speech and should never reach the UI or notes agent.
  if (!/[\p{L}\p{N}]/u.test(t)) return ''
  // Split into sentences (keeping each one's own trailing punctuation) and
  // drop only the ones that are ENTIRELY a known hallucination — not just
  // the chunk's trailing one. A long silent stretch routinely makes Whisper
  // loop the same line ("Thank you. Thank you. Thank you.") rather than say
  // it once; a trailing-anchored replace only ever caught the last
  // occurrence and left the rest sitting in the transcript verbatim.
  // A common multilingual-silence failure is the combined phrase
  // "foreign Thank you.". "foreign" is an acoustic event label in that
  // shape, not spoken content; remove it only when the entire remainder is
  // independently one of the known closing-line hallucinations. This does
  // not touch real sentences such as "Foreign investment increased."
  const foreignPrefix = t.match(/^foreign[\s:,.!?-]+(.+)$/i)
  if (foreignPrefix && JUNK_SENTENCE_RE.test(foreignPrefix[1].trim())) {
    t = foreignPrefix[1].trim()
  }
  const sentences = t.split(/(?<=[.!?])\s+/).filter((s) => s.length > 0)
  return sentences
    .filter((s) => !JUNK_SENTENCE_RE.test(s.trim()) && !RETIRED_PROMPT_LEAK_RE.test(s.trim()))
    .join(' ')
    .trim()
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
