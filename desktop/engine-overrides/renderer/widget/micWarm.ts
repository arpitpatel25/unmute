// Session-mode keep-warm for the iPhone Continuity microphone.
//
// THE finding that forced this (capture telemetry, 2026-07-05): the Continuity
// pipe's warm-up is wildly variable — 210ms one dictation, 3,074ms the next,
// dead the one after. Opening the stream fresh at key-down means the user's
// opening words are spoken into a pipe that isn't flowing yet; no client-side
// trick recovers audio the phone never sent. The only fix matching real usage
// ("speak at key-down" is a habit, not a choice) is a pipe that is ALREADY
// warm.
//
// The design (settled with the user, do not drift):
//   - Selecting the iPhone glyph = CONNECT: open the stream once, hold it.
//     Samples flow continuously and are DISCARDED — nothing is recorded,
//     nothing is transcribed, nothing leaves the machine. The phone's mic
//     indicator staying lit is the honest, EXPECTED consequence of a device
//     the user deliberately connected (the AirPods mental model).
//   - Selecting the Mac glyph = DISCONNECT. The user owns the lifecycle;
//     Unmute never drops the connection on its own (a dead link is the one
//     exception — it reports itself and the chip heals).
//   - Recording = flipping "discard" to "keep": key-down hands the ALREADY
//     FLOWING stream to the recorder. Zero warm-up, first word intact.
//
// Liveness: a 500ms monitor reads one ~3ms analyser window (trivially cheap,
// honors the no-heavy-work-while-recording rule) and remembers when it last
// saw a nonzero sample. `warmIsHot()` is the recorder's key-down check; a
// warm-but-silent-too-long stream is treated as a zombie by the caller.

export type WarmState = 'off' | 'connecting' | 'connected'

let stream: MediaStream | null = null
let ctx: AudioContext | null = null
let monitor: ReturnType<typeof setInterval> | null = null
let state: WarmState = 'off'
let lastSampleAt = 0
let connectSeq = 0 // guards a stale connect() resolving after a disconnect
// Set while a dictation records FROM the warm stream (see useAudioRecorder).
let warmBusy = false
let pendingDisconnectReason: string | null = null
const listeners = new Set<(s: WarmState) => void>()

/** Is a dictation capture currently running? Set by useAudioRecorder around
 *  every recording (any source) — lets connect-completion say "NEXT dictation"
 *  when the current one is staying on its original mic. */
let captureRunning = false
export function setCaptureInFlight(on: boolean): void { captureRunning = on }
function captureInFlight(): boolean { return captureRunning }

/** Status narration: plain-text one-liners the widget shows the user. Text,
 *  not pulses — chip colors are ambience, words are communication. */
function announce(text: string | null, source?: 'iphone' | 'mac'): void {
  try { window.dispatchEvent(new CustomEvent('unmute:mic-status', { detail: { text, source } })) } catch { /* UI's problem */ }
}

function setState(next: WarmState): void {
  if (state === next) return
  state = next
  for (const cb of listeners) { try { cb(state) } catch { /* listener's problem */ } }
}

export function warmState(): WarmState { return state }

/** The recorder marks the warm stream in-use for the duration of a recording;
 *  a user-toggle disconnect arriving meanwhile is deferred to release time. */
export function setWarmBusy(on: boolean): void {
  warmBusy = on
  if (!on && pendingDisconnectReason) {
    const reason = pendingDisconnectReason
    pendingDisconnectReason = null
    disconnectWarmMic(reason)
  }
}

