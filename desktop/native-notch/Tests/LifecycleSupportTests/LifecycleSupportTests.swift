import XCTest
@testable import LifecycleSupport

final class OrphanPolicyTests: XCTestCase {

    // On macOS a child whose parent dies is reparented to launchd (pid 1).
    // That is the one signal that survives a wedged main thread, a SIGKILLed
    // parent, and a crashed parent alike — nothing has to be delivered to us.
    func testReparentedToLaunchdMeansOrphaned() {
        XCTAssertTrue(isOrphaned(parentPid: 1))
    }

    func testALiveParentIsNotOrphaned() {
        XCTAssertFalse(isOrphaned(parentPid: 4242))
    }

    // Defensive: a ppid of 0 is not a real parent either. Treating it as alive
    // would leave the surface on screen forever, which is the whole failure.
    func testMissingParentCountsAsOrphaned() {
        XCTAssertTrue(isOrphaned(parentPid: 0))
    }

    // THE BUG THIS EXISTS FOR. The old shutdown dispatched .quit to the MAIN
    // queue, so a wedged main thread kept a screenSaver-level window on screen
    // with nothing driving it — and force-quitting the app never touched it,
    // because the process is named unmute-notch. The graceful path is still
    // tried first; the backstop is what guarantees the window goes.
    func testGracefulShutdownIsTriedBeforeTheBackstop() {
        let plan = shutdownPlan(graceMs: 800)
        XCTAssertTrue(plan.attemptGraceful)
        XCTAssertEqual(plan.hardExitAfterMs, 800)
    }

    func testTheBackstopIsAlwaysArmed() {
        // A grace period of zero must still arm a hard exit, not disable it.
        XCTAssertGreaterThan(shutdownPlan(graceMs: 0).hardExitAfterMs, 0)
    }
}
