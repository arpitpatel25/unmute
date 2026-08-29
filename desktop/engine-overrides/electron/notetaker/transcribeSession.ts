import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { tryManagedSTT } from '../paywall/paywall-route'
import { encodeWav } from './wavEncoder'
import { downmixAndResample } from './resample'
import { mergeChannelChunks, generateTitle, attributeSpeakers, type TranscriptSegment, type TimedChunkText, type SpeakerSample } from './transcriptMerge'
import { insertMeeting, type DBMeeting } from '../db'
import { createNotetakerLogger } from './notetakerLog'
import { isReliableWhisperSegment, type WhisperConfidenceSegment } from './whisperConfidence'

const log = createNotetakerLogger('transcribe')

/**
 * Result of transcribing ONE already-cut chunk of a channel's audio
 * (Periodic-flush replacement for the old whole-session processChannel()).
 */
export type ChunkTranscriptionResult = {
  text: string
  failed: boolean
  /** Speech-to-text timestamps relative to the encoded chunk. They are used
   * to order mic and system utterances precisely, not by upload completion
   * order or a guessed whole-channel duration. */
  segments: Array<{ startSeconds: number; endSeconds: number; text: string }>
}

type WhisperSegment = WhisperConfidenceSegment & {
  start: number
  end: number
  text: string
}

/** One chunk's audio, already reduced to mono/target-rate and WAV-encoded — the input `transcribeEncodedChunk` needs, and the payload `notetakerInit.ts` streams to disk. */
export type EncodedChunk = {
  wav: Buffer
  durationSeconds: number
  /** The rate `wav` was actually encoded at (downmixAndResample never
   *  upsamples, so this is usually TARGET_SAMPLE_RATE but can differ if the
   *  source itself arrived at or below that rate). */
  sampleRate: number
}

/**
 * Downsamples/resamples one chunk's raw samples to mono target-rate PCM and
 * WAV-encodes it. Deliberately a plain SYNCHRONOUS function, not folded into
 * the (async) transcription call below — this is what makes the memory
 * bound structural rather than incidental: `samples` and the intermediate
 * `reduced` array are locals of THIS function only. Once it returns, they
 * are unreachable from anywhere else in the program; they can never be kept
 * alive as part of a paused async-function frame across the network
 * `await` in `transcribeEncodedChunk`, because that function never receives
 * them in the first place — only the already-encoded `wav` Buffer does.
 *
 * The mono/target-rate reduction is not cosmetic: the pipeline worker caps
 * uploads at MAX_AUDIO_BYTES = 50MB (sized for compressed opus, not raw
 * PCM) — see resample.ts for the full byte-budget reasoning.
 *
 * Returns null for a chunk with nothing worth transcribing or persisting
 * (fewer samples than one target-rate slot holds) — not a failure, the
 * chunk was simply (near-)silent/empty.
 */
export function encodeChunk(samples: Float32Array, channelsCount: number, sampleRate: number): EncodedChunk | null {
  const reduced = downmixAndResample(samples, channelsCount, sampleRate)
  if (reduced.samples.length === 0) {
    log.debug('encodeChunk: empty chunk after downmix/resample, nothing to encode', {
      inputSamples: samples.length,
      inputChannels: channelsCount,
      inputSampleRate: sampleRate,
    })
    return null
  }
  const wav = encodeWav(reduced.samples, reduced.sampleRate, 1)
  const durationSeconds = reduced.samples.length / reduced.sampleRate
  return { wav, durationSeconds, sampleRate: reduced.sampleRate }
}

