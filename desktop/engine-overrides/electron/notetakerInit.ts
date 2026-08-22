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

import { Notification, dialog, ipcMain } from 'electron'
import { keyboardManager } from './keyboard'
import { MeetingWatcher } from './meetingWatcher'
import { NotetakerSession, type NativeAudioTap } from './notetakerSession'
import { NotetakerController } from './notetakerController'
import { readNowPlaying } from './mediaController'
import { getActiveTabUrl, SUPPORTED_APPLESCRIPT_BROWSERS, type AppleScriptBrowser } from './browserTabWatcher'

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
  class HookedNotetakerSession extends NotetakerSession {
    start(pid: number): void {
      super.start(pid)
      hooks.onSessionStart?.()
    }
    stop(): void {
      const wasActive = this.isActive
      super.stop()
      if (wasActive) hooks.onSessionStop?.()
    }
  }
  // Captured chunks have no downstream consumer yet — Tasks 1-9 built
  // detection + capture only (see the spec's own title); an actual notes
  // composer/transcript/persistence layer is not part of this plan. This is
  // a deliberate placeholder, not a forgotten wire-up.
  const session = new HookedNotetakerSession(nativeAudioTap, () => {})

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
  const pollMeetingSignal = async (): Promise<void> => {
    // NEVER do this work while a capture is hot (see the otherCaptureActive
    // comment above) — skip this tick entirely rather than delay it, the
    // next tick 3s later is not worth the risk of corrupting live audio.
    if (otherCaptureActive) return
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
