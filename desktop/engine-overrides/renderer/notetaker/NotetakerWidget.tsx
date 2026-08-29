// Meeting Notetaker — the floating widget's renderer (loaded at
// #/notetaker-widget by notetakerWidget.ts, mirroring how OverlayApp.tsx is
// loaded at #/overlay by overlay.ts).
//
// A small pill, bottom-left, showing a live waveform while a note-taking
// session is active — spec §7: "not buried, more like a floating thing."
// (2026-08-26: was a circle; redesigned to a pill sharing the dictation
// pill's own PillGlass material, so the two overlays read as one visual
// language.) Hovering (or focusing) reveals a separate white Cancel chip
// above it — the pill itself is not clickable (spec §6: stop is NEVER a
// single, direct action; hover-then-click-a-distinct-control satisfies
// that as well as the old same-spot double-click did). No timer anywhere
// in this file — the waveform redraws itself off the AnalyserNode via
// requestAnimationFrame, matching this codebase's existing precedent in
// widget/useAudioRecorder.ts + widget/Widget.tsx (WidgetApp owns the
// getUserMedia capture and analyser; Widget is the prop-driven presentational
// piece). This file follows the same split, consolidated into one module
// per this task's file budget.

import { useEffect, useRef, useState } from 'react'

// 55pt of waveform at 2px bars on a 2px gap. Five fat bars was the old
// short-pill compromise; at the dictation pill's proportions the same width
// holds fourteen, which is what makes it read as a voice rather than a meter.
const BAR_COUNT = 14

