// The impure half of "pause background media while dictating".
//
// mediaPause.ts holds the decisions and is fully tested; this file is the part
// that talks to macOS: it spawns the bundled mediaremote-adapter through
// /usr/bin/perl. See mediaPause.ts for why an adapter is required at all and
// why the media key is not an acceptable substitute.
//
// LATENCY IS THE FEATURE. Measured on macOS 26.2: the perl round trip is ~67ms
// and audio actually resumes ~105-120ms after the command. The microphone
// itself takes ~195ms to acquire, so the pause lands BEFORE the user can speak
// — as long as nothing here is awaited on the capture path. Every entry point
// below is therefore fire-and-forget.

import { app } from 'electron'
import { execFile, execFileSync } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import Store from 'electron-store'
import {
  mediaActionOnCaptureStart, mediaActionOnCaptureEnd, mediaActionOnHold, mediaActionOnRelease,
  parseNowPlaying, MR_PLAY, MR_PAUSE,
} from './mediaPause'

/** Whether WE paused the media for a capture, and therefore owe a resume. */
let wePaused = false

/** Whether the user asked for quiet and has not asked for it back.
 *
 *  Deliberately a SECOND flag rather than a reuse of `wePaused`. The two debts
 *  are settled by different events — a capture ends on its own, a hold ends
 *  only when the user releases it or closes the surface — and folding them
 *  into one boolean is how a dictation would silently un-mute someone. */
let heldByUser = false

// The SAME store main-extensions writes the toggle into. Read fresh on every
// capture rather than cached at startup, so turning the setting on takes effect
// on the very next dictation instead of the next launch.
const settings = new Store<{ pauseMediaWhileDictating?: boolean }>({ name: 'unmute-paywall-settings' })

function pauseEnabled(): boolean {
  // Default ON. The whole point is that a dictation should not be talked over,
  // and a user who has not thought about it wants the good behaviour, not the
  // silence-corrupting one. It stays reversible in Settings.
  try { return settings.get('pauseMediaWhileDictating', true) === true } catch { return true }
}

// NEVER LEAVE SOMEONE'S MUSIC PAUSED BECAUSE UNMUTE WENT AWAY.
//
// Nothing here holds a lock, a device, or any system state — a pause is one
// command sent to the media app, and the perl child exits immediately. The only
// thing Unmute keeps is the memory that it owes a resume, and the failure that
// memory could cause is playback left paused. So the last thing the app does on
// its way out is settle that debt, synchronously, because there is no event
// loop left to await on.
app.on('before-quit', () => {
  if (!wePaused && !heldByUser) return
  wePaused = false
  heldByUser = false
  const paths = adapterPaths()
  if (!paths) return
  try {
    execFileSync('/usr/bin/perl', [paths.perlScript, paths.framework, 'send', String(MR_PLAY)],
      { timeout: 1500, stdio: 'ignore' })
    console.log('[media] resumed on quit — Unmute never keeps your audio')
  } catch { /* quitting anyway; nothing left to recover to */ }
})

function adapterPaths(): { perlScript: string; framework: string } | null {
  const base = app.isPackaged
    ? join(process.resourcesPath, 'mediaremote-adapter')
    : join(app.getAppPath(), 'vendor', 'mediaremote-adapter')
  const perlScript = join(base, 'mediaremote-adapter.pl')
  const framework = join(base, 'MediaRemoteAdapter.framework')
  // Absent adapter is not an error: the feature simply does nothing. It is
  // opt-in, and a missing vendor directory must never break dictation.
  if (!existsSync(perlScript) || !existsSync(framework)) return null
  return { perlScript, framework }
}

function runAdapter(args: string[], timeoutMs: number): Promise<string | null> {
  const paths = adapterPaths()
  if (!paths) return Promise.resolve(null)
  return new Promise((resolve) => {
    execFile('/usr/bin/perl', [paths.perlScript, paths.framework, ...args], { timeout: timeoutMs },
      (err, stdout) => resolve(err ? null : stdout))
  })
}

