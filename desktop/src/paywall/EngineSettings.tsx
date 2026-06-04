// Engine selector — goes inside Settings.tsx as a new row.
// Replaces the existing "Use Groq cloud transcription" toggle from v1.3.4
// with a 4-way selector: Auto / Managed / BYOK / Local.

import { useEffect, useState } from 'react'

type EngineMode = 'auto' | 'managed' | 'byok' | 'local'

const OPTIONS: Array<{ value: EngineMode; label: string; description: string }> = [
  {
    value: 'auto',
    label: 'Auto',
    description: 'Picks the best available — Managed → BYOK → Local',
  },
  {
    value: 'managed',
    label: 'Managed',
    description: 'Use our cloud (sign in required, prepaid credits)',
  },
  {
    value: 'byok',
    label: 'BYOK',
    description: 'Use your own Groq API key (your key, our app, zero network on us)',
  },
  {
    value: 'local',
    label: 'Local',
    description: 'Fully offline — whisper.cpp on this Mac',
  },
]

export function EngineSettings() {
  const [mode, setMode] = useState<EngineMode>('auto')
  const [signedIn, setSignedIn] = useState(false)
  const [email, setEmail] = useState<string | null>(null)

  useEffect(() => {
    window.electronAPI.paywallGetEngineMode?.().then((v: EngineMode) => setMode(v))
    window.electronAPI.paywallGetUser?.().then((u) => {
      if (u) {
        setSignedIn(true)
        setEmail(u.email)
      }
    })
  }, [])

  function handleChange(next: EngineMode) {
    setMode(next)
    window.electronAPI.paywallSetEngineMode?.(next)
    if (next === 'managed' && !signedIn) {
      // Tell the main process to open the sign-in flow
      window.electronAPI.paywallRequestSignIn?.()
    }
  }

  return (
    <div className="px-5 py-4 border-t border-border">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <p className="text-[13px] font-semibold text-ink">Engine</p>
          <p className="text-[12px] text-ink-60 leading-relaxed mt-0.5">
            How transcription runs. Auto picks the best available.
          </p>
        </div>
        {signedIn && (
          <button
            onClick={() => window.electronAPI.paywallSignOut?.()}
            className="text-[11px] text-ink-35 hover:text-ink-60 transition-colors whitespace-nowrap"
          >
            Sign out
          </button>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        {OPTIONS.map((opt) => (
          <button
            key={opt.value}
            onClick={() => handleChange(opt.value)}
            className={`text-left px-3 py-2.5 rounded-xl border transition-colors ${
              mode === opt.value
                ? 'bg-ink text-white border-ink'
                : 'bg-white text-ink border-border hover:bg-cream-mid'
            }`}
          >
            <div className="flex items-center justify-between mb-0.5">
              <span className="text-[12px] font-bold">{opt.label}</span>
              {opt.value === 'managed' && signedIn && email && (
                <span className={`text-[10px] ${mode === opt.value ? 'text-white/60' : 'text-ink-35'}`}>
                  {email}
                </span>
              )}
            </div>
            <p
              className={`text-[11px] leading-relaxed ${
                mode === opt.value ? 'text-white/75' : 'text-ink-60'
              }`}
            >
              {opt.description}
            </p>
          </button>
        ))}
      </div>
    </div>
  )
}
