import fs from 'node:fs'
import { encodeWav } from './wavEncoder'

type PcmWav = { sampleRate: number; samples: Int16Array }
export type RecordingStartTimes = { micStartMs?: number | null; systemStartMs?: number | null }

/** Reads the small, standard PCM WAVs written by WavAppender. */
function readPcmWav(filePath: string): PcmWav | null {
  try {
    const bytes = fs.readFileSync(filePath)
    if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') return null
    if (bytes.toString('ascii', 12, 16) !== 'fmt ' || bytes.readUInt16LE(20) !== 1 || bytes.readUInt16LE(22) !== 1 || bytes.readUInt16LE(34) !== 16) return null
    const sampleRate = bytes.readUInt32LE(24)
    const dataBytes = Math.min(bytes.readUInt32LE(40), bytes.length - 44)
    if (bytes.toString('ascii', 36, 40) !== 'data' || sampleRate <= 0 || dataBytes <= 0) return null
    const samples = new Int16Array(dataBytes / 2)
    for (let i = 0; i < samples.length; i++) samples[i] = bytes.readInt16LE(44 + i * 2)
    return { sampleRate, samples }
  } catch {
    return null
  }
}

type AlignedLanes = { mic: PcmWav; system: PcmWav; micOffset: number; systemOffset: number; length: number }

/** Both lanes are started by the same capture-start call; in practice the mic
 * trails the native tap by ~100-300ms (permission grant + worklet attach). A
 * skew beyond this is a broken clock, not a real offset. */
const MAX_LANE_START_SKEW_MS = 60_000

/**
 * The native system tap reports host time; the mic lane's start comes from the
 * renderer's audio clock. When the two disagree by more than any capture could,
 * trust the native clock. On 2026-09-15 a sleep-lagged renderer clock put the
 * mic lane 9h early, and aligning to that padded a one-hour meeting with 9h of
 * silence — enough to throw, which left the meeting stuck processing forever.
 */
export function reconcileRecordingStarts(starts: RecordingStartTimes): RecordingStartTimes {
  const { micStartMs, systemStartMs } = starts
  if (micStartMs == null || systemStartMs == null) return starts
  if (Math.abs(micStartMs - systemStartMs) <= MAX_LANE_START_SKEW_MS) return starts
  return { micStartMs: systemStartMs, systemStartMs }
}

/** The two capture paths start independently, so align their files to the
 * shared capture timeline before making any audio decision. */
function alignLanes(mic: PcmWav, system: PcmWav, recordedStarts: RecordingStartTimes): AlignedLanes {
  const starts = reconcileRecordingStarts(recordedStarts)
  const fallbackStart = starts.micStartMs ?? starts.systemStartMs ?? 0
  const micStart = starts.micStartMs ?? fallbackStart
  const systemStart = starts.systemStartMs ?? fallbackStart
  const origin = Math.min(micStart, systemStart)
  const micOffset = Math.max(0, Math.round((micStart - origin) * mic.sampleRate / 1000))
  const systemOffset = Math.max(0, Math.round((systemStart - origin) * mic.sampleRate / 1000))
  return { mic, system, micOffset, systemOffset, length: Math.max(micOffset + mic.samples.length, systemOffset + system.samples.length) }
}

function laneSample(samples: Int16Array, index: number): number {
  return index >= 0 && index < samples.length ? samples[index] / 32768 : 0
}

const ACTIVITY_FRAME_MS = 10
const SYSTEM_SPEECH_RMS = 0.003
const SYSTEM_LOOKAHEAD_MS = 30
const SYSTEM_HANGOVER_MS = 350

/**
 * Marks the portions of the shared timeline owned by the clean system lane.
 *
 * A speaker-to-microphone reflection arrives *after* the corresponding
 * system samples. The old per-sample envelope released in roughly 20ms at
 * 16kHz, so the reflected voice could become audible from the mic lane while
 * the far-end speaker was between words or just after they stopped. Work in
 * short RMS frames and keep a real 350ms hangover instead. A small lookahead
 * also prevents the first reflected consonant from leaking at an onset.
 */
