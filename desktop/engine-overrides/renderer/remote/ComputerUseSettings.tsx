// Computer Use (ax-mcp) settings — lets Claude Code drive desktop apps in the
// background via the Accessibility API. Self-contained: owns its own IPC so it
// doesn't bloat the main Settings type.
//
// Controls:
//   • master toggle       — the real kill switch (server reads it live).
//   • Accessibility hint   — if the app isn't trusted yet, tell the user.
//   • allow all vs restrict — default is the WHOLE computer; restrict narrows
//                             it to a picked set of apps.
//   • app picker          — only shown in restrict mode.
//   • screenshots         — capture_window on/off (separate Screen Recording).

import { useEffect, useState, useCallback } from 'react'

interface AxPolicy { enabled: boolean; screenshotEnabled: boolean; allowAll: boolean; allowed: string[] }
interface AppRow { name: string; bundleId: string; pid: number; windowsHere: number; windowsAnywhere: number }

type CuAPI = {
  remoteGetComputerUse?: () => Promise<AxPolicy>
  remoteSetComputerUse?: (patch: Partial<AxPolicy>) => Promise<AxPolicy>
  remoteAxListApps?: () => Promise<AppRow[]>
  remoteAxTrusted?: () => Promise<boolean>
}
function api(): CuAPI {
  return (window as unknown as { electronAPI?: CuAPI }).electronAPI ?? {}
}

export function ComputerUseSettings() {
  const [p, setP] = useState<AxPolicy | null>(null)
  const [trusted, setTrusted] = useState<boolean | null>(null)
  const [apps, setApps] = useState<AppRow[]>([])
  const [loadingApps, setLoadingApps] = useState(false)

  useEffect(() => {
    void api().remoteGetComputerUse?.().then((v) => v && setP(v))
    void api().remoteAxTrusted?.().then((t) => setTrusted(!!t))
  }, [])

  const save = useCallback((patch: Partial<AxPolicy>) => {
    setP((prev) => (prev ? { ...prev, ...patch } : prev)) // optimistic
    void api().remoteSetComputerUse?.(patch).then((next) => next && setP(next))
  }, [])

  const loadApps = useCallback(() => {
    setLoadingApps(true)
    void api().remoteAxListApps?.().then((a) => setApps(Array.isArray(a) ? a : [])).finally(() => setLoadingApps(false))
  }, [])

  // When entering restrict mode, fetch the running-apps list for the picker.
  useEffect(() => { if (p && !p.allowAll && p.enabled) loadApps() }, [p?.allowAll, p?.enabled, loadApps])

  if (!p) return null

  const toggleApp = (row: AppRow, on: boolean) => {
    const key = (row.bundleId || row.name).toLowerCase()
    const set = new Set(p.allowed.map((x) => x.toLowerCase()))
    if (on) set.add(key); else set.delete(key)
    save({ allowed: [...set] })
  }
  const isChecked = (row: AppRow) => {
    const set = new Set(p.allowed.map((x) => x.toLowerCase()))
    return set.has((row.bundleId || '').toLowerCase()) || set.has(row.name.toLowerCase())
  }

  return (
    <div className="border-t border-black/5 pt-2 mt-1">
      {/* Master toggle */}
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
          Accessibility, then fully restart Unmute. Until then, control tools will report a permission error.
        </div>
      )}

      {p.enabled && (
        <div className="pl-3 border-l-2 border-black/5 ml-1">
          {/* Scope: whole computer vs restrict */}
          <label className="flex items-center justify-between py-1.5">
            <span>
              Allow all apps{' '}
              <span className="text-ink/40">(the whole computer — recommended; turn off to restrict to a chosen list)</span>
            </span>
            <input type="checkbox" checked={p.allowAll} onChange={(e) => save({ allowAll: e.target.checked })} />
          </label>

          {!p.allowAll && (
            <div className="py-1">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[12px] text-ink/60">Apps Claude may control:</span>
                <button className="text-[11px] text-blue-600 hover:underline" onClick={loadApps} disabled={loadingApps}>
                  {loadingApps ? 'refreshing…' : 'refresh list'}
                </button>
              </div>
              <div className="max-h-48 overflow-y-auto rounded border border-black/10 divide-y divide-black/5">
                {apps.length === 0 && <div className="text-[11px] text-ink/40 px-2 py-2">No apps loaded — click refresh.</div>}
                {apps.map((row) => (
                  <label key={row.pid} className="flex items-center justify-between px-2 py-1 text-[12px]">
                    <span className="truncate">
                      {row.name}
                      {row.windowsHere === 0 && row.windowsAnywhere > 0 && (
                        <span className="text-ink/30"> (on another Space)</span>
                      )}
                    </span>
                    <input type="checkbox" checked={isChecked(row)} onChange={(e) => toggleApp(row, e.target.checked)} />
                  </label>
                ))}
              </div>
            </div>
          )}

          {/* Screenshots */}
          <label className="flex items-center justify-between py-1.5">
            <span>
              Screenshots{' '}
              <span className="text-ink/40">(let it capture a single app window to verify results — needs Screen Recording)</span>
            </span>
            <input type="checkbox" checked={p.screenshotEnabled} onChange={(e) => save({ screenshotEnabled: e.target.checked })} />
          </label>
        </div>
      )}
    </div>
  )
}
