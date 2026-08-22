// Meeting Notetaker — the floating widget's renderer (loaded at
// #/notetaker-widget by notetakerWidget.ts, mirroring how OverlayApp.tsx is
// loaded at #/overlay by overlay.ts).
//
// A small circle, bottom-left, showing a live waveform while a note-taking
// session is active — spec §7: "not buried, more like a floating thing."
// Clicking it surfaces a Cancel affordance; a second click on Cancel itself
// confirms (spec §6: stop is NEVER a single, direct action). No timer
// anywhere in this file — the waveform redraws itself off the AnalyserNode
// via requestAnimationFrame, matching this codebase's existing precedent in
// widget/useAudioRecorder.ts + widget/Widget.tsx (WidgetApp owns the
// getUserMedia capture and analyser; Widget is the prop-driven presentational
// piece). This file follows the same split, consolidated into one module
// per this task's file budget.

import { useEffect, useRef, useState } from 'react'

const BAR_COUNT = 5

type API = {
  notetakerCancelRequested?: () => void
}
function api(): API {
  return (window as unknown as { electronAPI?: API }).electronAPI ?? {}
}

/**
 * Presentational piece: a circle with either a live waveform or a Cancel
 * button, depending on `confirmingCancel`. Pure prop-driven (no IPC, no
 * capture) so it's easy to reason about and reuse — mirrors Widget.tsx's
 * split from WidgetApp.tsx.
 */
export function NotetakerWidget({
  analyser,
  onCancelConfirmed,
}: {
  analyser: AnalyserNode | null
  onCancelConfirmed: () => void
}) {
  const [levels, setLevels] = useState<number[]>(() => new Array(BAR_COUNT).fill(0.1))
  const [confirmingCancel, setConfirmingCancel] = useState(false)
  const rafRef = useRef<number | undefined>(undefined)

  // Live waveform: reads the analyser every animation frame. No setInterval —
  // requestAnimationFrame both matches the display refresh and stops for free
  // when the (hidden) window isn't being painted.
  useEffect(() => {
    if (!analyser) return
    const data = new Uint8Array(analyser.frequencyBinCount)
    const tick = () => {
      analyser.getByteTimeDomainData(data)
      const chunkSize = Math.max(1, Math.floor(data.length / BAR_COUNT))
      const next = new Array(BAR_COUNT).fill(0).map((_, i) => {
        let sum = 0
        let n = 0
        for (let j = i * chunkSize; j < Math.min(data.length, (i + 1) * chunkSize); j++) {
          sum += Math.abs(data[j] - 128)
          n++
        }
        return n === 0 ? 0 : Math.min(1, (sum / n / 128) * 2)
      })
      setLevels(next)
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => {
      if (rafRef.current !== undefined) cancelAnimationFrame(rafRef.current)
    }
  }, [analyser])

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={confirmingCancel ? 'Cancel note-taking?' : 'Note-taking in progress'}
      onClick={() => setConfirmingCancel((v) => !v)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') setConfirmingCancel((v) => !v)
      }}
      className="w-14 h-14 rounded-full flex items-center justify-center gap-[3px] cursor-pointer select-none"
      style={{
        background: 'rgba(20, 20, 22, 0.92)',
        boxShadow: '0 2px 12px rgba(0,0,0,0.35)',
        // @ts-expect-error -- WebkitAppRegion is a real, non-standard Electron CSS prop
        WebkitAppRegion: 'no-drag',
      }}
    >
      {confirmingCancel ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            setConfirmingCancel(false)
            onCancelConfirmed()
          }}
          className="text-[10px] font-medium text-white/90 bg-transparent border-none cursor-pointer px-1"
        >
          Cancel
        </button>
      ) : (
        levels.map((level, i) => (
          <div
            key={i}
            className="w-[3px] rounded-full bg-white/90"
            style={{
              height: Math.max(4, Math.round(level * 24)),
              transition: 'height 60ms linear',
            }}
          />
        ))
      )}
    </div>
  )
}

/**
 * Route entry point mounted at #/notetaker-widget (see main.tsx). Owns the
 * local mic capture + AnalyserNode — same recipe as
 * widget/useAudioRecorder.ts's analyser setup (AudioContext + createAnalyser,
 * fftSize 128, one MediaStreamSource) — and wires the confirmed-Cancel click
 * to the main process over the `notetaker:cancel-requested` IPC channel via
 * the shared preload bridge (electron/remote-preload.ts). The main-process
 * handler for that channel, and feeding this window a REAL shared analyser
 * tied to the actual meeting audio rather than a locally-opened mic stream,
 * are composition-root concerns (Task 10) — this widget degrades gracefully
 * (flat/no bars) if getUserMedia is unavailable or denied.
 */
export function NotetakerWidgetRoute() {
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null)

  useEffect(() => {
    let cancelled = false
    let stream: MediaStream | null = null
    let audioContext: AudioContext | null = null

    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((s) => {
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop())
          return
        }
        stream = s
        audioContext = new AudioContext()
        const node = audioContext.createAnalyser()
        node.fftSize = 128
        audioContext.createMediaStreamSource(s).connect(node)
        setAnalyser(node)
      })
      .catch(() => {
        // No mic access in this window (denied/unavailable) — the widget
        // still shows and is still clickable, just with a flat waveform.
      })

    return () => {
      cancelled = true
      stream?.getTracks().forEach((t) => t.stop())
      void audioContext?.close()
    }
  }, [])

  return (
    <NotetakerWidget
      analyser={analyser}
      onCancelConfirmed={() => api().notetakerCancelRequested?.()}
    />
  )
}
