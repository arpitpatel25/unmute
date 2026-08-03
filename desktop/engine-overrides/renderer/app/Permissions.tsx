// Permissions — a Settings SECTION (it used to be a top-level tab).
//
// WHAT CHANGED, and why:
//
//  * THREE GROUPS INSTEAD OF ONE LIST. Two of these grants are the difference
//    between a working app and a dead one; two are only wanted if you use a
//    particular feature; one is a download, not a permission at all. They were
//    in a single undifferentiated card, so a user who could not dictate had to
//    read all five to find out which one mattered.
//
//  * SCREEN RECORDING IS NEW. It was missing entirely, and it is the grant
//    behind the agent's ability to capture a window — see remote/ax/policy.ts:10-13
//    ("capture needs a separate (Screen Recording) grant") and
//    remote/cua/driver-manager.ts:92-100, which probes it separately from
//    Accessibility.
//
//    A CORRECTION TO THE SPEC: §2.4 justifies this row as "needed for capture's
//    screenshots". It is not. Dictation-time screenshot capture is an fs.watch
//    over your screenshot folder (capture/screenshotWatch.ts:1-11) — it reads a
//    file macOS has already written, and needs no screen-capture grant at all.
//    The row belongs here, but for computer use, and that is what it says.
//
//  * NO LIVE STATUS ON SCREEN RECORDING. Nothing in the renderer's IPC surface
//    reports it — the only probe is inside a cua driver child process
//    (driver-manager.ts:92-100) with no channel out to this window. Rather than
//    render a status pill that would be a guess, the row states what the grant is
//    for and opens the right System Settings pane. Adding the IPC means touching
//    electron/, which this pack may not do.
//
//  * THE VENDOR LEAK IS GONE. The download row ended with a sentence naming the
//    cloud inference provider behind the managed engine and telling the user it
//    "works without this" — an infrastructure supplier nobody using the app
//    configures, chooses, or has any relationship with. Deleted, not reworded.
//
//  * IT IS PARAKEET, NOT WHISPER, IN EVERY VISIBLE STRING. The IPC names
//    (getWhisperModelStatus, downloadWhisperModel, whisper:download-progress)
//    are the main process's and are preserved verbatim; only the words a user
//    reads changed. Account and Privacy already say Parakeet v3, so this was the
//    last screen calling the same thing something else.

import React, { useCallback, useEffect, useState } from 'react'
import { SectionHeader, PermissionRow, ShieldIcon, EngineIcon, KeyIcon } from './_shared'

/** Typed accessor for the preload bridge.
 *
 *  `window.electronAPI` is undeclared in this project's renderer types, so every
 *  direct `window.electronAPI.x` is itself a type error (there were thirteen in
 *  this file). Reaching for the property through a cast window is the same
 *  runtime access, type-checked, with none of the noise — the idiom Settings.tsx
 *  and the Remote screens already use. */
interface PermissionsApi {
  getMicPermissionStatus?: () => Promise<string>
  getAccessibilityStatus?: () => Promise<boolean>
  requestMicPermission?: () => Promise<boolean>
  requestAccessibility?: () => Promise<boolean>
  openMicSettings?: () => void
  openAccessibilitySettings?: () => void
  openKeyboardSettings?: () => void
  getWhisperModelStatus?: () => Promise<boolean>
  downloadWhisperModel?: () => Promise<{ success: boolean }>
  onWhisperDownloadProgress?: (cb: (p: number) => void) => void
  removeAllListeners?: (channel: string) => void
  paywallOpenExternal?: (url: string) => Promise<boolean>
}
const api = (): PermissionsApi =>
  (window as unknown as { electronAPI?: PermissionsApi }).electronAPI ?? {}

/** Deep link to System Settings → Privacy & Security → Screen Recording.
 *  `shell.openExternal` (electron/auth-ipc.ts:98-101) passes any scheme through,
 *  so the same IPC that opens a checkout opens a settings pane. */
const SCREEN_RECORDING_PANE =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'

