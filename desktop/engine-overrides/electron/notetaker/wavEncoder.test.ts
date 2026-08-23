import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { encodeWav } from './wavEncoder'

describe('encodeWav', () => {
  test('produces a valid RIFF/WAVE header', () => {
    const buf = encodeWav(new Float32Array([0, 0.5, -0.5, 1, -1]), 16000, 1)
    assert.equal(buf.toString('ascii', 0, 4), 'RIFF')
    assert.equal(buf.toString('ascii', 8, 12), 'WAVE')
    assert.equal(buf.toString('ascii', 12, 16), 'fmt ')
  })

  test('fmt chunk encodes sample rate, channel count, and 16-bit PCM format', () => {
    const buf = encodeWav(new Float32Array([0]), 44100, 2)
    assert.equal(buf.readUInt16LE(20), 1) // PCM format code
    assert.equal(buf.readUInt16LE(22), 2) // channels
    assert.equal(buf.readUInt32LE(24), 44100) // sample rate
    assert.equal(buf.readUInt16LE(34), 16) // bits per sample
  })

  test('data chunk length matches sample count * 2 bytes (16-bit)', () => {
    const samples = new Float32Array(100)
    const buf = encodeWav(samples, 16000, 1)
    const dataChunkSize = buf.readUInt32LE(40)
    assert.equal(dataChunkSize, 100 * 2)
  })

  test('clamps out-of-range samples instead of wrapping', () => {
    const buf = encodeWav(new Float32Array([2.0, -2.0]), 16000, 1)
    const s1 = buf.readInt16LE(44)
    const s2 = buf.readInt16LE(46)
    assert.equal(s1, 32767)
    assert.equal(s2, -32768)
  })

  test('round-trips a mid-range sample within 16-bit quantization error', () => {
    const buf = encodeWav(new Float32Array([0.5]), 16000, 1)
    const s = buf.readInt16LE(44)
    assert.ok(Math.abs(s - 16383) <= 1)
  })

  test('empty input produces a valid header with zero-length data chunk', () => {
    const buf = encodeWav(new Float32Array([]), 16000, 1)
    assert.equal(buf.readUInt32LE(40), 0)
    assert.equal(buf.length, 44)
  })
})