/**
 * Sends one already-encoded chunk's WAV bytes through the same managed-STT
 * pipeline dictation already uses (`tryManagedSTT`) — immediately, per
 * chunk, not once at the end of a whole meeting. Called from each
 * PeriodicChunkEmitter's onSegment callback (notetakerInit.ts), AFTER that
 * chunk's audio has already been synchronously appended to its channel's
 * on-disk WAV file (see WavAppender) — this call and that append are
 * independent of each other; a failure here never loses audio already
 * safely on disk, exactly like the old whole-session processChannel() kept
 * a channel's audio file even when its STT call failed.
 *
 * Failure isolation: a thrown error (the STT call itself) is caught HERE,
 * per chunk — it never aborts the rest of that channel's chunks, let alone
 * the other channel's. The caller is told via `failed: true` so it can
 * track that chunk's channel toward the meeting's overall status, without
 * losing whatever OTHER chunks did transcribe successfully.
 */
export async function transcribeEncodedChunk(channel: 'mic' | 'system', encoded: EncodedChunk): Promise<ChunkTranscriptionResult> {
  const startedAt = Date.now()
  const clog = log.child({ channel })
  try {
    // The null language override makes this request truly auto-detecting on
    // the dedicated notetaker backend branch. Ordinary dictation continues to
    // use its existing configured language behavior unchanged.
    const result = await tryManagedSTT(
      encoded.wav,
      encoded.durationSeconds,
      'notetaker',
      undefined,
      // Whisper's prompt is decoder context, not an instruction channel. Both
      // imperative wording and a Hinglish example have leaked into output and
      // displaced real speech. Decode without a prompt. Any optional transcript
      // cleanup happens later on returned text only; it never chooses or forces
      // Whisper's language.
      undefined,
      null,
      'audio/wav',
    )
    const latencyMs = Date.now() - startedAt
    // A NULL result is a FAILURE here, not an empty transcript — same
    // Finding-3 reasoning as the old whole-session flow: tryManagedSTT
    // returns null both when the call really failed AND when managed STT is
    // simply unavailable, and treating that as "successfully transcribed
    // nothing" is what produced a silent blank transcript on real audio.
    // We KNOW audio existed (encodeChunk already filtered out empty
    // chunks), so mark this chunk failed and let the caller factor that
    // into the channel's/meeting's overall status. This promise settling
    // with `failed: true` never rejects, so it can never take down
    // `Promise.all` for the rest of this channel's or the other channel's
    // chunks.
    if (!result) {
      clog.error(`${channel} chunk transcription unavailable or failed (managed STT returned no result)`, {
        durationSeconds: encoded.durationSeconds,
        sampleRate: encoded.sampleRate,
        wavBytes: encoded.wav.length,
        latencyMs,
      })
      return { text: '', failed: true, segments: [] }
    }
    const hasTimestampedSegments = Array.isArray(result.segments)
    const receivedSegments = (result.segments ?? []) as WhisperSegment[]
    const reliableSegments = receivedSegments.filter(isReliableWhisperSegment)
    const droppedSegmentCount = receivedSegments.length - reliableSegments.length
    // When confidence metadata is available, the accepted segments are the
    // source of truth for both text and timing. If every segment looks like
    // noise, return empty rather than keeping Groq's unfiltered top-level
    // hallucination. Old worker responses have no segment array and retain
    // their existing top-level-text behavior.
    const reliableText = hasTimestampedSegments
      ? reliableSegments.map((segment) => segment.text.trim()).filter(Boolean).join(' ')
      : (result.text ?? '')
    clog.event('chunk-transcribed', {
      durationSeconds: encoded.durationSeconds,
      sampleRate: encoded.sampleRate,
      latencyMs,
      textLength: reliableText.length,
      textPreview: reliableText,
      droppedSegmentCount,
    })
    return {
      text: reliableText,
      failed: false,
      segments: reliableSegments
        .filter((segment) => Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.end >= segment.start)
        .map((segment) => ({ startSeconds: segment.start, endSeconds: segment.end, text: segment.text ?? '' })),
    }
  } catch (err) {
    clog.error(`${channel} chunk transcription failed`, {
      durationSeconds: encoded.durationSeconds,
      latencyMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    })
    return { text: '', failed: true, segments: [] }
  }
}

