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

    // THE SIGN. A reader scrolled up has the content's end BELOW the viewport:
    // end > viewportHeight, so the distance is positive and they are not at the
    // bottom. The call site once computed `viewportHeight - end`, which the clamp
    // turned into 0 = "at bottom" — and every streaming tick yanked them back.
    func testDistanceIsPositiveWhenContentIsBelowTheFold() {
        XCTAssertEqual(bottomDistance(contentEnd: 1400, viewportHeight: 600), 800)
        XCTAssertFalse(isAtBottom(was: true, distance: bottomDistance(contentEnd: 1400, viewportHeight: 600)))
    }

    // At the real bottom the end sits the Jump padding ABOVE the edge: negative,
    // clamped, at the bottom.
    func testRealBottomIsNegativeByThePaddingAndCountsAsArrived() {
        let d = bottomDistance(contentEnd: 600 - jumpControlHeight, viewportHeight: 600)
        XCTAssertEqual(d, -jumpControlHeight)
        XCTAssertTrue(isAtBottom(was: false, distance: d))
    }

    func testUnmeasuredViewportIsUnknownNotAnAnswer() {
        XCTAssertTrue(bottomDistance(contentEnd: 900, viewportHeight: 0).isNaN)
        XCTAssertTrue(bottomDistance(contentEnd: .nan, viewportHeight: 600).isNaN)
    }

    // ── LiveEndFollow ───────────────────────────────────────────────────────

    private func follow(top: CGFloat, end: CGFloat, _ f: inout LiveEndFollow, restoring: Bool = false) {
        f.measure(contentTop: top, contentEnd: end, viewportHeight: 600, restoring: restoring)
    }

    func testScrollingUpPastTheExitThresholdStopsTheFollow() {
        var f = LiveEndFollow()
        follow(top: -1000, end: 556, &f)          // at the bottom
        XCTAssertTrue(f.mayFollow(at: 100))
        follow(top: -700, end: 856, &f)           // reader moved up 300pt
        XCTAssertFalse(f.atBottom)
        XCTAssertFalse(f.mayFollow(at: 100))
    }

    // THE REGRESSION THE FIX COULD CAUSE. A big block landing before the follow
    // runs measures as far from the end — but the viewport did not move, so the
    // reader did not leave.
    func testContentGrowthAloneNeverStopsTheFollow() {
        var f = LiveEndFollow()
        follow(top: -1000, end: 556, &f)
        follow(top: -1000, end: 1200, &f)         // +644pt of content, same scroll
        XCTAssertTrue(f.atBottom)
    }

    // No 120pt window in which a tick can snap the reader back: an upward wheel
    // or trackpad movement leaves the bottom immediately.
    func testAnUpwardWheelLeavesTheBottomAtOnce() {
        var f = LiveEndFollow()
        follow(top: -1000, end: 556, &f)
        f.userScrolled(deltaX: 0, deltaY: 3, at: 10)
        XCTAssertFalse(f.atBottom)
        // Only 10pt up: inside the Jump padding, so the distance still clamps
        // to "arrived" — but the reader moved up, and that is not arriving.
        follow(top: -990, end: 566, &f)
        XCTAssertFalse(f.mayFollow(at: 20))
        // Streaming on while they read: still not followed.
        follow(top: -990, end: 900, &f)
        XCTAssertFalse(f.mayFollow(at: 20))
    }

    func testDownwardOrSidewaysWheelDoesNotLeaveTheBottom() {
        var f = LiveEndFollow()
        follow(top: -1000, end: 556, &f)
        f.userScrolled(deltaX: 0, deltaY: -5, at: 10)
        f.userScrolled(deltaX: 20, deltaY: 1, at: 10)
        XCTAssertTrue(f.atBottom)
    }

    // A transcript that fits cannot scroll up; a wheel over it must not strand
    // the follow for a reader who never left the end.
    func testUpwardWheelOnAnUnscrolledTranscriptKeepsFollowing() {
        var f = LiveEndFollow()
        follow(top: 0, end: 400, &f)
        f.userScrolled(deltaX: 0, deltaY: 5, at: 10)
        XCTAssertTrue(f.atBottom)
    }

    // Hands on the scroller: no follow, even at the bottom, until the grace
    // after the last input has passed.
    func testNoFollowWhileTheReaderIsScrolling() {
        var f = LiveEndFollow()
        follow(top: -1000, end: 556, &f)
        f.liveScrollBegan(at: 10)
        XCTAssertFalse(f.mayFollow(at: 50))
        f.liveScrollEnded(at: 60)
        XCTAssertFalse(f.mayFollow(at: 60 + userScrollGrace / 2))
        XCTAssertTrue(f.mayFollow(at: 60 + userScrollGrace + 0.01))
        f.userScrolled(deltaX: 0, deltaY: -2, at: 100)
        XCTAssertFalse(f.mayFollow(at: 100.1))
        XCTAssertTrue(f.mayFollow(at: 100 + userScrollGrace + 0.01))
    }

    // Dragging the knob up a little and letting go: they are reading, by the
    // strict arrival threshold, not the generous leaving one.
    func testALiveScrollThatEndsShortOfTheEndLeavesTheBottom() {
        var f = LiveEndFollow()
        follow(top: -1000, end: 556, &f)
        f.liveScrollBegan(at: 10)
        follow(top: -940, end: 616, &f)           // 60pt up: inside the dead zone
        XCTAssertTrue(f.atBottom)
        f.liveScrollEnded(at: 11)
        XCTAssertFalse(f.atBottom)
    }

    func testReturningToTheEndResumesTheFollow() {
        var f = LiveEndFollow()
        follow(top: -1000, end: 556, &f)
        f.userScrolled(deltaX: 0, deltaY: 4, at: 10)
        follow(top: -600, end: 956, &f)
        XCTAssertFalse(f.atBottom)
        follow(top: -1000, end: 556, &f)          // back at the end (e.g. Jump)
        XCTAssertTrue(f.mayFollow(at: 20))
    }

    func testJumpToLatestRearmsTheFollow() {
        var f = LiveEndFollow()
        follow(top: -1000, end: 556, &f)
        f.userScrolled(deltaX: 0, deltaY: 4, at: 10)
        XCTAssertFalse(f.atBottom)
        f.jumpToLatest()
        XCTAssertTrue(f.mayFollow(at: 20))
    }

    // While a restore positions the thread, the scroll is ours: record, decide
    // nothing. A new thread starts following.
    func testRestoreIsNotTheReaderScrolling() {
        var f = LiveEndFollow()
        follow(top: -1000, end: 556, &f)
        f.userScrolled(deltaX: 0, deltaY: 4, at: 10)
        f.reset()
        XCTAssertTrue(f.atBottom)
        follow(top: 0, end: 2000, &f, restoring: true)
        follow(top: -200, end: 1800, &f, restoring: true)
        XCTAssertTrue(f.atBottom)
    }
}
