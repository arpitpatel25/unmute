// Tests for the mic-source resolution module — the pure semantics behind the
// iPhone-mic tap-to-switch feature. The rules under test (settled in design):
//
//   - MacBook mic is ALWAYS the default; the iPhone is opt-in via one tap.
//   - An iPhone mic is recognized from the Continuity device label.
//   - Preferring the iPhone while it's absent silently resolves to the Mac
//     mic (no error states, no prompts — the glyph is the only UI).
//   - Resolution happens per-recording; `undefined` deviceId means "system
//     default" downstream in getUserMedia.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  findIphoneMic,
  resolveCaptureDeviceId,
  effectiveSource,
  type AudioInputDeviceInfo,
} from './micSource'

const builtIn: AudioInputDeviceInfo = {
  kind: 'audioinput',
  label: 'MacBook Pro Microphone (Built-in)',
  deviceId: 'built-in-id',
}
const iphone: AudioInputDeviceInfo = {
  kind: 'audioinput',
  label: "Arpit's iPhone Microphone (Continuity Camera)",
  deviceId: 'iphone-id',
}
const iphoneCamera: AudioInputDeviceInfo = {
  kind: 'videoinput',
  label: "Arpit's iPhone Camera (Continuity Camera)",
  deviceId: 'iphone-cam-id',
}
const defaultAliasOfIphone: AudioInputDeviceInfo = {
  kind: 'audioinput',
  label: "Default - Arpit's iPhone Microphone (Continuity Camera)",
  deviceId: 'default',
}

describe('findIphoneMic', () => {
  it('returns null when only the built-in mic is present', () => {
    assert.equal(findIphoneMic([builtIn]), null)
  })

  it('finds a Continuity iPhone microphone by label', () => {
    assert.equal(findIphoneMic([builtIn, iphone])?.deviceId, 'iphone-id')
  })

  it('ignores the iPhone CAMERA (videoinput) — audio inputs only', () => {
    assert.equal(findIphoneMic([builtIn, iphoneCamera]), null)
  })

  it('prefers the concrete device entry over the "default" alias', () => {
    assert.equal(
      findIphoneMic([defaultAliasOfIphone, builtIn, iphone])?.deviceId,
      'iphone-id'
    )
  })

  it('falls back to the "default" alias if it is the only iPhone entry', () => {
    assert.equal(
      findIphoneMic([defaultAliasOfIphone, builtIn])?.deviceId,
      'default'
    )
  })

  it('handles permission-hidden empty labels without crashing', () => {
    const unlabeled: AudioInputDeviceInfo = { kind: 'audioinput', label: '', deviceId: 'x' }
    assert.equal(findIphoneMic([unlabeled]), null)
  })
})

describe('resolveCaptureDeviceId', () => {
  it('mac preference → undefined (system default), even with an iPhone present', () => {
    assert.equal(resolveCaptureDeviceId('mac', [builtIn, iphone]), undefined)
  })

  it('iphone preference with the phone present → its deviceId', () => {
    assert.equal(resolveCaptureDeviceId('iphone', [builtIn, iphone]), 'iphone-id')
  })

  it('iphone preference with the phone ABSENT → undefined (silent fallback)', () => {
    assert.equal(resolveCaptureDeviceId('iphone', [builtIn]), undefined)
  })
})

describe('effectiveSource', () => {
  it('is mac when preference is mac, regardless of devices', () => {
    assert.equal(effectiveSource('mac', [builtIn, iphone]), 'mac')
  })

  it('is iphone when preferred and present', () => {
    assert.equal(effectiveSource('iphone', [builtIn, iphone]), 'iphone')
  })

  it('is mac when iphone is preferred but absent (glyph shows the truth)', () => {
    assert.equal(effectiveSource('iphone', [builtIn]), 'mac')
  })
})
