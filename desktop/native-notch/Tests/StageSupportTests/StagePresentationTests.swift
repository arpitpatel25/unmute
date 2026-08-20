import XCTest
@testable import StageSupport

final class StagePresentationTests: XCTestCase {
    func testOpeningAnOrchestratorTaskStartsInFullView() {
        XCTAssertTrue(stageFullState(current: false, action: .focusTask))
    }

    func testStageViewCanStillBeSplitAndClosesBackToItsDefault() {
        XCTAssertFalse(stageFullState(current: true, action: .toggle))
        XCTAssertFalse(stageFullState(current: true, action: .close))
    }

    func testADeadTerminalShowsItsConversationInsteadOfAnEmptyTerminal() {
        XCTAssertEqual(stageBodyMode(hasTerminal: true, terminalRequested: true,
                                     alive: false, resuming: false), .messages)
    }

    func testARelaunchingTerminalShowsExplicitProgress() {
        XCTAssertEqual(stageBodyMode(hasTerminal: true, terminalRequested: true,
                                     alive: false, resuming: true), .relaunching)
    }

    func testALiveRequestedTerminalShowsTheTerminal() {
        XCTAssertEqual(stageBodyMode(hasTerminal: true, terminalRequested: true,
                                     alive: true, resuming: false), .terminal)
    }

    func testConversationModeStillWinsWhenTheUserClosedTheTerminal() {
        XCTAssertEqual(stageBodyMode(hasTerminal: true, terminalRequested: false,
                                     alive: true, resuming: false), .messages)
    }

    func testAChatOnlyProviderNeverClaimsToHaveATerminal() {
        XCTAssertEqual(stageBodyMode(hasTerminal: false, terminalRequested: true,
                                     alive: true, resuming: false), .messages)
    }
}
