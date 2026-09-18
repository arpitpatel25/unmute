import fs from 'node:fs'
import path from 'node:path'

type AudioPaths = { audio_mic_path: string | null; audio_system_path: string | null }

/** The fixed filenames makeChunkHandler's WavAppender writes each lane to. */
const LANE_FILES = { audio_mic_path: 'audio-mic.wav', audio_system_path: 'audio-system.wav' } as const

/**
 * The audio paths a meeting can be regenerated from. A capture that crashed or
 * was quit before persistSession() keeps the placeholder row's NULL paths while
 * its lanes sit on disk under their fixed names; attaching those is what makes
 * "Regenerate from audio" possible for it at all.
 */
export function recoverableAudioPaths(meetingDir: string, row: AudioPaths): AudioPaths {
  const resolve = (column: keyof AudioPaths): string | null =>
    row[column] ?? (fs.existsSync(path.join(meetingDir, LANE_FILES[column])) ? LANE_FILES[column] : null)
  return { audio_mic_path: resolve('audio_mic_path'), audio_system_path: resolve('audio_system_path') }
}

/** Statuses with no durable transcript: the audio is the meeting's only copy. */
const UNTRANSCRIBED_STATUSES: ReadonlySet<string> = new Set(['recording', 'transcribing', 'failed'])

/**
 * Meeting audio normally expires 24h after the meeting ends. Not while the
 * meeting has no transcript — sweeping then deletes the only source its notes
 * could ever be regenerated from. Once a retry succeeds the row is `ready` and
 * the normal clock applies again.
 */
export function meetingAudioIsExpired(row: { ended_at: number; status: string }, cutoff: number): boolean {
  return row.ended_at < cutoff && !UNTRANSCRIBED_STATUSES.has(row.status)
}
