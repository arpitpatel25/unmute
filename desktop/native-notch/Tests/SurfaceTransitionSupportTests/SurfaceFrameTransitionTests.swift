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
        XCTAssertEqual(transition.request(task, from: current, animated: true), .animate(task))
    }

    func testReduceMotionSetsTheFrameImmediately() {
        var transition = SurfaceFrameTransition()
        let current = CGRect(x: 0, y: 0, width: 100, height: 30)
        let target = CGRect(x: 0, y: 0, width: 480, height: 620)

        XCTAssertEqual(transition.request(target, from: current, animated: false), .setImmediately(target))
    }
}
