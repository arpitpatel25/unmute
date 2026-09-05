import XCTest
@testable import ConversationSupport

final class ConversationScrollMemoryTests: XCTestCase {
    func testStorageIsPerTaskAndBounded() {
        let memory = ConversationScrollMemory(limit: 2)
        memory.remember(task: "a", anchor: "a1")
        memory.remember(task: "b", anchor: "b1")
        memory.remember(task: "c", anchor: "c1")
        XCTAssertNil(memory.anchor(for: "a"))
        XCTAssertEqual(memory.anchor(for: "b"), "b1")
        XCTAssertEqual(memory.anchor(for: "c"), "c1")
    }

    func testVisibleAnchorIsTheTurnOverlappingTheReadingEdge() {
        let frames = [
            TurnViewportFrame(id: "long", minY: -500, maxY: 120),
            TurnViewportFrame(id: "later", minY: 142, maxY: 240),
            TurnViewportFrame(id: "below", minY: 620, maxY: 720),
        ]
        XCTAssertEqual(visibleTurnAnchor(frames: frames, viewportHeight: 500), "long")
    }

    func testVisibleAnchorIgnoresTurnsBelowViewport() {
        XCTAssertNil(visibleTurnAnchor(frames: [TurnViewportFrame(id: "below", minY: 501, maxY: 700)], viewportHeight: 500))
    }

    func testRestoreGateSuppressesInitialWritesAndFollowingUntilCompletion() {
        var gate = ScrollRestoreGate()
        let captured = gate.begin(task: "a", savedAnchor: "old")
        XCTAssertEqual(captured, "old")
        XCTAssertFalse(gate.mayRecord(task: "a"))
        XCTAssertFalse(gate.mayFollow(task: "a"))
        gate.finish(task: "a")
        XCTAssertTrue(gate.mayRecord(task: "a"))
        XCTAssertTrue(gate.mayFollow(task: "a"))
    }

    func testDisclosureStateIsKeyedByTaskAndBounded() {
        let memory = DisclosureStateMemory(limit: 2)
        memory.remember(task: "a", key: "work:1", open: true)
        memory.remember(task: "b", key: "work:1", open: false)
        XCTAssertEqual(memory.value(task: "a", key: "work:1"), true)
        XCTAssertEqual(memory.value(task: "b", key: "work:1"), false)
        memory.remember(task: "c", key: "call:1", open: true)
        XCTAssertNil(memory.value(task: "a", key: "work:1"))
    }
}
