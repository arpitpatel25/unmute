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
import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import Store from 'electron-store'
import { mediaActionOnCaptureStart, mediaActionOnCaptureEnd, parseNowPlaying, MR_PLAY, MR_PAUSE } from './mediaPause'

/** Whether WE paused the media, and therefore owe the user a resume. */
let wePaused = false

// The SAME store main-extensions writes the toggle into. Read fresh on every
// capture rather than cached at startup, so turning the setting on takes effect
// on the very next dictation instead of the next launch.
const settings = new Store<{ pauseMediaWhileDictating?: boolean }>({ name: 'unmute-paywall-settings' })

function pauseEnabled(): boolean {
  try { return settings.get('pauseMediaWhileDictating', false) === true } catch { return false }
}

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
      const action = mediaActionOnCaptureEnd({ wePaused: true, audioPlaying: np?.playing === true })
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