export default function Permissions() {
  // System permissions (mic / accessibility) — live status with focus re-check
  const [micStatus, setMicStatus] = useState<string>('unknown')
  const [accessibilityGranted, setAccessibilityGranted] = useState<boolean>(false)
  const micGranted = micStatus === 'granted'

  // On-device model (Parakeet v3) — install / repair from one place
  const [modelReady, setModelReady] = useState(false)
  const [modelDownloading, setModelDownloading] = useState(false)
  const [modelProgress, setModelProgress] = useState(0)

  const refreshPermissions = useCallback(async () => {
    try {
      const [m, a] = await Promise.all([
        api().getMicPermissionStatus?.() ?? Promise.resolve('unknown'),
        api().getAccessibilityStatus?.() ?? Promise.resolve(false),
      ])
      setMicStatus(m)
      setAccessibilityGranted(a)
    } catch { /* best-effort */ }
  }, [])

  // The focus re-check. It matters MORE now than it did as a top-level tab:
  // granting a permission means leaving for System Settings and coming back, and
  // without this the row you just satisfied still reads "Not granted".
  useEffect(() => {
    refreshPermissions()
    const onFocus = () => refreshPermissions()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refreshPermissions])

  useEffect(() => {
    api().getWhisperModelStatus?.().then(setModelReady).catch(() => {})
    api().onWhisperDownloadProgress?.((p: number) => setModelProgress(p))
    return () => {
      api().removeAllListeners?.('whisper:download-progress')
    }
  }, [])

  async function handleGrantMic() {
    const ok = await api().requestMicPermission?.()
    if (ok) { setMicStatus('granted'); return }
    const next = await api().getMicPermissionStatus?.()
    if (next) setMicStatus(next)
    if (next !== 'granted') api().openMicSettings?.()
  }

  async function handleGrantAccessibility() {
    const ok = await api().requestAccessibility?.()
    setAccessibilityGranted(!!ok)
    if (!ok) api().openAccessibilitySettings?.()
  }

  async function handleDownloadModel() {
    if (modelDownloading) return
    setModelDownloading(true)
    setModelProgress(0)
    try {
      const res = await api().downloadWhisperModel?.()
      if (res?.success) setModelReady(true)
    } catch { /* swallow — UI stays in idle state */ }
    finally {
      setModelDownloading(false)
    }
  }

  return (
    <div>
      {/* ═══ Required ═══ */}
      <SectionHeader icon={<ShieldIcon />} title="Required" />
      <div className="bg-surface-2 border border-border rounded-2xl overflow-hidden mb-3 shadow-sm">
        <PermissionRow
          title="Microphone"
          description="So unmute can hear what you say. Nothing works without this."
          granted={micGranted}
          statusText={micGranted ? 'Granted' : micStatus === 'denied' || micStatus === 'restricted' ? 'Denied' : 'Not granted'}
          primary={!micGranted ? { label: 'Grant', onClick: handleGrantMic } : null}
          secondary={micStatus === 'denied' || micStatus === 'restricted' ? { label: 'Open Settings', onClick: () => api().openMicSettings?.() } : null}
        />
        <PermissionRow
          title="Accessibility"
          description="Lets unmute see your trigger keys and paste at the cursor."
          granted={accessibilityGranted}
          statusText={accessibilityGranted ? 'Granted' : 'Not granted'}
          primary={!accessibilityGranted ? { label: 'Grant', onClick: handleGrantAccessibility } : null}
          secondary={!accessibilityGranted ? { label: "I've enabled it", onClick: refreshPermissions } : null}
          divider
        />
      </div>

      {/* ═══ Only if you use these features ═══ */}
      <SectionHeader icon={<KeyIcon />} title="Only if you use these features" />
      <div className="bg-surface-2 border border-border rounded-2xl overflow-hidden mb-3 shadow-sm">
        <AuxRow
          tone="neutral"
          badge="Optional"
          title="Screen Recording"
          icon={
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="4" width="20" height="14" rx="2"/><path d="M8 21h8M12 18v3"/></svg>
          }
          body={
            <>
              Only needed if you let an agent take a picture of a window during
              computer use. Everything else — dictation, instruct, and the
              screenshots you take yourself while dictating — works without it.
            </>
          }
          action={{
            label: 'Open Screen Recording settings',
            onClick: () => { void api().paywallOpenExternal?.(SCREEN_RECORDING_PANE) },
          }}
        />
        <AuxRow
          tone="warm"
          badge="Recommended"
          title="Free up the Fn key"
          divider
          icon={
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h0M10 10h0M14 10h0M18 10h0M6 14h12"/></svg>
          }
          body={
            <>
              By default macOS uses the <span className="font-mono text-ink">Fn</span> key
              to show emoji or start Apple&rsquo;s own Dictation. To use it for
              unmute, open Keyboard Settings and set{' '}
              <span className="font-semibold text-ink">&ldquo;Press 🌐 key to&rdquo;</span> →{' '}
              <span className="font-semibold text-ink">&ldquo;Do Nothing&rdquo;</span>.
            </>
          }
          action={{ label: 'Open Keyboard Settings', onClick: () => api().openKeyboardSettings?.() }}
        />
      </div>

      {/* ═══ On-device engine ═══
          Not a permission — a download. It sits here because this is the screen
          people open when something will not run, and a missing model is one of
          the reasons. */}
      <SectionHeader icon={<EngineIcon />} title="On-device engine" />
      <div className="bg-surface-2 border border-border rounded-2xl overflow-hidden mb-3 shadow-sm">
        <AuxRow
          tone={modelReady ? 'good' : 'warm'}
          badge={modelReady ? 'Ready' : modelDownloading ? 'Downloading' : 'Not installed'}
          title="On-device model (Parakeet v3)"
          icon={
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          }
          body={<>Transcribes on this Mac, with no account and no network. Slower and a little less accurate than the cloud.</>}
          action={!modelReady && !modelDownloading
            ? { label: 'Download model (~480MB)', onClick: handleDownloadModel, primary: true }
            : null}
          trailing={modelDownloading
            ? <span className="text-[11px] font-medium text-ink-60">Downloading{modelProgress > 0 ? ` — ${Math.round(modelProgress)}%` : '…'}</span>
            : null}
        />
      </div>
    </div>
  )
}

