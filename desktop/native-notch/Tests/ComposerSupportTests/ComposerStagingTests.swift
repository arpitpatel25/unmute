import XCTest
@testable import ComposerSupport

final class ComposerStagingTests: XCTestCase {
    func testFastSecondWaitsForDelayedFirst() {
        var state = ComposerStagingOrder()
        state.reserve(.init(id: "1", taskId: "a", name: "slow"))
        state.reserve(.init(id: "2", taskId: "a", name: "fast"))
        XCTAssertEqual(state.complete(id: "2"), [])
        XCTAssertEqual(state.complete(id: "1"), ["1", "2"])
    }
    func testFailureAdvancesBatch() {
        var state = ComposerStagingOrder()
        state.reserve(.init(id: "1", taskId: "a", name: "bad"))
        state.reserve(.init(id: "2", taskId: "a", name: "good"))
        XCTAssertEqual(state.complete(id: "2"), [])
        XCTAssertEqual(state.complete(id: "1", error: "broken"), ["2"])
        XCTAssertEqual(state.records.first?.error, "broken")
    }
    func testRemovalDuringPendingPreventsLateDelivery() {
        var state = ComposerStagingOrder()
        state.reserve(.init(id: "1", taskId: "a", name: "gone"))
        state.reserve(.init(id: "2", taskId: "a", name: "next"))
        _ = state.complete(id: "2")
        XCTAssertEqual(state.remove(id: "1"), ["2"])
        XCTAssertEqual(state.complete(id: "1"), [])
    }
    func testTasksHaveIndependentBarriers() {
        var state = ComposerStagingOrder()
        state.reserve(.init(id: "a1", taskId: "a", name: "a"))
        state.reserve(.init(id: "b1", taskId: "b", name: "b"))
        XCTAssertEqual(state.complete(id: "b1"), ["b1"])
        XCTAssertEqual(state.records.first(where: { $0.id == "a1" })?.phase, .pending)
    }
    func testTaskSwitchDoesNotDiscardPendingSelection() {
        var state = ComposerStagingOrder()
        state.reserve(.init(id: "a1", taskId: "a", name: "kept"))
        state.reserve(.init(id: "b1", taskId: "b", name: "other"))
        _ = state.complete(id: "b1")
        XCTAssertEqual(state.records.first(where: { $0.taskId == "a" })?.name, "kept")
        XCTAssertEqual(state.complete(id: "a1"), ["a1"])
    }
    func testFailedSourceCanRetryWithoutLosingIdentity() {
        var state = ComposerStagingOrder()
        state.reserve(.init(id: "1", taskId: "a", name: "file", sourcePath: "/still-there"))
        _ = state.complete(id: "1", error: "temporary")
        XCTAssertTrue(state.retry(id: "1"))
        XCTAssertEqual(state.records[0].phase, .pending)
    }
    func testMissingImageIsUnavailableNotGenericFile() {
        XCTAssertEqual(attachmentVisualState(isImage: true, fileExists: false, imageDecoded: false), .unavailableImage)
    }
}
