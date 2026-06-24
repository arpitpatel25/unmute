// Permissions tab — macOS TCC grants + auxiliary setup
// (Free-up-Fn keyboard tip, offline whisper.cpp model download).
//
// Restructured out of the old single-page Settings.tsx. Identical IPC
// calls and JSX as before — just rendered in its own top-level tab so
// users can find it quickly when something isn't working.

import { useCallback, useEffect, useState } from 'react'
import { SectionHeader, PermissionRow, ShieldIcon } from './_shared'

export default function Permissions() {
  // System permissions (mic / accessibility) — live status with focus re-check
  const [micStatus, setMicStatus] = useState<string>('unknown')
  const [accessibilityGranted, setAccessibilityGranted] = useState<boolean>(false)
  const micGranted = micStatus === 'granted'

  // Offline whisper.cpp model — install / repair from one place
  const [whisperModelReady, setWhisperModelReady] = useState(false)
  const [whisperDownloading, setWhisperDownloading] = useState(false)
  const [whisperProgress, setWhisperProgress] = useState(0)

  const refreshPermissions = useCallback(async () => {
    try {
      const [m, a] = await Promise.all([
        window.electronAPI.getMicPermissionStatus(),
        window.electronAPI.getAccessibilityStatus(),
      ])
      setMicStatus(m)
      setAccessibilityGranted(a)
    } catch { /* best-effort */ }
  }, [])

  useEffect(() => {
    refreshPermissions()
    const onFocus = () => refreshPermissions()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refreshPermissions])

  useEffect(() => {
    window.electronAPI.getWhisperModelStatus().then(setWhisperModelReady).catch(() => {})
    window.electronAPI.onWhisperDownloadProgress((p: number) => setWhisperProgress(p))
    return () => {
      window.electronAPI.removeAllListeners('whisper:download-progress')
    }
  }, [])

  async function handleGrantMic() {
    const ok = await window.electronAPI.requestMicPermission()
    if (ok) { setMicStatus('granted'); return }
    const next = await window.electronAPI.getMicPermissionStatus()
    setMicStatus(next)
    if (next !== 'granted') window.electronAPI.openMicSettings()
  }

  async function handleGrantAccessibility() {
    const ok = await window.electronAPI.requestAccessibility()
    setAccessibilityGranted(ok)
    if (!ok) window.electronAPI.openAccessibilitySettings()
  }

  async function handleDownloadWhisper() {
    if (whisperDownloading) return
    setWhisperDownloading(true)
    setWhisperProgress(0)
    try {
      const res = await window.electronAPI.downloadWhisperModel()
      if (res.success) setWhisperModelReady(true)
    } catch { /* swallow — UI stays in idle state */ }
    finally {
      setWhisperDownloading(false)
    }
  }

  return (
    <div className="max-w-lg">
      <h2 className="font-display text-[22px] font-bold text-ink tracking-tight mb-6">Permissions</h2>

      {/* ═══ Permissions ═══ */}
      <SectionHeader icon={<ShieldIcon />} title="System permissions" />
      <div className="bg-surface-2 border border-border rounded-2xl overflow-hidden mb-3 shadow-sm">
        <PermissionRow
          title="Microphone"
          description="So unmute can hear what you say. Required."
          granted={micGranted}
          statusText={micGranted ? 'Granted' : micStatus === 'denied' || micStatus === 'restricted' ? 'Denied' : 'Not granted'}
          primary={!micGranted ? { label: 'Grant', onClick: handleGrantMic } : null}
          secondary={micStatus === 'denied' || micStatus === 'restricted' ? { label: 'Open Settings', onClick: () => window.electronAPI.openMicSettings() } : null}
        />
        <PermissionRow
          title="Accessibility"
          description="Lets unmute detect your shortcut keys and paste at the cursor. Required."
          granted={accessibilityGranted}
          statusText={accessibilityGranted ? 'Granted' : 'Not granted'}
          primary={!accessibilityGranted ? { label: 'Grant', onClick: handleGrantAccessibility } : null}
          secondary={!accessibilityGranted ? { label: "I've enabled it", onClick: refreshPermissions } : null}
          divider
        />
        <div className="px-5 py-4 border-t border-border">
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 rounded-lg bg-warm-soft text-warm flex items-center justify-center shrink-0 mt-0.5">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h0M10 10h0M14 10h0M18 10h0M6 14h12"/></svg>
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between gap-3">
                <p className="text-[13px] font-semibold text-ink">Free up the Fn key</p>
                <span className="text-[10px] font-bold uppercase tracking-wider text-ink-35">Recommended</span>
              </div>
              <p className="text-[12px] text-ink-60 leading-relaxed mt-1.5">
                By default macOS uses the <span className="font-mono text-ink">Fn</span> key to show emoji or trigger Apple's own Dictation. To use it for unmute, open Keyboard Settings and set <span className="font-semibold text-ink">"Press 🌐 key to"</span> → <span className="font-semibold text-ink">"Do Nothing"</span>.
              </p>
              <div className="mt-3">
                <button
                  onClick={() => window.electronAPI.openKeyboardSettings()}
                  className="px-3 py-1.5 rounded-full border border-border text-[11px] font-semibold text-ink-60 hover:bg-cream-mid hover:border-border-md transition-all"
                >
                  Open Keyboard Settings
                </button>
              </div>
            </div>
          </div>
        </div>
        {/* Offline transcription model — always accessible so users can install/repair from one place */}
        <div className="px-5 py-4 border-t border-border">
          <div className="flex items-start gap-3">
            <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 mt-0.5 ${whisperModelReady ? 'bg-green-100 text-green-700' : 'bg-warm-soft text-warm'}`}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between gap-3">
                <p className="text-[13px] font-semibold text-ink">Offline transcription model</p>
                <span className={`text-[10px] font-bold uppercase tracking-wider ${whisperModelReady ? 'text-green-700' : 'text-ink-35'}`}>
                  {whisperModelReady ? 'Ready' : whisperDownloading ? 'Downloading' : 'Not installed'}
                </span>
              </div>
              <p className="text-[12px] text-ink-60 leading-relaxed mt-1.5">
                Lets unmute transcribe on-device when you're offline or want full privacy. Optional — Groq cloud works without this.
              </p>
              {!whisperModelReady && (
                <div className="mt-3 flex items-center gap-3">
                  {whisperDownloading ? (
                    <span className="text-[11px] font-medium text-ink-60">
                      Downloading{whisperProgress > 0 ? ` — ${Math.round(whisperProgress)}%` : '…'}
                    </span>
                  ) : (
                    <button
                      onClick={handleDownloadWhisper}
                      className="px-3 py-1.5 rounded-full bg-ink text-white text-[11px] font-semibold hover:opacity-90 transition-opacity"
                    >
                      Download model (~480MB)
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
