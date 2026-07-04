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

// ── Pre-roll ring (the last word-loss gap) ────────────────────────────────
// People start the first syllable a beat BEFORE the key lands. With the pipe
// permanently warm we can afford a rolling pre-roll: a segment recorder runs
// continuously and is RESTARTED every PREROLL_CYCLE_MS, so at any moment we
// hold at most ~1.2s of recent audio (each restart discards the previous
// segment — the privacy promise stays: nothing older than the ring exists,
// nothing is transcribed or leaves the machine until a dictation adopts it).
// At key-down the recorder ADOPTS the live segment — its buffered chunks are
// the pre-roll, and the same recorder keeps running as THE dictation
// recorder, so the whole file is one valid webm stream.
const PREROLL_CYCLE_MS = 1200
let preRecorder: MediaRecorder | null = null
let preChunks: Blob[] = []
let preCycle: ReturnType<typeof setInterval> | null = null
let preAdopted = false

function spinPreRollSegment(): void {
  if (preAdopted || !stream || state !== 'connected') return
  try { if (preRecorder && preRecorder.state !== 'inactive') preRecorder.stop() } catch { /* replacing anyway */ }
  preChunks = []
  try {
    preRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' })
    preRecorder.ondataavailable = (e) => { if (e.data.size > 0) preChunks.push(e.data) }
    preRecorder.start(250)
  } catch (err) {
    console.warn('[audio:warm] pre-roll segment failed:', err instanceof Error ? err.message : err)
    preRecorder = null
  }
}

function startPreRoll(): void {
  preAdopted = false
  spinPreRollSegment()
  if (preCycle) clearInterval(preCycle)
  preCycle = setInterval(spinPreRollSegment, PREROLL_CYCLE_MS)
  ;(preCycle as { unref?: () => void }).unref?.()
}

function stopPreRoll(): void {
  if (preCycle) { clearInterval(preCycle); preCycle = null }
  try { if (preRecorder && preRecorder.state !== 'inactive') preRecorder.stop() } catch { /* gone */ }
  preRecorder = null
  preChunks = []
}

/** Key-down: hand the LIVE pre-roll segment to the dictation. The returned
 *  recorder is already running (chunks = the pre-roll so far); the caller
 *  owns it from here. Null when unavailable (caller records normally). */
export function adoptPreRoll(): { recorder: MediaRecorder; chunks: Blob[] } | null {
  if (state !== 'connected' || !preRecorder || preRecorder.state === 'inactive') return null
  preAdopted = true
  if (preCycle) { clearInterval(preCycle); preCycle = null }
  const out = { recorder: preRecorder, chunks: preChunks }
  preRecorder = null
  preChunks = []
  return out
}

/** Recording ended: resume the pre-roll ring for the next key-down. */
export function resumePreRoll(): void {
  if (state === 'connected') startPreRoll()
}

let stream: MediaStream | null = null
let ctx: AudioContext | null = null
let monitor: ReturnType<typeof setInterval> | null = null
let state: WarmState = 'off'
let lastSampleAt = 0
let connectSeq = 0 // guards a stale connect() resolving after a disconnect
const listeners = new Set<(s: WarmState) => void>()

function setState(next: WarmState): void {
  if (state === next) return
  state = next
  for (const cb of listeners) { try { cb(state) } catch { /* listener's problem */ } }
}

export function warmState(): WarmState { return state }

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
  console.log('[audio:warm] connecting iPhone mic (session mode)…')
  try {
    const s = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: { exact: deviceId }, sampleRate: 16000 },
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
      disconnectWarmMic('zombie-at-connect')
      return false
    }
    // Liveness monitor: one tiny read every 500ms while connected.
    monitor = setInterval(() => { if (sampleSeen()) lastSampleAt = Date.now() }, 500)
    ;(monitor as { unref?: () => void }).unref?.()
    s.getAudioTracks()[0]?.addEventListener('ended', () => {
      console.warn('[audio:warm] iPhone mic track ended (link died / phone left)')
      disconnectWarmMic('track-ended')
    })
    setState('connected')
    startPreRoll()
    console.log(`[audio:warm] iPhone mic CONNECTED (warm-up ${Date.now() - t0}ms) — pipe held until the user disconnects`)
    return true
  } catch (err) {
    console.warn('[audio:warm] connect failed:', err instanceof Error ? err.message : err)
    disconnectWarmMic('connect-error')
    return false
  }
}

export function disconnectWarmMic(reason: string): void {
  connectSeq++ // invalidate any in-flight connect
  stopPreRoll()
  if (monitor) { clearInterval(monitor); monitor = null }
  if (stream) { stream.getTracks().forEach((t) => { try { t.stop() } catch { /* gone */ } }); stream = null }
  if (ctx) { void ctx.close().catch(() => { /* already closed */ }); ctx = null }
  lastSampleAt = 0
  if (state !== 'off') console.log(`[audio:warm] iPhone mic disconnected (${reason})`)
  setState('off')
}
