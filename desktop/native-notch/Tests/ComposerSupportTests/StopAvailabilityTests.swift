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

    func testNeverForTasksThatAreNotOurs() {
        XCTAssertFalse(stopAvailable(isOwned: false, taskId: "t", canStop: true, status: "processing", lastTurnRunning: true))
    }

    // THE AGENT'S CHAT IS THE ONE CARD THAT IS NOT OWNED AND STILL STOPPABLE.
    // It was excluded outright, on the grounds that it "has its own interrupt";
    // that interrupt had no caller anywhere in the app, so a long turn could
    // only be waited out.
    func testTheAgentsChatOffersStopWhileItIsBusy() {
        XCTAssertTrue(stopAvailable(isOwned: false, taskId: "unmute-agent", canStop: true,
                                    status: "processing", lastTurnRunning: false))
        XCTAssertFalse(stopAvailable(isOwned: false, taskId: "unmute-agent", canStop: false,
                                     status: "ready", lastTurnRunning: false))
    }

    // Its busy flag is `processing` and nothing else: it has no executor, so
    // `alive` and a running turn-start are signals it simply does not carry.
    func testTheAgentFallsBackToItsStatusOnAnOlderEngine() {
        XCTAssertTrue(stopAvailable(isOwned: false, taskId: "unmute-agent", canStop: nil,
                                    status: "processing", lastTurnRunning: false))
        XCTAssertFalse(stopAvailable(isOwned: false, taskId: "unmute-agent", canStop: nil,
                                     status: "failed", lastTurnRunning: true))
    }
}