type API = {
  notetakerCancelRequested?: () => void
  notetakerOnCaptureActive?: (cb: (active: boolean) => void) => () => void
  notetakerOnStopPending?: (cb: (pending: boolean) => void) => () => void
  notetakerWidgetReady?: () => void
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
 * Plays one short synthesized tone into the widget's own AudioContext —
 * a real sine oscillator with a quick attack/decay GainNode envelope
 * (avoids the click a hard on/off would produce), connected straight to
 * ctx.destination (audible, unlike the mic tap's own muted monitoring
 * path — see attachMicChunkTap's `sink` below). Nodes are created fresh
 * per call and clean themselves up on `onended`, matching this file's
 * existing node-lifecycle discipline elsewhere.
 */
function playTone(ctx: AudioContext, freqHz: number, startAt: number, durationSeconds: number, peakGain: number): void {
  const osc = ctx.createOscillator()
  osc.type = 'sine'
  osc.frequency.value = freqHz
  const gain = ctx.createGain()
  gain.gain.setValueAtTime(0, startAt)
  // Quick attack (~12ms) then exponential decay to near-silence — the
  // "mild/cute" character asked for: soft onset, no harsh edges, gone
  // before it can feel like an alert.
  gain.gain.linearRampToValueAtTime(peakGain, startAt + 0.012)
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + durationSeconds)
  osc.connect(gain)
  gain.connect(ctx.destination)
  osc.start(startAt)
  osc.stop(startAt + durationSeconds + 0.02)
  osc.onended = () => {
    try { osc.disconnect() } catch { /* already disconnected */ }
    try { gain.disconnect() } catch { /* already disconnected */ }
  }
}

/**
 * The notetaker's start/stop feedback sound — synthesized, not a bundled
 * asset: no existing sound-effect infrastructure exists anywhere in this
 * app to extend, and there's no reliable way to source a properly licensed
 * "cute, mild, some bass to it" sound file. A rising two-note chime (C5→E5)
 * for start, the same interval falling (E5→C5) for stop — mirrored, so the
 * two read as a matched pair, not two unrelated sounds — each layered with
 * a quiet, short low-octave "thump" under the first note for the
 * requested bass, felt more than heard rather than a boomy hit.
 */
export function playNotetakerChime(ctx: AudioContext, direction: 'start' | 'stop'): void {
  const now = ctx.currentTime
  const NOTE_DURATION = 0.11
  const NOTE_GAP = 0.09
  const C5 = 523.25
  const E5 = 659.25
  const BASS = 130.81 // C3 — two octaves below C5, felt more than heard
  const [first, second] = direction === 'start' ? [C5, E5] : [E5, C5]
  playTone(ctx, first, now, NOTE_DURATION, 0.11)
  playTone(ctx, BASS, now, NOTE_DURATION * 1.4, 0.05)
  playTone(ctx, second, now + NOTE_GAP, NOTE_DURATION, 0.11)
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
  // Renderer-side proof the audio graph is actually PRODUCING samples, distinct
  // from main's own 'mic-chunk heartbeat' (which only proves the IPC message
  // arrived) — logging both sides of the same handoff is what makes "the tap
  // attached but nothing ever flowed" distinguishable from "IPC dropped it".
  let chunksSent = 0
  const send = (samples: ArrayBuffer) => {
    chunksSent++
    if (chunksSent === 1) {
      wlog('debug', 'first mic chunk sent to main over IPC', { sampleBytes: samples.byteLength })
    }
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
      wlog('info', 'mic tap attached via AudioWorklet', { chunkDurationMs, contextSampleRate: ctx.sampleRate, contextState: ctx.state })
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
    wlog('info', 'mic tap attached via ScriptProcessorNode (AudioWorklet fallback)', { chunkDurationMs, contextSampleRate: ctx.sampleRate, contextState: ctx.state })
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
 * Presentational piece: ONE pill, always — matching the same fixed-glass
 * PillGlass material and dark fill as the dictation pill (WidgetApp.tsx's
 * own chips, `#000`-family near-black + a whitish hairline border) while
 * actually recording, so the two overlays read as the same design language
 * (2026-08-25 redesign). Every other state (discard confirmation, the
 * undo-window countdown) turns the SAME pill white in place — never a
 * second, differently-sized element floating above it (2026-08-26, take
 * three: a separate floating "Discard" box was tried and looked
 * disproportionate next to the small pill; that's what this replaces).
 * Pure prop-driven (no IPC, no capture) so it's easy to reason about and
 * reuse — mirrors Widget.tsx's split from WidgetApp.tsx.
 *
 * Discard confirmation is a click-toggle on the pill, not hover
 * (2026-08-26, take two: hover-to-reveal was tried first, but its
 * hoverable area had to span the whole window to bridge the gap to a
 * floating chip above the pill, so ANY mouse movement near, not on, the
 * pill revealed it). Tapping the pill while recording turns it into two
 * explicit zones: a small × (back out, nothing happens) and a "Discard
 * meeting" zone (confirms). Two separate taps either way — spec §6's
 * "stop is never a single, direct action."
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
   *  remounts — without this, the discard option left open in one session
   *  would still be showing when the next session opened the widget. */
  sessionId?: number
  /** True while the KEYBOARD's own single-tap stop is in its undo window
   *  (main → notetaker:stop-pending, see notetakerWidget.ts's
   *  broadcastStopPending). Recording is still running — this is a separate
   *  signal from `analyser` going null, which only happens once a stop is
   *  actually finalized. The pill's own content swaps to a short message
   *  for this state (see below) — the discard box never shows here, since
   *  the only way to resolve it is another tap on the key. */
  stopPending?: boolean
  onCancelConfirmed: () => void
}) {
  const [levels, setLevels] = useState<number[]>(() => new Array(BAR_COUNT).fill(0.35))
  const [showDiscard, setShowDiscard] = useState(false)
  const rafRef = useRef<number | undefined>(undefined)

  const openDiscard = () => { if (!stopPending) setShowDiscard(true) }
  const dismissDiscard = () => setShowDiscard(false)
  const confirmDiscard = () => { setShowDiscard(false); onCancelConfirmed() }

  // A new session always starts on the waveform face, never a stale
  // discard state (or a frozen last frame of bars) left over from the
  // last one.
  useEffect(() => {
    setShowDiscard(false)
    setLevels(new Array(BAR_COUNT).fill(0.35))
  }, [sessionId])

  // The discard option only ever makes sense while actually recording —
  // never while the undo window (stopPending) is counting down, since the
  // only affordance that resolves that state is another tap on the key.
  useEffect(() => {
    if (stopPending) setShowDiscard(false)
  }, [stopPending])

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

  const NOTETAKER_GREEN = '#6fbf9a'
  const NOTETAKER_RED = '#c4482e'
  // "Recording" is its own look (dark PillGlass, matching the dictation
  // pill); every other state — discard confirmation, the undo-window
  // countdown — turns this SAME pill white in place, per feedback that a
  // second, differently-sized element floating above it read as
  // disproportionate no matter how either one was sized on its own. A
  // small static 3-bar glyph (waveGlyph below) stays in every white state
  // so it's still visibly "the recording thing," just not live-updating.
  // THE DICTATION PILL, NOT A SECOND DESIGN.
  //
  // This was rgba(14,15,19,0.42) over a blur(14px) backdrop — a translucent
  // dark wash that SAMPLES the wallpaper, so on a magenta desktop the pill came
  // out maroon and never read as black at all. PillView.swift settled this for
  // the dictation capsule and its comment says why: pure black with a rim reads
  // as "a hole punched in the screen", identical on every wallpaper, every
  // Space and every Mac. One instrument, not one that changes colour with the
  // desktop behind it.
  const glassBackground = '#000'
  const glassBorder = stopPending
    ? '1.5px solid rgba(111,191,154,0.45)'
    : '1px solid rgba(255,255,255,0.30)'
  // Pill height is fixed across every state (no resize-on-state-change
  // jank) — a true pill, not a tall capsule (2026-08-26: was 40px then
  // 22px; nudged back up slightly so the waveform has room to actually
  // read as a waveform rather than a near-flat line).
  // PillMetrics.height. The widget is the dictation pill carrying less, so it
  // is the same height and only the WAVEFORM is shorter — 30% off the length,
  // which is the one deliberate difference between the two.
  const PILL_HEIGHT = 36
  const WAVE_WIDTH = 55        // the dictation waveform is 78

  const waveGlyph = (tone: string) => (
    <span className="flex items-center flex-none" style={{ gap: 2 }}>
      <span className="block rounded-full" style={{ width: 2, height: 7, background: tone, opacity: 0.55 }} />
      <span className="block rounded-full" style={{ width: 2, height: 13, background: tone }} />
      <span className="block rounded-full" style={{ width: 2, height: 9, background: tone, opacity: 0.75 }} />
    </span>
  )

  return (
    <div
      className="w-full h-full flex flex-col-reverse items-start"
      style={{
        // @ts-expect-error -- WebkitAppRegion is a real, non-standard Electron CSS prop
        WebkitAppRegion: 'no-drag',
      }}
    >
      {/* ONE pill, always. Tapping it while recording opens the discard
       *  option in place; the undo-window countdown also renders in
       *  place. Never a second element. */}
      <div
        role={!stopPending && !showDiscard ? 'button' : undefined}
        tabIndex={!stopPending && !showDiscard ? 0 : undefined}
        title={!stopPending && !showDiscard ? 'Note taker' : undefined}
        aria-label={
          stopPending
            ? 'Stopping note-taking — press left Control again to keep recording'
            : showDiscard ? undefined : 'Note-taking in progress — tap for options'
        }
        onClick={!stopPending && !showDiscard ? openDiscard : undefined}
        onKeyDown={
          !stopPending && !showDiscard
            ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDiscard() } }
            : undefined
        }
        className={`rounded-full flex items-center select-none overflow-hidden ${!stopPending && !showDiscard ? 'cursor-pointer' : ''}`}
        style={{
          height: PILL_HEIGHT,
          padding: showDiscard ? 0 : stopPending ? '0 12px' : '0 13px',
          background: glassBackground,
          // NO BACKDROP SAMPLING and no shadow. The fill is opaque black, so a
          // blur behind it is invisible work; and PillView drops the shadow for
          // the same reason it drops the sheen — both imply a lit object, and
          // this one claims to be a hole rather than a surface.
          border: glassBorder,
          boxShadow: 'none',
          transition: 'background 180ms ease, border-color 180ms ease, padding 180ms ease, box-shadow 180ms ease',
        }}
      >
        {stopPending ? (
          <span className="flex items-center whitespace-nowrap" style={{ gap: 7 }}>
            {waveGlyph(NOTETAKER_GREEN)}
            <span
              className="rounded-full flex-none"
              style={{ width: 6, height: 6, background: NOTETAKER_GREEN, animation: 'notetaker-dot-pulse 1.1s ease-in-out infinite' }}
            />
            <span className="text-[13px] font-medium" style={{ color: 'rgba(255,255,255,0.92)' }}>
              Press ⌃ again to keep recording
            </span>
          </span>
        ) : showDiscard ? (
          <>
            <button
              type="button"
              onClick={dismissDiscard}
              title="Never mind — keep recording"
              className="flex items-center justify-center flex-none"
              // Was black-on-white; the pill is black now.
              style={{ width: 30, height: PILL_HEIGHT, color: 'rgba(255,255,255,0.55)' }}
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" />
              </svg>
            </button>
            <button
              type="button"
              onClick={confirmDiscard}
              className="flex items-center flex-1 whitespace-nowrap"
              style={{ gap: 6, height: PILL_HEIGHT, paddingRight: 13 }}
            >
              {waveGlyph(NOTETAKER_RED)}
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden="true" className="flex-none" style={{ color: NOTETAKER_RED }}>
                <path d="M5 7h14M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m-8 0 1 12a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1l1-12" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              {/* The red survives HERE and nowhere else — on the one label
                  that means destructive. A black capsule with a red word in it
                  reads as a warning; a red capsule reads as another product. */}
              <span className="text-[13px] font-medium" style={{ color: NOTETAKER_RED }}>Discard meeting</span>
            </button>
          </>
        ) : (
          /* SILENCE IS A LINE, NOT A ROW OF DOTS.
             The bars were 3px wide with a 5px floor and `rounded-full`, so at
             rest each one rendered as a CIRCLE — the pill showed five dots
             rather than a waveform. Same defect the Swift waveform had, and the
             same fix: no floor, a hairline behind, and nothing drawn below 2px
             because a sub-2px rounded div is that dot again by another name.
             Bars are 2px on a 2px gap, matching Waveform.swift exactly. */
          <span
            className="relative flex items-center justify-center flex-none"
            style={{ width: WAVE_WIDTH, height: 20 }}
          >
            <span
              className="absolute rounded-full"
              style={{ left: 0, right: 0, height: 1, background: 'rgba(255,255,255,0.18)' }}
            />
            <span className="relative flex items-center" style={{ gap: 2 }}>
              {levels.map((level, i) => {
                const h = Math.round(level * 20)
                return (
                  <div
                    key={i}
                    className="w-[2px] rounded-full bg-white"
                    style={{
                      height: h < 2 ? 0 : h,
                      opacity: 0.55 + 0.45 * level,
                      transition: 'height 60ms linear',
                    }}
                  />
                )
              })}
            </span>
          </span>
        )}
      </div>

      {/* @keyframes for the stopPending dot — inlined (no stylesheet in
       *  this window), same reasoning as the waveform preferring CSS
       *  transitions over extra rAF work. */}
      <style>{`
        @keyframes notetaker-dot-pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50%      { opacity: 0.5; transform: scale(0.82); }
        }
      `}</style>
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
  // Stable across the whole life of this mount (React only evaluates a
  // useRef initializer once) — everything below logs its own timing against
  // this, since "was the listener even mounted yet when main's signal
  // arrived" is exactly the race that dropped a capture-active signal on the
  // widget's very first load (see notetakerWidget.ts's own broadcast logs
  // for the main-process side of the same timeline).
  const mountedAtRef = useRef(Date.now())

  useEffect(() => {
    wlog('info', 'widget route mounted', { at: mountedAtRef.current })
  }, [])

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
  // short meeting's mic audio. A session now just opens a fresh
  // MediaStreamSource on this context — see the mic-acquisition effect's own
  // teardown comment below for why the context is NEVER suspended between
  // sessions (it used to be, which is what this comment used to say) —
  // cheap, synchronous-fast operations with nothing left on the critical
  // path to race against.
  const audioContextRef = useRef<AudioContext | null>(null)
  const workletReadyRef = useRef<Promise<boolean> | null>(null)

  useEffect(() => {
    const ctx = new AudioContext()
    audioContextRef.current = ctx
    wlog('info', 'AudioContext created', { initialState: ctx.state, sampleRate: ctx.sampleRate, msSinceMount: Date.now() - mountedAtRef.current })
    workletReadyRef.current = registerMicWorklet(ctx)
    return () => {
      wlog('info', 'AudioContext closing (route unmounting)', { stateAtClose: ctx.state })
      audioContextRef.current = null
      workletReadyRef.current = null
      void ctx.close()
    }
  }, [])

  useEffect(() => {
    const registeredAt = Date.now()
    wlog('debug', 'capture-active listener mounted', { msSinceMount: registeredAt - mountedAtRef.current })
    const unsubscribe = api().notetakerOnCaptureActive?.((active) => {
      wlog('debug', 'capture-active signal received from main', { active, wasActive: captureActiveRef.current, msSinceListenerMounted: Date.now() - registeredAt })
      // Feedback chime on the real false→true/true→false transition only —
      // never on a same-value resend (did-finish-load / widget-ready can
      // both resend the current cached state, which must not replay the
      // sound). Uses the same always-running AudioContext the mic tap does
      // (see the earlier fix removing suspend() between sessions).
      if (active && !captureActiveRef.current) {
        setSessionId((n) => n + 1)
        if (audioContextRef.current) playNotetakerChime(audioContextRef.current, 'start')
      } else if (!active && captureActiveRef.current && audioContextRef.current) {
        playNotetakerChime(audioContextRef.current, 'stop')
      }
      captureActiveRef.current = active
      setCaptureActive(active)
    })
    return () => unsubscribe?.()
  }, [])

  // Separate from captureActive on purpose — see NotetakerWidget's
  // `stopPending` prop comment: capture keeps running through this window,
  // it is only about to stop unless the user taps left Control again.
  useEffect(() => {
    const registeredAt = Date.now()
    wlog('debug', 'stop-pending listener mounted', { msSinceMount: registeredAt - mountedAtRef.current })
    const unsubscribe = api().notetakerOnStopPending?.((pending) => {
      wlog('debug', 'stop-pending signal received from main', { pending, msSinceListenerMounted: Date.now() - registeredAt })
      setStopPending(pending)
    })
    return () => unsubscribe?.()
  }, [])

  // Fires once both listener-registering effects above have actually run —
  // React commits effects with empty deps in declaration order on mount, so
  // by the time THIS effect body runs, both subscriptions are guaranteed
  // live. Tells main it can safely resend the current capture-active/
  // stop-pending state and have it actually arrive — see
  // notetakerWidget.ts's 'notetaker:widget-ready' handler for why this
  // exists (a real dropped-signal bug on the widget's first-ever load that
  // neither the immediate send nor the 'did-finish-load' resend closed).
  useEffect(() => {
    wlog('info', 'widget ready — listeners mounted, telling main', { msSinceMount: Date.now() - mountedAtRef.current })
    api().notetakerWidgetReady?.()
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

    const requestedAt = Date.now()
    wlog('info', 'requesting mic capture for a new session', { contextStateAtRequest: ctx.state })
    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then(async (s) => {
        // Silent before this fix: if the session was stopped WHILE
        // getUserMedia was still pending (a real observed shape — a session
        // this short never even reached the next log line), this branch fired
        // and nothing downstream of it ever ran or logged anything at all.
        if (cancelled) {
          wlog('info', 'mic capture granted but session already ended — discarding', {
            msFromRequestToGrant: Date.now() - requestedAt,
          })
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
          // Whether the OS itself thinks this track is live — a track can be
          // granted but already 'ended' or muted if the device was yanked or
          // handed to someone else between permission grant and this line.
          trackReadyState: track?.readyState,
          trackMuted: track?.muted,
          trackEnabled: track?.enabled,
          contextStateAtGrant: ctx.state,
          msFromRequestToGrant: Date.now() - requestedAt,
        })

        // DEFENSIVE ONLY, NOT THE NORMAL PATH ANYMORE. This context is no
        // longer suspended by anything in this file (see the teardown
        // below) — a real, repeated field failure: live-logged evidence
        // across one test run showed resume() taking 2852ms the FIRST time
        // this context was reused after a suspend, then simply never
        // resolving at all the two times after that, silently killing both
        // the mic tap and (independently) the native system tap for that
        // whole session. The fix is to never suspend this context in the
        // first place (nothing meaningful is saved by it — the mic is
        // actually released by stopping the MediaStreamTrack below, not by
        // suspending the context), so this branch should now never fire
        // in normal operation. It stays as a defensive fallback ONLY for
        // the case where something OUTSIDE this file suspends the context
        // (Chromium's own power-saving/visibility policies can still do
        // this to a backgrounded window) — logged at WARN, not the old
        // debug level, because hitting this now means something unexpected
        // happened and is worth noticing, not routine housekeeping.
        if (ctx.state === 'suspended') {
          const resumeStartedAt = Date.now()
          wlog('warn', 'AudioContext was suspended by something other than this file — resuming defensively', { contextState: ctx.state })
          await ctx.resume()
          wlog('warn', 'defensive AudioContext resume completed', { newState: ctx.state, resumeDurationMs: Date.now() - resumeStartedAt })
        }
        if (cancelled) {
          // Also previously silent — the session ended DURING ctx.resume()'s
          // await, so the tap/analyser below never got created either.
          wlog('info', 'session ended while resuming the AudioContext — discarding this grant', {
            contextStateAtCancel: ctx.state,
          })
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
      const hadDisposer = !!disposeMicTap
      const hadStream = !!stream
      // Detach the tap BEFORE the tracks and nodes go away, so no chunk is
      // posted from a graph that is already being torn down.
      disposeMicTap?.()
      disposeMicTap = null
      stream?.getTracks().forEach((t) => t.stop())
      try { sourceNode?.disconnect() } catch { /* already disconnected */ }
      try { analyserNode?.disconnect() } catch { /* already disconnected */ }
      // DELIBERATELY NEVER SUSPENDED. This context and its registered
      // worklet module are shared across every session in this window's
      // life (see the mount effect above) — it used to be suspended here
      // and resumed at the next session's start, on the theory that
      // suspending saved some idle CPU between meetings for free. Live
      // data proved that resume() is NOT free on a context reused this way:
      // 2852ms the first time, then hanging indefinitely (never resolving
      // at all) on subsequent reuses — silently killing the mic AND, in the
      // same window, the independent native system-audio tap for that
      // whole session. The mic is fully released by stopping the
      // MediaStreamTrack two lines up regardless of what the context itself
      // is doing, so suspending bought nothing that track.stop() didn't
      // already give us — only the failure mode. Leaving it running is the
      // fix; see the mic-acquisition `if (ctx.state === 'suspended')` guard
      // above, which stays only as a defensive fallback for something
      // OUTSIDE this file suspending it (Chromium's own policies can still
      // do that to a backgrounded window).
      const stateAtTeardown = audioContextRef.current?.state
      // Dropping the analyser is what stops the waveform's rAF loop (its
      // effect keys off this prop).
      setAnalyser(null)
      // hadDisposer/hadStream distinguish a session that actually got a mic
      // tap attached (normal, clean teardown) from one that never did (this
      // IS the "no mic ever captured" signature — everything above is a
      // no-op, and this line is the only trace it happened at all).
      wlog('debug', 'mic capture torn down for this session', {
        hadDisposer,
        hadStream,
        durationMs: Date.now() - requestedAt,
        // Expected to read 'running' from now on — anything else here means
        // something outside this file suspended the context mid-session,
        // which the defensive resume() branch above will have to deal with
        // next time (and will now log loudly if it does).
        contextStateAtTeardown: stateAtTeardown,
      })
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
