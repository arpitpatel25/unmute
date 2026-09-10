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

    func testPhysicalNotchNeverSleepsAnExplicitlyOpenPocket() {
        XCTAssertFalse(HoverSleepPolicy.shouldSleep(
            hasPhysicalNotch: true,
            pocketOpen: true,
            currentStateIsIdle: true,
            commandedStateIsDormant: true,
            hovering: false
        ))
    }

    func testClosedPhysicalNotchMaySleepAfterARealHoverExit() {
        XCTAssertTrue(HoverSleepPolicy.shouldSleep(
            hasPhysicalNotch: true,
            pocketOpen: false,
            currentStateIsIdle: true,
            commandedStateIsDormant: true,
            hovering: false
        ))
    }
}