function systemActivityByFrame(lanes: AlignedLanes): { active: Uint8Array; frameSamples: number } {
  const frameSamples = Math.max(1, Math.round(lanes.mic.sampleRate * ACTIVITY_FRAME_MS / 1000))
  const frameCount = Math.ceil(lanes.length / frameSamples)
  const detected = new Uint8Array(frameCount)

  for (let frame = 0; frame < frameCount; frame++) {
    const from = frame * frameSamples
    const to = Math.min(lanes.length, from + frameSamples)
    let energy = 0
    for (let i = from; i < to; i++) {
      const sample = laneSample(lanes.system.samples, i - lanes.systemOffset)
      energy += sample * sample
    }
    const rms = Math.sqrt(energy / Math.max(1, to - from))
    if (rms >= SYSTEM_SPEECH_RMS) detected[frame] = 1
  }

  const active = new Uint8Array(frameCount)
  const lookaheadFrames = Math.ceil(SYSTEM_LOOKAHEAD_MS / ACTIVITY_FRAME_MS)
  const hangoverFrames = Math.ceil(SYSTEM_HANGOVER_MS / ACTIVITY_FRAME_MS)
  for (let frame = 0; frame < frameCount; frame++) {
    if (!detected[frame]) continue
    const from = Math.max(0, frame - lookaheadFrames)
    const to = Math.min(frameCount - 1, frame + hangoverFrames)
    active.fill(1, from, to + 1)
  }
  return { active, frameSamples }
}

/**
 * A single playback file needs mix-minus, not a raw sum. When system audio
 * is active it is already the clean far-end reference, while the mic may
 * contain the same voice through speakers. Give that reference exclusive
 * ownership then use mic only while system audio is quiet. Raw lanes remain
 * untouched, and this avoids pretending a fixed offline subtraction is AEC.
 */
function mixMinus(lanes: AlignedLanes): Float32Array {
  const output = new Float32Array(lanes.length)
  const activity = systemActivityByFrame(lanes)
  for (let i = 0; i < output.length; i++) {
    const system = laneSample(lanes.system.samples, i - lanes.systemOffset)
    const mic = laneSample(lanes.mic.samples, i - lanes.micOffset)
    const systemActive = activity.active[Math.floor(i / activity.frameSamples)] === 1
    output[i] = systemActive ? system : mic
  }
  return output
}

function writeMonoWav(outputPath: string, samples: Float32Array, sampleRate: number): boolean {
  try {
    fs.writeFileSync(outputPath, encodeWav(samples, sampleRate, 1))
    return true
  } catch {
    return false
  }
}

/** Produces the sole user-facing, mono meeting recording. Never throws: it
 * runs synchronously inside the capture stop path, ahead of transcript
 * persistence, so an exception here would strand the meeting. */
export function createMeetingRecording(
  micPath: string | null,
  systemPath: string | null,
  outputPath: string,
  starts: RecordingStartTimes = {},
): boolean {
  try {
    return composeMeetingRecording(micPath, systemPath, outputPath, starts)
  } catch {
    return false
  }
}

function composeMeetingRecording(
  micPath: string | null,
  systemPath: string | null,
  outputPath: string,
  starts: RecordingStartTimes = {},
): boolean {
  const mic = micPath ? readPcmWav(micPath) : null
  const system = systemPath ? readPcmWav(systemPath) : null
  if (!mic && !system) return false
  if (!mic || !system || mic.sampleRate !== system.sampleRate) {
    const source = micPath && mic ? micPath : systemPath
    if (!source) return false
    try {
      fs.copyFileSync(source, outputPath)
      return true
    } catch {
      return false
    }
  }
  return writeMonoWav(outputPath, mixMinus(alignLanes(mic, system, starts)), mic.sampleRate)
}
