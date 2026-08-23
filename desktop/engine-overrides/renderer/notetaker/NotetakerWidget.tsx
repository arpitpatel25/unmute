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
  notetakerOnCaptureActive?: (cb: (active: boolean) => void) => () => void
  notetakerMicChunk?: (samples: ArrayBuffer, sampleRate: number, timestampMs: number) => void
  notetakerWidgetLog?: (level: 'debug' | 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => void
}
function api(): API {
  return (window as unknown as { electronAPI?: API }).electronAPI ?? {}
}

/** Relays into main's durable notetaker log file (see notetakerInit.ts's
 *  'notetaker:widget-log' handler) AND keeps the normal console output —
 *  this window's devtools console is the fastest signal while iterating,
 *  the log file is what survives after the window closes. */
function wlog(level: 'debug' | 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>): void {
  const line = `[notetaker-widget] ${message}`
  if (level === 'error') console.error(line, fields)
  else if (level === 'warn') console.warn(line, fields)
  else console.log(line, fields)
  api().notetakerWidgetLog?.(level, message, fields)
}

// ── Mic → main-process transcription tap ─────────────────────────────────
//
// The system-audio side of a meeting is captured natively in main (the Core
// Audio process tap). The MIC side has to come from a renderer, because
// getUserMedia only exists there — and this widget is the one window that
// already holds an open mic stream for exactly the capture window, with a
// lifecycle that is already correct (acquired on `notetaker:capture-active`
// true, fully released on false). So the transcription tap rides on THAT
// stream and THAT AudioContext rather than opening a second, independent
// getUserMedia: a third concurrent mic consumer is precisely the risk the
// branch review flagged, and this avoids adding one.
//
// Raw Float32 PCM goes to main over `notetaker:mic-chunk`, where it is handed
// to NotetakerSession.feedMicChunk() (a no-op if the session isn't active,
// so a late in-flight chunk can never leak into the next meeting).

/** ~85ms of audio at 48kHz — roughly 12 IPC messages a second, small enough
 *  that a chunk boundary costs nothing and large enough not to spam IPC with
 *  the worklet's native 128-frame quanta. */
const MIC_CHUNK_SAMPLES = 4096

/** The AudioWorklet processor, as source text. There is no AudioWorklet
 *  infrastructure anywhere in this renderer to follow (nothing in the tree
 *  calls addModule() and there are no .worklet.* files), and addModule() takes
 *  a URL, not a function — so the module is loaded from a Blob URL. That keeps
 *  the whole mechanism inside this one file: no new build-config entry point,
 *  no asset that has to resolve differently in dev (localhost) vs a packaged
 *  app (file://). Batching happens in here so the audio thread posts ~12
 *  messages/sec instead of ~375. */
const MIC_WORKLET_SOURCE = `
class NotetakerMicProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const opts = (options && options.processorOptions) || {}
    this._size = opts.chunkSamples > 0 ? opts.chunkSamples : 4096
    this._buf = new Float32Array(this._size)
    this._n = 0
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (channel) {
      for (let i = 0; i < channel.length; i++) {
        this._buf[this._n++] = channel[i]
        if (this._n === this._size) {
          const out = new Float32Array(this._buf)
          this.port.postMessage(out.buffer, [out.buffer])
          this._n = 0
        }
      }
    }
    return true
  }
}
registerProcessor('notetaker-mic', NotetakerMicProcessor)
`

/**
 * Attaches a PCM tap to an ALREADY-OPEN capture graph and streams its samples
 * to the main process. Returns a disposer, or null if no tap could be
 * attached (in which case the meeting simply has no mic channel — the widget,
 * the waveform, and the system-audio side all carry on unaffected).
 *
 * AudioWorkletNode is the primary path (ScriptProcessorNode is deprecated and
 * runs its callback on the main thread); the ScriptProcessorNode fallback
 * exists only for the case where addModule() is refused, since losing the
 * user's own half of every meeting is a much worse outcome than using a
 * deprecated-but-working node.
 */
