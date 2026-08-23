export type TranscriptSegment = { channel: 'mic' | 'system'; text: string; startMs: number; endMs: number }

/**
 * Merges the two channels' whole-recording transcripts into ordered
 * segments. v1 has no per-utterance timestamps from Groq (response_format
 * is 'json', not 'verbose_json' — see backend/cloudflare/pipeline), so each
 * channel yields at most one segment spanning its whole recorded duration;
 * ordering by startMs is still meaningful and correct for the common case
 * where one side starts talking, then the other responds.
 */
export function mergeTranscripts(
  micText: string, micStartMs: number, micDurationMs: number,
  systemText: string, systemStartMs: number, systemDurationMs: number
): TranscriptSegment[] {
  const segments: TranscriptSegment[] = []
  const trimmedMic = micText.trim()
  const trimmedSystem = systemText.trim()

  if (trimmedMic) {
    segments.push({ channel: 'mic', text: trimmedMic, startMs: micStartMs, endMs: micStartMs + micDurationMs })
  }
  if (trimmedSystem) {
    segments.push({ channel: 'system', text: trimmedSystem, startMs: systemStartMs, endMs: systemStartMs + systemDurationMs })
  }

  return segments.sort((a, b) => a.startMs - b.startMs)
}

const MAX_TITLE_LENGTH = 60

export function generateTitle(segments: TranscriptSegment[]): string {
  const first = segments[0]
  if (!first) {
    return `Meeting on ${new Date().toLocaleDateString()}`
  }
  if (first.text.length <= MAX_TITLE_LENGTH) {
    return first.text
  }
  return first.text.slice(0, MAX_TITLE_LENGTH).trim()
}