export function onWarmState(cb: (s: WarmState) => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/** The held stream — only while connected. The recorder must NEVER stop its
 *  tracks (cleanup checks identity against this). */
export function getWarmStream(): MediaStream | null {
  return state === 'connected' ? stream : null
}

/** Key-down check: is the warm pipe demonstrably flowing right now?
 *  (Samples seen within the last monitor window + margin.) */
export function warmIsHot(): boolean {
  return state === 'connected' && Date.now() - lastSampleAt < 1500
}

/**
 * Connect (idempotent): open the phone stream and hold it. Resolves true once
 * samples actually flow (the honest "connected"), false if the device never
 * delivered within the patience window (caller decides cooldown/fallback).
 */
export async function connectWarmMic(deviceId: string): Promise<boolean> {
  if (state === 'connected' || state === 'connecting') return state === 'connected'
  const seq = ++connectSeq
  setState('connecting')
  announce('Connecting iPhone mic…')
  console.log('[audio:warm] connecting iPhone mic (session mode)…')
  try {
    // Chromium's processing chain OFF for the phone: iOS already cleaned this
    // audio on-device; a second NS/AGC/EC pass only smears it (double-cleaning).
    const s = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: { exact: deviceId }, sampleRate: 16000, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    })
    if (seq !== connectSeq) { s.getTracks().forEach((t) => t.stop()); return false } // superseded
    stream = s
    ctx = new AudioContext()
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 128
    ctx.createMediaStreamSource(s).connect(analyser)
    const probe = new Float32Array(analyser.fftSize)
    const sampleSeen = (): boolean => {
      analyser.getFloatTimeDomainData(probe)
      for (let i = 0; i < probe.length; i++) if (probe[i] !== 0) return true
      return false
    }
    // Wait for first flow — the one-time warm-up, surfaced as "connecting".
    const t0 = Date.now()
    while (Date.now() - t0 < 4000) {
      if (seq !== connectSeq) return false
      if (sampleSeen()) { lastSampleAt = Date.now(); break }
      await new Promise((r) => setTimeout(r, 25))
    }
    if (lastSampleAt === 0 || Date.now() - lastSampleAt > 1500) {
      console.warn('[audio:warm] iPhone mic never delivered samples — zombie at connect')
      announce('iPhone mic unavailable — using MacBook', 'mac')
      disconnectWarmMic('zombie-at-connect')
      return false
    }
    // Liveness monitor: one tiny read every 500ms while connected.
    monitor = setInterval(() => { if (sampleSeen()) lastSampleAt = Date.now() }, 500)
    ;(monitor as { unref?: () => void }).unref?.()
    s.getAudioTracks()[0]?.addEventListener('ended', () => {
      console.warn('[audio:warm] iPhone mic track ended (link died / phone left)')
      announce('iPhone mic lost — switching to MacBook', 'mac')
      disconnectWarmMic('track-ended')
    })
    setState('connected')
    // Mid-recording connect: the ACTIVE dictation stays on its original mic
    // (sources are never swapped mid-recording) — say so, or the user talks
    // into a phone that isn't recording yet (observed live, felt like lost
    // audio). warmBusy is false here (this stream isn't recording), so the
    // signal is whether ANY capture is in flight.
    announce(
      captureInFlight()
        ? 'iPhone mic connected — used from your NEXT dictation'
        : 'iPhone mic connected — dictations will use it',
      undefined // do not override the glyph truth of a recording in progress
    )
    console.log(`[audio:warm] iPhone mic CONNECTED (warm-up ${Date.now() - t0}ms) — pipe held until the user disconnects`)
    return true
  } catch (err) {
    console.warn('[audio:warm] connect failed:', err instanceof Error ? err.message : err)
    disconnectWarmMic('connect-error')
    return false
  }
}

export function disconnectWarmMic(reason: string): void {
  // USER-initiated disconnect while a recording is actively using this stream
  // must NOT yank the tracks from under the recorder ("sources are never
  // swapped mid-recording") — observed live: a mid-dictation chip tap killed
  // the session. Defer it; the recorder's release executes it. Link-death and
  // zombie disconnects still act immediately (the tracks are dead anyway).
  if (warmBusy && reason === 'user-selected-mac') {
    pendingDisconnectReason = reason
    announce('Switching to MacBook after this dictation')
    console.log('[audio:warm] disconnect deferred — a recording is using the stream; applies when it ends')
    return
  }
  connectSeq++ // invalidate any in-flight connect
  if (monitor) { clearInterval(monitor); monitor = null }
  if (stream) { stream.getTracks().forEach((t) => { try { t.stop() } catch { /* gone */ } }); stream = null }
  if (ctx) { void ctx.close().catch(() => { /* already closed */ }); ctx = null }
  lastSampleAt = 0
  if (state !== 'off') console.log(`[audio:warm] iPhone mic disconnected (${reason})`)
  setState('off')
}
