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

export default function WidgetApp() {
  const [state, setState] = useState<WidgetState>('hidden')
  const [outputPreview, setOutputPreview] = useState('')
  const [fallbackMessage, setFallbackMessage] = useState('')
  const [errorMessage, setErrorMessage] = useState('')
  const [showDiscardHint, setShowDiscardHint] = useState(false)
  const [engineNotice, setEngineNotice] = useState<string | null>(null)
  const [offlineReason, setOfflineReason] = useState<OfflineReason | null>(null)
  const [dismissedTick, setDismissedTick] = useState(0)
  const { analyserNode, maxDurationSeconds, startRecording, stopRecording } = useAudioRecorder()

  const autoHideRef = useRef<ReturnType<typeof setTimeout> | null>(null)

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
      className="w-full h-full flex flex-col items-center"
      style={{ background: 'transparent', paddingTop: '8px' }}
    >
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
      {showAwareness && (
        <OfflineAwarenessCard
          reason={offlineReason}
          onDismiss={handleAwarenessDismiss}
        />
      )}
    </div>
  )
}
