// desktop/engine-overrides/electron/notetakerInit.ts
//
// Composition root for the Meeting Notetaker (Task 10), living inside the
// OSS engine's own electron/ tree — right alongside keyboard.ts,
// mediaController.ts, meetingWatcher.ts, notetakerSession.ts and
// notetakerController.ts, which this file wires together.
//
// WHY THIS FILE, AND NOT desktop/electron/remote/init.ts: init.ts
// (closed-source, the paywall/Remote layer) treats every OSS-engine
// singleton as an OPAQUE INJECTED DEPENDENCY — see its own
// `RemoteInitDeps`/`KeyboardManagerLike` comment: "Accepted as opaque
// shapes... so we don't entangle with engine internals. main.ts passes its
// real instances." A direct `import ... from '../../meetingWatcher'` inside
// init.ts cannot be made to resolve BOTH locally in this repo (which has no
// desktop/electron/../../<name> path — engine-overrides/electron/ is a
// SIBLING tree, not a parent of electron/remote/) AND after
// wire-into-engine.sh's copy (which lands init.ts two directories under the
// engine's electron root while engine-overrides/electron/*.ts lands AT that
// root) with the same relative path. Verified by trying it: `tsc -p
// tsconfig.typecheck.json` throws TS2307 on every such import, because that
// config typechecks electron/remote/**/*.ts against the files that actually
// exist in THIS repo, not the post-copy layout.
//
// Putting the wiring here instead keeps every import same-directory
// (trivially correct pre- and post-copy), and importing 'electron' directly
// from an engine-overrides file is already established precedent —
// mediaController.ts, keyListener.ts, sessionManager.ts etc. all do it.
//
// The one piece this file genuinely cannot reach is the floating widget
// (desktop/electron/remote/notetakerWidget.ts, a closed-source paywall-tree
// file) — its show()/hide() are injected via `hooks` instead. Wiring those
// hooks in is a one-line addition to wire-into-engine.sh's existing sed
// patcher, exactly parallel to how `initRemote({ sessionManager,
// keyboardManager })` is already injected into the OSS engine's real
// main.ts. Note the import path below is './paywall/remote/notetakerWidget'
// — NOT './paywall/notetakerWidget' — because `desktop/electron/remote/`
// (which notetakerWidget.ts lives in, alongside init.ts) is copied wholesale
// onto `$engine/electron/paywall/`, landing the widget at
// electron/paywall/remote/notetakerWidget.ts, same as init.ts itself
// (electron/paywall/remote/init.ts) — this bit an earlier draft of this
// wiring (wrong path, silently-undefined hooks) and is now covered by two
// dedicated grep checks in wire-into-engine.sh:
//
//   import { initNotetaker } from './notetakerInit'
//   import { showNotetakerWidget, hideNotetakerWidget } from './paywall/remote/notetakerWidget'
//   initNotetaker({ onSessionStart: showNotetakerWidget, onSessionStop: hideNotetakerWidget })
//
// Per docs/superpowers/specs/2026-08-23-meeting-notetaker-detection-capture.md.

import { Notification, dialog, ipcMain, app } from 'electron'
import path from 'path'
import fs from 'fs'
import { keyboardManager } from './keyboard'
import { MeetingWatcher } from './meetingWatcher'
import { NotetakerSession, type NativeAudioTap, type AudioTapStartResult } from './notetakerSession'
import { NotetakerController } from './notetakerController'
import { readNowPlaying } from './mediaController'
import { getActiveTabUrl, SUPPORTED_APPLESCRIPT_BROWSERS, type AppleScriptBrowser } from './browserTabWatcher'
import { PeriodicChunkEmitter, type FinalizedSegment } from './notetaker/periodicChunkEmitter'
import { encodeChunk, transcribeEncodedChunk, persistSession, newMeetingId } from './notetaker/transcribeSession'
import type { TimedChunkText, SpeakerSample } from './notetaker/transcriptMerge'
import { WavAppender } from './notetaker/wavAppender'
import { pollZoomSpeaker } from './notetaker/zoomSpeaker'
import { ZOOM_BUNDLE_ID } from './meetingApps'
import { getMeetings, getMeeting, updateMeetingTitle, deleteMeeting, insertMeeting } from './db'
import { createNotetakerLogger, getNotetakerLogFilePath } from './notetaker/notetakerLog'

const log = createNotetakerLogger('init')

export type NotetakerInitHooks = {
  /** Called exactly when REAL capture starts/stops — from
   *  NotetakerSession's own start()/stop(), never from detection or confirm
   *  logic — so the floating widget's visibility always matches actual
   *  capture state, per the plan. */
  onSessionStart?: () => void
  onSessionStop?: () => void
}

/**
 * The slice of the native-ax addon's surface this file actually needs.
 * Deliberately NOT pulled through native-ax's own ax-bridge.ts (a
 * closed-source, worker-thread-backed wrapper built for slow AX-TREE walks —
 * see its own file header: "AX tree walks can take up to the 8s messaging
 * timeout... running them on the Electron MAIN thread would block it") —
 * that file is cross-tree from here the same way notetakerWidget.ts is.
 *
 * frontmostApp()/listApps() are cheap NSWorkspace/CGWindowList enumerations
 * (native-ax/src/ax.mm:364,379 — no AX tree walk at all), fast enough to
 * call directly and synchronously on the main thread, same as this file's
 * sibling mediaController.ts's synchronous-feeling (if child-process-backed)
 * readNowPlaying().
 *
 * `find` is DIFFERENT and does NOT get that same justification — it IS a
 * real synchronous AX-tree walk (native-ax/src/ax.mm's withNodes, up to 4000
 * nodes with an 8s per-element messaging timeout), exactly the class of call
 * ax-bridge.ts exists to keep off the main thread. It was added here anyway
 * (for Zoom active-speaker polling, see zoomSpeaker.ts) rather than routed
 * through ax-bridge, accepting the main-thread cost as a known, deliberate
 * tradeoff — mitigated by throttling the poll interval, NOT by this being
 * cheap the way frontmostApp()/listApps() are. See the Zoom-speaker-poll
 * setInterval below for the throttling rationale. Routing this through
 * ax-bridge instead is a real, larger follow-up worth doing if the
 * throttled cadence proves too coarse in practice.
 */
