import type { TimestampedChunk } from '../notetakerSession'

export type FinalizedChannel = {
  samples: Float32Array
  sampleRate: number
  channels: number
  firstTimestampMs: number
} | null

type ChannelState = {
  parts: Float32Array[]
  sampleRate: number
  channels: number
  firstTimestampMs: number
}

/**
 * Accumulates timestamped audio chunks per channel (mic/system) during a
 * notetaker capture session, for later WAV-encoding + transcription on
 * stop. Format (sampleRate/channels) is taken from the first chunk fed for
 * that channel — every chunk from a given native/mic source is expected to
 * share the same format for the duration of one session.
 */
export class ChunkBuffer {
  private readonly mic: ChannelState = { parts: [], sampleRate: 0, channels: 0, firstTimestampMs: 0 }
  private readonly system: ChannelState = { parts: [], sampleRate: 0, channels: 0, firstTimestampMs: 0 }

  feed(chunk: TimestampedChunk): void {
    const state = chunk.source === 'mic' ? this.mic : this.system
    if (state.parts.length === 0) {
      state.sampleRate = chunk.sampleRate
      state.channels = chunk.channels
      state.firstTimestampMs = chunk.timestampMs
    }
    state.parts.push(chunk.samples)
  }

  finalize(source: 'mic' | 'system'): FinalizedChannel {
    const state = source === 'mic' ? this.mic : this.system
    if (state.parts.length === 0) return null

    const totalLength = state.parts.reduce((sum, part) => sum + part.length, 0)
    const merged = new Float32Array(totalLength)
    let offset = 0
    for (const part of state.parts) {
      merged.set(part, offset)
      offset += part.length
    }

    return {
      samples: merged,
      sampleRate: state.sampleRate,
      channels: state.channels,
      firstTimestampMs: state.firstTimestampMs,
    }
  }
}
