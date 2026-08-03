// Computer Use settings — one master toggle, nothing else.
//
// v2 (cua-driver embedded) deliberately DROPPED the per-app allowlist and the
// screenshot sub-toggle: the engine is a transparent pass-through and every
// wrapper-side gate is a place to silently break it (settled decision). The
// kill switch remains the user's control; the menu-bar activity indicator
// remains the live affordance.
import { useEffect, useState, useCallback } from 'react'
import { SettingRow, Toggle } from '../app/_shared'

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
    <>
      <SettingRow
        label="Computer Use"
        description="Lets a task operate your Mac apps in the background — no stolen focus, your screen never moves."
      >
        <Toggle checked={p.enabled} onChange={(enabled) => save({ enabled })} />
      </SettingRow>

      {p.enabled && trusted === false && (
        <div className="px-5 pb-4 -mt-1">
          <div className="text-[11px] text-ink-60 leading-relaxed bg-cream-mid border border-border rounded-[10px] px-3 py-2">
            Accessibility permission is needed. Grant it to Unmute in System Settings → Privacy &amp; Security →
            Accessibility. Unmute picks the grant up automatically within about half a minute — no restart needed.
          </div>
        </div>
      )}
    </>
  )
}
