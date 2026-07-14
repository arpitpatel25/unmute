import { useState, useRef, useCallback } from 'react'
import { getWarmStream, warmIsHot, disconnectWarmMic, setWarmBusy, warmState, setCaptureInFlight } from './micWarm'
import { effectiveSilenceThreshold, decideCut } from './vadPolicy'

type RecordingMode = 'dictation' | 'instruction'

interface UseAudioRecorderReturn {
  isRecording: boolean
  analyserNode: AnalyserNode | null
  maxDurationSeconds: number
  /** True once THIS recording looks like a noisy environment (high noise floor,
   *  collapsed speech-to-noise ratio). Purely a signal for the pill's gentle
   *  "lean in" hint — detection never touches the audio path. */
  noisyEnvironment: boolean
  /** True when the recording's loudest moment is still faint — coach "bring
   *  the mic closer" while there's time to fix it. */
  tooQuiet: boolean
  startRecording: (deviceId?: string, mode?: RecordingMode, sessionId?: string) => Promise<void>
  stopRecording: () => Promise<void>
}

const MIN_DURATION_MS = 500
const DEFAULT_MAX_DURATION_MS = 10 * 60 * 1000 // 10 minutes
const MIN_BUDGET_SECONDS = 5 // Don't start recording if budget < 5 seconds

// ─── VAD Chunking Defaults (overridden by server config at recording start) ───
const DEFAULT_CHUNK_MIN_MS = 30_000
const DEFAULT_SILENCE_THRESHOLD_RMS = 0.015
const DEFAULT_SILENCE_DURATION_MS = 400
const DEFAULT_HARD_CHUNK_CAP_MS = 45_000
const DEFAULT_VAD_POLL_INTERVAL_MS = 100

// ─── Noisy-environment detection (signal only, never a fix) ───
// Rides on the RMS the VAD loop already computes — zero extra audio work.
// Heuristic: in a quiet room the GAPS between words sit near digital silence
// (p20 ≈ 0.002-0.005) and speech peaks 10-30× above them. In a noisy spot the
// floor itself climbs past the speech-presence threshold AND the ratio
// collapses. Requiring BOTH keeps a soft-spoken user in a silent room (low
// floor) and a loud clear voice over a fan (high ratio) from being flagged.
const NOISY_MIN_FRAMES = 20            // ≥2s of evidence before judging
const NOISY_EVAL_EVERY_N_FRAMES = 5    // percentile math twice a second
// Short window = responsive: field test showed a 20s window lagged ~5s behind
// noise onset (new noise must displace old quiet history before p20 moves).
// 6s of history reacts in ~1.5-2.5s while still smoothing single-word spikes.
const NOISY_WINDOW_FRAMES = 60
// Retract hysteresis: the hint is a LIVE signal — when the noise stops, it
// should go. Clear when the floor sits below 70% of the trigger level for
// NOISY_CLEAR_EVALS consecutive evaluations (~2s), far enough below the
// trigger that boundary noise can't flicker the chip.
const NOISY_CLEAR_FLOOR_RMS = 0.0084
const NOISY_CLEAR_EVALS = 4
// CALIBRATED against real captures (2026-07-04, post-noise-suppression, 8-bit
// analyser): music at home ⇒ floor 0.013-0.014, speech 0.11-0.12, ratio 8-9.
// The original guesses (0.02 / <5) missed it on BOTH axes — Chromium's noise
// suppressor scrubs the gaps harder than expected, and a close mic keeps the
// ratio high even in real noise. Floor is the primary signal; the ratio cap
// is only a safety so a hot mic in a silent room can't be flagged.
const NOISY_FLOOR_RMS = 0.012          // gaps clearly above a quiet room's near-zero floor
const NOISY_MAX_RATIO = 12             // safety: voice hugely above floor = mic is fine
const NOISY_HINT_COOLDOWN_MS = 10 * 60_000 // same café, three dictations ≠ three nags
let lastNoisyHintAt = 0 // module-level: survives pill remounts within the session

// ── Zombie-phone cooldown ─────────────────────────────────────────────────
// When the Continuity link dies, macOS can keep the iPhone ENUMERATED and
// ACQUIRABLE while its wireless backend is gone — a zombie: getUserMedia
// succeeds, zero samples ever flow (observed live: 4 consecutive dictations
// recorded silence). After one confirmed zombie (gate cap-hit), skip the
// phone for a cooldown so the next dictations don't re-pay the 3s toll on a
// corpse. The device list refresh (event below) usually clears the zombie
// from enumeration well within this window.
const PHONE_ZOMBIE_COOLDOWN_MS = 60_000
let phoneZombieUntil = 0

// ── Too-quiet detection (the flip side of the noisy hint) ─────────────────
// Field data: the one garbled transcript of an otherwise-clean session was
// the one capture ~4× quieter than the rest (rmsMax 0.065 vs 0.13-0.65).
// Whisper got a whisper. Coach the fix in the moment: after enough evidence,
// if the LOUDEST the recording ever got is still faint, say so. Retracts if
// the level recovers (they leaned in). Same anti-nag pattern as the noisy
// hint: once per recording + a global cooldown.
const QUIET_MIN_FRAMES = 30            // ≥3s of evidence
const QUIET_MAX_RMS = 0.07             // never louder than this = too faint (good captures peak ≥0.13)
const QUIET_RECOVER_RMS = 0.11         // clearly audible again → retract
const QUIET_HINT_COOLDOWN_MS = 10 * 60_000
let lastQuietHintAt = 0

// ── Capture telemetry (observation only — zero behavior impact) ──────────
// One [audio:telemetry] line per event, greppable, JSON payloads. The goal:
// when a dictation is bad, the log alone should say WHY — what device, what
// processing, what the audio physically looked like, and when every stage
// happened. Timings are ms since the capture REQUEST (key-down).
interface CaptureTelemetry {
  t0: number
  source: string
  marks: Record<string, number>
  // audio-quality accumulators (fed by the existing 100ms VAD tick)
  frames: number
  zeroFrames: number       // all-exact-zero frames (dead pipe signature)
  clippedSamples: number   // |v| > 0.99 (overload/plosive slam)
  peak: number
  rmsSum: number
  rmsMax: number
  trackEvents: string[]    // mute/unmute/ended with timestamps
  chunks: number
  chunkBytes: number
}
// A valid webm/matroska file MUST begin with the EBML magic. Any assembly of
// recorder chunks passes through this guard: leading chunks that are not the
// header (stray tails from a rotated recorder, torn buffers) are dropped so a
// malformed head can never reach STT again — the failure mode becomes 'lost a
// stray fragment' instead of 'entire dictation errored'.
const EBML_MAGIC = [0x1a, 0x45, 0xdf, 0xa3]
async function trimToWebmHeader(chunks: Blob[]): Promise<Blob[]> {
  for (let i = 0; i < chunks.length; i++) {
    try {
      const head = new Uint8Array(await chunks[i].slice(0, 4).arrayBuffer())
      if (EBML_MAGIC.every((b, j) => head[j] === b)) {
        if (i > 0) console.warn(`[audio] dropped ${i} leading headerless chunk(s) — stream re-anchored to its webm header`)
        return i === 0 ? chunks : chunks.slice(i)
      }
    } catch { /* unreadable chunk — keep scanning */ }
  }
  return chunks // no header found anywhere — send as-is rather than send nothing
}