/** What is playing, as macOS understands it. Null when we cannot tell. */
export async function readNowPlaying(): Promise<ReturnType<typeof parseNowPlaying>> {
  const out = await runAdapter(['get'], 2000)
  return out === null ? null : parseNowPlaying(out)
}

/**
 * Pause background media for this capture, if the user asked for that and
 * something is actually playing.
 *
 * NOT awaited by the caller. A dictation must never wait on a child process,
 * and a failure here must never surface as a broken capture.
 */
export function pauseForCapture(): void {
  const enabled = pauseEnabled()
  if (!enabled) return
  void (async () => {
    try {
      const np = await readNowPlaying()
      const action = mediaActionOnCaptureStart({ enabled, audioPlaying: np?.playing === true })
      if (action !== 'pause') return
      await runAdapter(['send', String(MR_PAUSE)], 2000)
      wePaused = true
      console.log(`[media] paused ${np?.bundleIdentifier ?? 'now playing'} for dictation`)
    } catch (e) {
      console.warn('[media] pause skipped:', e instanceof Error ? e.message : e)
    }
  })()
}

/**
 * Give back exactly what we took, and nothing else.
 *
 * The state is re-read rather than assumed: if the user hit play themselves
 * during the dictation, resuming would start a second player rather than
 * restore anything, so we leave it alone.
 */
export function resumeAfterCapture(): void {
  if (!wePaused) return
  void (async () => {
    try {
      const np = await readNowPlaying()
      const action = mediaActionOnCaptureEnd({
        wePaused: true, audioPlaying: np?.playing === true, heldByUser,
      })
      wePaused = false
      if (action !== 'resume') {
        console.log('[media] not resuming — playback changed during the dictation')
        return
      }
      await runAdapter(['send', String(MR_PLAY)], 2000)
      console.log('[media] resumed after dictation')
    } catch (e) {
      wePaused = false
      console.warn('[media] resume skipped:', e instanceof Error ? e.message : e)
    }
  })()
}

/** Is the room being held quiet right now? The control's label follows this. */
export function isBackgroundAudioHeld(): boolean { return heldByUser }

/**
 * Mute the background on demand, for as long as the user wants it muted.
 *
 * Not the dictation path and not gated by its setting: this is an explicit
 * press, so the preference about whether Unmute may pause things *for a
 * capture* has no bearing on it.
 *
 * Fire-and-forget, like everything else here — a control must not wait on a
 * perl round trip to look pressed.
 */
export function holdBackgroundAudio(): void {
  void (async () => {
    try {
      const np = await readNowPlaying()
      const action = mediaActionOnHold({ heldByUser, audioPlaying: np?.playing === true })
      if (action !== 'pause') return
      await runAdapter(['send', String(MR_PAUSE)], 2000)
      // Recorded ONLY once the pause actually went out, so a hold that found
      // silence leaves no debt to "resume" into music nobody was playing.
      heldByUser = true
      console.log(`[media] holding ${np?.bundleIdentifier ?? 'now playing'} — user asked for quiet`)
    } catch (e) {
      console.warn('[media] hold skipped:', e instanceof Error ? e.message : e)
    }
  })()
}

/**
 * Give the room back.
 *
 * Called on a second press AND when the surface carrying the control closes.
 * Closing must release: a mute the user cannot see is a mute they cannot undo,
 * and leaving one behind is the same broken promise as leaving music paused
 * after a dictation.
 */
export function releaseBackgroundAudio(): void {
  if (!heldByUser) return
  void (async () => {
    try {
      const np = await readNowPlaying()
      const action = mediaActionOnRelease({ heldByUser: true, audioPlaying: np?.playing === true })
      heldByUser = false
      if (action !== 'resume') {
        console.log('[media] not resuming — playback changed while it was held')
        return
      }
      await runAdapter(['send', String(MR_PLAY)], 2000)
      console.log('[media] released the hold')
    } catch (e) {
      heldByUser = false
      console.warn('[media] release skipped:', e instanceof Error ? e.message : e)
    }
  })()
}
