import XCTest
@testable import SurfaceStateSupport

final class SurfaceInteractionStateTests: XCTestCase {
    func testPocketControlsAndHeightShareOneDerivedState() {
        var state = SurfaceInteractionState()
        state.reduce(.pocketAvailability(open: true, itemCount: 3))
        XCTAssertEqual(state.presentation.pocketHeight, 64)
        XCTAssertFalse(state.presentation.pocketDetailsVisible)

        state.reduce(.pointerEntered(.pocket))
        XCTAssertEqual(state.presentation.pocketHeight, 146)
        XCTAssertFalse(state.presentation.pocketDetailsVisible,
                       "the existing card grows before its lower content appears")

        state.reduce(.pocketGeometrySettled)
        XCTAssertEqual(state.presentation.pocketHeight, 146)
        XCTAssertTrue(state.presentation.pocketDetailsVisible)

        state.reduce(.pointerExited(.pocket))
        XCTAssertEqual(state.presentation.pocketHeight, 146,
                       "lower content disappears before the card contracts")
        XCTAssertFalse(state.presentation.pocketDetailsVisible)

        state.reduce(.pocketContentHidden)
        XCTAssertEqual(state.presentation.pocketHeight, 64)
        XCTAssertFalse(state.presentation.pocketDetailsVisible)
    }

    func testExitWhilePocketIsGrowingCannotReverseTheGeometry() {
        var state = SurfaceInteractionState()
        state.reduce(.pocketAvailability(open: true, itemCount: 2))
        state.reduce(.pointerEntered(.pocket))

        state.reduce(.pointerExited(.pocket))

        XCTAssertEqual(state.presentation.pocketHeight, 146)
        XCTAssertFalse(state.presentation.pocketDetailsVisible)
        state.reduce(.pocketGeometrySettled)
        XCTAssertEqual(state.presentation.pocketHeight, 64,
                       "a real exit observed during growth is applied only after growth settles")
    }

    func testCaptureKeepsPocketDetailsVisibleAfterPointerExit() {
        var state = SurfaceInteractionState()
        state.reduce(.pocketAvailability(open: true, itemCount: 1))
        state.reduce(.captureAimed(true))
        state.reduce(.pocketGeometrySettled)
        state.reduce(.pointerExited(.pocket))
        XCTAssertEqual(state.presentation.pocketHeight, 120)
        XCTAssertTrue(state.presentation.pocketDetailsVisible)
    }

    func testPocketOpenedWhileCaptureIsAlreadyAimedCompletesItsMorph() {
        var state = SurfaceInteractionState()
        state.reduce(.captureAimed(true))
        state.reduce(.pocketAvailability(open: true, itemCount: 2))
        XCTAssertEqual(state.presentation.pocketHeight, 146)
        XCTAssertFalse(state.presentation.pocketDetailsVisible)

        state.reduce(.pocketGeometrySettled)
        XCTAssertTrue(state.presentation.pocketDetailsVisible)
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

}
