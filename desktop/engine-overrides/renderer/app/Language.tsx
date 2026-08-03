// Language — a Settings SECTION (it used to be a top-level tab).
//
// Moved as-is, per SPEC §2.5, with three changes and no behaviour touched:
//   * the page's own <h2> and width cap are gone — Settings owns both now;
//   * the bespoke toggle button is `Toggle` from _shared.tsx, because D8 fixes
//     ONE control vocabulary and a second toggle drawn to a different size and
//     colour is exactly what that rules out;
//   * the two 12-pixel sizes moved to 12.5, the nearest step on D8's scale.
// Every IPC call and both settings keys are unchanged.
//
// The Whisper API is binary: send one ISO-639-1 code, or omit the field
// entirely so the model auto-detects across all 99 supported languages.
// There is no multi-language or constrained-detect option. We mirror that
// shape: one language card highlighted, plus an Auto-detect toggle.
//
// Auto-detect ON  → request omits `language` (slower + slightly less
//                    accurate; works with any language).
// Auto-detect OFF → request sends the picked code (faster + more accurate;
//                    locked to that one language).
//
// Persisted via electron-store:
//   sttLanguageAutoDetect: boolean (default true)
//   sttLanguage:          string  (default 'en')
// Saved on every interaction — no save button.

import { useState, useEffect, useMemo } from 'react'
import { LANGUAGES, languageByCode } from './languages'
import { Toggle } from './_shared'

/** Typed accessor for the preload bridge — see the note in Permissions.tsx.
 *  `window.electronAPI` is undeclared in the renderer's types, so going through
 *  a cast window is the same runtime access with the type errors removed. */
interface LanguageApi {
  paywallGetLanguageAutoDetect?: () => Promise<boolean>
  paywallGetLanguage?: () => Promise<string>
  paywallSetLanguageAutoDetect?: (v: boolean) => Promise<unknown>
  paywallSetLanguage?: (code: string) => Promise<unknown>
}
const api = (): LanguageApi =>
  (window as unknown as { electronAPI?: LanguageApi }).electronAPI ?? {}

export default function Language() {
  const [autoDetect, setAutoDetect] = useState<boolean>(true)
  const [selected, setSelected] = useState<string>('en')
  const [query, setQuery] = useState('')
  const [loaded, setLoaded] = useState(false)

  // ─── Load persisted settings on mount ───
  useEffect(() => {
    let cancelled = false
    Promise.all([
      api().paywallGetLanguageAutoDetect?.() ?? Promise.resolve(true),
      api().paywallGetLanguage?.() ?? Promise.resolve('en'),
    ]).then(([ad, code]) => {
      if (cancelled) return
      if (typeof ad === 'boolean') setAutoDetect(ad)
      if (typeof code === 'string' && code.length > 0) setSelected(code)
      setLoaded(true)
    }).catch(() => setLoaded(true))
    return () => { cancelled = true }
  }, [])

  // ─── Persist on every change ───
  useEffect(() => {
    if (!loaded) return
    api().paywallSetLanguageAutoDetect?.(autoDetect)?.catch(() => {})
  }, [autoDetect, loaded])

  useEffect(() => {
    if (!loaded) return
    api().paywallSetLanguage?.(selected)?.catch(() => {})
  }, [selected, loaded])

  // ─── Filter ───
  const filtered = useMemo(() => {
    if (!query.trim()) return LANGUAGES
    const q = query.trim().toLowerCase()
    return LANGUAGES.filter(
      (l) =>
        l.name.toLowerCase().includes(q) ||
        l.native.toLowerCase().includes(q) ||
        l.code.toLowerCase().includes(q),
    )
  }, [query])

  const selectedLang = languageByCode(selected)

  return (
    <div>
      {/* Auto-detect row */}
      <div className="bg-surface-2 border border-border rounded-2xl px-5 py-4 mb-5 shadow-sm flex items-center justify-between">
        <div className="min-w-0 mr-4">
          <p className="text-[14px] font-semibold text-ink">Auto-detect</p>
          <p className="text-[12.5px] text-ink-60 mt-0.5 leading-relaxed">
            When on, we let the model detect the language for every dictation. When off, we lock to the language you pick below — faster and more accurate, but only for that one language.
          </p>
        </div>
        <Toggle checked={autoDetect} onChange={setAutoDetect} />
      </div>

      {/* Section header — phrasing changes based on auto-detect state */}
      <div className="flex items-baseline justify-between mb-3">
        <p className="text-[14px] font-semibold text-ink">
          {autoDetect ? 'Preferred language' : 'Spoken language'}
        </p>
        <p className="text-[11px] text-ink-35">
          {autoDetect
            ? 'Used only if you turn auto-detect off'
            : selectedLang ? `Locked to ${selectedLang.name}` : ''}
        </p>
      </div>

      {/* Search */}
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search for a language…"
        className="w-full px-4 py-2.5 rounded-xl border border-border bg-surface-2 text-[13px] text-ink placeholder:text-ink-35 focus:outline-none focus:border-accent transition-colors mb-3"
      />

      {/* Grid */}
      <div className={`grid grid-cols-3 gap-2 ${autoDetect ? 'opacity-60' : ''}`}>
        {filtered.map((l) => {
          const isSelected = selected === l.code
          return (
            <button
              key={l.code}
              onClick={() => setSelected(l.code)}
              className={`text-left px-3 py-2.5 rounded-xl border transition-all ${isSelected ? 'border-accent bg-accent/[0.06]' : 'border-border bg-surface-2 hover:border-border-md hover:bg-cream-mid'}`}
            >
              <p className="text-[13px] font-semibold text-ink">{l.name}</p>
              {l.native !== l.name && (
                <p className="text-[11px] text-ink-35 mt-0.5 truncate">{l.native}</p>
              )}
            </button>
          )
        })}
      </div>

      {filtered.length === 0 && (
        <p className="text-[12.5px] text-ink-35 text-center py-6">
          No languages match “{query}”.
        </p>
      )}
    </div>
  )
}
