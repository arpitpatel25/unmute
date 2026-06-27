// Surface = the app/tool a task operates on; it is the flat namespace recipes
// live under. For the memory loop to close (inject → corroborate → promote), the
// SAME kind of task must always map to the SAME surface — so both the router and
// the librarian draw from ONE canonical vocabulary, and any off-vocabulary label
// is normalized away. (Live testing showed a recipe born under "x" that a later
// "general"-routed task never re-injected, so it could never climb confidence.)
export const GENERAL_SURFACE = 'general'

// The canonical surface vocabulary. `general` is the implicit fallback and is
// deliberately NOT in this list (it is not a stored namespace the router should
// pick). Extend deliberately — every entry must have keywords below AND be
// understood by the router prompt (which renders this list).
export const SURFACES = [
  'gmail', 'google-calendar', 'google-sheets', 'google-docs', 'google-drive',
  'canva', 'youtube', 'x', 'jiohotstar', 'whatsapp', 'macos',
] as const

const SURFACE_SET: ReadonlySet<string> = new Set(SURFACES)

// First match wins; order matters where keywords overlap (sheets before docs;
// the specific app names — whatsapp, jiohotstar — before the broad "macos").
const SURFACE_KEYWORDS: Array<[string, string[]]> = [
  ['gmail', ['email', 'inbox', 'inboxes', 'gmail', 'mail']],
  ['google-calendar', ['calendar', 'meeting', 'meetings', 'schedule', 'event', 'events']],
  ['google-sheets', ['sheet', 'sheets', 'spreadsheet']],
  ['google-docs', ['google doc', 'google docs', 'document']],
  ['google-drive', ['drive', 'my files']],
  ['canva', ['canva', 'design']],
  ['youtube', ['youtube', 'video', 'channel']],
  ['x', ['tweet', 'tweets', 'twitter', 'x.com', 'retweet']],
  ['jiohotstar', ['jiohotstar', 'jio hotstar', 'hotstar']],
  ['whatsapp', ['whatsapp']],
  ['macos', ['uninstall', 'mac app', 'macos', 'mac os', 'finder']],
]

export function detectSurface(intent: string): string {
  const t = (intent || '').toLowerCase()
  for (const [surface, kws] of SURFACE_KEYWORDS) {
    if (kws.some((k) => new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(t))) return surface
  }
  return GENERAL_SURFACE
}

/** True only for a stored, canonical surface (NOT `general`, which is the
 *  fallback rather than a namespace anyone should pick explicitly). */
export function isKnownSurface(s: string): boolean {
  return SURFACE_SET.has(s)
}

/** Normalize a free-form surface label (e.g. from the router LM) to the
 *  canonical vocabulary: lowercased if known, else `undefined` so the caller
 *  falls back to `detectSurface`. Keeps the store from fragmenting on
 *  synonyms/casing ("X" vs "x", "twitter" never reaching the store as its own
 *  bucket). */
export function normalizeSurface(s: string | undefined | null): string | undefined {
  if (!s || !s.trim()) return undefined
  const low = s.trim().toLowerCase()
  return SURFACE_SET.has(low) ? low : undefined
}
