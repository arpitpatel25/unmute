import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { tryManagedSTT } from '../paywall/paywall-route'
import { encodeWav } from './wavEncoder'
import { downmixAndResample } from './resample'
import { mergeChannelChunks, generateTitle, type TranscriptSegment, type TimedChunkText } from './transcriptMerge'
import { insertMeeting, type DBMeeting } from '../db'

/**
 * Result of transcribing ONE already-cut chunk of a channel's audio
 * (Periodic-flush replacement for the old whole-session processChannel()).
 */
export type ChunkTranscriptionResult = {
  text: string
  failed: boolean
}

/**
 * Downsamples/resamples one chunk's raw samples to mono 16kHz, WAV-encodes
 * it, and transcribes it through the same managed-STT pipeline dictation
 * already uses (`tryManagedSTT`) — immediately, per chunk, not once at the
 * end of a whole meeting. Called from each PeriodicChunkEmitter's onSegment
 * callback (notetakerInit.ts).
 *
 * The mono/16k reduction is not cosmetic: the pipeline worker caps uploads at
 * MAX_AUDIO_BYTES = 50MB (sized for compressed opus, not raw PCM) — see
 * resample.ts for the full byte-budget reasoning. Periodic per-chunk
 * transcription (each chunk capped at PeriodicChunkEmitter's hardCapMs, tens
 * of seconds) keeps every individual upload trivially far under that cap
 * regardless of total meeting length — the ~27-minute whole-meeting ceiling
 * the old single-shot flow had no longer applies.
 *
 * Failure isolation: a thrown error (WAV encode, or the STT call itself) is
 * caught HERE, per chunk — it never aborts the rest of that channel's chunks,
 * let alone the other channel's. The caller is told via `failed: true` so it
 * can mark that chunk's channel (and therefore the whole meeting) failed,
 * without losing whatever OTHER chunks did transcribe successfully.
 *
 * Nothing here retains the input `samples` beyond this call: the encoded
 * `wav` Buffer is only ever passed into `tryManagedSTT` and never stored on
 * any object that outlives this function, so once this promise settles both
 * `samples` and `wav` are eligible for garbage collection.
 */
export async function transcribeChunk(
  channel: 'mic' | 'system',
  samples: Float32Array,
  channelsCount: number,
  sampleRate: number,
): Promise<ChunkTranscriptionResult> {
  try {
    const reduced = downmixAndResample(samples, channelsCount, sampleRate)
    // Fewer samples than one 16kHz slot holds — there is nothing to
    // transcribe. Not a failure: the chunk was simply (near-)silent/empty.
    if (reduced.samples.length === 0) return { text: '', failed: false }

    const wav = encodeWav(reduced.samples, reduced.sampleRate, 1)
    const durationSeconds = reduced.samples.length / reduced.sampleRate
    const result = await tryManagedSTT(wav, durationSeconds, 'dictation')
    // A NULL result is a FAILURE here, not an empty transcript — same
    // Finding-3 reasoning as the old whole-session flow: tryManagedSTT
    // returns null both when the call really failed AND when managed STT is
    // simply unavailable, and treating that as "successfully transcribed
    // nothing" is what produced a silent blank transcript on real audio.
    // We KNOW audio existed (reduced.samples.length > 0 above), so mark this
    // chunk's channel failed and let the caller factor that into the
    // meeting's overall status. Other chunks (this channel's and the other
    // channel's) are unaffected — this promise settling with `failed: true`
    // never rejects, so it can never take down `Promise.all` for the rest.
    if (!result) {
      console.error(`[notetaker] ${channel} chunk transcription unavailable or failed (managed STT returned no result)`)
      return { text: '', failed: true }
    }
    return { text: result.text ?? '', failed: false }
  } catch (err) {
    console.error(`[notetaker] ${channel} chunk transcription failed:`, err)
    return { text: '', failed: true }
  }
}

/**
 * Called once, from HookedNotetakerSession's stop() flow (notetakerInit.ts),
 * after a capture session ends and every chunk's transcribeChunk() promise
 * (mic + system) has already resolved. Interleaves both channels' per-chunk
 * transcripts by real timestamp (mergeChannelChunks), generates a title,
 * atomically writes transcript.json, and updates the meeting's DB row from
 * its start()-time 'recording' placeholder to its final status.
 *
 * No per-meeting audio file is written any more (the old flow's
 * audio-mic.wav/audio-system.wav, one whole-channel file each) — periodic
 * flushing WAV-encodes and uploads each chunk independently and never
 * accumulates a channel's full raw audio in memory, so there is no single
 * in-memory buffer left to write out as one file at session end. Recreating
 * that (e.g. streaming each chunk's PCM to a shared per-channel file on
 * disk) is a real, separable feature and out of this task's scope — see
 * task-6-report.md. `audio_mic_path`/`audio_system_path` are always null;
 * `notetaker:get-audio-url` already handles a null path by returning null,
 * so this degrades to "no playback" rather than a broken link.
 */
export async function persistSession(
  micChunks: TimedChunkText[],
  systemChunks: TimedChunkText[],
  meetingId: string,
  startedAt: number,
  endedAt: number,
  failed: boolean,
): Promise<void> {
  const meetingDir = path.join(app.getPath('userData'), 'meetings', meetingId)
  fs.mkdirSync(meetingDir, { recursive: true })

  const segments: TranscriptSegment[] = mergeChannelChunks(micChunks, systemChunks)
  const title = generateTitle(segments)

  const transcriptPath = 'transcript.json'
  const target = path.join(meetingDir, transcriptPath)
  const temp = `${target}.${process.pid}.tmp`
  fs.writeFileSync(temp, JSON.stringify(segments), 'utf8')
  fs.renameSync(temp, target)

  const status: DBMeeting['status'] = failed ? 'failed' : 'ready'

  insertMeeting({
    id: meetingId,
    title,
    started_at: startedAt,
    ended_at: endedAt,
    duration_ms: endedAt - startedAt,
    status,
    transcript_path: transcriptPath,
    audio_mic_path: null,
    audio_system_path: null,
  })
}

export function newMeetingId(): string {
  return randomUUID()
}
