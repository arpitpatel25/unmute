import { test, describe } from 'node:test'
import assert from 'node:assert'
import {
  speechThreshold,
  heardSpeech,
  floatEquivalentOfByteRms,
  MIN_SPEECH_RMS,
  MAX_SPEECH_RMS,
} from './speechGate'

// Levels below are float rms (the meter this module is written for), with the
// dBFS in the name so the physical claim is visible: 20*log10(rms).
const SILENT_ROOM_FLOOR = 0.0006   // -64 dBFS: a quiet room on a wired mic
const WHISPER = 0.006              // -44 dBFS: the capture this gate was built for
const QUIET_SPEECH = 0.012         // -38 dBFS
const NORMAL_SPEECH = 0.08         // -22 dBFS: the MacBook mic's median capture
const CAFE_FLOOR = 0.012           // -38 dBFS: a real noisy-room floor

describe('speechThreshold', () => {
  test('quiet room: floor*4 is tiny, so the absolute minimum bar applies', () => {
    assert.equal(speechThreshold(SILENT_ROOM_FLOOR), MIN_SPEECH_RMS)
  })
  test('noisy room: scales to the floor so room tone cannot read as speech', () => {
    assert.ok(Math.abs(speechThreshold(0.003) - 0.012) < 1e-9)
  })
  test('never stricter than the old absolute bar, however loud the room', () => {
    assert.equal(speechThreshold(CAFE_FLOOR), MAX_SPEECH_RMS)
    assert.equal(speechThreshold(0.5), MAX_SPEECH_RMS)
  })
  test('no floor measured yet (recording under ~2s): the permissive minimum', () => {
    assert.equal(speechThreshold(null), MIN_SPEECH_RMS)
  })
})

describe('heardSpeech', () => {
  // THE REGRESSION TEST. Pre-fix this was false and the recording was thrown
  // away before STT — "nothing captured" on every whispered wired-mic dictation.
  test('a whisper in a quiet room IS speech', () => {
    assert.equal(heardSpeech(WHISPER, SILENT_ROOM_FLOOR), true)
  })
  test('a whisper before any floor is measured IS speech', () => {
    assert.equal(heardSpeech(WHISPER, null), true)
  })
  test('quiet and normal speech keep working', () => {
    assert.equal(heardSpeech(QUIET_SPEECH, SILENT_ROOM_FLOOR), true)
    assert.equal(heardSpeech(NORMAL_SPEECH, SILENT_ROOM_FLOOR), true)
    assert.equal(heardSpeech(NORMAL_SPEECH, CAFE_FLOOR), true)
  })
  test('an empty room is still not speech (an accidental key tap sends nothing)', () => {
    assert.equal(heardSpeech(SILENT_ROOM_FLOOR, SILENT_ROOM_FLOOR), false)
    assert.equal(heardSpeech(0.0009, null), false)
  })
  test('a dead pipe (digital zeros) is not speech', () => {
    assert.equal(heardSpeech(0, null), false)
    assert.equal(heardSpeech(0, 0), false)
  })
  test('room tone alone does not pass in a noisy room', () => {
    // Fan/café tone wandering a little above its own floor is not an utterance.
    assert.equal(heardSpeech(0.013, CAFE_FLOOR), false)
  })
})

describe('floatEquivalentOfByteRms', () => {
  // The old constants were calibrated against the 8-bit meter, which adds its
  // own quantization noise to every reading. Carrying them over unconverted
  // would silently tighten every threshold in the recorder.
  test('the old 0.015 speech bar becomes ~0.0143 on the float meter', () => {
    assert.ok(Math.abs(floatEquivalentOfByteRms(0.015) - 0.0143) < 0.0002)
  })
  test('loud speech is barely affected (quantization is negligible up there)', () => {
    assert.ok(Math.abs(floatEquivalentOfByteRms(0.08) - 0.08) < 0.0002)
  })
  test('a byte reading at or under the meter noise floor means silence', () => {
    assert.equal(floatEquivalentOfByteRms(0.004), 0)
    assert.equal(floatEquivalentOfByteRms(0), 0)
  })
})
