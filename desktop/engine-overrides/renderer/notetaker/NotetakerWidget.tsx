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
  notetakerOnStopPending?: (cb: (pending: boolean) => void) => () => void
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
 * Registers the AudioWorklet module on a context ONCE, well before any real
 * session — see the call site in NotetakerWidgetRoute for why.
 *
 * addModule() is the expensive, failure-prone step (compiling and spinning up
 * the worklet's own realtime execution context), and it used to run fresh
 * inside every session's first few seconds because the AudioContext itself
 * was created and closed per session. Measured in the field: on a cold audio
 * subsystem (nothing else playing through the system's audio device) it can
 * take upwards of ten seconds — and sometimes fails outright with "No
 * execution context available" — while it resolves in well under 100ms when
 * something else (e.g. a YouTube tab) already has the device active. A
 * meeting shorter than that cold-start delay lost 100% of its mic audio: the
 * waveform kept animating (the analyser doesn't depend on this), so nothing
 * looked wrong until the transcript came back empty. Registering once at
 * mount, on a context that then stays alive for the window's whole lifetime,
 * takes the cold start off every session's critical path.
 */
async function registerMicWorklet(ctx: AudioContext): Promise<boolean> {
  try {
    const url = URL.createObjectURL(new Blob([MIC_WORKLET_SOURCE], { type: 'application/javascript' }))
    try {
      await ctx.audioWorklet.addModule(url)
    } finally {
      URL.revokeObjectURL(url)
    }
    wlog('info', 'mic worklet module registered')
    return true
  } catch (err) {
    wlog('warn', 'AudioWorklet module registration failed — mic tap will use ScriptProcessor for this window\'s lifetime', {
      error: err instanceof Error ? err.message : String(err),
    })
    return false
  }
}

/**
 * Attaches a PCM tap to an ALREADY-OPEN capture graph and streams its samples
 * to the main process. Returns a disposer, or null if no tap could be
 * attached (in which case the meeting simply has no mic channel — the widget,
 * the waveform, and the system-audio side all carry on unaffected).
 *
 * AudioWorkletNode is the primary path (ScriptProcessorNode is deprecated and
 * runs its callback on the main thread); the ScriptProcessorNode fallback
 * exists only for the case where the module never registered (or a fresh
 * node construction fails even though it did), since losing the user's own
 * half of every meeting is a much worse outcome than using a
 * deprecated-but-working node.
 */
async function attachMicChunkTap(
  ctx: AudioContext,
  source: MediaStreamAudioSourceNode,
  workletRegistered: boolean,
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
  //
  // GUARDED, UNLIKE THE REST OF THIS FUNCTION'S OWN try/catch BLOCKS BELOW:
  // this used to run unwrapped, so on a REUSED, cross-session AudioContext
  // (see NotetakerWidgetRoute's own comment on why the context lives for the
  // window's whole lifetime) any exception here — e.g. a stale `ctx.state`
  // the moment this runs — rejected the whole function with NO wlog call at
  // all, silently swallowed by this function's caller ("attachMicChunkTap
  // already logs" is exactly the assumption this violated). Live-observed:
  // two out of three back-to-back meetings in the same window session had
  // "mic capture granted" logged and then nothing else ever — no tap
  // attached, no error, no chunks, meeting saved with no "You" channel and
  // no trace of why. This makes that failure path actually log something.
  let sink: GainNode
  try {
    sink = ctx.createGain()
    sink.gain.value = 0
    sink.connect(ctx.destination)
  } catch (err) {
    wlog('error', 'mic tap sink could not be created — this meeting will have no "You" channel', {
      error: err instanceof Error ? err.message : String(err),
      contextState: ctx.state,
    })
    return null
  }

  if (workletRegistered) {
    try {
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
      wlog('warn', 'AudioWorkletNode construction failed despite a registered module, falling back to ScriptProcessor', { error: err instanceof Error ? err.message : String(err) })
    }
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
  stopPending = false,
  onCancelConfirmed,
}: {
  analyser: AnalyserNode | null
  /** Bumped by the route on every new capture session. The widget WINDOW is
   *  reused across sessions (hidden, never closed), so this component never
   *  remounts — without this, a "Cancel" the user surfaced but never
   *  confirmed in one session would still be on screen when the next session
   *  opened the widget. */
  sessionId?: number
  /** True while the KEYBOARD's own single-tap stop is in its undo window
   *  (main → notetaker:stop-pending, see notetakerWidget.ts's
   *  broadcastStopPending). Recording is still running — this is a separate
   *  signal from `analyser` going null, which only happens once a stop is
   *  actually finalized. Mutually exclusive with `confirmingCancel` below by
   *  construction: this widget's own click handler is disabled while true,
   *  since the only way to resolve THIS state is another tap on the key. */
  stopPending?: boolean
  onCancelConfirmed: () => void
}) {
  const [levels, setLevels] = useState<number[]>(() => new Array(BAR_COUNT).fill(0.1))
  const [confirmingCancel, setConfirmingCancel] = useState(false)
  const [hovering, setHovering] = useState(false)
  const rafRef = useRef<number | undefined>(undefined)

  // A new session always starts on the waveform face, never on a stale
  // Cancel button (or a frozen last frame of bars) left over from the last one.
  useEffect(() => {
    setConfirmingCancel(false)
    setHovering(false)
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

  // Same fixed-glass material as the dictation pill cluster (Theme.swift's
  // PillGlass, ported to CSS): a top-down sheen over a near-black base, one
  // hairline rim, no drop shadow. Tinted red (Theme.cError) while confirming
  // a cancel OR while the key's own undo window is counting down — "one
  // tinted thing per surface," and here that's the one destructive outcome
  // on the whole widget, whichever path is heading toward it.
  const tinted = confirmingCancel || stopPending
  const glassBackground = tinted
    ? 'linear-gradient(to bottom, rgba(255,255,255,0.06), rgba(255,255,255,0.02) 55%, rgba(255,69,58,0.10) 100%), rgb(14,15,19)'
    : 'linear-gradient(to bottom, rgba(255,255,255,0.09), rgba(255,255,255,0.02) 55%, rgba(255,255,255,0) 100%), rgb(14,15,19)'
  const glassBorder = tinted ? '1.5px solid rgba(255,69,58,0.75)' : '1px solid rgba(255,255,255,0.10)'

  return (
    <div
      className="w-full h-full flex flex-col items-start"
      style={{
        // @ts-expect-error -- WebkitAppRegion is a real, non-standard Electron CSS prop
        WebkitAppRegion: 'no-drag',
      }}
    >
      <div
        role="button"
        tabIndex={0}
        aria-label={
          stopPending
            ? 'Stopping note-taking — tap left Control again to keep recording'
            : confirmingCancel
              ? 'Cancel note-taking?'
              : 'Note-taking in progress'
        }
        // Click is disabled while stopPending: the only affordance that
        // resolves THIS state is another tap on the key (see the class-level
        // prop comment), and letting a click also raise the Cancel button
        // here would let two different "about to stop" states collide.
        onClick={stopPending ? undefined : () => setConfirmingCancel((v) => !v)}
        onKeyDown={
          stopPending
            ? undefined
            : (e) => {
                if (e.key === 'Enter' || e.key === ' ') setConfirmingCancel((v) => !v)
              }
        }
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => setHovering(false)}
        className={`w-14 h-14 rounded-full flex items-center justify-center gap-[3px] select-none ${stopPending ? 'cursor-default' : 'cursor-pointer'}`}
        style={{
          background: glassBackground,
          border: glassBorder,
          boxShadow: 'none',
          animation: stopPending ? 'notetaker-stop-pending-pulse 1s ease-in-out infinite' : undefined,
        }}
      >
        {confirmingCancel && !stopPending ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              setConfirmingCancel(false)
              onCancelConfirmed()
            }}
            className="flex flex-col items-center gap-0.5 bg-transparent border-none cursor-pointer p-0"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" stroke="white" strokeWidth={2.4} strokeLinecap="round" />
            </svg>
            <span className="text-[10px] font-bold text-white">Cancel</span>
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
      {/* @keyframes for the stopPending pulse — inlined (no stylesheet in
       *  this window) rather than a JS-driven animation, same reasoning as
       *  the waveform preferring CSS transitions over extra rAF work. */}
      <style>{`
        @keyframes notetaker-stop-pending-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.55; }
        }
      `}</style>
      {/* Hover-only identity label normally; while stopPending it becomes a
       *  persistent (not hover-gated) instruction, since that state is
       *  time-sensitive and the user may not be hovering the widget at all
       *  when it starts (they just tapped a key). Never shown while
       *  confirming a cancel, since that state already reads as itself. */}
      {!confirmingCancel && (
        <div
          className="mt-1.5 text-[11px] font-semibold text-white/70 bg-[rgba(14,15,19,0.9)] border border-white/[0.06] rounded-full px-2.5 py-1 whitespace-nowrap"
          style={{
            opacity: stopPending || hovering ? 1 : 0,
            transition: 'opacity 150ms ease-out',
            pointerEvents: 'none',
          }}
        >
          {stopPending ? 'Tap to keep recording' : 'Note taker'}
        </div>
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
  // The engine's body defaults to an opaque `--color-cream` fill (styles.css)
  // that the dictation widget (WidgetApp.tsx) strips with this exact
  // 'widget-body' class + documentElement override. This route never needed
  // it before: the window was sized EXACTLY to the circle, so the opaque body
  // never had any margin to show through. It grew a label area below the
  // circle for the hover-revealed "Note taker" text, and that margin exposed
  // the cream fill as a rounded box behind the circle — so this route now
  // needs the same transparency fix WidgetApp already applies.
  useEffect(() => {
    document.body.classList.add('widget-body')
    document.documentElement.style.background = 'transparent'
    return () => {
      document.body.classList.remove('widget-body')
    }
  }, [])

  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null)
  const [captureActive, setCaptureActive] = useState(false)
  const [stopPending, setStopPending] = useState(false)
  /** Increments on every false→true transition: one "session" of the widget. */
  const [sessionId, setSessionId] = useState(0)
  // Read in the IPC handler to detect the transition. A ref, not the state
  // value: the handler is registered once (empty deps) so it would close over
  // a stale `captureActive`, and deriving it inside a setState updater would
  // double-count under React's double-invoked updaters in StrictMode.
  const captureActiveRef = useRef(false)

  // ONE AudioContext for the whole life of this window, created and its
  // worklet module registered at MOUNT — before any real session, and
  // regardless of whether one ever happens. See registerMicWorklet's own
  // comment for the field data: addModule() cold-starting inside a session
  // (the old per-session `new AudioContext()`) is what silently lost every
  // short meeting's mic audio. A session now only ever RESUMES this context
  // and opens a fresh MediaStreamSource on it — cheap, synchronous-fast
  // operations with nothing left on the critical path to race against.
  const audioContextRef = useRef<AudioContext | null>(null)
  const workletReadyRef = useRef<Promise<boolean> | null>(null)

  useEffect(() => {
    const ctx = new AudioContext()
    audioContextRef.current = ctx
    workletReadyRef.current = registerMicWorklet(ctx)
    return () => {
      audioContextRef.current = null
      workletReadyRef.current = null
      void ctx.close()
    }
  }, [])

  useEffect(() => {
    const unsubscribe = api().notetakerOnCaptureActive?.((active) => {
      wlog('debug', 'capture-active signal received from main', { active, wasActive: captureActiveRef.current })
      if (active && !captureActiveRef.current) setSessionId((n) => n + 1)
      captureActiveRef.current = active
      setCaptureActive(active)
    })
    return () => unsubscribe?.()
  }, [])

  // Separate from captureActive on purpose — see NotetakerWidget's
  // `stopPending` prop comment: capture keeps running through this window,
  // it is only about to stop unless the user taps left Control again.
  useEffect(() => {
    const unsubscribe = api().notetakerOnStopPending?.((pending) => {
      wlog('debug', 'stop-pending signal received from main', { pending })
      setStopPending(pending)
    })
    return () => unsubscribe?.()
  }, [])

  useEffect(() => {
    if (!captureActive) return
    const ctx = audioContextRef.current
    if (!ctx) {
      wlog('error', 'no persistent AudioContext available — mic capture cannot start this session')
      return
    }
    let cancelled = false
    let stream: MediaStream | null = null
    let sourceNode: MediaStreamAudioSourceNode | null = null
    let analyserNode: AnalyserNode | null = null
    let disposeMicTap: (() => void) | null = null

    wlog('info', 'requesting mic capture for a new session')
    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then(async (s) => {
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

        // The previous session suspended this context on teardown; resume is
        // near-instant (nothing to negotiate — the device stayed warm).
        if (ctx.state === 'suspended') await ctx.resume()
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop())
          return
        }

        const node = ctx.createAnalyser()
        node.fftSize = 128
        const source = ctx.createMediaStreamSource(s)
        sourceNode = source
        analyserNode = node
        source.connect(node)
        setAnalyser(node)

        // The transcription tap hangs off the SAME source node as the
        // waveform's analyser. Attached in its own promise chain so that
        // awaiting the worklet-ready flag can never delay (or fail) the
        // waveform, and so this .then() keeps the exact synchronous shape
        // the mic-lifecycle fix established.
        void (workletReadyRef.current ?? Promise.resolve(false))
          .then((workletRegistered) => attachMicChunkTap(ctx, source, workletRegistered))
          .then((dispose) => {
            // Capture may have stopped while this was resolving — the
            // cleanup below has already run and can't see this disposer, so
            // undo it here instead.
            if (cancelled) dispose?.()
            else disposeMicTap = dispose
          })
          .catch((err) => {
            // Defense in depth, not the primary diagnostic anymore:
            // attachMicChunkTap now guarantees its own wlog on every
            // failure path (see its sink-creation try/catch). This only
            // fires for something UNFORESEEN in this chain itself (e.g. the
            // `.then((dispose) => …)` step above throwing) — previously
            // fully silent, same failure shape as the bug that motivated
            // guarding attachMicChunkTap in the first place.
            wlog('error', 'mic tap attach chain failed unexpectedly — this meeting will have no "You" channel', {
              error: err instanceof Error ? err.message : String(err),
            })
          })
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
      // Detach the tap BEFORE the tracks and nodes go away, so no chunk is
      // posted from a graph that is already being torn down.
      disposeMicTap?.()
      disposeMicTap = null
      stream?.getTracks().forEach((t) => t.stop())
      try { sourceNode?.disconnect() } catch { /* already disconnected */ }
      try { analyserNode?.disconnect() } catch { /* already disconnected */ }
      // SUSPEND, don't close: this context and its registered worklet module
      // are shared across every session in this window's life (see the
      // mount effect above). Suspending still fully releases the mic — only
      // the now-stopped MediaStreamTrack does that — while keeping the next
      // session's resume() instant instead of paying addModule() again.
      if (audioContextRef.current && audioContextRef.current.state === 'running') {
        void audioContextRef.current.suspend()
      }
      // Dropping the analyser is what stops the waveform's rAF loop (its
      // effect keys off this prop).
      setAnalyser(null)
      wlog('debug', 'mic capture torn down for this session')
    }
  }, [captureActive])

  return (
    <NotetakerWidget
      analyser={analyser}
      sessionId={sessionId}
      stopPending={stopPending}
      onCancelConfirmed={() => api().notetakerCancelRequested?.()}
    />
  )
}
