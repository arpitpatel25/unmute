import { useState, useRef, useCallback } from 'react'

type RecordingMode = 'dictation' | 'instruction'

interface UseAudioRecorderReturn {
  isRecording: boolean
  analyserNode: AnalyserNode | null
  maxDurationSeconds: number
  /** True once THIS recording looks like a noisy environment (high noise floor,
   *  collapsed speech-to-noise ratio). Purely a signal for the pill's gentle
   *  "lean in" hint — detection never touches the audio path. */
  noisyEnvironment: boolean
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

export function useAudioRecorder(): UseAudioRecorderReturn {
  const [isRecording, setIsRecording] = useState(false)
  const [analyserNode, setAnalyserNode] = useState<AnalyserNode | null>(null)
  const [maxDurationSeconds, setMaxDurationSeconds] = useState(300)
  const [noisyEnvironment, setNoisyEnvironment] = useState(false)

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
  // Whether any speech (RMS above the silence threshold) was heard this recording.
  // If false on stop, we skip STT entirely — no wasted API call.
  const heardSpeechRef = useRef<boolean>(false)

  // ─── Noisy-environment refs (per recording) ───
  const rmsFramesRef = useRef<number[]>([])
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
      streamRef.current.getTracks().forEach((t) => t.stop())
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
  const emitChunk = useCallback(async (reason: 'silence' | 'hard-cap'): Promise<void> => {
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

    const blob = new Blob(macroBlobs, { type: 'audio/webm' })
    const buffer = await blob.arrayBuffer()

    console.log(`[audio:vad] ${reason === 'silence' ? 'Silence detected' : 'Hard cap'}, cutting chunk ${chunkIdx} at ${elapsed}ms (${buffer.byteLength} bytes)`)

    // Send chunk to main process
    window.electronAPI.sendAudioChunk(buffer, chunkIdx, mode, frozenSessionIdRef.current)

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
          const speech = sorted[Math.floor(sorted.length * 0.9)]  // the voice
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

      // Check hard cap first
      if (chunkElapsed >= hardChunkCapMsRef.current) {
        console.log(`[audio:vad] Hard cap at ${chunkElapsed}ms, force-cutting chunk ${chunkIndexRef.current}`)
        emitChunk('hard-cap')
        return
      }

      // Only look for silence after minimum chunk duration
      if (chunkElapsed < chunkMinMsRef.current) return

      if (rms < silenceThresholdRef.current) {
        if (silenceStartRef.current === null) {
          silenceStartRef.current = Date.now()
        } else if (Date.now() - silenceStartRef.current >= silenceDurationMsRef.current) {
          // Sustained silence — cut chunk
          emitChunk('silence')
        }
      } else {
        // Audio detected — reset silence timer
        silenceStartRef.current = null
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
        const blob = new Blob(macroBlobs, { type: 'audio/webm' })
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

    // Discard if too short, empty, or silent (no speech) — no STT call
    if (duration < MIN_DURATION_MS || chunks.length === 0 || !heardSpeechRef.current) {
      console.log('[audio] Discarding (short/empty/silent). Duration:', duration, 'heardSpeech:', heardSpeechRef.current)
      window.electronAPI.sendAudioDiscarded(frozenModeRef.current, frozenSessionIdRef.current)
      return false
    }

    // Assemble and send
    const blob = new Blob(chunks, { type: 'audio/webm' })
    const buffer = await blob.arrayBuffer()
    console.log('[audio] Flushed audio, mode:', mode, 'size:', buffer.byteLength, 'duration:', duration)
    window.electronAPI.sendAudioReady(buffer, duration, mode, frozenSessionIdRef.current)
    return true
  }, [cleanupStream])

  const startRecording = useCallback(async (deviceId?: string, mode?: RecordingMode, sessionId?: string) => {
    // If there's an active recorder, flush it first (sends its audio with correct
    // mode AND the previous session's frozen ID — set below only after the flush).
    const existingRecorder = mediaRecorderRef.current
    if (existingRecorder && existingRecorder.state !== 'inactive') {
      console.log('[audio] Flushing previous recording before starting new one (mode was:', frozenModeRef.current, ')')
      await flushRecorder()
    }

    // Reset state for new recording
    frozenModeRef.current = mode || 'dictation'
    frozenSessionIdRef.current = sessionId
    audioSentRef.current = false
    heardSpeechRef.current = false
    chunksRef.current = []
    rmsFramesRef.current = []
    noisyFrameCountRef.current = 0
    noisyFlaggedRef.current = false
    noisyEverFlaggedRef.current = false
    noisyQuietEvalsRef.current = 0
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

    const constraints: MediaStreamConstraints = {
      audio: deviceId
        ? { deviceId: { exact: deviceId }, sampleRate: 16000 }
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

    const stream = await navigator.mediaDevices.getUserMedia(constraints)
    streamRef.current = stream

    // Set up audio context for waveform analysis
    const audioContext = new AudioContext()
    audioContextRef.current = audioContext
    const source = audioContext.createMediaStreamSource(stream)
    const analyser = audioContext.createAnalyser()
    analyser.fftSize = 128
    source.connect(analyser)
    analyserRef.current = analyser
    setAnalyserNode(analyser)

    // Set up MediaRecorder. We tried lowering audioBitsPerSecond to 32_000
    // to shrink uploads but Groq's Whisper endpoint rejected the resulting
    // low-bitrate opus stream with HTTP 400. Reverted to the browser default
    // until we find a safe lower bound.
    const mediaRecorder = new MediaRecorder(stream, {
      mimeType: 'audio/webm;codecs=opus',
    })
    mediaRecorderRef.current = mediaRecorder

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) {
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

    mediaRecorder.start(250) // Collect data every 250ms
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

    return new Promise<void>((resolve) => {
      recorder.onstop = async () => {
        setIsRecording(false)

        // Discard if too short, or silent with no chunks emitted (no speech) — no STT call
        const wasChunked = chunkedModeEnabledRef.current && chunkIndexRef.current > 0
        if (duration < MIN_DURATION_MS || (!heardSpeechRef.current && !wasChunked)) {
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
            const blob = new Blob(macroBlobs, { type: 'audio/webm' })
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
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' })
        const buffer = await blob.arrayBuffer()
        console.log('[audio] Sending audio to main process, mode:', mode, 'size:', buffer.byteLength, 'duration:', duration)
        window.electronAPI.sendAudioReady(buffer, duration, mode, frozenSessionIdRef.current)

        // Close stream AFTER full audio is delivered (no-op if no stream was open).
        window.electronAPI?.paywallStreamClose?.()
        cleanupStream()
        resolve()
      }

      recorder.stop()
    })
  }, [cleanupStream])

  return { isRecording, analyserNode, maxDurationSeconds, noisyEnvironment, startRecording, stopRecording }
}
