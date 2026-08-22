// desktop/engine-overrides/electron/notetakerController.ts
//
// Composition-root glue: wires MeetingWatcher's detection events and
// KeyboardManager's chord events to NotetakerSession, per spec §6
// (docs/superpowers/specs/2026-08-23-meeting-notetaker-detection-capture.md).
// Detection only ever prompts — it never auto-starts capture. Stopping via
// the chord or a detected meeting-end is always a confirm; the widget's own
// two-click Cancel (spec §6/§7) is a SEPARATE resolution path that the
// composition root wires directly to session.stop() (the confirm already
// happened in the renderer — see electron/remote-preload.ts's
// notetakerCancelRequested comment), not through this controller.
//
// This class is pure logic (no Electron imports), so it is fully unit
// tested. The real wiring — real Notification, a real confirm dialog, the
// real NotetakerSession backed by unmute-native-audio-tap, and real
// MeetingWatcher/KeyboardManager event plumbing — lives in
// desktop/engine-overrides/electron/notetakerInit.ts (Electron glue, not
// unit-tested, exactly like every other feature wired in there). NOT
// desktop/electron/remote/init.ts — see notetakerInit.ts's own file header
// for why (that file's opaque-injected-dependency design + the copy-time
// directory layout make a direct cross-tree import from init.ts
// unresolvable both locally and after the build's engine-overrides copy).

import type { NotetakerSession } from './notetakerSession'

export type NotetakerControllerDeps = {
  session: NotetakerSession
  /**
   * Resolves the pid to target when a capture is about to start.
   *
   * DIVERGES FROM THE ORIGINAL PLAN SKETCH, which typed this as a plain
   * `() => number | null`. The real resolver goes through native-ax's
   * frontmostApp()/listApps(), which run on a dedicated worker thread
   * (desktop/electron/remote/ax/ax-bridge.ts — AX tree walks can take up to
   * 8s and must never block the Electron main thread, which also carries
   * latency-sensitive dictation audio) and are therefore inherently
   * asynchronous. Widened to allow either shape so a synchronous fake (as
   * used in this file's own tests) keeps working unchanged; always
   * `await`ed internally.
   */
  resolveTargetPid: () => number | null | Promise<number | null>
  showNotification: (opts: { title: string; body?: string; onClick?: () => void }) => void
  confirm: (message: string) => Promise<boolean>
}

export class NotetakerController {
  private readonly deps: NotetakerControllerDeps

  constructor(deps: NotetakerControllerDeps) {
    this.deps = deps
  }

  onMeetingDetected(): void {
    this.deps.showNotification({
      title: "Looks like you're in a meeting",
      body: 'Double-tap Control+Option to start notes.',
    })
  }

  /**
   * A detected meeting has ended. Spec §6: this drives the SAME confirm-to-
   * stop prompt as the chord double-tap while active — never auto-stops.
   *
   * Returns the settled promise (the original sketch fired-and-forgot this
   * internally) so the composition root can sequence
   * `keyboardManager.confirmNotesStop()` after a stop has actually
   * happened, keeping the chord's own `notesActive` flag in sync with
   * reality rather than only with its own double-tap.
   */
  onMeetingEnded(): Promise<void> {
    if (!this.deps.session.isActive) return Promise.resolve()
    return this.onNotesStopConfirmRequested()
  }

  async onNotesStartRequested(): Promise<void> {
    const pid = await this.deps.resolveTargetPid()
    if (pid == null) {
      this.deps.showNotification({ title: 'Notetaker', body: 'Could not find a target app to capture.' })
      return
    }
    this.deps.session.start(pid)
  }

  async onNotesStopConfirmRequested(): Promise<void> {
    const confirmed = await this.deps.confirm('Stop note-taking?')
    if (confirmed) {
      this.deps.session.stop()
    }
  }
}
