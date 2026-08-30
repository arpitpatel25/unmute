import XCTest
@testable import SurfaceSizeSupport

// ── A CONTINUOUS RANGE, NOT THREE BUTTONS ──
//
// 70/80/90 is a narrow band offered as three fixed choices. What people
// actually want is to drag to the size that suits the screen they are on.
// The range widens to 40–95% and every value in between is reachable.
//
// 95 rather than 100: a surface that fills the screen edge to edge has no
// ground left around it, and the notch is deliberately an overlay rather than
// a window. 40 rather than lower: below that the task view cannot hold a
// readable column and a terminal at once.

final class SurfaceSizeRangeTests: XCTestCase {

    func testTheRangeIsFortyToNinetyFive() {
        XCTAssertEqual(SurfaceSizeStep.minimum, 0.40, accuracy: 0.0001)
        XCTAssertEqual(SurfaceSizeStep.maximum, 0.95, accuracy: 0.0001)
    }

    func testAnyValueInBetweenIsReachable() {
        for percent in 40...95 {
            let fill = CGFloat(percent) / 100
            XCTAssertEqual(SurfaceSizeStep.clamp(fill), fill, accuracy: 0.0001,
                           "\(percent)% must survive the clamp untouched")
        }
    }

    func testValuesOutsideTheRangeAreBroughtBackIn() {
        XCTAssertEqual(SurfaceSizeStep.clamp(0.1), 0.40, accuracy: 0.0001)
        XCTAssertEqual(SurfaceSizeStep.clamp(1.5), 0.95, accuracy: 0.0001)
    }

    /// A slider produces 0.7234; a label reading "72.34%" is noise. Whole
    /// percents are the resolution anyone can perceive on screen.
    func testAFillSnapsToAWholePercent() {
        XCTAssertEqual(SurfaceSizeStep.clamp(0.7234), 0.72, accuracy: 0.0001)
        XCTAssertEqual(SurfaceSizeStep.clamp(0.7266), 0.73, accuracy: 0.0001)
    }

    /// Nonsense in, a usable surface out — never a zero-size window.
    func testGarbageResolvesToSomethingUsable() {
        XCTAssertEqual(SurfaceSizeStep.clamp(.nan), SurfaceSizeStep.fallback, accuracy: 0.0001)
        XCTAssertEqual(SurfaceSizeStep.clamp(.infinity), SurfaceSizeStep.maximum, accuracy: 0.0001)
    }

    // MARK: - the track

    func testTheTrackRunsFromZeroToOneAcrossTheRange() {
        XCTAssertEqual(SurfaceSizeStep.fraction(of: 0.40), 0, accuracy: 0.0001)
        XCTAssertEqual(SurfaceSizeStep.fraction(of: 0.95), 1, accuracy: 0.0001)
        XCTAssertEqual(SurfaceSizeStep.fraction(of: 0.675), 0.5, accuracy: 0.01)
    }

    func testDraggingToAPositionGivesTheFillThere() {
        XCTAssertEqual(SurfaceSizeStep.fill(atFraction: 0), 0.40, accuracy: 0.0001)
        XCTAssertEqual(SurfaceSizeStep.fill(atFraction: 1), 0.95, accuracy: 0.0001)
        XCTAssertEqual(SurfaceSizeStep.fill(atFraction: 0.5), 0.68, accuracy: 0.01)
    }

    /// A drag can leave the control entirely — the pointer keeps moving after
    /// the track ends, and the value must stop at the edge rather than run on.
    func testDraggingPastEitherEndStopsAtTheEnd() {
        XCTAssertEqual(SurfaceSizeStep.fill(atFraction: -3), 0.40, accuracy: 0.0001)
        XCTAssertEqual(SurfaceSizeStep.fill(atFraction: 9), 0.95, accuracy: 0.0001)
    }

    // MARK: - the keyboard nudge

    func testNudgingMovesOneStepAndStopsAtTheEdges() {
        XCTAssertEqual(SurfaceSizeStep.next(after: 0.70, direction: .larger), 0.75)
        XCTAssertEqual(SurfaceSizeStep.next(after: 0.70, direction: .smaller), 0.65)
        XCTAssertNil(SurfaceSizeStep.next(after: SurfaceSizeStep.maximum, direction: .larger))
        XCTAssertNil(SurfaceSizeStep.next(after: SurfaceSizeStep.minimum, direction: .smaller))
    }

    /// Nudging from a dragged value must land on the grid, not carry the
    /// dragged remainder along forever.
    func testNudgingFromAnOddValueLandsOnTheGrid() {
        XCTAssertEqual(SurfaceSizeStep.next(after: 0.72, direction: .larger), 0.75)
        XCTAssertEqual(SurfaceSizeStep.next(after: 0.72, direction: .smaller), 0.70)
    }

    /// Near the top the last step is short — it must still reach the maximum
    /// rather than refusing because a full nudge would overshoot.
    func testTheLastNudgeReachesTheTop() {
        XCTAssertEqual(SurfaceSizeStep.next(after: 0.93, direction: .larger), 0.95)
    }
}
