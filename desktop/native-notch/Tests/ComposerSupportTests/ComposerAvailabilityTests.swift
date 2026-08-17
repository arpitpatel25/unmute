import XCTest
@testable import ComposerSupport

final class ComposerAvailabilityTests: XCTestCase {

    // THE QUESTION THE OLD GATE ASKED WAS THE WRONG ONE. It asked whether the
    // task was conceptually finished — (done || failed) && kind != "session" —
    // when what decides whether a text box is useful is whether you can send to
    // it right now. Those two diverge in BOTH directions, and both cost the user.

    // Direction one: a one-off that finished is parked WARM for 8-15 minutes,
    // executor alive, terminal live, sends succeeding — and the old gate hid the
    // box the instant status flipped to done. Observed in the field: replies
    // reaching done one-off tasks via the Remote key, which bypasses the box.
    func testAParkedWarmOneoffStillOffersTheComposer() {
        XCTAssertEqual(composerState(alive: true, status: "done", kind: "oneoff"), .composable)
    }

    // Direction two: the box sat there over a dead executor. Every send was
    // retained and silently refused — typing into nothing.
    func testADeadExecutorOffersResumeRatherThanAnEmptyBox() {
        XCTAssertEqual(composerState(alive: false, status: "done", kind: "session"), .notRunning)
    }

    func testALiveSessionIsComposable() {
        XCTAssertEqual(composerState(alive: true, status: "processing", kind: "session"), .composable)
    }

    // Driver-backed threads (Codex desktop) have no PTY to be alive or dead; the
    // engine reports alive: true for them precisely so this reads correctly.
    func testADriverBackedThreadIsAlwaysComposable() {
        XCTAssertEqual(composerState(alive: true, status: "done", kind: "oneoff"), .composable)
    }

    // A dead executor is worth a Resume even mid-flight — that IS the state the
    // user hit when a session died while it said "processing".
    func testADeadExecutorMidFlightStillOffersResume() {
        XCTAssertEqual(composerState(alive: false, status: "processing", kind: "session"), .notRunning)
    }

    // The one case where nothing is offered: a one-off errand that genuinely
    // ended AND has no executor. There is nothing to say and nothing to resume
    // into — the old `ended()` rule, kept for exactly this case.
    func testAFinishedOneoffWithNoExecutorOffersNothing() {
        XCTAssertEqual(composerState(alive: false, status: "failed", kind: "oneoff"), .finished)
    }
}