async function attachMicChunkTap(
  ctx: AudioContext,
  source: MediaStreamAudioSourceNode,
): Promise<(() => void) | null> {
  const chunkDurationMs = Math.round((MIC_CHUNK_SAMPLES / ctx.sampleRate) * 1000)
  const send = (samples: ArrayBuffer) => {
    // Timestamp the START of the chunk, not the moment it finished filling —
    // the main process aligns the two channels' transcripts by first
    // timestamp, so a systematic one-chunk lag would skew the merge.
    api().notetakerMicChunk?.(samples, ctx.sampleRate, Date.now() - chunkDurationMs)
  }

  // A node only actually runs when the graph pulls it, so the tap needs a
  // path to the destination. Muted gain, not a direct connect: the tap's own
  // output is silence, but routing it through an explicit zero-gain node means
  // nothing can ever make the meeting's mic audible back through the speakers.
  const sink = ctx.createGain()
  sink.gain.value = 0
  sink.connect(ctx.destination)

  try {
    const url = URL.createObjectURL(new Blob([MIC_WORKLET_SOURCE], { type: 'application/javascript' }))
    try {
      await ctx.audioWorklet.addModule(url)
    } finally {
      URL.revokeObjectURL(url)
    }
    const node = new AudioWorkletNode(ctx, 'notetaker-mic', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      processorOptions: { chunkSamples: MIC_CHUNK_SAMPLES },
    })
    node.port.onmessage = (e: MessageEvent) => send(e.data as ArrayBuffer)
    source.connect(node)
    node.connect(sink)
    wlog('info', 'mic tap attached via AudioWorklet', { chunkDurationMs, contextSampleRate: ctx.sampleRate })
    return () => {
      node.port.onmessage = null
      try { node.disconnect() } catch { /* graph already torn down */ }
      try { source.disconnect(node) } catch { /* already disconnected */ }
      try { sink.disconnect() } catch { /* already disconnected */ }
      wlog('debug', 'mic tap (AudioWorklet) disposed')
    }
  } catch (err) {
    wlog('warn', 'AudioWorklet mic tap unavailable, falling back to ScriptProcessor', { error: err instanceof Error ? err.message : String(err) })
  }

  try {
    const processor = ctx.createScriptProcessor(MIC_CHUNK_SAMPLES, 1, 1)
    processor.onaudioprocess = (e: AudioProcessingEvent) => {
      // getChannelData hands back a view the engine reuses — copy before it
      // crosses the IPC boundary.
      send(new Float32Array(e.inputBuffer.getChannelData(0)).buffer)
    }
    source.connect(processor)
    processor.connect(sink)
    wlog('info', 'mic tap attached via ScriptProcessorNode (AudioWorklet fallback)', { chunkDurationMs, contextSampleRate: ctx.sampleRate })
    return () => {
      processor.onaudioprocess = null
      try { processor.disconnect() } catch { /* already disconnected */ }
      try { source.disconnect(processor) } catch { /* already disconnected */ }
      try { sink.disconnect() } catch { /* already disconnected */ }
      wlog('debug', 'mic tap (ScriptProcessor) disposed')
    }
  } catch (err) {
    wlog('error', 'no mic tap could be attached — this meeting will have no "You" channel', { error: err instanceof Error ? err.message : String(err) })
    try { sink.disconnect() } catch { /* nothing to undo */ }
    return null
  }
}

/**
 * Presentational piece: a circle with either a live waveform or a Cancel
 * button, depending on `confirmingCancel`. Pure prop-driven (no IPC, no
 * capture) so it's easy to reason about and reuse — mirrors Widget.tsx's
 * split from WidgetApp.tsx.
 */
