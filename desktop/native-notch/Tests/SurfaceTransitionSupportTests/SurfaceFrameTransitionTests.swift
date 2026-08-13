import CoreGraphics
import XCTest
@testable import SurfaceTransitionSupport

final class SurfaceFrameTransitionTests: XCTestCase {
    func testSameInFlightTargetDoesNotRestartTheTransition() {
        var transition = SurfaceFrameTransition()
        let current = CGRect(x: 0, y: 0, width: 100, height: 30)
        let target = CGRect(x: 0, y: 0, width: 480, height: 620)

        XCTAssertEqual(transition.request(target, from: current, animated: true), .animate(target))
        XCTAssertEqual(transition.request(target, from: current, animated: true), .none)
    }

    func testNewTargetRetargetsInsteadOfDiscardingTheCurrentTransition() {
        var transition = SurfaceFrameTransition()
        let current = CGRect(x: 0, y: 0, width: 100, height: 30)
        let pocket = CGRect(x: 0, y: 0, width: 300, height: 240)
        let task = CGRect(x: 0, y: 0, width: 720, height: 700)

        XCTAssertEqual(transition.request(pocket, from: current, animated: true), .animate(pocket))
        XCTAssertEqual(transition.request(task, from: current, animated: true), .animateFrom(current, to: task))
    }

    func testReduceMotionSetsTheFrameImmediately() {
        var transition = SurfaceFrameTransition()
        let current = CGRect(x: 0, y: 0, width: 100, height: 30)
        let target = CGRect(x: 0, y: 0, width: 480, height: 620)

        XCTAssertEqual(transition.request(target, from: current, animated: false), .setImmediately(target))
    }

    func testSampleInterpolatesWithoutBlockingTheRequestingThread() {
        let from = CGRect(x: 500, y: 800, width: 348, height: 146)
        let to = CGRect(x: 72, y: 90, width: 1296, height: 810)
        let halfway = SurfaceFrameTransition.sample(from: from, to: to, progress: 0.5)

        XCTAssertEqual(halfway, CGRect(x: 286, y: 445, width: 822, height: 478))
    }

    func testRetargetBeginsAtTheCurrentPresentationFrame() {
        var transition = SurfaceFrameTransition()
        let original = CGRect(x: 500, y: 800, width: 348, height: 146)
        let firstTarget = CGRect(x: 72, y: 90, width: 1296, height: 810)
        let current = CGRect(x: 350, y: 560, width: 700, height: 370)
        let secondTarget = CGRect(x: 144, y: 180, width: 1152, height: 720)

        _ = transition.request(firstTarget, from: original, animated: true)
        XCTAssertEqual(transition.request(secondTarget, from: current, animated: true),
                       .animateFrom(current, to: secondTarget))
    }

    func testRepeatedExpandedUpdatePreservesAnInFlightPocketHandoff() {
        XCTAssertTrue(SurfaceContentHandoff.shouldPreserve(
            wasExpanded: true,
            destinationExpanded: true,
            contentReady: false,
            hasPocketSnapshot: true
        ))
    }

    func testLeavingExpandedStateDoesNotPreserveThePocketHandoff() {
        XCTAssertFalse(SurfaceContentHandoff.shouldPreserve(
            wasExpanded: true,
            destinationExpanded: false,
            contentReady: false,
            hasPocketSnapshot: true
        ))
    }
}
