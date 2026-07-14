import { useState, useEffect, useRef } from 'react'
import type { WidgetState } from '../shared/types'

interface WidgetProps {
  state: WidgetState
  analyserNode: AnalyserNode | null
  maxDurationSeconds?: number
  outputPreview?: string
  fallbackMessage?: string
  errorMessage?: string
  showDiscardHint?: boolean
  engineNotice?: string | null
  draftOffer?: boolean
  onAcceptDraft?: () => void
  onCancel: () => void
  onStop: () => void
  onUndo: () => void
}


// ── Self-carried critical styles ──────────────────────────────────────────
// The invisible-pill incident (2026-07-05): the HUD window occasionally lost
// its external stylesheet (dev/HMR hiccup) — the class-styled pill rendered
// as a transparent, zero-layout ghost while the inline-styled mic chip sat
// beside it looking normal. The pill's CRITICAL styles now travel WITH the
// component as a <style> element in its own subtree: identical rules, same
// values, so normally they're a no-op duplicate — but if the stylesheet ever
// vanishes, the pill still renders. (Cosmetic extras like the shimmer bar
// stay external; losing polish is fine, losing the pill is not.)
const PILL_CRITICAL_CSS = `
@keyframes hud-enter { from { transform: translateY(-20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
@keyframes hud-exit { from { transform: translateY(0); opacity: 1; } to { transform: translateY(-12px); opacity: 0; } }
.animate-hud-enter { animation: hud-enter 0.25s cubic-bezier(0.16, 1, 0.3, 1) forwards; }
.animate-hud-exit  { animation: hud-exit 0.18s ease-in forwards; }
@keyframes dot-pulse-red { 0%, 100% { transform: scale(1); box-shadow: 0 0 0 0 rgba(255,255,255,0.4); } 50% { transform: scale(0.85); box-shadow: 0 0 0 4px rgba(255,255,255,0.0); } }
@keyframes dot-pulse-white { 0%, 100% { transform: scale(1); } 50% { transform: scale(0.83); } }
@keyframes dot-pulse-processing { 0%, 100% { transform: scale(1); box-shadow: 0 0 0 0 rgba(56,182,255,0.5); } 50% { transform: scale(0.85); box-shadow: 0 0 0 5px rgba(56,182,255,0.0); } }
.animate-dot-pulse-red   { animation: dot-pulse-red 1.5s ease-in-out infinite; }
.animate-dot-pulse-white { animation: dot-pulse-white 1.5s ease-in-out infinite; }
.animate-dot-pulse-processing { animation: dot-pulse-processing 1.5s ease-in-out infinite; }
/* NO drop shadow: Unmute must occupy ONLY the widget itself — a soft 36px
   shadow pooled behind the whole pill row and read as a bounding box around the
   panel. The external styles.css already sets box-shadow:none (line ~1244); this
   self-carried duplicate lagged behind and, injected later in the DOM, WON the
   cascade — so the stale shadow was what actually rendered. Kept in sync now. */
.unmute-pill { display: inline-flex; align-items: center; gap: 10px; height: 44px; padding: 0 14px; background: #0E0E10; border: 1px solid rgba(255,255,255,0.55); border-radius: 9999px; box-shadow: none; max-width: 480px; }
.unmute-pill-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.unmute-pill-dot--white { background: rgba(255,255,255,0.88); }
.unmute-pill-dot--red { background: rgb(255,90,90); }
.unmute-pill-dot--processing { background: rgb(56,182,255); }
.unmute-pill-label { font-size: 13px; font-weight: 500; letter-spacing: 0.01em; white-space: nowrap; color: rgba(255,255,255,0.55); }
.unmute-pill-timer { font-size: 12px; font-variant-numeric: tabular-nums; color: rgba(255,255,255,0.30); white-space: nowrap; transition: color 0.3s ease; }
.unmute-pill-timer--warn { color: #FFAA33; }
.unmute-pill-waveform { flex-shrink: 0; display: flex; align-items: center; }
.unmute-pill-stop { width: 28px; height: 28px; border-radius: 50%; border: none; cursor: pointer; display: flex; align-items: center; justify-content: center; flex-shrink: 0; transition: all 0.15s; background: rgba(255,255,255,0.08); }
.unmute-pill-stop:hover { background: rgba(255,255,255,0.14); transform: scale(1.08); }
.unmute-pill-stop-icon { width: 9px; height: 9px; border-radius: 2px; }
.unmute-pill-stop-icon--white { background: rgba(255,255,255,0.85); }
.unmute-pill-stop-icon--red { background: rgba(255,255,255,0.85); }
.unmute-pill-processing { display: flex; align-items: center; gap: 8px; }
.unmute-pill-draft-btn { border: 1px solid rgba(255,255,255,0.35); background: rgba(255,255,255,0.08); color: rgba(255,255,255,0.85); font-size: 12px; border-radius: 9999px; padding: 3px 10px; cursor: pointer; white-space: nowrap; }
.unmute-pill-draft-btn:hover { background: rgba(255,255,255,0.16); }
`


