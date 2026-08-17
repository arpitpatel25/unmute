import Foundation
import LifecycleSupport

/// Tying this process's life to its parent's, by means that survive a wedged
/// main thread. The policy (and why it exists) is in LifecycleSupport.
enum Lifecycle {

    /// Begin shutting down. Tries an orderly AppKit teardown, then exits
    /// unconditionally from a detached thread whether or not that worked.
    ///
    /// The hard exit is the point. `exit()` here does not route through the run
    /// loop, so a main thread stuck in a syscall, a layout storm, or a deadlock
    /// cannot keep the window on screen — and when the process dies, WindowServer
    /// removes its windows with it.
    static func shutdownNow(reason: String, onCommand: ((Command) -> Void)? = nil) {
        NotchLog.log("lifecycle: shutting down (\(reason))")
        let plan = shutdownPlan(graceMs: defaultOrphanGraceMs)
        if plan.attemptGraceful, let onCommand {
            DispatchQueue.main.async { onCommand(.quit) }
        }
        Thread.detachNewThread {
            Thread.sleep(forTimeInterval: Double(plan.hardExitAfterMs) / 1000.0)
            NotchLog.log("lifecycle: hard exit (\(reason)) — graceful teardown did not complete")
            exit(0)
        }
    }

    /// Watch for losing our parent, independently of stdin.
    ///
    /// stdin EOF covers the ordinary case, but it is a delivery: it can be missed
    /// if the descriptor is inherited oddly or held open elsewhere. Reparenting to
    /// launchd is not a delivery — it is a fact the kernel will tell us whenever we
    /// ask. One syscall a second, off the main thread.
    static func startOrphanWatchdog(onCommand: @escaping (Command) -> Void) {
        Thread.detachNewThread {
            while true {
                Thread.sleep(forTimeInterval: Double(orphanPollIntervalMs) / 1000.0)
                if isOrphaned(parentPid: getppid()) {
                    Lifecycle.shutdownNow(reason: "orphaned", onCommand: onCommand)
                    return
                }
            }
        }
    }
}
