// alt/note are only ever set by cleanup's code-switching recovery (see
// transcriptCleanup.ts): `alt` is a low-confidence guess at what a segment
// actually said, `note` names the suspected other language — set together,
// only when cleanup wasn't confident enough to correct `text` itself. Never
// present on a raw (pre-cleanup) segment.
export type TranscriptSegment = {
  channel: 'mic' | 'system'
  text: string
  startMs: number
  endMs: number
  speakerName?: string | null
  alt?: string
  note?: string
}

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

// The system lane is captured directly, while the microphone lane can also
// contain a quieter copy of that same far-end speech from the speakers. The
// browser's echoCancellation constraint helps the live microphone stream but
// is not reliable enough to prevent Whisper from transcribing that copy. Once
// both lanes have text and real capture timestamps, prefer the direct system
// copy when an overlapping mic segment is demonstrably the same utterance.
//
// This intentionally does not suppress one-word acknowledgements: a genuine
// "yes" spoken over somebody else is indistinguishable from leaked audio from
// text alone, so ambiguous short turns stay attributed to You.
const ECHO_MATCH_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'for',
  'from', 'had', 'has', 'have', 'he', 'her', 'him', 'his', 'i', 'im', 'in',
  'is', 'it', 'its', 'me', 'my', 'of', 'on', 'or', 'our', 'she', 'that',
  'the', 'their', 'them', 'they', 'this', 'to', 'was', 'we', 'were', 'you',
  'your',
])

function normalizedTokens(text: string): string[] {
  return text.toLocaleLowerCase('en-US').match(/[\p{L}\p{N}]+/gu) ?? []
}

function tokenRecall(needles: string[], haystack: Set<string>): number {
  if (needles.length === 0) return 0
  return needles.filter((token) => haystack.has(token)).length / needles.length
}

function relatedInTime(mic: TranscriptSegment, system: TranscriptSegment): boolean {
  const overlapMs = Math.max(0, Math.min(mic.endMs, system.endMs) - Math.max(mic.startMs, system.startMs))
  const micDurationMs = Math.max(1, mic.endMs - mic.startMs)
  if (overlapMs >= Math.min(500, micDurationMs * 0.2)) return true
  const gapMs = mic.startMs >= system.endMs
    ? mic.startMs - system.endMs
    : system.startMs >= mic.endMs
      ? system.startMs - mic.endMs
      : 0
  return gapMs <= 350
}

function isTimingTwin(mic: TranscriptSegment, system: TranscriptSegment): boolean {
  const micDurationMs = Math.max(1, mic.endMs - mic.startMs)
  const systemDurationMs = Math.max(1, system.endMs - system.startMs)
  const durationRatio = Math.min(micDurationMs, systemDurationMs) / Math.max(micDurationMs, systemDurationMs)
  return Math.min(micDurationMs, systemDurationMs) >= 1500 &&
    Math.abs(mic.startMs - system.startMs) <= 650 &&
    Math.abs(mic.endMs - system.endMs) <= 650 &&
    durationRatio >= 0.65
}

export function removeMicEchoDuplicates(segments: TranscriptSegment[]): TranscriptSegment[] {
  const systems = segments.filter((segment) => segment.channel === 'system')
  if (systems.length === 0) return segments

  return segments.filter((segment) => {
    if (segment.channel !== 'mic') return true
    const micTokens = normalizedTokens(segment.text)
    const informativeMicTokens = micTokens.filter((token) => !ECHO_MATCH_STOP_WORDS.has(token))
    if (informativeMicTokens.length < 2) return true

    return !systems.some((system) => {
      if (!relatedInTime(segment, system)) return false
      // When both independent lane emitters detect essentially the same
      // onset and silence boundary, they heard the same acoustic event. This
      // catches code-switched speech where STT translates/garbles the two
      // copies differently enough that token comparison alone cannot match
      // them (live example: "Then I sat down..." versus "Then he sat down
      // and I saw the camera...").
      const systemTokenSet = new Set(normalizedTokens(system.text))
      // Matching audio boundaries alone are not proof of echo. Full-channel
      // retry files intentionally share one container duration, and the old
      // timing-only rule deleted a perfectly good 30-second microphone
      // transcript while retaining an unrelated two-word system result.
      // Timing may strengthen a match only when the decoders also agree on
      // at least two meaningful words.
      const sharedInformativeTokens = informativeMicTokens.filter((token) => systemTokenSet.has(token)).length
      if (isTimingTwin(segment, system) && sharedInformativeTokens >= 2) return true
      return tokenRecall(micTokens, systemTokenSet) >= 0.72 &&
        tokenRecall(informativeMicTokens, systemTokenSet) >= 0.8
    })
  })
}

/**
 * Converts capture/STT chunks into readable speaker turns. Periodic audio
 * flushing is an internal reliability detail: when two chronologically
 * adjacent segments have the same speaker, the transcript should show one
 * paragraph until another speaker interrupts.
 *
 * Keep distinct resolved system speakers separate when attribution is
 * available. Mic is always the local user, and unattributed system audio is
 * the single user-facing "Them" lane.
 */
export function mergeAdjacentSpeakerTurns(segments: TranscriptSegment[]): TranscriptSegment[] {
  const turns: TranscriptSegment[] = []

  for (const segment of segments) {
    const previous = turns.at(-1)
    const sameSpeaker = previous?.channel === segment.channel &&
      (segment.channel === 'mic' || (previous.speakerName ?? null) === (segment.speakerName ?? null))

    if (!previous || !sameSpeaker) {
      turns.push({ ...segment })
      continue
    }

    previous.text = `${previous.text.trimEnd()} ${segment.text.trimStart()}`.trim()
    previous.startMs = Math.min(previous.startMs, segment.startMs)
    previous.endMs = Math.max(previous.endMs, segment.endMs)

    if (previous.alt || segment.alt) {
      previous.alt = `${previous.alt?.trimEnd() ?? ''} ${segment.alt?.trimStart() ?? ''}`.trim()
    }
    if (!previous.note && segment.note) previous.note = segment.note
  }

  return turns
}

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

  return removeMicEchoDuplicates(all).sort((a, b) =>
    a.startMs - b.startMs ||
    a.endMs - b.endMs ||
    (a.channel === b.channel ? 0 : a.channel === 'mic' ? -1 : 1)
  )
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
