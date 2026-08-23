import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { tryManagedSTT } from '../paywall/paywall-route'
import { encodeWav } from './wavEncoder'
import { downmixAndResample } from './resample'
import type { ChunkBuffer, FinalizedChannel } from './chunkBuffer'
import { mergeTranscripts, generateTitle, type TranscriptSegment } from './transcriptMerge'
import { insertMeeting, type DBMeeting } from '../db'

/**
 * Result of encoding + (attempting to) transcribe one channel's finalized
 * audio. `audioPath` is set as soon as the WAV write succeeds, independent
 * of whether the STT call itself later fails — so a transcription failure
 * never throws away audio that was already safely on disk.
 */
type ChannelOutcome = {
  text: string
  audioPath: string | null
  failed: boolean
}

/**
 * Downmixes one channel's buffered samples to MONO 16kHz, encodes that to
 * WAV, writes it to `<meetingDir>/audio-<channel>.wav`, then transcribes it
 * through the same managed-STT pipeline dictation already uses
 * (`tryManagedSTT`).
 *
 * The mono/16k reduction is not cosmetic: the pipeline worker caps uploads at
 * MAX_AUDIO_BYTES = 50MB, and the system tap's native 48kHz STEREO PCM costs
 * 192,000 bytes/second once encoded as 16-bit WAV — i.e. the cap is hit at
 * ~4min33s of meeting. At mono 16kHz that is 32,000 bytes/second, so the safe
 * window is ~27 minutes. See resample.ts for the full reasoning.
 *
 * Failure isolation: a thrown error (WAV encode, or the STT call itself)
 * is caught HERE, per channel — it does not abort the other channel's
 * processing, and does not discard an audio file that was already written.
 * The caller is told about the failure via `failed: true` so it can mark
 * the meeting's status accordingly, but whatever transcript/audio WAS
 * produced is still persisted.
 */
async function processChannel(
  channel: 'mic' | 'system',
  finalized: FinalizedChannel,
  meetingDir: string,
): Promise<ChannelOutcome> {
  if (!finalized) return { text: '', audioPath: null, failed: false }

  let audioPath: string | null = null
  try {
    const reduced = downmixAndResample(finalized.samples, finalized.channels, finalized.sampleRate)
    // Fewer samples than one 16kHz slot holds — there is nothing to transcribe
    // and nothing worth writing. Not a failure: the channel was simply empty.
    if (reduced.samples.length === 0) return { text: '', audioPath: null, failed: false }

    const wav = encodeWav(reduced.samples, reduced.sampleRate, 1)
    const fileName = `audio-${channel}.wav`
    fs.writeFileSync(path.join(meetingDir, fileName), wav)
    audioPath = fileName // audio is on disk now — preserved even if the STT call below throws

    const durationSeconds = reduced.samples.length / reduced.sampleRate
    const result = await tryManagedSTT(wav, durationSeconds, 'dictation')
    // A NULL result is a FAILURE here, not an empty transcript. tryManagedSTT
    // returns null both when the call really failed (413 from the size cap,
    // network error, a 4xx from the STT provider) AND when managed STT is
    // simply unavailable (local engine mode, no access token) — and in 'auto'
    // engine mode it swallows rejections into that same null. Treating null as
    // "successfully transcribed nothing" is what produced the worst failure
    // mode this feature had: a meeting with real captured audio saved as
    // status:'ready' with a blank transcript, indistinguishable from a meeting
    // where nobody spoke. We KNOW audio existed (finalized was non-null and
    // survived the reduction), so mark the channel failed and let the caller
    // set status:'failed'. The audio file already written stays on disk.
    if (!result) {
      console.error(`[notetaker] ${channel} transcription unavailable or failed (managed STT returned no result)`)
      return { text: '', audioPath, failed: true }
    }
    return { text: result.text ?? '', audioPath, failed: false }
  } catch (err) {
    console.error(`[notetaker] ${channel} transcription failed:`, err)
    return { text: '', audioPath, failed: true }
  }
}

/**
 * Called once, from HookedNotetakerSession's stop() flow (notetakerInit.ts),
 * after a capture session ends. Encodes whatever was buffered on each
 * channel to WAV, transcribes both through the same managed-STT pipeline
 * dictation already uses, merges the results, and persists everything —
 * transcript.json forever, the two audio files for 24h (see db.ts's
 * sweepExpiredMeetingAudio).
 *
 * Mic and system channels are processed independently (see processChannel):
 * if one channel's STT call fails, the meeting is still persisted with
 * whatever audio/transcript the other channel produced, and `status` is set
 * to 'failed' so the UI can surface that this meeting is incomplete rather
 * than silently showing nothing.
 */
export async function transcribeAndPersistSession(
  buffer: ChunkBuffer,
  meetingId: string,
  startedAt: number,
  endedAt: number,
): Promise<void> {
  const meetingDir = path.join(app.getPath('userData'), 'meetings', meetingId)
  fs.mkdirSync(meetingDir, { recursive: true })

  const mic = buffer.finalize('mic')
  const system = buffer.finalize('system')

  const [micResult, systemResult] = await Promise.all([
    processChannel('mic', mic, meetingDir),
    processChannel('system', system, meetingDir),
  ])

  const status: DBMeeting['status'] = micResult.failed || systemResult.failed ? 'failed' : 'ready'

  const micDurationMs = mic ? (mic.samples.length / mic.channels / mic.sampleRate) * 1000 : 0
  const systemDurationMs = system ? (system.samples.length / system.channels / system.sampleRate) * 1000 : 0
  const segments: TranscriptSegment[] = mergeTranscripts(
    micResult.text, mic?.firstTimestampMs ?? 0, micDurationMs,
    systemResult.text, system?.firstTimestampMs ?? 0, systemDurationMs,
  )
  const title = generateTitle(segments)

  const transcriptPath = 'transcript.json'
  const target = path.join(meetingDir, transcriptPath)
  const temp = `${target}.${process.pid}.tmp`
  fs.writeFileSync(temp, JSON.stringify(segments), 'utf8')
  fs.renameSync(temp, target)

  insertMeeting({
    id: meetingId,
    title,
    started_at: startedAt,
    ended_at: endedAt,
    duration_ms: endedAt - startedAt,
    status,
    transcript_path: transcriptPath,
    audio_mic_path: micResult.audioPath,
    audio_system_path: systemResult.audioPath,
  })
}

export function newMeetingId(): string {
  return randomUUID()
}
