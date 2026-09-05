import XCTest
import CoreGraphics
@testable import ConversationSupport

final class BottomProximityTests: XCTestCase {

    // THE BUG THIS EXISTS TO MAKE IMPOSSIBLE.
    //
    // "Am I at the bottom?" was answered by whether a marker view happened to be
    // on screen — and the answer decided whether the Jump-to-latest button was on
    // screen, and the button's presence moved the content, which moved the marker.
    // Each step was individually correct and the sequence never settled: SwiftUI
    // recomputed layout forever and pinned a CPU core at 100%, freezing the notch
    // over every window on every Space.
    //
    // Two properties kill it. The input is a MEASUREMENT rather than a
    // consequence of what we drew, and the thresholds are far enough apart that
    // the button's own height cannot carry the value back across.

    func testAtTheVeryBottom() {
        XCTAssertTrue(isAtBottom(was: false, distance: 0))
    }

    func testFarFromTheBottom() {
        XCTAssertFalse(isAtBottom(was: true, distance: 600))
    }

    // THE GUARANTEE. Showing the button shifts the content by roughly its own
    // height. Starting at the bottom, that shift must NOT be enough to report
    // "not at the bottom" — otherwise the button hides itself, the shift
    // reverses, and we are back in the loop.
    func testTheButtonsOwnHeightCannotFlipTheAnswer() {
        var state = true
        for _ in 0..<50 {
            // Alternate: button shown (content pushed by its height) and hidden.
            state = isAtBottom(was: state, distance: jumpControlHeight)
            state = isAtBottom(was: state, distance: 0)
        }
        XCTAssertTrue(state, "the control's own height flipped the state — the loop is still possible")
    }

    // And the same holds starting from the other side: a reader who has scrolled
    // up stays scrolled up while the button appears beneath them.
    func testShowingTheControlDoesNotSnapAReaderBack() {
        var state = false
        for _ in 0..<50 {
            state = isAtBottom(was: state, distance: 300 - jumpControlHeight)
            state = isAtBottom(was: state, distance: 300)
        }
        XCTAssertFalse(state)
    }

    // Hysteresis proper: leaving the bottom takes a real scroll, not a nudge.
    func testLeavingTheBottomTakesMoreThanANudge() {
        XCTAssertTrue(isAtBottom(was: true, distance: 40))
        XCTAssertFalse(isAtBottom(was: true, distance: 400))
    }

    // …and returning requires actually arriving, not merely approaching.
    func testReturningRequiresArriving() {
        XCTAssertFalse(isAtBottom(was: false, distance: 40))
        XCTAssertTrue(isAtBottom(was: false, distance: 2))
    }

    // The gap must exceed the control, or the guarantee above is luck.
    func testThresholdsLeaveRoomForTheControl() {
        XCTAssertGreaterThan(bottomExitThreshold - bottomEnterThreshold, jumpControlHeight)
    }

    // Garbage in (a frame not yet measured) must not report a confident answer
    // that yanks the reader; keep whatever we had.
    func testAnUnmeasuredFrameKeepsThePreviousAnswer() {
        XCTAssertTrue(isAtBottom(was: true, distance: .nan))
        XCTAssertFalse(isAtBottom(was: false, distance: .nan))
    }

    func testReadableMeasuresStayInsideNarrowPanelsAndCapProse() {
        XCTAssertEqual(proseMeasure(panelWidth: 500), 404)
        XCTAssertEqual(proseMeasure(panelWidth: 1400), 760)
        XCTAssertEqual(codeMeasure(panelWidth: 500), 404)
        XCTAssertEqual(codeMeasure(panelWidth: 1400), 1304)
    }
}
