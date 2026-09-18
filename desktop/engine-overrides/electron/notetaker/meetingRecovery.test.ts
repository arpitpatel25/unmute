import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { meetingAudioIsExpired, recoverableAudioPaths } from './meetingRecovery'

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'notetaker-meeting-recovery-'))
}

describe('recoverableAudioPaths', () => {
  // A capture that never reached persistSession() keeps the start()-time
  // placeholder's NULL paths even though both WAVs are on disk. Without the
  // paths, "Regenerate from audio" is disabled and retry has nothing to read.
  test('finds the fixed-name lane files a crashed capture left behind', () => {
    const dir = tempDir()
    fs.writeFileSync(path.join(dir, 'audio-mic.wav'), 'x')
    fs.writeFileSync(path.join(dir, 'audio-system.wav'), 'x')
    assert.deepEqual(
      recoverableAudioPaths(dir, { audio_mic_path: null, audio_system_path: null }),
      { audio_mic_path: 'audio-mic.wav', audio_system_path: 'audio-system.wav' },
    )
  })

  test('keeps paths already recorded on the row', () => {
    const dir = tempDir()
    assert.deepEqual(
      recoverableAudioPaths(dir, { audio_mic_path: 'custom-mic.wav', audio_system_path: 'custom-system.wav' }),
      { audio_mic_path: 'custom-mic.wav', audio_system_path: 'custom-system.wav' },
    )
  })

  test('leaves a lane null when its file does not exist', () => {
    const dir = tempDir()
    fs.writeFileSync(path.join(dir, 'audio-system.wav'), 'x')
    assert.deepEqual(
      recoverableAudioPaths(dir, { audio_mic_path: null, audio_system_path: null }),
      { audio_mic_path: null, audio_system_path: 'audio-system.wav' },
    )
  })
})

describe('meetingAudioIsExpired', () => {
  const cutoff = 1_000

  test('expires audio of a finished meeting past the cutoff', () => {
    assert.equal(meetingAudioIsExpired({ ended_at: 999, status: 'ready' }, cutoff), true)
  })

  test('keeps audio younger than the cutoff', () => {
    assert.equal(meetingAudioIsExpired({ ended_at: 1_001, status: 'ready' }, cutoff), false)
  })

  // The audio is the only copy of a meeting whose transcript never landed.
  // Sweeping it on the normal 24h clock is how a crashed meeting's notes
  // become permanently unrecoverable.
  for (const status of ['recording', 'transcribing', 'failed'] as const) {
    test(`keeps audio of a ${status} meeting that never produced a transcript`, () => {
      assert.equal(meetingAudioIsExpired({ ended_at: 0, status }, cutoff), false)
    })
  }
})
