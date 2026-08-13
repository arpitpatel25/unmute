import XCTest
@testable import HoverStateSupport

final class HoverExitDecisionTests: XCTestCase {
    func testResizeGeneratedExitKeepsRevealWhenPointerRemainsInsideSurface() {
        XCTAssertEqual(
            HoverExitDecision.resolve(pointerInsideSurface: true),
            .keepRevealed
        )
    }

    func testPhysicalExitAllowsRevealToCollapse() {
        XCTAssertEqual(
            HoverExitDecision.resolve(pointerInsideSurface: false),
            .acceptExit
        )
    }
}
