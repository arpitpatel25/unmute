// Managed-build WidgetApp override.
//
// Extends the OSS WidgetApp with the OfflineAwarenessCard — appears below
// the pill whenever the on-device engine is the one routing this dictation,
// telling the user *why* (not signed in / no balance / cloud unreachable /
// chose-on-device). Dismissible per app session; reappears on next launch.

import { useState, useEffect, useCallback, useRef } from 'react'
import Widget from './Widget'
import { useAudioRecorder } from './useAudioRecorder'
import type { WidgetState } from '../shared/types'
import OfflineAwarenessCard, { type OfflineReason } from './OfflineAwarenessCard'

// ─── Sound Feedback (Web Audio API) ───
let soundEnabled = true

function playClickSound(type: 'start' | 'stop') {
  if (!soundEnabled) return
  try {
    const ctx = new AudioContext()
    const oscillator = ctx.createOscillator()
    const gain = ctx.createGain()
    oscillator.connect(gain)
    gain.connect(ctx.destination)
    oscillator.frequency.setValueAtTime(type === 'start' ? 880 : 660, ctx.currentTime)
    oscillator.type = 'sine'
    const lfo = ctx.createOscillator()
    const lfoGain = ctx.createGain()
    lfo.connect(lfoGain)
    lfoGain.connect(oscillator.frequency)
    lfo.type = 'sine'
    lfo.frequency.setValueAtTime(14, ctx.currentTime)
    lfoGain.gain.setValueAtTime(8, ctx.currentTime)
    lfo.start(ctx.currentTime)
    lfo.stop(ctx.currentTime + 0.08)
    gain.gain.setValueAtTime(0.07, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.08)
    oscillator.start(ctx.currentTime)
    oscillator.stop(ctx.currentTime + 0.08)
    setTimeout(() => ctx.close(), 200)
  } catch {
    /* sound is non-critical */
  }
}

// Awareness widget is hidden once the user × it. Module-scoped so it
// persists across pill open/close within this app session — only an app
// restart resets it (which is what we want).
let sessionDismissed = false

// Remote capture marker — a dark chip shown to the LEFT of the pill (with a gap)
// ONLY during a Remote capture. Same dark fill (#0E0E10), whitish border, and
// drop shadow as the pill so they read as one family. Instead of an icon it
// shows the active DOER MODEL name in Claude's orange, so the user always knows
// which model the task will run on. Hovering expands an inline selector
// (Haiku · Sonnet · Opus) so they can switch ON THE FLY while speaking — the
// choice applies to THIS task on submit (and persists as the default).
const CLAUDE_ORANGE = '#D97757'
const MODELS = ['haiku', 'sonnet', 'opus'] as const
type ModelId = (typeof MODELS)[number]
const isModelId = (m: unknown): m is ModelId => m === 'haiku' || m === 'sonnet' || m === 'opus'

function remoteModelApi() {
  return window.electronAPI as unknown as {
    remoteGetModel?: () => Promise<string>
    remoteSetModel?: (m: string) => Promise<string>
    remoteOnModelChanged?: (cb: (model: string) => void) => () => void
  }
}

