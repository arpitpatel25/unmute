import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { WavAppender } from './wavAppender'
import { encodeWav } from './wavEncoder'

function tmpFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wav-appender-test-'))
  return path.join(dir, 'audio.wav')
}

describe('WavAppender', () => {
  test('constructor writes a valid 44-byte RIFF/WAVE/fmt/data header with zero sizes', () => {
    const file = tmpFile()
    const w = new WavAppender(file, 16000)
    w.close()
    const buf = fs.readFileSync(file)
    assert.equal(buf.length, 44)
    assert.equal(buf.toString('ascii', 0, 4), 'RIFF')
    assert.equal(buf.toString('ascii', 8, 12), 'WAVE')
    assert.equal(buf.toString('ascii', 12, 16), 'fmt ')
    assert.equal(buf.readUInt16LE(22), 1) // mono
    assert.equal(buf.readUInt32LE(24), 16000) // sample rate
    assert.equal(buf.readUInt32LE(40), 0) // data size, nothing appended
  })

  test('append() writes PCM bytes sequentially and close() patches both size fields', () => {
    const file = tmpFile()
    const w = new WavAppender(file, 16000)

    const chunk1 = encodeWav(new Float32Array([0.1, 0.2, 0.3]), 16000, 1).subarray(44)
    const chunk2 = encodeWav(new Float32Array([0.4, 0.5]), 16000, 1).subarray(44)
    w.append(chunk1)
    w.append(chunk2)
    assert.equal(w.bytesWritten, chunk1.length + chunk2.length)
    w.close()

    const buf = fs.readFileSync(file)
    const expectedDataBytes = chunk1.length + chunk2.length
    assert.equal(buf.length, 44 + expectedDataBytes)
    assert.equal(buf.readUInt32LE(40), expectedDataBytes) // data chunk size
    assert.equal(buf.readUInt32LE(4), 36 + expectedDataBytes) // RIFF chunk size
    // Data landed in call order (chunk1's bytes immediately after the header, chunk2's right after that).
    assert.deepEqual(buf.subarray(44, 44 + chunk1.length), Buffer.from(chunk1))
    assert.deepEqual(buf.subarray(44 + chunk1.length), Buffer.from(chunk2))
  })

  test('close() with nothing ever appended produces a valid, empty (silent) WAV file', () => {
    const file = tmpFile()
    const w = new WavAppender(file, 16000)
    w.close()
    const buf = fs.readFileSync(file)
    assert.equal(buf.length, 44)
    assert.equal(buf.readUInt32LE(40), 0)
    assert.equal(buf.readUInt32LE(4), 36)
  })

  test('close() is idempotent — a second call does not double-patch or throw', () => {
    const file = tmpFile()
    const w = new WavAppender(file, 16000)
    const chunk = encodeWav(new Float32Array([0.1]), 16000, 1).subarray(44)
    w.append(chunk)
    w.close()
    const before = fs.readFileSync(file)
    assert.doesNotThrow(() => w.close())
    const after = fs.readFileSync(file)
    assert.deepEqual(after, before)
  })

  test('append() after close() is a silent no-op, not a crash or a corrupted file', () => {
    const file = tmpFile()
    const w = new WavAppender(file, 16000)
    const chunk = encodeWav(new Float32Array([0.1, 0.2]), 16000, 1).subarray(44)
    w.append(chunk)
    w.close()
    const before = fs.readFileSync(file)
    assert.doesNotThrow(() => w.append(chunk))
    const after = fs.readFileSync(file)
    assert.deepEqual(after, before)
  })

  test('rate getter reflects the sample rate passed to the constructor', () => {
    const file = tmpFile()
    const w = new WavAppender(file, 44100)
    assert.equal(w.rate, 44100)
    w.close()
  })
})