interface NativeAx {
  /** Returns the frontmost app's localizedName as a plain STRING — NOT an
   *  object with .bundleId/.pid, despite that shape being assumed elsewhere
   *  in this codebase (desktop/electron/remote/codex/driver.ts:109,
   *  claude-desktop/actuate.ts:146 both do `(await bridge.call(
   *  'frontmostApp', []))?.bundleId`, which is always undefined against the
   *  real addon — a pre-existing bug there, out of this task's scope to
   *  fix). Confirmed by reading native-ax/src/ax.mm:379-384 directly. */
  frontmostApp(): string
  listApps(): Array<{ name: string; bundleId: string; pid: number; windowsHere: number; windowsAnywhere: number }>
  /** Added for Zoom active-speaker polling — see zoomSpeaker.ts. Matches
   *  unmute-native-ax's real find(app, label, role) signature. */
  find(app: string, label: string, role: string): {
    app: string
    nodes: Array<{ id: number; role: string; label: string; actions: string[] }>
    total: number
    error?: string
  }
}

function loadNativeAx(): NativeAx | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ax = require('unmute-native-ax') as NativeAx
    log.event('native-ax-loaded')
    return ax
  } catch (e) {
    log.error('unmute-native-ax unavailable — cannot resolve a capture target', { error: (e as Error).message })
    return null
  }
}

/** frontmostApp() gives a name; listApps() is the only call that pairs a
 *  name with a pid — so resolving "the app to target" is: get the frontmost
 *  name, then look it up in listApps(). Spec §9: manual trigger capture
 *  "never needs to know it's looking at a meeting, only which app is
 *  currently frontmost" — this is exactly that, unconditionally. */
function resolveTargetPid(ax: NativeAx): number | null {
  try {
    const frontName = ax.frontmostApp()
    if (!frontName) {
      log.warn('resolveTargetPid: frontmostApp() returned nothing — no target to capture')
      return null
    }
    const match = ax.listApps().find((a) => a.name === frontName)
    if (!match) {
      log.warn('resolveTargetPid: frontmost app has no matching entry in listApps() — cannot resolve a pid', { frontName })
      return null
    }
    log.event('target-app-resolved', { appName: match.name, bundleId: match.bundleId, pid: match.pid })
    return match.pid
  } catch (e) {
    log.error('resolveTargetPid failed', { error: (e as Error).message })
    return null
  }
}

/**
 * Reconstructs the renderer's Float32 PCM from whatever Electron's structured
 * clone handed us. It should always be a plain ArrayBuffer (that is what
 * remote-preload's notetakerMicChunk sends, matching sendAudioChunk's existing
 * ArrayBuffer-over-IPC precedent), but a Buffer/TypedArray view is accepted
 * too so a serialization surprise degrades to "still works" rather than "the
 * mic channel is silently empty again". Returns null for anything else.
 */
function toFloat32(samples: unknown): Float32Array | null {
  let buffer: ArrayBuffer | null = null
  if (samples instanceof ArrayBuffer) {
    buffer = samples
  } else if (ArrayBuffer.isView(samples)) {
    buffer = samples.buffer.slice(samples.byteOffset, samples.byteOffset + samples.byteLength) as ArrayBuffer
  }
  if (!buffer || buffer.byteLength === 0 || buffer.byteLength % 4 !== 0) return null
  return new Float32Array(buffer)
}

function showNotetakerNotification(opts: { title: string; body?: string; onClick?: () => void }): void {
  try {
    if (!Notification.isSupported()) {
      log.warn('notification not supported on this platform — dropped', { title: opts.title })
      return
    }
    const n = new Notification({ title: opts.title, body: opts.body ?? '' })
    if (opts.onClick) n.on('click', opts.onClick)
    n.show()
    log.event('notification-shown', { title: opts.title, body: opts.body })
  } catch (e) {
    log.error('notification failed', { error: (e as Error).message })
  }
}

