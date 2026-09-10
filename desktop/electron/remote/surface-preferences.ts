export const FIXED_SURFACE_APPEARANCE = 'solid' as const
export const FIXED_SURFACE_TONE = 'glass' as const

type SurfacePreferenceKey = 'surfaceAppearance' | 'surfaceTone'

export interface SurfacePreferenceStore {
  get(key: SurfacePreferenceKey): unknown
  set(key: SurfacePreferenceKey, value: string): unknown
}

/**
 * Surface customization is temporarily unavailable. Normalize persisted
 * installs as well as fresh ones so hidden legacy choices cannot reappear
 * after a restart or helper respawn.
 */
export function enforceFixedSurfacePreferences(store: SurfacePreferenceStore): {
  surfaceTone: boolean
  surfaceAppearance: boolean
} {
  const changed = {
    surfaceTone: store.get('surfaceTone') !== FIXED_SURFACE_TONE,
    surfaceAppearance: store.get('surfaceAppearance') !== FIXED_SURFACE_APPEARANCE,
  }

  if (changed.surfaceTone) store.set('surfaceTone', FIXED_SURFACE_TONE)
  if (changed.surfaceAppearance) store.set('surfaceAppearance', FIXED_SURFACE_APPEARANCE)
  return changed
}