/** Per-capture source truth + optional user-facing text (see micWarm.announce). */
function announceSource(source: 'iphone' | 'mac', text?: string): void {
  try { window.dispatchEvent(new CustomEvent('unmute:mic-status', { detail: { text: text ?? null, source } })) } catch { /* UI's problem */ }
}

function tlog(event: string, data: Record<string, unknown>): void {
  try { console.log(`[audio:telemetry] ${event} ${JSON.stringify(data)}`) } catch { /* never break capture */ }
}

export function useAudioRecorder(): UseAudioRecorderReturn {
  const [isRecording, setIsRecording] = useState(false)
  const [analyserNode, setAnalyserNode] = useState<AnalyserNode | null>(null)
  const [maxDurationSeconds, setMaxDurationSeconds] = useState(300)
  const [noisyEnvironment, setNoisyEnvironment] = useState(false)
  const [tooQuiet, setTooQuiet] = useState(false)
  const quietFlaggedRef = useRef<boolean>(false)

  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const startTimeRef = useRef<number>(0)
  const maxTimerRef = useRef<NodeJS.Timeout | null>(null)
  // Mode is frozen at recording start — survives even if startRecording is called again
  const frozenModeRef = useRef<RecordingMode>('dictation')
  // Session ID this recording belongs to — sent with audio so the main process
  // can reject a late buffer that belongs to a dictation that already ended.
  const frozenSessionIdRef = useRef<string | undefined>(undefined)
  // Guard against double-sending audio
  const audioSentRef = useRef<boolean>(false)
  // Holds the in-flight AudioContext.close() so the NEXT recording can wait for
  // the mic to be fully released before re-acquiring it. Without this, the 2nd
  // (and every later) recording started getUserMedia while the prior context was
  // still tearing down, and the MediaRecorder emitted a malformed/undecodable
  // webm — every STT engine rejected it and dictation fell back to offline.
  const teardownRef = useRef<Promise<void> | null>(null)
  // Was THIS recording captured from a requested (iPhone Continuity) device?
  // Drives the source-gated behaviors below (stop grace). Never true for the
  // default Mac-mic path — the no-regression guarantee is structural.
  const phoneSourceRef = useRef<boolean>(false)
  // When capture was REQUESTED (key-down → startRecording entry). The phone
  // path's pipe gate delays the RECORDER clock (startTimeRef) by up to 3s, so
  // too-short decisions must use this clock — the user's actual hold — or a
  // gated quick utterance gets unfairly discarded (observed: 497ms recorded
  // from a much longer hold, eaten by a 3ms miss). On the Mac path the two
  // clocks are ~identical, so behavior there is unchanged.
  const requestTimeRef = useRef<number>(0)
  const telemetryRef = useRef<CaptureTelemetry | null>(null)

  // ─── VAD Chunking Refs ───
  const chunkIndexRef = useRef<number>(0)
  const chunkStartTimeRef = useRef<number>(0)
  const macroBlobsRef = useRef<Blob[]>([])  // Micro-chunks for current macro chunk
  const silenceStartRef = useRef<number | null>(null)
  const vadIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const vadActivatedRef = useRef<boolean>(false)
  const chunkedModeEnabledRef = useRef<boolean>(false)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const vadDelayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Track if we're in the middle of emitting a chunk (MediaRecorder stop/restart cycle)
  const isEmittingChunkRef = useRef<boolean>(false)
  // Key-release arrived DURING a VAD chunk-cut (recorder mid-swap). Natural
  // collision: the user releases the key BECAUSE they stopped speaking, and
  // "stopped speaking" is the exact silence signal the VAD cuts on. emitChunk
  // honors this flag by finalizing instead of restarting.
  const stopDuringEmitRef = useRef<boolean>(false)
  // Whether any speech (RMS above the silence threshold) was heard this recording.
  // If false on stop, we skip STT entirely — no wasted API call.
  const heardSpeechRef = useRef<boolean>(false)

  // ─── Noisy-environment refs (per recording) ───
  const rmsFramesRef = useRef<number[]>([])
  // Latest p20 of the rolling rms window — THIS recording's noise floor.
  // Feeds the adaptive silence threshold (vadPolicy) so café pauses cut.
  const noiseFloorRef = useRef<number | null>(null)
  const noisyFrameCountRef = useRef<number>(0)
  const noisyFlaggedRef = useRef<boolean>(false)      // chip currently up
  const noisyEverFlaggedRef = useRef<boolean>(false)  // fired at least once THIS recording (re-flag skips the global cooldown)
  const noisyQuietEvalsRef = useRef<number>(0)        // consecutive quiet evals while flagged

  // ─── Server-config-driven chunking params (loaded at recording start) ───
  const chunkMinMsRef = useRef<number>(DEFAULT_CHUNK_MIN_MS)
  const silenceThresholdRef = useRef<number>(DEFAULT_SILENCE_THRESHOLD_RMS)
  const silenceDurationMsRef = useRef<number>(DEFAULT_SILENCE_DURATION_MS)
  const hardChunkCapMsRef = useRef<number>(DEFAULT_HARD_CHUNK_CAP_MS)
  const vadPollIntervalMsRef = useRef<number>(DEFAULT_VAD_POLL_INTERVAL_MS)

  const cleanupStream = useCallback(() => {
    setCaptureInFlight(false)
    if (maxTimerRef.current) {
      clearTimeout(maxTimerRef.current)
      maxTimerRef.current = null
    }
    // Clean up VAD
    if (vadIntervalRef.current) {
      clearInterval(vadIntervalRef.current)
      vadIntervalRef.current = null
    }
    if (vadDelayTimerRef.current) {
      clearTimeout(vadDelayTimerRef.current)
      vadDelayTimerRef.current = null
    }
    vadActivatedRef.current = false
    isEmittingChunkRef.current = false

    if (streamRef.current) {
      // The warm session stream outlives recordings by design — the user
      // connected it; only the user (or a dead link) disconnects it.
      if (streamRef.current !== getWarmStream()) {
        streamRef.current.getTracks().forEach((t) => t.stop())
      } else {
        setWarmBusy(false) // releases any deferred user-toggle disconnect
      }
      streamRef.current = null
    }
    if (audioContextRef.current) {
      // close() is ASYNC. Keep the promise so startRecording can await the mic
      // being fully released before the next getUserMedia (the fix for the
      // "every recording after the first is corrupt" bug). Null the ref now so
      // nothing reuses a closing context.
      const ctx = audioContextRef.current
      audioContextRef.current = null
      teardownRef.current = ctx.close().catch(() => { /* already closed */ }).then(() => {
        if (teardownRef.current) teardownRef.current = null
      })
    }
    analyserRef.current = null
    setAnalyserNode(null)
  }, [])

  /**
   * Emit a macro chunk: stop MediaRecorder → assemble valid WebM blob → send via IPC → restart.
   * The gap falls on a detected silence period, so no audible audio loss.
   */
  const emitChunk = useCallback(async (reason: 'silence' | 'soft-cap' | 'hard-cap'): Promise<void> => {
    const recorder = mediaRecorderRef.current
    const stream = streamRef.current
    if (!recorder || recorder.state === 'inactive' || !stream) return
    if (isEmittingChunkRef.current) return // Prevent re-entrance

    isEmittingChunkRef.current = true
    const chunkIdx = chunkIndexRef.current
    const elapsed = Date.now() - chunkStartTimeRef.current
    const mode = frozenModeRef.current

    // Pause VAD monitoring during the stop/restart cycle
    if (vadIntervalRef.current) {
      clearInterval(vadIntervalRef.current)
      vadIntervalRef.current = null
    }

    // Stop MediaRecorder — triggers final ondataavailable then onstop
    const existingOnStop = recorder.onstop
    await new Promise<void>((resolve) => {
      recorder.onstop = () => resolve()
      recorder.stop()
    })

    // Assemble all accumulated micro-chunks into a valid WebM blob
    const macroBlobs = [...macroBlobsRef.current]
    macroBlobsRef.current = []

    if (macroBlobs.length === 0) {
      console.log(`[audio:vad] Chunk ${chunkIdx} has no data, skipping`)
      isEmittingChunkRef.current = false
      return
    }

    const blob = new Blob(await trimToWebmHeader(macroBlobs), { type: 'audio/webm' })
    const buffer = await blob.arrayBuffer()

    console.log(`[audio:vad] cut reason=${reason}, chunk ${chunkIdx} at ${elapsed}ms (${buffer.byteLength} bytes)`)

    // Send chunk to main process
    window.electronAPI.sendAudioChunk(buffer, chunkIdx, mode, frozenSessionIdRef.current)

    // Stop landed mid-cut (see stopDuringEmitRef): the chunk just sent IS the
    // last audio. Deliver the final-chunk signal so the session completes and
    // pastes — never restart the recorder into a session that has ended.
    if (stopDuringEmitRef.current) {
      stopDuringEmitRef.current = false
      audioSentRef.current = true
      window.electronAPI?.paywallStreamClose?.()
      const total = chunkIdx + 1
      const heldDuration = Date.now() - startTimeRef.current
      window.electronAPI.sendAudioFinalChunk(new ArrayBuffer(0), total, total, heldDuration, mode, frozenSessionIdRef.current)
      chunkIndexRef.current = total
      isEmittingChunkRef.current = false
      cleanupStream()
      return
    }

    // Paywall: close the current streaming POST (chunkIdx) and open a new one
    // for the next macro chunk (chunkIdx + 1). Before this fix the renderer
    // opened a single stream at chunkIndex 0 for the WHOLE recording, so VAD
    // chunks 1+ silently fell through to the upload-after-stop path
    // (tryManagedSTT) and paid the full audio upload latency. Now every macro
    // chunk gets its own streaming POST — paywall-stream.ts already tracks
    // sessions in a Map<chunkIndex, StreamSession>, we just had to drive the
    // index from the renderer.
    const nextChunkIdx = chunkIdx + 1
    window.electronAPI?.paywallStreamClose?.()
    window.electronAPI?.paywallStreamOpen?.({
      flowType: mode === 'instruction' ? 'instruction' : 'dictation',
      chunkIndex: nextChunkIdx,
    })

    // Increment chunk index and reset chunk start time
    chunkIndexRef.current = nextChunkIdx
    chunkStartTimeRef.current = Date.now()
    silenceStartRef.current = null

    // Restart MediaRecorder on the same live stream (stream is still active).
    // audioBitsPerSecond = 32_000: opus voice-mode bitrate. Whisper STT
    // accuracy is statistically indistinguishable from the browser default
    // (~64-128 kbps) for spoken English at this rate — multiple public
    // benchmarks show <0.5% WER delta. We get ~50% smaller uploads, which
    // is meaningful on mobile hotspots and congested wifi (~30-150ms
    // saved on the upload leg) and a no-op on fast connections.
    if (stream.active) {
      const newRecorder = new MediaRecorder(stream, {
        mimeType: 'audio/webm;codecs=opus',
        // Note: tried audioBitsPerSecond: 32_000 here — Groq's Whisper
        // endpoint returned 400 on the resulting opus stream. Reverted
        // to the browser default (≈64-96 kbps) until we either probe
        // Groq's actual minimum or move to a different STT provider.
      })
      mediaRecorderRef.current = newRecorder

      newRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          chunksRef.current.push(e.data) // Full recording backup
          macroBlobsRef.current.push(e.data) // Current macro chunk
          // Forward to the active paywall stream (chunkIdx+1). Without this,
          // bytes for chunks 1+ would never reach paywall-stream and the
          // newly-opened stream would just sit empty.
          e.data.arrayBuffer().then((buf) => {
            window.electronAPI?.paywallStreamChunk?.(buf)
          }).catch(() => { /* best-effort */ })
        }
      }

      newRecorder.start(250)

      // Resume VAD monitoring
      startVADMonitoring()
    }

    isEmittingChunkRef.current = false
  }, [])

  /**
   * Start VAD monitoring interval — checks audio levels every 100ms.
   */
  const startVADMonitoring = useCallback(() => {
    if (vadIntervalRef.current) return // Already running

    const analyser = analyserRef.current
    if (!analyser) return

    const bufferLength = analyser.frequencyBinCount
    const dataArray = new Uint8Array(bufferLength)

    vadIntervalRef.current = setInterval(() => {
      if (isEmittingChunkRef.current) return

      analyser.getByteTimeDomainData(dataArray)

      // Compute RMS
      let sumSquares = 0
      for (let i = 0; i < bufferLength; i++) {
        const normalized = (dataArray[i] - 128) / 128
        sumSquares += normalized * normalized
      }
      const rms = Math.sqrt(sumSquares / bufferLength)

      // Telemetry accumulation (same tick, float precision, ~3ms of audio):
      // physical audio quality — peaks, clipping, dead frames — so a bad
      // transcription can be traced to WHAT THE MIC DELIVERED.
      {
        const tel = telemetryRef.current
        if (tel) {
          const fbuf = new Float32Array(analyser.fftSize)
          analyser.getFloatTimeDomainData(fbuf)
          let allZero = true
          for (let i = 0; i < fbuf.length; i++) {
            const v = fbuf[i]
            if (v !== 0) allZero = false
            const a = Math.abs(v)
            if (a > tel.peak) tel.peak = a
            if (a > 0.99) tel.clippedSamples++
          }
          tel.frames++
          if (allZero) tel.zeroFrames++
          tel.rmsSum += rms
          if (rms > tel.rmsMax) tel.rmsMax = rms
          if (!tel.marks.firstSound && !allZero) tel.marks.firstSound = Date.now() - tel.t0
        }
      }

      // Track speech across the whole recording (independent of chunk VAD activation)
      if (rms >= silenceThresholdRef.current) heardSpeechRef.current = true

      // Noisy-environment watch: a LIVE signal. Collect every frame; judge twice
      // a second. The chip RAISES when the floor climbs + ratio collapses, and
      // RETRACTS (hysteresis, ~2s sustained quiet) when the noise stops.
      {
        const frames = rmsFramesRef.current
        frames.push(rms)
        if (frames.length > NOISY_WINDOW_FRAMES) frames.shift()
        // Cadence off a monotonic counter — frames.length pins at the window
        // cap, where `length % N` became always-true (the every-100ms log spam).
        noisyFrameCountRef.current++
        if (frames.length >= NOISY_MIN_FRAMES && noisyFrameCountRef.current % NOISY_EVAL_EVERY_N_FRAMES === 0) {
          const sorted = [...frames].sort((a, b) => a - b)
          const floor = sorted[Math.floor(sorted.length * 0.2)]   // the "gaps"
          noiseFloorRef.current = floor
          const speech = sorted[Math.floor(sorted.length * 0.9)]  // the voice
          // Too-quiet: judged on the recording's loudest moment so far.
          {
            const tel = telemetryRef.current
            const maxSoFar = tel ? tel.rmsMax : 0
            if (!quietFlaggedRef.current && frames.length >= QUIET_MIN_FRAMES
                && heardSpeechRef.current === true && maxSoFar > 0 && maxSoFar < QUIET_MAX_RMS
                && Date.now() - lastQuietHintAt > QUIET_HINT_COOLDOWN_MS) {
              quietFlaggedRef.current = true
              lastQuietHintAt = Date.now()
              console.log(`[audio:quiet] too-quiet detected (rmsMax=${maxSoFar.toFixed(4)})`)
              setTooQuiet(true)
            } else if (quietFlaggedRef.current && maxSoFar >= QUIET_RECOVER_RMS) {
              quietFlaggedRef.current = false
              console.log('[audio:quiet] level recovered — hint retracted')
              setTooQuiet(false)
            }
          }
          if (!noisyFlaggedRef.current) {
            // Raise: global cooldown applies to the FIRST fire of a recording
            // only — a re-raise after mid-recording noise-return is fresh signal.
            const cooldownOk = noisyEverFlaggedRef.current || Date.now() - lastNoisyHintAt > NOISY_HINT_COOLDOWN_MS
            if (cooldownOk && floor > NOISY_FLOOR_RMS && speech / Math.max(floor, 1e-6) < NOISY_MAX_RATIO) {
              noisyFlaggedRef.current = true
              noisyEverFlaggedRef.current = true
              noisyQuietEvalsRef.current = 0
              lastNoisyHintAt = Date.now()
              console.log(`[audio:noise] noisy environment detected (floor=${floor.toFixed(4)}, speech=${speech.toFixed(4)})`)
              setNoisyEnvironment(true)
            }
          } else {
            // Retract: sustained quiet well below the trigger level.
            if (floor < NOISY_CLEAR_FLOOR_RMS) {
              noisyQuietEvalsRef.current++
              if (noisyQuietEvalsRef.current >= NOISY_CLEAR_EVALS) {
                noisyFlaggedRef.current = false
                noisyQuietEvalsRef.current = 0
                console.log('[audio:noise] environment quiet again — hint retracted')
                setNoisyEnvironment(false)
              }
            } else {
              noisyQuietEvalsRef.current = 0
            }
          }
        }
      }

      // Chunk-splitting logic only runs once VAD is activated (long recordings)
      if (!vadActivatedRef.current) return

      const chunkElapsed = Date.now() - chunkStartTimeRef.current

      // Adaptive threshold: "silence" is judged relative to THIS recording's
      // measured noise floor, so noisy rooms still get natural cuts instead
      // of running into the hard cap mid-word.
      const threshold = effectiveSilenceThreshold(silenceThresholdRef.current, noiseFloorRef.current)

      // Maintain the silence run-length the policy consumes.
      if (rms < threshold) {
        if (silenceStartRef.current === null) silenceStartRef.current = Date.now()
      } else {
        silenceStartRef.current = null
      }

      const decision = decideCut({
        rms,
        chunkElapsedMs: chunkElapsed,
        silenceSinceMs: silenceStartRef.current === null ? null : Date.now() - silenceStartRef.current,
        minChunkMs: chunkMinMsRef.current,
        silenceDurationMs: silenceDurationMsRef.current,
        hardCapMs: hardChunkCapMsRef.current,
        softCapWindowMs: 5_000,
        threshold,
      })
      if (decision !== 'none') {
        console.log(`[audio:vad] cut=${decision} at ${chunkElapsed}ms (rms=${rms.toFixed(4)}, threshold=${threshold.toFixed(4)}, floor=${(noiseFloorRef.current ?? 0).toFixed(4)})`)
        emitChunk(decision)
      }
    }, vadPollIntervalMsRef.current)
  }, [emitChunk])

  /**
   * Flush the current recorder: stop it, collect chunks, send audio with correct mode.
   * Returns true if audio was sent, false if not (too short / no chunks / already sent).
   * After calling this, the recorder is inactive and refs are cleaned up.
   */
  const flushRecorder = useCallback(async (): Promise<boolean> => {
    const recorder = mediaRecorderRef.current
    if (!recorder || recorder.state === 'inactive') {
      return false
    }

    // Mark as sent to prevent double-send from onstop handler
    if (audioSentRef.current) {
      console.log('[audio] Audio already sent for this recording, skipping flush')
      return false
    }
    audioSentRef.current = true

    // Paywall: close the streaming POST so the worker finalizes any in-flight
    // upload (same reason as in stopRecording).
    window.electronAPI?.paywallStreamClose?.()

    const duration = Date.now() - startTimeRef.current
    const mode = frozenModeRef.current

    // Detach any existing onstop handler to prevent double-send
    recorder.onstop = null

    // Same tail grace as stopRecording — a flushed phone recording deserves
    // its in-flight syllables too.
    if (phoneSourceRef.current) {
      await new Promise((r) => setTimeout(r, 300))
    }

    // Stop the recorder — this triggers a final ondataavailable then onstop
    // We wait for onstop so the final chunk is added to chunksRef.current
    await new Promise<void>((resolve) => {
      recorder.onstop = () => resolve()
      recorder.stop()
    })

    // Check if we were in chunked mode and chunks were emitted
    if (chunkedModeEnabledRef.current && chunkIndexRef.current > 0) {
      // Send the remaining micro-chunks as the final chunk
      const macroBlobs = [...macroBlobsRef.current]
      macroBlobsRef.current = []

      if (macroBlobs.length > 0) {
        const blob = new Blob(await trimToWebmHeader(macroBlobs), { type: 'audio/webm' })
        const buffer = await blob.arrayBuffer()
        const totalChunks = chunkIndexRef.current + 1
        console.log(`[audio] Flushed FINAL chunk ${chunkIndexRef.current}/${totalChunks}, size: ${buffer.byteLength}, duration: ${duration}ms`)
        window.electronAPI.sendAudioFinalChunk(buffer, chunkIndexRef.current, totalChunks, duration, mode, frozenSessionIdRef.current)
      } else {
        // No remaining data — send totalChunks based on what was already sent
        const totalChunks = chunkIndexRef.current
        console.log(`[audio] No remaining data for final chunk, totalChunks: ${totalChunks}`)
        // Send a minimal final chunk signal so sessionManager knows we're done
        const emptyBuffer = new ArrayBuffer(0)
        window.electronAPI.sendAudioFinalChunk(emptyBuffer, chunkIndexRef.current, totalChunks, duration, mode, frozenSessionIdRef.current)
      }

      cleanupStream()
      return true
    }

    // Non-chunked path (original behavior)
    const chunks = [...chunksRef.current]

    // Clean up stream/context
    cleanupStream()

    // Discard if too short, empty, or silent (no speech) — no STT call.
    // Too-short judges the HELD time (request→now): the gate must not make a
    // real utterance look sub-threshold.
    const heldMs = Date.now() - requestTimeRef.current
    if (Math.max(duration, heldMs) < MIN_DURATION_MS || chunks.length === 0 || !heardSpeechRef.current) {
      console.log('[audio] Discarding (short/empty/silent). Duration:', duration, 'heardSpeech:', heardSpeechRef.current)
      window.electronAPI.sendAudioDiscarded(frozenModeRef.current, frozenSessionIdRef.current)
      return false
    }

    // Assemble and send
    const blob = new Blob(await trimToWebmHeader(chunks), { type: 'audio/webm' })
    const buffer = await blob.arrayBuffer()
    console.log('[audio] Flushed audio, mode:', mode, 'size:', buffer.byteLength, 'duration:', duration)
    emitCaptureSummary('flush', buffer.byteLength, duration)
    window.electronAPI.sendAudioReady(buffer, duration, mode, frozenSessionIdRef.current)
    return true
  }, [cleanupStream])

  /** One line that judges the whole capture: device, timings, physical audio
   *  quality, delivery size. THE line to read when a dictation came out wrong. */
  const emitCaptureSummary = useCallback((via: string, bytes: number, durationMs: number) => {
    const tel = telemetryRef.current
    if (!tel) return
    tlog('capture-summary', {
      via,
      source: tel.source,
      marks: tel.marks,                                 // acquired/pipeLive/recorderStart/firstChunk/firstSound…
      durationMs,
      bytes,
      kbps: durationMs > 0 ? Math.round((bytes * 8) / durationMs) : 0,
      frames: tel.frames,
      zeroFramePct: tel.frames ? Math.round((tel.zeroFrames / tel.frames) * 100) : 0, // dead-pipe % of the recording
      rmsAvg: tel.frames ? +(tel.rmsSum / tel.frames).toFixed(4) : 0,
      rmsMax: +tel.rmsMax.toFixed(4),
      peak: +tel.peak.toFixed(3),
      clippedSamples: tel.clippedSamples,               // >0 = overload (too close / AGC slam)
      trackEvents: tel.trackEvents,                     // link health during THIS capture
      chunks: tel.chunks,
    })
  }, [])

  const startRecording = useCallback(async (deviceId?: string, mode?: RecordingMode, sessionId?: string) => {
    // If there's an active recorder, flush it first (sends its audio with correct
    // mode AND the previous session's frozen ID — set below only after the flush).
    const existingRecorder = mediaRecorderRef.current
    if (existingRecorder && existingRecorder.state !== 'inactive') {
      console.log('[audio] Flushing previous recording before starting new one (mode was:', frozenModeRef.current, ')')
      await flushRecorder()
    }

    requestTimeRef.current = Date.now()
    telemetryRef.current = {
      t0: Date.now(), source: 'pending', marks: {}, frames: 0, zeroFrames: 0,
      clippedSamples: 0, peak: 0, rmsSum: 0, rmsMax: 0, trackEvents: [], chunks: 0, chunkBytes: 0,
    }
    // Reset state for new recording
    frozenModeRef.current = mode || 'dictation'
    frozenSessionIdRef.current = sessionId
    audioSentRef.current = false
    heardSpeechRef.current = false
    chunksRef.current = []
    rmsFramesRef.current = []
    noiseFloorRef.current = null
    noisyFrameCountRef.current = 0
    noisyFlaggedRef.current = false
    noisyEverFlaggedRef.current = false
    noisyQuietEvalsRef.current = 0
    quietFlaggedRef.current = false
    setTooQuiet(false)
    setNoisyEnvironment(false)

    // Reset chunking state
    chunkIndexRef.current = 0
    chunkStartTimeRef.current = 0
    macroBlobsRef.current = []
    silenceStartRef.current = null
    vadActivatedRef.current = false
    chunkedModeEnabledRef.current = false
    isEmittingChunkRef.current = false

    // Check if chunked transcription is enabled (only for dictation mode)
    if (frozenModeRef.current === 'dictation') {
      try {
        const chunkedEnabled = await window.electronAPI.getChunkedTranscription()
        chunkedModeEnabledRef.current = chunkedEnabled
        console.log('[audio] Chunked transcription:', chunkedEnabled ? 'ENABLED' : 'DISABLED')
      } catch {
        console.log('[audio] Could not query chunked transcription setting, defaulting to disabled')
      }
    }

    // Load server-driven chunking params (non-blocking — falls back to defaults)
    try {
      const config = await window.electronAPI.getServerConfig()
      if (config?.chunking) {
        chunkMinMsRef.current = config.chunking.min_duration_ms ?? DEFAULT_CHUNK_MIN_MS
        silenceThresholdRef.current = config.chunking.silence_threshold_rms ?? DEFAULT_SILENCE_THRESHOLD_RMS
        silenceDurationMsRef.current = config.chunking.silence_duration_ms ?? DEFAULT_SILENCE_DURATION_MS
        hardChunkCapMsRef.current = config.chunking.hard_cap_ms ?? DEFAULT_HARD_CHUNK_CAP_MS
        vadPollIntervalMsRef.current = config.chunking.vad_poll_interval_ms ?? DEFAULT_VAD_POLL_INTERVAL_MS
        console.log(`[audio] Loaded chunking config v${config.version}: min=${chunkMinMsRef.current}ms, silence=${silenceThresholdRef.current}, hardCap=${hardChunkCapMsRef.current}ms`)
      }
    } catch {
      console.log('[audio] Could not load server config, using default chunking params')
    }

    // Dev-only override: chunk min duration (0 = use server config)
    try {
      const overrideMs = await window.electronAPI.getChunkMinDuration()
      if (overrideMs > 0) {
        chunkMinMsRef.current = overrideMs
        console.log(`[audio] Dev override: chunkMinMs=${overrideMs}ms`)
      }
    } catch {
      // Ignore — not critical
    }

    // Fixed max recording duration (no quota in local/BYO-key mode)
    setMaxDurationSeconds(Math.round(DEFAULT_MAX_DURATION_MS / 1000))

    // Sarvam has a 30s limit — force chunked mode and cap hard chunk at 28s
    try {
      const sttProvider = await window.electronAPI.getSTTProvider()
      if (sttProvider === 'sarvam' && frozenModeRef.current === 'dictation') {
        chunkedModeEnabledRef.current = true
        hardChunkCapMsRef.current = Math.min(hardChunkCapMsRef.current, 28_000)
        console.log(`[audio] Sarvam detected — forced chunked mode, hardCap=${hardChunkCapMsRef.current}ms`)
      }
    } catch {
      // Ignore — not critical
    }

    console.log('[audio] Starting NEW recording, mode:', frozenModeRef.current)

    // Source resolution ORDER (the stale-cooldown lesson: a verifiably-flowing
    // pipe was benched for 60s while dictations went to the far-away Mac):
    //   1. warm stream HOT  → use it. Proof of life beats any cooldown.
    //   2. warm CONNECTING  → Mac for THIS dictation. Never gamble on a pipe
    //      that isn't flowing yet; the next dictation lands on the phone.
    //   3. zombie cooldown  → Mac (blind cold retries of a corpse stay benched).
    //   4. cold acquire + pipe gate (pre-session dictations).
    let requestedDeviceId = deviceId
    if (requestedDeviceId && !warmIsHot() && warmState() === 'connecting') {
      console.log('[audio:mic] warm session still connecting — this dictation captures on the Mac mic')
      announceSource('mac', 'iPhone still connecting — this dictation uses the MacBook mic')
      requestedDeviceId = undefined
    } else if (requestedDeviceId && !warmIsHot() && Date.now() < phoneZombieUntil) {
      console.log('[audio:mic] phone in zombie cooldown — capturing on the Mac mic')
      announceSource('mac')
      requestedDeviceId = undefined
    }

    // Phone path: Chromium's processing chain OFF. The iPhone already applied
    // its own call-tuned DSP before transmitting; a second noise-suppression/
    // AGC/echo-cancellation pass on pre-cleaned audio only smears speech
    // (double-cleaning — confirmed pipeline asymmetry vs the Mac path, where
    // Chromium is the ONLY cleaner and stays on).
    const constraints: MediaStreamConstraints = {
      audio: requestedDeviceId
        ? { deviceId: { exact: requestedDeviceId }, sampleRate: 16000, echoCancellation: false, noiseSuppression: false, autoGainControl: false }
        : { sampleRate: 16000 }
    }

    // Wait for the PREVIOUS recording's AudioContext to finish closing before we
    // re-acquire the mic. Acquiring while the old context/device is still tearing
    // down is what corrupted every recording after the first (undecodable audio →
    // STT 400 → offline fallback). A small settle covers the device-release lag
    // after the context reports closed.
    if (teardownRef.current) {
      try { await teardownRef.current } catch { /* best-effort */ }
      await new Promise((r) => setTimeout(r, 40))
    }

    // Acquire the mic. When a specific device was requested (the iPhone
    // Continuity mic path) and it vanished between resolution and capture —
    // phone walked away, user hit Disconnect on it — retry ONCE with the
    // system default. The design guarantee is a SILENT fallback to the Mac
    // mic: a missing phone must never surface an error or kill a dictation.
    let stream: MediaStream | null = null
    let usedWarm = false
    phoneSourceRef.current = false
    const tAcquire = Date.now()
    // SESSION-MODE KEEP-WARM: if the user connected their iPhone (glyph =
    // connect, pipe held open, samples flowing-and-discarded), key-down just
    // flips discard→keep — hand the ALREADY WARM stream to the recorder.
    // Zero warm-up, first word intact. A warm-but-silent pipe (link died
    // under us) is a zombie: disconnect it, cooldown, capture on the Mac.
    if (requestedDeviceId) {
      const warm = getWarmStream()
      if (warm) {
        if (warmIsHot()) {
          stream = warm
          usedWarm = true
          phoneSourceRef.current = true
          setWarmBusy(true) // a user-toggle disconnect defers until this recording ends
          announceSource('iphone')
          console.log('[audio:mic] using WARM iPhone stream — no acquisition, no gate')
        } else {
          console.warn('[audio:mic] warm iPhone stream is STALE at key-down — zombie, failing over to the Mac mic')
          announceSource('mac', 'iPhone mic lost — switched to MacBook')
          disconnectWarmMic('stale-at-keydown')
          phoneZombieUntil = Date.now() + PHONE_ZOMBIE_COOLDOWN_MS
          try { window.dispatchEvent(new CustomEvent('unmute:phone-mic-zombie')) } catch { /* best-effort */ }
          requestedDeviceId = undefined
        }
      }
    }
    if (!stream) {
      try {
        stream = await navigator.mediaDevices.getUserMedia(constraints)
        phoneSourceRef.current = !!requestedDeviceId // requested device delivered
      } catch (err) {
        if (!requestedDeviceId) throw err
        console.log('[audio] Requested device unavailable, falling back to system default mic:', err)
        stream = await navigator.mediaDevices.getUserMedia({ audio: { sampleRate: 16000 } })
      }
    }
    // Head-gap calibration: how long the mic took to actually open. The
    // Continuity path is the interesting number — words spoken before this
    // resolved never existed. (Mac mic: ~50-150ms; phone: measured in field.)
    console.log(`[audio:mic] acquired in ${Date.now() - tAcquire}ms, source=${phoneSourceRef.current ? 'iphone' : 'default'}`)
    announceSource(phoneSourceRef.current ? 'iphone' : 'mac')
    streamRef.current = stream
    {
      const tel = telemetryRef.current
      const track = stream.getAudioTracks()[0]
      if (tel && track) {
        tel.source = phoneSourceRef.current ? 'iphone' : 'default'
        tel.marks.acquired = Date.now() - tel.t0
        // THE ground truth the guessing ends on: what the track is actually
        // running at (sampleRate honors/ignores our 16k request) and which
        // processing Chromium REALLY applied (the double-DSP question).
        tlog('track-settings', {
          source: tel.source,
          label: track.label,
          readyState: track.readyState,
          muted: track.muted,
          settings: track.getSettings(),
          capabilities: typeof track.getCapabilities === 'function' ? track.getCapabilities() : 'n/a',
        })
        for (const ev of ['mute', 'unmute', 'ended'] as const) {
          track.addEventListener(ev, () => {
            const at = Date.now() - tel.t0
            tel.trackEvents.push(`${ev}@${at}ms`)
            tlog('track-event', { source: tel.source, event: ev, atMs: at, readyState: track.readyState })
          })
        }
      }
    }
    // Tripwire for the corrupt-webm class: a capture track dying MID-RECORDING
    // (phone disconnected/walked away) is the suspect for undecodable output.
    // Log it loudly so field failures carry their cause.
    stream.getAudioTracks()[0]?.addEventListener('ended', () => {
      console.warn('[audio:mic] capture track ENDED mid-recording (device vanished) — this dictation may be damaged')
    })

    // Set up audio context for waveform analysis (rebuilt on zombie failover)
    let audioContext = new AudioContext()
    tlog('audio-context', { sampleRate: audioContext.sampleRate })
    audioContextRef.current = audioContext
    let analyser = audioContext.createAnalyser()
    analyser.fftSize = 128
    audioContext.createMediaStreamSource(stream).connect(analyser)
    analyserRef.current = analyser
    setAnalyserNode(analyser)

    // Set up MediaRecorder. We tried lowering audioBitsPerSecond to 32_000
    // to shrink uploads but Groq's Whisper endpoint rejected the resulting
    // low-bitrate opus stream with HTTP 400. Reverted to the browser default
    // until we find a safe lower bound.
    const onRecorderData = (e: BlobEvent) => {
      if (e.data.size > 0) {
        const tel = telemetryRef.current
        if (tel) {
          if (!tel.marks.firstChunk) tel.marks.firstChunk = Date.now() - tel.t0
          tel.chunks++
          tel.chunkBytes += e.data.size
        }
        chunksRef.current.push(e.data)
        // If chunked mode, also push to current macro chunk buffer
        if (chunkedModeEnabledRef.current) {
          macroBlobsRef.current.push(e.data)
        }
        // Paywall: forward bytes to the managed-cloud streaming POST as they arrive
        e.data.arrayBuffer().then((buf) => {
          window.electronAPI?.paywallStreamChunk?.(buf)
        }).catch(() => { /* best-effort */ })
      }
    }
    // Capture begins AT KEY-DOWN, never before: the key-press is the consent
    // signal (same contract as screenshots). Pre-roll was tried and removed —
    // it polluted rapid-fire dictations with the previous utterance's tail.
    let mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' })
    mediaRecorderRef.current = mediaRecorder
    mediaRecorder.ondataavailable = onRecorderData

    // ── PIPE-LIVENESS GATE (iPhone only) ──────────────────────────────────
    // getUserMedia resolves in ~170ms on the Continuity mic, but the WIRELESS
    // PIPELINE behind it starts delivering samples 0.5-2s later (cold link).
    // Recording that dead air produced files with 1-2s of leading silence +
    // a clipped first word — the double trigger for Whisper's documented
    // silence-hallucination (invented opening sentences). So: do not START
    // the recorder until samples actually flow. A dead pipe yields EXACT
    // digital zeros; any live mic — even in a silent room — has a nonzero
    // noise floor. The recorder then starts on flowing audio: no leading
    // silence in the file, and the start-click (played after this resolves)
    // finally tells the truth. Capped so a pathological stream can never
    // block a dictation. Mac path: skipped entirely (pipe is live at open).
    if (phoneSourceRef.current && !usedWarm) {
      const probe = new Float32Array(analyser.fftSize)
      const tGate = Date.now()
      let live = false
      // 10ms cadence: the analyser window is ~3ms of audio, so detection
      // reacts within ~10ms of the first real sample. Combined with the
      // recorder being CREATED before this gate (below runs start() only),
      // the worst-case clip on a zero-gated stream that opens on the user's
      // own voice is a few tens of ms of the first phoneme — inaudible to
      // STT — instead of the first word.
      while (Date.now() - tGate < 3000) {
        analyser.getFloatTimeDomainData(probe)
        if (probe.some((v) => v !== 0)) { live = true; break }
        await new Promise((r) => setTimeout(r, 10))
      }
      if (live) {
        console.log(`[audio:mic] phone pipe LIVE after ${Date.now() - tGate}ms`)
        if (telemetryRef.current) telemetryRef.current.marks.pipeLive = Date.now() - telemetryRef.current.t0
      } else {
        if (telemetryRef.current) telemetryRef.current.marks.zombieVerdict = Date.now() - telemetryRef.current.t0
        // ZOMBIE VERDICT: acquirable device, zero samples in 3s. The link is
        // dead (macOS kept the corpse enumerated). Recording it would capture
        // silence and eat the user's words — THE thing that must never
        // happen. Fail over to the Mac mic RIGHT NOW: the recorder hasn't
        // started, so the dictation continues seamlessly on the lesser mic.
        console.warn(`[audio:mic] phone pipe DEAD after ${Date.now() - tGate}ms — zombie device, failing over to the Mac mic`)
        announceSource('mac', 'iPhone mic lost — switched to MacBook')
        phoneZombieUntil = Date.now() + PHONE_ZOMBIE_COOLDOWN_MS
        try { window.dispatchEvent(new CustomEvent('unmute:phone-mic-zombie')) } catch { /* chip refresh is best-effort */ }
        // Tear down the zombie wiring…
        stream.getTracks().forEach((t) => t.stop())
        try { await audioContext.close() } catch { /* already closing */ }
        // …and rebuild everything on the system default.
        stream = await navigator.mediaDevices.getUserMedia({ audio: { sampleRate: 16000 } })
        streamRef.current = stream
        phoneSourceRef.current = false // it's a Mac-mic recording now (no tail grace)
        audioContext = new AudioContext()
        audioContextRef.current = audioContext
        analyser = audioContext.createAnalyser()
        analyser.fftSize = 128
        audioContext.createMediaStreamSource(stream).connect(analyser)
        analyserRef.current = analyser
        setAnalyserNode(analyser)
        mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' })
        mediaRecorderRef.current = mediaRecorder
        mediaRecorder.ondataavailable = onRecorderData
        console.log('[audio:mic] failover complete — capturing on the Mac mic')
      }
    }

    mediaRecorder.start(250)
    setCaptureInFlight(true)
    if (telemetryRef.current) telemetryRef.current.marks.recorderStart = Date.now() - telemetryRef.current.t0
    startTimeRef.current = Date.now()
    chunkStartTimeRef.current = Date.now()
    setIsRecording(true)

    // Paywall: open a streaming POST for chunk 0. Per-macro-chunk streams
    // (chunk 1, 2, ...) get opened at VAD boundaries inside emitChunk so
    // long dictations don't fall back to upload-after-stop for chunks > 0.
    window.electronAPI?.paywallStreamOpen?.({
      flowType: frozenModeRef.current === 'instruction' ? 'instruction' : 'dictation',
      chunkIndex: 0,
    })

    // Always run the RMS monitor for the whole recording so heardSpeech is
    // tracked even for short, non-chunked dictations. Chunk-SPLITTING stays
    // gated behind vadActivatedRef, so this never splits short clips.
    startVADMonitoring()

    // If chunked mode, schedule VAD activation after chunkMinMs
    if (chunkedModeEnabledRef.current) {
      const minMs = chunkMinMsRef.current
      console.log(`[audio:vad] Chunked mode active — VAD will activate after ${minMs}ms`)
      vadDelayTimerRef.current = setTimeout(() => {
        vadDelayTimerRef.current = null
        vadActivatedRef.current = true
        console.log('[audio:vad] VAD monitoring activated')
        startVADMonitoring()
      }, minMs)
    }

    // Auto-stop at max duration
    maxTimerRef.current = setTimeout(() => {
      stopRecording()
    }, DEFAULT_MAX_DURATION_MS)
  }, [flushRecorder, startVADMonitoring])

  const stopRecording = useCallback(async () => {
    const recorder = mediaRecorderRef.current

    // ─── End-of-recording race fix ──────────────────────────────────
    // We used to call paywallStreamClose() immediately here, BEFORE
    // MediaRecorder flushed its final encoder buffer. That signaled
    // "we're done" upstream while the trailing 50-200ms of audio (the
    // opus chunk in flight at the moment of stop) was still sitting in
    // the encoder. The cloud worker finalized Whisper STT with partial
    // audio and the trailing word(s) were dropped on the floor. Net
    // effect: ~50% of dictations had the last word truncated, depending
    // on whether the user released Fn just before or just after the
    // encoder's chunk boundary (~100ms grid).
    //
    // Fix: defer paywallStreamClose() to AFTER recorder.onstop fires
    // (below). onstop is gated on the last ondataavailable, so by the
    // time it runs the trailing buffer is in our hands and either has
    // been streamed already or will be sent via sendAudioFinalChunk.
    // The cloud worker only sees "stream closed" once we actually have
    // every byte, so it can't return early with partial audio.
    //
    // Cost: ~50-150ms extra wait at stop time (encoder flush latency).
    // Real but acceptable for never losing trailing words; the upcoming
    // silence-trim pass will more than recover this by stripping the
    // dead air at the end of recordings.

    if (!recorder || recorder.state === 'inactive') {
      // Already stopped (might have been flushed by startRecording).
      // Flush path already closed the stream; nothing to do here.
      if (isEmittingChunkRef.current) {
        // THE COLLISION (13 hits in one session log): the recorder is mid-swap
        // inside emitChunk. Bailing here closed the session with NO audio
        // delivery while the cut chunk was already transcribed upstream —
        // "history has it, nothing pasted, said it didn't catch it". Flag the
        // stop; emitChunk delivers the FINAL signal instead of restarting.
        console.log('[audio] stop during VAD chunk-cut — emitChunk will finalize')
        stopDuringEmitRef.current = true
        setIsRecording(false)
        return
      }
      console.log('[audio] stopRecording called but recorder already inactive')
      window.electronAPI?.paywallStreamClose?.()
      cleanupStream()
      setIsRecording(false)
      return
    }

    // Check if audio was already sent (by startRecording's flush).
    // Same as above — flush path owns the stream close.
    if (audioSentRef.current) {
      console.log('[audio] stopRecording: audio already sent by flush, cleaning up')
      window.electronAPI?.paywallStreamClose?.()
      recorder.onstop = null
      try { recorder.stop() } catch { /* ignore */ }
      cleanupStream()
      setIsRecording(false)
      return
    }

    audioSentRef.current = true
    const duration = Date.now() - startTimeRef.current
    const mode = frozenModeRef.current

    // Stop VAD monitoring
    if (vadIntervalRef.current) {
      clearInterval(vadIntervalRef.current)
      vadIntervalRef.current = null
    }
    if (vadDelayTimerRef.current) {
      clearTimeout(vadDelayTimerRef.current)
      vadDelayTimerRef.current = null
    }

    // TAIL GRACE (iPhone only): the phone's audio rides a buffered wireless
    // pipeline with 100-300ms of in-flight latency. Stopping at key-lift
    // guillotines the final syllables still in transit. Keep recording for a
    // beat so they land; the Mac-mic path (near-zero latency) is untouched.
    if (phoneSourceRef.current) {
      await new Promise((r) => setTimeout(r, 300))
    }

    return new Promise<void>((resolve) => {
      recorder.onstop = async () => {
        setIsRecording(false)

        // Discard if too short, or silent with no chunks emitted (no speech) — no STT call.
        // Judged on HELD time (see requestTimeRef) so the phone gate can't
        // shrink a real utterance below the threshold.
        const wasChunked = chunkedModeEnabledRef.current && chunkIndexRef.current > 0
        const heldMs = Date.now() - requestTimeRef.current
        if (Math.max(duration, heldMs) < MIN_DURATION_MS || (!heardSpeechRef.current && !wasChunked)) {
          console.log('[audio] Discarding (short/silent). Duration:', duration, 'heardSpeech:', heardSpeechRef.current)
          window.electronAPI.sendAudioDiscarded(mode, frozenSessionIdRef.current)
          // Close stream too — there's no audio coming.
          window.electronAPI?.paywallStreamClose?.()
          cleanupStream()
          resolve()
          return
        }

        // Check if chunks were emitted during recording (chunked mode)
        if (chunkedModeEnabledRef.current && chunkIndexRef.current > 0) {
          // Send remaining micro-chunks as final chunk
          const macroBlobs = [...macroBlobsRef.current]
          macroBlobsRef.current = []

          const totalChunks = chunkIndexRef.current + (macroBlobs.length > 0 ? 1 : 0)

          if (macroBlobs.length > 0) {
            const blob = new Blob(await trimToWebmHeader(macroBlobs), { type: 'audio/webm' })
            const buffer = await blob.arrayBuffer()
            console.log(`[audio] Sending FINAL chunk ${chunkIndexRef.current}/${totalChunks}, size: ${buffer.byteLength}, duration: ${duration}ms`)
            window.electronAPI.sendAudioFinalChunk(buffer, chunkIndexRef.current, totalChunks, duration, mode, frozenSessionIdRef.current)
          } else {
            // No remaining data — all audio was already sent in previous chunks
            console.log(`[audio] No remaining data — all ${chunkIndexRef.current} chunks already sent`)
            // Still send final signal so sessionManager knows total count
            const emptyBuffer = new ArrayBuffer(0)
            window.electronAPI.sendAudioFinalChunk(emptyBuffer, chunkIndexRef.current, chunkIndexRef.current, duration, mode, frozenSessionIdRef.current)
          }

          // Close stream AFTER final chunk is sent so the worker has every byte.
          window.electronAPI?.paywallStreamClose?.()
          cleanupStream()
          resolve()
          return
        }

        // Non-chunked path — send full audio as single buffer (original behavior)
        const blob = new Blob(await trimToWebmHeader(chunksRef.current), { type: 'audio/webm' })
        const buffer = await blob.arrayBuffer()
        console.log('[audio] Sending audio to main process, mode:', mode, 'size:', buffer.byteLength, 'duration:', duration)
        emitCaptureSummary('stop', buffer.byteLength, duration)
        window.electronAPI.sendAudioReady(buffer, duration, mode, frozenSessionIdRef.current)

        // Close stream AFTER full audio is delivered (no-op if no stream was open).
        window.electronAPI?.paywallStreamClose?.()
        cleanupStream()
        resolve()
      }

      recorder.stop()
    })
  }, [cleanupStream])

  return { isRecording, analyserNode, maxDurationSeconds, noisyEnvironment, tooQuiet, startRecording, stopRecording }
}