/**
 * Called once, from HookedNotetakerSession's stop() flow (notetakerInit.ts),
 * after a capture session ends, both channels' WAV-file writers have been
 * closed, and every chunk's transcription promise (mic + system) has
 * already resolved. Interleaves both channels' per-chunk transcripts by
 * real timestamp (mergeChannelChunks), generates a title, atomically writes
 * transcript.json, and updates the meeting's DB row from its start()-time
 * 'recording' placeholder to its final status.
 *
 * `audioMicPath`/`audioSystemPath` are the relative filenames
 * (`audio-mic.wav`/`audio-system.wav`) the caller's WavAppenders actually
 * wrote, or null for a channel that produced zero real (non-silent) chunks
 * — same "no audio, no file" semantics the old whole-session flow had for
 * an entirely-empty channel.
 */
export async function persistSession(
  micChunks: TimedChunkText[],
  systemChunks: TimedChunkText[],
  meetingId: string,
  startedAt: number,
  endedAt: number,
  failed: boolean,
  audioMicPath: string | null,
  audioSystemPath: string | null,
  zoomSpeakerSamples: SpeakerSample[] = [],
  wasZoomSession = false,
): Promise<TranscriptSegment[]> {
  const mlog = log.child({ meetingId })
  const meetingDir = path.join(app.getPath('userData'), 'meetings', meetingId)
  fs.mkdirSync(meetingDir, { recursive: true })

  const segments: TranscriptSegment[] = mergeChannelChunks(micChunks, systemChunks)
  const attributedSegments = attributeSpeakers(segments, zoomSpeakerSamples)
  const title = generateTitle(attributedSegments)

  const transcriptPath = 'transcript.json'
  const target = path.join(meetingDir, transcriptPath)
  const temp = `${target}.${process.pid}.tmp`
  fs.writeFileSync(temp, JSON.stringify(attributedSegments), 'utf8')
  fs.renameSync(temp, target)

  const status: DBMeeting['status'] = failed ? 'failed' : 'ready'

  mlog.event('session-persisted', {
    title,
    status,
    durationMs: endedAt - startedAt,
    micChunkCount: micChunks.length,
    systemChunkCount: systemChunks.length,
    segmentCount: attributedSegments.length,
    hasMicAudio: !!audioMicPath,
    hasSystemAudio: !!audioSystemPath,
  })

  const systemSegmentCount = attributedSegments.filter((s) => s.channel === 'system').length
  const attributedCount = attributedSegments.filter((s) => s.channel === 'system' && s.speakerName).length
  // wasZoomSession distinguishes "not a Zoom call — attribution never
  // applies here, zero samples is expected" from "was a Zoom call, polled,
  // learned nothing" (a real problem worth investigating from
  // zoom-speaker-poll's own per-poll diagnostics in the notetaker log) —
  // without it, both cases logged identically as zero samples/zero
  // attributed, which is exactly what a whole-plan review flagged as
  // undermining this feature's own "verify from real logs" strategy.
  mlog.event('speaker-attribution-summary', {
    wasZoomSession,
    zoomSpeakerSamplesCollected: zoomSpeakerSamples.length,
    systemSegmentCount,
    attributedCount,
  })

  insertMeeting({
    id: meetingId,
    title,
    started_at: startedAt,
    ended_at: endedAt,
    duration_ms: endedAt - startedAt,
    status,
    transcript_path: transcriptPath,
    audio_mic_path: audioMicPath,
    audio_system_path: audioSystemPath,
    // Capture stop has already exposed this meeting as "Preparing notes".
    // Preserve that pending state through this INSERT OR REPLACE so the
    // detail view never flashes "no notes" between persistence and the
    // direct note-generation stage starting.
    cleanup_status: 'pending',
    summary_status: 'pending',
    cleaned_transcript_path: null,
    notes_path: null,
  })

  return attributedSegments
}

export function newMeetingId(): string {
  return randomUUID()
}
