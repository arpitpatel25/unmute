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
import { NotetakerSession, type NativeAudioTap } from './notetakerSession'
import { NotetakerController } from './notetakerController'
import { readNowPlaying } from './mediaController'
import { getActiveTabUrl, SUPPORTED_APPLESCRIPT_BROWSERS, type AppleScriptBrowser } from './browserTabWatcher'
import { PeriodicChunkEmitter, type FinalizedSegment } from './notetaker/periodicChunkEmitter'
import { encodeChunk, transcribeEncodedChunk, persistSession, newMeetingId } from './notetaker/transcribeSession'
import type { TimedChunkText } from './notetaker/transcriptMerge'
import { WavAppender } from './notetaker/wavAppender'
import { getMeetings, getMeeting, updateMeetingTitle, deleteMeeting, insertMeeting } from './db'

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
 * frontmostApp()/listApps() are cheap NSWorkspace/CGWindowList enumerations
 * (native-ax/src/ax.mm:364,379 — no AX tree walk at all), fast enough to
 * call directly and synchronously on the main thread, same as this file's
 * sibling mediaController.ts's synchronous-feeling (if child-process-backed)
 * readNowPlaying().
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
}

function loadNativeAx(): NativeAx | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('unmute-native-ax') as NativeAx
  } catch (e) {
    console.warn('[notetaker] unmute-native-ax unavailable — cannot resolve a capture target:', (e as Error).message)
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
    if (!frontName) return null
    const match = ax.listApps().find((a) => a.name === frontName)
    return match ? match.pid : null
  } catch (e) {
    console.warn('[notetaker] resolveTargetPid failed:', (e as Error).message)
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
    if (!Notification.isSupported()) return
    const n = new Notification({ title: opts.title, body: opts.body ?? '' })
    if (opts.onClick) n.on('click', opts.onClick)
    n.show()
  } catch (e) {
    console.warn('[notetaker] notification failed:', (e as Error).message)
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
    return result.response === 0
  } catch (e) {
    console.warn('[notetaker] confirm dialog failed:', (e as Error).message)
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
    return getMeetings()
  })

  ipcMain.handle('notetaker:get-transcript', (_event, id: string) => {
    const meeting = getMeeting(id)
    if (!meeting || !meeting.transcript_path) return []
    const meetingDir = path.join(app.getPath('userData'), 'meetings', id)
    try {
      const raw = fs.readFileSync(path.join(meetingDir, meeting.transcript_path), 'utf8')
      return JSON.parse(raw)
    } catch {
      return []
    }
  })

  ipcMain.handle('notetaker:rename-meeting', (_event, id: string, title: string) => {
    updateMeetingTitle(id, title)
  })

  ipcMain.handle('notetaker:delete-meeting', (_event, id: string) => {
    deleteMeeting(id)
  })

  ipcMain.handle('notetaker:get-audio-url', (_event, id: string, channel: 'mic' | 'system') => {
    const meeting = getMeeting(id)
    if (!meeting) return null
    const relPath = channel === 'mic' ? meeting.audio_mic_path : meeting.audio_system_path
    if (!relPath) return null
    const fullPath = path.join(app.getPath('userData'), 'meetings', id, relPath)
    if (!fs.existsSync(fullPath)) return null
    return `file://${fullPath}`
  })

  let nativeAudioTap: NativeAudioTap | null = null
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    nativeAudioTap = require('unmute-native-audio-tap') as NativeAudioTap
  } catch (e) {
    console.warn('[notetaker] unmute-native-audio-tap unavailable — meeting notetaker disabled:', (e as Error).message)
  }
  const ax = loadNativeAx()
  if (!nativeAudioTap || !ax) return

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
  }

  function freshTracker(): ChannelTracker {
    return { promises: [], attempted: 0, succeeded: 0, writer: null, audioFileName: null }
  }

  function makeChunkHandler(channel: 'mic' | 'system', tracker: ChannelTracker, meetingDir: string): (segment: FinalizedSegment) => void {
    return (segment: FinalizedSegment) => {
      const startMs = segment.startTimestampMs
      const durationMs =
        segment.sampleRate > 0 && segment.channels > 0
          ? (segment.samples.length / segment.channels / segment.sampleRate) * 1000
          : 0
      const endMs = startMs + durationMs

      const encoded = encodeChunk(segment.samples, segment.channels, segment.sampleRate)
      if (!encoded) {
        // Near-silent/empty chunk (per encodeChunk's own threshold) —
        // nothing worth transcribing or writing to the audio file. Recorded
        // as an already-resolved empty segment so ordering/merging still
        // sees a placeholder for this chunkIndex; not counted toward
        // `attempted`, so it can never make a channel look "failed."
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
        } catch (e) {
          console.warn(`[notetaker] could not open the ${channel} audio file for writing:`, (e as Error).message)
        }
      }
      if (tracker.writer) {
        if (tracker.writer.rate === encoded.sampleRate) {
          try {
            tracker.writer.append(encoded.wav.subarray(44)) // strip this chunk's own 44-byte header — only the FIRST write to the file carries one
          } catch (e) {
            console.warn(`[notetaker] failed to append a ${channel} audio chunk to disk:`, (e as Error).message)
          }
        } else {
          // Fail safe rather than silently concatenate mismatched-rate PCM
          // under one header (downmixAndResample never upsamples, so a
          // source that ever arrives at <= the target rate would encode at
          // its own, different rate) — still transcribe this chunk
          // normally below, just skip writing it into the shared file.
          console.warn(`[notetaker] ${channel} chunk encoded at ${encoded.sampleRate}Hz, this session's audio file is ${tracker.writer.rate}Hz — skipping the audio-file append for this chunk (still transcribing it)`)
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
  let sessionStartedAt = 0
  // Allocated at START, not at stop: the meeting's DB row is now written the
  // moment capture begins (see below), so the id has to exist that early and
  // the final insert must reuse it rather than mint a second one.
  let sessionMeetingId = ''

  class HookedNotetakerSession extends NotetakerSession {
    start(pid: number): void {
      sessionStartedAt = Date.now()
      sessionMeetingId = newMeetingId()
      // Created eagerly (not lazily on first chunk) so the directory exists
      // before any WavAppender tries to open a file inside it — mkdir
      // failure is logged but never blocks capture from starting; a channel
      // whose WavAppender then fails to open just falls back to
      // transcription-only for that channel (see the try/catch above).
      const meetingDir = path.join(app.getPath('userData'), 'meetings', sessionMeetingId)
      try {
        fs.mkdirSync(meetingDir, { recursive: true })
      } catch (e) {
        console.warn('[notetaker] could not create the meeting directory:', (e as Error).message)
      }
      micTracker = freshTracker()
      systemTracker = freshTracker()
      micEmitter = new PeriodicChunkEmitter(makeChunkHandler('mic', micTracker, meetingDir))
      systemEmitter = new PeriodicChunkEmitter(makeChunkHandler('system', systemTracker, meetingDir))
      super.start(pid) // throws if the tap won't start — no placeholder row in that case
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
        console.warn('[notetaker] could not write the in-progress meeting row:', (e as Error).message)
      }
      hooks.onSessionStart?.()
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
      super.stop()
      if (wasActive) {
        hooks.onSessionStop?.()
        const endedAt = Date.now()
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
              console.warn('[notetaker] failed to close the mic audio file:', (e as Error).message)
            }
            try {
              system.writer?.close()
            } catch (e) {
              console.warn('[notetaker] failed to close the system audio file:', (e as Error).message)
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
            return persistSession(
              micChunks,
              systemChunks,
              meetingId,
              startedAt,
              endedAt,
              micFailed || systemFailed,
              mic.audioFileName,
              system.audioFileName,
            )
          })
          .catch((e) => {
            console.error('[notetaker] failed to transcribe/persist session:', (e as Error).message)
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
  ipcMain.on('notetaker:mic-chunk', (_event, samples: unknown, sampleRate: unknown, timestampMs: unknown) => {
    const pcm = toFloat32(samples)
    if (!pcm || pcm.length === 0) return
    if (typeof sampleRate !== 'number' || !(sampleRate > 0)) return
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
    controller
      .onNotesStartRequested()
      .catch((e) => {
        // The single most likely real-world failure here is a TCC
        // ("System Audio Recording Only") denial from session.start() —
        // silent otherwise, so the user gets no explanation for why nothing
        // happened. The no-resolvable-pid case already gets its own
        // notification from inside the controller; this covers the throw
        // path the controller deliberately does not catch.
        console.warn('[notetaker] start failed:', (e as Error).message)
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
    controller
      .onNotesStopConfirmRequested()
      .then(() => {
        if (!session.isActive) keyboardManager.confirmNotesStop()
      })
      .catch((e) => console.warn('[notetaker] stop-confirm failed:', (e as Error).message))
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
    console.log('[notetaker] app is quitting during a capture — stopping the session (save is best-effort)')
    try {
      session.stop()
      keyboardManager.confirmNotesStop()
    } catch (e) {
      console.warn('[notetaker] stop-on-quit failed:', (e as Error).message)
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
    onMeetingStarted: () => controller.onMeetingDetected(),
    onMeetingEnded: () => {
      controller
        .onMeetingEnded()
        .then(() => {
          if (!session.isActive) keyboardManager.confirmNotesStop()
        })
        .catch((e) => console.warn('[notetaker] meeting-ended handling failed:', (e as Error).message))
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
      meetingWatcher.feed({ nowPlaying: np ?? { playing: false }, activeTabUrl })
    } catch (e) {
      console.warn('[notetaker] meeting-signal poll failed:', (e as Error).message)
    }
  }
  const MEETING_POLL_MS = 3000
  const pollTimer = setInterval(() => { void pollMeetingSignal() }, MEETING_POLL_MS)
  pollTimer.unref()

  console.log('[notetaker] wired')
}
