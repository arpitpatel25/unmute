import { isReliableWhisperSegment, type WhisperConfidenceSegment } from './whisperConfidence'

type EncodedChunkLike = {
  wav: Buffer
  durationSeconds: number
  sampleRate: number
}

type ManagedSegment = WhisperConfidenceSegment & {
  start: number
  end: number
  text: string
}

type ManagedResult = {
  text: string
  segments?: ManagedSegment[]
}

export type NotetakerChunkResult = {
  text: string
  failed: boolean
  segments: Array<{ startSeconds: number; endSeconds: number; text: string }>
}

export type NotetakerSTTDependencies = {
  managed: (encoded: EncodedChunkLike) => Promise<ManagedResult | null>
  local: (encoded: EncodedChunkLike) => Promise<string>
  onManagedFallback?: (reason: unknown) => void
  onLocalFailure?: (reason: unknown) => void
}

/** Finish the Notetaker-specific cascade after the worker has already tried
 * OpenRouter Qwen and Groq Whisper. This is deliberately independent from
 * SessionManager so ordinary dictation's provider selection is untouched. */
export async function transcribeEncodedChunkWithFallback(
  _channel: 'mic' | 'system',
  encoded: EncodedChunkLike,
  dependencies: NotetakerSTTDependencies,
): Promise<NotetakerChunkResult> {
  try {
    const managed = await dependencies.managed(encoded)
    if (managed) {
      const receivedSegments = Array.isArray(managed.segments) ? managed.segments : []
      const reliableSegments = receivedSegments.filter(isReliableWhisperSegment)
      const hasTimestampedSegments = Array.isArray(managed.segments)
      const text = hasTimestampedSegments
        ? reliableSegments.map((segment) => segment.text.trim()).filter(Boolean).join(' ')
        : managed.text.trim()
      if (text) {
        return {
          text,
          failed: false,
          segments: reliableSegments
            .filter((segment) => Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.end >= segment.start)
            .map((segment) => ({ startSeconds: segment.start, endSeconds: segment.end, text: segment.text })),
        }
      }
    }
    dependencies.onManagedFallback?.('empty-or-unavailable')
  } catch (error) {
    dependencies.onManagedFallback?.(error)
  }

  try {
    const text = (await dependencies.local(encoded)).trim()
    if (text) return { text, failed: false, segments: [] }
    dependencies.onLocalFailure?.('empty-output')
  } catch (error) {
    dependencies.onLocalFailure?.(error)
  }
  return { text: '', failed: true, segments: [] }
}
