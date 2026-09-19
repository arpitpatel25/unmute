import XCTest
@testable import ComposerSupport

// Stop must be there whenever work is visibly happening on a task that is ours.
final class StopAvailabilityTests: XCTestCase {
    func testEngineCanStopWinsOverALaggingStatus() {
        // The field bug: streaming, status latched failed, alive false.
        XCTAssertTrue(stopAvailable(isOwned: true, taskId: "t", canStop: true, status: "failed", lastTurnRunning: false))
    }

    func testWorkingStatusesOfferStop() {
        XCTAssertTrue(stopAvailable(isOwned: true, taskId: "t", canStop: nil, status: "processing", lastTurnRunning: false))
        XCTAssertTrue(stopAvailable(isOwned: true, taskId: "t", canStop: false, status: "needs-user", lastTurnRunning: false))
    }

    func testRunningBlocksOfferStopUnlessSettled() {
        XCTAssertTrue(stopAvailable(isOwned: true, taskId: "t", canStop: false, status: "ready", lastTurnRunning: true))
        XCTAssertFalse(stopAvailable(isOwned: true, taskId: "t", canStop: false, status: "done", lastTurnRunning: true))
        XCTAssertFalse(stopAvailable(isOwned: true, taskId: "t", canStop: false, status: "ready", lastTurnRunning: false))
    }

    func testNeverForTasksThatAreNotOursOrTheAgentsOwnChat() {
        XCTAssertFalse(stopAvailable(isOwned: false, taskId: "t", canStop: true, status: "processing", lastTurnRunning: true))
        XCTAssertFalse(stopAvailable(isOwned: true, taskId: "unmute-agent", canStop: true, status: "processing", lastTurnRunning: true))
    }
}