// No existing confirm-dialog mechanism anywhere in this codebase to reuse
// (grepped desktop/electron/remote/ for dialog.showMessageBox — nothing uses
// it today). Electron's own dialog API is the standard, un-invented way to
// ask a yes/no question from the main process.
async function confirmNotetakerDialog(message: string): Promise<boolean> {
  try {
    const result = await dialog.showMessageBox({
      type: 'question',
      buttons: ['Stop', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      message,
    })
    log.event('confirm-dialog-answered', { message, confirmed: result.response === 0 })
    return result.response === 0
  } catch (e) {
    log.error('confirm dialog failed', { error: (e as Error).message })
    return false // fail closed — never stop a running capture on a broken dialog
  }
}

let initialized = false

/**
 * Wire detection (MeetingWatcher, Task 3), the manual chord trigger
 * (keyboardManager's notes-start-requested/notes-stop-confirm-requested,
 * Task 7), capture (NotetakerSession backed by the real
 * unmute-native-audio-tap addon, Task 8), and the widget (via `hooks`,
 * Task 9) together. Idempotent, like initRemote() — safe if main.ts's
 * activate handler or a hot-reload calls it more than once.
 *
 * Native-module-gated: if unmute-native-audio-tap or unmute-native-ax failed
 * to load (not rebuilt for this Electron ABI, or simply absent), the WHOLE
 * feature stays off rather than half-wiring detection prompts for a capture
 * path that would immediately throw — same "opt-in, degrades to doing
 * nothing" posture as mediaController.ts's adapterPaths() guard.
 */
export function initNotetaker(hooks: NotetakerInitHooks = {}): void {
  if (initialized) return
  initialized = true

  // ── Meeting list/detail surface for the Notetaker tab (Tasks 8-10) ──
  //
  // DELIBERATELY REGISTERED BEFORE THE NATIVE-MODULE GUARD BELOW. These five
  // handlers only read/write the `meetings` table and the meetings directory —
  // none of them touch the audio tap or native-ax. Registering them behind the
  // guard meant that an ABI mismatch, a failed native rebuild, or simply
  // running on a non-macOS host made every ALREADY-SAVED meeting unreachable:
  // the renderer's invoke() would reject with "No handler registered", which
  // the list renders as an empty history — indistinguishable from having never
  // recorded anything. Live capture degrades to unavailable; browsing what was
  // already captured must not.
  ipcMain.handle('notetaker:list-meetings', () => {
    const meetings = getMeetings()
    log.debug('list-meetings', { count: meetings.length })
    return meetings
  })

  ipcMain.handle('notetaker:get-transcript', (_event, id: string) => {
    const meeting = getMeeting(id)
    if (!meeting || !meeting.transcript_path) {
      log.child({ meetingId: id }).debug('get-transcript: no meeting or no transcript_path', {
        found: !!meeting,
      })
      return []
    }
    const meetingDir = path.join(app.getPath('userData'), 'meetings', id)
    try {
      const raw = fs.readFileSync(path.join(meetingDir, meeting.transcript_path), 'utf8')
      const parsed = JSON.parse(raw)
      log.child({ meetingId: id }).debug('get-transcript: loaded', { segmentCount: Array.isArray(parsed) ? parsed.length : 0 })
      return parsed
    } catch (e) {
      log.child({ meetingId: id }).warn('get-transcript: failed to read/parse transcript file', { error: (e as Error).message })
      return []
    }
  })

  ipcMain.handle('notetaker:rename-meeting', (_event, id: string, title: string) => {
    updateMeetingTitle(id, title)
    log.child({ meetingId: id }).event('meeting-renamed', { title })
  })

  ipcMain.handle('notetaker:delete-meeting', (_event, id: string) => {
    deleteMeeting(id)
  })

  ipcMain.handle('notetaker:get-audio-url', (_event, id: string, channel: 'mic' | 'system') => {
    const mlog = log.child({ meetingId: id })
    const meeting = getMeeting(id)
    if (!meeting) {
      mlog.debug('get-audio-url: no meeting row found', { channel })
      return null
    }
    const relPath = channel === 'mic' ? meeting.audio_mic_path : meeting.audio_system_path
    if (!relPath) {
      mlog.debug('get-audio-url: channel has no recorded/still-retained audio path', { channel })
      return null
    }
    const fullPath = path.join(app.getPath('userData'), 'meetings', id, relPath)
    if (!fs.existsSync(fullPath)) {
      mlog.warn('get-audio-url: DB has a path but the file is missing on disk', { channel, relPath })
      return null
    }
    mlog.debug('get-audio-url: resolved', { channel })
    return `file://${fullPath}`
  })

  let nativeAudioTap: NativeAudioTap | null = null
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    nativeAudioTap = require('unmute-native-audio-tap') as NativeAudioTap
    log.event('native-audio-tap-loaded')
  } catch (e) {
    log.error('unmute-native-audio-tap unavailable — meeting notetaker disabled', { error: (e as Error).message })
  }
  const ax = loadNativeAx()
  if (!nativeAudioTap || !ax) {
    log.error('notetaker feature disabled at startup — missing native module(s)', {
      nativeAudioTapLoaded: !!nativeAudioTap,
      nativeAxLoaded: !!ax,
    })
    return
  }
  // `ax` is narrowed to non-null by the guard above, but — like the
  // hoisted-`function` case documented on pollMeetingSignal further down
  // ("does not carry into a hoisted function's body... does carry into a
  // const arrow function defined after the narrowing point") — that
  // narrowing does NOT carry into HookedNotetakerSession's class methods
  // below (confirmed by `tsc --strict`: `ax` reads back as `NativeAx | null`
  // inside start()). Capturing it into a fresh const HERE, at the point
  // where its type is fixed rather than merely narrowed, gives
  // `zoomAx: NativeAx` a type that isn't control-flow-dependent, so it
  // carries into any closure unconditionally — same object, no re-require.
  const zoomAx: NativeAx = ax

  // Widget visibility must always match REAL capture state (not the
  // controller's detection/confirm logic), so it is wired here, at the one
  // place start()/stop() actually run — never from the controller. Guarded
  // by `isActive` BEFORE calling super so the hook only fires on a REAL
  // transition: NotetakerSession.stop() early-returns as a no-op when
  // already inactive, and a firing hook on a no-op would break the
  // "hook == real transition" invariant (harmless today since
  // hideNotetakerWidget() is itself idempotent, but not something to rely
  // on staying harmless).
  // Periodic per-channel chunk cutting + IMMEDIATE per-chunk transcription
  // (Task 6 of the periodic-flush plan, replacing the old
  // buffer-everything-until-stop ChunkBuffer + single-shot
  // transcribeAndPersistSession() from the earlier persistence plan). Each
  // channel gets its own PeriodicChunkEmitter, whose onSegment fires as soon
  // as vadPolicy cuts a chunk (not once at the very end of the meeting) —
  // see makeChunkHandler below. This is what keeps a long meeting from
  // buffering hours of raw Float32 audio in RAM: only ONE chunk's worth of
  // samples is ever alive per channel at a time, and encodeChunk() (a plain
  // synchronous function, see transcribeSession.ts) makes those samples —
  // and the intermediate downmixed/resampled array — PROVABLY unreachable
  // the moment it returns, before any network I/O even starts. Only the
  // already-encoded `wav` Buffer survives into transcribeEncodedChunk()'s
  // `await tryManagedSTT(...)`, which is the structural (not just
  // GC-timing-dependent) form of the memory bound this plan exists to fix.
  //
  // Each chunk's audio is ALSO streamed to its channel's on-disk WAV file
  // (`WavAppender`) synchronously, right after encodeChunk() and before the
  // STT call fires — this restores the pre-periodic-flush "You"/"Them"
  // playback file the governing spec's own non-goals list (§5) requires
  // stay intact ("this spec doesn't change... the 24h audio-only... split"),
  // without re-buffering a whole channel's audio in memory: only one
  // chunk's encoded bytes are ever in flight to disk at a time.
  //
  // Each channel's in-flight transcription promises, per-chunk success/
  // attempt counts (for partial-failure semantics, see stop() below), and
  // WavAppender live on a small per-session `ChannelTracker` object, not on
  // shared module-level primitives — `HookedNotetakerSession.start()`
  // allocates a FRESH tracker (and a fresh emitter closing over it) for both
  // channels, exactly like the old fresh-`ChunkBuffer`-per-session pattern.
  // Because the tracker is captured by the emitter's onSegment closure at
  // construction time (not re-read from a reassignable outer variable), a
  // subsequent start() reassigning `micTracker`/`systemTracker` can never
  // cause an in-flight chunk from the PREVIOUS session to record its result
  // against the NEW session — each stop() call also snapshots its own
  // session's tracker/emitter into local consts before doing any awaiting,
  // for the same reason `meetingId`/`startedAt` already were.
  type ChannelTracker = {
    promises: Promise<TimedChunkText>[]
    /** Chunks that had real (non-silent) audio and were actually sent to
     *  STT — excludes chunks encodeChunk() judged empty/silent. */
    attempted: number
    /** Of `attempted`, how many got back a real transcript. Used for
     *  partial-failure semantics: a channel is only 'failed' if it was
     *  attempted at all AND every single attempt failed — see stop(). */
    succeeded: number
    writer: WavAppender | null
    /** Set together with `writer`, once, on that channel's first non-empty
     *  chunk — the relative filename persistSession() should record in the
     *  DB row, or null if this channel never produced any real audio. */
    audioFileName: string | null
    /** Log-only running counter — how many times this channel's emitter has
     *  called onSegment at all (including empty/silent cuts), so a log line
     *  can say "chunk 7 of the system channel" rather than just "a chunk". */
    chunkIndex: number
  }

  function freshTracker(): ChannelTracker {
    return { promises: [], attempted: 0, succeeded: 0, writer: null, audioFileName: null, chunkIndex: 0 }
  }

  function makeChunkHandler(channel: 'mic' | 'system', tracker: ChannelTracker, meetingDir: string, mlog: ReturnType<typeof log.child>): (segment: FinalizedSegment) => void {
    return (segment: FinalizedSegment) => {
      const chunkIndex = tracker.chunkIndex++
      const clog = mlog.child({ channel, chunkIndex })
      const startMs = segment.startTimestampMs
      const durationMs =
        segment.sampleRate > 0 && segment.channels > 0
          ? (segment.samples.length / segment.channels / segment.sampleRate) * 1000
          : 0
      const endMs = startMs + durationMs
      clog.event('chunk-cut', {
        durationMs: Math.round(durationMs),
        sampleCount: segment.samples.length,
        sourceSampleRate: segment.sampleRate,
        sourceChannels: segment.channels,
      })

      const encoded = encodeChunk(segment.samples, segment.channels, segment.sampleRate)
      if (!encoded) {
        // Empty chunk (encodeChunk only rejects zero-length sample arrays —
        // it has no silence threshold of its own) — nothing worth
        // transcribing or writing to the audio file. Recorded as an
        // already-resolved empty segment so ordering/merging still sees a
        // placeholder for this chunkIndex; not counted toward `attempted`,
        // so it can never make a channel look "failed."
        clog.event('chunk-empty-skipped')
        tracker.promises.push(Promise.resolve({ channel, text: '', startMs, endMs } as TimedChunkText))
        return
      }

      // Stream to disk BEFORE firing the STT call, synchronously — chunks
      // land in the file in cut order, and by the time we go async below,
      // `segment.samples` (this closure's only reference to the raw audio)
      // has already been dropped: encodeChunk() returned, so its locals are
      // gone, and this callback itself never stored `segment` anywhere.
      if (!tracker.writer) {
        try {
          const fileName = `audio-${channel}.wav`
          tracker.writer = new WavAppender(path.join(meetingDir, fileName), encoded.sampleRate)
          tracker.audioFileName = fileName
          clog.event('audio-file-opened', { fileName, sampleRate: encoded.sampleRate })
        } catch (e) {
          clog.error('could not open the audio file for writing', { error: (e as Error).message })
        }
      }
      if (tracker.writer) {
        if (tracker.writer.rate === encoded.sampleRate) {
          try {
            tracker.writer.append(encoded.wav.subarray(44)) // strip this chunk's own 44-byte header — only the FIRST write to the file carries one
          } catch (e) {
            clog.error('failed to append audio chunk to disk', { error: (e as Error).message })
          }
        } else {
          // Fail safe rather than silently concatenate mismatched-rate PCM
          // under one header (downmixAndResample never upsamples, so a
          // source that ever arrives at <= the target rate would encode at
          // its own, different rate) — still transcribe this chunk
          // normally below, just skip writing it into the shared file.
          clog.warn('chunk sample rate does not match this session\'s audio file — skipping the audio-file append for this chunk (still transcribing it)', {
            chunkSampleRate: encoded.sampleRate,
            fileSampleRate: tracker.writer.rate,
          })
        }
      }

      tracker.attempted++
      // Fired and tracked, NOT awaited here — feeding further chunks (and
      // the session generally) must never block on one chunk's network
      // round-trip. transcribeEncodedChunk() never rejects (it catches
      // internally), so this .then() chain always resolves, never throws
      // into an unhandled rejection.
      const p = transcribeEncodedChunk(channel, encoded).then((result) => {
        if (!result.failed) tracker.succeeded++
        return { channel, text: result.text, startMs, endMs } as TimedChunkText
      })
      tracker.promises.push(p)
    }
  }

  let micTracker: ChannelTracker = freshTracker()
  let systemTracker: ChannelTracker = freshTracker()
  let micEmitter = new PeriodicChunkEmitter(() => {})
  let systemEmitter = new PeriodicChunkEmitter(() => {})
  // Zoom active-speaker polling state (Task 3 of the speaker-attribution
  // plan). Per-session, exactly like micTracker/systemTracker above: reset
  // fresh in start(), snapshotted into a local const in stop() before any
  // async work, so a subsequent start() reassigning `zoomSpeakerSamples`
  // can never corrupt a still-in-flight previous session's persist chain.
  let zoomSpeakerSamples: SpeakerSample[] = []
  let zoomSpeakerPollTimer: ReturnType<typeof setInterval> | null = null
  /** Whether the CURRENT session was recognized as Zoom — same per-session
   *  reset/snapshot discipline as zoomSpeakerSamples, so stop()'s summary
   *  log can distinguish "not a Zoom call" from "was a Zoom call, polled,
   *  learned nothing" instead of both looking identical (zero samples). */
  let zoomSessionActive = false
  let sessionStartedAt = 0
  // Allocated at START, not at stop: the meeting's DB row is now written the
  // moment capture begins (see below), so the id has to exist that early and
  // the final insert must reuse it rather than mint a second one.
  let sessionMeetingId = ''
  // Log-only heartbeat counter, reset in start() — see the mic-chunk IPC
  // handler below.
  let micChunksReceived = 0

  class HookedNotetakerSession extends NotetakerSession {
    start(pid: number): AudioTapStartResult | undefined {
      sessionStartedAt = Date.now()
      sessionMeetingId = newMeetingId()
      micChunksReceived = 0
      const mlog = log.child({ meetingId: sessionMeetingId })
      mlog.event('capture-start-requested', { targetPid: pid })
      // Created eagerly (not lazily on first chunk) so the directory exists
      // before any WavAppender tries to open a file inside it — mkdir
      // failure is logged but never blocks capture from starting; a channel
      // whose WavAppender then fails to open just falls back to
      // transcription-only for that channel (see the try/catch above).
      const meetingDir = path.join(app.getPath('userData'), 'meetings', sessionMeetingId)
      try {
        fs.mkdirSync(meetingDir, { recursive: true })
      } catch (e) {
        mlog.error('could not create the meeting directory', { error: (e as Error).message })
      }
      micTracker = freshTracker()
      systemTracker = freshTracker()
      micEmitter = new PeriodicChunkEmitter(makeChunkHandler('mic', micTracker, meetingDir, mlog))
      systemEmitter = new PeriodicChunkEmitter(makeChunkHandler('system', systemTracker, meetingDir, mlog))
      let tapResult: AudioTapStartResult | undefined
      try {
        tapResult = super.start(pid) // throws if the tap won't start — no placeholder row in that case
      } catch (e) {
        mlog.error('native audio tap failed to start — capture did not begin (likely a TCC "System Audio Recording Only" denial)', {
          targetPid: pid,
          error: (e as Error).message,
        })
        throw e
      }
      // A global tap (see audiotap.mm's header comment for why it replaced
      // per-process pid targeting) can't fail to capture audio the way a
      // mistargeted per-process tap could — it captures everything except
      // whatever it excludes. The one thing still worth flagging is a
      // failure to exclude THIS app's own process (a feedback risk, not a
      // "captures nothing" risk), logged as a warning, not an error.
      if (tapResult && !tapResult.excludedOwnProcess) {
        mlog.warn('native audio tap started but could not exclude this app\'s own process from the global tap', {
          targetPid: pid,
          ownLookupStatus: tapResult.ownLookupStatus,
        })
      } else if (tapResult) {
        mlog.event('capture-started', {
          targetPid: pid,
          meetingDir,
          mode: tapResult.mode,
          excludedOwnProcess: tapResult.excludedOwnProcess,
        })
      } else {
        mlog.event('capture-started', { targetPid: pid, meetingDir })
      }
      // Zoom active-speaker polling (Task 3 of the speaker-attribution
      // plan) — only for a Zoom session, and only started once the tap has
      // actually started above (a failed tap start throws out of this
      // function before reaching here, so no interval is ever left running
      // for a session that never began). Placed after the tap-start
      // try/catch, not before it, for exactly that reason.
      // A fresh array object, not an in-place clear — critical so that the
      // `speakerSamplesForThisSession` const snapshotted in a PREVIOUS
      // session's stop() (see below) keeps pointing at that session's own
      // array forever, even after this line reassigns the outer `let` for
      // the new session. The interval below closes over THIS local
      // `samples` binding, not the reassignable outer `zoomSpeakerSamples`
      // — the same "capture the object, don't re-read a reassignable outer
      // variable" discipline this file's makeChunkHandler/tracker pattern
      // already uses, and for the identical reason: without it, correctness
      // would depend on invariants living in a different file/function
      // (NotetakerSession refusing a second concurrent start()) rather than
      // being safe by construction here.
      const samples: SpeakerSample[] = []
      zoomSpeakerSamples = samples
      // Guarded like resolveTargetPid's own listApps() call a few dozen
      // lines up — this file already treats that call as throwable, and an
      // uncaught throw HERE would propagate out of start() after the tap is
      // already live (active=true), skipping both the placeholder DB row
      // and hooks.onSessionStart?.() (the widget/mic) below — a much larger
      // blast radius than losing Zoom speaker attribution for one session.
      let isZoomSession = false
      try {
        isZoomSession = zoomAx.listApps().some((a) => a.pid === pid && a.bundleId === ZOOM_BUNDLE_ID)
      } catch (e) {
        mlog.warn('could not determine whether this is a Zoom session — speaker attribution disabled for it', {
          error: (e as Error).message,
        })
      }
      zoomSessionActive = isZoomSession
      if (isZoomSession) {
        // 12s, matching pollMeetingSignal's own throttled-while-active
        // cadence below (3000ms * ACTIVE_CAPTURE_POLL_DIVISOR) — NOT a
        // lighter version of the same "poll frequently, skip most ticks"
        // pattern, because unlike pollMeetingSignal there is no cheap
        // per-tick work this timer needs to keep doing on a skipped tick
        // (no debounce window to feed) — so the interval itself is just
        // set to the safe cadence directly. pollZoomSpeaker's AX-tree walk
        // is NOT cheap the way frontmostApp()/listApps() are (see the
        // NativeAx interface's own header comment) — it is exactly the
        // "heavy main-process work during a hot capture" class of call
        // pollMeetingSignal's own comment below warns can corrupt audio,
        // so it gets the same cadence, not a faster one.
        const ZOOM_SPEAKER_POLL_MS = 12000
        let lastLoggedSpeaker: string | null | undefined = undefined // undefined = never logged yet
        let firstPoll = true
        zoomSpeakerPollTimer = setInterval(() => {
          // Same "never do heavy main-process work while a capture is hot"
          // constraint pollMeetingSignal documents below.
          if (otherCaptureActive) return
          // Stamped before the walk, not after — pollZoomSpeaker's AX walk
          // can take real time (up to an 8s messaging timeout in the
          // native addon), and a sample timestamped after a slow walk could
          // land in the wrong transcript segment given Task 4's
          // startMs<=t<=endMs range matching.
          const timestampMs = Date.now()
          // `zoomAx: NativeAx` (now including `find`, per the interface
          // extension above) structurally satisfies zoomSpeaker.ts's
          // NativeAxLike — no cast needed.
          const result = pollZoomSpeaker(zoomAx)
          samples.push({ speakerName: result.speakerName, timestampMs })
          // Lightweight scalar diagnostics on EVERY poll (cheap, and the
          // whole reason they exist — see zoomSpeaker.ts's header comment
          // — is to tell apart "Zoom never resolved" (axError set) from
          // "resolved, found nodes, none matched" (nodesReturned>0,
          // candidateCount 0) from "resolved, found nothing at all"
          // (nodesReturned 0, axError null), none of which a change-only
          // log of just speakerName could distinguish). The full node list
          // is NOT logged every poll (too large over a whole meeting) —
          // only once, on the session's first poll, which is enough to see
          // the real tree shape for tuning the heuristic afterward.
          if (firstPoll) {
            firstPoll = false
            mlog.debug('zoom-speaker-poll-first-tree-dump', { allNodes: result.allNodes })
          }
          if (result.speakerName !== lastLoggedSpeaker) lastLoggedSpeaker = result.speakerName
          mlog.debug('zoom-speaker-poll', {
            speakerName: result.speakerName,
            candidateCount: result.candidateCount,
            rawCandidates: result.rawCandidates,
            nodesReturned: result.nodesReturned,
            totalWalked: result.totalWalked,
            axError: result.axError,
          })
        }, ZOOM_SPEAKER_POLL_MS)
        zoomSpeakerPollTimer.unref()
      }
      // A PLACEHOLDER ROW, WRITTEN IMMEDIATELY. Until this existed, the
      // meetings row was only inserted at the very END of
      // persistSession(), so an app quit or crash mid-meeting
      // erased the recording completely: no row, no audio, no error, nothing
      // in the UI to tell the user it had ever happened. Now a
      // status:'recording' row exists for the whole capture, so a meeting
      // interrupted by a crash still shows up in the Notetaker list in a
      // clearly-incomplete state. insertMeeting() is INSERT OR REPLACE, so the
      // real row written at the end of transcription overwrites this one in
      // place (same id) with the final title/status/paths.
      // ended_at is seeded to started_at (not 0) so list ordering and the
      // duration column stay sane while the meeting is still running.
      try {
        insertMeeting({
          id: sessionMeetingId,
          title: 'Recording…',
          started_at: sessionStartedAt,
          ended_at: sessionStartedAt,
          duration_ms: 0,
          status: 'recording',
          transcript_path: null,
          audio_mic_path: null,
          audio_system_path: null,
        })
      } catch (e) {
        // A failed placeholder row must never take down a capture that has
        // already started — the end-of-session insert is still the real one.
        mlog.error('could not write the in-progress meeting row', { error: (e as Error).message })
      }
      hooks.onSessionStart?.()
      return tapResult
    }
    stop(): void {
      const wasActive = this.isActive
      // Read before the async chain below so a subsequent start() can't
      // retarget this session's persist call — same reasoning now also
      // applies to the emitter/tracker snapshots just below.
      const meetingId = sessionMeetingId
      const startedAt = sessionStartedAt
      const mic = micTracker
      const system = systemTracker
      const micEm = micEmitter
      const systemEm = systemEmitter
      // Same snapshot-before-any-async-work discipline as mic/system/
      // meetingId/startedAt above: clear this session's own poll timer
      // (never a subsequent session's, since each start() creates its own
      // via the outer `let`) and capture the samples array into a local
      // const so a subsequent start() reassigning `zoomSpeakerSamples`
      // can't corrupt this session's still-in-flight persist chain below.
      if (zoomSpeakerPollTimer) {
        clearInterval(zoomSpeakerPollTimer)
        zoomSpeakerPollTimer = null
      }
      const speakerSamplesForThisSession = zoomSpeakerSamples
      const wasZoomSession = zoomSessionActive
      const mlog = log.child({ meetingId })
      mlog.event('capture-stop-requested', { wasActive })
      super.stop()
      if (wasActive) {
        hooks.onSessionStop?.()
        const endedAt = Date.now()
        mlog.event('capture-stopped', { durationMs: endedAt - startedAt })
        // flush() finalizes each channel's trailing partial segment by
        // firing onSegment ONE more time, through the exact same
        // makeChunkHandler path as any other cut — no special-casing needed,
        // and it lands in `mic`/`system`'s promises array like every other
        // chunk since those closures captured these exact tracker objects.
        micEm.flush()
        systemEm.flush()
        Promise.all([Promise.all(mic.promises), Promise.all(system.promises)])
          .then(([micChunks, systemChunks]) => {
            // Close both writers now that no more append() calls can
            // happen (flush() already fired, and every promise above has
            // settled) — this patches each file's WAV header with its
            // final byte count. A channel that never opened a writer (zero
            // real chunks) has nothing to close.
            try {
              mic.writer?.close()
            } catch (e) {
              mlog.error('failed to close the mic audio file', { error: (e as Error).message })
            }
            try {
              system.writer?.close()
            } catch (e) {
              mlog.error('failed to close the system audio file', { error: (e as Error).message })
            }
            // Partial-failure semantics: a channel is 'failed' only if it
            // was attempted at all AND every single attempt failed — one
            // transient STT blip in an hour-long meeting should not throw
            // away an otherwise-good transcript. A channel with zero
            // attempts (nothing captured/nothing but silence) is not
            // failed either, matching the old whole-session flow's
            // "empty channel is not a failure" semantics.
            const micFailed = mic.attempted > 0 && mic.succeeded === 0
            const systemFailed = system.attempted > 0 && system.succeeded === 0
            mlog.event('channels-summarized', {
              micChunks: mic.chunkIndex,
              micAttempted: mic.attempted,
              micSucceeded: mic.succeeded,
              micFailed,
              micHasAudioFile: !!mic.audioFileName,
              systemChunks: system.chunkIndex,
              systemAttempted: system.attempted,
              systemSucceeded: system.succeeded,
              systemFailed,
              systemHasAudioFile: !!system.audioFileName,
            })
            return persistSession(
              micChunks,
              systemChunks,
              meetingId,
              startedAt,
              endedAt,
              micFailed || systemFailed,
              mic.audioFileName,
              system.audioFileName,
              speakerSamplesForThisSession,
              wasZoomSession,
            )
          })
          .catch((e) => {
            mlog.error('failed to transcribe/persist session', { error: (e as Error).message })
          })
      }
    }
  }
  const session = new HookedNotetakerSession(nativeAudioTap, (chunk) => {
    if (chunk.source === 'mic') {
      micEmitter.feed(chunk.samples, chunk.sampleRate, chunk.channels, chunk.timestampMs)
    } else {
      systemEmitter.feed(chunk.samples, chunk.sampleRate, chunk.channels, chunk.timestampMs)
    }
  })

  // ── The MIC half of the recording (spec §2/§4) ──
  // getUserMedia only exists in a renderer, so the mic channel arrives here as
  // raw PCM from the floating widget — the one window that already holds an
  // open mic stream for exactly the capture window (see NotetakerWidget.tsx's
  // attachMicChunkTap). Without this handler feedMicChunk() had no production
  // caller at all and every saved meeting was a "them"-only transcript.
  //
  // No isActive guard here on purpose: NotetakerSession.feedMicChunk() already
  // returns early when the session is inactive, so a chunk still in flight
  // when a meeting ends is dropped by the session itself rather than by a
  // second, duplicate check that could drift out of sync with it.
  /** Heartbeat cadence, not every-chunk — mic chunks arrive ~12/sec, so
   *  logging every one would flood the file for no diagnostic gain. Every
   *  100th (~every 8s during active capture) is enough to prove the mic
   *  pipeline is alive without drowning the more interesting per-cut logs. */
  const MIC_CHUNK_LOG_EVERY = 100
  ipcMain.on('notetaker:mic-chunk', (_event, samples: unknown, sampleRate: unknown, timestampMs: unknown) => {
    const pcm = toFloat32(samples)
    if (!pcm || pcm.length === 0) {
      log.warn('mic-chunk dropped: could not decode samples payload', {
        meetingId: sessionMeetingId || undefined,
        sessionActive: session.isActive,
      })
      return
    }
    if (typeof sampleRate !== 'number' || !(sampleRate > 0)) {
      log.warn('mic-chunk dropped: invalid sampleRate', { sampleRate, meetingId: sessionMeetingId || undefined })
      return
    }
    if (!session.isActive) return // expected/silent: a straggler chunk after stop() — session itself also no-ops this
    micChunksReceived++
    if (micChunksReceived % MIC_CHUNK_LOG_EVERY === 1) {
      log.child({ meetingId: sessionMeetingId }).debug('mic-chunk heartbeat', { chunksReceivedThisSession: micChunksReceived, sampleCount: pcm.length, sampleRate })
    }
    session.feedMicChunk(pcm, sampleRate, typeof timestampMs === 'number' ? timestampMs : Date.now())
  })

  const controller = new NotetakerController({
    session,
    resolveTargetPid: () => resolveTargetPid(ax),
    showNotification: showNotetakerNotification,
    confirm: confirmNotetakerDialog,
  })

  // ── Manual chord trigger (Task 7's KeyboardManager events) ──
  keyboardManager.on('notes-start-requested', () => {
    log.event('chord-start-requested')
    controller
      .onNotesStartRequested()
      .catch((e) => {
        // The single most likely real-world failure here is a TCC
        // ("System Audio Recording Only") denial from session.start() —
        // silent otherwise, so the user gets no explanation for why nothing
        // happened. The no-resolvable-pid case already gets its own
        // notification from inside the controller; this covers the throw
        // path the controller deliberately does not catch.
        log.error('start failed', { error: (e as Error).message })
        showNotetakerNotification({
          title: 'Notetaker',
          body: 'Could not start note-taking (permission denied, or capture failed to start).',
        })
      })
      .finally(() => {
        // keyboard.ts sets notesActive = true BEFORE emitting
        // notes-start-requested (see maybeHandleNotesChordDown) — if
        // resolveTargetPid came back null, or session.start() threw,
        // capture never actually began. Resync the chord's own state back
        // to false so the NEXT double-tap starts a fresh attempt instead of
        // raising a "Stop note-taking?" dialog for a capture that never
        // existed. (When start DID succeed, session.isActive is true here
        // and this is correctly a no-op.)
        if (!session.isActive) keyboardManager.confirmNotesStop()
      })
  })
  keyboardManager.on('notes-stop-confirm-requested', () => {
    log.event('chord-stop-confirm-requested')
    controller
      .onNotesStopConfirmRequested()
      .then(() => {
        if (!session.isActive) keyboardManager.confirmNotesStop()
      })
      .catch((e) => log.error('stop-confirm failed', { error: (e as Error).message }))
  })

  // ── Widget's own two-click Cancel (spec §6/§7) ──
  // Wired DIRECTLY to session.stop(), not through
  // onNotesStopConfirmRequested(): the widget already collected its own
  // confirmation (click to reveal Cancel, click Cancel to fire) — see
  // desktop/electron/remote-preload.ts's notetakerCancelRequested comment
  // ("the confirm already happened in the renderer by the time this
  // fires"). Routing it through the controller's confirm() too would mean a
  // THIRD click (an OS dialog) on top of the two the user already made.
  ipcMain.on('notetaker:cancel-requested', () => {
    if (!session.isActive) return
    log.event('widget-cancel-clicked')
    session.stop()
    keyboardManager.confirmNotesStop()
  })

  // ── App quit while a meeting is being recorded ──
  // BEST EFFORT, NOT A GUARANTEE. stop() flushes both emitters and kicks off
  // per-chunk transcription + persistSession() — which does real network I/O
  // (managed STT, per chunk) — and Electron will not wait for those promises
  // before exiting, so a full save usually will NOT complete here. Any chunk
  // that already finished transcribing before quit is lost too, since
  // persistSession() only runs once ALL chunks (including the flush()
  // trailing partial) have settled. What this DOES buy: the tap is closed
  // cleanly, and the meeting's
  // placeholder row (written at start(), above) is already on disk, so the
  // interrupted meeting is visible in the Notetaker list as 'recording'
  // instead of vanishing without a trace. Anything more (a synchronous
  // flush-audio-to-disk-then-transcribe-on-next-launch path) is a real design
  // change, deliberately out of scope for this fix.
  app.on('before-quit', () => {
    if (!session.isActive) return
    log.child({ meetingId: sessionMeetingId }).event('quit-during-capture', { note: 'stopping the session — save is best-effort' })
    try {
      session.stop()
      keyboardManager.confirmNotesStop()
    } catch (e) {
      log.error('stop-on-quit failed', { error: (e as Error).message })
    }
  })

  // ── Capture-active gate for the poll loop below ──
  // Heavy main-process work while a capture is hot corrupts audio — the same
  // constraint sessionManager.ts's own pauseForCapture() call site documents
  // ("heavy main-process work while the microphone is hot corrupts the
  // audio... deliberately NOT awaited"). Nothing in this codebase exposes a
  // pollable "is a capture active right now" getter (sessionManager.ts has
  // exactly one public getter, `processing`, which means something
  // different — API calls in flight AFTER capture stops); the actual
  // existing signal is keyboardManager's own 'keyboard' channel, which
  // already emits a full 'key-state' snapshot (dictationActive/
  // instructionActive/remoteActive/agentActive) after every key event — the
  // same channel this file already listens to nothing on yet. Reusing that,
  // rather than adding a new getter to sessionManager.ts or inventing a
  // fresh signal.
  let otherCaptureActive = false
  keyboardManager.on('keyboard', (e) => {
    const k = e as unknown as {
      type?: string
      dictationActive?: boolean
      instructionActive?: boolean
      remoteActive?: boolean
      agentActive?: boolean
    }
    if (k.type !== 'key-state') return
    otherCaptureActive = !!(k.dictationActive || k.instructionActive || k.remoteActive || k.agentActive)
  })

  // ── Detection (MeetingWatcher, Task 3) ──
  const meetingWatcher = new MeetingWatcher({
    onMeetingStarted: () => {
      log.event('meeting-detected')
      controller.onMeetingDetected()
    },
    onMeetingEnded: () => {
      log.event('meeting-end-detected', { sessionWasActive: session.isActive })
      controller
        .onMeetingEnded()
        .then(() => {
          if (!session.isActive) keyboardManager.confirmNotesStop()
        })
        .catch((e) => log.error('meeting-ended handling failed', { error: (e as Error).message }))
    },
  })

  // Poll loop: readNowPlaying() (native app / bundle-ID signal, spec §2)
  // combined with the AppleScript tab-URL watcher (Task 2, spec §3) for
  // whichever SUPPORTED_APPLESCRIPT_BROWSERS browser is currently
  // frontmost.
  //
  // NOT WIRED: Chrome tab-URL detection. The plan (task-2-brief.md)
  // assumed "Chrome's tab URL is already reachable via the existing
  // unmute-in-chrome extension bridge... Task 9 wires that channel in" —
  // verified false on both counts researching this task: grepping this
  // entire repo turns up no Chrome-extension message-handling code
  // anywhere (the real unmute-in-chrome MV3 extension, per prior session
  // work, is a SEPARATE feature for driving Claude-in-Chrome/Codex browser
  // automation, not a passive tab-URL feed into this process), and Task 9's
  // own report never mentions Chrome. Building a bespoke channel now would
  // be exactly the "second detection path for Chrome" this task was told
  // not to build. Net effect: Chrome-hosted Google Meet/Zoom-web meetings
  // will NOT trigger the proactive detection prompt (meetingApps.ts
  // deliberately excludes com.google.Chrome from MEETING_APP_BUNDLE_IDS)
  // until a real bridge is built as separate follow-up work. The manual
  // chord trigger is completely unaffected — it never depends on detection
  // (spec §9).
  //
  // 3s: frequent enough that the watcher's 1.5s debounce settles within a
  // couple of polls, infrequent enough not to hammer osascript/native-ax on
  // every tick.
  //
  // An arrow function assigned to `const`, not a hoisted `function`
  // declaration — TypeScript's control-flow narrowing of `const ax` (from
  // the `if (!nativeAudioTap || !ax) return` guard above) does not carry
  // into a hoisted function's body (confirmed with `tsc --strict`: `ax`
  // reads back as `NativeAx | null` inside a `function` here), but does
  // carry into a `const` arrow function defined after the narrowing point.
  /** While the notetaker itself is recording, only every Nth tick actually
   *  polls — 3s * 4 = one sample every ~12s. See pollMeetingSignal below. */
  const ACTIVE_CAPTURE_POLL_DIVISOR = 4
  let ticksSinceStart = 0
  /** Last sample logged, so the poll loop only writes a line when something
   *  about the signal actually changed — a full log of every 3s tick would
   *  dwarf everything else in the file for no diagnostic value. Only the
   *  hostname of a tab URL is kept, never the full URL: a meeting URL's
   *  path/query often carries a join token, and this log file may end up
   *  read by someone other than the person who joined that meeting. */
  let lastLoggedSample = ''
  const pollMeetingSignal = async (): Promise<void> => {
    // NEVER do this work while a capture is hot (see the otherCaptureActive
    // comment above) — skip this tick entirely rather than delay it, the
    // next tick 3s later is not worth the risk of corrupting live audio.
    if (otherCaptureActive) return

    // The notetaker's OWN capture is a hot capture too: this tick spawns a
    // `perl` child process (readNowPlaying), makes a synchronous native-ax
    // frontmostApp() call, and may spawn `osascript` for the browser tab URL —
    // every 3 seconds, right through the user's meeting. That was harmless
    // while the captured audio was being discarded; now that the recording is
    // transcribed and saved (and the widget is holding a live mic), it is not.
    //
    // BUT this deliberately THROTTLES rather than skips outright. Hard-skipping
    // every tick while `session.isActive` would silently delete a whole stop
    // path: MeetingWatcher only emits onMeetingEnded after its signal flips
    // false, and NotetakerController.onMeetingEnded() early-returns unless
    // `session.isActive` — i.e. the ONLY situation that event exists for is
    // exactly the one a hard skip would stop feeding. A recording would then
    // never notice its meeting had ended. Backing the cadence off to every 4th
    // tick (~12s) removes ~75% of the main-process churn during a recording
    // while keeping end-detection alive (the watcher debounces on wall-clock
    // time, not on tick count, so it still flips after two throttled samples).
    ticksSinceStart++
    if (session.isActive && ticksSinceStart % ACTIVE_CAPTURE_POLL_DIVISOR !== 0) return
    try {
      const np = await readNowPlaying()
      let activeTabUrl: string | undefined
      const frontName = ax.frontmostApp()
      const browserName = SUPPORTED_APPLESCRIPT_BROWSERS.find((b: AppleScriptBrowser) => b === frontName)
      if (browserName) activeTabUrl = await getActiveTabUrl(browserName)

      let tabHost: string | undefined
      if (activeTabUrl) {
        try { tabHost = new URL(activeTabUrl).host } catch { tabHost = '<unparseable-url>' }
      }
      const sample = JSON.stringify({ frontName, playing: np?.playing ?? false, bundleId: np?.bundleIdentifier, tabHost })
      if (sample !== lastLoggedSample) {
        lastLoggedSample = sample
        log.debug('meeting-signal sample changed', {
          frontmostApp: frontName,
          nowPlayingBundleId: np?.bundleIdentifier,
          nowPlayingActive: np?.playing ?? false,
          browserWatched: browserName,
          activeTabHost: tabHost,
          meetingWatcherActive: meetingWatcher.isMeetingActive,
        })
      }

      meetingWatcher.feed({ nowPlaying: np ?? { playing: false }, activeTabUrl })
    } catch (e) {
      log.error('meeting-signal poll failed', { error: (e as Error).message })
    }
  }
  const MEETING_POLL_MS = 3000
  const pollTimer = setInterval(() => { void pollMeetingSignal() }, MEETING_POLL_MS)
  pollTimer.unref()

  // ── Renderer-side (widget) diagnostics, forwarded into this same log ──
  // getUserMedia, device selection, and the AudioWorklet-vs-ScriptProcessor
  // fallback all happen in the widget's renderer (NotetakerWidget.tsx) —
  // this just relays those events into the one durable notetaker log file so
  // "what was the source of the mic audio, and did it actually work" is
  // answerable from ONE place instead of a renderer devtools console that
  // closes when the widget window does. Never trusts the renderer's field
  // shapes — worst case a malformed payload just gets logged as-is.
  ipcMain.on('notetaker:widget-log', (_event, level: unknown, message: unknown, fields: unknown) => {
    const lvl = level === 'warn' || level === 'error' || level === 'debug' ? level : 'info'
    const msg = typeof message === 'string' ? message : String(message)
    const wlog = log.child({ meetingId: sessionMeetingId || undefined })
    wlog[lvl](msg, (fields && typeof fields === 'object' ? fields : undefined) as Record<string, unknown> | undefined)
  })

  log.event('wired', { logFile: getNotetakerLogFilePath() })
}
