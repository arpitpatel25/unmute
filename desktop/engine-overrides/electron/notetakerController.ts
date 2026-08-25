// desktop/engine-overrides/electron/notetakerController.ts
//
// Composition-root glue: wires MeetingWatcher's detection events and
// KeyboardManager's chord events to NotetakerSession, per spec §6
// (docs/superpowers/specs/2026-08-23-meeting-notetaker-detection-capture.md).
// Detection only ever prompts — it never auto-starts capture. A detected
// meeting-end is always a native confirm dialog; the widget's own two-click
// Cancel (spec §6/§7) is a SEPARATE resolution path that the composition
// root wires directly to session.stop() (the confirm already happened in
// the renderer — see electron/remote-preload.ts's notetakerCancelRequested
// comment), not through this controller.
//
// The key's own single-tap stop is a THIRD path, revised after the first
// shipped cut removed its confirmation dialog entirely and a live user test
// found that too easy to trigger by accident with nothing to undo. Rather
// than bring the dialog back (which would make ending a meeting the one
// notetaker action that blocks on a click), a single tap now arms a short
// on-screen undo window — see onNotesStopRequested below — so ending a
// meeting stays a single keystroke, but a mistaken one is still recoverable.
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
  /** How long the key's own single-tap stop waits, undone, before it
   *  actually stops the session. Real value lives in notetakerInit.ts;
   *  tests pass a small one so they don't sleep for real seconds. */
  stopGraceMs: number
  /** Fires synchronously whenever the undo window arms or clears, so the
   *  composition root can drive the widget's on-screen tint (see
   *  notetakerWidget.ts's broadcastStopPending). Never fires for the OTHER
   *  two stop paths (the confirm dialog, the widget's own two-click
   *  Cancel) — both already resolve their own confirmation before this
   *  class ever sees them. */
  onStopPendingChanged: (pending: boolean) => void
  /** Fires once the key's undo window elapses and the session has actually
   *  stopped — the ONLY moment `keyboardManager.confirmNotesStop()` may run
   *  for this path, since notesActive must stay true for the whole undo
   *  window (a stray double-tap mid-window must not read as a fresh
   *  session start). */
  onStopFinalized: () => void
}

export class NotetakerController {
  private readonly deps: NotetakerControllerDeps
  private stopTimer: ReturnType<typeof setTimeout> | null = null

  constructor(deps: NotetakerControllerDeps) {
    this.deps = deps
  }

  /** Whether the key's single-tap stop is currently in its undo window.
   *  Exposed for callers that stop the session through some OTHER path
   *  (widget Cancel, app quit) and need to know whether a stray timer is
   *  still armed underneath them — see cancelPendingStop's own comment. */
  get isStopPending(): boolean {
    return this.stopTimer !== null
  }

  onMeetingDetected(): void {
    this.deps.showNotification({
      title: "Looks like you're in a meeting",
      body: 'Double-tap left Control to start notes.',
    })
  }

  /**
   * A detected meeting has ended. Unmute noticed this itself (the user did
   * not ask to stop), so it still asks before stopping — this is a
   * DIFFERENT resolution from the key's own single-tap stop below, and
   * supersedes it: any undo window the key already armed is cleared first,
   * since a meeting that has genuinely ended has nothing left to keep
   * recording into.
   *
   * Returns the settled promise (the original sketch fired-and-forgot this
   * internally) so the composition root can sequence
   * `keyboardManager.confirmNotesStop()` after a stop has actually
   * happened, keeping the key's own `notesActive` flag in sync with
   * reality rather than only with its own tap.
   */
  onMeetingEnded(): Promise<void> {
    if (!this.deps.session.isActive) return Promise.resolve()
    this.cancelPendingStop()
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

  /**
   * The key's own single-tap stop. The FIRST tap while a meeting is
   * running does not stop anything yet — it arms a short undo window
   * (recording keeps running throughout it) and lets the composition root
   * know so the widget can tint. A SECOND tap before the window elapses is
   * read as "keep recording": it cancels the pending stop and nothing
   * happens. No second tap at all lets the window elapse, which finalizes
   * the stop exactly as the original direct-stop design did.
   *
   * This means every tap while the session is active still funnels through
   * this one method (mirrors the original design exactly) — it is this
   * method's OWN pending state, not the caller, that decides whether a given
   * tap arms or cancels.
   */
  onNotesStopRequested(): void {
    if (!this.deps.session.isActive) return
    if (this.stopTimer !== null) {
      this.cancelPendingStop()
      return
    }
    this.stopTimer = setTimeout(() => {
      this.stopTimer = null
      this.deps.onStopPendingChanged(false)
      this.deps.session.stop()
      this.deps.onStopFinalized()
    }, this.deps.stopGraceMs)
    this.deps.onStopPendingChanged(true)
  }

  /**
   * Clears an armed undo window WITHOUT stopping the session — both the
   * key's own "tap again to keep recording" resolution, and a defensive
   * call from every OTHER path that can stop the session for real
   * (onMeetingEnded above; the widget's direct-cancel and app-quit paths in
   * notetakerInit.ts). Without those defensive calls, a stop finalized
   * through one of those other paths would leave this timer armed — and if
   * the user then double-tapped to start a brand-new meeting before it
   * fired, the stale timer would later call session.stop() on THAT new
   * session out from under them.
   */
  cancelPendingStop(): void {
    if (this.stopTimer === null) return
    clearTimeout(this.stopTimer)
    this.stopTimer = null
    this.deps.onStopPendingChanged(false)
  }
}
