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
    func testADeadExecutorWaitsForAutomaticReconnectRatherThanShowingAnEmptyBox() {
        XCTAssertEqual(composerState(alive: false, status: "done", kind: "session"), .notRunning)
    }

    func testALiveSessionIsComposable() {
        XCTAssertEqual(composerState(alive: true, status: "processing", kind: "session"), .composable)
    }

    func testExplicitCapabilityRefusalBeatsAlive() {
        XCTAssertEqual(composerState(alive: true, canCompose: false, status: "processing", kind: "session"), .notRunning)
    }

    func testMissingCapabilityFallsBackToAliveForLegacyPayloads() {
        XCTAssertEqual(composerState(alive: true, canCompose: nil, status: "processing", kind: "session"), .composable)
    }

    // Driver-backed threads (Codex desktop) have no PTY to be alive or dead; the
    // engine reports alive: true for them precisely so this reads correctly.
    func testADriverBackedThreadIsAlwaysComposable() {
        XCTAssertEqual(composerState(alive: true, status: "done", kind: "oneoff"), .composable)
    }

    // A dead executor is worth a Resume even mid-flight — that IS the state the
    // user hit when a session died while it said "processing".
    func testADeadExecutorMidFlightWaitsForAutomaticReconnect() {
        XCTAssertEqual(composerState(alive: false, status: "processing", kind: "session"), .notRunning)
    }

    func testAResumableFinishedOneoffWaitsForAutomaticReconnect() {
        XCTAssertEqual(composerState(alive: false, canResume: true, status: "failed", kind: "oneoff"), .notRunning)
    }

    func testANonResumableFinishedOneoffOffersNothing() {
        XCTAssertEqual(composerState(alive: false, canResume: false, status: "failed", kind: "oneoff"), .finished)
    }
}
