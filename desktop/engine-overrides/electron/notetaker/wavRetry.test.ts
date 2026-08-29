import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { encodeWav } from './wavEncoder'
import { readRetryWavChunks } from './wavRetry'

test('readRetryWavChunks splits PCM audio and preserves timeline offsets', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unmute-wav-retry-'))
  const file = path.join(dir, 'recording.wav')
  try {
    const samples = new Float32Array(30)
    samples.fill(0.25)
    fs.writeFileSync(file, encodeWav(samples, 10, 1))
    const chunks = [...readRetryWavChunks(file, 1)]
    assert.equal(chunks.length, 3)
    assert.deepEqual(chunks.map((chunk) => chunk.offsetSeconds), [0, 1, 2])
    assert.deepEqual(chunks.map((chunk) => chunk.encoded.durationSeconds), [1, 1, 1])
    assert.ok(chunks.every((chunk) => chunk.encoded.wav.length === 64))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('readRetryWavChunks rejects unsupported input without throwing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unmute-wav-retry-'))
  const file = path.join(dir, 'recording.wav')
  try {
    fs.writeFileSync(file, 'not a wav')
    assert.deepEqual([...readRetryWavChunks(file)], [])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
