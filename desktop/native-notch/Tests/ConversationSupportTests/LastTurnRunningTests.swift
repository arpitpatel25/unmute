import XCTest
@testable import ConversationSupport

// Stop keys off the same "is this turn still working" the chat draws from.
final class LastTurnRunningTests: XCTestCase {
    func testTurnStartWithoutEndIsRunningEvenWhenMarkerPrecedesThePrompt() {
        XCTAssertTrue(BlockPresentation.lastTurnRunning([
            Block(kind: "turnStart", startedAt: 1), Block(kind: "message", role: "user", text: "go"),
            Block(kind: "message", role: "assistant", text: "working on it")]))
    }

    func testEndedTurnIsNotRunning() {
        XCTAssertFalse(BlockPresentation.lastTurnRunning([
            Block(kind: "turnStart", startedAt: 1), Block(kind: "message", role: "user", text: "go"),
            Block(kind: "message", role: "assistant", text: "done"), Block(kind: "turnEnd", outcome: "completed")]))
    }

    func testRunningCommandIsRunning() {
        XCTAssertTrue(BlockPresentation.lastTurnRunning([
            Block(kind: "message", role: "user", text: "go"), Block(kind: "command", status: "running")]))
    }

    func testOnlyTheLastTurnCounts() {
        XCTAssertFalse(BlockPresentation.lastTurnRunning([
            Block(kind: "turnStart", startedAt: 1), Block(kind: "message", role: "user", text: "old"),
            Block(kind: "message", role: "user", text: "new"), Block(kind: "message", role: "assistant", text: "hi")]))
        XCTAssertFalse(BlockPresentation.lastTurnRunning([]))
    }
}
