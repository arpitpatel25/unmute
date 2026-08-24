export type TranscriptSegment = { channel: 'mic' | 'system'; text: string; startMs: number; endMs: number; speakerName?: string | null }

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

export type TimedChunkText = { channel: 'mic' | 'system'; text: string; startMs: number; endMs: number }

/**
 * Interleaves already-transcribed, already-stitched chunks from both
 * channels into one ordered transcript, by real per-chunk start time —
 * a genuine improvement over the old one-block-per-channel merge, now
 * that periodic flushing gives real per-chunk timestamps.
 */
export function mergeChannelChunks(micChunks: TimedChunkText[], systemChunks: TimedChunkText[]): TranscriptSegment[] {
  const all: TranscriptSegment[] = [...micChunks, ...systemChunks]
    .filter((c) => c.text.trim().length > 0)
    .map((c) => ({ channel: c.channel, text: c.text.trim(), startMs: c.startMs, endMs: c.endMs }))

  return all.sort((a, b) => a.startMs - b.startMs)
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

export type SpeakerSample = { speakerName: string | null; timestampMs: number }

/**
 * Attributes each system-channel segment to whichever speaker was sampled
 * for the largest share of that segment's [startMs, endMs] window
 * (majority vote by count of in-range samples — samples arrive on a
 * roughly-fixed poll interval, so sample count is a fair proxy for time
 * share). Mic segments are never touched — they're always "You," no
 * attribution needed. Ties go to whichever candidate was sampled first
 * (Map insertion order), deterministic rather than arbitrary.
 *
 * Pure — does not mutate its inputs. See
 * docs/superpowers/specs/2026-08-24-notetaker-speaker-attribution.md §3.2.
 */
export function attributeSpeakers(
  segments: TranscriptSegment[],
  samples: SpeakerSample[]
): TranscriptSegment[] {
  return segments.map((seg) => {
    if (seg.channel !== 'system') return seg
    const inRange = samples.filter(
      (s) => s.timestampMs >= seg.startMs && s.timestampMs <= seg.endMs && s.speakerName
    )
    if (inRange.length === 0) return { ...seg, speakerName: null }
    const counts = new Map<string, number>()
    for (const s of inRange) {
      counts.set(s.speakerName as string, (counts.get(s.speakerName as string) ?? 0) + 1)
    }
    let winner: string | null = null
    let winnerCount = 0
    for (const [name, count] of counts) {
      if (count > winnerCount) { winner = name; winnerCount = count }
    }
    return { ...seg, speakerName: winner }
  })
}
