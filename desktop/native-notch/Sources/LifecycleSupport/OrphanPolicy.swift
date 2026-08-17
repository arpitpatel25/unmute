// THE SURFACE MUST NOT OUTLIVE THE APP — EVEN WHEN THE APP DIES BADLY.
//
// The notch is a separate process, spawned as an ordinary child. On macOS a
// child does not die with its parent: it is reparented to launchd and keeps
// running. Its window sits at `level = .screenSaver`, above every other window
// on the display, and it is non-activating — so an orphaned notch is a surface
// floating over everything with nothing driving it.
//
// Two things were supposed to prevent that, and both only cover the happy path:
//
//   * The app disposes the notch client on `before-quit`. That fires on a clean
//     quit and NOT on a crash, an abort, or a force-quit — and a crash is
//     exactly when this matters. There is a SIGABRT in the field to prove it.
//   * The reader thread notices stdin EOF and dispatches `.quit` to the MAIN
//     QUEUE. If the main thread is wedged — which is the reported symptom — that
//     message is never serviced and the process stays up.
//
// So the escape hatch depended on the thread that was stuck, and the cleanup
// depended on the parent exiting politely. Users were left force-quitting the
// app (which never matches `unmute-notch`) and then rebooting the machine.
//
// What is reliable instead: the kernel. A dead parent means our ppid becomes 1,
// and nothing has to be delivered to us for that to be true. Polling it from a
// background thread survives a wedged main thread, a SIGKILLed parent, and a
// crashed parent alike. Paired with a hard exit that does not route through
// AppKit, the surface can no longer strand itself.

import Foundation

/// True when this process has no live parent.
///
/// macOS reparents an orphan to launchd (pid 1). A ppid of 0 is not a real
/// parent either — treating it as alive is how a surface would stay on screen
/// forever, so it counts as orphaned too.
public func isOrphaned(parentPid: Int32) -> Bool {
    parentPid <= 1
}

/// How to shut down once the parent is known to be gone.
public struct ShutdownPlan: Equatable {
    /// Ask AppKit to tear down normally first, so a healthy process still gets
    /// an orderly exit (windows removed, terminal detached, state flushed).
    public let attemptGraceful: Bool
    /// …and exit unconditionally after this long regardless, from a thread that
    /// is not the main queue. THIS is what a wedged main thread cannot block.
    public let hardExitAfterMs: Int

    public init(attemptGraceful: Bool, hardExitAfterMs: Int) {
        self.attemptGraceful = attemptGraceful
        self.hardExitAfterMs = hardExitAfterMs
    }
}

/// The backstop is never optional. A grace period of zero still arms a hard
/// exit — "be polite" must never be able to become "stay forever".
public func shutdownPlan(graceMs: Int) -> ShutdownPlan {
    ShutdownPlan(attemptGraceful: true, hardExitAfterMs: max(graceMs, 100))
}

/// Default grace: long enough for an orderly AppKit teardown on a healthy
/// process, short enough that a stranded surface is gone before anyone reaches
/// for the power button.
public let defaultOrphanGraceMs = 800

/// How often to ask the kernel who our parent is. Cheap (one syscall) and off
/// the main thread, so this cannot contribute to the load it guards against.
public let orphanPollIntervalMs = 1000