function RemoteBadge() {
  const [model, setModel] = useState<ModelId>('sonnet')
  const [expanded, setExpanded] = useState(false)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const api = remoteModelApi()
    void api.remoteGetModel?.().then((m) => { if (isModelId(m)) setModel(m) })
    const off = api.remoteOnModelChanged?.((m) => { if (isModelId(m)) setModel(m) })
    return () => off?.()
  }, [])
  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current) }, [])

  const open = () => {
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null }
    setExpanded(true)
  }
  // Small grace before collapsing — the chip widening shifts the layout, which
  // can drop the cursor out of the box and cause expand/collapse flicker.
  const scheduleClose = () => { closeTimer.current = setTimeout(() => setExpanded(false), 150) }

  const pick = (m: ModelId) => {
    setModel(m) // optimistic — reflects instantly; the next task reads the setting
    void remoteModelApi().remoteSetModel?.(m)
    setExpanded(false)
  }

  return (
    <div
      style={{ flex: 'none', height: 44, display: 'flex', alignItems: 'center' }}
      onMouseEnter={open}
      onMouseLeave={scheduleClose}
    >
      <div
        style={{
          height: 44,
          borderRadius: 9999,
          background: '#0E0E10',
          // Match the pill exactly: whitish border, dark fill, and — like the
          // pill — NO drop shadow. (The pill's shadow was removed in styles.css;
          // the fill + border alone make the chip read as the same family.)
          border: '1px solid rgba(255, 255, 255, 0.55)',
          boxShadow: 'none',
          display: 'flex',
          alignItems: 'center',
          padding: '0 6px',
          gap: 2,
        }}
      >
        {/* All three are ALWAYS rendered. The active one is always visible; the
            other two collapse to zero width/opacity when not hovered and animate
            their max-width on reveal — so the chip (and the pill it pushes) GLIDE
            instead of hard-swapping the content. */}
        {MODELS.map((m) => {
          const active = m === model
          const shown = expanded || active
          return (
            <button
              key={m}
              onClick={() => pick(m)}
              tabIndex={shown ? 0 : -1}
              style={{
                height: 32,
                maxWidth: shown ? 88 : 0,
                opacity: shown ? 1 : 0,
                padding: shown ? '0 10px' : '0',
                overflow: 'hidden',
                whiteSpace: 'nowrap',
                borderRadius: 9999,
                border: 'none',
                cursor: 'pointer',
                fontSize: 12.5,
                fontWeight: 600,
                textTransform: 'capitalize',
                background: active && expanded ? 'rgba(217,119,87,0.18)' : 'transparent',
                color: active ? CLAUDE_ORANGE : 'rgba(255,255,255,0.5)',
                transition:
                  'max-width 220ms cubic-bezier(0.16,1,0.3,1), opacity 200ms ease, padding 220ms cubic-bezier(0.16,1,0.3,1), color 140ms ease, background 140ms ease',
              }}
              onMouseEnter={(e) => { if (!active) e.currentTarget.style.color = 'rgba(255,255,255,0.9)' }}
              onMouseLeave={(e) => { if (!active) e.currentTarget.style.color = 'rgba(255,255,255,0.5)' }}
            >
              {m}
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ── Staged-images chip (the attachment LEDGER, shown only during a Remote
// capture). Screenshots captured while addressing Unmute — or in the short
// window just before — stage automatically; this chip is the truth of what
// rides with the utterance: 🖼 n, hover → numbered ✕ buttons to prune. What
// you see is what sends. Same chip family as the model badge: dark fill,
// whitish border, NO shadow, horizontal glide (nothing pops outside the
// widget window).
function stagedApi() {
  return window.electronAPI as unknown as {
    remoteGetStaged?: () => Promise<string[]>
    remoteOnStagedChanged?: (cb: (d: { count: number; paths: string[]; pending?: number }) => void) => () => void
    remoteUnstageImage?: (path: string) => Promise<boolean>
    remoteGetStagedPreviews?: () => Promise<Array<{ path: string; dataUrl: string }>>
    paywallSetHUDHeight?: (height: number) => Promise<boolean>
  }
}

// Clean line-drawn image glyph (currentColor, no emoji).
function ImageGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <circle cx="8.5" cy="8.5" r="1.5" fill="currentColor" stroke="none" />
      <path d="M21 15l-5-5L5 21" />
    </svg>
  )
}

function StagedImagesChip() {
  const [paths, setPaths] = useState<string[]>([])
  const [pending, setPending] = useState(0) // clipboard screenshot noticed mid-recording (readable only at key-lift)
  const [previews, setPreviews] = useState<Array<{ path: string; dataUrl: string }>>([])
  const [expanded, setExpanded] = useState(false)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const api = stagedApi()
    void api.remoteGetStaged?.().then((p) => { if (Array.isArray(p)) setPaths(p) })
    const off = api.remoteOnStagedChanged?.((d) => { setPaths(d.paths ?? []); setPending(d.pending ?? 0) })
    return () => off?.()
  }, [])
  // Refresh thumbnails whenever the dropdown is open and the set changes.
  useEffect(() => {
    if (!expanded) return
    void stagedApi().remoteGetStagedPreviews?.().then((p) => { if (Array.isArray(p)) setPreviews(p) })
  }, [expanded, paths])
  // The dropdown extends below the pill row — grow the (72px) HUD window while
  // open, restore on close/unmount. Same seam the awareness card uses.
  useEffect(() => {
    const api = stagedApi()
    const rows = paths.length + pending
    if (expanded && rows) void api.paywallSetHUDHeight?.(Math.min(220, 60 + rows * 42 + 16))
    else void api.paywallSetHUDHeight?.(72)
    return () => { void stagedApi().paywallSetHUDHeight?.(72) }
  }, [expanded, paths.length, pending])
  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current) }, [])

  const total = paths.length + pending
  if (total === 0) return null

  const open = () => {
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null }
    setExpanded(true)
  }
  const scheduleClose = () => { closeTimer.current = setTimeout(() => setExpanded(false), 200) }

  return (
    <div
      style={{ flex: 'none', height: 44, display: 'flex', alignItems: 'center', position: 'relative' }}
      onMouseEnter={open}
      onMouseLeave={scheduleClose}
    >
      <div
        style={{
          height: 44,
          borderRadius: 9999,
          background: '#0E0E10',
          border: '1px solid rgba(255, 255, 255, 0.55)',
          boxShadow: 'none',
          display: 'flex',
          alignItems: 'center',
          padding: '0 12px',
          gap: 6,
          color: 'rgba(255,255,255,0.85)',
        }}
      >
        <ImageGlyph />
        <span style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>{total}</span>
      </div>

      {/* vertical dropdown: one row per image — thumbnail preview + remove */}
      {expanded && (
        <div
          style={{
            position: 'absolute', top: 48, left: 0, minWidth: 168,
            background: '#0E0E10', border: '1px solid rgba(255,255,255,0.35)',
            borderRadius: 12, padding: 6, display: 'flex', flexDirection: 'column', gap: 4,
            zIndex: 10,
          }}
        >
          {pending > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ width: 56, height: 34, borderRadius: 5, background: 'rgba(255,255,255,0.08)', flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(255,255,255,0.35)' }}>
                <ImageGlyph />
              </div>
              <span style={{ fontSize: 10.5, color: 'rgba(255,255,255,0.55)', flex: 1 }}>
                screenshot — attaches when you release
              </span>
            </div>
          )}
          {paths.map((p) => {
            const preview = previews.find((v) => v.path === p)?.dataUrl
            return (
              <div key={p} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {preview ? (
                  <img src={preview} alt="" style={{ width: 56, height: 34, objectFit: 'cover', borderRadius: 5, border: '1px solid rgba(255,255,255,0.15)', flex: 'none' }} />
                ) : (
                  <div style={{ width: 56, height: 34, borderRadius: 5, background: 'rgba(255,255,255,0.08)', flex: 'none' }} />
                )}
                <span style={{ fontSize: 10.5, color: 'rgba(255,255,255,0.55)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, maxWidth: 120 }}>
                  {p.split('/').pop()}
                </span>
                <button
                  title="Remove — won't be sent"
                  onClick={() => void stagedApi().remoteUnstageImage?.(p)}
                  style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.6)', fontSize: 13, lineHeight: 1, padding: '4px 6px', cursor: 'pointer', flex: 'none' }}
                >✕</button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// Per-SESSION raw toggle, shown next to the model badge during a Remote capture.
// RAW = no Unmute memory injection (a clean Claude Code session). Reflects the
// effective state (session override over the saved default); clicking sets a
// session-only override that resets on relaunch.
function rawApi() {
  return window.electronAPI as unknown as {
    remoteGetRawState?: () => Promise<{ effectiveRaw: boolean }>
    remoteSetSessionRaw?: (on: boolean | null) => Promise<boolean>
  }
}

function RawToggle() {
  const [raw, setRaw] = useState(false)
  useEffect(() => {
    void rawApi().remoteGetRawState?.().then((s) => { if (s) setRaw(!!s.effectiveRaw) })
  }, [])
  const toggle = () => {
    const next = !raw
    setRaw(next) // optimistic
    void rawApi().remoteSetSessionRaw?.(next)
  }
  return (
    <div style={{ flex: 'none', height: 44, display: 'flex', alignItems: 'center' }}>
      <button
        onClick={toggle}
        title={raw
          ? 'Raw mode ON — this Remote session runs with NO Unmute memory injection. Click to turn off.'
          : 'Raw mode OFF — Unmute injects relevant memory. Click for a clean Claude Code session.'}
        style={{
          height: 44,
          borderRadius: 9999,
          background: '#0E0E10',
          border: '1px solid rgba(255, 255, 255, 0.55)',
          // Match the shadowless pill (see RemoteBadge note above).
          boxShadow: 'none',
          display: 'flex',
          alignItems: 'center',
          padding: '0 12px',
          gap: 6,
          cursor: 'pointer',
          fontSize: 12.5,
          fontWeight: 700,
          letterSpacing: 0.3,
          whiteSpace: 'nowrap',
          color: raw ? CLAUDE_ORANGE : 'rgba(255,255,255,0.45)',
          transition: 'color 140ms ease',
        }}
      >
        <span
          style={{
            width: 7, height: 7, borderRadius: 9999,
            background: raw ? CLAUDE_ORANGE : 'rgba(255,255,255,0.28)',
            boxShadow: raw ? `0 0 8px ${CLAUDE_ORANGE}` : 'none',
            transition: 'background 140ms ease, box-shadow 140ms ease',
          }}
        />
        RAW
      </button>
    </div>
  )
}

export default function WidgetApp() {
  const [state, setState] = useState<WidgetState>('hidden')
  const [outputPreview, setOutputPreview] = useState('')
  const [fallbackMessage, setFallbackMessage] = useState('')
  const [errorMessage, setErrorMessage] = useState('')
  const [showDiscardHint, setShowDiscardHint] = useState(false)
  const [engineNotice, setEngineNotice] = useState<string | null>(null)
  const [offlineReason, setOfflineReason] = useState<OfflineReason | null>(null)
  const [dismissedTick, setDismissedTick] = useState(0)
  // Is the CURRENT capture a Remote one (dispatches a task) vs a dictation
  // (types text)? Drives the Remote badge next to the pill. Set on every
  // recording:start from its kind, so it's always fresh for this capture.
  const [isRemote, setIsRemote] = useState(false)
  const { analyserNode, maxDurationSeconds, startRecording, stopRecording } = useAudioRecorder()

  const autoHideRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  // The HUD window is click-through by default (so the empty area around the
  // pill never blocks the apps behind it). Hit-test the cursor on every move and
  // flip the window interactive ONLY while it's over actual content (anything
  // that isn't the bare transparent root). Change-tracked so we don't spam IPC.
  useEffect(() => {
    const hud = window.electronAPI as unknown as { hudSetInteractive?: (on: boolean) => void }
    let last = false
    const onMove = (e: MouseEvent) => {
      const root = rootRef.current
      if (!root) return
      const el = document.elementFromPoint(e.clientX, e.clientY)
      const interactive = !!el && el !== root && root.contains(el)
      if (interactive !== last) { last = interactive; hud.hudSetInteractive?.(interactive) }
    }
    window.addEventListener('mousemove', onMove)
    return () => window.removeEventListener('mousemove', onMove)
  }, [])

  const clearAutoHide = useCallback(() => {
    if (autoHideRef.current) {
      clearTimeout(autoHideRef.current)
      autoHideRef.current = null
    }
  }, [])

  const scheduleAutoHide = useCallback((delayMs: number) => {
    clearAutoHide()
    autoHideRef.current = setTimeout(() => {
      autoHideRef.current = null
      setState('hidden')
    }, delayMs)
  }, [clearAutoHide])

  useEffect(() => {
    document.body.classList.add('widget-body')
    document.documentElement.style.background = 'transparent'
    return () => {
      document.body.classList.remove('widget-body')
    }
  }, [])

  // Keep the Remote badge coupled to the pill. The badge and the pill are two
  // separate elements gated by different conditions (badge: isRemote; pill:
  // state), so a latched isRemote could let the badge appear/linger without the
  // pill. The moment the pill leaves an ACTIVE state (→ output/hidden/error/…),
  // drop isRemote so the badge can never outlive the pill. A new Remote capture
  // re-sets isRemote via remoteOnCaptureKind on the next recording:start.
  useEffect(() => {
    const active =
      state === 'dictation-active' ||
      state === 'instruction-active' ||
      state === 'processing'
    if (!active) setIsRemote(false)
  }, [state])

  // ─── Peek the current engine each time a dictation starts ───
  // We don't block the recording on this; we just enrich the awareness
  // card asynchronously. Clearing offlineReason on 'hidden' makes the
  // card auto-dismiss when the pill goes away.
  useEffect(() => {
    const isActive =
      state === 'dictation-active' ||
      state === 'instruction-active' ||
      state === 'processing'
    if (!isActive) {
      setOfflineReason(null)
      return
    }
    // Already populated mid-session? Don't re-peek (avoids flicker when
    // moving from active → processing).
    if (offlineReason !== null) return
    window.electronAPI.paywallEnginePeekStatus?.().then((r) => {
      if (r && r.provider === 'local' && r.reason) {
        setOfflineReason(r.reason as OfflineReason)
      }
    }).catch(() => { /* ignore */ })
  }, [state, offlineReason])

  // ─── Listen for runtime fallback (managed → local mid-call) ───
  useEffect(() => {
    window.electronAPI.paywallOnEngineFellBack?.((info) => {
      setOfflineReason(info.reason)
    })
  }, [])

  useEffect(() => {
    const api = window.electronAPI

    api.getSoundFeedback().then((enabled: boolean) => {
      soundEnabled = enabled
    }).catch(() => { /* default true */ })

    // Additive Remote-kind listener (also fires on recording:start, reading its
    // 4th arg). Tells us whether this capture is Remote so the pill can badge it.
    const remoteApi = api as unknown as {
      remoteOnCaptureKind?: (cb: (kind: 'dictation' | 'remote') => void) => void
    }
    remoteApi.remoteOnCaptureKind?.((kind) => setIsRemote(kind === 'remote'))

    api.onRecordingStart(async (mode, sessionId) => {
      clearAutoHide()
      playClickSound('start')
      setEngineNotice(null)
      setState(mode === 'dictation' ? 'dictation-active' : 'instruction-active')
      try {
        await startRecording(undefined, mode, sessionId)
      } catch {
        setErrorMessage('Mic error. Check settings.')
        setState('error')
        scheduleAutoHide(3000)
      }
    })

    api.onRecordingStop(async () => {
      setState('processing')
      setShowDiscardHint(false)
      await stopRecording()
    })

    api.onOutputReady(() => {
      playClickSound('stop')
      setState('output')
      setShowDiscardHint(false)
      scheduleAutoHide(1200)
    })

    api.onOutputFallback((text, _sessionId, message) => {
      playClickSound('stop')
      const preview = text.length > 50 ? text.slice(0, 50) + '...' : text
      setOutputPreview(preview)
      setFallbackMessage(message || 'Formatting unavailable — pasted raw')
      setState('output-fallback')
      setShowDiscardHint(false)
      scheduleAutoHide(4000)
    })

    api.onOutputError((error) => {
      playClickSound('stop')
      setErrorMessage(error)
      setState('error')
      setShowDiscardHint(false)
      scheduleAutoHide(5000)
    })

    api.onSessionCancelled(() => {
      setState('cancelled')
      setShowDiscardHint(false)
    })

    api.onProcessingDiscardHint(() => {
      setShowDiscardHint(true)
    })

    api.onSessionTooShort(() => {
      setState('too-short')
      setShowDiscardHint(false)
    })

    api.onEngineNotice((reason) => {
      setEngineNotice(reason)
    })

    api.widgetReady()

    return () => {
      api.removeAllListeners('recording:start')
      api.removeAllListeners('recording:stop')
      api.removeAllListeners('output:ready')
      api.removeAllListeners('output:fallback')
      api.removeAllListeners('output:error')
      api.removeAllListeners('session:cancelled')
      api.removeAllListeners('processing:show-discard-hint')
      api.removeAllListeners('session:too-short')
      api.removeAllListeners('session:engine-notice')
    }
  }, [startRecording, stopRecording, clearAutoHide, scheduleAutoHide])

  const handleCancel = useCallback(async () => {
    await stopRecording()
    window.electronAPI.cancelSession()
    setState('hidden')
  }, [stopRecording])

  const handleStop = useCallback(async () => {
    setState('processing')
    await stopRecording()
  }, [stopRecording])

  const handleUndo = useCallback(() => {
    setState('processing')
    window.electronAPI.undoCancel()
  }, [])

  const handleAwarenessDismiss = useCallback(() => {
    sessionDismissed = true
    setDismissedTick((n) => n + 1)
  }, [])

  // Card visibility: pill is showing AND we know we're on local AND user
  // hasn't × it this session AND the pill state isn't terminal (output/
  // error/cancelled — at those points the pill is collapsing anyway).
  const pillShowing =
    state === 'dictation-active' ||
    state === 'instruction-active' ||
    state === 'processing'
  const showAwareness =
    pillShowing && offlineReason !== null && !sessionDismissed
  // `dismissedTick` is read here just to trigger re-render on dismiss
  void dismissedTick

  return (
    <div
      ref={rootRef}
      className="w-full h-full flex flex-col items-center"
      style={{ background: 'transparent', paddingTop: '8px' }}
    >
      {/* Remote capture → circular badge to the LEFT of the pill, with a gap.
          Dictation → pill only. */}
      <div className="flex items-center justify-center" style={{ gap: '16px' }}>
        {isRemote && pillShowing && <RemoteBadge />}
        {isRemote && pillShowing && <RawToggle />}
        {/* the screenshot ledger shows for BOTH capture kinds — dictation pastes
            the images into the target app after the text; Remote attaches them
            to the task. Self-hides at zero. */}
        {pillShowing && <StagedImagesChip />}
        <Widget
          state={state}
          analyserNode={analyserNode}
          maxDurationSeconds={maxDurationSeconds}
          outputPreview={outputPreview}
          fallbackMessage={fallbackMessage}
          errorMessage={errorMessage}
          showDiscardHint={showDiscardHint}
          engineNotice={engineNotice}
          onCancel={handleCancel}
          onStop={handleStop}
          onUndo={handleUndo}
        />
      </div>
      {showAwareness && (
        <OfflineAwarenessCard
          reason={offlineReason}
          onDismiss={handleAwarenessDismiss}
        />
      )}
    </div>
  )
}
