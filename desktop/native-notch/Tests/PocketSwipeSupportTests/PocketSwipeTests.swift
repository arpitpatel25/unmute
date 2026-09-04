import XCTest
@testable import PocketSwipeSupport

final class PocketSwipeTests: XCTestCase {
    /// Fingers left = the next card, the same sign a scroll view advances on.
    func testSwipeLeftAdvances() {
        var s = PocketSwipe()
        XCTAssertNil(s.feed(.init(deltaX: 0, deltaY: 0, isGestureStart: true)))
        XCTAssertNil(s.feed(.init(deltaX: -10, deltaY: 0)))
        XCTAssertEqual(s.feed(.init(deltaX: -20, deltaY: 0)), 1)
    }

    func testSwipeRightGoesBack() {
        var s = PocketSwipe()
        XCTAssertNil(s.feed(.init(deltaX: 0, deltaY: 0, isGestureStart: true)))
        XCTAssertEqual(s.feed(.init(deltaX: 30, deltaY: 0)), -1)
    }

    /// A brush past the menu bar must not re-aim your voice.
    func testShortTravelDoesNothing() {
        var s = PocketSwipe()
        _ = s.feed(.init(deltaX: 0, deltaY: 0, isGestureStart: true))
        for _ in 0..<5 { XCTAssertNil(s.feed(.init(deltaX: -4, deltaY: 0))) }
    }

    /// ONE SWIPE, ONE CARD — a long drag does not walk the whole crank.
    func testOneStepPerGesture() {
        var s = PocketSwipe()
        _ = s.feed(.init(deltaX: 0, deltaY: 0, isGestureStart: true))
        XCTAssertEqual(s.feed(.init(deltaX: -30, deltaY: 0)), 1)
        for _ in 0..<10 { XCTAssertNil(s.feed(.init(deltaX: -30, deltaY: 0))) }
    }

    /// Lifting and swiping again is a second card.
    func testNextGestureStepsAgain() {
        var s = PocketSwipe()
        _ = s.feed(.init(deltaX: 0, deltaY: 0, isGestureStart: true))
        XCTAssertEqual(s.feed(.init(deltaX: -30, deltaY: 0)), 1)
        XCTAssertNil(s.feed(.init(deltaX: 0, deltaY: 0, isGestureEnd: true)))
        _ = s.feed(.init(deltaX: 0, deltaY: 0, isGestureStart: true))
        XCTAssertEqual(s.feed(.init(deltaX: -30, deltaY: 0)), 1)
    }

    /// The glide after the fingers lift is the SAME swipe arriving twice.
    func testMomentumIsIgnored() {
        var s = PocketSwipe()
        _ = s.feed(.init(deltaX: 0, deltaY: 0, isGestureStart: true))
        XCTAssertEqual(s.feed(.init(deltaX: -30, deltaY: 0)), 1)
        _ = s.feed(.init(deltaX: 0, deltaY: 0, isGestureEnd: true))
        for _ in 0..<10 {
            XCTAssertNil(s.feed(.init(deltaX: -40, deltaY: 0, isMomentum: true)))
        }
    }

    /// A vertical scroll that drifts sideways is not a swipe.
    func testVerticalDominantScrollIsNotASwipe() {
        var s = PocketSwipe()
        _ = s.feed(.init(deltaX: 0, deltaY: 0, isGestureStart: true))
        XCTAssertNil(s.feed(.init(deltaX: -30, deltaY: -90)))
    }

    /// A notched wheel has no phases: each detent is its own step.
    func testWheelDetentStepsWithoutPhases() {
        var s = PocketSwipe()
        XCTAssertEqual(s.feed(.init(deltaX: -1, deltaY: 0, hasPreciseDeltas: false)), 1)
        XCTAssertEqual(s.feed(.init(deltaX: -1, deltaY: 0, hasPreciseDeltas: false)), 1)
        XCTAssertEqual(s.feed(.init(deltaX: 1, deltaY: 0, hasPreciseDeltas: false)), -1)
        XCTAssertNil(s.feed(.init(deltaX: 0, deltaY: -3, hasPreciseDeltas: false)))
    }

    /// Reset abandons a gesture in flight — the pocket closed under it.
    func testResetAbandonsTravel() {
        var s = PocketSwipe()
        _ = s.feed(.init(deltaX: 0, deltaY: 0, isGestureStart: true))
        XCTAssertNil(s.feed(.init(deltaX: -20, deltaY: 0)))
        s.reset()
        XCTAssertNil(s.feed(.init(deltaX: -20, deltaY: 0)))
    }
}
