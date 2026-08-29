export type WhisperConfidenceSegment = {
  avg_logprob?: number
  no_speech_prob?: number
  compression_ratio?: number
}

/** Groq's verbose Whisper response exposes the same confidence fields used
 * by OpenAI Whisper's own silence/hallucination handling. Keep normal speech
 * even when accented or multilingual (low no-speech probability), but reject
 * segments the model itself considers overwhelmingly non-speech or both
 * non-speech and low-confidence. Older workers omit these fields and remain
 * backward-compatible. */
export function isReliableWhisperSegment(segment: WhisperConfidenceSegment): boolean {
  const noSpeech = segment.no_speech_prob
  const logprob = segment.avg_logprob
  const compression = segment.compression_ratio
  if (typeof noSpeech === 'number' && noSpeech >= 0.85) return false
  if (typeof noSpeech === 'number' && typeof logprob === 'number' && noSpeech >= 0.6 && logprob < -0.5) return false
  if (typeof compression === 'number' && typeof logprob === 'number' && compression > 2.4 && logprob < -0.5) return false
  return true
}
