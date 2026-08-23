/**
 * Encodes raw PCM Float32 samples into a standard 16-bit PCM WAV file.
 * 16-bit rather than 32-bit float output because it's the most broadly
 * compatible format for both browser <audio> playback and the STT upload.
 */
export function encodeWav(samples: Float32Array, sampleRate: number, channels: number): Buffer {
  const bytesPerSample = 2
  const dataSize = samples.length * bytesPerSample
  const buffer = Buffer.alloc(44 + dataSize)

  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write('WAVE', 8, 'ascii')

  buffer.write('fmt ', 12, 'ascii')
  buffer.writeUInt32LE(16, 16) // fmt chunk size
  buffer.writeUInt16LE(1, 20) // PCM format code
  buffer.writeUInt16LE(channels, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  const blockAlign = channels * bytesPerSample
  buffer.writeUInt32LE(sampleRate * blockAlign, 28) // byte rate
  buffer.writeUInt16LE(blockAlign, 32)
  buffer.writeUInt16LE(16, 34) // bits per sample

  buffer.write('data', 36, 'ascii')
  buffer.writeUInt32LE(dataSize, 40)

  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]))
    const pcm = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff
    buffer.writeInt16LE(Math.round(pcm), 44 + i * bytesPerSample)
  }

  return buffer
}
