// Cheap, deterministic surface prior used to scope memory injection BEFORE the
// router exists (Phase 7 lets the router emit a better surface). Surface = the
// app/tool a task operates on; it is the flat namespace recipes live under.
export const GENERAL_SURFACE = 'general'

// First match wins; order matters where keywords overlap (sheets before docs).
const SURFACE_KEYWORDS: Array<[string, string[]]> = [
  ['gmail', ['email', 'inbox', 'inboxes', 'gmail', 'mail']],
  ['google-calendar', ['calendar', 'meeting', 'meetings', 'schedule', 'event', 'events']],
  ['google-sheets', ['sheet', 'sheets', 'spreadsheet']],
  ['google-docs', ['google doc', 'google docs', 'document']],
  ['google-drive', ['drive', 'my files']],
  ['canva', ['canva', 'design']],
  ['youtube', ['youtube', 'video', 'channel']],
]

export function detectSurface(intent: string): string {
  const t = (intent || '').toLowerCase()
  for (const [surface, kws] of SURFACE_KEYWORDS) {
    if (kws.some((k) => new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(t))) return surface
  }
  return GENERAL_SURFACE
}
