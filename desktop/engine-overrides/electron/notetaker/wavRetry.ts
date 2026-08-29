import fs from 'node:fs'
import type { EncodedChunk } from './transcribeSession'

const WAV_HEADER_BYTES = 44
const DEFAULT_MAX_CHUNK_SECONDS = 10 * 60
const ACTIVITY_FRAME_MS = 10
const SPEECH_RMS = 0.015
const MIN_AUDIBLE_MS = 500

export type RetryWavChunk = {
  encoded: EncodedChunk
  offsetSeconds: number
  hasEnoughSpeech: boolean
}

function writePcmWavHeader(target: Buffer, dataBytes: number, sampleRate: number, channels: number, bitsPerSample: number): void {
  const bytesPerSample = bitsPerSample / 8
  target.write('RIFF', 0, 'ascii')
  target.writeUInt32LE(36 + dataBytes, 4)
  target.write('WAVE', 8, 'ascii')
  target.write('fmt ', 12, 'ascii')
  target.writeUInt32LE(16, 16)
  target.writeUInt16LE(1, 20)
  target.writeUInt16LE(channels, 22)
  target.writeUInt32LE(sampleRate, 24)
  target.writeUInt32LE(sampleRate * channels * bytesPerSample, 28)
  target.writeUInt16LE(channels * bytesPerSample, 32)
  target.writeUInt16LE(bitsPerSample, 34)
  target.write('data', 36, 'ascii')
  target.writeUInt32LE(dataBytes, 40)
}

function chunkHasEnoughSpeech(wav: Buffer, sampleRate: number, channels: number, minimumMs = MIN_AUDIBLE_MS): boolean {
  const frameSamples = Math.max(1, Math.round(sampleRate * ACTIVITY_FRAME_MS / 1000))
  const frameBytes = frameSamples * channels * 2
  let audibleMs = 0
  for (let from = WAV_HEADER_BYTES; from < wav.length; from += frameBytes) {
    const to = Math.min(wav.length, from + frameBytes)
    let energy = 0
    let samples = 0
    for (let i = from; i + 1 < to; i += 2) {
      const sample = wav.readInt16LE(i) / 32768
      energy += sample * sample
      samples++
    }
    if (samples > 0 && Math.sqrt(energy / samples) >= SPEECH_RMS) {
      audibleMs += samples * 1000 / (sampleRate * channels)
      if (audibleMs >= minimumMs) return true
    }
  }
  return false
}

/**
 * Streams a retained PCM WAV into bounded STT requests. A full meeting WAV
 * can exceed the managed endpoint's 50 MB limit; yielding one chunk at a
 * time also avoids retaining the whole recording in the Electron main
 * process. The source format is intentionally restricted to WavAppender's
 * standard 16-bit PCM layout.
 */
export function* readRetryWavChunks(filePath: string, maxChunkSeconds = DEFAULT_MAX_CHUNK_SECONDS): Generator<RetryWavChunk> {
  let fd: number | null = null
  try {
    fd = fs.openSync(filePath, 'r')
    const header = Buffer.alloc(WAV_HEADER_BYTES)
    if (fs.readSync(fd, header, 0, header.length, 0) !== header.length) return
    if (header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') return
    if (header.toString('ascii', 12, 16) !== 'fmt ' || header.toString('ascii', 36, 40) !== 'data') return
    const format = header.readUInt16LE(20)
    const channels = header.readUInt16LE(22)
    const sampleRate = header.readUInt32LE(24)
    const bitsPerSample = header.readUInt16LE(34)
    if (format !== 1 || channels < 1 || sampleRate <= 0 || bitsPerSample !== 16) return

    const bytesPerFrame = channels * 2
    const declaredDataBytes = header.readUInt32LE(40)
    const availableDataBytes = Math.max(0, fs.fstatSync(fd).size - WAV_HEADER_BYTES)
    const dataBytes = Math.min(declaredDataBytes, availableDataBytes)
    const maxFrames = Math.max(1, Math.floor(maxChunkSeconds * sampleRate))
    const maxBytes = maxFrames * bytesPerFrame

    for (let dataOffset = 0; dataOffset < dataBytes; dataOffset += maxBytes) {
      const requestedBytes = Math.min(maxBytes, dataBytes - dataOffset)
      const wav = Buffer.allocUnsafe(WAV_HEADER_BYTES + requestedBytes)
      const bytesRead = fs.readSync(fd, wav, WAV_HEADER_BYTES, requestedBytes, WAV_HEADER_BYTES + dataOffset)
      if (bytesRead <= 0) break
      const alignedBytes = bytesRead - (bytesRead % bytesPerFrame)
      if (alignedBytes <= 0) break
      writePcmWavHeader(wav, alignedBytes, sampleRate, channels, bitsPerSample)
      const finalWav = alignedBytes === requestedBytes ? wav : wav.subarray(0, WAV_HEADER_BYTES + alignedBytes)
      const frameOffset = dataOffset / bytesPerFrame
      const frameCount = alignedBytes / bytesPerFrame
      yield {
        encoded: { wav: finalWav, durationSeconds: frameCount / sampleRate, sampleRate },
        offsetSeconds: frameOffset / sampleRate,
        hasEnoughSpeech: chunkHasEnoughSpeech(finalWav, sampleRate, channels),
      }
    }
  } catch {
    return
  } finally {
    if (fd !== null) fs.closeSync(fd)
  }
}
