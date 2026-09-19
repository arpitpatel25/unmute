import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { encodeWav } from './wavEncoder'
import { createMeetingRecording, reconcileRecordingStarts } from './wavMixer'

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'notetaker-wav-mixer-'))
}

function writeWav(file: string, samples: number[], rate = 16000): void {
  fs.writeFileSync(file, encodeWav(new Float32Array(samples), rate, 1))
}

function sampleAt(file: Buffer, index: number): number {
  return file.readInt16LE(44 + index * 2) / 32768
}

describe('createMeetingRecording', () => {
  test('uses the system lane once while it is active instead of summing an echo from mic', () => {
    const dir = tempDir()
    const mic = path.join(dir, 'mic.wav')
    const system = path.join(dir, 'system.wav')
    const output = path.join(dir, 'meeting.wav')
    writeWav(mic, new Array(500).fill(0.5))
    writeWav(system, new Array(500).fill(0.25))

    assert.equal(createMeetingRecording(mic, system, output), true)
    const result = fs.readFileSync(output)
    assert.equal(result.toString('ascii', 0, 4), 'RIFF')
    assert.equal(result.readUInt16LE(22), 1)
    assert.ok(Math.abs(sampleAt(result, 300) - 0.25) < 0.02)
  })

  test('keeps the available source when the other side is absent', () => {
    const dir = tempDir()
    const mic = path.join(dir, 'mic.wav')
    const output = path.join(dir, 'meeting.wav')
    writeWav(mic, [0.3, -0.2])
    assert.equal(createMeetingRecording(mic, null, output), true)
    assert.deepEqual(fs.readFileSync(output), fs.readFileSync(mic))
  })

  test('keeps delayed speaker reflection muted after the system voice stops', () => {
    const dir = tempDir()
    const mic = path.join(dir, 'mic.wav')
    const system = path.join(dir, 'system.wav')
    const output = path.join(dir, 'meeting.wav')
    const rate = 16000
    const micSamples = new Array(rate).fill(0)
    const systemSamples = new Array(rate).fill(0)
    // Clean far-end speech occupies 0-100ms. Its acoustic reflection reaches
    // the microphone later, from 170-270ms. Local speech begins well after
    // the de-echo hangover and must still be retained.
    for (let i = 0; i < rate * 0.1; i++) systemSamples[i] = 0.25
    for (let i = rate * 0.17; i < rate * 0.27; i++) micSamples[i] = 0.45
    for (let i = rate * 0.6; i < rate * 0.8; i++) micSamples[i] = 0.35
    writeWav(mic, micSamples, rate)
    writeWav(system, systemSamples, rate)

    assert.equal(createMeetingRecording(mic, system, output), true)
    const result = fs.readFileSync(output)
    assert.ok(Math.abs(sampleAt(result, Math.round(rate * 0.22))) < 0.01)
    assert.ok(Math.abs(sampleAt(result, Math.round(rate * 0.7)) - 0.35) < 0.02)
  })

  test('aligns independently-started files before composing the one playback stream', () => {
    const dir = tempDir()
    const mic = path.join(dir, 'mic.wav')
    const system = path.join(dir, 'system.wav')
    const output = path.join(dir, 'meeting.wav')
    writeWav(mic, new Array(9600).fill(0.4))
    writeWav(system, new Array(1600).fill(0.2))

    assert.equal(createMeetingRecording(mic, system, output, { micStartMs: 100, systemStartMs: 0 }), true)
    const result = fs.readFileSync(output)
    // 100ms × 16kHz of timeline padding is kept. The first section is system
    // only; after its activity has released, the mic's later-starting audio
    // remains instead of being overlaid at sample zero.
    assert.equal((result.length - 44) / 2, 11200)
    assert.ok(Math.abs(sampleAt(result, 400) - 0.2) < 0.02)
    assert.ok(Math.abs(sampleAt(result, 10000) - 0.4) < 0.02)
  })

  test('uses the one known lane start when timing metadata is partial', () => {
    const dir = tempDir()
    const mic = path.join(dir, 'mic.wav')
    const system = path.join(dir, 'system.wav')
    const output = path.join(dir, 'meeting.wav')
    writeWav(mic, new Array(100).fill(0.2), 100)
    writeWav(system, new Array(100).fill(0), 100)
    assert.equal(createMeetingRecording(mic, system, output, { micStartMs: 1_000 }), true)
    assert.equal((fs.readFileSync(output).length - 44) / 2, 100)
  })

  // 2026-09-15: the renderer's mic clock lagged wall time by the ~9h the Mac
  // had slept, so the mixer padded the mic lane with 9h of silence — a 2.3GB
  // Float32Array for a one-hour meeting — threw, and the meeting sat on
  // "Preparing notes…" forever.
  test('ignores a lane start skew no real capture can produce instead of padding hours of silence', () => {
    const dir = tempDir()
    const mic = path.join(dir, 'mic.wav')
    const system = path.join(dir, 'system.wav')
    const output = path.join(dir, 'meeting.wav')
    writeWav(mic, new Array(100).fill(0.2), 100)
    writeWav(system, new Array(100).fill(0), 100)
    const nineHoursMs = 9 * 60 * 60 * 1000
    assert.equal(createMeetingRecording(mic, system, output, { micStartMs: 0, systemStartMs: nineHoursMs }), true)
    assert.equal((fs.readFileSync(output).length - 44) / 2, 100)
  })

  test('returns false instead of throwing when the recording cannot be composed', () => {
    const dir = tempDir()
    const mic = path.join(dir, 'mic.wav')
    const system = path.join(dir, 'system.wav')
    writeWav(mic, new Array(100).fill(0.2), 100)
    writeWav(system, new Array(100).fill(0), 100)
    const unreadableStarts = Object.defineProperty({}, 'micStartMs', { get: () => { throw new Error('boom') } })
    assert.equal(createMeetingRecording(mic, system, path.join(dir, 'meeting.wav'), unreadableStarts), false)
  })
})

describe('reconcileRecordingStarts', () => {
  test('keeps plausible lane starts untouched', () => {
    assert.deepEqual(reconcileRecordingStarts({ micStartMs: 1_140, systemStartMs: 1_000 }), { micStartMs: 1_140, systemStartMs: 1_000 })
  })

  test('re-anchors the mic lane on the native system clock when the two disagree by more than a capture could', () => {
    const systemStartMs = 1_789_464_746_877
    const micStartMs = 1_789_432_567_969 // the real, sleep-lagged value from 2026-09-15
    assert.deepEqual(reconcileRecordingStarts({ micStartMs, systemStartMs }), { micStartMs: systemStartMs, systemStartMs })
  })

  test('passes partial timing metadata through', () => {
    assert.deepEqual(reconcileRecordingStarts({ micStartMs: 5 }), { micStartMs: 5 })
  })
})
