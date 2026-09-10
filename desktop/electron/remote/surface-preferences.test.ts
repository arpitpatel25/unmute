import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  FIXED_SURFACE_APPEARANCE,
  FIXED_SURFACE_TONE,
  enforceFixedSurfacePreferences,
} from './surface-preferences'

test('every persisted surface combination is normalized to Glass and Fixed', () => {
  for (const surfaceTone of ['spaceGray', 'black', 'glass']) {
    for (const surfaceAppearance of ['system', 'glass', 'solid']) {
      const values = new Map<string, unknown>([
        ['surfaceTone', surfaceTone],
        ['surfaceAppearance', surfaceAppearance],
      ])

      enforceFixedSurfacePreferences({
        get: key => values.get(key),
        set: (key, value) => values.set(key, value),
      })

      assert.equal(values.get('surfaceTone'), FIXED_SURFACE_TONE)
      assert.equal(values.get('surfaceAppearance'), FIXED_SURFACE_APPEARANCE)
    }
  }
})

test('normalization reports only values that actually changed', () => {
  const values = new Map<string, unknown>([
    ['surfaceTone', 'black'],
    ['surfaceAppearance', 'solid'],
  ])

  const changed = enforceFixedSurfacePreferences({
    get: key => values.get(key),
    set: (key, value) => values.set(key, value),
  })

  assert.deepEqual(changed, { surfaceTone: true, surfaceAppearance: false })
})
