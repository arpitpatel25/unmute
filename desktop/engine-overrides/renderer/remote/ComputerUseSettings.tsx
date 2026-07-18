// Computer Use settings — one master toggle, nothing else.
//
// v2 (cua-driver embedded) deliberately DROPPED the per-app allowlist and the
// screenshot sub-toggle: the engine is a transparent pass-through and every
// wrapper-side gate is a place to silently break it (settled decision). The
// kill switch remains the user's control; the menu-bar activity indicator
// remains the live affordance.
import { useEffect, useState, useCallback } from 'react'

interface AxPolicy { enabled: boolean }

type CuAPI = {
  remoteGetComputerUse?: () => Promise<AxPolicy>
  remoteSetComputerUse?: (patch: Partial<AxPolicy>) => Promise<AxPolicy>
  remoteAxTrusted?: () => Promise<boolean>
}
function api(): CuAPI {
  return (window as unknown as { electronAPI?: CuAPI }).electronAPI ?? {}
}

export function ComputerUseSettings() {
  const [p, setP] = useState<AxPolicy | null>(null)
  const [trusted, setTrusted] = useState<boolean | null>(null)

  useEffect(() => {
    void api().remoteGetComputerUse?.().then((v) => v && setP(v))
    void api().remoteAxTrusted?.().then((t) => setTrusted(!!t))
  }, [])

  const save = useCallback((patch: Partial<AxPolicy>) => {
    setP((prev) => (prev ? { ...prev, ...patch } : prev)) // optimistic
    void api().remoteSetComputerUse?.(patch).then((next) => next && setP(next))
  }, [])

  if (!p) return null

  return (
    <div className="border-t border-black/5 pt-2 mt-1">
      <label className="flex items-center justify-between py-1.5">
        <span>
          Computer Use{' '}
          <span className="text-ink/40">
            (let Claude Code operate your Mac apps in the background — no stolen focus, your screen never moves)
          </span>
        </span>
        <input
          type="checkbox"
          checked={p.enabled}
          onChange={(e) => save({ enabled: e.target.checked })}
        />
      </label>

      {p.enabled && trusted === false && (
        <div className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1 my-1">
          Accessibility permission is needed. Grant it to Unmute in System Settings → Privacy &amp; Security →
          Accessibility. Unmute picks the grant up automatically within about half a minute — no restart needed.
        </div>
      )}
    </div>
  )
}
