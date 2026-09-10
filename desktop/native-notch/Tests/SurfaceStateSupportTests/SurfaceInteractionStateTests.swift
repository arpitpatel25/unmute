import XCTest
@testable import SurfaceStateSupport

final class SurfaceInteractionStateTests: XCTestCase {
    // THE POCKET'S MORPH TESTS LIVED HERE — five of them, all describing a
    // second size that no longer exists: the growth order, the no-reversal
    // rule, the capture-keeps-it-open rule, and the exit that could only be
    // applied at a settlement boundary. The pocket has ONE size now, so there
    // is no morph to sequence and nothing here to assert about it.
    //
    // What replaced them is a geometry test: PocketRow measures its two
    // shoulders and PocketCard states its own height, and both are exercised
    // through NotchGeometry rather than through this reducer.

    func testPointerOnlyTracksTheBar() {
        var state = SurfaceInteractionState()
        state.reduce(.pointerEntered(.bar))
        XCTAssertTrue(state.presentation.barHovered)
        state.reduce(.pointerExited(.bar))
        XCTAssertFalse(state.presentation.barHovered)
    }

    func testRepeatedTaskEntryDoesNotResetExplicitTerminalChoice() {
        var state = SurfaceInteractionState()
        state.reduce(.taskEntered(id: "a", terminalDefaultOpen: true, requiresTerminal: false))
        state.reduce(.terminalVisibilityChanged(false))
        state.reduce(.taskEntered(id: "a", terminalDefaultOpen: true, requiresTerminal: false))
        XCTAssertFalse(state.terminalVisible)
    }

    func testNewTaskAppliesItsTerminalDefault() {
        var state = SurfaceInteractionState()
        state.reduce(.taskEntered(id: "a", terminalDefaultOpen: false, requiresTerminal: false))
        state.reduce(.terminalVisibilityChanged(true))
        state.reduce(.taskEntered(id: "b", terminalDefaultOpen: false, requiresTerminal: false))
        XCTAssertFalse(state.terminalVisible)
    }

    func testOpenPocketOutlineRemainsAttachedToTheScreenEdge() {
        XCTAssertFalse(SurfaceBorderPolicy.includesTopEdge(pocketOpen: true))
    }

    func testClosedSurfaceKeepsItsCompleteOutline() {
        XCTAssertTrue(SurfaceBorderPolicy.includesTopEdge(pocketOpen: false))
    }

}