export default function Widget({
  state,
  maxDurationSeconds = 300,
  outputPreview,
  fallbackMessage,
  errorMessage,
  showDiscardHint = false,
  engineNotice = null,
  draftOffer = false,
  onAcceptDraft,
  onStop,
  onUndo
}: WidgetProps) {
  const [elapsed, setElapsed] = useState(0)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const [exiting, setExiting] = useState(false)
  const prevStateRef = useRef<WidgetState>('hidden')

  const isRecording =
    state === 'dictation-active' ||
    state === 'instruction-active' ||
    state === 'chained'

  const isDictation = state === 'dictation-active'
  const isInstruction = state === 'instruction-active' || state === 'chained'

  // Entry/Exit animation
  useEffect(() => {
    const wasHidden = prevStateRef.current === 'hidden'
    const isNowHidden = state === 'hidden'

    if (!wasHidden && isNowHidden) {
      setExiting(true)
      const timeout = setTimeout(() => setExiting(false), 200)
      prevStateRef.current = state
      return () => clearTimeout(timeout)
    }
    // THE VANISHING-PILL RACE: a dictation started within the 200ms fade
    // cancelled the timer above via the effect cleanup — and nothing else ever
    // reset `exiting`. The pill then rendered EVERY subsequent state with the
    // exit animation stuck at its end (opacity 0, `forwards`): invisible pill,
    // healthy state machine, chip beside it looking normal. Any non-hiding
    // transition means the exit is over or aborted — reset unconditionally.
    setExiting(false)
    prevStateRef.current = state
  }, [state])

  // Recording timer
  useEffect(() => {
    if (isRecording) {
      setElapsed(0)
      timerRef.current = setInterval(() => setElapsed((p) => p + 1), 1000)
    } else if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [isRecording])

  function formatTime(s: number): string {
    return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`
  }

  if (state === 'hidden' && !exiting) return null

  const MAX_DURATION = maxDurationSeconds
  const WARN_THRESHOLD = 30
  const timeRemaining = MAX_DURATION - elapsed
  const isNearLimit = isRecording && timeRemaining <= WARN_THRESHOLD

  const dotClass = isDictation ? 'unmute-pill-dot--white' : 'unmute-pill-dot--red'
  const dotPulseClass = isDictation ? 'animate-dot-pulse-white' : 'animate-dot-pulse-red'
  const stopIconClass = isDictation ? 'unmute-pill-stop-icon--white' : 'unmute-pill-stop-icon--red'

  return (
    <div className={exiting ? 'animate-hud-exit' : 'animate-hud-enter'}>
      <style>{PILL_CRITICAL_CSS}</style>

      {/* ══════ RECORDING (pill) ══════ */}
      {isRecording && (
        <div className="unmute-pill">
          {/* Remote (instruction) captures show a small remote glyph in place of
              the recording dot, so the pill itself reads as "remote" at a glance.
              Kept dot-sized (14px) and whitish; reuses the dot pulse so it still
              feels live. Dictation keeps the plain dot. */}
          {isInstruction ? (
            <span
              className={`unmute-pill-dot-icon ${dotPulseClass}`}
              aria-hidden="true"
              style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none"
                stroke="rgba(255,255,255,0.92)" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round">
                <path d="M10.5 5V1.8" />
                <rect x="4.5" y="5" width="7" height="9.5" rx="1.8" />
                <path d="M6.4 7.4h3.2" />
                <circle cx="8" cy="11.4" r="1.2" />
              </svg>
            </span>
          ) : (
            <div className={`unmute-pill-dot ${dotClass} ${dotPulseClass}`} />
          )}
          <span className={`unmute-pill-timer ${isNearLimit ? 'unmute-pill-timer--warn' : ''}`}>
            {isNearLimit ? `-${formatTime(timeRemaining)}` : formatTime(elapsed)}
          </span>
          <button className="unmute-pill-stop" onClick={onStop} aria-label="Stop recording">
            <div className={`unmute-pill-stop-icon ${stopIconClass}`} />
          </button>
        </div>
      )}

      {/* ══════ PROCESSING (pill) ══════ */}
      {state === 'processing' && (
        <div className="unmute-pill">
          <div className="unmute-pill-dot unmute-pill-dot--processing animate-dot-pulse-processing" />
          <span className="unmute-pill-label">
            {draftOffer ? 'Taking longer…' : engineNotice ? 'On-device' : 'Processing'}
          </span>
          <div className="unmute-pill-dots unmute-pill-dots--processing">
            <span className="animate-dot-bounce" />
            <span className="animate-dot-bounce" />
            <span className="animate-dot-bounce" />
          </div>
          {draftOffer ? (
            <button className="unmute-pill-draft-btn animate-fade-up-in" onClick={onAcceptDraft}>
              Use quick draft
            </button>
          ) : engineNotice ? (
            <span className="unmute-pill-helper animate-fade-up-in">offline model</span>
          ) : showDiscardHint && (
            <span className="unmute-pill-helper animate-fade-up-in">Esc to discard</span>
          )}
        </div>
      )}

      {/* ══════ OUTPUT — silent success ack (text is already at the cursor) ══════ */}
      {state === 'output' && (
        <div className="unmute-pill animate-success-pop">
          <div className="unmute-pill-success-icon">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
              stroke="#00C896" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </div>
        </div>
      )}

      {/* ══════ OUTPUT FALLBACK (pill) ══════ */}
      {state === 'output-fallback' && (
        <div className="unmute-pill unmute-pill--fallback animate-success-pop">
          <div className="unmute-pill-fallback-icon">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
              stroke="#FFAA33" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          </div>
          <span className="unmute-pill-fallback-text">{fallbackMessage || 'Formatting unavailable — pasted raw'}</span>
          <span className="unmute-pill-output-text">{outputPreview}</span>
        </div>
      )}

      {/* ══════ ERROR (pill) ══════ */}
      {state === 'error' && (
        <div className="unmute-pill unmute-pill--error animate-fade-up-in">
          <div className="unmute-pill-error-icon">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
              stroke="#FF4444" strokeWidth="2.5" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </div>
          <div className="unmute-pill-error-content">
            <span className="unmute-pill-error-text">{errorMessage || 'Something went wrong'}</span>
            {!errorMessage?.includes('limit reached') && (
              <span className="unmute-pill-error-hint">Retry from History to regenerate</span>
            )}
          </div>
        </div>
      )}

      {/* ══════ NOTHING CAPTURED — too short or silent (no API call made) ══════ */}
      {state === 'too-short' && (
        <div className="unmute-pill unmute-pill--muted animate-fade-up-in">
          <span className="unmute-pill-muted-text">Didn't catch that</span>
        </div>
      )}

      {/* ══════ CANCELLED (pill) ══════ */}
      {state === 'cancelled' && (
        <div className="unmute-pill animate-fade-up-in">
          <span className="unmute-pill-cancel-text">Cancelled</span>
          <button className="unmute-pill-undo animate-undo-appear" onClick={onUndo}>
            Undo
          </button>
        </div>
      )}
    </div>
  )
}
