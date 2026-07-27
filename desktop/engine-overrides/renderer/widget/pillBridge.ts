// The bridge from this renderer's capture state to the NATIVE input surface.
//
// The pill's pixels live in the Swift helper; its behaviour stays here, because
// this renderer owns the audio. Nothing about the capture path moves — no
// device handling, no VAD, no recorder lifecycle. This module only:
//
//   widget state  →  pillPushState   (on change)
//   analyser      →  pillPushLevel   (throttled, while recording only)
//   helper event  →  a callback the widget already implements
//
// THE THROTTLE IS THE POINT. The level is the only thing that changes per
// frame, and a main-process round-trip per frame is exactly the work that
// corrupts audio. LEVEL_HZ is deliberately conservative; the meter reads as
// continuous well below 60fps because the Swift side eases between values.

import { useEffect, useRef } from 'react'

export type PillPhase =
  | 'hidden' | 'listening' | 'transcribing' | 'landed' | 'error' | 'draft'

/** Frames per second for the amplitude push. 20 is smooth to the eye once the
 *  receiving view eases between samples, and is 3× cheaper than matching the
 *  display refresh. Raise only with a measurement in hand. */
const LEVEL_HZ = 20

export interface PillBridgeApi {
  pillPushState?: (state: Record<string, unknown>) => void
  pillPushLevel?: (level: number, elapsed?: number) => void
  pillHide?: () => void
  onPillEvent?: (cb: (e: { type: string; value?: unknown }) => void) => () => void
}

function api(): PillBridgeApi {
  return (window as unknown as { electronAPI?: PillBridgeApi }).electronAPI ?? {}
}

/** True when the native surface is drawing the pill, so this renderer must not
 *  also draw one. Mirrors UNMUTE_NOTCH_ENABLED on the main side: if the helper
 *  is off, the DOM pill is still the surface and nothing here applies. */
export function nativePillActive(): boolean {
  return typeof api().pillPushState === 'function'
}

/** Map the widget's state machine onto the surface's phases. */
export function toPhase(state: string, draftOffer: boolean): PillPhase {
  if (draftOffer) return 'draft'
  switch (state) {
    case 'dictation-active':
    case 'instruction-active':
    case 'chained':
      return 'listening'
    case 'processing':
      return 'transcribing'
    case 'output':
    case 'output-fallback':
      return 'landed'
    case 'error':
    case 'too-short':
      return 'error'
    // 'cancelled' and 'hidden' both mean the surface is gone. Cancelled is
    // deliberately NOT an error — the user meant to discard it.
    default:
      return 'hidden'
  }
}

/** RMS of the analyser's time-domain data, 0…1. The same read the DOM waveform
 *  already did — this does not add a second tap on the audio graph. */
export function levelOf(analyser: AnalyserNode | null, buf: Uint8Array): number {
  if (!analyser) return 0
  analyser.getByteTimeDomainData(buf as never)
  let sum = 0
  for (let i = 0; i < buf.length; i++) {
    const v = (buf[i] - 128) / 128
    sum += v * v
  }
  // sqrt of mean square, lifted a little so quiet speech still moves the meter.
  return Math.min(1, Math.sqrt(sum / buf.length) * 2.6)
}

/** Push the descriptive state whenever it changes. */
export function usePillState(state: Record<string, unknown>, enabled: boolean): void {
  const last = useRef<string>('')
  useEffect(() => {
    if (!enabled) return
    const json = JSON.stringify(state)
    if (json === last.current) return
    last.current = json
    api().pillPushState?.(state)
  }, [state, enabled])
}

/** Drive the amplitude while — and ONLY while — a capture is running. */
export function usePillLevel(
  analyser: AnalyserNode | null,
  recording: boolean,
  elapsed: () => number,
  enabled: boolean,
): void {
  useEffect(() => {
    if (!enabled || !recording || !analyser) return
    const buf = new Uint8Array(analyser.fftSize)
    let raf = 0
    let last = 0
    const tick = (t: number) => {
      raf = requestAnimationFrame(tick)
      if (t - last < 1000 / LEVEL_HZ) return
      last = t
      api().pillPushLevel?.(levelOf(analyser, buf), elapsed())
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [analyser, recording, enabled, elapsed])
}

/** Route gestures from the native surface back into this renderer. */
export function usePillEvents(
  handlers: Partial<Record<string, (value?: unknown) => void>>,
  enabled: boolean,
): void {
  const ref = useRef(handlers)
  ref.current = handlers
  useEffect(() => {
    if (!enabled) return
    return api().onPillEvent?.((e) => { ref.current[e.type]?.(e.value) })
  }, [enabled])
}