export function NotetakerWidget({
  analyser,
  sessionId = 0,
  onCancelConfirmed,
}: {
  analyser: AnalyserNode | null
  /** Bumped by the route on every new capture session. The widget WINDOW is
   *  reused across sessions (hidden, never closed), so this component never
   *  remounts — without this, a "Cancel" the user surfaced but never
   *  confirmed in one session would still be on screen when the next session
   *  opened the widget. */
  sessionId?: number
  onCancelConfirmed: () => void
}) {
  const [levels, setLevels] = useState<number[]>(() => new Array(BAR_COUNT).fill(0.1))
  const [confirmingCancel, setConfirmingCancel] = useState(false)
  const rafRef = useRef<number | undefined>(undefined)

  // A new session always starts on the waveform face, never on a stale
  // Cancel button (or a frozen last frame of bars) left over from the last one.
  useEffect(() => {
    setConfirmingCancel(false)
    setLevels(new Array(BAR_COUNT).fill(0.1))
  }, [sessionId])

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
 * the shared preload bridge (electron/remote-preload.ts). Feeding this window
 * a REAL shared analyser tied to the actual meeting audio rather than a
 * locally-opened mic stream is still a composition-root concern — this widget
 * degrades gracefully (flat/no bars) if getUserMedia is unavailable or denied.
 *
 * MIC LIFETIME IS DRIVEN BY IPC, NOT BY MOUNT. The widget WINDOW is created
 * once and thereafter only shown/hidden (see notetakerWidget.ts) with
 * `backgroundThrottling: false` + `paintWhenInitiallyHidden: true`, so this
 * component NEVER unmounts and a mount-time getUserMedia would never be
 * released: after one note-taking session the app would hold a second live
 * mic capture for the rest of its run — macOS mic indicator stuck on,
 * Bluetooth pinned to the low-quality HFP codec, dictation quality degraded.
 * So the capture is gated on `notetaker:capture-active`, which main sends
 * true from NotetakerSession.start() and false from its stop() (via the
 * show/hide hooks). Every acquired resource — the MediaStream's tracks, the
 * AudioContext, and (through `analyser` going back to null) the waveform's
 * requestAnimationFrame loop — is released the moment it goes false.
 *
 * This capture is ALSO the meeting's mic channel: attachMicChunkTap() hangs a
 * PCM tap off the same source node and streams it to the main process (see
 * that function's comment for why it reuses this stream instead of opening a
 * second one). The tap is torn down first in the cleanup below, so it lives
 * strictly inside the same window as the stream it reads.
 */
export function NotetakerWidgetRoute() {
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null)
  const [captureActive, setCaptureActive] = useState(false)
  /** Increments on every false→true transition: one "session" of the widget. */
  const [sessionId, setSessionId] = useState(0)
  // Read in the IPC handler to detect the transition. A ref, not the state
  // value: the handler is registered once (empty deps) so it would close over
  // a stale `captureActive`, and deriving it inside a setState updater would
  // double-count under React's double-invoked updaters in StrictMode.
  const captureActiveRef = useRef(false)

  useEffect(() => {
    const unsubscribe = api().notetakerOnCaptureActive?.((active) => {
      wlog('debug', 'capture-active signal received from main', { active, wasActive: captureActiveRef.current })
      if (active && !captureActiveRef.current) setSessionId((n) => n + 1)
      captureActiveRef.current = active
      setCaptureActive(active)
    })
    return () => unsubscribe?.()
  }, [])

  useEffect(() => {
    if (!captureActive) return
    let cancelled = false
    let stream: MediaStream | null = null
    let audioContext: AudioContext | null = null
    let disposeMicTap: (() => void) | null = null

    wlog('info', 'requesting mic capture for a new session')
    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((s) => {
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop())
          return
        }
        stream = s
        const track = s.getAudioTracks()[0]
        wlog('info', 'mic capture granted', {
          // The device label — this IS "what was the source of the mic
          // audio" for the mic half of the meeting. Empty string is a real,
          // observed browser value when the permission was granted but the
          // OS declines to disclose the device name.
          deviceLabel: track?.label || '<no label>',
          deviceId: track?.getSettings?.().deviceId,
        })
        const ctx = new AudioContext()
        audioContext = ctx
        const node = ctx.createAnalyser()
        node.fftSize = 128
        const source = ctx.createMediaStreamSource(s)
        source.connect(node)
        setAnalyser(node)

        // The transcription tap hangs off the SAME source node as the
        // waveform's analyser. Attached in its own promise chain so that
        // loading the worklet can never delay (or fail) the waveform, and so
        // this .then() keeps the exact synchronous shape the mic-lifecycle fix
        // established.
        void attachMicChunkTap(ctx, source)
          .then((dispose) => {
            // Capture may have stopped while addModule() was loading — the
            // cleanup below has already run and can't see this disposer, so
            // undo it here instead. (Closing the context alone would stop the
            // audio, but leaving the node connected to a closed graph is
            // exactly the kind of thing that outlives a session.)
            if (cancelled) dispose?.()
            else disposeMicTap = dispose
          })
          .catch(() => { /* attachMicChunkTap already logs; never break the widget */ })
      })
      .catch((err) => {
        // No mic access in this window (denied/unavailable) — the widget
        // still shows and is still clickable, just with a flat waveform, and
        // the meeting will have no "You" channel at all — this is the single
        // most useful line in the whole log for diagnosing that.
        wlog('error', 'getUserMedia failed — this meeting will have no mic ("You") channel', {
          errorName: err instanceof Error ? err.name : undefined,
          errorMessage: err instanceof Error ? err.message : String(err),
        })
      })

    return () => {
      cancelled = true
      // Detach the tap BEFORE the tracks and context go away, so no chunk is
      // posted from a graph that is already being torn down.
      disposeMicTap?.()
      disposeMicTap = null
      stream?.getTracks().forEach((t) => t.stop())
      void audioContext?.close()
      // Dropping the analyser is what stops the waveform's rAF loop (its
      // effect keys off this prop) — it also releases the last reference to
      // the closed AudioContext's graph.
      setAnalyser(null)
      wlog('debug', 'mic capture torn down for this session')
    }
  }, [captureActive])

  return (
    <NotetakerWidget
      analyser={analyser}
      sessionId={sessionId}
      onCancelConfirmed={() => api().notetakerCancelRequested?.()}
    />
  )
}