/* ─── AuxRow ───
 *
 * The shape the Fn-key tip and the model download were both already using,
 * inline and twice over, now written once. It is not `PermissionRow` from
 * _shared.tsx because that row's status is a granted/not-granted boolean with a
 * tick or a warning glyph, and none of these three rows has one: two are advice
 * and one is a download. A tick that means "installed" next to a tick that means
 * "granted" would be the same icon for two concepts (D8). */
function AuxRow({ tone, badge, title, icon, body, action, trailing, divider }: {
  tone: 'good' | 'warm' | 'neutral'
  badge: string
  title: string
  icon: React.ReactNode
  body: React.ReactNode
  action: { label: string; onClick: () => void; primary?: boolean } | null
  trailing?: React.ReactNode
  divider?: boolean
}) {
  const iconClass = tone === 'good' ? 'bg-success-soft text-success'
    : tone === 'warm' ? 'bg-warm-soft text-warm'
      : 'bg-ink-07 text-ink-35'
  const badgeClass = tone === 'good' ? 'text-success' : 'text-ink-35'
  return (
    <div className={`px-5 py-4 flex items-start gap-3 ${divider ? 'border-t border-border' : ''}`}>
      <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 mt-0.5 ${iconClass}`}>
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-3">
          <p className="text-[13px] font-semibold text-ink">{title}</p>
          <span className={`text-[10px] font-bold uppercase tracking-wider ${badgeClass}`}>{badge}</span>
        </div>
        <p className="text-[12.5px] text-ink-60 leading-relaxed mt-1.5">{body}</p>
        {(action || trailing) && (
          <div className="flex items-center gap-3 mt-3">
            {action && (
              <button
                onClick={action.onClick}
                className={action.primary
                  ? 'px-3 py-1.5 rounded-full bg-ink text-white text-[11px] font-semibold hover:opacity-90 transition-opacity'
                  : 'px-3 py-1.5 rounded-full border border-border text-[11px] font-semibold text-ink-60 hover:bg-cream-mid hover:border-border-md transition-all'}
              >
                {action.label}
              </button>
            )}
            {trailing}
          </div>
        )}
      </div>
    </div>
  )
}
