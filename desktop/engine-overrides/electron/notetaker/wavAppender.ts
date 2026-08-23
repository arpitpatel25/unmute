import fs from 'node:fs'
import { encodeWav } from './wavEncoder'

/**
 * Streams one channel's periodic chunks into a single playable WAV file on
 * disk, incrementally — restores the pre-periodic-flush "You"/"Them"
 * playback file (`audio-mic.wav`/`audio-system.wav`, consumed by
 * `notetaker:get-audio-url` and `MeetingDetail.tsx`) WITHOUT reintroducing
 * the whole-channel in-memory buffering that periodic flushing exists to
 * remove. Each chunk's PCM payload is written to disk as soon as it's
 * encoded (see notetakerInit.ts's makeChunkHandler) — never held in RAM
 * alongside any other chunk's.
 *
 * WAV's 44-byte header encodes two sizes (RIFF chunk size, data chunk size)
 * that aren't known until every chunk has been appended, so this writes a
 * placeholder header up front (sequential write, advances the fd's file
 * position to 44), appends each chunk's raw PCM bytes sequentially after
 * that (also sequential writes, so they land in call order), then patches
 * just those two 4-byte size fields in place via explicit-offset writes at
 * close() — explicit-offset writes (Node's fs.writeSync with a `position`
 * argument, POSIX pwrite() under the hood) do not disturb the fd's ongoing
 * sequential write position, so interleaving them with the plain sequential
 * writes above is safe as long as the two patches only ever happen once,
 * at the very end, after every append() has already happened.
 */
export class WavAppender {
  private fd: number
  private dataBytes = 0
  private readonly sampleRateValue: number
  private closed = false

  constructor(filePath: string, sampleRate: number) {
    this.sampleRateValue = sampleRate
    this.fd = fs.openSync(filePath, 'w')
    try {
      // encodeWav() on zero samples produces exactly a valid 44-byte
      // RIFF/WAVE/fmt/data header with both size fields at 0 — reused here
      // as the placeholder rather than duplicating the header-layout logic.
      const header = encodeWav(new Float32Array(0), sampleRate, 1)
      fs.writeSync(this.fd, header) // sequential: fd position 0 -> 44
    } catch (e) {
      fs.closeSync(this.fd) // don't leak the fd if the caller retries construction
      throw e
    }
  }

  /** The sample rate this writer's header was created with. A later chunk
   *  encoded at a different rate must not be appended under this header —
   *  see notetakerInit.ts's fail-safe skip-and-warn on a mismatch. */
  get rate(): number {
    return this.sampleRateValue
  }

  /** Total PCM bytes appended so far (post-header). */
  get bytesWritten(): number {
    return this.dataBytes
  }

  /**
   * Appends one chunk's raw 16-bit PCM bytes (its encodeWav() output with
   * the leading 44-byte header already stripped by the caller) to the file,
   * in call order. A no-op once close() has run.
   */
  append(pcmBytes: Buffer): void {
    if (this.closed || pcmBytes.length === 0) return
    fs.writeSync(this.fd, pcmBytes) // sequential: continues from wherever the fd position already is
    this.dataBytes += pcmBytes.length
  }

  /**
   * Patches the RIFF chunk size (offset 4: `36 + dataBytes`) and the data
   * chunk size (offset 40: `dataBytes`) now that the total is known, then
   * closes the fd. Safe to call with zero bytes ever appended (leaves a
   * valid, silent, header-only WAV file). Idempotent — a second call is a
   * no-op, never double-patches or double-closes the fd.
   */
  close(): void {
    if (this.closed) return
    this.closed = true
    try {
      const riffSize = Buffer.alloc(4)
      riffSize.writeUInt32LE(36 + this.dataBytes, 0)
      fs.writeSync(this.fd, riffSize, 0, 4, 4) // explicit position: pwrite, doesn't touch the sequential cursor
      const dataSize = Buffer.alloc(4)
      dataSize.writeUInt32LE(this.dataBytes, 0)
      fs.writeSync(this.fd, dataSize, 0, 4, 40)
    } finally {
      fs.closeSync(this.fd)
    }
  }
}
