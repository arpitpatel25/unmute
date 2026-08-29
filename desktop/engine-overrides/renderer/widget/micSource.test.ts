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
  selectableMacInputs,
  AUTOMATIC_DEVICE_ID,
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

// ── Mac-side input choice (Settings → Audio → Microphone) ──────────────────
// This picker used to be decorative: its value lived in React state and
// nothing read it, so a USB mic could only be reached by changing the macOS
// system default. These cover the semantics that make the choice real.
const usb: AudioInputDeviceInfo = {
  kind: 'audioinput',
  label: 'Shure MV7 (USB Audio)',
  deviceId: 'usb-id',
}
const defaultAlias: AudioInputDeviceInfo = {
  kind: 'audioinput',
  label: 'Default - MacBook Air Microphone',
  deviceId: 'default',
}
const speakers: AudioInputDeviceInfo = {
  kind: 'audiooutput',
  label: 'MacBook Air Speakers',
  deviceId: 'out-id',
}

describe('selectableMacInputs', () => {
  it('offers a USB mic alongside the built-in — the bug this fixes', () => {
    assert.deepEqual(
      selectableMacInputs([builtIn, usb]).map((d) => d.deviceId),
      ['built-in-id', 'usb-id']
    )
  })

  it('excludes the iPhone — the widget glyph owns that choice, not this list', () => {
    assert.deepEqual(
      selectableMacInputs([builtIn, iphone]).map((d) => d.deviceId),
      ['built-in-id']
    )
  })

  it('excludes outputs and the synthetic "default" alias', () => {
    assert.deepEqual(
      selectableMacInputs([defaultAlias, builtIn, speakers]).map((d) => d.deviceId),
      ['built-in-id']
    )
  })

  it('drops entries with no deviceId (permission not yet granted)', () => {
    const blank: AudioInputDeviceInfo = { kind: 'audioinput', label: '', deviceId: '' }
    assert.deepEqual(selectableMacInputs([blank, builtIn]).map((d) => d.deviceId), ['built-in-id'])
  })

  it('de-duplicates repeated deviceIds', () => {
    assert.equal(selectableMacInputs([builtIn, { ...builtIn }]).length, 1)
  })
})

describe('resolveCaptureDeviceId with a chosen Mac input', () => {
  it('captures from the chosen USB mic', () => {
    assert.equal(resolveCaptureDeviceId('mac', [builtIn, usb], 'usb-id'), 'usb-id')
  })

  it('AUTOMATIC resolves to undefined — follow whatever macOS is set to', () => {
    assert.equal(
      resolveCaptureDeviceId('mac', [builtIn, usb], AUTOMATIC_DEVICE_ID),
      undefined
    )
  })

  it('a chosen device that is gone falls back to automatic, not a dead id', () => {
    assert.equal(resolveCaptureDeviceId('mac', [builtIn], 'usb-id'), undefined)
  })

  it('the iPhone still wins when it is preferred and the phone is here', () => {
    assert.equal(
      resolveCaptureDeviceId('iphone', [builtIn, usb, iphone], 'usb-id'),
      'iphone-id'
    )
  })

  it('iPhone preferred but absent falls back to the chosen Mac input', () => {
    assert.equal(resolveCaptureDeviceId('iphone', [builtIn, usb], 'usb-id'), 'usb-id')
  })

  it('no choice recorded behaves exactly as before (system default)', () => {
    assert.equal(resolveCaptureDeviceId('mac', [builtIn, usb]), undefined)
  })
})
