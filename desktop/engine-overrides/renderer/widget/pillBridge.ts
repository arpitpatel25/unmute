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

/** One-for-one with the widget's own state machine — see toPhase. */
export type PillPhase =
  | 'hidden' | 'recording' | 'processing' | 'output'
  | 'output-fallback' | 'too-short' | 'cancelled' | 'error'

// THE AMPLITUDE PUSH IS GONE.
//
// It existed to drive a waveform — which the original pill does not have. The
// `analyserNode` prop is passed into Widget.tsx and never rendered; the
// `.unmute-pill-waveform` class is vestigial. Having rebuilt the pill to the
// original anatomy (dot/glyph + timer + stop), there is nothing for a per-frame
// value to drive.
//
// So the capture path now carries ONE push per second, for the timer, instead
// of twenty. The measured cost of the 20Hz version was already negligible
// (~2µs/frame, 0.004% main-thread duty over a two-minute capture) — this is
// simply 20× less of an already-safe thing, and no longer touches the audio
// graph at all.
const TICK_MS = 1000

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

/** Map the widget's state machine onto the surface's phases.
 *
 *  ONE-FOR-ONE, deliberately. The first version collapsed eight states into
 *  five: `too-short` was folded into `error` (so "Didn't catch that" became
 *  "something went wrong"), `cancelled` was dropped to `hidden` (taking the
 *  Undo affordance with it), and `output-fallback` was merged into plain
 *  success (so a raw paste stopped saying formatting had failed). A draft offer
 *  is a flag ON processing, not a state of its own. */
export function toPhase(state: string): PillPhase {
  switch (state) {
    case 'dictation-active':
    case 'instruction-active':
    case 'chained':
      return 'recording'
    case 'processing':       return 'processing'
    case 'output':           return 'output'
    case 'output-fallback':  return 'output-fallback'
    case 'too-short':        return 'too-short'
    case 'cancelled':        return 'cancelled'
    case 'error':            return 'error'
    default:                 return 'hidden'
  }
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

/** Tick the recording timer — one push per second, and ONLY while recording. */
export function usePillTicker(
  recording: boolean,
  elapsed: () => number,
  enabled: boolean,
): void {
  useEffect(() => {
    if (!enabled || !recording) return
    api().pillPushLevel?.(0, elapsed())     // land 0:00 immediately
    const id = setInterval(() => api().pillPushLevel?.(0, elapsed()), TICK_MS)
    return () => clearInterval(id)
  }, [recording, enabled, elapsed])
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
